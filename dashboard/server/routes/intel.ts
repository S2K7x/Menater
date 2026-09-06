/**
 * Manual lookup: three routes, no writes, no caller-supplied URL.
 *
 * ============================================================================
 * WHAT THIS SURFACE DELIBERATELY DOES NOT ACCEPT
 *
 * A value and, optionally, a kind and a provider list. Never a URL, never a
 * header, never an endpoint. The console is a thing an operator points at
 * hostile input all day — an alert's `raw_log` is text an attacker composed —
 * so a route that took "fetch this and show me the answer" would be a
 * server-side request forgery with a button on it. The provider catalogue in
 * `intel/providers.ts` is what decides every address that is dialled.
 *
 * ============================================================================
 * WHY THERE IS A THROTTLE HERE AND NOT ON THE OTHER READ ROUTES
 *
 * Every other GET in this console costs a database round trip. These cost
 * somebody's API quota, and one of the keys — HIBP's — is rate-limited per
 * key across the whole installation, so a held-down Enter on one screen takes
 * the feature away from everyone else's screen. The limit is per caller
 * address, generous for a human, and it SAYS how long the wait is: a refusal
 * that does not name its own duration gets retried immediately.
 *
 * ============================================================================
 * EVERYTHING THE OPERATOR CAN FIX LEAVES HERE AS A 200
 *
 * `lib/api.ts` turns any 401 into "log in again" and replaces the body of a
 * 502/503/504 with a generic sentence. A provider's 401 forwarded as a 401
 * would send an analyst to the login screen because VirusTotal's key expired.
 * So a lookup that reaches a provider always answers 200, and the per-source
 * failure travels inside the payload where it can be read.
 * ============================================================================
 */

import { json, readBody } from '../respond.ts';
import { SUPPORTED_KINDS } from '../intel/providers.ts';
import { describeProviders, lookup, pwnedRange } from '../intel/lookup.ts';
import type { ObservableKind } from '../intel/observables.ts';
import type { Ctx } from './context.ts';

/**
 * A human runs a handful of lookups a minute; a loop runs thousands.
 *
 * The bucket is keyed on the caller's address, which behind Docker or a
 * reverse proxy is ONE address for everybody — so this is in practice a
 * budget shared by the console, not a per-analyst one. That is the same
 * property the login throttle has, and it follows from the console's lock
 * being a single password that identifies nobody. 40 a minute is set well
 * above what a person does and well below what a loop does, so the shared
 * budget is not a limit anyone reaches by working.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;
const buckets = new Map<string, { count: number; resetAt: number }>();

function overBudget(ip: string, now = Date.now()): number {
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    // Housekeeping, bounded by WORK DONE rather than by a timer: a sweep
    // postponed far enough is a sweep that does not happen.
    if (buckets.size > 512) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return 0;
  }
  b.count += 1;
  return b.count > MAX_PER_WINDOW ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

/** Exposed so a test starts from a clean budget. */
export const resetIntelThrottle = (): void => buckets.clear();

const asKind = (v: unknown): ObservableKind | null =>
  typeof v === 'string' && (SUPPORTED_KINDS as string[]).includes(v) ? (v as ObservableKind) : null;

export async function intelRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, ip } = c;

  /** The catalogue, and which half of it this install can actually use. */
  if (path === '/api/intel/providers' && req.method === 'GET') {
    return json(res, 200, { providers: describeProviders(), kinds: SUPPORTED_KINDS });
  }

  if (path === '/api/intel/lookup' && req.method === 'POST') {
    const wait = overBudget(ip);
    if (wait > 0) {
      return json(res, 429, {
        error: `That is more lookups than these APIs allow from one console. Try again in ${wait} s — `
          + 'the quota being protected is your own key\'s.',
      });
    }
    const body = await readBody(req);
    // SHAPE FIRST, then size. `only: "virustotal"` — a string where a list
    // belongs — would otherwise reach a `Set` constructor and be read
    // character by character, quietly selecting no provider at all. And the
    // catalogue holds seven entries, so a longer list is a mistake or a probe:
    // building a Set out of an unbounded one is work this route need not do.
    const only = Array.isArray(body?.only)
      ? body.only.filter((x: unknown) => typeof x === 'string').slice(0, 20)
      : [];
    const result = await lookup(body?.value, asKind(body?.kind), {
      fresh: body?.fresh === true,
      only,
    });
    // 200 even for an unrecognised value: "that is not an IP address" is an
    // answer to the question that was asked, not a malformed request.
    return json(res, 200, result);
  }

  /**
   * The Pwned Passwords relay. `GET`, because five hex characters in a path
   * carry nothing: they are the part of a hash that is designed to be public.
   */
  const range = /^\/api\/intel\/pwned-range\/([0-9A-Fa-f]{5})$/.exec(path);
  if (range && req.method === 'GET') {
    const wait = overBudget(ip);
    if (wait > 0) return json(res, 429, { error: `Too many checks at once. Try again in ${wait} s.` });
    const out = await pwnedRange(range[1]!);
    if (!out.ok) return json(res, 200, { ok: false, error: out.error });
    // Text, not JSON: the API's own format is one `SUFFIX:COUNT` per line, and
    // re-encoding it here would mean two places agreeing on a shape instead of
    // one. `no-store` matters more than usual — this is password material's
    // neighbourhood, even though none of it is a password.
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(out.body);
    return true;
  }

  return false;
}
