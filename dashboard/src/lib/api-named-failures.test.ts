/**
 * A failure the operator can FIX must reach the operator.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `lib/api.ts` replaces the body of any 502/503/504 with one sentence:
 * "The console server is not answering. Start it with `npm run serve`."
 *
 * That rule was written for the Vite dev proxy, which was the only thing that
 * could answer those codes at the time. Measured on this repository's Vite
 * (8.2.1), with the proxy pointed at a dead upstream:
 *
 *     { "status": 502, "contentType": "text/plain", "body": "" }
 *
 * An empty body: there is genuinely nothing else to say, and the sentence is
 * the right one.
 *
 * The console itself answers 503 too, and never for that reason. It answers it
 * when no database is configured (so the rule store cannot be read and the
 * engine is not mounted), and when a database that IS configured refuses the
 * connection. Those are states an operator fixes in Settings, and the server
 * writes a sentence naming each of them — including, for a refused connection,
 * the one `describePgError` exists to recover, since `pg` reports
 * `ECONNREFUSED` with an EMPTY message. All of them left the client as
 * "start the console server": advice to restart a server that had just
 * answered, on the screens whose whole job is to say what is wrong.
 *
 * The rule was already written in `lib/api.ts`, forty lines further down.
 * `pwnedRange` cannot use `call()` — its route answers plain text — so it
 * reads its own errors, and it says: "A JSON body here carries the named
 * reason, and throwing it away for a generic sentence would lose the only
 * useful half of the answer." Every route that DOES go through `call()` lost
 * it.
 *
 * So these tests put the REAL request handler behind the REAL client and
 * assert the sentence that reaches the screen — not a fixture mapping a status
 * to a message.
 *
 * ============================================================================
 * THE SECOND HALF, AND THE SAME TRAP
 *
 * The 5xx fix left the sentence for every OTHER refusal read from `body.error`
 * alone — and this server names a reason under three different keys. Measured
 * by driving the real handler through the real client, before the fix:
 *
 *   POST /api/rules        400 {"problems":[{"field":"name","detail":"A rule
 *                              needs a name: …"}, …5 of them]}
 *                          → "The console server answered 400 with no explanation."
 *   PUT  /api/rules/:id    400 {"problems":[…]}                → the same
 *   POST /api/settings/test/database
 *                          400 {"ok":false,"detail":"Host missing."}
 *                                                              → the same
 *   POST /api/approvals/:token/resume
 *                          500 {"ok":false,"detail":"The decision could not be
 *                              recorded: … Without it the run will time out and
 *                              the alert will be escalated."}
 *                          → "The console server answered 500 with no explanation."
 *
 * The last one is the worst place in the console to lose a sentence: somebody
 * has just answered the question the pipeline stopped to ask, and what was
 * thrown away names both the cause AND what happens next.
 *
 * And `RulesPage` has read `err.problems` since it was written, to render one
 * line per field — `call()` threw a plain `ApiError`, so that array never
 * arrived and the branch under its comment had never once run. Dead code that
 * looks load-bearing, on the screen where an operator writes the rules that
 * decide what stops reaching a human.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A REAL path, unlike the suite's default: these tests change the database
// coordinates through `saveConfig`, which writes the file.
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-named-failures-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('../../server/app.ts');
const { saveConfig } = await import('../../server/config.ts');
const { messages } = await import('../../server/i18n.ts');
const { api, ApiError } = await import('./api.ts');
const { consoleDictionary } = await import('../i18n/console.ts');
/** `ApiError` is a value binding here (dynamic import), so annotating needs this. */
type Refusal = InstanceType<typeof ApiError>;
type Problem = { field: string; detail: string };

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** What the client says when nobody named a reason. */
const GENERIC = consoleDictionary('en').errors.apiNotResponding;
/** What the server writes. `messages(locale).api` is what a route is handed. */
const am = messages('en').api;

