/**
 * What the credential store's documentation claims, against what it does.
 *
 * ============================================================================
 * THE FAILURE THESE PREVENT FROM COMING BACK
 *
 * `credentials.ts` opens with three numbered decisions, and the second one
 * read: *"Precedence: real environment > this store > `.env`"*, with a second
 * sentence under `applyCredentialStore` promising that *"the store beats
 * `.env` — a key typed in the interface is a more recent and more deliberate
 * act than a shared `.env`"*. `CLAUDE.md` carried the same ordering for both
 * halves of the product, under a heading saying the two stores obey the same
 * rule.
 *
 * Measured, the console does the OPPOSITE of that last tier, and in both of
 * its launch modes, for two different reasons:
 *
 *  - `npm run serve` launches `server/api.ts` with Node's own
 *    `--env-file-if-exists=.env` (`scripts/start.ts`). Node applies that file
 *    BEFORE any module evaluates, so by the time `snapshotRealEnv()` runs, a
 *    `.env` key is indistinguishable from a shell one.
 *  - In Docker — the normal installation mode — `docker compose` reads `.env`
 *    on the HOST and substitutes it into `environment:`. The container
 *    receives real environment variables and holds no `.env` at all.
 *
 * Either way a `.env` key is reported `locked`, the store is never applied
 * over it, and typing one in Settings is REFUSED. So the precedence is two
 * tiers, `.env` sits in the TOP one, and the store never beats it.
 *
 * VulnPipe's keystore — which that banner was copied from — genuinely
 * implements the three tiers, because `config/load-env.ts` calls
 * `snapshotRealEnv()` BEFORE its own `loadEnv()`, in a side-effect module
 * whose whole header is about evaluation order. Hence a fourth source,
 * `dotenv`, that the console's `CredentialSource` does not have. The console
 * cannot copy it: Node's `--env-file` is applied before user code runs, and in
 * Docker there is no file to re-read. **The divergence is real and permanent**,
 * which is why it is written down rather than flattened.
 *
 * Nothing here changes behaviour. The behaviour claims pass before and after
 * ON PURPOSE: they are the premise the prose has to match, and a test that
 * only checked the prose would go green the day somebody "fixed" the code to
 * agree with a sentence that was wrong.
 * ============================================================================
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_CREDENTIALS } from './credentials.ts';

let dir: string;
let store: string;

/** A fresh module per test: `snapshotRealEnv` freezes on first call by design. */
async function load() {
  vi.resetModules();
  return import('./credentials.ts');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'menater-cred-prec-'));
  store = join(dir, 'credentials.json');
  process.env.MENATER_CREDENTIALS = store;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MENATER_CREDENTIALS;
});

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// The measured rule. Two tiers, and `.env` is in the top one.
// ---------------------------------------------------------------------------

