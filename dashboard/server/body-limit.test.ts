/**
 * The request body limit, and what a sender is told when it is hit.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `readBody` has capped the body at 256 kB since the request-body trap was
 * written down — that half worked. What was never checked is the SENTENCE, and
 * every one of the three shapes it took said something that was not true:
 *
 *   - `PUT /api/ingestion/policy` answered **200 with the current policy**.
 *     Its `.catch(() => null)` reached `normalizePolicyInput(null, current)`,
 *     which treats an absent body as "change nothing" and reports success. A
 *     refused save, reported as a save. That is the defect the Tracking tab
 *     exists to expose, on a settings route.
 *   - `POST /api/findings/promote` and the two ingestion endpoints answered
 *     with a verdict about the body's SHAPE — "scan_run_id: a non-empty string
 *     is required" — about fields nobody had read. A diagnosis nobody made.
 *   - every other route answered **500** with `Corps de requete trop
 *     volumineux.`: a server-fault code for a sender-fault, in French, in a
 *     product that is English-only.
 *
 * So the three assertions here are: the STATUS says whose fault it is, the
 * SENTENCE says it was the size and names the cap, and a body under the cap is
 * untouched — because "lower everything until nothing is refused" is the
 * plausible wrong fix.
 * ============================================================================
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-body-limit-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('./app.ts');
const { BodyTooLarge, MalformedBody, readBody, readBodyOrNull, humanBytes } = await import('./respond.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** The cap `respond.ts` declares. Written out so the test states the number. */
const CAP = 256 * 1024;

interface Captured { status: number; body: string }

/**
 * Drives the real handler with a raw body of a chosen size.
 *
 * The body is yielded in 64 kB chunks, like a socket delivers it: the cap is
 * checked BETWEEN chunks, so a single-chunk fixture would exercise a different
 * branch from the one production takes.
 */
async function call(method: string, url: string, raw: Buffer | null): Promise<Captured> {
  const captured: Captured = { status: 0, body: '' };
  const req: any = {
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (!raw) return;
      for (let i = 0; i < raw.length; i += 65536) yield raw.subarray(i, i + 65536);
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

/** A syntactically valid JSON body of at least `bytes` bytes. */
function bodyOfAtLeast(bytes: number, extra: Record<string, unknown> = {}): Buffer {
  const head = Buffer.from(JSON.stringify({ ...extra, filler: '' }));
  return Buffer.from(JSON.stringify({ ...extra, filler: 'x'.repeat(Math.max(1, bytes - head.length)) }));
}

describe('a body refused for its size says so', () => {
  const oversized = bodyOfAtLeast(CAP + 1024);

  it('does not report a refused save as a save', async () => {
    // The route that answered 200 with the policy it had not changed.
    const r = await call('PUT', '/api/ingestion/policy', oversized);
    expect(r.status).toBe(413);
    // And it must not carry the settled policy beside the refusal: a caller
    // reading `policy` back is a caller who believes the write landed.
    expect(JSON.parse(r.body).policy).toBeUndefined();
  });

  it('does not name fields nobody read', async () => {
    const r = await call('POST', '/api/findings/promote', oversized);
    expect(r.status).toBe(413);
    expect(r.body).not.toContain('scan_run_id');
    expect(r.body).not.toContain('is required');
  });

  it('answers the same at the ingestion endpoints, new path and legacy', async () => {
    for (const path of ['/api/ingest/wazuh', '/api/webhook/soc/alert']) {
      const r = await call('POST', path, oversized);
      expect(r.status, path).toBe(413);
      // Not a verdict about the alert's shape, and not one about the door
      // either: nothing here looked at either.
      expect(r.body, path).not.toContain('schema');
      expect(r.body, path).not.toContain('webhook_disabled');
    }
  });

  it('is a 413 and not the last net\'s 500 on an ordinary route', async () => {
    const r = await call('POST', '/api/auth/login', oversized);
    expect(r.status).toBe(413);
  });

  it('names the cap in English, in a unit somebody can say out loud', async () => {
    const { error } = JSON.parse((await call('POST', '/api/auth/login', oversized)).body);
    expect(error).toContain('256 kB');
    // The sentence it replaced, and the raw byte count that would replace it
    // the next time somebody writes this without `humanBytes`.
    expect(error).not.toContain('Corps de requete');
    expect(error).not.toContain('262144');
    // English only: the catalogue is the rule, this is the check on this key.
    expect(error).toMatch(/^[\x20-\x7E]+$/);
  });

  it('leaves a body under the cap alone', async () => {
    // The plausible wrong fix is a cap low enough that nothing gets through.
    // A 200 kB policy write is accepted and applied.
    const big = bodyOfAtLeast(200 * 1024, { delivery: 'pull' });
    const r = await call('PUT', '/api/ingestion/policy', big);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).policy.delivery).toBe('pull');
  });
});

describe('readBodyOrNull', () => {
  /** A request whose stream fails, or delivers `raw`. */
  function request(raw: Buffer | null, fail?: Error): any {
    return {
      async *[Symbol.asyncIterator]() {
        if (fail) throw fail;
        if (raw) yield raw;
      },
    };
  }

  it('still answers null for a body that could not be read', async () => {
    // A socket that dies mid-transfer tells a route nothing it can pass on,
    // and the three callers that use this form depend on that staying true.
    await expect(readBodyOrNull(request(null, new Error('aborted')))).resolves.toBeNull();
    // Unreadable JSON is NOT that case: it used to be answered `{}` here, and
    // the three callers then described a body nobody had read. It travels on
    // like the size refusal above — `malformed-body.test.ts` owns that half.
    await expect(readBodyOrNull(request(Buffer.from('{oops')))).rejects.toBeInstanceOf(MalformedBody);
  });

  it('lets a refusal WE made travel on', async () => {
    const oversized = Buffer.alloc(CAP + 1, 0x20);
    await expect(readBodyOrNull(request(oversized))).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readBody(request(oversized))).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it('carries the cap it enforced, rather than leaving the caller to guess it', async () => {
    const err = await readBody(request(Buffer.alloc(CAP + 1, 0x20))).catch((e) => e);
    expect(err.limit).toBe(CAP);
    expect(humanBytes(err.limit)).toBe('256 kB');
  });
});
