/**
 * S1.3 — the tamper-evidence promise, made checkable from the console.
 *
 * ============================================================================
 * WHAT THIS CLOSES
 *
 * `soc_audit_log` is append-only and hash-chained, and the database does the
 * sealing: `soc_audit_seal()` takes an advisory lock, reads the previous
 * link, allocates the id inside that lock and hashes the row's canonical form
 * against its predecessor. `soc_audit_verify_chain()` replays that
 * computation row by row and names anything that no longer matches.
 *
 * The console's entire contribution to all of it was a STRING. `audit.ts`
 * writes `chain_verify_hint: "SELECT * FROM soc_audit_verify_chain() WHERE
 * status <> 'ok';"` onto every audit record, and nothing in this process has
 * ever run that query. So the one claim this product makes that an auditor
 * would actually test — *the record cannot be altered without it showing* —
 * was verifiable only by someone with a `psql` session on the container, and
 * `CLAUDE.md` documents the command because there was no other way to get it.
 *
 * Same family as the approval sweep that had no clock behind it: everything
 * around the guarantee was built and correct, and the thing that exercises it
 * had no caller.
 *
 * ============================================================================
 * IT READS, IT NEVER WRITES — AND IT IS NOT ON A TIMER
 *
 * One `SELECT`, no transaction, no row touched. The verifier cannot repair a
 * chain and must not try: the table is immutable by design and rows sealed
 * before the id-inside-the-lock fix keep their broken links for ever, which is
 * the right trade and the reason `soc_audit_verify_chain()` goes on naming
 * them honestly.
 *
 * And nothing calls this periodically. It recomputes a SHA-256 per row —
 * measured at 24 µs a row — so putting it in the snapshot would make every
 * twenty-second refresh of every open tab pay for it on the single thread that
 * also answers the ingestion webhook. It is a deliberate human act, like the
 * connectivity diagnostic beside it.
 *
 * ============================================================================
 * THE WALK IS BOUNDED, AND THE CLIP IS CARRIED TO THE SCREEN
 *
 * `createPool` sets `statement_timeout: 15_000`. At the measured 24 µs a row
 * that bites somewhere around 620,000 rows — which a console taking ten
 * thousand alerts a day reaches in about two months. A check that works until
 * an install has been running long enough to need it is not a check.
 *
 * So the walk covers the `VERIFY_WINDOW` most recent rows and `complete` says
 * whether that was the whole table. The anchor is the id of the row just
 * BEFORE the window, and it has to be an id that EXISTS: the function seeds
 * its running hash from `WHERE l.id = p_from`, so an id nobody holds seeds
 * zeros and the first row walked is then reported as a broken link. A false
 * red, manufactured by the bound. Hence `ORDER BY id DESC OFFSET $1 LIMIT 1`
 * rather than arithmetic on `max(id)`.
 *
 * Which is also why nothing here derives a count from an id RANGE. Ids have
 * gaps BY CONSTRUCTION — the seal allocates a second `nextval` inside the
 * lock and the one the column default already burned is skipped, so a healthy
 * table measured here ran 2, 4, 6 … 100000 for 49,999 rows. `last - first + 1`
 * would have called every install tampered.
 *
 * ============================================================================
 * MEASURED, ON THE REAL FUNCTION
 *
 * PostgreSQL 16.14, as the application role `n8n_soc` (which holds
 * `GRANT EXECUTE ON FUNCTION soc_audit_verify_chain(bigint)` and `SELECT` on
 * the table, and nothing else — checked, because `sql/10-engine.sql` shipped
 * with no grants once already):
 *
 *   window=50000   1208 ms  {"total":"49999","from_id":"0","checked":"49999","broken":"2"}
 *   window=40000    964 ms  {"total":"49999","from_id":"20000","checked":"40000","broken":"0"}
 *   window=10         5 ms  {"total":"49999","from_id":"99980","checked":"10","broken":"0"}
 *
 * The middle line is the one to keep: both tampered rows sit below the anchor,
 * so a partial walk answered `broken: 0` about a table that really is broken.
 * A clip nobody is told about is a silent hole one day further out, so
 * `complete` travels and the screen's tone follows it.
 *
 * `EXPLAIN (ANALYZE)` on the query below: `Function Scan on
 * soc_audit_verify_chain q (actual rows=49999 loops=1)` — the `MATERIALIZED`
 * CTE is what keeps that at one scan while five sub-selects read it.
 * ============================================================================
 */