describe('the precedence the console actually implements', () => {
  it('lets an environment value win over a stored one, and never applies the store over it', async () => {
    writeFileSync(store, JSON.stringify({ OPENROUTER_APIKEY: 'from-the-store' }));
    // What `--env-file-if-exists=.env` and `docker compose` both produce: an
    // ordinary variable, already present when the process starts.
    const env = { OPENROUTER_APIKEY: 'from-dot-env' } as NodeJS.ProcessEnv;

    const { applyCredentialStore, describeCredentials } = await load();
    const touched = applyCredentialStore(env);

    expect(touched).toEqual([]);
    expect(env.OPENROUTER_APIKEY).toBe('from-dot-env');

    const row = describeCredentials(env).find((c) => c.env === 'OPENROUTER_APIKEY');
    expect(row?.locked).toBe(true);
    expect(row?.source).toBe('environment');
  });

  it('has no `dotenv` source to report one with — the tier does not exist here', async () => {
    // The structural half of the divergence, and the half a prose fix cannot
    // carry. VulnPipe's `KeySource` has four variants; this one has three.
    // Adding a fourth here means the precedence changed and both documents
    // above have to move with it.
    const source = read('./credentials.ts');
    const declared = /export type CredentialSource =([^;]+);/.exec(source)?.[1] ?? '';
    const variants = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();

    expect(variants).toEqual(['environment', 'none', 'store']);

    const vulnpipe = read('../../VulnPipe/src/config/keystore.ts');
    const theirs = /export type KeySource =([^;]+);/.exec(vulnpipe)?.[1] ?? '';
    expect([...theirs.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toContain('dotenv');
  });
});

// ---------------------------------------------------------------------------
// The two sentences an operator reads when the field is disabled.
// ---------------------------------------------------------------------------

describe('what the operator is told when a key is locked', () => {
  /**
   * Both named "shell, Docker or CI" — three places, none of them the file
   * that `cp .env.example .env` tells them to fill in, which is the likeliest
   * source of all. "Change it where it is defined" then points nowhere.
   */
  it('names `.env` in the 409 the route returns', async () => {
    const env = { OPENROUTER_APIKEY: 'from-dot-env' } as NodeJS.ProcessEnv;
    const { saveCredentials, CredentialError } = await load();

    let message = '';
    try {
      saveCredentials({ OPENROUTER_APIKEY: 'typed-in-settings' }, env);
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialError);
      message = (err as Error).message;
    }
    expect(message).toContain('.env');
    expect(env.OPENROUTER_APIKEY).toBe('from-dot-env');
  });

  it('names `.env` in the help text under the read-only field', () => {
    const catalogue = read('../src/i18n/console.ts');
    const locked = /locked: \(name\) =>\s*`([^`]+)`/.exec(catalogue)?.[1];
    expect(locked, 'credentials.locked not found in the catalogue').toBeTruthy();
    expect(locked).toContain('.env');
  });
});

// ---------------------------------------------------------------------------
// The catalogue, and the prose that describes it.
// ---------------------------------------------------------------------------

describe('CLAUDE.md names every credential this console manages', () => {
  /**
   * Prose cannot be checked; a list of names can. The table said "OpenRouter,
   * Slack, Shodan, AbuseIPDB, VirusTotal — plus HIBP": six of the twelve, with
   * the assistant's four provider keys and the Discord webhook named nowhere.
   * Same shape as the assistant prompt that described seven tools while
   * `TOOLS` held fourteen.
   *
   * SCOPED TO THAT SECTION, not to the whole file, for the reason the n8n
   * sweep recorded: a corpus that contains the prose discussing a name makes
   * every name vouch for itself. The traps table mentions several of these.
   */
  const section = (() => {
    const doc = read('../../CLAUDE.md');
    const start = doc.indexOf('### Two credential stores');
    expect(start, 'the credential section has been renamed').toBeGreaterThan(-1);
    const after = doc.indexOf('\n## ', start);
    return doc.slice(start, after === -1 ? undefined : after);
  })();

  it.each(MANAGED_CREDENTIALS.map((c) => c.env))('names %s', (name) => {
    expect(section).toContain(name);
  });

  it('names nothing that has left the catalogue', () => {
    // The other direction, and the one that would otherwise let the section go
    // on describing a key somebody removed.
    const known = new Set<string>(MANAGED_CREDENTIALS.map((c) => c.env));
    const named = [...section.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)]
      .map((m) => m[1])
      // Variables that legitimately appear there and are not credentials.
      .filter((n) => !['MENATER_CONFIG', 'MENATER_CREDENTIALS', 'PATH'].includes(n));

    expect(named.length, 'no credential names found — the section changed shape')
      .toBeGreaterThan(0);
    for (const n of new Set(named)) expect(known.has(n), `${n} is not managed`).toBe(true);
  });

  it('does not state ONE precedence for both halves', () => {
    /**
     * The false sentence was *"Precedence for both: real environment > store >
     * `.env`"*, and the error is in the two words "for both" — not in the
     * ordering, which is exactly right about VulnPipe and is quoted in its
     * column of the table above. A first draft of this test forbade the
     * ordering string itself and went red on the corrected section, which is
     * the shape worth remembering: a guard written against the symptom fails
     * the fix. What is forbidden is asserting one rule for two halves that
     * measurably differ.
     */
    expect(section).not.toMatch(/[Pp]recedence for both/);
  });
});
