/**
 * Pipeline credentials.
 *
 * The rule that matters is precedence: real environment > store > nothing.
 * A key set by Docker is a deployment decision, and a file on disk silently
 * overriding it would make the console lie about what the pipeline uses.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let store: string;

/**
 * A fresh module per test.
 *
 * `snapshotRealEnv` freezes on first call BY DESIGN — once we have written to
 * `process.env` we can no longer tell a shell variable from our own. A shared
 * module instance would therefore carry the first test's snapshot into all the
 * others, and the precedence tests would pass for the wrong reason.
 */
async function load() {
  vi.resetModules();
  return import('./credentials.ts');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'menater-cred-'));
  store = join(dir, 'credentials.json');
  process.env.MENATER_CREDENTIALS = store;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MENATER_CREDENTIALS;
});

describe('what the console may write', () => {
  it('refuses a name that is not on the closed list', async () => {
    const { saveCredentials, CredentialError } = await load();
    // The list is closed because this endpoint writes into `process.env`:
    // an arbitrary name would let it set PATH.
    expect(() => saveCredentials({ PATH: '/tmp/evil' }, {}))
      .toThrow(CredentialError);
  });

  it('writes the store 0600 — it holds API keys', async () => {
    const { saveCredentials } = await load();
    saveCredentials({ OPENROUTER_APIKEY: 'sk-test' }, {});
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });
});

describe('precedence: real environment wins', () => {
  it('REFUSES a key already set in the environment, with the reason', async () => {
    const env = { OPENROUTER_APIKEY: 'from-docker' } as NodeJS.ProcessEnv;
    const { saveCredentials, CredentialError } = await load();

    // Accepting it and then ignoring it is the worse of the two answers.
    expect(() => saveCredentials({ OPENROUTER_APIKEY: 'from-ui' }, env))
      .toThrow(CredentialError);
    expect(env.OPENROUTER_APIKEY).toBe('from-docker');
  });

  it('reports such a key as locked, so the field can be shown read-only', async () => {
    const env = { SLACK_BOTTOKEN: 'xoxb-from-docker' } as NodeJS.ProcessEnv;
    const { describeCredentials } = await load();

    const slack = describeCredentials(env).find((c: any) => c.env === 'SLACK_BOTTOKEN');
    expect(slack).toMatchObject({ set: true, locked: true, source: 'environment' });
  });

  it('does not let the store override the environment at startup', async () => {
    writeFileSync(store, JSON.stringify({ OPENROUTER_APIKEY: 'from-store' }));
    const env = { OPENROUTER_APIKEY: 'from-docker' } as NodeJS.ProcessEnv;
    const { applyCredentialStore } = await load();

    expect(applyCredentialStore(env)).toEqual([]);
    expect(env.OPENROUTER_APIKEY).toBe('from-docker');
  });

  it('applies the store when the environment is empty', async () => {
    writeFileSync(store, JSON.stringify({ OPENROUTER_APIKEY: 'from-store' }));
    const env = {} as NodeJS.ProcessEnv;
    const { applyCredentialStore } = await load();

    expect(applyCredentialStore(env)).toEqual(['OPENROUTER_APIKEY']);
    expect(env.OPENROUTER_APIKEY).toBe('from-store');
  });
});

describe('saving', () => {
  it('takes effect on the process immediately — no restart', async () => {
    // This is what makes the model selector go from absent to available in the
    // second after typing: `secretFor()` reads `process.env` at call time.
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials } = await load();

    saveCredentials({ OPENROUTER_APIKEY: 'sk-new' }, env);
    expect(env.OPENROUTER_APIKEY).toBe('sk-new');
  });

  it('empty KEEPS the existing value', async () => {
    // A secret field always comes back empty on screen. Reading that as
    // "erase" would delete the key of anyone who saves Settings untouched.
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials } = await load();

    saveCredentials({ OPENROUTER_APIKEY: 'sk-keep' }, env);
    saveCredentials({ OPENROUTER_APIKEY: '' }, env);

    expect(env.OPENROUTER_APIKEY).toBe('sk-keep');
    expect(JSON.parse(readFileSync(store, 'utf8')).OPENROUTER_APIKEY).toBe('sk-keep');
  });

  it('null erases, from both the store and the process', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials } = await load();

    saveCredentials({ OPENROUTER_APIKEY: 'sk-gone' }, env);
    saveCredentials({ OPENROUTER_APIKEY: null }, env);

    expect(env.OPENROUTER_APIKEY).toBeUndefined();
    expect(JSON.parse(readFileSync(store, 'utf8')).OPENROUTER_APIKEY).toBeUndefined();
  });

  it('never returns the value back out', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials } = await load();

    const status = saveCredentials({ OPENROUTER_APIKEY: 'sk-secret' }, env);
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    expect(status.find((c: any) => c.env === 'OPENROUTER_APIKEY'))
      .toMatchObject({ set: true, source: 'store', locked: false });
  });
});

