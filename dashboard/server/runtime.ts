/**
 * The built-in engine, and everything mounted around it.
 *
 * ============================================================================
 * WHAT LIVES HERE
 *
 * The engine, its Postgres pool, the tuning-rule store and the resolver that
 * turns a credential NAME into its value. They belong together because they
 * share one lifecycle: all four are rebuilt when the database coordinates
 * change, and `engineKey()` is what notices that they must be.
 *
 * The routes never build any of this. They ask for it, and get `null` when no
 * database is configured — which is a state to REPORT, not to paper over.
 * ============================================================================
 */

import { Engine } from './engine/engine.ts';
import { PgRunStore, createPool, describePgError } from './engine/pg-store.ts';
import type { RunStore } from './engine/store.ts';
import { pureHandlers, TransformRegistry } from './engine/nodes/pure.ts';
import { ioHandlers } from './engine/nodes/io.ts';
import { controlHandlers } from './engine/nodes/control.ts';
import { buildRegistry } from './engine/transforms/registry.ts';
import { PIPELINE_WORKFLOWS } from './engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './engine/workflows/routing.ts';
import { RuleStore } from './rules-store.ts';
import { getConfig } from './config.ts';

/**
 * The built-in engine, mounted on demand.
 *
 * ============================================================================
 * IT MAY NOT EXIST, AND THAT IS A NORMAL STATE
 *
 * With no database configured there is no engine: `null`. The console stays
 * entirely usable — triage queue, tracking, metrics, code analysis — and the
 * alert entry point says plainly why it refuses.
 *
 * Forcing it onto an in-memory store would be worse: executions would vanish
 * on every restart, pending approvals included. A thirty-minute wait lost to a
 * redeployment is a human decision asked for twice — or worse, never got.
 * ============================================================================
 */
let engineCache: {
  key: string; engine: Engine; store: PgRunStore; pool: ReturnType<typeof createPool>;
} | null = null;

export function engineKey(): string {
  const db = getConfig().database;
  return `${db.host}:${db.port}/${db.database}/${db.user}/${db.ssl}`;
}

export function getEngine(): Engine | null {
  const db = getConfig().database;
  // No host or no database: nothing to mount. We do not guess an address.
  if (!db.host || !db.database) return null;

  const key = engineKey();
  if (engineCache && engineCache.key === key) return engineCache.engine;
  if (engineCache) void engineCache.pool.end().catch(() => {});

  const pool = createPool(db);
  const store = new PgRunStore(pool);

  // The variables are re-read ON EVERY CALL: changing them in the interface
  // takes effect at the next execution, with no restart. That is the whole
  // point of the Workflow tab.
  const vars = () => new Map<string, unknown>(Object.entries(getConfig().variables));
  const now = () => new Date();

  const transforms: TransformRegistry = buildRegistry({
    now,
    /**
     * Where the approver clicking the Slack button lands.
     *
     * NOT `/api/approvals/<id>`: that route only accepts POST, and
     * a browser gets a JSON 404 from it. That route carries the approval
     * action, not the page from which it is triggered.
     *
     * The console has no URL routing at all — no deep link to a case —
     * so the link opens the application, where the alert is waiting in the
     * queue. The `?run=` does nothing TODAY: it identifies the execution for
     * the day the interface can open it directly, rather than losing that
     * information in the link.
     */
    resumeUrl: (runId: string) =>
      `${getConfig().tunnel.hostname || ''}/?run=${encodeURIComponent(runId)}`,
  });

  const deps = {
    transforms,
    vars,
    now,
    secret: (name: string) => secretFor(name),
    query: async (sql: string, params: unknown[]) => (await pool.query(sql, params as never[])).rows,
    runSubflow: async (workflowId: string, input: unknown, alertId: string | null) => {
      const run = await engine.start(workflowId, input, alertId);
      return { run_id: run.id, status: run.status };
    },
  };

  const engine = new Engine({
    store,
    handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
    now,
  });
  for (const wf of [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS]) engine.register(wf);

  engineCache = { key, engine, store, pool };
  return engine;
}

/**
 * Rule store, on the engine's own pool.
 *
 * `null` when no database is configured — the console then says the rules
 * cannot be read, rather than showing an empty list that would look like
 * "no rules" instead of "no answer".
 */
/**
 * The run journal, for READING.
 *
 * The console's queue, metrics and Tracking tab are built from it — see
 * `engine/cases.ts`. Exposed separately from `getEngine()` because reading the
 * journal must not require the engine to be startable: a store that answers is
 * enough to show what already happened.
 */
export function getEngineStore(): RunStore | null {
  // Mounting the engine is what builds the store, and it is idempotent per
  // database key. Reading the journal therefore costs nothing extra, and it
  // cannot end up reading a store the engine is not using.
  getEngine();
  return engineCache?.store ?? null;
}

export function getRuleStore(): RuleStore | null {
  const engine = getEngine();
  if (!engine || !engineCache) return null;
  return new RuleStore(engineCache.pool);
}

/**
 * A rule-store failure that must be reported as a database problem.
 *
 * `getRuleStore()` answers whether a database is CONFIGURED, not whether it
 * answers. Every call below that guard could therefore still fail at connect
 * time, and fell to the catch-all — which replies 500 with pg's own message.
 * On `ECONNREFUSED` that message is the EMPTY STRING, so the Rules tab showed
 * a failure with no cause: the very defect already fixed on the webhook, in a
 * place the fix was never applied.
 *
 * It matters more here than elsewhere: an unreadable rule set is
 * indistinguishable from an empty one, and an empty one means no rule ever
 * fires — green everywhere, and nothing being filtered.
 */
export class RuleDbError extends Error {}

/**
 * Runs a rule-store call, naming the database as the cause if it fails.
 *
 * NOT called `db`: `getEngine()` holds a local `const db = getConfig().database`,
 * and a module function shadowed by a local of the same name is exactly the
 * alias trap this project already paid for once.
 */
export async function ruleDb<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new RuleDbError(describePgError(err, 'Base de données (règles)'));
  }
}

/**
 * Resolves a credential by its NAME.
 *
 * Every key the pipeline uses is resolved through here, from `process.env` AT
 * CALL TIME — which is what lets a key set in Settings take effect on the next
 * alert with no restart. A missing credential fails its node by NAMING it,
 * which is what saves you from chasing a 401 at the provider's end.
 */
export function secretFor(name: string): string | undefined {
  const env = process.env[name.toUpperCase().replace(/[.-]/g, '_')];
  return env === '' ? undefined : env;
}
