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
 * Reads a JSON request body.
 *
 * An unreadable body yields `{}` rather than throwing. That holds only because
 * EVERY route validates what it received — the rule routes shape the input
 * before reading it, the ingestion routes reject an alert whose identity
 * fields are missing, and both name what was wrong. A route that skipped that
 * validation would silently act on an empty object.
 */
export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Corps de requete trop volumineux.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
