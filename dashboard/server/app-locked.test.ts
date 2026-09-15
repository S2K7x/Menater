/**
 * The console WITH its access lock on — the state nothing else tests.
 *
 * ============================================================================
 * WHAT THIS PROTECTS
 *
 * `app.test.ts` drives the request surface with the lock OFF, and
 * `auth.test.ts` asks `requiresAuth` about `/api/` paths only. Between the two,
 * one question was never put: with a password set, what does a BROWSER get?
 *
 * It got `401 {"error":"Authentication required."}` — for `/`, for
 * `index.html`, for the JavaScript bundle. The login screen is a React
 * component inside that bundle (`LoginScreen` in `src/App.tsx`), so refusing
 * the shell refuses the only way anyone has of logging in: enabling the lock
 * left a console nobody could open, recoverable only by editing `config.json`
 * on disk. Invisible in development, where Vite serves the interface and only
 * the `/api` calls cross this handler — the same shape as the `/api/*`-served-
 * the-SPA defect in CLAUDE.md, which was likewise "only broken in Docker".
 *
 * So these tests pin BOTH halves of the rule, and the second is the one that
 * keeps the first honest:
 *   - the interface's own files are served without a session;
 *   - everything under `/api/` still is not.
 * ============================================================================
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

// A built interface, and a file NEXT TO its root: serving the shell without a
// session must not turn the handler into a file server for the whole disk.
const ROOT = mkdtempSync(join(tmpdir(), 'menater-locked-ui-'));
mkdirSync(join(ROOT, 'assets'));
writeFileSync(join(ROOT, 'index.html'), '<!doctype html><title>MENATER</title>');
writeFileSync(join(ROOT, 'assets', 'index-a1b2c3.js'), 'console.log("console bundle")');
const OUTSIDE = join(ROOT, '..', `menater-locked-secret-${process.pid}.txt`);
writeFileSync(OUTSIDE, 'A PASSWORD');

// Both read once, at module load, so they are set before the import below.
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-locked-cfg-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');
process.env.MENATER_UI_ROOT = ROOT;
// A lock that is ON, with a password set. The hash is never verified here:
// every request below arrives with no cookie at all.
writeFileSync(
  process.env.MENATER_CONFIG,
  JSON.stringify({ auth: { enabled: true, salt: 'not-a-real-salt', hash: 'not-a-real-hash' } }),
);

const { handleRequest } = await import('./app.ts');

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUTSIDE, { force: true });
});

interface Captured {
  status: number;
  headers: Record<string, any>;
  body: string;
}

/**
 * A real `Writable`, not a stub with an `end()`.
 *
 * `serveStatic` answers a GET by piping a read stream into the response, so a
 * fake that only records `end()` would report an empty body for the very files
 * these tests exist to check are delivered.
 */
async function call(method: string, url: string): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  const req: any = {
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  };

  let finished: () => void;
  const done = new Promise<void>((r) => { finished = r; });

  const res: any = new Writable({
    write(chunk, _enc, cb) { captured.body += chunk.toString('utf8'); cb(); },
  });
  res.req = req;
  res.headersSent = false;
  res.writeHead = (status: number, headers: Record<string, any>) => {
    captured.status = status;
    captured.headers = headers ?? {};
    res.headersSent = true;
    return res;
  };
  res.setHeader = () => {};
  res.on('finish', () => finished());

  await handleRequest(req, res);
  // A piped GET ends the response asynchronously; a JSON answer has already
  // called `end()` by the time `handleRequest` resolves.
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, 500))]);
  return captured;
}

describe('the interface is reachable so that someone CAN log in', () => {
  it('serves the shell at `/` instead of refusing it', async () => {
    // The 401 that used to come back here is the whole defect: the login form
    // lives in the bundle this request is asking for.
    const r = await call('GET', '/');
    expect(r.status).toBe(200);
    expect(String(r.headers['Content-Type'])).toMatch(/text\/html/);
    expect(r.body).toContain('MENATER');
  });

  it('serves the JavaScript bundle the login screen lives in', async () => {
    // Serving `index.html` and refusing its bundle is the same lockout one
    // request later, and it looks like a broken page rather than a locked one.
    const r = await call('GET', '/assets/index-a1b2c3.js');
    expect(r.status).toBe(200);
    expect(r.body).toContain('console bundle');
  });

  it('serves a navigation route, which is a screen and not a file', async () => {
    const r = await call('GET', '/settings');
    expect(r.status).toBe(200);
    expect(r.body).toContain('MENATER');
  });

  it('still answers the three routes that make logging in possible', async () => {
    const r = await call('GET', '/api/auth/status');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ enabled: true, authenticated: false });
  });
});

describe('and NOTHING under /api/ comes with it', () => {
  // The counterpart, and the one that stops this fix from becoming a hole:
  // every one of these is data, and none of them may answer without a session.
  it.each([
    ['GET', '/api/snapshot'],
    ['GET', '/api/settings'],
    ['GET', '/api/workflows'],
    ['GET', '/api/rules'],
    ['GET', '/api/credentials'],
    ['GET', '/api/cases/abc'],
    ['GET', '/api/ingest/sources'],
    ['GET', '/api/ingestion/policy'],
    ['POST', '/api/simulate'],
    ['POST', '/api/replay'],
    ['POST', '/api/settings'],
    ['POST', '/api/rules'],
    ['POST', '/api/findings/promote'],
    ['POST', '/api/assistant/chat'],
    ['GET', '/api/vulnpipe/scans'],
    ['GET', '/api/definitely-not-a-route'],
  ])('refuses %s %s without a session', async (method, path) => {
    const r = await call(method, path);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toMatchObject({ auth_required: true });
  });

  it('refuses `/api` itself, which is not a screen', async () => {
    const r = await call('GET', '/api');
    expect(r.status).toBe(401);
  });
});

describe('serving the shell did not open the disk', () => {
  it('does not deliver a file next to the root, encoded or not', async () => {
    // The new exposure this change creates, pinned where the change is: these
    // requests now reach `serveStatic` with no session. `static.test.ts` proves
    // the containment; this proves the lock did not stop being what stood in
    // front of it by accident.
    const name = OUTSIDE.split('/').pop()!;
    for (const attempt of [`/../${name}`, `/%2e%2e%2f${name}`, `/assets/../../${name}`]) {
      const r = await call('GET', attempt);
      expect(r.body, attempt).not.toContain('A PASSWORD');
      expect(r.body, attempt).toContain('MENATER');
    }
  });
});
