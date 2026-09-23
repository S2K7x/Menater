/**
 * A request body that could not be PARSED, and what the sender is told.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `readBody` mapped a `JSON.parse` failure to `{}` — the empty body — under a
 * header saying that holds "because EVERY route validates what it received".
 * The claim was never tested, and it is false in both directions: some routes
 * read `{}` as *change nothing* and report success, and the ones that do
 * validate then describe a body nobody could read.
 *
 * Measured against the real handler, before this file existed:
 *
 *   - `PUT /api/ingestion/policy`, `PUT /api/settings`, `PUT /api/credentials`
 *     and `PUT /api/workflows/variables` all answered **200** with the settled
 *     value. A save that never happened, reported as a save — on four
 *     configuration routes, which is the defect the Tracking tab exists to
 *     expose, rebuilt on the screens where an operator changes things.
 *   - the two ingestion endpoints handed `{}` to the pipeline, so an appliance
 *     posting form-encoded data by mistake is told its alert is missing the
 *     identity fields. A diagnosis nobody made, sent to the one caller that
 *     cannot ask a follow-up question.
 *   - `POST /api/auth/login` answered **"Wrong password."** and spent one of
 *     the eight attempts: a client with a broken serialiser locks the operator
 *     out of their own console, blaming a password that was never read.
 *   - `POST /api/mcp` fell through to "Not a JSON-RPC 2.0 request", while the
 *     branch four lines above it — `rpcError(null, PARSE_ERROR, 'Body is not
 *     JSON.')` — had been written for exactly this case and could not be
 *     reached, because `{}` is an object.
 *
 * The neighbouring half of the same door, a body over the 256 kB cap, is
 * `body-limit.test.ts`. The rule both files assert is the same one: a refusal
 * we made says what WE refused, and never a verdict about content nobody read.
 *
 * The second shape here is a body that parses and is not an object — `null`,
 * a number, a string. `POST /api/diagnostics` and `POST /api/simulate` read a
 * field off it and answered **500 carrying V8's own message** ("Cannot read
 * properties of null"): a server-fault code for a sender fault.
 *
 * WHAT MUST NOT CHANGE, and is claimed here on purpose: a request with NO body
 * at all is still the empty object — a dozen routes take one — and a body over
 * the cap keeps its own 413.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-malformed-body-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is resolved once, at load.
const { handleRequest } = await import('./app.ts');
const { getConfig, hashPassword } = await import('./config.ts');
const { MalformedBody, readBody, readBodyOrNull } = await import('./respond.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Captured { status: number; body: string }

/** Drives the real handler with a raw body, exactly as a socket delivers it. */
async function call(
  method: string,
  url: string,
  raw: string | null,
  headers: Record<string, string> = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, body: '' };
  const req: any = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (raw !== null) yield Buffer.from(raw, 'utf8');
    },
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

/** A body cut off mid-transfer: the commonest way valid JSON stops being JSON. */
const TRUNCATED = '{"delivery":"pull","fastLane":["critical"';
/** An appliance configured to post a form where this API reads JSON. */
const FORM_ENCODED = 'alert_id=ALT-9001&severity=high&rule_name=Failed+SSH+logins';

beforeEach(() => {
  const c = getConfig();
  c.auth.enabled = false;
  c.webhook.mode = 'on';
  c.webhook.secret = 'the-shared-secret';
  c.ingestion.delivery = 'hybrid';
});