interface Captured {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Drives the real handler, the way `body-limit.test.ts` does. */
async function serve(method: string, url: string, payload: string | null): Promise<Captured> {
  const captured: Captured = { status: 0, body: '', headers: {} };
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

/**
 * Puts the real server behind the real client.
 *
 * `fetch` is the only seam between them, so replacing it with the handler is
 * what makes these assertions end to end rather than a fixture agreeing with
 * itself.
 */
function consoleOnTheOtherEnd(): void {
  vi.stubGlobal('fetch', async (url: unknown, init: any = {}) => {
    const c = await serve(String(init.method ?? 'GET'), String(url), init.body ?? null);
    return new Response(c.body, {
      status: c.status,
      headers: { 'Content-Type': c.headers['Content-Type'] ?? 'application/json' },
    });
  });
}

/** The state of an install where nobody has filled the database in. */
function noDatabase(): void {
  saveConfig({ database: { host: '', database: '' } });
}

/**
 * A database that is configured and refuses.
 *
 * Port 1 is privileged and nothing can be listening on it, so the connection
 * is refused immediately — no sleeping test, and no dependence on whether the
 * machine running the suite happens to have a Postgres on 5432. That mattered
 * here: with the default coordinates these assertions passed or failed
 * depending on whose laptop they ran on, which is the flakiness this suite
 * already removed once.
 */
function databaseRefuses(): void {
  saveConfig({ database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater' } });
}

beforeEach(() => consoleOnTheOtherEnd());
afterEach(() => vi.unstubAllGlobals());

describe('no database configured', () => {
  beforeEach(() => noDatabase());

  it('says the rules cannot be read, and why', async () => {
    await expect(api.rules()).rejects.toThrow(ApiError);
    await expect(api.rules()).rejects.toThrow(am.rulesNoDatabase);
  });

  it('says it on the dry run too — the one an operator presses to ask "why"', async () => {
    await expect(api.testRules({ alert_id: 'a-1' })).rejects.toThrow(am.rulesNoDatabase);
  });

  it('says the engine is not started when an approval is answered', async () => {
    // The worst place to lose a reason: somebody is answering the question the
    // pipeline stopped to ask.
    await expect(
      api.resume('tok-1', { decision: 'approve', approver: 'alice', reason: '' }),
    ).rejects.toThrow(am.engineUnavailable);
  });

  it('never tells the operator to start a server that has just answered', async () => {
    await expect(api.rules()).rejects.not.toThrow(GENERIC);
  });

  it('answers the injection button in its own envelope, not as a dead API', async () => {
    // `POST /api/simulate` carries `{ ok, response }`, and the Health tab reads
    // both: `ok: false` prints the sentence where the answer goes. The route's
    // own neighbouring catch — an engine that throws — already answered 200 in
    // that shape, so the missing engine was the odd one out of its own file.
    const r = await api.simulate({ scenario: 'brute_force' });
    expect(r.ok).toBe(false);
    expect(r.response).toBe(am.simulateNoEngine);
    // The sentence is only worth keeping because it says where to go.
    expect(r.response).toContain('Settings');
  });
});

describe('a database that refuses the connection', () => {
  beforeEach(() => databaseRefuses());

  it('names the refusal, which pg itself reports with an empty message', async () => {
    // `RuleDbError` → the catch-all in `app.ts` → 503 carrying the sentence
    // `describePgError` recovered. It is the whole point of that fix, and the
    // client was throwing it away at the last inch.
    await expect(api.rules()).rejects.toThrow(/ECONNREFUSED/);
    await expect(api.rules()).rejects.not.toThrow(GENERIC);
  });
});

describe('the sentence the rule was written for is untouched', () => {
  /**
   * THE CONTROL. A dev proxy with nothing behind it answers 502 with an empty
   * `text/plain` body — measured, see the header. Nothing named a reason, so
   * the generic sentence is the right one and must survive this change.
   */
  it('keeps the generic answer for the empty 502 of a dead upstream', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('', { status: 502, headers: { 'Content-Type': 'text/plain' } }));
    await expect(api.rules()).rejects.toThrow(GENERIC);
  });

  it('keeps it for a 503 whose body is not JSON at all', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<html><head><title>503 Service Unavailable</title></head></html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      }));
    await expect(api.rules()).rejects.toThrow(GENERIC);
  });

  it('keeps it for a 503 whose JSON names no reason', async () => {
    // An empty `error` is not a reason. Surfacing it would put a blank banner
    // on screen, which says less than the generic sentence does.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: '   ' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    await expect(api.rules()).rejects.toThrow(GENERIC);
  });

  it('keeps it for a 504 with no body, the shape a gateway times out with', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 504 }));
    await expect(api.rules()).rejects.toThrow(GENERIC);
  });
});

