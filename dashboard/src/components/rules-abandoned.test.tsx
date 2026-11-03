/**
 * @vitest-environment jsdom
 */
/**
 * "Your pattern is too slow to run" has to reach the person who typed it.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `bounded-regex.ts` makes a rule whose regular expressions run out of their
 * budget match NOTHING — fail-safe, and the same answer an invalid pattern
 * already gets. That half is silent on its own, and silence here is the defect
 * this product exists to expose: a rule that stops deciding looks exactly like
 * a rule that did not match, and the only person who can fix the pattern is
 * the one reading the dry run.
 *
 * `rules-dry-run.test.ts` proves the route carries the list. It cannot prove
 * the two halves MEET, because it never mounts the screen — and a field named
 * on one side of a boundary and read on the other is the shape this repository
 * has paid for more than once. So the payload the screen reads here is the
 * REAL route's answer, not a hand-written one.
 *
 * The one thing injected is the rule itself: the panel sends only the alert
 * and the route then reads the STORED set, which needs a database this
 * environment does not have. So the body is intercepted and the draft added —
 * every field the screen reads is still composed by the server.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-rules-abandoned-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('../../server/app.ts');
const { saveConfig } = await import('../../server/config.ts');
const { render } = await import('../vulnpipe/test-utils.tsx');
const { RulesPage } = await import('./RulesPage.tsx');
const { consoleDictionary } = await import('../i18n/console.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const t = consoleDictionary('en').rules;

/** Six characters that do not terminate, against the subject cap. */
const EXPONENTIAL = '(a+)+$';
const SUBJECT = `${'a'.repeat(1999)}!`;

async function serve(url: string, payload: string) {
  const captured = { status: 0, body: '' };
  const req: any = {
    method: 'POST',
    url,
    headers: { host: 'localhost:4400' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload, 'utf8'); },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

beforeEach(() => {
  // Configured and unreachable: `getRuleStore()` answers whether a database is
  // CONFIGURED, and a dry run on body-supplied rules opens no socket.
  saveConfig({ database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater' } });
  vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
    const method = String(init.method ?? 'GET');
    if (method === 'GET' && String(url).startsWith('/api/rules')) {
      const empty = String(url).includes('/templates') ? { templates: [], drafts: [] } : { rules: [] };
      return new Response(JSON.stringify(empty), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const sent = JSON.parse(String(init.body ?? '{}'));
    const c = await serve(String(url), JSON.stringify({
      ...sent,
      rules: [{
        name: 'Scanner noise',
        conditions: [{ field: 'raw_log', op: 'regex', values: [EXPONENTIAL] }],
        action: 'allow',
      }],
    }));
    return new Response(c.body, { status: c.status, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a dry run on a pattern too slow to decide', () => {
  it('names the rule and says what to do, instead of reporting no match', async () => {
    const user = userEvent.setup();
    const { container } = render(<RulesPage />);

    const field = await screen.findByLabelText(t.testAlert);
    await user.clear(field);
    // `type()` would send two thousand keystrokes through the event loop.
    await user.click(field);
    await user.paste(JSON.stringify({ alert_id: 'A-1', raw_log: SUBJECT }));
    await user.click(screen.getByRole('button', { name: new RegExp(t.testRun) }));

    await waitFor(() => {
      expect(container.querySelector('.soc-banner')).toBeTruthy();
    });
    const banner = within(container.querySelector('.soc-banner') as HTMLElement);

    // The sentence the operator needs: which rule, what it decided (nothing),
    // and what to change.
    expect(banner.getByText(new RegExp('Scanner noise'))).toBeTruthy();
    expect(banner.getByText(/simplify the pattern/)).toBeTruthy();

    /**
     * And NOT only "no rule matches". That sentence is true and, alone, it is
     * the failure that shows green: it is what an operator reads as "my rule
     * is fine, this alert simply is not covered".
     */
    const none = screen.queryByText(t.testNoMatch);
    expect(none === null || /simplify the pattern/.test(none.parentElement?.textContent ?? '')).toBe(true);
  });
});
