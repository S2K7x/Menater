/**
 * Where a poller left off, per source.
 *
 * ============================================================================
 * WHY THIS IS NOT IN `config.json`
 *
 * A cursor is not a setting. It is operational state the process WRITES on its
 * own, several times a minute, and settings are what a human edits. Mixing the
 * two means every poll rewrites a file that also holds the console password
 * and the ingestion secret — a lot of chances for a truncated write to cost
 * something that matters.
 *
 * It is not in Postgres either, and that is deliberate: the poller must work
 * on an install that has no database configured yet, which is exactly the
 * install most likely to be trying its first source.
 *
 * ============================================================================
 * THE ONE RULE THIS FILE ENFORCES
 *
 * AN EMPTY OR FAILED POLL DOES NOT ADVANCE THE CHECKPOINT.
 *
 * It reads as an optimisation to move the cursor to "now" after every poll —
 * fewer overlaps, less to re-read. It is a data-loss bug: a poll that returned
 * nothing because the source was down, or slow, or rate-limiting us, is
 * indistinguishable from a poll that returned nothing because nothing
 * happened. Advancing on the first case skips whatever the source was holding.
 * `recordPoll` is only ever handed a `since` taken from an alert we actually
 * DELIVERED.
 *
 * ============================================================================
 * THE WRITE IS DEBOUNCED, AND IT IS NOT `fsync`ed
 *
 * It used to be a `writeFileSync` on every poll of every source. That is
 * synchronous I/O on the event loop, on a timer, for the life of the process —
 * the console's own request handling paying for a background transport.
 *
 * The question CLAUDE.md asks per line is what a power cut in the next few
 * milliseconds would actually cost. Here: one overlap window re-read, which
 * deduplication absorbs. That is an intention, not money. So: debounced,
 * asynchronous, no `fsync` — and an UNCONDITIONAL flush at shutdown, because
 * a flush that trusts a `dirty` flag loses precisely the last poll.
 * ============================================================================
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CONFIG_PATH } from '../config.ts';

/** Next to `config.json`, so a volume that persists one persists the other. */
export const CURSOR_PATH = process.env.MENATER_CURSORS
  || join(dirname(CONFIG_PATH), 'ingest-cursors.json');

export interface Cursor {
  /** ISO-8601. `null` means "never polled": the first poll asks for the window. */
  since: string | null;
  /** When we last got an answer at all — success or empty, not failure. */
  lastPollAt: string | null;
  lastError: string | null;
  /** Alerts accepted from this source since the file was created. */
  received: number;
  /**
   * Consecutive failed polls. Reset to 0 by any poll that got an answer.
   *
   * This is what makes the backoff in `poller.ts` possible, and it is the only
   * reason it is persisted: a console restarted in a loop against a dead
   * endpoint would otherwise restart at full rate every time.
   */
  failures: number;
  /**
   * ISO-8601, or `null`. Before this instant the poller SKIPS this source.
   *
   * Held here rather than computed from `failures` alone so that the interface
   * can say *when* — a source silently skipped is the failure showing green
   * that this whole module is written against.
   */
  nextAttemptAt: string | null;
}

type Store = Record<string, Cursor>;

const EMPTY: Cursor = {
  since: null, lastPollAt: null, lastError: null,
  received: 0, failures: 0, nextAttemptAt: null,
};

let cache: Store | null = null;

/** Pending debounced write, and the timer that will run it. */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> | null = null;

/**
 * How long a burst of polls is allowed to coalesce into one write.
 *
 * Shorter than any legal polling interval (15 s), so a steady poller still
 * writes once per poll; long enough that a "poll now" over eight sources is
 * one write rather than eight.
 */
const WRITE_DEBOUNCE_MS = 500;

function load(): Store {
  if (cache) return cache;
  cache = {};
  if (existsSync(CURSOR_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CURSOR_PATH, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') cache = parsed as Store;
    } catch {
      // A corrupt cursor file must not stop ingestion. Losing the cursor costs
      // one overlap window of re-reading, which dedup absorbs; refusing to
      // start costs every alert from here on.
      console.error(`[menater] ${CURSOR_PATH} unreadable — polling restarts from the current window.`);
    }
  }
  return cache;
}

/** The actual write. Never throws: a cursor we could not save is not fatal. */
async function writeNow(): Promise<void> {
  const store = cache;
  if (!store) return;
  try {
    mkdirSync(dirname(CURSOR_PATH), { recursive: true });
    await writeFile(CURSOR_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
    chmodSync(CURSOR_PATH, 0o600);
  } catch (err) {
    // Not fatal, and not silent: a cursor that cannot be written means the
    // next restart re-reads a window. Say it rather than pretend it happened.
    console.error(`[menater] cursor not saved (${(err as Error).message})`);
  }
}

function schedulePersist(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writing = writeNow();
  }, WRITE_DEBOUNCE_MS);
  // A pending cursor write must never hold the process open: it is worth one
  // overlap window, and `flushCursors` is what makes an orderly exit correct.
  writeTimer.unref?.();
}

export function readCursor(source: string): Cursor {
  return { ...EMPTY, ...load()[source] };
}

export function allCursors(): Record<string, Cursor> {
  const store = load();
  return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { ...EMPTY, ...v }]));
}

/**
 * Record the outcome of a poll, and decide when this source may be tried next.
 *
 * `since` is only written when the caller passes one, and the caller only
 * passes one when it read it off an alert it delivered. See the header.
 */
export function recordPoll(
  source: string,
  outcome: {
    since?: string | null;
    error: string | null;
    received: number;
    /** Milliseconds to wait before the next attempt. Ignored on success. */
    backoffMs?: number;
  },
): Cursor {
  const store = load();
  const before = { ...EMPTY, ...store[source] };
  const failed = outcome.error !== null;
  const next: Cursor = {
    since: outcome.since ?? before.since,
    // A FAILED poll does not count as having heard from the source. Otherwise
    // "last answer: 3 s ago" sits reassuringly next to an endpoint that has
    // been refusing us for an hour.
    lastPollAt: failed ? before.lastPollAt : new Date().toISOString(),
    lastError: outcome.error,
    received: before.received + outcome.received,
    failures: failed ? before.failures + 1 : 0,
    // ANY answer clears the backoff, including one that delivered nothing:
    // the source is talking to us again, and continuing to skip it would be
    // punishing it for a fault it has already recovered from.
    nextAttemptAt: failed && outcome.backoffMs
      ? new Date(Date.now() + outcome.backoffMs).toISOString()
      : null,
  };
  store[source] = next;
  schedulePersist();
  return next;
}

/** Forget a source's cursor — the next poll re-reads its window. */
export function forgetCursor(source: string): void {
  const store = load();
  delete store[source];
  schedulePersist();
}

/**
 * Write whatever is pending, now. Called on shutdown.
 *
 * UNCONDITIONAL: it does not consult a `dirty` flag. A shutdown flush that
 * trusts bookkeeping kept somewhere else loses exactly the last poll — the one
 * that just happened — and a test is the only thing that ever catches it.
 */
export async function flushCursors(): Promise<void> {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  await writing;
  await writeNow();
}

/** Tests only: drop the in-process copy so a fresh file is read. */
export function resetCursorCache(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  cache = null;
  writing = null;
}
