/**
 * Reading a request, and answering it.
 *
 * The two ends of every route, kept together and away from the routes
 * themselves: what comes in has a size limit, what goes out has a content type,
 * a cache policy and — past a threshold — compression. None of that is a
 * decision any individual route should be making twice.
 */

import { gzipSync } from 'node:zlib';

/**
 * Below this size, compressing costs more than it returns: the gain is
 * measured in microseconds, the cost in CPU cycles on every small response.
 */
const GZIP_MIN_BYTES = 4096;

/**
 * Bytes already produced for a body object.
 *
 * ============================================================================
 * THE SNAPSHOT IS ONE OBJECT, ANSWERED MANY TIMES
 *
 * `snapshot()` hands the SAME `ConsoleSnapshot` back to every caller for up to
 * fifteen seconds — that is what its cache is for — and this function used to
 * re-run `JSON.stringify` and `gzipSync` over it on every one of those
 * answers. Measured on a 563 kB window: 2.5 ms of stringify plus 3.3 ms of
 * gzip, about 5.8 ms of BLOCKED EVENT LOOP per request, on the single thread
 * that also serves the ingestion webhook. Ten tabs at the minimum refresh is
 * ~12 ms of loop per second spent re-encoding bytes nothing had changed.
 *
 * The compression was never the waste. The REPETITION was, which is why the
 * answer is a memo and not an asynchronous `gzip`.
 *
 * KEYED ON IDENTITY, AND THAT IS THE WHOLE SAFETY ARGUMENT. A body that
 * changed is necessarily a different object: `rebuild()` builds a new
 * snapshot, and every other route composes a fresh literal per request. So
 * there is no invalidation for anybody to forget — the same reasoning as the
 * service inventory's index, which is memoised on its array's identity for
 * exactly this reason. What it forbids is answering twice with an object
 * MUTATED in between; no route in this server does that, and
 * `respond-encoding.test.ts` pins the contract.
 *
 * A `WeakMap`, so the bytes are collected with the body instead of being held
 * for the life of the process.
 * ============================================================================
 */
const encoded = new WeakMap<object, { raw: Buffer; gzip: Buffer | null }>();

/**
 * The serialised body, produced once per object.
 *
 * A body that is not an object — a string, `null`, a number — cannot key a
 * `WeakMap`, so it is encoded as it always was. Those are small answers by
 * construction; the ones worth memoising are all objects.
 */
function encodeOnce(body: unknown): { raw: Buffer; gzip: Buffer | null } {
  const key = typeof body === 'object' && body !== null ? (body as object) : null;
  const hit = key ? encoded.get(key) : undefined;
  if (hit) return hit;

  const slot = { raw: Buffer.from(JSON.stringify(body), 'utf8'), gzip: null as Buffer | null };
  if (key) encoded.set(key, slot);
  return slot;
}

/**
 * Answers with JSON.
 *
 * `no-store` is not decoration: a triage queue served from a browser cache is
 * a queue that lies about what is waiting.
 */
export function json(
  res: any,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): true {
  const slot = encodeOnce(body);
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };

  // The snapshot runs to several hundred kB: it carries the ENTIRE execution
  // window, traceability included. It often travels over the network (console
  // open somewhere other than the API's machine), and JSON compresses about
  // tenfold.
  const accepts = String(res.req?.headers?.['accept-encoding'] ?? '');
  if (slot.raw.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(accepts)) {
    // Compressed lazily and kept BESIDE the raw form, never instead of it: the
    // next caller may be one that sends `accept-encoding: identity`, and it
    // has to get bytes it can read.
    if (!slot.gzip) slot.gzip = gzipSync(slot.raw);
    res.writeHead(status, {
      ...base, 'Content-Encoding': 'gzip', 'Content-Length': slot.gzip.length });
    res.end(slot.gzip);
    // Returning `true` is what lets a route group say "handled" simply by
    // writing `return json(...)`, exactly as every branch already did.
    return true;
  }

  res.writeHead(status, { ...base, 'Content-Length': slot.raw.length });
  res.end(slot.raw);
  return true;
}

/** Size limit: an unbounded body is a memory-exhaustion vector. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * A byte count someone can read out loud.
 *
 * `max / 1024 / 1024` printed "over 0.00048828125 MB" for a 500-byte cap, and
 * would print the same kind of thing to an operator the day somebody lowers a
 * constant. A limit nobody can read is a limit nobody can act on.
 *
 * It lives here rather than beside either refusal because this console refuses
 * a size in two directions — a request body it will not read, and a polled
 * source's response it will not buffer — and two spellings of one number is
 * how the two start disagreeing.
 */
