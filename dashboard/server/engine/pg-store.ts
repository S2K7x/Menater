/**
 * Magasin d'exécutions sur Postgres — ce qui rend la durabilité réelle.
 *
 * ============================================================================
 * CE QUI CHANGE PAR RAPPORT AU MAGASIN EN MÉMOIRE
 *
 * Rien, du point de vue du moteur : c'est la même interface. C'est justement
 * l'intérêt — les tests de reprise après interruption tournent contre les
 * DEUX implémentations, avec la même suite. Une différence de comportement
 * entre les deux se voit donc en 200 ms, pas en production.
 *
 * ============================================================================
 * TROIS POINTS OÙ CE FICHIER GAGNE SA PLACE
 *
 *  1. `beginStep` DOIT ÊTRE DURABLE AU RETOUR. Toute la garantie « au plus une
 *     fois » repose là-dessus : si l'intention d'écrire est en base avant
 *     l'écriture, une reprise retrouve toujours la trace d'un appel dont elle
 *     ignore l'issue. Un `INSERT` simple suffit — Postgres ne rend la main
 *     qu'une fois la transaction validée.
 *
 *  2. LE VERROU EST UN `UPDATE` CONDITIONNEL, PAS UN `SELECT` PUIS UN `UPDATE`.
 *     Deux processus qui liraient puis écriraient prendraient tous deux le
 *     verrou. Une seule requête, et c'est la base qui arbitre.
 *
 *  3. UNE ATTENTE NE SE TRANCHE QU'UNE FOIS, pour la même raison : le
 *     `WHERE resumed_at IS NULL` est dans l'`UPDATE`. Un double clic ou un
 *     lien rouvert ne produit qu'une seule prise d'effet.
 *
 * ============================================================================
 * CE QU'IL NE FAIT PAS
 *
 * Il ne crée pas le schéma. `sql/10-engine.sql` s'applique à la main, comme le
 * reste — une application qui migre sa propre base au démarrage finit par le
 * faire au pire moment, et sur une base de sécurité c'est inacceptable.
 */

import { Pool, type PoolClient } from 'pg';

import type { RunStore } from './store.ts';
import type {
  RunRecord, RunStatus, StepRecord, StepStatus, WaitRecord,
} from './types.ts';

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Fabrique un pool. `max: 6` — le moteur est un seul processus qui traite les
 * étapes en séquence ; ouvrir vingt connexions ne servirait qu'à épuiser la
 * limite de la base pendant qu'un autre outil en a besoin.
 */
export function createPool(config: PgConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: 6,
    // Une requête qui n'aboutit pas en 15 s ne va pas aboutir : mieux vaut
    // une erreur nommée qu'une exécution figée sans explication.
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
  });
}

/**
 * Rend une erreur Postgres LISIBLE.
 *
 * ============================================================================
 * POURQUOI CE N'EST PAS DU CONFORT
 *
 * Sur une connexion refusée, `pg` lève une `AggregateError` dont `.message`
 * est LA CHAÎNE VIDE. Le code d'erreur (`ECONNREFUSED`) est bien là, dans
 * `.code`, mais personne ne le lit — et l'application remonte alors une erreur
 * sans message.
 *
 * Constaté à l'écran : le point d'entrée des alertes répondait
 * `"error": ""`. Une base injoignable devenait une panne sans cause, sur le
 * chemin où l'on a le moins de temps pour chercher.
 *
 * La règle du projet est « ne jamais throw une erreur silencieuse ». Une
 * erreur au message vide en est une.
 * ============================================================================
 */
export function describePgError(err: unknown, where: string): string {
  const e = err as { message?: string; code?: string; errors?: unknown[]; detail?: string };
  const message = (e?.message ?? '').trim();
  if (message !== '') return `${where}: ${message}`;

  // Message vide : on va chercher le code, puis celui des erreurs agrégées.
  const code =
    e?.code
    ?? (Array.isArray(e?.errors)
      ? (e.errors.find((x) => (x as { code?: string })?.code) as { code?: string } | undefined)?.code
      : undefined);

  const explained: Record<string, string> = {
    ECONNREFUSED: 'the database refused the connection \u2014 nothing is listening at that address',
    ENOTFOUND: 'the host cannot be found',
    ETIMEDOUT: 'the database did not answer in time',
    '28P01': 'password refused for this user',
    '3D000': 'that database does not exist',
    '42P01': 'the table does not exist \u2014 the SQL schema was never applied',
  };

  if (code) return `${where}: ${explained[code] ?? `error ${code}`} (${code})`;
  return `${where}: an error carrying neither message nor code `
    + `(${(err as Error)?.constructor?.name ?? 'unknown'})`;
}

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

function toRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowVersion: Number(row.workflow_version),
    status: row.status as RunStatus,
    alertId: (row.alert_id as string) ?? null,
    input: row.input,
    startedAt: iso(row.started_at)!,
    endedAt: iso(row.ended_at),
    error: (row.error as string) ?? null,
  };
}

