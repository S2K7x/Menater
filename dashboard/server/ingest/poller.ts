/**
 * N5 — the pull transport.
 *
 * ============================================================================
 * IT LIVES OUTSIDE THE ENGINE, ON PURPOSE
 *
 * ROADMAP § 2 bis asked the question and this is the answer it proposed: the
 * node catalogue is closed at sixteen types and has no `trigger.schedule`.
 * Adding a seventeenth type to fetch alerts would put a timer inside the thing
 * whose closed-ness is a safety property. Collection is a TRANSPORT concern —
 * it belongs beside the webhook handler, not inside the workflow engine — and
 * an alert it collects enters `01-Ingestion` at exactly the line a pushed one
 * does. Every guardrail downstream is unchanged, because it is the same
 * downstream.
 *
 * ============================================================================
 * FOUR PROPERTIES, AND EACH ONE IS A BUG SOMEONE HAS SHIPPED
 *
 *  1. THE CURSOR ONLY MOVES ON DATA WE RECEIVED. See `cursors.ts`.
 *
 *  2. THE WINDOW OVERLAPS. A source that timestamps at detection and indexes a
 *     second later loses that second forever under an exact cursor. We ask for
 *     `cursor - overlap` and let dedup discard the repeats.
 *
 *  3. POLLS DO NOT PILE UP. A source that takes 90 s to answer on a 60 s
 *     interval would otherwise accumulate overlapping requests until the heap
 *     gives out. One poll per source at a time, and a slow source simply polls
 *     less often — which is the honest consequence of it being slow.
 *
 *  4. THE BODY IS ALWAYS CONSUMED. Node's `fetch` keeps the socket checked out
 *     of the pool until the body is read or cancelled; every early return here
 *     goes through `drain()`. That trap is in CLAUDE.md, paid for once already
 *     on the enrichment sources.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * NO RETRY STORM. A failed poll is not retried inside the tick: the next tick
 * IS the retry, and it is already spaced by the interval. Retrying a source
 * that is rate-limiting us is how a poller gets a key revoked.
 *
 * NO INVENTED CURSOR. If no alert in a batch carries a readable timestamp, the
 * cursor stays where it was. Re-reading a window costs a dedup lookup; moving
 * a cursor past alerts we could not date costs the alerts.
 * ============================================================================
 */

import { describeFetchError, fetchWithDeadline } from '../http.ts';
import { mapLimit } from '../limit.ts';
import { isManagedCredential } from '../credentials.ts';
import { mappingFor, normalize } from '../engine/transforms/normalize.ts';
import { readPath } from '../engine/values.ts';
import { readCursor, recordPoll } from './cursors.ts';
import type { IngestionPolicy, PullSource } from './policy.ts';

/**
 * How many alerts of one batch are handed to the pipeline at once.
 *
 * IT USED TO BE ONE, AND THAT WAS THE WRONG KIND OF PRUDENCE. `engine.start`
 * awaits the whole pipeline, and 03 makes a model call: about sixteen seconds
 * per alert on this instance. A batch of a hundred delivered strictly in
 * sequence is a poll that holds a source for twenty-six minutes — during which
 * `inFlight` correctly refuses to poll it again, so a "smoothed" transport
 * turns into a stalled one.
 *
 * FOUR IS THE SMOOTHING, and it is the number that makes the word honest:
 * `batchSize` bounds how much we READ per poll, this bounds how much RUNS at
 * once. Push has no equivalent — a burst of a hundred webhooks opens a hundred
 * pipelines — and that difference is precisely what the pull lane is for.
 *
 * Deliberately lower than `DETAIL_CONCURRENCY`'s eight: those are HTTP reads
 * against one n8n, these are full pipeline runs that each write to Postgres
 * and call a model on somebody's budget.
 */
const DELIVERY_CONCURRENCY = 4;

/**
 * How many SOURCES are polled at once.
 *
 * `Promise.all` over every enabled source is the trap this codebase already
 * paid for once, in `n8n.ts`: with enough of them, the last requests in the
 * queue burn their 20 s timeout waiting for a socket and the source is
 * recorded as unreachable when it was merely queued behind us.
 */
const SOURCE_CONCURRENCY = 4;

