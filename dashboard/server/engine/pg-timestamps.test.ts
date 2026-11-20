/**
 * How the Postgres store asks for the timestamps it answers with.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `soc_run.started_at` is a `timestamptz`. Postgres sends it as TEXT —
 * `2026-11-20 04:08:20.249+00`, probed on PostgreSQL 16.15 — `pg` hands that
 * text to `postgres-date`, which parses it into a `Date`, and `iso()` then
 * calls `toISOString()` to produce the string this store's records carry and
 * this console answers with. The `Date` in the middle is never read by
 * anything: every timestamp in `pg-store.ts` goes through `iso()`, and no
 * consumer of a `RunRecord`, `StepRecord` or `WaitRecord` wants a date object.
 *
 * Per value that round trip is 0.861 us against 0.076 us for slicing the text
 * straight into the ISO form — nothing, and the multiplier is the defect: the
 * snapshot rebuild reads two timestamps per step row, and a 500-run window is
 * 4,078 of them.
 *
 * ============================================================================
 * WHAT IS CLAIMED HERE, AND WHY IT IS NOT THE VALUE
 *
 * The answer does not change — that is the whole point of the change, and it
 * is also why no assertion about a `RunRecord`'s field can see it: with pg's
 * own parser the text becomes a `Date` and `iso()` formats it; with ours the
 * text becomes the same string directly. Both spell
 * `2026-11-20T04:08:20.249Z`. So a test that reads `startedAt` passes before
 * and after, exactly as `pg-projection.test.ts` records for the input
 * projection.
 *
 * What is claimed is therefore the WORK: how many `Date` objects the store
 * made the driver build. A pool double can observe that faithfully, because
 * what it stands in for is the wire — and the second half, that the fast path
 * is not silently dead, is claimed on the converter itself.
 * ============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { types as pgTypes } from 'pg';

import { PgRunStore, isoIfUtcText, ISO_TIMESTAMPS } from './pg-store.ts';
import type { Pool } from 'pg';

/** OIDs: `timestamptz` and `timestamp`. */
const TIMESTAMPTZ = 1184;
const TIMESTAMP = 1114;

/**
 * Every text form this PostgreSQL emitted for a `timestamptz`, probed on 16.15
 * rather than assumed, plus the awkward ones a server configured in another
 * timezone or holding an ancient date would send.
 *
 * The last four rows are what decides that the fallback has to be pg's own
 * parser: they are the forms the fast path declines, and `new Date` THROWS on
 * three of them and silently answers **2044** for the fourth. A throw there
 * comes out of the query, so one such row would take down a read of the
 * journal. Found by mutation — without them, swapping the fallback for `new
 * Date(text).toISOString()` passed everything.
 */
const FORMS = [
  '2026-11-20 04:08:20.249+00',    // the ordinary one, milliseconds
  '2026-11-20 04:08:20+00',        // no fractional part at all
  '2026-11-20 04:08:20.2+00',      // one digit — Postgres trims trailing zeros
  '2026-11-20 04:08:20.05+00',     // two
  '2026-11-20 04:08:20.249123+00', // microseconds, truncated to milliseconds
  '2026-11-20 04:08:20.000001+00', // microseconds that round to nothing
  '1999-12-31 23:59:59.999+00',
  '0044-03-15 10:00:00+00',        // a four-digit year under 100
  '10000-01-01 00:00:00+00',       // five digits: ISO expands the year
  '2026-11-20 05:08:20.249+01',    // a server whose timezone is not UTC
  '2026-11-20 00:08:20.249-04',
  '2026-06-01 12:00:00+05:30',     // an offset with minutes
  'infinity',                      // pg answers the NUMBER Infinity
  '-infinity',
  '0044-03-15 10:00:00+00 BC',     // before Christ: pg expands to -000043
  '0044-03-15 10:00:00+01',        // a year under 100 the fast path declines
];

/** What the driver does today: text -> `Date` -> `toISOString()`. */
const viaPg = (text: string): string | null => {
  const d = (pgTypes.getTypeParser(TIMESTAMPTZ, 'text') as (v: string) => unknown)(text);
  return d instanceof Date ? d.toISOString() : d === null || d === undefined ? null : String(d);
};

