/**
 * @vitest-environment jsdom
 */
/**
 * The rules editor's refusal banner, from the server's sentence to the screen.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `RulesPage.save()` reads `err.problems` and renders one line per entry, under
 * a comment saying "showing 'invalid' instead would throw that away". That read
 * had never once returned anything: `lib/api.ts` threw a plain `ApiError`, so
 * the array the server sends under `problems` stopped at the HTTP client. What
 * reached the operator was "The console server answered 400 with no
 * explanation" — on the screen where they write the rules that decide what
 * stops reaching a human.
 *
 * `api-named-failures.test.ts` proves the client now carries the list. It
 * cannot prove the two halves MEET, because it never mounts the component —
 * and the whole defect was two halves that did not. So this one puts the REAL
 * handler behind the REAL client behind the REAL screen, and reads the banner.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-rules-refusal-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('../../server/app.ts');
const { saveConfig } = await import('../../server/config.ts');
const { render } = await import('../vulnpipe/test-utils.tsx');
const { RulesPage } = await import('./RulesPage.tsx');
const { consoleDictionary } = await import('../i18n/console.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const t = consoleDictionary('en').rules;

/** Drives the real handler, the way `api-named-failures.test.ts` does. */
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

beforeEach(() => {
  // Configured and refusing: the rules routes validate the body BEFORE they
  // dial, so the 400 is reached without a socket, and the no-database 503 does
  // not short-circuit it. Port 1 is privileged — nothing can be listening.
  saveConfig({ database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater' } });
  vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
    const method = String(init.method ?? 'GET');
    /**
     * THE TWO READS ARE ANSWERED HERE, AND NOTHING ELSE IS.
     *
     * `RulesPage` returns its error panel instead of the page when the LIST
     * cannot be read, so against a refusing database there is no editor to
     * open — and this test is about the editor's refusal, not the list's. The
     * reads answer an empty catalogue; `POST /api/rules`, the path under test,
     * goes to the real handler and comes back through the real client.
     */
    if (method === 'GET' && String(url).startsWith('/api/rules')) {
      const empty = String(url).includes('/templates')
        ? { templates: [], drafts: [] }
        : { rules: [] };
      return new Response(JSON.stringify(empty), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const c = await serve(method, String(url), init.body ?? null);
    return new Response(c.body, {
      status: c.status,
      headers: { 'Content-Type': c.headers['Content-Type'] ?? 'application/json' },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a tuning rule the server refuses', () => {
  it('shows every field the server named, not a status code', async () => {
    const user = userEvent.setup();
    const { container } = render(<RulesPage />);

    await user.click(await screen.findByRole('button', { name: t.add }));
    await user.click(screen.getByRole('button', { name: t.save }));

    await waitFor(() => {
      expect(container.querySelector('.soc-banner-error')).toBeTruthy();
    });

    /**
     * Scoped to the banner deliberately.
     *
     * The editor's own help text for the owner field reads "An exception with
     * no owner is one nobody will dare remove", which is the same sentence the
     * server writes back — so an unscoped `getByText` finds two nodes and the
     * query stops proving anything about the banner. Narrow the query rather
     * than loosen the assertion: `Explain` taught this file's neighbours the
     * same lesson.
     */
    const banner = within(container.querySelector('.soc-banner-error') as HTMLElement);

    // One line per thing wrong, each saying what goes wrong if it stands.
    expect(banner.getByText(/A rule needs a name/)).toBeTruthy();
    expect(banner.getByText(/An exception with no owner/)).toBeTruthy();
    expect(banner.getByText(/In six months this is the only thing/)).toBeTruthy();
    expect(banner.getByText(/This operator needs at least one value/)).toBeTruthy();

    // FOUR lines, one per refusal, and that count is the assertion that
    // separates "the list arrived" from "one sentence arrived": a join read as
    // a single message would render as one.
    expect(container.querySelectorAll('.soc-banner-error p > span')).toHaveLength(4);

    // And NOT the sentence that replaced all four of them.
    expect(screen.queryByText(consoleDictionary('en').errors.noExplanation(400))).toBeNull();
  });
});
