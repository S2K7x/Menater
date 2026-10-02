/**
 * What the Postgres store asks the database FOR, when a reader narrows a window.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, AND WHY A DOUBLE IS THE RIGHT INSTRUMENT HERE
 *
 * `store-contract.test.ts` runs one suite against both stores and claims the
 * BEHAVIOUR of the input projection — a run outside the predicate carries
 * `INPUT_NOT_READ`, one inside it carries its payload, and a payload that is
 * really `null` stays `null`. Its Postgres half runs against a real server.
 *
 * That suite cannot see the saving. `PgRunStore.recentRuns` sets the sentinel in
 * JavaScript, AFTER the rows are in hand, so a version that went on selecting
 * every column would satisfy every one of those assertions while fetching,
 * sending and parsing the whole `input` column exactly as before. Measured by
 * mutation: putting `SELECT *` back fails NOTHING in the suite — and `SELECT *`
 * is the entire defect this change exists to remove.
 *
 * So what is claimed here is the WORK the database is asked to do, counted as
 * the number of `input` values that crossed the pool — not a SQL string, which
 * would fail on a reformatting, and not milliseconds, which is the flaky kind of
 * assertion this project has already removed once. A pool double can observe
 * that faithfully, because what it is standing in for is the wire.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { PgRunStore } from './pg-store.ts';
import { CASE_INPUTS } from './cases.ts';
import { INPUT_NOT_READ } from './types.ts';
import type { Pool } from 'pg';

/** The five runs one alert produces, plus an orphan with no `alert_id`. */
const TABLE = [
  { id: 'r1', workflow_id: '01-ingestion', alert_id: 'A-1', input: { alert_id: 'A-1', raw_log: 'L' } },
  { id: 'r2', workflow_id: '02-enrichment', alert_id: 'A-1', input: { alert_id: 'A-1', raw_log: 'L' } },
  { id: 'r3', workflow_id: '03-ai-decision', alert_id: 'A-1', input: { alert_id: 'A-1', raw_log: 'L' } },
  { id: 'r4', workflow_id: '04-action-routing', alert_id: 'A-1', input: { alert_id: 'A-1', raw_log: 'L' } },
  { id: 'r5', workflow_id: '05-audit-log', alert_id: 'A-1', input: { alert_id: 'A-1', raw_log: 'L' } },
  { id: 'r6', workflow_id: '01-ingestion', alert_id: null, input: { diagnostic_probe: true } },
];

/**
 * A pool that answers like Postgres about ONE thing: it hands back the columns
 * the query named, and nothing else. That is the only property this file reads,
 * and it is the one `SELECT *` breaks.
 */
function recordingPool() {
  /** Every `input` value that crossed the pool, per query. */
  const inputsSent: number[] = [];
  const idsAsked: string[][] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const named = /SELECT\s+(.*?)\s+FROM/is.exec(sql)?.[1] ?? '';
      const wantsInput = named.includes('*') || /\binput\b/.test(named);
      const only = /ANY\(\$1::text\[\]\)/.test(sql) ? (params[0] as string[]) : null;
      if (only) idsAsked.push(only);
      const rows = TABLE
        .filter((r) => only === null || only.includes(r.id))
        .map((r) => ({
          id: r.id,
          workflow_id: r.workflow_id,
          workflow_version: 1,
          status: 'done',
          alert_id: r.alert_id,
          started_at: new Date('2026-09-04T10:00:00Z'),
          ended_at: new Date('2026-09-04T10:00:01Z'),
          error: null,
          ...(wantsInput ? { input: r.input } : {}),
        }));
      inputsSent.push(rows.filter((r) => 'input' in r).length);
      return { rows };
    },
  };
  return { store: new PgRunStore(pool as unknown as Pool), inputsSent, idsAsked };
}

describe('a window the reader narrowed', () => {
  it('does not pull the input of a run nobody opens', async () => {
    // THE SAVING, counted. Four of the five runs an alert produces carry the
    // alert again as their sub-workflow payload, and `cases.ts` opens none of
    // them. Measured on a real Postgres over a seeded window: 895,641 bytes of
    // input in the table against 99,049 read.
    const { store, inputsSent } = recordingPool();
    const runs = await store.recentRuns({ limit: 10, inputOf: CASE_INPUTS });
    expect(runs).toHaveLength(6);
    // The window's own query carries no input at all…
    expect(inputsSent[0], 'the window query is still pulling the input column').toBe(0);
    // …and the second one carries exactly the two the reader opens: the run
    // that entered through `01-ingestion`, and the one with no `alert_id`.
    expect(inputsSent[1]).toBe(2);
    expect(inputsSent).toHaveLength(2);
  });

  it('asks the second query for exactly the run ids the predicate selected', async () => {
    const { store, idsAsked } = recordingPool();
    await store.recentRuns({ limit: 10, inputOf: CASE_INPUTS });
    expect(idsAsked).toEqual([['r1', 'r6']]);
  });

  it('spends no second round trip when the reader opens nothing', async () => {
    // The boundary. A caller that reads no input at all — `inputOf: () => false`
    // — must not buy a query to fetch nothing.
    const { store, inputsSent, idsAsked } = recordingPool();
    const runs = await store.recentRuns({ limit: 10, inputOf: () => false });
    expect(inputsSent).toEqual([0]);
    expect(idsAsked).toEqual([]);
    for (const r of runs) expect(r.input).toBe(INPUT_NOT_READ);
  });

  it('pulls every input, in ONE query, when no predicate is given', async () => {
    // The other boundary, and the one a resume depends on: omitting the option
    // asks for the whole journal, which is what a reader of it must get.
    const { store, inputsSent } = recordingPool();
    const runs = await store.recentRuns({ limit: 10 });
    expect(inputsSent).toEqual([6]);
    expect(runs[0].input).toEqual({ alert_id: 'A-1', raw_log: 'L' });
  });
});