/**
 * The largest response we will read into memory.
 *
 * The mirror image of a trap already in CLAUDE.md — "a request body with no
 * size limit" — pointing the other way. `await res.json()` buffers whatever
 * arrives, and the address is one somebody typed into a form: a source that
 * answers a gigabyte, by malice or by a forgotten pagination parameter, grows
 * the heap until the console dies. The console has no business being taken
 * down by a log source.
 *
 * 16 MB is far past any honest page of alerts and far short of trouble; the
 * refusal names the size, so it reads as "narrow your query", not as an outage.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The failure backoff, in multiples of the polling interval.
 *
 * A source that has been refusing us for an hour does not become reachable by
 * being asked every fifteen seconds, and hammering one that answered 429 is
 * how a poller gets its key revoked. Doubling per consecutive failure, capped:
 *
 *   1 failure → 2 intervals, 2 → 4, 3 → 8 … up to `BACKOFF_MAX_MS`.
 *
 * JITTERED DOWNWARD, never upward: several sources that failed together — a
 * network outage — would otherwise all come back at the same instant and
 * rebuild the burst. Same reasoning as the assistant's `full jitter`, and the
 * floor keeps the wait at least one interval so the backoff never UNDERCUTS
 * the cadence the operator chose.
 *
 * The skip is never silent: `nextAttemptAt` is on the cursor and on screen.
 */
const BACKOFF_MAX_MS = 30 * 60 * 1000;

export function backoffFor(failures: number, intervalMs: number): number {
  if (failures <= 0) return 0;
  const doubled = intervalMs * 2 ** Math.min(failures, 8);
  const capped = Math.min(doubled, BACKOFF_MAX_MS);
  // Full jitter between one interval and the capped delay: never shorter than
  // the cadence that was asked for, never longer than the cap.
  const floor = Math.min(intervalMs, capped);
  return Math.round(floor + Math.random() * (capped - floor));
}

/** What one poll did, for the interface and for the tests. */
export interface PollOutcome {
  source: string;
  /** Alerts handed to the pipeline. Duplicates the engine rejects are still counted here. */
  accepted: number;
  /** Items the source returned that carried no readable identity. */
  unusable: number;
  error: string | null;
  /** Where the cursor stands after this poll. */
  since: string | null;
  /**
   * When this source may be tried again, after a failure. `null` when it is
   * due now. Returned so the interface can SAY the source is being skipped —
   * a silent skip is the failure showing green all over again.
   */
  nextAttemptAt: string | null;
}

export interface PollerDeps {
  /** Hands one normalized alert to the pipeline. Returns the run id, or throws. */
  deliver: (source: string, alert: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

/** Read and discard a body we are not going to use. See property 4. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed, or no body: nothing to reclaim */
  }
}

export class ResponseTooLarge extends Error {}

/**
 * A byte count someone can read out loud.
 *
 * `max / 1024 / 1024` printed "over 0.00048828125 MB" for a 500-byte cap in a
 * test, and would print the same kind of thing to an operator the day somebody
 * lowers the constant. A limit nobody can read is a limit nobody can act on.
 */
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} bytes`;
}

/**
 * The response body, as text, refusing anything past `max` bytes.
 *
 * STREAMED AND COUNTED rather than buffered then measured: checking the length
 * after `res.text()` is checking whether the heap survived, which is not a
 * check. The stream is cancelled the moment the cap is passed, so an endless
 * response costs `max` bytes and one cancel, not a process.
 *
 * `Content-Length` is consulted first only as a courtesy — it is a claim by the
 * other end, so it can refuse early but is never trusted to let anything
 * through.
 */
export async function readCapped(res: Response, max: number): Promise<string> {
  const claimed = Number(res.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(claimed) && claimed > max) {
    await drain(res);
    throw new ResponseTooLarge(
      `the source announced ${humanBytes(claimed)}, over the ${humanBytes(max)} `
      + 'this console will read. Narrow the query, or lower the batch size.',
    );
  }

  const body = res.body;
  // No stream (an older runtime, or a test's plain Response): fall back to the
  // whole text and check it. The cap is then a diagnosis rather than a guard,
  // which is still better than no cap.
  if (!body) {
    const text = await res.text();
    if (text.length > max) throw new ResponseTooLarge(`the response exceeds ${humanBytes(max)}.`);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        // DISCARD WHAT IS ALREADY HELD before refusing, rather than finishing
        // the accumulation politely — the exact wording of the request-body
        // trap, applied in the other direction.
        chunks.length = 0;
        throw new ResponseTooLarge(
          `the response is over ${humanBytes(max)}. Narrow the query, or lower the batch size.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket back to the pool whether we finished or refused.
    try { await reader.cancel(); } catch { /* already done */ }
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The array of alerts inside a response.
 *
 * `itemsPath` empty means the body IS the array — the shape a plain
 * `GET /alerts` returns. A body that is neither is an answer we cannot read,
 * and it says so rather than treating it as zero alerts: "the source returned
 * nothing" and "we could not find the alerts in what it returned" are opposite
 * facts, and only one of them is good news.
 */