function toStep(row: Record<string, unknown>): StepRecord {
  return {
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    attempt: Number(row.attempt),
    status: row.status as StepStatus,
    output: row.output,
    port: (row.port as string) ?? null,
    error: (row.error as string) ?? null,
    startedAt: iso(row.started_at)!,
    endedAt: iso(row.ended_at),
  };
}

function toWait(row: Record<string, unknown>): WaitRecord {
  return {
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    token: String(row.token),
    deadline: iso(row.deadline)!,
    resumedAt: iso(row.resumed_at),
    payload: row.payload,
  };
}

export class PgRunStore implements RunStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const res = await this.pool.query(sql, params as never[]);
      return res.rows as T[];
    } catch (err) {
      // POINT DE PASSAGE UNIQUE : toutes les requêtes du magasin traversent
      // cette méthode, donc aucune ne peut remonter une erreur muette.
      // Le premier mot du SQL suffit à situer l'échec sans exposer la requête.
      throw new Error(describePgError(err, `Database (${sql.trim().split(/\s+/)[0]})`));
    }
  }

  async createRun(run: RunRecord): Promise<void> {
    await this.q(
      // `ended_at` est ECRIT DES LA CREATION quand il est fourni. La contrainte
      // `soc_run_ended_consistency` refuse une exécution « terminée » sans date
      // de fin — et elle a raison : une durée manquante fausse toutes les
      // mesures sans jamais lever.
      `INSERT INTO soc_run (id, workflow_id, workflow_version, status, alert_id, input, started_at, ended_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [run.id, run.workflowId, run.workflowVersion, run.status, run.alertId,
       JSON.stringify(run.input ?? null), run.startedAt, run.endedAt, run.error],
    );
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const rows = await this.q('SELECT * FROM soc_run WHERE id = $1', [runId]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async setRunStatus(runId: string, status: RunStatus, error: string | null = null): Promise<void> {
    // `ended_at` suit le statut dans la MÊME requête : la contrainte
    // `soc_run_ended_consistency` rejetterait une ligne « terminée » sans date,
    // et une exécution terminée sans date fausse toutes les mesures de durée.
    const ended = status === 'done' || status === 'failed' || status === 'cancelled';
    await this.q(
      `UPDATE soc_run SET status = $2, error = $3,
         ended_at = CASE WHEN $4 THEN now() ELSE NULL END
       WHERE id = $1`,
      [runId, status, error, ended],
    );
  }

  async unfinishedRuns(): Promise<RunRecord[]> {
    const rows = await this.q(
      `SELECT * FROM soc_run WHERE status IN ('running','waiting') ORDER BY started_at`,
    );
    return rows.map(toRun);
  }

  async recentRuns(opts: { limit: number; since?: string | null }): Promise<RunRecord[]> {
    // `started_at DESC, id DESC` and a hard LIMIT: this is the console's
    // hottest read, and an unbounded ORDER BY over a year of runs is how a
    // triage queue becomes slower every week it is used. `id` breaks ties so
    // the order is stable between two refreshes.
    const rows = opts.since
      ? await this.q(
        `SELECT * FROM soc_run WHERE started_at >= $1
           ORDER BY started_at DESC, id DESC LIMIT $2`,
        [opts.since, opts.limit],
      )
      : await this.q(
        'SELECT * FROM soc_run ORDER BY started_at DESC, id DESC LIMIT $1',
        [opts.limit],
      );
    return rows.map(toRun);
  }

  async stepsOfMany(runIds: string[]): Promise<Map<string, StepRecord[]>> {
    const out = new Map<string, StepRecord[]>();
    for (const id of runIds) out.set(id, []);
    if (runIds.length === 0) return out;
    // ONE query, not one per run. `stepsOf` in a loop is a round trip per run
    // and the queue reads a hundred of them per refresh — the same shape as
    // the "Promise.all over the whole window" trap, moved into the database.
    const rows = await this.q(
      `SELECT * FROM soc_run_step WHERE run_id = ANY($1::text[])
        ORDER BY started_at, node_id`,
      [runIds],
    );
    for (const row of rows) {
      const step = toStep(row);
      out.get(step.runId)?.push(step);
    }
    return out;
  }

  async beginStep(step: StepRecord): Promise<void> {
    // `ON CONFLICT DO NOTHING` : une reprise peut retrouver une étape déjà
    // commencée. Écraser sa trace effacerait précisément ce qui permet de
    // savoir qu'une écriture était en cours.
    await this.q(
      `INSERT INTO soc_run_step (run_id, node_id, attempt, status, output, port, error, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (run_id, node_id, attempt) DO NOTHING`,
      [step.runId, step.nodeId, step.attempt, step.status,
       step.output === undefined ? null : JSON.stringify(step.output),
       step.port, step.error],
    );
  }

  async endStep(
    runId: string,
    nodeId: string,
    attempt: number,
    patch: { status: StepStatus; output?: unknown; port?: string | null; error?: string | null },
  ): Promise<void> {
    const rows = await this.q(
      `UPDATE soc_run_step
         SET status = $4,
             output = COALESCE($5::jsonb, output),
             port = COALESCE($6, port),
             error = $7,
             ended_at = now()
       WHERE run_id = $1 AND node_id = $2 AND attempt = $3
       RETURNING run_id`,
      [runId, nodeId, attempt, patch.status,
       patch.output === undefined ? null : JSON.stringify(patch.output),
       patch.port ?? null, patch.error ?? null],
    );
    if (rows.length === 0) {
      // Même message que le magasin en mémoire : les deux implémentations
      // doivent échouer de la même façon, sinon les tests de contrat ne
      // prouvent rien.
      throw new Error(`step ${nodeId}#${attempt} of ${runId} was never started`);
    }
  }

  async stepsOf(runId: string): Promise<StepRecord[]> {
    const rows = await this.q(
      'SELECT * FROM soc_run_step WHERE run_id = $1 ORDER BY started_at, node_id',
      [runId],
    );
    return rows.map(toStep);
  }

  async createWait(wait: WaitRecord): Promise<void> {
    await this.q(
      `INSERT INTO soc_run_wait (token, run_id, node_id, deadline)
       VALUES ($1,$2,$3,$4)`,
      [wait.token, wait.runId, wait.nodeId, wait.deadline],
    );
  }

  async waitByToken(token: string): Promise<WaitRecord | null> {
    const rows = await this.q('SELECT * FROM soc_run_wait WHERE token = $1', [token]);
    return rows[0] ? toWait(rows[0]) : null;
  }

  async resolveWait(token: string, payload: unknown): Promise<void> {
    // `WHERE resumed_at IS NULL` DANS l'UPDATE : c'est la base qui garantit
    // qu'une attente ne se tranche qu'une fois. Un double clic, un lien
    // rouvert, un rejeu de requête ne produisent qu'une seule prise d'effet.
    const rows = await this.q(
      `UPDATE soc_run_wait SET resumed_at = now(), payload = $2::jsonb
       WHERE token = $1 AND resumed_at IS NULL
       RETURNING token`,
      [token, JSON.stringify(payload ?? null)],
    );
    if (rows.length === 0) {
      const existing = await this.waitByToken(token);
      throw new Error(existing ? 'that wait was already settled' : 'unknown wait token');
    }
  }

  async expiredWaits(now: string): Promise<WaitRecord[]> {
    const rows = await this.q(
      'SELECT * FROM soc_run_wait WHERE resumed_at IS NULL AND deadline <= $1 ORDER BY deadline',
      [now],
    );
    return rows.map(toWait);
  }

  async claimRun(runId: string, owner: string): Promise<boolean> {
    // UN SEUL `UPDATE` CONDITIONNEL. Un `SELECT` puis un `UPDATE` laisserait
    // deux processus prendre le verrou entre les deux requêtes — et deux
    // moteurs qui reprennent la même exécution rejouent ses étapes.
    const rows = await this.q(
      `UPDATE soc_run SET owner = $2, claimed_at = now()
       WHERE id = $1 AND (owner IS NULL OR owner = $2)
       RETURNING id`,
      [runId, owner],
    );
    return rows.length > 0;
  }

  async releaseRun(runId: string, owner: string): Promise<void> {
    await this.q(
      'UPDATE soc_run SET owner = NULL, claimed_at = NULL WHERE id = $1 AND owner = $2',
      [runId, owner],
    );
  }
}

