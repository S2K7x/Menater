/**
 * The audit chain's verifier, read from the console.
 *
 * ============================================================================
 * WHY EVERY NUMBER HERE ARRIVES AS A STRING, AND WHY THAT IS THE SUBJECT
 *
 * `soc_audit_log.id` is a `bigserial` and `count(*)` is a `bigint`, so `pg`
 * hands all four counters over as TEXT. Measured against the real function on
 * PostgreSQL 16.14, as the application role `n8n_soc`:
 *
 *   {"total":"49999","from_id":"0","checked":"49999","broken":"2"}
 *   types: total=string from_id=string checked=string broken=string
 *
 * This project has already paid for that once: `soc_audit_log.id` reached the
 * case builder as `"2651"`, a reader tested it with `typeof v === 'number'`,
 * and the Health tab announced "38 cases with no committed audit row" over a
 * database whose chain was intact. A FALSE RED COSTS MORE THAN NO RED AT ALL,
 * and nowhere more than here: this table is the product's only tamper
 * evidence, and a verifier that cries wolf is one an auditor stops believing.
 *
 * The sharper half is the other direction, and it is why `'empty'` is a word
 * and not a `broken === 0` branch: the string `"0"` is TRUTHY. An empty table
 * read carelessly reports *chain intact* — green over a table nobody has
 * written a decision to yet, which is this product's defining defect committed
 * against its own integrity guarantee.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  BREAK_SAMPLE, VERIFY_WINDOW, chainOutcome, verifyAuditChain, type Queryable,
} from './audit-chain.ts';

/** What the pool was asked, so a test can count round trips. */
interface Call { sql: string; params: unknown[] }

/**
 * A pool double that answers ONE row, the way `pg` really answers it.
 *
 * Typed as `Queryable` rather than cast to `Pool`: a cast fixture is a fixture
 * the typecheck does not hold to the contract, which this repository found out
 * the hard way one night earlier on `meta.from_env`.
 */
function pool(row: Record<string, unknown>): { q: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    q: {
      query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [row] });
      },
    },
  };
}

/** The answer shape measured above: every counter as text. */
const answered = (over: Record<string, unknown> = {}) => ({
  total: '49999', from_id: '0', checked: '49999', broken: '0', sample: [], ...over,
});

describe('the counters postgres sends as text are read as numbers', () => {
  it('reads total, checked, broken and from_id out of bigint strings', async () => {
    const { q } = pool(answered({ total: '2644', checked: '2644', broken: '0' }));
    const v = await verifyAuditChain(q);
    expect(v.total).toBe(2644);
    expect(v.checked).toBe(2644);
    expect(v.broken).toBe(0);
    expect(v.from_id).toBe(0);
  });

  it('accepts a number too, because `::int` columns and fixtures send one', async () => {
    const { q } = pool(answered({ total: 7, checked: 7, broken: 1, from_id: 0 }));
    const v = await verifyAuditChain(q);
    expect(v.total).toBe(7);
    expect(v.broken).toBe(1);
  });

  /**
   * NOT `?? 0`. A zero invented here reads as "nothing to verify", which is
   * the reassuring answer — the gap filled with a default that § 8 refuses,
   * on the one table whose whole job is to be checkable.
   */
  it('refuses a counter it cannot read, rather than defaulting it to zero', async () => {
    for (const bad of [undefined, null, {}, 'lots', '12.5', '']) {
      const { q } = pool(answered({ checked: bad }));
      await expect(verifyAuditChain(q)).rejects.toThrow(/checked/);
    }
  });
});

describe('the verdict is a word, and an empty table is not an intact chain', () => {
  it('calls an empty table empty', () => {
    expect(chainOutcome({
      total: 0, checked: 0, broken: 0, from_id: 0, complete: true, sample: [],
    })).toBe('empty');
  });

  it('calls a walked chain with no mismatch intact', () => {
    expect(chainOutcome({
      total: 2644, checked: 2644, broken: 0, from_id: 0, complete: true, sample: [],
    })).toBe('intact');
  });

  it('calls one mismatch broken', () => {
    expect(chainOutcome({
      total: 2644, checked: 2644, broken: 1, from_id: 0, complete: true, sample: [],
    })).toBe('broken');
  });

  /**
   * Measured, and the reason this verdict has a fourth word: a 69,643-row
   * table answered `broken: 0` over a walk of 50,000 rows. `intact` there
   * would be the reassuring word reachable from a state it does not describe.
   */
  it('refuses to call a clipped walk with no mismatch intact', () => {
    expect(chainOutcome({
      total: 69_643, checked: 50_000, broken: 0, from_id: 139_288, complete: false, sample: [],
    })).toBe('partial');
  });

  /** A mismatch found is the headline whatever else the walk missed. */
  it('still says broken when the walk was also clipped', () => {
    expect(chainOutcome({
      total: 69_643, checked: 50_000, broken: 3, from_id: 139_288, complete: false, sample: [],
    })).toBe('broken');
  });

  /**
   * The table is append-only, so `total > 0` with `checked === 0` cannot come
   * from the window — only from a verifier that walked nothing. Reporting that
   * as `intact` would be the empty-table defect one state further in.
   */
  it('does not call a table nothing was walked of intact', () => {
    expect(chainOutcome({
      total: 2644, checked: 0, broken: 0, from_id: 5288, complete: false, sample: [],
    })).toBe('empty');
  });
});