import { describePgError } from './engine/pg-store.ts';

/**
 * The only thing this needs of a pool, so a test can hand it a double without
 * a cast. A real `pg.Pool` satisfies it.
 */
export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Rows walked in one pass.
 *
 * A POLICY NUMBER, not a measured maximum — the same distinction the payload
 * depth cap draws. 50,000 rows cost 1.21 s on the machine this was measured
 * on, i.e. a twelfth of the statement timeout, which leaves room for a server
 * under load and a chain whose rows are larger.
 */
export const VERIFY_WINDOW = 50_000;

/**
 * Mismatching rows named on screen. The COUNT is never clipped — twenty rows
 * listed out of fifty-seven is a reading aid; fifty-seven reported as twenty
 * would be a lie about how much of the record is in question.
 */
export const BREAK_SAMPLE = 20;

/** One row the replayed computation disagrees with. */
export interface ChainBreak {
  id: number;
  alert_id: string;
  /** The verifier's own sentence, from a closed vocabulary it composes. */
  status: string;
}

/** What the walk found. Facts only — `chainOutcome` reads the verdict. */
export interface ChainVerification {
  /** Rows the walk recomputed. */
  checked: number;
  /** Rows whose link or whose own hash did not match. */
  broken: number;
  /** Rows in the table. `checked < total` means the window clipped history. */
  total: number;
  /** The id the walk started AFTER. `0` is the first row of the chain. */
  from_id: number;
  /** Whether the walk covered the whole table. */
  complete: boolean;
  /** At most `BREAK_SAMPLE` mismatches, oldest first. */
  sample: ChainBreak[];
}

/**
 * ONE round trip, because each one replays the whole chain.
 *
 * `anchor` is read in the same statement as the walk so the denominator and
 * the numerator come from one snapshot: two queries could answer "50,001 of
 * 50,000" after one insert landed between them.
 */
const VERIFY_SQL = `
WITH anchor AS (
  SELECT count(*) AS total,
         coalesce((SELECT l.id FROM soc_audit_log l ORDER BY l.id DESC OFFSET $1 LIMIT 1), 0) AS from_id
    FROM soc_audit_log
),
v AS MATERIALIZED (
  SELECT q.id, q.alert_id, q.status
    FROM soc_audit_verify_chain((SELECT a.from_id FROM anchor a)) q
),
bad AS (
  SELECT b.id, b.alert_id, b.status FROM v b WHERE b.status <> 'ok' ORDER BY b.id LIMIT $2
)
SELECT (SELECT a.total FROM anchor a)                  AS total,
       (SELECT a.from_id FROM anchor a)                AS from_id,
       (SELECT count(*) FROM v)                        AS checked,
       (SELECT count(*) FROM v WHERE v.status <> 'ok') AS broken,
       (SELECT coalesce(json_agg(json_build_object('id', c.id, 'alert_id', c.alert_id,
                                                   'status', c.status) ORDER BY c.id),
                        '[]'::json) FROM bad c)        AS sample`;

/**
 * A counter, as `pg` really hands a `bigint` over: the string `"49999"`.
 *
 * IT THROWS RATHER THAN DEFAULTING. A `?? 0` here answers "nothing to verify"
 * — the reassuring sentence — about a column nobody could read, and this is
 * the one table where a comfortable wrong answer costs the whole guarantee.
 */
function counter(value: unknown, column: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error(
    `The audit chain verifier answered ${column} as ${JSON.stringify(value)}, `
    + 'which is not a whole number.',
  );
}