describe('the ISO timestamp converter', () => {
  it('answers exactly what pg’s own parser answers, on every form this server emits', () => {
    // BYTE-IDENTICAL OR IT IS NOT AN OPTIMISATION. A difference here is a
    // changed API answer, on the field the queue sorts and the card prints.
    for (const text of FORMS) {
      const parse = ISO_TIMESTAMPS.getTypeParser(TIMESTAMPTZ, 'text') as (v: string) => unknown;
      expect(parse(text), `disagreed on ${text}`).toBe(viaPg(text));
    }
  });

  it('reads the UTC form itself, and declines every other one', () => {
    // THE FAST PATH IS NOT DEAD, and this is the only thing that says so: the
    // test above passes just as well over a converter that delegates
    // everything, which is the whole saving thrown away in silence.
    expect(isoIfUtcText('2026-11-20 04:08:20.249+00')).toBe('2026-11-20T04:08:20.249Z');
    expect(isoIfUtcText('2026-11-20 04:08:20+00')).toBe('2026-11-20T04:08:20.000Z');
    expect(isoIfUtcText('0044-03-15 10:00:00+00')).toBe('0044-03-15T10:00:00.000Z');

    // `null` means "not a shape I can read", never "no timestamp": a SQL NULL
    // never reaches a type parser at all (probed — the row value is `null` and
    // the parser is not called).
    expect(isoIfUtcText('2026-11-20 05:08:20.249+01')).toBeNull();   // another offset
    expect(isoIfUtcText('2026-06-01 12:00:00+05:30')).toBeNull();    // minutes in the offset
    expect(isoIfUtcText('10000-01-01 00:00:00+00')).toBeNull();      // five-digit year
    expect(isoIfUtcText('0044-03-15 10:00:00+00 BC')).toBeNull();    // before Christ
    expect(isoIfUtcText('infinity')).toBeNull();
  });

  it('leaves every other type, the binary format and `timestamp`, to pg', () => {
    // The object is handed to EVERY column of the query, so anything it does
    // not own it must hand back unchanged — the binary form of the one type it
    // does own included, which this converter cannot read.
    expect(ISO_TIMESTAMPS.getTypeParser(23, 'text')).toBe(pgTypes.getTypeParser(23, 'text'));
    expect(ISO_TIMESTAMPS.getTypeParser(TIMESTAMPTZ, 'binary'))
      .toBe(pgTypes.getTypeParser(TIMESTAMPTZ, 'binary'));
    // `timestamp without time zone` is NOT claimed, and that is the decision:
    // every timestamp column in `sql/` is `timestamptz`, its text carries no
    // offset so the fast path could never read one, and a branch for a state
    // this schema cannot produce is the dead code that looks load-bearing.
    expect(ISO_TIMESTAMPS.getTypeParser(TIMESTAMP, 'text'))
      .toBe(pgTypes.getTypeParser(TIMESTAMP, 'text'));
  });
});

/**
 * A pool that answers like Postgres about ONE thing: timestamp columns arrive
 * as the text the server sends, run through whatever type parser the query
 * asked for — pg's own when it asked for none, which is what builds a `Date`.
 *
 * `datesBuilt` is the work being counted.
 *
 * IT HONOURS THE QUERY'S `types` AND NOT A POOL-LEVEL ONE, deliberately. pg
 * accepts both, and registering them on the pool would save this store the
 * same work — while also changing what the three other readers of that one
 * pool receive. So the two are not the same change, and the one this double
 * cannot see is the one `the scope of the converter` below speaks to.
 */
