/**
 * @vitest-environment jsdom
 */
/**
 * The Rules tab when the rule set cannot be read.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `RulesPage` is the whole tab, not a section of one — so its `if (error)`
 * branch, which returns a bare banner INSTEAD of the page, is the only place
 * in this console where a failure deletes the screen it is a failure of.
 * Measured in Chromium on the built bundle, with a database configured and
 * nothing listening on it:
 *
 *     tab        headings   main height
 *     Tracking   3          583 px   "No run in the window: the pipeline
 *                                     processed nothing, or is unreachable."
 *     Health     7          1389 px  "Unreachable — postgresql://…"
 *     Rules      0          104 px   one line, and it was in FRENCH
 *
 * Three facts, and each has its own test below.
 *
 * 1. ZERO HEADINGS. The page title, the kicker and the lede all live inside
 *    the branch that is skipped, so the tab loses its identity exactly when
 *    somebody needs to know which screen is broken — and a reader navigating
 *    by heading finds nothing at all. `CLARITY.md` § 9's first question is
 *    whether the page still has exactly one level-1 title.
 *
 * 2. THE SENTENCE WAS IN FRENCH. `ruleDb` labelled the cause
 *    `Base de données (règles)`, while `PgRunStore.q()` — the sibling that
 *    describes every other query failure, in the same module's import — writes
 *    `Database (SELECT)`. One file over, in English. The catalogue sweep in
 *    `n8n-removed.test.ts` cannot see it: it is a template literal in a server
 *    module, not a catalogue entry.
 *
 * 3. NEITHER SENTENCE SAID WHERE TO FIX IT. `rulesNoDatabase` stopped at
 *    "the rules cannot be read", while `simulateNoEngine` — the next key in
 *    the same catalogue, for the same missing database — ends with
 *    "Settings → Database."
 *
 * The reason that reaches the screen stays the SERVER's, which is what
 * `api-named-failures.test.ts` exists to protect: the browser holds a
 * sentence, the server holds the state, and only the server can tell "no
 * database configured" from "a database that refuses". That is also why the
 * console catalogue's own `rules.noDatabase` — "Database unreachable: the
 * rules cannot be read.", referenced by nothing since it was written — is not
 * wired in here but removed. It is wrong on half the states it would cover.
 *
 * Like `rules-refusal.test.tsx`, this drives the REAL route behind the REAL
 * client behind the REAL screen: the defect is what an operator reads, and a
 * fixture mapping a status to a message would agree with itself.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A REAL path: these tests change the database coordinates through
// `saveConfig`, which writes the file.
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-rules-failure-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('../../server/app.ts');
const { saveConfig } = await import('../../server/config.ts');
const { messages } = await import('../../server/i18n.ts');
const { render } = await import('../vulnpipe/test-utils.tsx');
const { RulesPage } = await import('./RulesPage.tsx');
const { consoleDictionary } = await import('../i18n/console.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const t = consoleDictionary('en').rules;
const am = messages('en').api;

/** Drives the real handler, the way `rules-refusal.test.tsx` does. */
async function serve(method: string, url: string, payload: string | null) {
  const captured = { status: 0, body: '', headers: {} as Record<string, string> };
  const req: any = {
    method,
    url,
    headers: { host: 'localhost:4400' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload, 'utf8');
    },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status;
      captured.headers = headers;
      res.headersSent = true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

/** The console on the other end of `fetch`, which is the only seam. */
function consoleOnTheOtherEnd(): void {
  vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
    const c = await serve(String(init.method ?? 'GET'), String(url), init.body ?? null);
    return new Response(c.body, {
      status: c.status,
      headers: { 'Content-Type': c.headers['Content-Type'] ?? 'application/json' },
    });
  });
}

const banner = () => document.querySelector('.soc-banner-error') as HTMLElement | null;
const titles = () => screen.queryAllByRole('heading', { name: t.title });

beforeEach(() => consoleOnTheOtherEnd());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('no database configured — the state of a fresh install', () => {
  beforeEach(() => saveConfig({ database: { host: '', database: '' } }));

  it('keeps the screen the failure is ABOUT', async () => {
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    // One, and exactly one: the identity of the tab, not a second copy of it.
    expect(titles()).toHaveLength(1);
  });

  it('carries the reason the server named, not a code', async () => {
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(within(banner() as HTMLElement).getByText(am.rulesNoDatabase)).toBeTruthy();
  });

  it('says WHERE the operator fixes it', async () => {
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    // The sibling key `simulateNoEngine` has ended this way since it was
    // written, for the same missing database.
    expect(banner()!.textContent).toMatch(/Settings → Database/);
  });

  it('does not offer to write a rule into a store it cannot read', async () => {
    // THE BOUNDARY. Keeping the page head must not bring back the editor: a
    // rule saved against an unreadable set is a rule nobody can see.
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(screen.queryByRole('button', { name: t.add })).toBeNull();
    expect(screen.queryByRole('button', { name: t.fromTemplate })).toBeNull();
  });

  it('does not announce a standing failure in a live region', async () => {
    // `CLARITY.md` § 8: the console re-renders on every poll, and a region is
    // for what APPEARED BECAUSE SOMEBODY ACTED. This sentence is here on
    // arrival, and it stays. Passes before and after the change, on purpose.
    const { container } = render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(container.querySelectorAll('[aria-live],[role="status"],[role="alert"]')).toHaveLength(0);
  });
});

describe('a database that is configured and refuses', () => {
  // Port 1 is privileged: nothing can be listening, so the refusal is
  // immediate and does not depend on whether this machine has a Postgres.
  beforeEach(() => saveConfig({
    database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater' },
  }));

  it('keeps the screen the failure is ABOUT', async () => {
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(titles()).toHaveLength(1);
  });

  it('names the cause pg itself reports with an empty message', async () => {
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(banner()!.textContent).toMatch(/ECONNREFUSED/);
  });

  it('says it in English, like the sibling that describes every other query', async () => {
    render(<RulesPage />);
    await waitFor(() => expect(banner()).toBeTruthy());
    const sentence = banner()!.textContent ?? '';
    expect(sentence).toMatch(/^Database \(rules\)/);
    // Measured on the real route: the prefix was `Base de données (règles)`.
    expect(sentence).not.toMatch(/[éèêëàâçùûôîï]/i);
  });
});

describe('the rule set loads', () => {
  // THE CONTROL. The page head is written once and reached by both branches,
  // so the success path must still carry exactly one title. Passes before and
  // after.
  beforeEach(() => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const empty = String(url).includes('/templates')
        ? { templates: [], drafts: [] }
        : { rules: [] };
      return new Response(JSON.stringify(empty), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  it('shows the page title once, and the editor', async () => {
    render(<RulesPage />);
    expect(await screen.findByRole('button', { name: t.add })).toBeTruthy();
    expect(titles()).toHaveLength(1);
    expect(banner()).toBeNull();
  });
});
