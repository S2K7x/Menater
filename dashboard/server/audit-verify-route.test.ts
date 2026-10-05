/**
 * `POST /api/audit/verify` — the answers it gives when it cannot look.
 *
 * ============================================================================
 * WHY THESE ARE 200s
 *
 * `lib/api.ts` replaces the body of ANY 502/503/504 with « the console server
 * is not answering. Start it with `npm run serve`. » — a sentence written for
 * the Vite dev proxy, which was the only thing that could answer those codes
 * when the rule was written. So a 503 here would throw away the one sentence
 * naming the fix (*Settings → Database*) and send the operator to restart a
 * server that had just answered them.
 *
 * `/api/simulate` already took that decision and records it in a comment; this
 * file is what stops the next edit from quietly undoing it, because nothing
 * about a 503 LOOKS wrong in the route that writes it. The only way to see the
 * defect is from the client's side of the boundary — which is why the
 * assertion is on the status code AND on the sentence surviving.
 *
 * ============================================================================
 * AND WHY `outcome` IS READ, NOT `ok`
 *
 * There is no `ok` in this envelope on purpose. The four states do not fold
 * into two: `empty` would land on whichever side the boolean chose, and that
 * state — a table nobody has written a decision to — is the one a careless
 * reading reports as an intact chain.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-chain-route-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is resolved once, at load.
const { handleRequest } = await import('./app.ts');
const { getConfig } = await import('./config.ts');
const { messages } = await import('./i18n.ts');

const am = messages('en').api;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Captured { status: number; body: any }

/** Drives the real handler, exactly as a socket delivers the request. */
async function verify(): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  const req: any = {
    method: 'POST',
    url: '/api/audit/verify',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}', 'utf8'); },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) {
      if (chunk) {
        captured.body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      }
    },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

/**
 * A port the OS just handed us and that we then close: nothing is listening,
 * for certain, without claiming anything about the machine running the suite.
 * That is the `persistent-cache.test.ts` lesson — a test must provoke the
 * failure it is testing, never borrow one from the environment.
 */
async function closedPort(): Promise<number> {
  const server: Server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeEach(() => {
  getConfig().auth.enabled = false;
  const db = getConfig().database;
  db.host = '';
  db.database = '';
});

describe('with no database configured', () => {
  it('answers 200 and names the screen that fixes it', async () => {
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('unavailable');
    expect(r.body.verification).toBeNull();
    expect(r.body.response).toBe(am.chainNoDatabase);
    expect(r.body.response).toMatch(/Settings/);
  });

  it('does not report the absence of a chain as an intact one', async () => {
    const r = await verify();
    expect(r.body.outcome).not.toBe('intact');
    expect(r.body.outcome).not.toBe('empty');
  });

  it('sends no `ok`, so no caller can fold four states into two', async () => {
    const r = await verify();
    expect(r.body.ok).toBeUndefined();
  });
});

describe('with a database that is configured and refuses', () => {
  it('answers 200 carrying the cause and the consequence', async () => {
    const db = getConfig().database;
    db.host = '127.0.0.1';
    db.port = await closedPort();
    db.database = 'menater';
    db.user = 'menater';
    db.password = 'x';
    db.ssl = false;

    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('unavailable');
    // Both halves travel: the cause, and what it means for the question that
    // was asked. BE CLEAR ABOUT WHAT THIS DOES NOT PROVE — `pg` only sends an
    // EMPTY message when the host resolves to several addresses, and in this
    // container it does not, so this socket produces a good message either
    // way. The empty-message shape is injected in `audit-chain.test.ts`;
    // mutation said so before this comment did.
    expect(r.body.response).toMatch(/ECONNREFUSED|refused the connection/i);
    expect(r.body.response).toMatch(/Audit chain/);
    expect(r.body.response).toMatch(/Nothing was verified/);
  });

  it('describes the fault once, not under two prefixes', async () => {
    const db = getConfig().database;
    db.host = '127.0.0.1';
    db.port = await closedPort();
    db.database = 'menater';
    db.user = 'menater';
    db.password = 'x';
    db.ssl = false;

    const r = await verify();
    expect(r.body.response.match(/Audit chain/g)).toHaveLength(1);
  });
});
