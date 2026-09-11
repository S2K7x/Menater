/**
 * The snapshot cache, and the one thing it must never do.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `snapshot.ts` is the console's central read path — the triage queue, the
 * metrics and the Tracking tab are all one cached object — and it had no test
 * at all. Its cache is four constants and twenty lines, and the traps table
 * already records what those twenty lines get wrong when they are written
 * carelessly: *"Invalidating `cache` without `inFlight`: a traversal that
 * started before a write finishes after it, and reinstalls the pre-approval
 * state in the cache."*
 *
 * That fix was made — `invalidate()` throws away both references. It was not
 * enough, and this file is the proof: throwing away the REFERENCE does not stop
 * the disowned rebuild, which is still running, from writing its result into
 * the cache when it lands, with a brand-new timestamp on top of it.
 * ============================================================================
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord, StepRecord } from './engine/types.ts';

/** The run journal the console reads, under test control. */
let runs: RunRecord[] = [];
/** Held open to keep a rebuild in flight for as long as a test needs. */
let gate: { promise: Promise<void>; open: () => void } | null = null;
let reads = 0;

const deferred = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { promise, open };
};

const store = {
  async recentRuns(): Promise<RunRecord[]> {
    reads += 1;
    // What the journal held WHEN IT WAS ASKED, not when it got round to
    // answering. That is the whole shape of the defect: a slow answer to an
    // early question, arriving after a write it knows nothing about.
    const answer = runs;
    if (gate) await gate.promise;
    return answer;
  },
  async stepsOfMany(ids: string[]): Promise<Map<string, StepRecord[]>> {
    return new Map(ids.map((id) => [id, steps.get(id) ?? []]));
  },
};

const steps = new Map<string, StepRecord[]>();

vi.mock('./runtime.ts', () => ({
  getEngineStore: () => store,
}));

vi.mock('./config.ts', () => ({
  connectionString: () => 'postgres://test/menater',
  getConfig: () => ({
    database: { host: 'db.test', port: 5432, database: 'menater' },
    console: { refreshSeconds: 20, executionWindow: 120, forceDemo: false },
    inventory: { entries: [] },
  }),
}));

const { invalidate, snapshot } = await import('./snapshot.ts');
const { DEFAULT_LOCALE } = await import('./i18n.ts');

/**
 * One ingestion run for an alert. Enough for `buildCases` to produce a case —
 * the point here is which SET of runs a snapshot was built from, never what a
 * case contains.
 */
function run(alertId: string): RunRecord {
  return {
    id: `run-${alertId}`,
    workflowId: '01-ingestion',
    workflowVersion: 1,
    status: 'done',
    alertId,
    input: { alert_id: alertId, rule_name: 'r', severity: 'high', raw_log: 'l' },
    startedAt: '2026-09-11T10:00:00.000Z',
    endedAt: '2026-09-11T10:00:01.000Z',
    error: null,
  };
}

const ids = (snap: { cases: { alert_id: string }[] }) => snap.cases.map((c) => c.alert_id).sort();

beforeEach(() => {
  invalidate();
  gate = null;
  reads = 0;
  runs = [];
  steps.clear();
});

