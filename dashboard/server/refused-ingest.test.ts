/**
 * What the console does for a caller it just refused.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `/api/ingest/:source` and `/api/webhook/soc/alert` are the two paths that sit
 * OUTSIDE the console's access lock on purpose — an appliance emitting an alert
 * has no browser session, so the data plane authenticates with a shared secret
 * instead (`auth.ts`, `INGEST_PATH`). They are also, through a tunnel, the part
 * of this product that faces the Internet.
 *
 * `handleAlert` refuses at that door in four ways before the engine is ever
 * reached: the mode is off, no secret is configured, the token is wrong, there
 * is no engine. The route then called `invalidate()` UNCONDITIONALLY, so all
 * four refusals threw away the snapshot cache — `cache` and `inFlight` both.
 *
 * `snapshot.ts`'s own header calls the rebuild "the most expensive thing the
 * console does", and the `inFlight` half exists because "ten tabs used to
 * trigger ten full walks of the run journal in parallel". So a caller holding
 * no credential at all, answered `401`, still spent that — once per request,
 * with no rate limit, on the single thread that also serves the alerts.
 *
 * Nothing shows: the attacker sees a 401, the operator sees a console that got
 * slow. It is this product's own defining defect, a failure that looks like
 * something else, on the door its own file header calls the most sensitive in
 * the product.
 *
 * THE ASSERTION IS THE EFFECT, NOT THE CALL. These tests do not spy on
 * `invalidate()`; they take a snapshot, make the refused request, take another
 * and compare the two by IDENTITY. A live cache hands back the SAME object, a
 * wiped one necessarily builds a new one — so the test cannot pass by the fix
 * merely moving the call somewhere else.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-refused-ingest-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is resolved once, at load.
const { handleRequest } = await import('./app.ts');
const { getConfig } = await import('./config.ts');
const { snapshot, invalidate } = await import('./snapshot.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const captured = { status: 0, body: '' };
  const req: any = {
    method: 'POST',
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield payload; },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) { if (chunk) captured.body = chunk.toString(); },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

const ALERT = {
  alert_id: 'ALT-REFUSED-1',
  rule_name: 'Failed SSH logins',
  severity: 'high',
  timestamp: '2026-09-22T00:00:00Z',
  raw_log: 'sshd: authentication failure',
};

/** Fills the cache and hands back the object a second reader would be served. */
async function warm() {
  invalidate();
  return snapshot('en');
}

describe('a caller refused at the ingestion door does not spend the snapshot', () => {
  beforeEach(() => {
    const c = getConfig();
    c.webhook.mode = 'on';
    c.webhook.secret = 'the-shared-secret';
    c.auth.enabled = false;
  });

  it('keeps the cache when the token is WRONG', async () => {
    const before = await warm();
    const r = await post('/api/ingest/generic', ALERT, { 'x-soc-token': 'not-the-secret' });
    expect(r.status).toBe(401);
    expect(await snapshot('en')).toBe(before);
  });

  it('keeps the cache when there is NO token at all', async () => {
    const before = await warm();
    const r = await post('/api/ingest/generic', ALERT);
    expect(r.status).toBe(401);
    expect(await snapshot('en')).toBe(before);
  });

  it('keeps the cache when the entry point is switched OFF', async () => {
    getConfig().webhook.mode = 'off';
    const before = await warm();
    const r = await post('/api/ingest/generic', ALERT, { 'x-soc-token': 'the-shared-secret' });
    expect(r.status).toBe(503);
    expect(await snapshot('en')).toBe(before);
  });

  it('keeps the cache when no secret is configured, so the door is closed', async () => {
    getConfig().webhook.secret = '';
    const before = await warm();
    const r = await post('/api/ingest/generic', ALERT, { 'x-soc-token': 'anything' });
    expect(r.status).toBe(503);
    expect(await snapshot('en')).toBe(before);
  });

  it('keeps the cache when there is no engine to run the alert', async () => {
    // The fourth refusal, and the one a fresh install actually hits.
    // `getEngine()` returns null only when the coordinates name no host — with
    // the defaults an Engine IS built and merely fails to connect, which is a
    // different answer (500 `engine_failed`, past the secret). The host is part
    // of `cacheKey`, so it is set BEFORE the cache is warmed and put back
    // after, or the comparison would be measuring the key rather than the fix.
    const db = getConfig().database;
    const host = db.host;
    db.host = '';
    try {
      const before = await warm();
      const r = await post('/api/ingest/generic', ALERT, { 'x-soc-token': 'the-shared-secret' });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).reason).toBe('engine_unavailable');
      expect(await snapshot('en')).toBe(before);
    } finally {
      db.host = host;
    }
  });

  it('holds on the LEGACY path too — it is the same branch, and it is the one on the tunnel', async () => {
    const before = await warm();
    const r = await post('/api/webhook/soc/alert', ALERT, { 'x-soc-token': 'wrong' });
    expect(r.status).toBe(401);
    expect(await snapshot('en')).toBe(before);
  });

  /**
   * THE MIRROR, and it is half the fix: an alert that got PAST the secret must
   * still throw the cache away, or "the queue does not show what just arrived"
   * replaces "the console is slow" — the worse of the two, and the one this
   * product exists to make impossible.
   *
   * With coordinates that name a host, `getEngine()` builds an Engine and
   * `start` fails at connect time, so this is the `500 engine_failed` branch:
   * past the door, a run may have been written, and `ran` is true. It is the
   * control that catches a "fix" which merely deletes the `invalidate()` call.
   */
  it('STILL invalidates for a caller that got past the secret', async () => {
    const before = await warm();
    const r = await post('/api/ingest/generic', ALERT, { 'x-soc-token': 'the-shared-secret' });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body).reason).toBe('engine_failed');
    expect(await snapshot('en')).not.toBe(before);
  });

  /**
   * The boundary, claimed on purpose. An unknown source is refused by the ROUTE
   * before `handleAlert` is reached at all, so it was never a way in — this
   * passes before and after, and it is here so that a fix which simply moved
   * `invalidate()` up would be caught.
   */
  it('an unknown source was already refused before any of this', async () => {
    const before = await warm();
    const r = await post('/api/ingest/no-such-siem', ALERT, { 'x-soc-token': 'the-shared-secret' });
    expect(r.status).toBe(404);
    expect(await snapshot('en')).toBe(before);
  });
});
