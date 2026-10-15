/**
 * @vitest-environment jsdom
 */
/**
 * J0.1's button, and the refusals it could not read.
 *
 * ============================================================================
 * WHAT WAS WRONG
 *
 * `PromoteFinding` called `fetch('/api/findings/promote')` itself. It was the
 * ONLY raw `fetch` left in the browser half of this product — the sweep that
 * found it is pinned at the bottom of this file — and `src/lib/api.ts` is the
 * single place that knows how to read this server's refusals. So the one
 * control that bridges the two halves of this product was the one control that
 * could not read what the server said.
 *
 * The route itself is careful: `server/routes/findings.ts` answers **200** for
 * every state IT decides — a refused alert, a duplicate, no engine, an engine
 * that threw — with the sentence in `response`, under a comment explaining
 * that a 4xx or a 5xx would be rewritten by `lib/api.ts`. That half worked and
 * is claimed below as a control.
 *
 * But the access lock and the 256 kB body cap answer BEFORE the route runs,
 * and neither of them writes `response`. Measured by driving the real handler:
 *
 *   POST /api/findings/promote, console password set
 *     401 {"error":"Authentication required.","auth_required":true}
 *     → "The console could not be reached: HTTP 401. Nothing entered the queue."
 *
 *   POST /api/findings/promote, body over the cap
 *     413 {"error":"Request body over 256 kB. It was refused before being
 *          read, so nothing here is a statement about what it contained."}
 *     → "The console could not be reached: HTTP 413. Nothing entered the queue."
 *
 * Two defects in one sentence. The reason the server wrote is thrown away for
 * the status code — the trap this repository has paid for on twenty routes
 * already — and the sentence ASSERTS the console was out of reach, about a
 * console that answered in milliseconds and said what to do about it. A
 * sentence must not be reachable from a state it does not describe.
 *
 * ============================================================================
 * WHY THE WHOLE STACK AND NOT A FIXTURE
 *
 * Both sentences are composed by code nobody would think to look at from here:
 * `server/auth.ts` decides the 401 and `server/respond.ts` words the 413
 * through `humanBytes`. A fixture mapping 401 to a string would agree with
 * whatever this test happened to write. So `fetch` is replaced by the REAL
 * request handler and the component is mounted in front of it — the shape
 * `api-named-failures.test.ts` and `rules-refusal.test.tsx` already use.
 * ============================================================================
 */

import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { render } from '../test-utils.tsx';
import { PromoteFinding } from './PromoteFinding.tsx';
import type { ReportFinding } from './ReportView.tsx';
import { consoleDictionary } from '../../i18n/console.ts';
import { dictionary } from '../../i18n/dictionary.ts';

// A real path: enabling the lock goes through `saveConfig`, which writes.
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-promote-refusals-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('../../../server/app.ts');
const { saveConfig } = await import('../../../server/config.ts');
const { messages } = await import('../../../server/i18n.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const en = dictionary('en').report;
const cn = consoleDictionary('en');
/** What the server is handed to word its own answers. */
const am = messages('en').api;

const FINDING: ReportFinding = {
  severity: 'critical',
  report_level: 'critical',
  vulnerability: 'IDOR',
  route: '/orders/:id',
  http_method: 'GET',
  file: 'src/routes/orders.ts',
  line: 42,
  claude_verdict: 'confirmed',
  claude_reasoning: 'The handler reads the id straight off the params.',
  technical_summary: 'No ownership check between the lookup and the response.',
  plain_language_summary: 'Anyone logged in can read anyone else’s order.',
  suggested_fix_direction: 'Scope the query to the authenticated user.',
  owasp_category: 'A01:2021 Broken Access Control',
  evidence: 'code',
  local_confidence_score: 0.82,
  detected_by: ['idor-scanner'],
  code_excerpt: null,
};

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

/** The real server behind the real client. `fetch` is the only seam. */
function consoleOnTheOtherEnd(): void {
  vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
    const c = await serve(String(init.method ?? 'GET'), String(url), init.body ?? null);
    return new Response(c.body, {
      status: c.status,
      headers: { 'Content-Type': c.headers['Content-Type'] ?? 'application/json' },
    });
  });
}

const press = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: /send to the triage queue/i }));
};

