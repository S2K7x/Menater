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
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
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
  if (payload.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(accepts)) {
    const gz = gzipSync(payload);
    res.writeHead(status, { ...base, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.end(gz);
    // Returning `true` is what lets a route group say "handled" simply by
    // writing `return json(...)`, exactly as every branch already did.
    return true;
  }

  res.writeHead(status, { ...base, 'Content-Length': payload.length });
  res.end(payload);
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
 * Reads a JSON request body.
 *
 * An unreadable body yields `{}` rather than throwing. That holds only because
 * EVERY route validates what it received — the rule routes shape the input
 * before reading it, the ingestion routes reject an alert whose identity
 * fields are missing, and both name what was wrong. A route that skipped that
 * validation would silently act on an empty object.
 *
 * A body over the cap is the one thing that does throw: there is no validation
 * to fall back on, because nothing was read.
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
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
 */
export async function readBodyOrNull(req: any): Promise<any | null> {
  try {
    return await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) throw err;
    return null;
  }
}