/**
 * A PATCH IS ALL-OR-NOTHING.
 *
 * `saveCredentials` used to validate and apply in the same pass, and write the
 * store once at the end — so a patch whose SECOND entry is refused left the
 * first one in `process.env` (live: `secretFor()` reads it at call time) and
 * absent from the file. The route answers 409, and the pipeline is already
 * running on the key the operator was told had not been saved, until a restart
 * silently reverts it.
 *
 * The inverse of this product's defining defect: not a failure showing green
 * but a PARTIAL SUCCESS SHOWING RED, in the store that decides which model key
 * the triage uses and whether a human can be asked for an approval. A
 * partially applied credential set is the state nobody can reason about, so
 * every name is checked before anything is touched.
 *
 * The refusal itself is unchanged — same message, same `key`, the first
 * offending entry in insertion order. What changes is what is left behind.
 */
describe('a refused patch changes nothing', () => {
  it('leaves an earlier key out of the process AND out of the file', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials, CredentialError } = await load();
    saveCredentials({ OPENROUTER_APIKEY: 'OLD-KEY' }, env);

    expect(() => saveCredentials(
      { OPENROUTER_APIKEY: 'NEW-KEY', NOT_A_CREDENTIAL: 'x' } as any, env,
    )).toThrow(CredentialError);

    expect(env.OPENROUTER_APIKEY).toBe('OLD-KEY');
    expect(JSON.parse(readFileSync(store, 'utf8')).OPENROUTER_APIKEY).toBe('OLD-KEY');
  });

  it('does not erase a key when a later entry is refused', async () => {
    // `null` is the delete, and a deletion reported as refused is the shape
    // that takes a Slack token off a running console: no approval can be
    // requested, and the operator was told the change did not land.
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials, CredentialError } = await load();
    saveCredentials({ SLACK_BOTTOKEN: 'xoxb-live' }, env);

    expect(() => saveCredentials(
      { SLACK_BOTTOKEN: null, NOT_A_CREDENTIAL: 'x' } as any, env,
    )).toThrow(CredentialError);

    expect(env.SLACK_BOTTOKEN).toBe('xoxb-live');
    expect(JSON.parse(readFileSync(store, 'utf8')).SLACK_BOTTOKEN).toBe('xoxb-live');
  });

  it('refuses the whole patch when one name is LOCKED by the environment', async () => {
    // The likeliest real shape: a browser whose `locked` flags went stale
    // across a restart sends the whole form back.
    const env = { SLACK_BOTTOKEN: 'xoxb-from-docker' } as NodeJS.ProcessEnv;
    const { saveCredentials, CredentialError } = await load();

    expect(() => saveCredentials(
      { OPENROUTER_APIKEY: 'NEW-KEY', SLACK_BOTTOKEN: 'typed-anyway' }, env,
    )).toThrow(CredentialError);

    expect(env.OPENROUTER_APIKEY).toBeUndefined();
    expect(existsSync(store)).toBe(false);
  });

  it('names the FIRST offending entry, as it always did', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials, CredentialError } = await load();

    try {
      saveCredentials(
        { NOT_A_CREDENTIAL: 'x', ALSO_NOT_ONE: 'y' } as any, env,
      );
      expect.unreachable('the patch must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialError);
      expect((err as any).key).toBe('NOT_A_CREDENTIAL');
    }
  });

  it('still applies every entry of a patch that is wholly valid', async () => {
    // The boundary: all-or-nothing must not become none-at-all. Passes before
    // and after the fix, on purpose.
    const env = {} as NodeJS.ProcessEnv;
    const { saveCredentials } = await load();

    saveCredentials(
      { OPENROUTER_APIKEY: 'sk-a', SHODAN_APIKEY: 'sh-b', HIBP_APIKEY: 'hi-c' }, env,
    );

    expect(env.OPENROUTER_APIKEY).toBe('sk-a');
    expect(env.SHODAN_APIKEY).toBe('sh-b');
    expect(env.HIBP_APIKEY).toBe('hi-c');
    const onDisk = JSON.parse(readFileSync(store, 'utf8'));
    expect(onDisk).toMatchObject({
      OPENROUTER_APIKEY: 'sk-a', SHODAN_APIKEY: 'sh-b', HIBP_APIKEY: 'hi-c',
    });
  });
});

describe('an unreadable store does not stop the console', () => {
  it('starts from nothing rather than throwing', async () => {
    writeFileSync(store, 'not json at all');
    const env = {} as NodeJS.ProcessEnv;
    const { applyCredentialStore } = await load();

    expect(() => applyCredentialStore(env)).not.toThrow();
    expect(env.OPENROUTER_APIKEY).toBeUndefined();
  });
});

describe('the list itself', () => {
  it('names the model key as the required one', async () => {
    // The only credential whose absence changes every verdict.
    const { describeCredentials } = await load();
    const required = describeCredentials({}).filter((c: any) => c.required);
    expect(required.map((c: any) => c.env)).toEqual(['OPENROUTER_APIKEY']);
  });

  it('matches the credential names the workflows ask for', async () => {
    // `secretFor('openrouter.apiKey')` derives OPENROUTER_APIKEY. If these
    // drift apart the key is stored and never found.
    const { MANAGED_CREDENTIALS } = await load();
    for (const c of MANAGED_CREDENTIALS) {
      expect(c.credential.toUpperCase().replace(/[.-]/g, '_')).toBe(c.env);
    }
  });
});