export function extractItems(
  body: unknown,
  itemsPath: string,
): { items: Record<string, unknown>[]; error: string | null } {
  const at = itemsPath === '' ? body : readPath(body as Record<string, unknown>, itemsPath);
  if (!Array.isArray(at)) {
    return {
      items: [],
      error: itemsPath === ''
        ? 'the response body is not a list of alerts. Name the field that holds them.'
        : `no list of alerts at "${itemsPath}" in the response.`,
    };
  }
  return { items: at.filter((i) => i && typeof i === 'object') as Record<string, unknown>[], error: null };
}

/**
 * The newest timestamp among alerts we actually received, or `null`.
 *
 * `null` leaves the cursor untouched. See "no invented cursor".
 */
export function newestTimestamp(alerts: Record<string, unknown>[]): string | null {
  let best: number | null = null;
  let bestRaw: string | null = null;
  for (const a of alerts) {
    const raw = a.timestamp;
    if (typeof raw !== 'string') continue;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) { best = t; bestRaw = raw; }
  }
  return bestRaw;
}

/**
 * The address to call, cursor and overlap applied.
 *
 * ============================================================================
 * WITH NO CURSOR YET, IT LOOKS BACK. IT USED TO ASK FOR "NOW".
 *
 * That was a silent, permanent hole, and only running it showed it. The rule
 * one line up — an empty poll does not advance the checkpoint — means a source
 * that has never delivered anything keeps a `null` cursor. Asking `now` on a
 * `null` cursor therefore meant:
 *
 *   poll at T-15s asks for [T-15s, ∞)   → nothing yet, cursor stays null
 *   an alert is raised at T-10s
 *   poll at T     asks for [T, ∞)       → the alert is already in the past
 *
 * The window between two polls was never requested by either of them. Every
 * alert raised before the source's first delivery fell into a gap, forever,
 * with a green check on screen and a cursor that looked perfectly healthy.
 * The two rules were each right and their intersection was a data-loss bug.
 *
 * The lookback is `interval + overlap`, which is by construction longer than
 * the time since the previous poll — so consecutive windows always overlap and
 * nothing can fall between them. Deduplication throws the repeats away, which
 * is the same bargain the overlap already makes.
 * ============================================================================
 */
export function pollUrl(
  src: PullSource,
  since: string | null,
  overlapSeconds: number,
  now: Date,
  intervalSeconds = 0,
): string {
  const url = new URL(src.url);
  const from = since
    ? new Date(Date.parse(since) - overlapSeconds * 1000)
    : new Date(now.getTime() - (intervalSeconds + overlapSeconds) * 1000);
  url.searchParams.set(src.cursorParam, from.toISOString());
  return url.toString();
}