/**
 * A mismatch row, or nothing.
 *
 * A row this cannot read is DROPPED and the count is not touched: the screen
 * then says "57 rows do not match" and lists the ones it could read, which is
 * honest in a way that rendering `undefined` next to a real id is not.
 */
function breakRow(value: unknown): ChainBreak | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const id = typeof r.id === 'number' ? r.id
    : typeof r.id === 'string' && /^\d+$/.test(r.id) ? Number(r.id) : null;
  if (id === null || typeof r.alert_id !== 'string' || typeof r.status !== 'string') return null;
  return { id, alert_id: r.alert_id, status: r.status };
}

/** Replays the hash chain over the most recent `VERIFY_WINDOW` rows. */
export async function verifyAuditChain(pool: Queryable): Promise<ChainVerification> {
  let res: { rows: Array<Record<string, unknown>> };
  try {
    res = await pool.query(VERIFY_SQL, [VERIFY_WINDOW, BREAK_SAMPLE]);
  } catch (err) {
    // THE ONE PLACE THE QUERY'S FAULT IS NAMED, which is why it is here and
    // not at the route: `PgRunStore.q()` is the same choke point for the same
    // reason, and describing a fault at two levels prints one cause under two
    // prefixes.
    //
    // It is not decoration. `pg` rejects `ECONNREFUSED` with an EMPTY message
    // when the host resolves to several addresses — the code is in `.code` and
    // in that of the aggregated errors — so a route forwarding `err.message`
    // answers « nothing was verified » with no cause at all, on the screen
    // whose entire job is to say what is wrong. Measured in this container,
    // where `localhost` resolves to one address: `Error`, message
    // `"connect ECONNREFUSED 127.0.0.1:38503"`, `code` `"ECONNREFUSED"` — i.e.
    // the ordinary case is NOT the dangerous one, and the dangerous one cannot
    // be provoked with a real socket here. `audit-chain.test.ts` injects the
    // documented shape instead.
    throw new Error(describePgError(err, 'Audit chain'));
  }
  const row = res.rows[0];
  // An aggregate over an empty table still returns one row, so no row at all
  // means the statement did not answer the question that was asked.
  if (!row) throw new Error('The audit chain verifier returned no row.');

  const from_id = counter(row.from_id, 'from_id');
  return {
    total: counter(row.total, 'total'),
    checked: counter(row.checked, 'checked'),
    broken: counter(row.broken, 'broken'),
    from_id,
    complete: from_id === 0,
    sample: (Array.isArray(row.sample) ? row.sample : [])
      .map(breakRow)
      .filter((b): b is ChainBreak => b !== null),
  };
}

/** What the walk is entitled to claim. */
export type ChainOutcome = 'intact' | 'partial' | 'broken' | 'empty';

/**
 * The verdict, as a WORD — and FOUR of them, not a boolean and not three.
 *
 * A boolean has no room for the third fact, and the third fact is the one that
 * matters: `broken === 0` is also true of a table nobody has written a
 * decision to, and `"0"` out of `pg` is TRUTHY, so the careless reading of
 * either shape prints *chain intact* over an empty table. Green is earned.
 *
 * `partial` is the fourth, and it was added because the measurement demanded
 * it: a 69,643-row table answered `broken: 0` over a walk of 50,000 rows, and
 * calling that `intact` makes the reassuring word reachable from a state it
 * does not describe — the same defect as the scan report that took green when
 * coverage was unknown. A partial coverage changes the TITLE; it is not a
 * footnote under an unchanged one.
 *
 * `broken` still wins over `partial`: a mismatch found is the headline
 * whatever else the walk missed, and the sentence beside it says both.
 */
export function chainOutcome(v: ChainVerification): ChainOutcome {
  if (v.broken > 0) return 'broken';
  // `total === 0` is the empty table. `checked === 0` with rows in the table
  // cannot come from the window — the anchor is always inside it — so it means
  // the walk covered nothing, and nothing verified is not a verified chain.
  if (v.total === 0 || v.checked === 0) return 'empty';
  return v.complete ? 'intact' : 'partial';
}
