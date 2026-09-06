/**
 * Persistence for tuning rules.
 *
 * Every write also appends to `soc_tuning_rule_history`, IN THE SAME
 * TRANSACTION. A rule decides that certain alerts stop reaching a human;
 * "who silenced this, when, and why" has to be answerable from the database
 * alone, months later, by someone without the console open. A history written
 * outside the transaction is a history that disagrees with the table the first
 * time something fails halfway.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { TuningRule } from './engine/transforms/tuning.ts';

export interface StoredRule extends TuningRule {
  match_count: number;
  last_matched_at: string | null;
}

const toRule = (row: Record<string, any>): StoredRule => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled,
  priority: row.priority,
  conditions: row.conditions ?? [],
  action: row.action,
  severity: row.severity ?? null,
  owner: row.owner,
  reason: row.reason,
  expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  created_at: new Date(row.created_at).toISOString(),
  updated_at: new Date(row.updated_at).toISOString(),
  match_count: Number(row.match_count ?? 0),
  last_matched_at: row.last_matched_at ? new Date(row.last_matched_at).toISOString() : null,
});

export class RuleStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async list(): Promise<StoredRule[]> {
    const res = await this.pool.query(
      'SELECT * FROM soc_tuning_rule ORDER BY priority ASC, id ASC',
    );
    return res.rows.map(toRule);
  }

  /**
   * Only what the engine needs, and only what can still match.
   *
   * Expired rules are filtered HERE as well as in `evaluateRules`: the engine
   * re-checks because it must never depend on the caller having done it, and
   * the query narrows because loading a year of lapsed exceptions on every
   * alert is waste.
   */
  async active(): Promise<StoredRule[]> {
    const res = await this.pool.query(
      `SELECT * FROM soc_tuning_rule
        WHERE enabled AND (expires_at IS NULL OR expires_at > now())
        ORDER BY priority ASC, id ASC`,
    );
    return res.rows.map(toRule);
  }

  async create(rule: Omit<TuningRule, 'id'>, by: string): Promise<StoredRule> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO soc_tuning_rule
           (id, name, enabled, priority, conditions, action, severity, owner, reason, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id, rule.name, rule.enabled, rule.priority, JSON.stringify(rule.conditions),
          rule.action, rule.severity, rule.owner, rule.reason, rule.expires_at,
        ],
      );
      await client.query(
        `INSERT INTO soc_tuning_rule_history (rule_id, change, snapshot, changed_by)
         VALUES ($1, 'created', $2, $3)`,
        [id, JSON.stringify(res.rows[0]), by],
      );
      await client.query('COMMIT');
      return toRule(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(id: string, patch: Partial<TuningRule>, by: string): Promise<StoredRule | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM soc_tuning_rule WHERE id = $1', [id]);
      if (current.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const merged = { ...toRule(current.rows[0]), ...patch };
      const res = await client.query(
        `UPDATE soc_tuning_rule
            SET name=$2, enabled=$3, priority=$4, conditions=$5, action=$6,
                severity=$7, owner=$8, reason=$9, expires_at=$10, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [
          id, merged.name, merged.enabled, merged.priority, JSON.stringify(merged.conditions),
          merged.action, merged.severity, merged.owner, merged.reason, merged.expires_at,
        ],
      );
      await client.query(
        `INSERT INTO soc_tuning_rule_history (rule_id, change, snapshot, changed_by)
         VALUES ($1, 'updated', $2, $3)`,
        [id, JSON.stringify(res.rows[0]), by],
      );
      await client.query('COMMIT');
      return toRule(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async remove(id: string, by: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM soc_tuning_rule WHERE id = $1', [id]);
      if (current.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      // The snapshot goes in BEFORE the delete: removing a rule must not
      // remove the record that it once existed, nor what it said.
      await client.query(
        `INSERT INTO soc_tuning_rule_history (rule_id, change, snapshot, changed_by)
         VALUES ($1, 'deleted', $2, $3)`,
        [id, JSON.stringify(current.rows[0]), by],
      );
      await client.query('DELETE FROM soc_tuning_rule WHERE id = $1', [id]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Records that a rule matched.
   *
   * Deliberately NOT awaited by the ingestion path: a counter is measurement,
   * and measurement must never be able to delay — or fail — the handling of an
   * alert. A lost increment costs a slightly stale statistic.
   */
  async noteMatch(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE soc_tuning_rule SET match_count = match_count + 1, last_matched_at = now() WHERE id = $1',
      [id],
    );
  }

  async history(id: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const res = await this.pool.query(
      `SELECT change, snapshot, changed_at, changed_by
         FROM soc_tuning_rule_history WHERE rule_id = $1
        ORDER BY changed_at DESC LIMIT $2`,
      [id, limit],
    );
    return res.rows;
  }
}