/** One poll of one source. Never throws: a transport is not allowed to take the console down. */
export async function pollSource(
  src: PullSource,
  policy: IngestionPolicy,
  deps: PollerDeps,
): Promise<PollOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const cursor = readCursor(src.source);
  const intervalMs = policy.pull.intervalSeconds * 1000;
  const fail = (message: string): PollOutcome => {
    const out = recordPoll(src.source, {
      error: message,
      received: 0,
      // The NEXT failure's wait, computed from the count this one produces.
      backoffMs: backoffFor(cursor.failures + 1, intervalMs),
    });
    return {
      source: src.source, accepted: 0, unusable: 0,
      error: message, since: cursor.since, nextAttemptAt: out.nextAttemptAt,
    };
  };

  if (src.url === '') return fail('no address configured for this source.');
  const mapping = mappingFor(src.source);
  // Same refusal as the push route: an unknown source is named, never guessed
  // at. Mis-detecting a format produces a half-mapped alert, which is worse
  // than no alert.
  if (!mapping) return fail(`no mapping for source "${src.source}" — nothing would know how to read it.`);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (src.authHeader !== '' && src.authCredential !== '') {
    // CLOSED CATALOGUE, again. Reading an arbitrary environment variable into
    // an outbound header would turn this field into a way to exfiltrate any
    // secret this process holds, to an address typed in the same form.
    if (!isManagedCredential(src.authCredential)) {
      return fail(`"${src.authCredential}" is not one of the credentials this console manages.`);
    }
    const value = process.env[src.authCredential];
    if (!value) return fail(`the credential ${src.authCredential} is not set: the source would refuse us.`);
    headers[src.authHeader] = value;
  }

  let res: Response;
  try {
    res = await fetchWithDeadline(
      pollUrl(src, cursor.since, policy.pull.overlapSeconds, now, policy.pull.intervalSeconds),
      { method: 'GET', headers },
      { timeoutMs: 20_000, fetchImpl: deps.fetchImpl },
    );
  } catch (err) {
    // NOT `(err as Error).message`: that is the string "fetch failed" for every
    // transport failure there is, and this sentence is the only thing on the
    // Ingestion tab that says whether to fix the address, start the machine or
    // open the firewall. It is persisted too, as the cursor's `lastError`.
    return fail(describeFetchError(err));
  }

  if (!res.ok) {
    await drain(res);
    // 429 is obeyed, not fought: the next tick is the retry, and it is already
    // spaced. Saying the status is what lets someone tell a bad key (401) from
    // a quota (429) from an outage (5xx) without opening a log.
    return fail(`the source answered HTTP ${res.status}.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES));
  } catch (err) {
    return fail(
      err instanceof ResponseTooLarge
        ? err.message
        : `the response is not JSON (${(err as Error).message}).`,
    );
  }

  const { items, error: shapeError } = extractItems(body, src.itemsPath);
  if (shapeError) return fail(shapeError);

  const batch = items.slice(0, policy.pull.batchSize);
  const normalized: Record<string, unknown>[] = [];
  let unusable = 0;
  for (const item of batch) {
    const alert = normalize(mapping, item) as Record<string, unknown>;
    // No identity, no cursor contribution and no delivery. It is COUNTED and
    // shown: silently skipping items is how a source that changed its shape
    // looks like a source that went quiet.
    if (typeof alert.alert_id !== 'string' || alert.alert_id.trim() === '') { unusable += 1; continue; }
    normalized.push(alert);
  }

  // DELIVERED IN BOUNDED WAVES, and the cursor still only moves over a
  // CONSECUTIVE PREFIX of successes.
  //
  // Those two facts have to hold together. Running four at once means alert 7
  // can succeed while alert 3 fails, and taking "the newest thing that worked"
  // would then place the cursor past alert 3 — which nobody would ever fetch
  // again, with nothing on screen to say so. Taking the prefix instead costs a
  // re-read of 4..7 on the next poll, and dedup throws those away.
  //
  // `mapLimit` returns results in INPUT order, which is what makes the prefix
  // meaningful rather than an accident of who finished first.
  const results = await mapLimit(normalized, DELIVERY_CONCURRENCY, async (alert) => {
    try {
      await deps.deliver(src.source, alert);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });

  let accepted = 0;
  while (accepted < results.length && results[accepted] === null) accepted += 1;
  // The first failure in READING order is the one to report: it is the one
  // blocking the cursor, and therefore the one someone has to fix.
  const deliveryError = accepted < results.length ? results[accepted] : null;

  // A POLL THAT READ ALERTS AND PLACED NONE IS A FAILED POLL.
  //
  // Found by running it: with no database configured every delivery throws,
  // and the first version of this function still returned `error: null`. The
  // screen then showed a green check, "0 alerts collected, last answer 3 s
  // ago", over a source that was working perfectly and a pipeline that was
  // dropping everything it sent — a failure showing green, which is the exact
  // defect the Tracking tab exists to expose, rebuilt in the transport layer.
  //
  // The HTTP call succeeding is not the question the operator is asking.
  if (deliveryError !== null) {
    const detail = accepted === 0
      ? `read ${normalized.length} alert${normalized.length === 1 ? '' : 's'}, `
        + `delivered none: ${deliveryError}`
      : `delivered ${accepted} of ${normalized.length}, then stopped: ${deliveryError}`;
    // The cursor still advances over what WAS delivered: re-reading those costs
    // a dedup lookup, and stopping the cursor dead would re-read them forever.
    const partial = newestTimestamp(normalized.slice(0, accepted));
    const outcome = recordPoll(src.source, {
      since: partial, error: detail, received: accepted,
      backoffMs: backoffFor(cursor.failures + 1, intervalMs),
    });
    return {
      source: src.source, accepted, unusable, error: detail,
      since: outcome.since, nextAttemptAt: outcome.nextAttemptAt,
    };
  }

  const since = newestTimestamp(normalized.slice(0, accepted));
  const outcome = recordPoll(src.source, { since, error: null, received: accepted });
  return {
    source: src.source, accepted, unusable, error: null,
    since: outcome.since, nextAttemptAt: null,
  };
}

/**
 * The polling loop.
 *
 * Started and stopped by `runtime.ts`; one instance per process. It holds no
 * alert state of its own — everything durable is in the cursor file and in the
 * pipeline — so stopping it mid-tick costs at most one re-read of an overlap
 * window.
 */
export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private last: PollOutcome[] = [];
  /** The period the running timer was built with, so `sync` can leave it alone. */
  private periodMs = 0;

  // DECLARED THEN ASSIGNED, not a parameter property. `readonly getPolicy:`
  // in the constructor signature compiles under `tsc` and vitest and is
  // refused by `erasableSyntaxOnly` — and, in the VulnPipe half, breaks at
  // startup under `node --experimental-strip-types` where no test can see it.
  // That trap is in CLAUDE.md; this is the shape it asks for.
  private readonly getPolicy: () => IngestionPolicy;
  private readonly deps: PollerDeps;

  constructor(getPolicy: () => IngestionPolicy, deps: PollerDeps) {
    this.getPolicy = getPolicy;
    this.deps = deps;
  }

  /** The outcome of each source's most recent poll, for the Ingestion tab. */
  lastOutcomes(): PollOutcome[] { return [...this.last]; }

  running(): boolean { return this.timer !== null; }

  /**
   * Bring the timer in line with the policy. Idempotent, and called after
   * every settings save: enabling polling must not require a restart, for the
   * same reason a credential does not.
   *
   * ==========================================================================
   * IT DOES NOT POLL JUST BECAUSE IT WAS CALLED. THAT WAS A DEFECT.
   *
   * The first version tore the timer down and fired a poll on every call — and
   * `sync` is called after every save, on a screen whose fields saved on every
   * keystroke. Typing `120` into the interval field therefore made three real
   * requests to the source in under a second, and typing a URL made one per
   * character. A "retry storm" is exactly what the header of this file says it
   * refuses to build, and it had one wired into the settings form.
   *
   * Both halves were wrong and both are fixed: the interface now commits a
   * field when you leave it, and this restarts the timer ONLY when the period
   * actually changed. An immediate poll happens on a cold start — where it is
   * the honest response to "enable polling" — and never on a re-sync.
   * ==========================================================================
   */
  sync(): void {
    const policy = this.getPolicy();
    const wanted = policy.pull.enabled
      && policy.delivery !== 'push'
      && policy.pull.sources.some((s) => s.enabled);
    if (!wanted) { this.stop(); return; }

    const period = policy.pull.intervalSeconds * 1000;
    // Already running at this cadence: the source list or the batch size may
    // have changed, and `tick` reads both fresh every time. Nothing to do.
    if (this.timer && this.periodMs === period) return;

    const coldStart = this.timer === null;
    this.stop();
    this.periodMs = period;
    this.timer = setInterval(() => { void this.tick(); }, period);
    // `unref` so a poller never holds the process open: a console asked to
    // stop must stop, and a pending poll is worth at most one overlap window.
    this.timer.unref?.();
    if (coldStart) void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.periodMs = 0;
  }

  /**
   * One round over every enabled source. Exposed for the "poll now" button.
   *
   * `force` skips the failure backoff — that button is somebody asking, on
   * purpose, and making them wait out a backoff they can see on screen would
   * make the only diagnostic control on the page refuse to run.
   */
  async tick(opts: { force?: boolean } = {}): Promise<PollOutcome[]> {
    const policy = this.getPolicy();
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    const skipped: PollOutcome[] = [];

    const due = policy.pull.sources.filter((src) => {
      if (!src.enabled || this.inFlight.has(src.source)) return false;
      if (opts.force) return true;
      const { nextAttemptAt, lastError, since } = readCursor(src.source);
      if (!nextAttemptAt || Date.parse(nextAttemptAt) <= now) return true;
      // BACKED OFF, AND IT SAYS SO. A source quietly missing from the results
      // reads as a source nobody is watching; the row keeps its error and
      // gains the time of the next attempt.
      skipped.push({
        source: src.source, accepted: 0, unusable: 0,
        error: lastError, since, nextAttemptAt,
      });
      return false;
    });

    // BOUNDED, not `Promise.all` over everything. See `SOURCE_CONCURRENCY`.
    const polled = await mapLimit(due, SOURCE_CONCURRENCY, async (src) => {
      this.inFlight.add(src.source);
      try {
        return await pollSource(src, policy, this.deps);
      } finally {
        this.inFlight.delete(src.source);
      }
    });
    const outcomes = [...polled, ...skipped];
    // Merge rather than replace: a source skipped because it was still in
    // flight keeps the result it last produced, instead of disappearing from
    // the screen for a tick.
    const merged = new Map(this.last.map((o) => [o.source, o]));
    for (const o of outcomes) merged.set(o.source, o);
    this.last = [...merged.values()];
    return outcomes;
  }
}
