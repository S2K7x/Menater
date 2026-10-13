/**
 * The entry-point probe dials THIS console, and no header can move it.
 *
 * ============================================================================
 * WHAT WAS WRONG, AND WHY IT READ AS A FEATURE
 *
 * `Health → Test connectivity` ends by probing the ingestion endpoint for
 * real: it POSTs a deliberately invalid alert and reads the 400 as the pass,
 * which proves the route, the shared secret, the normalizer and the validator
 * all work. To do that it has to send the secret.
 *
 * `routes/ops.ts` built the address it sent that secret to out of the
 * request's own `Host` header, with `X-Forwarded-Proto` choosing the scheme,
 * under a comment that is true of a different thing: the ingestion SNIPPETS
 * name the address the operator reached the console on, because a snippet is
 * text somebody copies. Here the same reflected header was not displayed — it
 * was dialled, with a credential attached.
 *
 * Measured over two real sockets before the fix: one `POST /api/diagnostics`
 * carrying `Host: 127.0.0.1:<decoy>` and an empty body — the probe is on
 * unless the body says otherwise — delivered `x-soc-token: <the shared
 * secret>` to the decoy, and the console answered 200 with a diagnostic line
 * that looked like any other failure. That secret is the only authentication
 * on `/api/ingest/*` and `/api/webhook/soc/alert`, which is the surface the
 * tunnel profile puts on the Internet; and `/api/diagnostics` needs no session
 * on an install with no console password, which is the default.
 *
 * ============================================================================
 * WHY THESE TESTS LOOK THE WAY THEY DO
 *
 * REAL SOCKETS, BOTH SIDES. A fetch double would be asked whether the code
 * called it with the address we expected — which is the same assumption the
 * defect was made of. A listener either receives the secret or does not.
 *
 * AND THE CLAIM IS POSITIVE, NOT AN ABSENCE. "The attacker's address received
 * nothing" is also satisfied by a probe that never ran — so this file starts
 * TWO listeners, one at the port the console believes it answers on and one at
 * the address a caller would name, and asserts which of the two got the
 * secret. Nothing here depends on a port being closed, so there is no premise
 * about the machine running the suite that can quietly stop holding: that is
 * the defect `persistent-cache.test.ts` paid for, avoided rather than
 * re-provoked.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-diag-address-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

const SECRET = 'a-shared-ingestion-secret';

/**
 * A listener that answers 400 — which is the probe's PASS.
 *
 * Two of these are started: one at the port the console believes it answers
 * on, one at the address an attacker would name. Nothing in this file depends
 * on a port being closed, so there is no premise about the machine running the
 * suite that could stop holding; which of the two received the secret is the
 * whole measurement.
 */
interface Listener {
  port: number;
  server: Server;
  requests: Array<{ url: string; token: unknown; body: string }>;
}

async function entryPointAnswering(): Promise<Listener> {
  const requests: Listener['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: String(req.url), token: req.headers['x-soc-token'], body });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"status":"rejected","reason":"schema_validation_failed"}');
    });
  });
  // No host argument, exactly as `api.ts` does it: Node then binds every
  // interface on both families, so `localhost` reaches it whichever way that
  // name resolves on the machine running this.
  await new Promise<void>((r) => server.listen(0, () => r()));
  return { port: (server.address() as { port: number }).port, server, requests };
}

/**
 * Where the console believes it answers — set BEFORE `env.ts` reads it, since
 * `PORT` is resolved at module load.
 */
const self: Listener = await entryPointAnswering();
process.env.MENATER_API_PORT = String(self.port);

const { handleRequest } = await import('./app.ts');
const { saveConfig } = await import('./config.ts');

/** The address a caller would name instead. */
let elsewhere: Listener;

beforeAll(async () => {
  elsewhere = await entryPointAnswering();
  // The normal production state for this probe: the door is open and it has a
  // secret. With either untrue the probe does not call at all, and every
  // assertion below would be vacuously satisfied.
  saveConfig({
    // A database that cannot answer, so no case depends on the machine.
    database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater', password: 'x' },
    webhook: { mode: 'on', secret: SECRET },
  });
});

