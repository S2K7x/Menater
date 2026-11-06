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
 *
 * ============================================================================
 * AND WHICH FORM, WHICH IS THE SECOND SUBJECT OF THIS FILE
 *
 * The window this console answers is 67% run UUIDs by compressed size, each one
 * appearing three times about a hundred kilobytes from its copies — far outside
 * DEFLATE's 32,768-byte sliding window, so gzip pays for every occurrence in
 * full. Brotli's window is megabytes. Measured on a real 500-run window:
 * 51,061 gzipped bytes against 29,126 at brotli q4, for LESS CPU.
 *
 * The claims below are therefore about the CHOICE of form: brotli when it is
 * offered, gzip when it is not, nothing when neither is, and never a form the
 * client refused. The quality is pinned as a number because the library's own
 * default is 11, which measured 992 ms of blocked event loop on that window.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { brotliDecompressSync, constants, gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Hoisted: `vi.mock` factories run before ordinary module-level consts. */
const spy = vi.hoisted(() => ({ gzips: 0, brotlis: 0, quality: [] as unknown[] }));

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    gzipSync: (buf: any, opts?: any) => {
      spy.gzips += 1;
      return actual.gzipSync(buf, opts);
    },
    brotliCompressSync: (buf: any, opts?: any) => {
      spy.brotlis += 1;
      spy.quality.push(opts?.params?.[actual.constants.BROTLI_PARAM_QUALITY]);
      return actual.brotliCompressSync(buf, opts);
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

function answer(
  body: unknown,
  opts: { gzip?: boolean; status?: number; offers?: string } = {},
): Answer {
  const captured: Answer = { status: 0, headers: {}, buf: Buffer.alloc(0) };
  const res: any = {
    req: {
      headers: {
        'accept-encoding': opts.offers ?? (opts.gzip === false ? 'identity' : 'gzip, deflate'),
      },
    },
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

beforeEach(() => { spy.gzips = 0; spy.brotlis = 0; spy.quality = []; });

/** What a browser really sends, measured in Chromium 1194 over plain HTTP. */
const BROWSER = 'gzip, deflate, br, zstd';
/** What Node's own `fetch` sends — an MCP client, an appliance, our probes. */
const NODE_FETCH = 'gzip, deflate';

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
 * WHICH FORM, AND NEVER ONE THE CLIENT REFUSED.
 *
 * Two of these five claims pass before AND after the brotli change, on
 * purpose: the client that offers only gzip and the client that offers nothing
 * are the console's own callers — Node's `fetch` (the MCP bridge, the loopback
 * probes) and an appliance posting an alert — and a saving for browsers that
 * changed what they are answered would be a different bug.
 */
describe('which compressed form the answer takes', () => {
  it('answers a browser in brotli', () => {
    const { body } = counting();

    const a = answer(body, { offers: BROWSER });

    expect(a.headers['Content-Encoding']).toBe('br');
    expect(a.headers['Content-Length']).toBe(a.buf.length);
    expect(JSON.parse(brotliDecompressSync(a.buf).toString('utf8')).payload).toBe(FILLER);
  });

  it('answers a client that offers only gzip in gzip', () => {
    const { body } = counting();

    const a = answer(body, { offers: NODE_FETCH });

    expect(a.headers['Content-Encoding']).toBe('gzip');
    expect(spy.brotlis).toBe(0);
    expect(JSON.parse(gunzipSync(a.buf).toString('utf8')).payload).toBe(FILLER);
  });

  it('answers a client that offers nothing with the raw bytes', () => {
    const { body } = counting();

    const a = answer(body, { offers: '' });

    expect(a.headers['Content-Encoding']).toBeUndefined();
    expect(spy.gzips).toBe(0);
    expect(spy.brotlis).toBe(0);
    expect(JSON.parse(a.buf.toString('utf8')).payload).toBe(FILLER);
  });

  /**
   * Every form is kept BESIDE the others, which is the rule the gzip memo
   * already stated: the next caller may be one that reads none of them.
   */
  it('keeps all three forms of one body, each produced once', () => {
    const { body, reads } = counting();

    const brotli = answer(body, { offers: BROWSER });
    const gzip = answer(body, { offers: NODE_FETCH });
    const plain = answer(body, { offers: 'identity' });
    answer(body, { offers: BROWSER });
    answer(body, { offers: NODE_FETCH });

    expect(JSON.parse(brotliDecompressSync(brotli.buf).toString('utf8')).payload).toBe(FILLER);
    expect(JSON.parse(gunzipSync(gzip.buf).toString('utf8')).payload).toBe(FILLER);
    expect(JSON.parse(plain.buf.toString('utf8')).payload).toBe(FILLER);
    // One serialisation, one brotli, one gzip — for five answers.
    expect(reads()).toBe(1);
    expect(spy.brotlis).toBe(1);
    expect(spy.gzips).toBe(1);
  });

  /**
   * `q=0` is how a client says an encoding is NOT acceptable (RFC 9110 § 12.5.3),
   * and the single-token regex this function used could not see it. Reading it
   * is what makes a second encoding safe to add: with two forms on offer,
   * "which one does this caller want" stops being a boolean.
   */
  it('never sends a form the client refused with q=0', () => {
    const { body } = counting();

    const noBrotli = answer(body, { offers: 'gzip, deflate, br;q=0' });
    const neither = answer(body, { offers: 'br;q=0, gzip;q=0, deflate' });

    expect(noBrotli.headers['Content-Encoding']).toBe('gzip');
    expect(neither.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(neither.buf.toString('utf8')).payload).toBe(FILLER);
  });

  /**
   * `br` is two characters, so a token search for it matches the start of any
   * longer name. Answering brotli to a client that named something else is the
   * same defect as answering a form it refused.
   */
  it('compares the whole token, not a prefix of it', () => {
    const { body } = counting();

    const made_up = answer(body, { offers: 'brotli, gzipped' });

    expect(made_up.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(made_up.buf.toString('utf8')).payload).toBe(FILLER);
  });

  /**
   * THE QUALITY IS A NUMBER THIS CODE CHOOSES, and that is not a style point:
   * `brotliCompressSync` with no parameters compresses at quality 11, which
   * measured 992 ms of blocked event loop on a 610 kB window against gzip's
   * 3.9 ms. Four is the value for which there is no trade-off at all — fewer
   * bytes AND less CPU than the gzip it replaces.
   */
  it('compresses at an explicitly chosen quality, not the library default', () => {
    answer(counting().body, { offers: BROWSER });

    expect(spy.quality).toHaveLength(1);
    expect(typeof spy.quality[0]).toBe('number');
    expect(spy.quality[0]).toBeLessThan(constants.BROTLI_DEFAULT_QUALITY);
    expect(spy.quality[0]).toBeLessThanOrEqual(5);
  });

  it('does not compress a body under the threshold for a browser either', () => {
    const a = answer({ ok: true }, { offers: BROWSER });

    expect(spy.brotlis).toBe(0);
    expect(a.headers['Content-Encoding']).toBeUndefined();
    expect(a.buf.toString('utf8')).toBe('{"ok":true}');
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
  async function get(offers = NODE_FETCH): Promise<Answer> {
    const captured: Answer = { status: 0, headers: {}, buf: Buffer.alloc(0) };
    const req: any = {
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'accept-encoding': offers },
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

  /**
   * The polling browser, which is who this route is for: one snapshot object
   * for fifteen seconds, one brotli for all of its answers.
   */
  it('answers the polling browser in brotli, encoded once', async () => {
    const first = await get(BROWSER);
    const second = await get(BROWSER);

    expect(first.headers['Content-Encoding']).toBe('br');
    expect(spy.brotlis).toBe(1);
    expect(second.buf.equals(first.buf)).toBe(true);
    expect(JSON.parse(brotliDecompressSync(first.buf).toString('utf8')).refresh_seconds).toBe(20);
  });
});
