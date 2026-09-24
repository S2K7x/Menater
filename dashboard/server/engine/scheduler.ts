/**
 * The clock behind « no answer within 30 minutes and the alert is escalated ».
 *
 * ============================================================================
 * THE PROMISE WAS WRITTEN, AND NOTHING KEPT IT
 *
 * `Engine.sweepExpiredWaits()` is the code that turns an unanswered approval
 * into an escalation, and it works — `engine.test.ts` drives it, the `timeout`
 * port is wired to `escalate-timeout` in `04-Action-Routing`, and the schema
 * even carries the partial index the sweep query needs
 * (`soc_run_wait_pending_idx`). Its only callers were the tests. There was no
 * scheduler in this process at all: `setInterval` appeared in `ingest/poller.ts`
 * for polling and in `auth.ts` for sessions, and nowhere else.
 *
 * So an approval request said, in the message posted to a human, that silence
 * for thirty minutes would escalate the alert — and silence did nothing. The
 * run stayed `waiting` for ever. *Silence is never consent* held, in that no
 * action was executed; the escalation meant to replace it never happened, and
 * because `awaiting` short-circuits the verdict ladder in `cases.ts` the chain
 * never became `stalled` either. An alert nobody answered was therefore
 * invisible on the one tab built to show what the queue hides.
 *
 * ============================================================================
 * WHAT THIS FILE IS CAREFUL ABOUT
 *
 *   - It reads `getEngine()` on EVERY tick, never once at boot. Configuring a
 *     database in Settings mounts the engine with no restart, and the sweep has
 *     to start with it — the same rule `syncPoller` follows after a save. No
 *     engine is a normal state, not an error: it is one `null` check.
 *
 *   - Nothing escapes the timer. `setInterval(() => void this.tick())` with an
 *     uncaught rejection inside TERMINATES a Node 22 process — the trap this
 *     repository already paid for on `pollSource`. `tick()` therefore resolves
 *     with what happened and rejects for nothing.
 *
 *   - Sweeps do not pile up. One in flight at a time, like the poller: a sweep
 *     slower than its period means less frequent sweeps, which is the honest
 *     consequence, where accumulating them drives the same run twice.
 *
 *   - A failure is SAID, with its cause, and said once. The cause survives
 *     because `PgRunStore.q()` describes every query failure at a single choke
 *     point — `pg` reports an `ECONNREFUSED` with an EMPTY message, and that
 *     is where it is recovered, so nothing has to describe it twice. A
 *     database that is refusing fails
 *     every sixty seconds for as long as it is down, and a line per minute
 *     repeating one sentence is the permanent alarm this console refuses
 *     everywhere else. Consecutive identical messages are reported once, and
 *     the recovery is reported too — otherwise the silence that follows reads
 *     the same as the silence before.
 * ============================================================================
 */

import { errorText, type Engine } from './engine.ts';

/**
 * How often the deadlines are looked at.
 *
 * It bounds how LATE an escalation can be, not how long the wait is: the
 * deadline itself is `approval.timeoutMinutes`, editable in Settings and 30
 * minutes by default. One minute of lateness on thirty is worth one indexed
 * query a minute — `soc_run_wait_pending_idx` covers it exactly.
 */
export const SWEEP_INTERVAL_MS = 60_000;

export interface SchedulerDeps {
  /** Read fresh on every tick: the engine can be mounted after boot. */
  engine: () => Engine | null;
  /** Where an escalation or a failure is announced. Injected for the tests. */
  report?: (line: string) => void;
  reportError?: (line: string) => void;
}

/** Drives `sweepExpiredWaits` on a timer. One per process. */
export class WaitScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** The last failure announced, so the same sentence is not repeated. */
  private lastError: string | null = null;

  // DECLARED THEN ASSIGNED, not a parameter property: the server runs under
  // `--experimental-strip-types` / `erasableSyntaxOnly`, which refuses that
  // syntax. See CLAUDE.md.
  private readonly deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  running(): boolean { return this.timer !== null; }

  /** Idempotent: calling it twice does not give you two timers. */
  start(periodMs: number = SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, periodMs);
    // `unref` so the sweep never holds the process open. A console asked to
    // stop must stop; a deadline missed by one restart is swept at the next.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Resolves with the runs escalated; never rejects.
   *
   * Also exported for the tests, which must not wait out a real minute — a
   * test that sleeps is a test people learn to ignore.
   */
  async tick(): Promise<string[]> {
    if (this.inFlight) return [];
    this.inFlight = true;
    try {
      const engine = this.deps.engine();
      if (!engine) return [];

      const { resumed, failed } = await engine.sweepExpiredWaits();
      if (resumed.length > 0) {
        this.deps.report?.(
          `${resumed.length} approval${resumed.length > 1 ? 's' : ''} timed out and `
          + `escalated: ${resumed.join(', ')}`,
        );
      }
      for (const f of failed) this.announceError(`run ${f.runId} — ${f.error}`);
      if (failed.length === 0) this.announceRecovery();
      return resumed;
    } catch (err) {
      // Reading the deadlines is itself a database call: an unreachable
      // database lands here, and it must not take the process with it.
      this.announceError(errorText(err));
      return [];
    } finally {
      this.inFlight = false;
    }
  }

  private announceError(message: string): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.deps.reportError?.(`approval sweep failed — ${message}`);
  }

  private announceRecovery(): void {
    if (this.lastError === null) return;
    this.lastError = null;
    this.deps.report?.('approval sweep is answering again');
  }
}

let scheduler: WaitScheduler | null = null;

/**
 * The process's scheduler, built on first use.
 *
 * It is started unconditionally at boot, database or not: the tick asks for
 * the engine rather than being handed one, so an install that configures its
 * database from the Settings tab starts honouring its approval deadlines
 * without a restart. With no engine the whole tick is one `null` check.
 */
export function getWaitScheduler(engine: () => Engine | null): WaitScheduler {
  if (!scheduler) {
    scheduler = new WaitScheduler({
      engine,
      report: (line) => console.log(`[menater] ${line}`),
      reportError: (line) => console.error(`[menater] ${line}`),
    });
  }
  return scheduler;
}

export function stopWaitScheduler(): void {
  scheduler?.stop();
}