afterAll(() => {
  self.server.close();
  elsewhere.server.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** `POST /api/diagnostics`, with the headers of the caller's choosing. */
async function diagnose(headers: Record<string, string>) {
  const captured = { status: 0, body: '' };
  const req: any = {
    method: 'POST',
    url: '/api/diagnostics',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', ...headers },
    socket: { remoteAddress: '203.0.113.9' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}', 'utf8'); },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk: any) { if (chunk) captured.body = chunk.toString(); },
    setHeader() {},
  };
  await handleRequest(req, res);
  return { status: captured.status, diag: captured.body ? JSON.parse(captured.body) : null };
}

const webhookCheck = (diag: any) =>
  (diag.checks as Array<{ id: string; status: string; detail: string }>).find((c) => c.id === 'webhook')!;

describe('the entry-point probe\'s address', () => {
  it('sends the secret to this process, and not to the address in the Host header', async () => {
    const mine = self.requests.length;
    const theirs = elsewhere.requests.length;
    const { status } = await diagnose({ host: `127.0.0.1:${elsewhere.port}` });

    // The route answered — this is not a refusal doing the work for us. There
    // is no session cookie here either, which is the state of an install with
    // no console password: that is what made the leak unauthenticated.
    expect(status).toBe(200);

    expect(
      elsewhere.requests.length - theirs,
      'the console dialled the address in the Host header: a header chose where a credential went',
    ).toBe(0);
    expect(elsewhere.requests.some((r) => r.token === SECRET)).toBe(false);

    // THE POSITIVE HALF. The probe ran, it reached the port this process
    // believes it serves, and the secret it carries went there — so the check
    // still proves what it was written to prove.
    const sent = self.requests.slice(mine);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/ingest/generic');
    expect(sent[0].token).toBe(SECRET);
    expect(JSON.parse(sent[0].body)).toEqual({ diagnostic_probe: true });
  });

  it('ignores X-Forwarded-Proto too — the scheme was the caller\'s as well', async () => {
    // Before the fix this one dialled `https://` at a plain-HTTP listener, and
    // the operator read `ERR_SSL_PACKET_LENGTH_TOO_LONG`: a TLS diagnosis
    // about a host nobody had configured. Measured, before writing the fix.
    const mine = self.requests.length;
    const theirs = elsewhere.requests.length;
    const { diag } = await diagnose({
      host: `127.0.0.1:${elsewhere.port}`,
      'x-forwarded-proto': 'https',
    });

    expect(elsewhere.requests.length - theirs).toBe(0);
    expect(self.requests.length - mine).toBe(1);
    const c = webhookCheck(diag);
    // A 400 from the endpoint is the probe's pass, and no TLS anywhere.
    expect(c.status).toBe('ok');
    expect(c.detail).not.toMatch(/SSL|TLS/i);
  });

  /**
   * The control, and it passes BEFORE the fix as well as after: the probe is
   * still a probe. `undefined` was always the no-Host answer, so this claims
   * the half the fix must not break rather than the half it changes.
   */
  it('still probes when no header is sent at all', async () => {
    const mine = self.requests.length;
    const { status, diag } = await diagnose({});

    expect(status).toBe(200);
    expect(self.requests.length - mine).toBe(1);
    expect(webhookCheck(diag).status).toBe('ok');
  });

  /** And it is still skippable, which is the one thing a caller may decide. */
  it('is skipped when the body asks for that, and then dials nothing at all', async () => {
    const mine = self.requests.length;
    const theirs = elsewhere.requests.length;
    const captured = { body: '' };
    const req: any = {
      method: 'POST', url: '/api/diagnostics',
      headers: {
        'content-type': 'application/json', 'accept-encoding': 'identity',
        host: `127.0.0.1:${elsewhere.port}`,
      },
      socket: { remoteAddress: '203.0.113.9' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"probeWebhook":false}', 'utf8'); },
    };
    const res: any = {
      req, headersSent: false,
      writeHead() { res.headersSent = true; },
      end(c: any) { if (c) captured.body = c.toString(); },
      setHeader() {},
    };
    await handleRequest(req, res);

    expect(webhookCheck(JSON.parse(captured.body)).status).toBe('skip');
    expect(self.requests.length - mine).toBe(0);
    expect(elsewhere.requests.length - theirs).toBe(0);
  });
});
