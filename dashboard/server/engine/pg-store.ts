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

import { Pool, types as pgTypes } from 'pg';

import type { RunReadOptions, RunStore, StepReadOptions } from './store.ts';
import { INPUT_NOT_READ, OUTPUT_NOT_READ } from './types.ts';
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
  const pool = new Pool({
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

  // A CONNECTION NOBODY WAS USING MUST NOT BE ABLE TO END THE PROCESS.
  //
  // A `Pool` is an `EventEmitter`, and it emits `'error'` when a connection it
  // holds IDLE loses the server at the other end: a database restart, a
  // failover, an administrator's `pg_terminate_backend`, a middlebox reaping an
  // idle socket. An `EventEmitter` that emits `'error'` with no listener
  // THROWS — and that throw is an uncaught EXCEPTION, not a rejection, so
  // `api.ts`'s `process.on('unhandledRejection')`, written under the comment
  // « a promise rejected outside the handler must not bring the server down »,
  // never saw it. Measured against the real console on PostgreSQL 16.15: a
  // healthy `GET /api/snapshot` answered 200, one backend sat idle in the pool,
  // `pg_terminate_backend` on it, and the process was gone — the port closed,
  // the ingestion webhook with it, and 301 lines of a dumped internal `Client`
  // object in the log naming nothing an operator can act on.
  //
  // IT REPORTS AND RETURNS, and that is the whole decision. The pool needs no
  // repair: with this event merely listened to it drops the dead client
  // (`idleCount` and `totalCount` both fall to 0) and the next query opens a
  // new connection — measured. So the missing listener contributed nothing but
  // the death. node-postgres' own documentation suggests `process.exit(-1)`
  // here; on this process that rebuilds the defect inside its own repair, and
  // `pool-error.test.ts` keeps a test whose only job is to refuse it.
  //
  // NO `describePgError`, deliberately. That function exists because `pg`
  // reports a refused CONNECT as an `AggregateError` whose `.message` is the
  // EMPTY STRING; an idle client is one that already connected, so that shape
  // cannot arrive here. The three that can were probed on 16.15 and every one
  // carries its own sentence: `57P01` / "terminating connection due to
  // administrator command" for an admin command and for an orderly restart,
  // and a plain `Error` / "Connection terminated unexpectedly" when the
  // database process is killed outright. Describing them twice would print one
  // cause under two prefixes, which is the mistake the approval sweep already
  // made once.
  //
  // The consequence is named next to the cause: a dropped connection the pool
  // reopens by itself is not a database that is down, and sending an operator
  // to look at a database that is answering costs them the evening.
  pool.on('error', (err: Error) => {
    console.error(
      `[menater] a pooled database connection was dropped: ${err.message}`
      + ' — it will be reopened on the next query.',
    );
  });

  return pool;
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
 *
 * AND IT ONLY HAPPENS WITH MORE THAN ONE ADDRESS. That was missing here, and
 * the omission is what let three callers go around this function while two
 * tests written against the empty message stayed green. The empty `.message`
 * is Node's happy-eyeballs `AggregateError`, raised when the host resolved to
 * several addresses and every attempt failed; with ONE address `pg` rejects
 * with a plain `Error` carrying `connect ECONNREFUSED <addr>:<port>`. Measured
 * through `pg` 8.23.0 on Node 22.23.4 against a closed port:
 *
 *   host         constructor      .message                            .code
 *   twohomed     AggregateError   ""                                  ECONNREFUSED
 *   127.0.0.1    Error            "connect ECONNREFUSED 127.0.0.1:1"  ECONNREFUSED
 *
 * So every fixture that names a literal address exercises the row that works.
 * `localhost` is two addresses on any machine whose `/etc/hosts` carries the
 * usual `::1` line, and it is this product's default database host.
 * ============================================================================
 */
export function describePgError(err: unknown, where: string): string {
  return `${where}: ${pgCause(err)}`;
}

/**
 * The CAUSE alone, with no prefix.
 *
 * Split out of `describePgError` for the one surface that already supplies the
 * prefix: the Health tab renders a check's `detail` directly under its `label`,
 * which is « Database », and the two other sentences on that same check
 * (`dbNotConfigured`, `dbReachable`) do not repeat the word either. Prefixing
 * there would say the same thing twice, two lines apart.
 *
 * Everything else goes through `describePgError`, because a step error or a
 * banner travels with no label beside it.
 */
export function pgCause(err: unknown): string {
  const e = err as { message?: string; code?: string; errors?: unknown[] };
  const message = (e?.message ?? '').trim();
  if (message !== '') return message;

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

  if (code) return `${explained[code] ?? `error ${code}`} (${code})`;
  return 'an error carrying neither message nor code '
    + `(${(err as Error)?.constructor?.name ?? 'unknown'})`;
}

/**
 * The sentence for a failed query against the engine's pool.
 *
 * ONE SPELLING FOR BOTH CALLERS. `PgRunStore.q()` is the store's own choke
 * point; `queryDep` in `runtime.ts` is the dependency the engine's `postgres`
 * node is built on. They are the same fact about the same pool, and two copies
 * of `sql.trim().split(...)` is how two spellings of one number start
 * disagreeing.
 *
 * The first word of the SQL situates the failure without exposing the query.
 */
export function describeQueryError(err: unknown, sql: string): string {
  return describePgError(err, `Database (${sql.trim().split(/\s+/)[0]})`);
}

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/**
 * `timestamptz`, which is what EVERY timestamp column in `sql/` is — checked,
 * not assumed: the schema holds no `timestamp without time zone` at all.
 *
 * So `timestamp` (OID 1114) is deliberately absent. Its text carries no
 * offset, so the converter below could never read one anyway, and wrapping it
 * would be a branch for a state this schema cannot produce. A column added in
 * that type later goes on getting pg's parser, and `iso()` formats the `Date`
 * exactly as it does today.
 */
const PG_TIMESTAMPTZ = 1184;

/**
 * The UTC text form Postgres sends, sliced straight into the ISO string this
 * store answers with — or `null` when the text is not that shape.
 *
 * ============================================================================
 * WHAT IT IS FOR: A `Date` NOBODY READS
 *
 * Postgres sends a timestamp as text (`2026-11-20 04:08:20.249+00`, probed on
 * PostgreSQL 16.15). `pg` hands that to `postgres-date`, which parses it into
 * a `Date`, and `iso()` immediately calls `toISOString()` to get back a
 * string. Nothing in between reads the date object: every timestamp in this
 * file goes through `iso()`, and no consumer of a `RunRecord`, `StepRecord` or
 * `WaitRecord` wants anything but the ISO string.
 *
 * Per value the round trip is 0.861 us against 0.076 us here — nothing, and
 * the multiplier is the defect, which is the same shape as the service
 * inventory re-normalised inside the loop that searched it. The snapshot
 * rebuild reads TWO timestamps per step row, and a 500-run window holds 4,078
 * of them: measured against a real PostgreSQL 16.15 over a window seeded by
 * driving the six workflows, `stepsOfMany` is **31.77 ms with pg's parser and
 * 16.26 ms without it** — 48.8% of the single most expensive query this
 * console makes, on the thread that also answers the ingestion webhook.
 *
 * ============================================================================
 * WHY IT DECLINES RATHER THAN HANDLING EVERY FORM
 *
 * Postgres can also emit an offset (`+01`, `+05:30`), a five-digit year, `BC`
 * and `infinity`, and the offsets need arithmetic this function deliberately
 * does not do: `null` means *not a shape I can read*, and the caller then
 * delegates to pg's own parser, which is today's behaviour unchanged. So the
 * fast path is a saving on the deployment this product documents — Docker's
 * `postgres:16` runs UTC — and never a second opinion about what a timestamp
 * means.
 *
 * `null` cannot be confused with an absent timestamp: a SQL NULL never reaches
 * a type parser at all. Probed — the row value is `null` and the parser is not
 * called.
 *
 * THE FALLBACK IS pg's PARSER AND NOT `new Date(text)`, and that is the one
 * trap here — the forms the fast path declines are exactly the ones `new Date`
 * is worst at. Probed on Node 22.23.5 against pg 8.23.0:
 *
 *   'infinity'                  pg: the NUMBER Infinity   new Date: THROWS
 *   '-infinity'                 pg: -Infinity             new Date: THROWS
 *   '0044-03-15 10:00:00+00 BC' pg: -000043-03-15T…       new Date: THROWS
 *   '0044-03-15 10:00:00+01'    pg: 0044-03-15T09:00:00Z  new Date: **2044**
 *
 * A throw is the sharp one: it would come out of a type parser, i.e. out of
 * the query, so one such row would take down a read of the journal rather than
 * cost a formatting. The two-digit-year rule is the quiet one. Delegating
 * keeps all four at exactly what this store answered before — `iso(Infinity)`
 * is the string `"Infinity"` today and stays it.
 * ============================================================================
 */
export function isoIfUtcText(text: string): string | null {
  // "2026-11-20 04:08:20.249+00" -> "2026-11-20T04:08:20.249Z"
  //  0123456789^^^^^^^^^           a four-digit year puts the space at 10 and
  //  the seconds at 17-18, so everything below is a fixed offset.
  if (text.length < 22 || text.charCodeAt(10) !== 32 /* ' ' */) return null;
  if (!text.endsWith('+00')) return null;

  let millis: string;
  if (text.charCodeAt(19) === 46 /* '.' */) {
    // Postgres trims trailing zeros and keeps at most six digits; `Date` holds
    // three, and truncates rather than rounds — which is what `.249123`
    // becoming `.249` means, measured on both paths.
    const digits = text.slice(20, -3);
    if (digits.length === 0 || digits.length > 6) return null;
    millis = digits.length >= 3 ? digits.slice(0, 3) : `${digits}000`.slice(0, 3);
  } else if (text.length === 22) {
    millis = '000';
  } else {
    return null;
  }
  return `${text.slice(0, 10)}T${text.slice(11, 19)}.${millis}Z`;
}

/**
 * The type parsers this store's queries ask for.
 *
 * SCOPED TO THIS STORE, deliberately. `runtime.ts` shares one pool between
 * this journal, the engine's `postgres` node, the audit-chain check and the
 * rule store; those three go on receiving `Date` objects exactly as they do
 * today, because the reason this store can ask for text is that it converts
 * every timestamp to text anyway. Registering it on the pool — or worse, on
 * `pg.types` for the whole process — would change what three other readers
 * see in order to speed up one.
 *
 * Anything this object does not own is handed back unchanged: it is given to
 * EVERY column of every query, binary format included, and a converter that
 * cannot read a form must not be the one answering for it.
 */
export const ISO_TIMESTAMPS = {
  getTypeParser(oid: number, format?: unknown) {
    const delegate = pgTypes.getTypeParser(oid, format as never);
    if (format === 'binary' || oid !== PG_TIMESTAMPTZ) return delegate;
    return (text: string) => isoIfUtcText(text) ?? iso(delegate(text));
  },
};

/**
 * Every column of `soc_run` except `input`.
 *
 * Written out rather than subtracted, because a `SELECT *` minus one column is
 * not something SQL can say — and because `toRun` reads these names, so a
 * column added to the table and not here is a field that silently stops
 * arriving on a projected read.
 */
const COLS_WITHOUT_INPUT =
  'id, workflow_id, workflow_version, status, alert_id, started_at, ended_at, error';

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
      // `types` RIDES ON THE QUERY, not on the pool: see `ISO_TIMESTAMPS`. It
      // is this method and not the two hot readers because `q()` is the one
      // choke point every query of this store passes through — the same reason
      // `describeQueryError` lives here — and all four record builders below
      // read their timestamps through `iso()`.
      const res = await this.pool.query({
        text: sql, values: params as never[], types: ISO_TIMESTAMPS });
      return res.rows as T[];
    } catch (err) {
      // POINT DE PASSAGE UNIQUE : toutes les requêtes du magasin traversent
      // cette méthode, donc aucune ne peut remonter une erreur muette.
      // `describeQueryError` est partagé avec `queryDep` (runtime.ts), qui est
      // l'autre consommateur direct de ce pool : une seule formulation.
      throw new Error(describeQueryError(err, sql));
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

  async recentRuns(opts: RunReadOptions): Promise<RunRecord[]> {
    // `started_at DESC, id DESC` and a hard LIMIT: this is the console's
    // hottest read, and an unbounded ORDER BY over a year of runs is how a
    // triage queue becomes slower every week it is used. `id` breaks ties so
    // the order is stable between two refreshes.
    //
    // AND ONLY THE INPUTS THE CALLER SAID IT WOULD READ. `input` is by far the
    // widest column here — the alert as it arrived, raw log included — and the
    // predicate selects a ROW rather than a column, so it cannot travel into
    // this query the way `stepsOfMany`'s list of node ids does. The window's
    // identity comes back first, the inputs asked for second: one extra round
    // trip for the whole window, against 750 kB of jsonb this process no longer
    // fetches and parses. See `RunReadOptions`.
    const cols = opts.inputOf === undefined ? '*' : COLS_WITHOUT_INPUT;
    const rows = opts.since
      ? await this.q(
        `SELECT ${cols} FROM soc_run WHERE started_at >= $1
           ORDER BY started_at DESC, id DESC LIMIT $2`,
        [opts.since, opts.limit],
      )
      : await this.q(
        `SELECT ${cols} FROM soc_run ORDER BY started_at DESC, id DESC LIMIT $1`,
        [opts.limit],
      );
    const runs = rows.map(toRun);
    if (opts.inputOf === undefined) return runs;

    // THE SENTINEL IS SET FIRST, FOR EVERY RUN. A row the second query does not
    // answer for therefore stays `INPUT_NOT_READ` and fails loudly where it is
    // read, instead of arriving as `null` — which is a legitimate payload here
    // and would make a diagnostic probe look like an anomaly. Nothing deletes
    // from `soc_run` (it is the journal) and `input` is written once, at INSERT
    // and never updated, so the two reads cannot disagree about a row they both
    // see.
    for (const r of runs) r.input = INPUT_NOT_READ;
    const wanted = runs.filter((r) => opts.inputOf!(r)).map((r) => r.id);
    if (wanted.length === 0) return runs;
    const inputs = new Map<string, unknown>();
    for (const row of await this.q(
      'SELECT id, input FROM soc_run WHERE id = ANY($1::text[])', [wanted],
    )) {
      inputs.set(String(row.id), row.input);
    }
    for (const r of runs) if (inputs.has(r.id)) r.input = inputs.get(r.id);
    return runs;
  }

  async stepsOfMany(
    runIds: string[],
    opts: StepReadOptions = {},
  ): Promise<Map<string, StepRecord[]>> {
    const out = new Map<string, StepRecord[]>();
    for (const id of runIds) out.set(id, []);
    if (runIds.length === 0) return out;
    const wanted = opts.outputsOf;
    // ONE query, not one per run. `stepsOf` in a loop is a round trip per run
    // and the queue reads a hundred of them per refresh — the same shape as
    // the "Promise.all over the whole window" trap, moved into the database.
    //
    // AND ONLY THE OUTPUTS THE CALLER SAID IT WOULD READ. The `CASE` is what
    // keeps the other outputs out of the answer: a jsonb column is read, sent,
    // and `JSON.parse`d per row, so selecting it for a node nobody asks about
    // is paid three times for nothing. The filter is on `node_id` alone rather
    // than on the (workflow, node) pair the contract declares, which
    // over-fetches the handful of ids two workflows share — five rows in a
    // 980-row window, measured — and buys a query with no join.
    const rows = wanted === undefined
      ? await this.q(
        `SELECT * FROM soc_run_step WHERE run_id = ANY($1::text[])
          ORDER BY started_at, node_id`,
        [runIds],
      )
      : await this.q(
        `SELECT run_id, node_id, attempt, status, port, error, started_at, ended_at,
                CASE WHEN node_id = ANY($2::text[]) THEN output END AS output
           FROM soc_run_step WHERE run_id = ANY($1::text[])
          ORDER BY started_at, node_id`,
        [runIds, [...wanted]],
      );
    for (const row of rows) {
      const step = toStep(row);
      // THE SENTINEL IS DECIDED BY THE LIST, NEVER BY THE VALUE. The `CASE`
      // above hands back SQL NULL both for an output we did not ask for and
      // for one the node really left empty, and those are different facts: a
      // declared node whose output is genuinely `null` must stay `null`, or
      // `handoffState` stops being able to say `empty`.
      if (wanted !== undefined && !wanted.has(step.nodeId)) step.output = OUTPUT_NOT_READ;
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

  async openWaitOfRun(runId: string): Promise<WaitRecord | null> {
    // `soc_run_wait_run_idx` covers the lookup. `resumed_at IS NULL` is the
    // whole contract: a settled wait is not an open question, and answering it
    // twice would be the one thing `resolveWait` exists to make impossible.
    const rows = await this.q(
      `SELECT * FROM soc_run_wait WHERE run_id = $1 AND resumed_at IS NULL
         ORDER BY created_at LIMIT 1`,
      [runId],
    );
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
