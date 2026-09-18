/**
 * Answering the SAME object twice, and paying for it once.
 *
 * ============================================================================
 * WHAT THIS PINS
 *
 * `snapshot()` hands the same `ConsoleSnapshot` back to every caller for up to
 * fifteen seconds — that is what the cache is for — and `json()` used to run
 * `JSON.stringify` and `gzipSync` over it again on every single answer.
 * Measured on a 563 kB window: 2.5 ms of stringify plus 3.3 ms of gzip, i.e.
 * ~5.8 ms of BLOCKED EVENT LOOP per request, on the one thread that also
 * serves the ingestion webhook. The compression was never the waste; the
 * repetition was.
 *
 * The saving is keyed on the body's IDENTITY, so these tests count WORK — how
 * many times the body is read, how many times gzip runs — and never
 * milliseconds. A stopwatch assertion is the flaky kind this project has
 * already removed once.
 *
 * The two halves that have to hold together are: identity is not content (two
 * equal objects are two answers, because only identity proves nothing changed
 * in between), and the compressed form must never displace the raw one — a
 * client that does not accept gzip has to get the bytes it can read, whatever
 * the previous caller asked for.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Hoisted: `vi.mock` factories run before ordinary module-level consts. */
const spy = vi.hoisted(() => ({ gzips: 0 }));

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    gzipSync: (buf: any, opts?: any) => {
      spy.gzips += 1;
      return actual.gzipSync(buf, opts);
    },
  };
});

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-encoding-test-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

const { json } = await import('./respond.ts');
const { handleRequest } = await import('./app.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Above `GZIP_MIN_BYTES` (4096), so the compression branch is taken. */
const FILLER = 'menater '.repeat(1200);

/**
 * A body that COUNTS how many times it has been serialised.
 *
 * `JSON.stringify` reads each property once per call, so the getter is an
 * exact, deterministic count of the encodings this body paid for.
 */
function counting(fill = FILLER) {
  let reads = 0;
  const body = {
    kind: 'snapshot',
    get payload() { reads += 1; return fill; },
  };
  return { body, reads: () => reads };
}

interface Answer { status: number; headers: Record<string, any>; buf: Buffer }

function answer(body: unknown, opts: { gzip?: boolean; status?: number } = {}): Answer {
  const captured: Answer = { status: 0, headers: {}, buf: Buffer.alloc(0) };
  const res: any = {
    req: { headers: { 'accept-encoding': opts.gzip === false ? 'identity' : 'gzip, deflate' } },
    writeHead(status: number, headers: Record<string, any>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(chunk: any) {
      captured.buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    },
  };
  json(res, opts.status ?? 200, body);
  return captured;
}

beforeEach(() => { spy.gzips = 0; });

describe('encoding one body object once', () => {
  /**
   * THE DEFECT, in one line: ten tabs polling the console at the minimum
   * refresh re-encoded an object the cache had not changed.
   */
  it('serialises a body object once however many times it is answered', () => {
    const { body, reads } = counting();

    answer(body);
    answer(body);
    answer(body);

    expect(reads()).toBe(1);
  });

  it('compresses it once too', () => {
    const { body } = counting();

    answer(body);
    answer(body);

    expect(spy.gzips).toBe(1);
  });

  it('answers byte-for-byte the same thing every time', () => {
    const { body } = counting();

    const first = answer(body);
    const second = answer(body);

    expect(second.buf.equals(first.buf)).toBe(true);
    expect(second.headers['Content-Length']).toBe(first.headers['Content-Length']);
    expect(second.headers['Content-Length']).toBe(second.buf.length);
    expect(JSON.parse(gunzipSync(second.buf).toString('utf8')).payload).toBe(FILLER);
  });
});

describe('what the saving must not change', () => {
  /**
   * IDENTITY IS NOT CONTENT, and that is the whole safety argument: a body
   * that changed is necessarily a different object (`rebuild()` builds a new
   * snapshot, every route composes a new literal), so there is no
   * invalidation anybody can forget. Keying on content would mean hashing
   * bytes we have not produced yet.
   */
  it('encodes two equal but distinct objects separately', () => {
    const a = counting();
    const b = counting();

    answer(a.body);
    answer(b.body);

    expect(a.reads()).toBe(1);
    expect(b.reads()).toBe(1);
    expect(spy.gzips).toBe(2);
  });

  /**
   * The compressed form is kept BESIDE the raw one, never instead of it. A
   * client sending `accept-encoding: identity` after somebody else asked for
   * gzip must still get bytes it can read.
   */
  it('still answers a client that does not accept gzip with the raw bytes', () => {
    const { body, reads } = counting();

    const compressed = answer(body, { gzip: true });
    const plain = answer(body, { gzip: false });

    expect(compressed.headers['Content-Encoding']).toBe('gzip');
    expect(plain.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(plain.buf.toString('utf8')).payload).toBe(FILLER);
    expect(plain.headers['Content-Length']).toBe(plain.buf.length);
    // One serialisation for both answers: only the compression is per-form.
    expect(reads()).toBe(1);
  });

  it('never compresses a body under the threshold', () => {
    const small = { ok: true };

    const first = answer(small);
    const second = answer(small);

    expect(spy.gzips).toBe(0);
    expect(first.headers['Content-Encoding']).toBeUndefined();
    expect(second.buf.toString('utf8')).toBe('{"ok":true}');
  });

  it('answers a body that is not an object at all', () => {
    expect(answer('hello').buf.toString('utf8')).toBe('"hello"');
    expect(answer(null).buf.toString('utf8')).toBe('null');
    expect(answer([1, 2, 3]).buf.toString('utf8')).toBe('[1,2,3]');
  });

  /** The memo holds BYTES, not a response: the status is still the caller's. */
  it('reuses the bytes without reusing the status', () => {
    const { body, reads } = counting();

    expect(answer(body, { status: 200 }).status).toBe(200);
    expect(answer(body, { status: 409 }).status).toBe(409);
    expect(reads()).toBe(1);
  });
});

/**
 * The route this whole memo exists for.
 *
 * No database here, so the snapshot is the sample set — which is still tens of
 * kilobytes, still over the compression threshold, and still the same object
 * for the fifteen seconds its cache holds it. Two polls one after the other is
 * the ordinary state of a console someone has left open.
 */
describe('GET /api/snapshot, answered twice', () => {
  async function get(): Promise<Answer> {
    const captured: Answer = { status: 0, headers: {}, buf: Buffer.alloc(0) };
    const req: any = {
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'accept-encoding': 'gzip, deflate' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {},
    };
    const res: any = {
      req,
      headersSent: false,
      writeHead(status: number, headers: Record<string, any>) {
        captured.status = status;
        captured.headers = headers ?? {};
        res.headersSent = true;
      },
      end(chunk: any) {
        if (chunk) captured.buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      },
      setHeader() {},
    };
    await handleRequest(req, res);
    return captured;
  }

  it('encodes the cached snapshot once, not once per poll', async () => {
    const first = await get();
    const second = await get();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers['Content-Encoding']).toBe('gzip');
    expect(spy.gzips).toBe(1);
    expect(second.buf.equals(first.buf)).toBe(true);
  });

  /**
   * The cadence used to be added by the route, as `{ ...snap, refresh_seconds }`
   * — a new object on every request, which is exactly what stopped the answer
   * from being recognised as one already encoded. It travels ON the snapshot
   * now, and the screen still reads it where it always did.
   */
  it('still carries the refresh cadence the screen reads', async () => {
    const body = JSON.parse(gunzipSync((await get()).buf).toString('utf8'));
    expect(body.refresh_seconds).toBe(20);
  });
});
