/**
 * The database test button, and the two answers it gave about a port it never
 * dialled.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `POST /api/settings/test/database` does `Number(body.port ?? d.port)` and
 * hands the result straight to `tcpProbe`. `saveConfig`, ten lines away in
 * `config.ts`, already clamps the same value into `[1, 65535]` — so the rule
 * exists, and the one screen that applies it is the one an operator presses
 * when things are ALREADY working. The diagnostic, pressed precisely when they
 * are not, had no rule at all.
 *
 * Measured against the real handler on Node 22.22.2, before this file existed:
 *
 *   {"host":"127.0.0.1","port":0}        -> 200 {"ok":false,"detail":
 *                        "Connection refused: nothing is listening on this port."}
 *   {"host":"127.0.0.1","port":70000}    -> 500 {"error":"Port should be >= 0
 *                        and < 65536. Received type number (70000)."}
 *   {"host":"127.0.0.1","port":-1}       -> 500  (same shape)
 *   {"host":"127.0.0.1","port":5432.5}   -> 500  (same shape)
 *   {"host":"127.0.0.1","port":"nope"}   -> 500  ("Received type number (NaN)")
 *
 * Both answers are wrong in the way this product exists to refuse.
 *
 * **The 200 is a confident diagnosis about a state that did not happen.** The
 * port field is `type="number"`, so clearing it sends `Number('') === 0`; the
 * console then reports "nothing is listening on this port" about a value SAVE
 * would have turned into 5432, and the operator goes and looks at their
 * database. Node's own error for port 0 does not even carry a port —
 * `connect ECONNREFUSED 127.0.0.1`, measured — because the OS never dialled
 * one. Same rule as `clean` requiring a source that ANSWERED, and as
 * "the model answered with no content" on a model that was never asked: a
 * sentence must not be reachable from a state it does not describe.
 *
 * **The 500 is a server-fault code for a sender fault**, carrying V8's own
 * message and logged as `[menater] uncaught error` with a stack. `70000` and
 * `-1` are typeable in that field — it has no `min` or `max` — and
 * `createConnection` throws `RangeError ERR_SOCKET_BAD_PORT` SYNCHRONOUSLY
 * inside `tcpProbe`'s promise executor, so nothing catches it and the route
 * falls to the last net in `app.ts`. That is the trap `normalizeRuleInput`
 * exists to prevent, one route over.
 *
 * The fix is a named 400 at the route and NOT a clamp: silently probing 65535
 * because somebody typed 70000 answers a question nobody asked.
 *
 * WHAT MUST NOT CHANGE, and is claimed here on purpose: a real port is still
 * dialled and still answers 200 — with `ok: true` and the caveat when
 * something listens, and with `ok: false` when nothing does. The network
 * question keeps its 200; only the question about the REQUEST became a 400.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-db-probe-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is resolved once, at load.
const { handleRequest } = await import('./app.ts');
const { getConfig } = await import('./config.ts');
const { messages } = await import('./i18n.ts');

const am = messages('en').api;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Captured { status: number; body: any }

/** Drives the real handler, exactly as a socket delivers the request. */
async function testDatabase(payload: unknown): Promise<Captured> {
  const raw = JSON.stringify(payload);
  const captured: Captured = { status: 0, body: undefined };
  const req: any = {
    method: 'POST',
    url: '/api/settings/test/database',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw, 'utf8'); },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

/**
 * A listener WE own, on a port the OS hands us. The alternative — asserting
 * that some fixed port is closed — is a claim about the machine running the
 * suite, which is the defect `persistent-cache.test.ts` was fixed for.
 */
function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

beforeEach(() => {
  getConfig().auth.enabled = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a port the console would never dial is refused, not diagnosed', () => {
  it('does not report an empty port field as a database that is not listening', async () => {
    // `Number('')` is 0, and that is what the `type="number"` field sends when
    // it is cleared. The old answer was 200 + "nothing is listening on this
    // port" — a verdict about a machine, for a value that named no port.
    const r = await testDatabase({ host: '127.0.0.1', port: 0 });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.detail).toBe(am.portInvalid('0'));
    // The network sentence must not travel with it: it is the half that sends
    // somebody to look at a database that was never contacted.
    expect(r.body.detail).not.toMatch(/listening/i);
    expect(r.body.caveat).toBeUndefined();
  });

  it('answers a sender fault with a 400, never a 500 carrying Node internals', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const port of [70000, 65536, -1, 5432.5]) {
      const r = await testDatabase({ host: '127.0.0.1', port });
      expect(r.status, String(port)).toBe(400);
      expect(r.body.detail, String(port)).toBe(am.portInvalid(String(port)));
      // Node's own sentence, which is what the operator used to read.
      expect(r.body.detail, String(port)).not.toMatch(/Received type/);
      expect(r.body.error, String(port)).toBeUndefined();
    }
    // And nothing reached the last net in `app.ts`, which logs a stack under
    // "uncaught error" — a sender fault filed as a server fault in the log an
    // operator reads.
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a port that is not a number at all, in the same words', async () => {
    for (const port of ['nope', '', true, {}] as unknown[]) {
      const r = await testDatabase({ host: '127.0.0.1', port });
      expect(r.status, JSON.stringify(port)).toBe(400);
      // `Number(true)` is 1 and `Number('')` is 0: coercing a shape the
      // interface cannot produce into a legal port number would dial a port
      // nobody named.
      expect(r.body.detail, JSON.stringify(port)).toMatch(/is not a port number/);
    }
  });

  it('names the rule and the value it received', async () => {
    const r = await testDatabase({ host: '127.0.0.1', port: 70000 });
    expect(r.body.detail).toContain('70000');
    expect(r.body.detail).toContain('65535');
  });

  it('still refuses a missing host first, and by its own sentence', async () => {
    const r = await testDatabase({ host: '   ', port: 0 });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe(am.hostMissing);
  });
});

describe('the network question keeps its 200', () => {
  it('dials a real open port and reports it open, with the caveat', async () => {
    const { server, port } = await listen();
    try {
      const r = await testDatabase({ host: '127.0.0.1', port });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.detail).toContain(String(port));
      // Reaching the port proves neither the credentials nor the tables.
      expect(r.body.caveat).toBe(am.portCaveat);
    } finally {
      await close(server);
    }
  });

  it('answers a closed port at 200 too — a network verdict, not a refusal', async () => {
    // Bound then released, so the number is one the OS handed out rather than
    // one this test hopes is free.
    const { server, port } = await listen();
    await close(server);
    const r = await testDatabase({ host: '127.0.0.1', port });
    expect(r.status).toBe(200);
    expect(typeof r.body.ok).toBe('boolean');
    expect(r.body.detail).toBeTruthy();
  });

  it('falls back to the configured port when the body names none', async () => {
    const { server, port } = await listen();
    getConfig().database.port = port;
    try {
      const r = await testDatabase({ host: '127.0.0.1' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    } finally {
      await close(server);
    }
  });
});