describe('a body that could not be parsed is not an empty body', () => {
  it('does not report a save that never happened as a save', async () => {
    const before = JSON.parse((await call('GET', '/api/ingestion/policy', null)).body).policy;
    const r = await call('PUT', '/api/ingestion/policy', TRUNCATED);
    expect(r.status).toBe(400);
    // Not beside the refusal either: a caller handed `policy` back reads the
    // write as landed, which is the whole defect.
    expect(JSON.parse(r.body).policy).toBeUndefined();
    const after = JSON.parse((await call('GET', '/api/ingestion/policy', null)).body).policy;
    expect(after).toEqual(before);
  });

  it('refuses the other three configuration saves the same way', async () => {
    for (const [method, path, raw] of [
      ['PUT', '/api/settings', '{"console":{"refreshSeconds":30'],
      ['PUT', '/api/credentials', '{"OPENROUTER_APIKEY":"sk-'],
      ['PUT', '/api/workflows/variables', '{"pipeline.shadowMode":fals'],
    ] as const) {
      const r = await call(method, path, raw);
      expect(r.status, path).toBe(400);
      // The settled value must not travel with the refusal.
      const body = JSON.parse(r.body);
      expect(body.settings, path).toBeUndefined();
      expect(body.credentials, path).toBeUndefined();
      expect(body.variables, path).toBeUndefined();
    }
    // And nothing was applied: the refresh rate is what it was.
    const settings = JSON.parse((await call('GET', '/api/settings', null)).body).settings;
    expect(settings.console.refreshSeconds).toBe(getConfig().console.refreshSeconds);
  });

  it('tells an appliance its body was not JSON, not that its alert is incomplete', async () => {
    for (const path of ['/api/ingest/generic', '/api/webhook/soc/alert']) {
      const r = await call('POST', path, FORM_ENCODED, { 'x-soc-token': 'the-shared-secret' });
      expect(r.status, path).toBe(400);
      // A verdict about the alert's shape is a diagnosis nobody made: nothing
      // read those fields, because nothing could.
      expect(r.body, path).not.toContain('alert_id');
      expect(r.body, path).not.toContain('invalid_schema');
      // And the pipeline was never started for it.
      expect(r.body, path).not.toContain('engine_failed');
    }
  });

  it('does not spend one of the eight login attempts on a body it never read', async () => {
    const c = getConfig();
    const { salt, hash } = hashPassword('the-console-password');
    c.auth.salt = salt;
    c.auth.hash = hash;

    for (let i = 0; i < 8; i += 1) {
      const r = await call('POST', '/api/auth/login', '{"password":"the-console-pas');
      expect(r.status, `attempt ${i + 1}`).toBe(400);
      // Never a verdict on a password: none was read.
      expect(r.body, `attempt ${i + 1}`).not.toContain('Wrong password');
    }

    // Eight unread bodies used to be eight wrong guesses, and the operator was
    // then locked out for five minutes with the right password in hand.
    const ok = await call('POST', '/api/auth/login', '{"password":"the-console-password"}');
    expect(ok.status).toBe(200);
  });

  it('says it was the body, in English, and names no field', async () => {
    const { error } = JSON.parse((await call('PUT', '/api/ingestion/policy', TRUNCATED)).body);
    expect(error).toMatch(/JSON/);
    // English only, the rule the catalogue exists to keep.
    expect(error).toMatch(/^[\x20-\x7E]+$/);
    // Not V8's sentence, which names a position in a buffer the sender cannot see.
    expect(error).not.toContain('Unexpected');
    expect(error).not.toContain('position');
  });
});

describe('a body that parses and is not an object', () => {
  it('is a sender fault, not a 500 carrying V8 s message', async () => {
    for (const [method, path, raw] of [
      ['POST', '/api/diagnostics', 'null'],
      ['POST', '/api/simulate', 'null'],
      // A number got through by accident: `(5).scenario` is undefined, so the
      // route ran on defaults and answered 200 about a body it never read.
      ['POST', '/api/diagnostics', '5'],
      ['PUT', '/api/settings', '"a string"'],
    ] as const) {
      const r = await call(method, path, raw);
      expect(r.status, `${path} ${raw}`).toBe(400);
      expect(r.body, `${path} ${raw}`).not.toContain('Cannot read properties');
    }
  });

  it('says the body must be a JSON object, rather than calling valid JSON invalid', async () => {
    const { error } = JSON.parse((await call('POST', '/api/diagnostics', 'null')).body);
    // `null` IS valid JSON. A sentence must not be reachable from a state it
    // does not describe.
    expect(error).not.toMatch(/not valid JSON/i);
    expect(error).toMatch(/object/i);
  });
});

