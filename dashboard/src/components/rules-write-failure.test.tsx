/**
 * @vitest-environment jsdom
 */
/**
 * The two writes on the Rules tab that threw their failure away.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * This console makes sixteen writes from the browser. Fourteen of them sit in
 * a `try` that puts the server's own sentence on screen — `saveSettings`,
 * `saveCredentials`, `saveVariables`, `saveIngestionPolicy`, `pollNow`,
 * `simulate`, `replay`, `resume`, `verifyChain`, `testDatabase`,
 * `mcpGenerateToken`, `mcpTest`, `createRule` and `updateRule` from the
 * editor. Two were written `.catch(() => {})`:
 *
 *     RulesPage.toggle()  →  api.updateRule(...).catch(() => {})
 *     RulesPage.remove()  →  api.deleteRule(...).catch(() => {})
 *
 * They are the two controls on every row of the rule list, on the screen where
 * a team writes the rules deciding what stops reaching a human — and the write
 * that DOES report, `save()`, is the function directly above them in the same
 * component. The mirror of a rule is not the rule, at the shortest distance
 * this repository has yet paid for it.
 *
 * What an operator got: nothing. The failure was discarded, `load()` re-read
 * the set, and the row came back exactly as it was. Press Disable on a rule
 * that is closing alerts and it stays enabled, with no word anywhere — a
 * button that reads as broken, over a rule that is still running. Confirm a
 * deletion and the rule is still in the list, after `window.confirm` has
 * already taken the operator's "yes".
 *
 * ============================================================================
 * THE TWO FAILURES BELOW ARE THE TWO SHAPES, AND NEITHER IS A FIXTURE
 *
 * 1. THE WRITE NEVER LEFT. `fetch` rejects — a restarted console container, a
 *    proxy dropping one request, a socket that died — and the read a moment
 *    later succeeds. This needs no premise about the server at all, and it is
 *    the one state in which the read cannot cover for the write: `load()`
 *    answers, so the page keeps rendering, and the row quietly disagrees with
 *    what the operator just asked for.
 *
 * 2. THE SERVER REFUSED IN WORDS. The real route, with a database configured
 *    and refusing: `ruleDb` wraps the failure through `describePgError` and
 *    `app.ts` answers **503** carrying `Database (rules): connect
 *    ECONNREFUSED`. That sentence exists, is written for an operator, and had
 *    never once left the process on this path. It stands for every write-side
 *    database failure — a revoked UPDATE grant, a read-only replica, a full
 *    disk — where SELECT keeps answering.
 *
 * Like `rules-refusal.test.tsx`, which exists for the OTHER write on this same
 * screen, the refusal is produced by the REAL handler and travels through the
 * REAL client into the REAL screen: a fixture mapping a status to a message
 * would agree with whatever the fix happened to write.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A REAL path: these tests set the database coordinates through `saveConfig`,
// which writes the file.
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-rules-write-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('../../server/app.ts');
const { saveConfig } = await import('../../server/config.ts');
const { render } = await import('../vulnpipe/test-utils.tsx');
const { RulesPage } = await import('./RulesPage.tsx');
const { consoleDictionary } = await import('../i18n/console.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const t = consoleDictionary('en').rules;

/**
 * The rule the list serves.
 *
 * Enabled, so the row's button reads "Disable" and the exposure a silent
 * failure leaves is the dangerous direction: a rule still closing alerts that
 * the operator believes they have just switched off. The id is 36 characters
 * of hex-and-dashes because that is what `/^\/api\/rules\/([0-9a-fA-F-]{36})$/`
 * matches — a shorter one would never reach the route under test.
 */
const RULE = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Nightly backup agent',
  enabled: true,
  priority: 100,
  conditions: [{ field: 'rule_name', op: 'contains' as const, values: ['backup'] }],
  action: 'allow' as const,
  severity: null,
  owner: 'soc@example.com',
  reason: 'The backup agent reads every file on the host, every night.',
  expires_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  match_count: 12,
  last_matched_at: '2026-10-13T00:00:00.000Z',
};

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