describe('the window, and what it is allowed to hide', () => {
  it('walks only the tail, and says the walk is partial', async () => {
    // Measured on the real function: `from_id: "20000"` with 49,999 rows in
    // the table walked 40,000 of them — AND reported `broken: 0` over two rows
    // that really are tampered, because both sit below the anchor. That is the
    // whole reason the partial walk has to be carried to the screen.
    const { q } = pool(answered({ total: '49999', from_id: '20000', checked: '40000' }));
    const v = await verifyAuditChain(q);
    expect(v.complete).toBe(false);
    expect(v.checked).toBe(40_000);
    expect(v.total).toBe(49_999);
  });

  it('calls a walk that started at the first row complete', async () => {
    const { q } = pool(answered({ from_id: '0' }));
    expect((await verifyAuditChain(q)).complete).toBe(true);
  });

  it('asks for the window and the sample size, in that order', async () => {
    const { q, calls } = pool(answered());
    await verifyAuditChain(q);
    expect(calls[0].params).toEqual([VERIFY_WINDOW, BREAK_SAMPLE]);
  });

  /**
   * ONE round trip, and it is not tidiness: each one re-runs
   * `soc_audit_verify_chain()`, which recomputes a SHA-256 per row — measured
   * at 1.21 s for 49,999 rows. Two queries would double that, and the pool's
   * own `statement_timeout` is 15 s.
   */
  it('recomputes the chain once', async () => {
    const { q, calls } = pool(answered());
    await verifyAuditChain(q);
    expect(calls).toHaveLength(1);
  });
});

describe('the count of mismatches is never the length of the sample', () => {
  it('keeps the real count when the sample is clipped', async () => {
    const sample = Array.from({ length: BREAK_SAMPLE }, (_, i) => ({
      id: i + 1, alert_id: `A-${i}`, status: 'TAMPERED: …',
    }));
    const { q } = pool(answered({ broken: '57', sample }));
    const v = await verifyAuditChain(q);
    expect(v.broken).toBe(57);
    expect(v.sample).toHaveLength(BREAK_SAMPLE);
  });

  it('reads a break row as the three fields the screen shows', async () => {
    const { q } = pool(answered({
      broken: '1',
      sample: [{ id: '504', alert_id: 'A-252', status: 'BROKEN_LINK: prev_hash does not match' }],
    }));
    const v = await verifyAuditChain(q);
    // `id` is a bigint here too — inside the json this time, where the same
    // reader has to work.
    expect(v.sample[0]).toEqual({
      id: 504, alert_id: 'A-252', status: 'BROKEN_LINK: prev_hash does not match',
    });
  });

  it('drops a break row it cannot read rather than rendering half of one', async () => {
    const { q } = pool(answered({ broken: '2', sample: [{ id: 1 }, { nope: true }] }));
    const v = await verifyAuditChain(q);
    expect(v.sample).toEqual([]);
    // The COUNT survives: the screen must still say two rows do not match.
    expect(v.broken).toBe(2);
  });
});

describe('the query\u2019s own fault is named at the one place it passes through', () => {
  /**
   * THE SHAPE THAT MATTERS, and it cannot be provoked with a real socket in
   * this container. `CLAUDE.md` records it: on `ECONNREFUSED` against a host
   * that resolves to several addresses, `pg` rejects with an `AggregateError`
   * whose `.message` is the EMPTY STRING \u2014 the code is in the aggregated
   * errors. Measured here, where `localhost` resolves to one address: a plain
   * `Error` with a perfectly good message, so the route test over a real
   * closed port passes whether the description happens or not. Hence this.
   */
  it('recovers the cause when pg sends an error with no message', async () => {
    const refused = Object.assign(new Error(''), { code: undefined as string | undefined });
    const aggregate = new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], '');
    for (const err of [aggregate, Object.assign(refused, { code: 'ECONNREFUSED' })]) {
      const q: Queryable = { query: () => Promise.reject(err) };
      await expect(verifyAuditChain(q)).rejects.toThrow(/ECONNREFUSED/);
    }
  });

  it('says where the fault was, so the sentence is not about the whole console', async () => {
    const q: Queryable = { query: () => Promise.reject(new Error('permission denied for table soc_audit_log')) };
    await expect(verifyAuditChain(q)).rejects.toThrow(/^Audit chain: permission denied/);
  });

  /** One prefix. Two would print one cause as two faults. */
  it('names the place once', async () => {
    const q: Queryable = { query: () => Promise.reject(new Error('nope')) };
    await expect(verifyAuditChain(q)).rejects.toThrow('Audit chain: nope');
  });

  /**
   * A fault WE found in the answer keeps its own sentence: it already says
   * which column and what arrived, and prefixing it with the database would
   * send somebody to look at Postgres over a reader of ours.
   */
  it('does not dress a reading fault as a database fault', async () => {
    const { q } = pool(answered({ checked: {} }));
    await expect(verifyAuditChain(q)).rejects.toThrow(/^The audit chain verifier answered checked/);
  });
});

describe('an answer that is not one row is not an answer', () => {
  /**
   * ANCHORED, and that is the assertion rather than a style. An aggregate over
   * an empty table still returns one row, so no row at all is a fault in OUR
   * reading, not in the database — and a check for it written inside the query
   * try-block would come out prefixed `Audit chain:`, sending somebody to look
   * at Postgres. A loose `/no row/` passes over exactly that; mutation said
   * so.
   */
  it('refuses an empty result set, in its own voice', async () => {
    const q: Queryable = { query: () => Promise.resolve({ rows: [] }) };
    await expect(verifyAuditChain(q))
      .rejects.toThrow(/^The audit chain verifier returned no row/);
  });
});