/**
 * The 4xx half. Same rule, other keys.
 *
 * A configured-but-refusing database is used on purpose: `getRuleStore()`
 * answers whether a database is CONFIGURED, and the rules routes validate the
 * body BEFORE they dial it — so these 400s are reached without a socket ever
 * being opened, and without the no-database 503 short-circuiting them first.
 */
describe('a refusal the server explained under a key that was not `error`', () => {
  beforeEach(() => databaseRefuses());

  it('gives the rules editor the sentences it wrote, not "no explanation"', async () => {
    const bad = api.createRule({ name: '', conditions: 'nope' as never });
    await expect(bad).rejects.toThrow(/A rule needs a name/);
    await expect(api.createRule({ name: '', conditions: 'nope' as never }))
      .rejects.toThrow(/Conditions must be a list/);
    await expect(api.createRule({ name: '', conditions: 'nope' as never }))
      .rejects.not.toThrow(consoleDictionary('en').errors.noExplanation(400));
  });

  it('hands the per-field list to the banner that has always tried to render it', async () => {
    // `RulesPage` does `(e as { problems?: RuleProblem[] })?.problems` and
    // renders one line per entry. It received `undefined` for its whole life.
    const err = await api.createRule({ name: '', conditions: 'nope' as never })
      .then(() => null, (e: unknown) => e as Refusal);
    expect(err).toBeInstanceOf(ApiError);
    expect(Array.isArray(err!.problems)).toBe(true);
    // One per field the server named, each carrying the sentence and the field.
    expect(err!.problems!.length).toBeGreaterThan(1);
    expect(err!.problems!.map((p: Problem) => p.field)).toContain('name');
    expect(err!.problems!.every((p: Problem) => typeof p.detail === 'string' && p.detail !== '')).toBe(true);
  });

  it('does it on the UPDATE route too, which refuses through the same validator', async () => {
    // Two routes, so that a fix on the one somebody remembers is not mistaken
    // for the rule. This is the defect the ingestion endpoints already paid for.
    await expect(
      api.updateRule('11111111-1111-1111-1111-111111111111', { name: '', priority: 'high' as never }),
    ).rejects.toThrow(/Priority must be a number/);
  });

  it('tells the approver why their decision did not stick, and what follows', async () => {
    // The sentence lost here carries the CONSEQUENCE: the run will time out and
    // the alert will be escalated. "No explanation (500)" says neither half.
    const decision = api.resume('tok-x', { decision: 'approve', approver: 'alice', reason: '' });
    await expect(decision).rejects.toThrow(/escalated/);
    await expect(
      api.resume('tok-x', { decision: 'approve', approver: 'alice', reason: '' }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('names what the database probe is missing instead of the status code', async () => {
    await expect(api.testDatabase({ host: '' })).rejects.toThrow(am.hostMissing);
  });
});

describe('what must NOT start being surfaced', () => {
  beforeEach(() => databaseRefuses());

  it('keeps "no explanation" when the body names nothing at all', async () => {
    // The generic sentence is right here: there is genuinely nothing to say,
    // and a blank banner says less than it does.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }));
    await expect(api.rules()).rejects.toThrow(consoleDictionary('en').errors.noExplanation(400));
  });

  it('keeps it when every key present is blank', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: '  ', detail: '', problems: [{ field: 'x', detail: ' ' }] }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }));
    await expect(api.rules()).rejects.toThrow(consoleDictionary('en').errors.noExplanation(400));
  });

  it('never puts [object Object] on screen for an `error` that is not a string', async () => {
    // `POST /api/mcp` answers a JSON-RPC envelope whose `error` is an object.
    // No browser call reaches it today; the cast that would have printed
    // "[object Object]" was one route away from being reachable.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch.' } }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }));
    await expect(api.rules()).rejects.toThrow(consoleDictionary('en').errors.noExplanation(400));
    await expect(api.rules()).rejects.not.toThrow(/object Object/);
  });

  it('leaves a refusal that already carried `error` exactly as it was', async () => {
    // The inventory 400 sends `error` AND `problems`. `error` is the sentence
    // the server composed for a human; the list must not displace it.
    const refused = await api.saveSettings({ inventory: [] })
      .then(() => null, (e: unknown) => e as Refusal);
    expect(refused!.message).toBe(
      am.inventoryRefused(['inventory: Send the list as { "entries": [ … ] }.']),
    );
  });
});