/** The two reads the screen makes on mount, and nothing else. */
function reads(url: string): Response | null {
  if (!url.startsWith('/api/rules')) return null;
  const body = url.includes('/templates')
    ? { templates: [], drafts: [] }
    : { rules: [RULE] };
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

const banner = () => document.querySelector('.soc-banner-error') as HTMLElement | null;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Mounted and loaded: the row and its two controls are on screen. */
async function openTheList() {
  render(<RulesPage />);
  expect(await screen.findByText(RULE.name)).toBeTruthy();
}

describe('a write the console never managed to send', () => {
  /** Reads answer; the write rejects at the transport, as a dropped request does. */
  let sent: string[];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
      const method = String(init.method ?? 'GET');
      const answer = method === 'GET' ? reads(String(url)) : null;
      if (answer) return answer;
      sent.push(`${method} ${String(url)}`);
      throw new TypeError('fetch failed');
    });
  });

  it('says the rule was NOT disabled, and names it', async () => {
    const user = userEvent.setup();
    await openTheList();

    await user.click(screen.getByRole('button', { name: t.disable }));

    // The write was attempted — without this the next assertion could pass
    // over a button that dials nothing.
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toBe(`PUT /api/rules/${RULE.id}`);

    await waitFor(() => expect(banner()).toBeTruthy());
    // WHAT STILL HOLDS, not "an error occurred": the rule is still enabled,
    // and that is the operator's exposure.
    expect(within(banner()!).getByText(new RegExp(t.notDisabled(RULE.name)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  });

  it('says the rule was NOT deleted, after the operator already said yes', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', () => true);
    await openTheList();

    await user.click(screen.getByRole('button', { name: t.removeRule(RULE.name) }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toBe(`DELETE /api/rules/${RULE.id}`);

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(within(banner()!).getByText(new RegExp(t.notRemoved(RULE.name)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  });

  it('says the rule is still DISABLED when enabling is what failed', async () => {
    // The other direction, and it is not decoration: one sentence for both
    // would be reachable from a state it does not describe, and the mutation
    // that reuses `notDisabled` here is red on this test alone. The row's
    // button reads `Enable`, so this is the state an operator reaches by
    // pressing it.
    const user = userEvent.setup();
    vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
      const method = String(init.method ?? 'GET');
      if (method === 'GET') {
        const body = String(url).includes('/templates')
          ? { templates: [], drafts: [] }
          : { rules: [{ ...RULE, enabled: false }] };
        return new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new TypeError('fetch failed');
    });

    render(<RulesPage />);
    expect(await screen.findByText(RULE.name)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t.enable }));

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(banner()!.textContent).toContain(t.notEnabled(RULE.name));
    expect(banner()!.textContent).not.toContain(t.notDisabled(RULE.name));
  });

  it('takes the sentence back down when the next write lands', async () => {
    // A banner saying a rule is still enabled, left standing over a rule that
    // has since been disabled, is a failure showing RED — which this console
    // refuses for the same reason it refuses one showing green. The row is the
    // record; the sentence is about one click.
    const user = userEvent.setup();
    let refuse = true;
    vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
      const method = String(init.method ?? 'GET');
      const answer = method === 'GET' ? reads(String(url)) : null;
      if (answer) return answer;
      if (refuse) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ rule: { ...RULE, enabled: false } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await openTheList();
    await user.click(screen.getByRole('button', { name: t.disable }));
    await waitFor(() => expect(banner()).toBeTruthy());

    refuse = false;
    await user.click(screen.getByRole('button', { name: t.disable }));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('announces it, because it appeared because somebody acted', async () => {
    const user = userEvent.setup();
    await openTheList();
    await user.click(screen.getByRole('button', { name: t.disable }));
    await waitFor(() => expect(banner()).toBeTruthy());

    // The region has to PRE-EXIST its sentence, so it is a wrapper around a
    // conditional banner and not an attribute on one — `Guidance.tsx`'s first
    // decision. Asserted as containment rather than by counting regions: the
    // editor and the dry run each have one of their own.
    const region = banner()!.closest('[role="status"]');
    expect(region).toBeTruthy();
    // And NOT inside a fold. A closed `<details>` is absent from the
    // accessibility tree while jsdom still renders its body, so this property
    // cannot be read off the page here — it is pinned structurally.
    expect(region!.closest('details')).toBeNull();
  });

  it('keeps the rule list the failure is ABOUT', async () => {
    // THE BOUNDARY, and the lesson from the one screen that answered a failure
    // by deleting itself: a write that failed must not take the set with it.
    // `error` is the state "the rules cannot be READ" and this is not that.
    const user = userEvent.setup();
    await openTheList();
    await user.click(screen.getByRole('button', { name: t.disable }));
    await waitFor(() => expect(banner()).toBeTruthy());

    expect(screen.getByText(RULE.name)).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: t.title })).toHaveLength(1);
    expect(screen.getByRole('button', { name: t.disable })).toBeTruthy();
  });
});

describe('a write the server refused in words', () => {
  beforeEach(() => {
    // Configured and refusing. Port 1 is privileged: nothing can be listening,
    // so the refusal is immediate and does not depend on this machine having a
    // Postgres. `getRuleStore()` builds a pool lazily, so the route is reached
    // and the failure happens in the WRITE.
    saveConfig({ database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater' } });
    vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
      const method = String(init.method ?? 'GET');
      const answer = method === 'GET' ? reads(String(url)) : null;
      if (answer) return answer;
      const c = await serve(method, String(url), init.body ?? null);
      return new Response(c.body, {
        status: c.status,
        headers: { 'Content-Type': c.headers['Content-Type'] ?? 'application/json' },
      });
    });
  });

  it('carries the sentence `ruleDb` wrote, which never left the process', async () => {
    const user = userEvent.setup();
    await openTheList();
    await user.click(screen.getByRole('button', { name: t.disable }));

    await waitFor(() => expect(banner()).toBeTruthy());
    const said = banner()!.textContent ?? '';
    // English, like `PgRunStore.q()`'s sibling — and the cause `pg` itself
    // reports with an EMPTY message, recovered by `describePgError`.
    expect(said).toMatch(/Database \(rules\)/);
    expect(said).toMatch(/ECONNREFUSED/);
    // And not the generic sentence that replaces a 503 nobody explained.
    expect(said).not.toMatch(/npm run serve/);
  });
});

describe('the controls that work', () => {
  // CONTROLS. Both pass before AND after: the fix must not put a banner on a
  // screen where nothing went wrong, and must not dial on a cancelled confirm.
  beforeEach(() => {
    vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
      const method = String(init.method ?? 'GET');
      const answer = method === 'GET' ? reads(String(url)) : null;
      if (answer) return answer;
      return new Response(JSON.stringify({ rule: { ...RULE, enabled: false } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  it('says nothing when the write lands', async () => {
    const user = userEvent.setup();
    await openTheList();
    await user.click(screen.getByRole('button', { name: t.disable }));
    // Settled: the re-read has come back and the row is rendered again.
    await waitFor(() => expect(screen.getByText(RULE.name)).toBeTruthy());
    expect(banner()).toBeNull();
  });

  it('dials nothing when the operator cancels the deletion', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', () => false);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
      const method = String(init.method ?? 'GET');
      seen.push(`${method} ${String(url)}`);
      return reads(String(url)) ?? new Response('{}', { status: 200 });
    });
    await openTheList();
    seen.length = 0;

    await user.click(screen.getByRole('button', { name: t.removeRule(RULE.name) }));
    expect(seen).toHaveLength(0);
    expect(banner()).toBeNull();
  });
});