describe('what a refusal for the body must not swallow', () => {
  it('still reads a request with no body at all as an empty one', async () => {
    // A dozen routes take no body. Refusing those would be the plausible
    // over-fix: everything is refused, and every test above passes.
    const r = await call('POST', '/api/diagnostics', null);
    expect(r.status).toBe(200);
  });

  it('still applies a valid save', async () => {
    const r = await call('PUT', '/api/ingestion/policy', '{"delivery":"pull"}');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).policy.delivery).toBe('pull');
  });

  it('leaves the size refusal its own answer', async () => {
    // 256 kB of spaces: over the cap, and it would not have parsed either.
    // The cap is checked first, so the sender is told about the size.
    const oversized = ' '.repeat(256 * 1024 + 1);
    const r = await call('PUT', '/api/ingestion/policy', oversized);
    expect(r.status).toBe(413);
    expect(r.body).toContain('256 kB');
  });
});

describe('the MCP endpoint answers inside its own protocol', () => {
  beforeEach(() => {
    const c = getConfig();
    c.assistant.mcpEnabled = true;
    c.assistant.mcpToken = 'test-mcp-token-0123456789';
  });

  const AUTH = { authorization: 'Bearer test-mcp-token-0123456789', host: 'localhost:4400' };

  it('answers a parse error, not a verdict on a request nobody read', async () => {
    const r = await call('POST', '/api/mcp', '{"jsonrpc":"2.0","method":"tools/lis', AUTH);
    expect(r.status).toBe(400);
    const body = JSON.parse(r.body);
    // A JSON-RPC client must get a JSON-RPC envelope, never a bare `{error}`.
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32700);
    // What it used to say: the body parsed to `{}`, so the endpoint reported a
    // well-formed request that was not a JSON-RPC one.
    expect(body.error.message).not.toContain('Not a JSON-RPC 2.0 request');
  });

  it('calls valid JSON that is not a request object an invalid REQUEST', async () => {
    const r = await call('POST', '/api/mcp', 'null', AUTH);
    expect(r.status).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.error.code).toBe(-32600);
  });

  it('still accepts a batch, which is a top-level array', async () => {
    const batch = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    const r = await call('POST', '/api/mcp', batch, AUTH);
    expect(r.status).toBe(200);
    expect(Array.isArray(JSON.parse(r.body))).toBe(true);
  });
});

describe('readBody and readBodyOrNull', () => {
  /** A request whose stream fails, or delivers `raw`. */
  function request(raw: string | null, fail?: Error): any {
    return {
      async *[Symbol.asyncIterator]() {
        if (fail) throw fail;
        if (raw !== null) yield Buffer.from(raw, 'utf8');
      },
    };
  }

  it('throws rather than inventing an empty body', async () => {
    await expect(readBody(request('{oops'))).rejects.toBeInstanceOf(MalformedBody);
    await expect(readBody(request('null'))).rejects.toBeInstanceOf(MalformedBody);
  });

  it('carries WHICH of the two it was, so the answer can differ', async () => {
    const notJson = await readBody(request('{oops')).catch((e) => e);
    const notObject = await readBody(request('42')).catch((e) => e);
    expect(notJson.reason).toBe('not_json');
    expect(notObject.reason).toBe('not_an_object');
  });

  it('lets that refusal travel on through readBodyOrNull', async () => {
    // Same rule as `BodyTooLarge`: `null` is for a body that could not be
    // READ, and a refusal WE made reaches the one place that can word it.
    await expect(readBodyOrNull(request('{oops'))).rejects.toBeInstanceOf(MalformedBody);
  });

  it('still answers null for a body that could not be read', async () => {
    await expect(readBodyOrNull(request(null, new Error('aborted')))).resolves.toBeNull();
  });

  it('still reads an absent body as an empty object, and an array as itself', async () => {
    await expect(readBody(request(null))).resolves.toEqual({});
    await expect(readBody(request('[1,2]'))).resolves.toEqual([1, 2]);
  });
});