function timingPool() {
  let datesBuilt = 0;
  const parserFor = (types: { getTypeParser(oid: number, format?: unknown): unknown } | undefined) => {
    const get = types?.getTypeParser.bind(types) ?? pgTypes.getTypeParser;
    const parse = get(TIMESTAMPTZ, 'text') as (v: string) => unknown;
    return (text: string) => {
      const value = parse(text);
      if (value instanceof Date) datesBuilt++;
      return value;
    };
  };

  const pool = {
    async query(config: any, legacyValues?: unknown[]) {
      // pg accepts both shapes; the store uses one of them, and the double
      // must not be the thing that decides which.
      const sql: string = typeof config === 'string' ? config : config.text;
      const values: unknown[] = (typeof config === 'string' ? legacyValues : config.values) ?? [];
      const ts = parserFor(typeof config === 'string' ? undefined : config.types);

      if (/FROM soc_run_step/i.test(sql)) {
        const ids = (values[0] as string[]) ?? [];
        return {
          rows: ids.flatMap((runId) => ['validate', 'to-02'].map((nodeId) => ({
            run_id: runId,
            node_id: nodeId,
            attempt: 1,
            status: 'ok',
            output: null,
            port: null,
            error: null,
            started_at: ts('2026-11-20 04:08:20.249+00'),
            ended_at: ts('2026-11-20 04:08:20.312+00'),
          }))),
        };
      }
      return {
        rows: [{
          id: 'r1',
          workflow_id: '01-ingestion',
          workflow_version: 1,
          status: 'done',
          alert_id: 'A-1',
          input: { alert_id: 'A-1' },
          started_at: ts('2026-11-20 04:08:20.249+00'),
          ended_at: ts('2026-11-20 04:08:20.312+00'),
          error: null,
        }],
      };
    },
  };
  return { store: new PgRunStore(pool as unknown as Pool), dates: () => datesBuilt };
}

describe('what the store asks the driver to build', () => {
  it('reads a window of runs without building one Date', async () => {
    const { store, dates } = timingPool();
    const runs = await store.recentRuns({ limit: 10 });
    // The answer is unchanged — that is what makes this an optimisation…
    expect(runs[0].startedAt).toBe('2026-11-20T04:08:20.249Z');
    expect(runs[0].endedAt).toBe('2026-11-20T04:08:20.312Z');
    // …and this is the saving, which no assertion on the answer can see.
    expect(dates(), 'the store is still making the driver parse text into Date objects').toBe(0);
  });

  it('reads every step of a window without building one Date', async () => {
    // THE ONE THAT PAYS. Two timestamps per step row, and a 500-run window
    // holds 4,078 of them: measured against a real PostgreSQL 16.15,
    // `stepsOfMany` is 31.77 ms with pg's parser and 16.26 without it.
    const { store, dates } = timingPool();
    const ids = Array.from({ length: 50 }, (_, i) => `r${i}`);
    const steps = await store.stepsOfMany(ids);
    expect([...steps.values()].reduce((n, s) => n + s.length, 0)).toBe(100);
    expect(steps.get('r0')![0].startedAt).toBe('2026-11-20T04:08:20.249Z');
    expect(dates(), 'a window of steps still costs 200 Date objects').toBe(0);
  });
});

/** Every `.ts` under `server/`, tests excluded, comments and imports stripped. */
function productCode(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        out.push([path, readFileSync(path, 'utf8')
          // THIS FILE'S OWN PROSE NAMES WHAT IT HUNTS, and so does
          // `pg-store.ts`'s: a search over raw text would be satisfied by a
          // paragraph explaining the rule rather than by code keeping it.
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/^\s*import[\s\S]*?from\s*'[^']*';/gm, '')]);
      }
    }
  };
  walk('server');
  return out;
}

describe('the scope of the converter', () => {
  it('is asked for per query, never registered on the pool or on the process', () => {
    // THE DECISION, not a style note. `runtime.ts` shares ONE pool between
    // this journal, the engine's `postgres` node, the audit-chain check and
    // the rule store; the reason this store may ask for text is that it
    // converts every timestamp to text anyway, which is true of it and of
    // nothing else on that pool. `pg.types.setTypeParser` is process-wide and
    // is the plausible shortcut — it would change what three other readers
    // receive in order to speed up one, with nothing on screen to say so.
    const files = productCode();
    expect(files.length, 'the walk found nothing: the rule would pass over anything').toBeGreaterThan(40);

    const offenders = files.filter(([, code]) => /\bsetTypeParser\s*\(/.test(code));
    expect(offenders.map(([path]) => path)).toEqual([]);

    // And the one place that DOES ask for it is this store's choke point.
    const asks = files.filter(([, code]) => /\bISO_TIMESTAMPS\b/.test(code));
    expect(asks.map(([path]) => path)).toEqual([join('server', 'engine', 'pg-store.ts')]);
  });
});
