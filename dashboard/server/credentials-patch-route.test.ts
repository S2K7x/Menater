/**
 * `PUT /api/credentials`: what a refused patch leaves behind.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `credentials.test.ts` drives `saveCredentials` with an INJECTED env object,
 * which is what makes its precedence tests honest — but it means none of them
 * exercises the production call, `saveCredentials(body ?? {})` against the live
 * `process.env`. And the live process is the whole cost of this bug: decision 1
 * of `credentials.ts` is that a key set here takes effect with no restart,
 * because `secretFor()` reads `process.env` at call time.
 *
 * Measured against the real handler before the fix, on a store holding
 * `OLD-KEY`:
 *
 *   PUT /api/credentials {"OPENROUTER_APIKEY":"NEW-KEY","NOT_A_CREDENTIAL":"x"}
 *     → 409 "NOT_A_CREDENTIAL" is not a credential this console manages.
 *     → process.env.OPENROUTER_APIKEY === 'NEW-KEY'
 *     → credentials.json still holds OLD-KEY
 *
 * So the triage model was running on a key the operator had just been told was
 * not saved, until a restart silently reverted it. A partial success showing
 * red — the inverse of the failure showing green this console exists to expose,
 * in the store that decides which model key the pipeline uses and whether a
 * human can be asked for an approval.
 *
 * WHAT MUST NOT CHANGE, claimed here on purpose: a wholly valid patch still
 * applies every entry and answers 200 with the status list. All-or-nothing must
 * not become none-at-all.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-cred-route-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');
const STORE = join(SCRATCH, 'credentials.json');
process.env.MENATER_CREDENTIALS = STORE;

/**
 * The premise is MADE here, not borrowed from the machine.
 *
 * `snapshotRealEnv()` freezes on its first call, and a managed name already in
 * this runner's environment would be reported `locked` — so the patch below
 * would be refused for a reason that has nothing to do with what is tested.
 * Cleared BEFORE the first import, which is what takes that snapshot.
 */
for (const name of ['OPENROUTER_APIKEY', 'SLACK_BOTTOKEN', 'SHODAN_APIKEY']) {
  delete process.env[name];
}

// Imported AFTER the variables above: both paths are resolved at load.
const { handleRequest } = await import('./app.ts');
const { getConfig } = await import('./config.ts');

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  delete process.env.MENATER_CREDENTIALS;
  for (const name of ['OPENROUTER_APIKEY', 'SLACK_BOTTOKEN', 'SHODAN_APIKEY']) {
    delete process.env[name];
  }
});

interface Captured { status: number; body: string }

/** Drives the real handler, exactly as a socket delivers the request. */
async function call(method: string, url: string, payload?: unknown): Promise<Captured> {
  const raw = payload === undefined ? null : JSON.stringify(payload);
  const captured: Captured = { status: 0, body: '' };
  const req: any = {
    method,
    url,
    headers: {},
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

const onDisk = (): Record<string, string> =>
  existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {};

beforeEach(() => {
  getConfig().auth.enabled = false;
  rmSync(STORE, { force: true });
  delete process.env.OPENROUTER_APIKEY;
  delete process.env.SHODAN_APIKEY;
});

describe('a patch the route refuses is not half applied', () => {
  it('answers 409 and leaves the live process on the key that was there', async () => {
    expect((await call('PUT', '/api/credentials', { OPENROUTER_APIKEY: 'OLD-KEY' })).status)
      .toBe(200);

    const r = await call('PUT', '/api/credentials', {
      OPENROUTER_APIKEY: 'NEW-KEY', NOT_A_CREDENTIAL: 'x',
    });

    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).key).toBe('NOT_A_CREDENTIAL');
    // The two halves of the defect: the live process, and the file.
    expect(process.env.OPENROUTER_APIKEY).toBe('OLD-KEY');
    expect(onDisk().OPENROUTER_APIKEY).toBe('OLD-KEY');
  });

  it('does not leak the refused value into the status list it does not send', async () => {
    const r = await call('PUT', '/api/credentials', {
      OPENROUTER_APIKEY: 'sk-never-saved', NOT_A_CREDENTIAL: 'x',
    });

    expect(r.status).toBe(409);
    expect(r.body).not.toContain('sk-never-saved');
    expect(JSON.parse(r.body).credentials).toBeUndefined();
  });

  it('still applies every entry of a patch that is wholly valid', async () => {
    // The boundary. Passes before AND after the fix, on purpose: a refusal
    // that became a refusal of everything would be a different bug.
    const r = await call('PUT', '/api/credentials', {
      OPENROUTER_APIKEY: 'sk-a', SHODAN_APIKEY: 'sh-b',
    });

    expect(r.status).toBe(200);
    expect(process.env.OPENROUTER_APIKEY).toBe('sk-a');
    expect(process.env.SHODAN_APIKEY).toBe('sh-b');
    expect(onDisk()).toMatchObject({ OPENROUTER_APIKEY: 'sk-a', SHODAN_APIKEY: 'sh-b' });
  });
});