beforeEach(() => {
  consoleOnTheOtherEnd();
  // No database, so the route reaches `getEngine() === null` and answers its
  // own `promoteNoEngine` — the control below. The lock is off by default,
  // which is what this product ships.
  saveConfig({ database: { host: '', database: '' }, auth: { enabled: false, salt: '', hash: '' } } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a refusal that answers before the route does', () => {
  it('shows the access lock’s own sentence, not the status code', async () => {
    saveConfig({ auth: { enabled: true, salt: 'salt', hash: 'hash' } } as never);
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" target="acme/api" />);

    await press();

    const note = await screen.findByRole('status');
    // The server's sentence. It is the one that says what to do — sign in
    // again — and it is composed in `server/auth.ts`, not here.
    await waitFor(() => expect(note.textContent).toContain(cn.errors.authRequired));
    expect(note.textContent).not.toMatch(/HTTP 401/);
  });

  it('does not claim the console was out of reach when it answered', async () => {
    saveConfig({ auth: { enabled: true, salt: 'salt', hash: 'hash' } } as never);
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" target="acme/api" />);

    await press();

    const note = await screen.findByRole('status');
    // The half that is not about the reason: the old sentence opened with
    // « The console could not be reached », about a console that had just
    // answered. The consequence — nothing entered the queue — is true either
    // way and stays.
    await waitFor(() => expect(note.textContent).toMatch(/nothing entered the queue/i));
    expect(note.textContent).not.toMatch(/could not be reached/i);
  });

  it('shows the body cap’s own sentence, with the cap in it', async () => {
    // `readBodyOrNull` keeps `null` for a body that could not be READ and lets
    // a refusal WE made travel on, so this reaches `app.ts`'s 413 rather than
    // the route's "a non-empty string is required".
    // The excerpt is where a real finding's weight is, and it is the one
    // field of this shape that can plausibly carry 300 kB: the scanner reads
    // it off the file it analysed.
    const huge: ReportFinding = {
      ...FINDING,
      code_excerpt: {
        start_line: 1,
        lines: Array.from({ length: 300 }, () => 'x'.repeat(1000)),
        highlight_line: 42,
        truncated: false,
      },
    };
    render(<PromoteFinding finding={huge} scanRunId="scan-001" target="acme/api" />);

    await press();

    const note = await screen.findByRole('status');
    // Worded through `humanBytes`, which exists so that a cap an operator
    // cannot say out loud does not reach them as « over 0.00048828125 MB ».
    await waitFor(() => expect(note.textContent).toMatch(/256 kB/));
    expect(note.textContent).not.toMatch(/HTTP 413/);
  });

  it('is told apart from a console that really did not answer', async () => {
    // The sentence the old wording asserted for everything is still here, and
    // now reachable only from the state it describes.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" target="acme/api" />);

    await press();

    const note = await screen.findByRole('status');
    await waitFor(() => expect(note.textContent).toContain(cn.errors.apiUnreachable));
  });
});

describe('what the route itself decides is unchanged', () => {
  it('still prints the server’s sentence for a state the ROUTE answers', async () => {
    // 200 with `ok: false` and `response`. This is the shape J0.1 was built
    // around and the reason the route refuses to use status codes at all —
    // green before AND after, on purpose: without it, "the named reason now
    // arrives" could be satisfied by a change that broke the common case.
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" target="acme/api" />);

    await press();

    const note = await screen.findByRole('status');
    await waitFor(() => expect(note.textContent).toBe(am.promoteNoEngine));
    expect(note.className).toContain('vp-promote-failed');
  });
});

/**
 * ============================================================================
 * THE SWEEP THAT FOUND IT
 *
 * Not "is `PromoteFinding` fixed" — that is the two describes above. This is
 * the rule, written as the whole subtraction: the browser talks to a server
 * through one of the two clients, and through nothing else. One of them is the
 * console's (`src/lib/api.ts`, which carries `BASE`, the 401 and
 * `namedReason`); the other is the analysis section's
 * (`src/vulnpipe/lib/api.ts`, which carries `VITE_VULNPIPE_API_URL` and its own
 * reader). A third caller is a third reader, and it will be missing whichever
 * of those two it did not happen to copy.
 *
 * Comments are stripped first, for the reason `rules-match.test.ts` gives: the
 * prose above this line contains the word it hunts, and a test whose own
 * explanation vouches for the strings it searches is green on its own comment.
 * ============================================================================
 */
describe('nothing in the browser dials a server by itself', () => {
  // `import.meta.dirname`, not `import.meta.url`: under jsdom the latter is not
  // a `file:` URL, and `readdirSync` refuses it. The same choice
  // `heading-outline.test.tsx` makes, for the same reason.
  const SRC = join(import.meta.dirname, '..', '..');

  /** Every browser source file, tests and the two clients excluded. */
  const browserFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = `${rel}${entry.name}`;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), `${next}/`);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          out.push(next);
        }
      }
    };
    walk(SRC, '');
    return out.filter((f) => f !== 'lib/api.ts' && f !== 'vulnpipe/lib/api.ts');
  };

  const code = (rel: string): string =>
    readFileSync(join(SRC, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('finds the files rather than trusting a list', () => {
    // A sweep that reads nothing passes trivially. This is the control that
    // says the walk reached the product — the ruler, before the measurement.
    const files = browserFiles();
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('vulnpipe/components/PromoteFinding.tsx');
    expect(files).toContain('App.tsx');
  });

  it('leaves `fetch` to the two clients', () => {
    const offenders = browserFiles().filter((f) => /\bfetch\s*\(/.test(code(f)));
    // Named, not counted: the whole cost of the original defect was that
    // nobody knew which file it was in.
    expect(offenders).toEqual([]);
  });

  it('and the clients are where it lives, so the rule is not vacuous', () => {
    // The other direction. If `fetch` had left both clients, the assertion
    // above would pass over a product that reaches a server some third way.
    expect(/\bfetch\s*\(/.test(code('lib/api.ts'))).toBe(true);
    expect(/\bfetch\s*\(/.test(code('vulnpipe/lib/api.ts'))).toBe(true);
  });
});

/**
 * ============================================================================
 * `VITE_API_URL`, AND THE RULE THIS FILE'S OWN PROBE HAD TO LEARN
 *
 * `lib/api.ts` reads the API's origin once, at module load:
 * `const BASE = import.meta.env?.VITE_API_URL ?? ''`. A hardcoded path ignores
 * it, so on a console served from another origin the press goes to the page's
 * host and not the API's — latent in the Docker deployment, which sets neither
 * variable, and the exact defect `pwnedRange`'s header records as already paid
 * for once on the password panel.
 *
 * MEASURED, because the instrument reads zero by default. `vi.stubEnv` does
 * NOT show up on this file's own `import.meta.env` — Vite replaces that
 * expression per module at transform time, so reading it back here prints
 * `undefined` and a test written that way would conclude the stub did nothing.
 * It DOES reach a module imported after the stub. Probed on vitest 4.1.11:
 *
 *   DEFAULT BASE URL = /api/findings/promote
 *   STUBBED BASE URL = https://api.example.test/api/findings/promote
 *   STUBBED PWNED URL = https://api.example.test/api/intel/pwned-range/ABCDE
 *
 * So the module is re-evaluated inside the test rather than at the top of the
 * file, and what is asserted is the URL that was dialled.
 * ============================================================================
 */
describe('both readers go to the API’s origin, not the page’s', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('sends a promoted finding and a password prefix to `VITE_API_URL`', async () => {
    const dialled: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      dialled.push(String(u));
      return new Response('{"ok":true,"status":202,"response":"in the queue"}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));

    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    vi.resetModules();
    const { api } = await import('../../lib/api.ts');

    await api.promoteFinding({ scan_run_id: 'scan-001', target: 'acme/api', finding: FINDING });
    await api.pwnedRange('ABCDE').catch(() => undefined);

    expect(dialled).toEqual([
      'https://api.example.test/api/findings/promote',
      'https://api.example.test/api/intel/pwned-range/ABCDE',
    ]);
  });
});

/** The key that was renamed, and why it could not keep its old name. */
describe('the sentence itself', () => {
  it('names the consequence and carries the reason, and asserts nothing else', () => {
    expect(en.promoteNotSent('Authentication required.'))
      .toBe('Authentication required. Nothing entered the queue.');
    // It must not reintroduce a claim about reachability: that is what made
    // the old `promoteUnreachable` wrong for three of the four states it was
    // reachable from.
    expect(en.promoteNotSent('X.')).not.toMatch(/reach/i);
  });
});