export function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} bytes`;
}

/**
 * A body refused for its SIZE.
 *
 * Its own class rather than a plain `Error`, because what a route can do about
 * it is the opposite of what it can do about an unreadable body. A stream that
 * died mid-transfer leaves a route nothing to pass on; this is a refusal WE
 * made, before anything was read, for a reason the sender can act on. Told
 * apart, it becomes a 413 naming the cap; conflated, it became a verdict about
 * fields nobody had looked at.
 *
 * No parameter property (`constructor(readonly limit: number)`): the service
 * runs under `node --experimental-strip-types`, which refuses that syntax at
 * startup while `tsc` and vitest accept it.
 */
export class BodyTooLarge extends Error {
  /** The cap that was enforced, so the answer can name it rather than guess. */
  limit: number;

  constructor(limit: number) {
    super(`request body over ${humanBytes(limit)}`);
    this.limit = limit;
  }
}

/**
 * A body that arrived and is not something any route can read.
 *
 * The sibling of `BodyTooLarge`, and it exists for the same reason: mapped to
 * the empty object, this refusal was answered by whatever a route does when it
 * is sent nothing. Four configuration saves read that as *change nothing* and
 * reported success; the ingestion endpoints told an appliance its alert was
 * missing the fields nobody could read; the login route called it a wrong
 * password and spent one of the eight attempts.
 *
 * `reason` is carried because the two states are not one: bytes that do not
 * parse are not valid JSON, and `null` or a number is valid JSON that names no
 * field. One sentence for both would be reachable from a state it does not
 * describe.
 *
 * No parameter property: the service runs under
 * `node --experimental-strip-types`, which refuses that syntax at startup.
 */
export class MalformedBody extends Error {
  /** `not_json`: the bytes do not parse. `not_an_object`: they parse to a scalar or null. */
  reason: 'not_json' | 'not_an_object';

  constructor(reason: 'not_json' | 'not_an_object') {
    super(reason === 'not_json' ? 'request body is not valid JSON' : 'request body is not a JSON object');
    this.reason = reason;
  }
}

/**
 * Reads a JSON request body.
 *
 * Three answers, and they are three facts. NOTHING ARRIVED is `{}` — a dozen
 * routes take no body, and that must stay true. Bytes that arrived and cannot
 * be read are a refusal WE made, so they throw and the answer names what was
 * wrong with them. A body over the cap throws first, because its refusal is
 * about a size nobody read past.
 *
 * It used to answer `{}` for the middle case too, under a header saying that
 * held "because EVERY route validates what it received". Measured against the
 * real handler, that was false in both directions: the routes that do not
 * validate reported a save nobody made, and the routes that do described a
 * body nobody could read. See `malformed-body.test.ts`.
 *
 * An ARRAY is returned as itself: `/api/mcp` takes a JSON-RPC batch, and that
 * is the one top-level array this API accepts.
 */
export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      // DISCARD WHAT IS ALREADY HELD before refusing, rather than politely
      // finishing an accumulation we have already decided to throw away.
      chunks.length = 0;
      throw new BodyTooLarge(MAX_BODY_BYTES);
    }
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // V8's own message names a position in a buffer the sender cannot see, so
    // it is not forwarded: the class carries the fact, the route the sentence.
    throw new MalformedBody('not_json');
  }
  if (parsed === null || typeof parsed !== 'object') throw new MalformedBody('not_an_object');
  return parsed;
}

/**
 * The body, or `null` for one the route can answer without.
 *
 * Three routes read their body this way — the two ingestion endpoints and the
 * promote route — because each still has something to say when the body is
 * missing: they name the identity fields an alert needs. Written as
 * `readBody(req).catch(() => null)`, that also swallowed the size refusal, and
 * the sender was then told its alert was missing fields that were present and
 * merely unread. Only the unreadable body is `null`; a refusal we made travels
 * on to the one place that can word it.
 *
 * `null` therefore means ONE thing: the stream itself failed — a socket that
 * died mid-transfer, which tells a route nothing it can pass on. Both of our
 * own refusals, the size and the shape, travel.
 */
export async function readBodyOrNull(req: any): Promise<any | null> {
  try {
    return await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge || err instanceof MalformedBody) throw err;
    return null;
  }
}