// --- Variables ------------------------------------------------------------------

/**
 * Lit les variables de pipeline depuis la base.
 *
 * Rend `null` si la table n'existe pas encore : l'appelant retombe alors sur
 * `config.json`. C'est délibéré — la console doit rester utilisable avant que
 * le schéma soit appliqué, et le dire plutôt que d'échouer au démarrage.
 */
export async function readVariables(pool: Pool): Promise<Map<string, unknown> | null> {
  try {
    const res = await pool.query('SELECT key, value FROM soc_variable');
    return new Map(res.rows.map((r: { key: string; value: unknown }) => [r.key, r.value]));
  } catch {
    return null;
  }
}

/**
 * Écrit une variable, en conservant l'historique.
 *
 * L'ancienne valeur est archivée dans la même transaction : « qui a changé ce
 * seuil, et quand » est une question qu'on se pose toujours APRÈS l'incident,
 * quand il est trop tard pour commencer à l'enregistrer.
 */
export async function writeVariables(
  pool: Pool,
  patch: Record<string, unknown>,
  by: string,
): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(patch)) {
      const before = await client.query('SELECT value FROM soc_variable WHERE key = $1', [key]);
      await client.query(
        `INSERT INTO soc_variable (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(value), by],
      );
      await client.query(
        `INSERT INTO soc_variable_history (key, old_value, new_value, changed_by)
         VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        [key, JSON.stringify(before.rows[0]?.value ?? null), JSON.stringify(value), by],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