describe('a rebuild that invalidate() disowned', () => {
  /**
   * THE DEFECT. The queue is rebuilt in the background while an operator
   * answers an approval. The write lands, `invalidate()` runs — and then the
   * rebuild that had already read the database finishes and puts what it read
   * BEFORE the write back into the cache, stamped `Date.now()`. The cache is
   * fifteen seconds long, so the console goes on showing the pre-approval queue
   * for up to fifteen seconds after the operator was told the approval was
   * sent, and nothing anywhere says so.
   */
  it('does not put what it read before the write back into the cache', async () => {
    runs = [run('BEFORE')];
    gate = deferred();

    // A background rebuild, started before the write: it has asked the database
    // and is waiting for the answer.
    const inFlight = snapshot(DEFAULT_LOCALE);

    // The write lands. This is `POST /api/approvals/:token/resume`.
    runs = [run('BEFORE'), run('AFTER')];
    invalidate();

    // Only now does the pre-write read come back.
    gate.open();
    expect(ids(await inFlight)).toEqual(['BEFORE']);

    // The next poll must see the alert the write added. Before the fix it saw
    // the disowned rebuild's answer, served from a cache it had no right to
    // install itself in.
    gate = null;
    expect(ids(await snapshot(DEFAULT_LOCALE))).toEqual(['AFTER', 'BEFORE']);
  });

  /**
   * The same defect, stated as the operator meets it: `force` is the "Refresh"
   * button and the injection follow-up, and its whole contract is that it does
   * not answer from the cache. A disowned rebuild installing a fresh timestamp
   * is invisible to that promise — `force` rebuilds, so it was never the path
   * that broke — but the periodic poll behind it is the one the operator is
   * actually watching.
   */
  it('leaves the cache empty, so the next read goes back to the journal', async () => {
    runs = [run('BEFORE')];
    gate = deferred();
    const inFlight = snapshot(DEFAULT_LOCALE);
    invalidate();
    gate.open();
    await inFlight;

    const before = reads;
    gate = null;
    await snapshot(DEFAULT_LOCALE);
    expect(reads, 'the journal was not re-read').toBe(before + 1);
  });
});

describe('what the cache is for, and must go on doing', () => {
  /**
   * The reason `inFlight` exists at all. Ten tabs on a triage desk is the
   * normal state, and ten full walks of the run journal in parallel is what
   * this shares away. A fix for the defect above that also broke this would
   * have traded a fifteen-second lie for a tenfold read.
   */
  it('shares one walk of the journal between concurrent callers', async () => {
    runs = [run('A')];
    gate = deferred();

    const all = Promise.all([
      snapshot(DEFAULT_LOCALE), snapshot(DEFAULT_LOCALE), snapshot(DEFAULT_LOCALE),
    ]);
    gate.open();
    const [a, b, c] = await all;

    expect(reads).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('serves a fresh snapshot from memory rather than re-reading', async () => {
    runs = [run('A')];
    await snapshot(DEFAULT_LOCALE);
    await snapshot(DEFAULT_LOCALE);
    expect(reads).toBe(1);
  });

  /**
   * A rebuild nothing disowned is the ordinary case, and it MUST publish: a
   * cache that never fills is the tenfold read above, arrived at from the other
   * side.
   */
  it('publishes the result of a rebuild that was never invalidated', async () => {
    runs = [run('A')];
    await snapshot(DEFAULT_LOCALE);
    runs = [run('A'), run('B')];
    // No `invalidate()`: the cache is still fresh and is allowed to answer.
    expect(ids(await snapshot(DEFAULT_LOCALE))).toEqual(['A']);
    expect(reads).toBe(1);
  });

  /**
   * WHAT BOUNDS THE COST OF REFUSING TO PUBLISH.
   *
   * Never publishing a disowned rebuild means that writes arriving faster than
   * a rebuild completes would leave the cache permanently empty, and every poll
   * would walk the journal again. That is acceptable only because the OTHER
   * half of this cache still holds in that regime: concurrent callers share one
   * walk. Ten tabs on a triage desk is the load this protects against, and it
   * is unchanged by an invalidation — so the worst case is one rebuild per poll
   * cycle, never one per tab.
   */
  it('still shares one walk between concurrent callers after an invalidation', async () => {
    runs = [run('A')];
    await snapshot(DEFAULT_LOCALE);
    invalidate();

    gate = deferred();
    const before = reads;
    const all = Promise.all([
      snapshot(DEFAULT_LOCALE), snapshot(DEFAULT_LOCALE), snapshot(DEFAULT_LOCALE),
    ]);
    gate.open();
    await all;

    expect(reads).toBe(before + 1);
  });

  it('force asks the journal again even with a fresh cache', async () => {
    runs = [run('A')];
    await snapshot(DEFAULT_LOCALE);
    runs = [run('A'), run('B')];
    expect(ids(await snapshot(DEFAULT_LOCALE, true))).toEqual(['A', 'B']);
    expect(reads).toBe(2);
  });
});
