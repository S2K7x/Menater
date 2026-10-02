/**
 * The execution store: what makes the engine DURABLE.
 *
 * ============================================================================
 * THE INTERFACE EXISTS FOR ONE PRECISE REASON
 *
 * The engine knows nothing but `RunStore`. Two implementations satisfy it:
 * Postgres in production, memory in the tests.
 *
 * That is not abstraction for its own sake. What has to be proved is RECOVERY
 * AFTER AN INTERRUPTION: cut the process in the middle of a call that changes
 * the world, restart, check that nothing is replayed. A test that needs a
 * Postgres for that does not run in CI, therefore does not run, therefore
 * recovery is never verified — and recovery is exactly the part of the engine
 * whose breakage nobody notices.
 *
 * ============================================================================
 * WHAT THE STORE GUARANTEES, AND WHAT IT DOES NOT
 *
 * IT GUARANTEES that `beginStep` is durable before the call returns. The whole
 * "at most once" rule rests on that: if the INTENTION to write is recorded
 * before the write, a recovery always finds the trace of a call whose outcome
 * it does not know.
 *
 * IT DOES NOT GUARANTEE mutual exclusion between processes. One console runs
 * today. `claimRun` takes an advisory lock so that assumption becomes false
 * LOUDLY rather than silently, the day a second process starts.
 * ============================================================================
 */

import { INPUT_NOT_READ, OUTPUT_NOT_READ } from './types.ts';
import type {
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  WaitRecord,
} from './types.ts';

/**
 * What a reader of several runs' steps declares it will READ.
 *
 * ============================================================================
 * THE JOURNAL HOLDS FAR MORE THAN THE CONSOLE READS
 *
 * Every node writes its output, and that is the point: six months later it is
 * the only thing that explains why a branch was taken. But the case builder
 * reads the output of a DECLARED set of node ids — `NODE_CONTRACT` — and of
 * the 81 nodes in the six workflows, 29 ids are in it. Measured on a real
 * Postgres over a window of the documented size, the rest is 70% of the jsonb
 * the query pulls: fetched, parsed into JavaScript objects, and dropped.
 *
 * So the caller says which outputs it wants. Omitting the option asks for
 * everything, which is what a reader that needs the whole journal gets.
 *
 * WHAT A STEP OUTSIDE THE LIST CARRIES IS `OUTPUT_NOT_READ`, never `null`:
 * see the comment on that constant. Both stores must do this identically, or
 * the console shows one thing on Postgres and another in the tests —
 * `store-contract.test.ts` is where that is held.
 * ============================================================================
 */
export interface StepReadOptions {
  /** Node ids whose `output` the caller will read. Absent = every output. */
  outputsOf?: ReadonlySet<string>;
}

/**
 * Which runs' `input` a reader of a window declares it will READ.
 *
 * ============================================================================
 * A PREDICATE, NOT A LIST — AND THAT IS THE WHOLE DECISION
 *
 * `soc_run.input` is the payload a run received, kept so a replay is possible.
 * Four of the five runs an alert produces are sub-workflow calls, and each of
 * them carries the alert AGAIN; the case builder opens the input of exactly two
 * kinds of run — the one that entered through `01-ingestion`, and one with no
 * `alert_id`, where a marker inside the payload tells the connectivity probe
 * from a real anomaly. Measured on a real Postgres over a seeded window:
 * **895,641 bytes of input, 99,049 of it read**.
 *
 * `outputsOf` above can be a SET because what it selects is a column's own
 * value. This selects a ROW, by a rule over two columns — and a rule has to
 * live in one place. Expressed as data (a workflow-id list plus an orphan
 * flag) it would be interpreted twice, once in SQL and once in JavaScript, so
 * the reader's logic would exist in three copies; expressed as a function it
 * exists once, in `cases.ts`, beside the lines that read the field.
 *
 * The price is that the Postgres store cannot push it down, so it reads the
 * window's identity first and the inputs it was asked for second — ONE extra
 * round trip for the whole window, not one per run. That trip is AWAITED,
 * which is the opposite of the cost this change removes: the bytes it no
 * longer fetches were parsed ON the single thread that also answers the
 * ingestion webhook. Both numbers are in the pull request.
 *
 * A RUN OUTSIDE THE PREDICATE CARRIES `INPUT_NOT_READ`, never `null`: see the
 * comment on that constant. Both stores must do this identically, or the
 * console shows one thing on Postgres and another in the tests —
 * `store-contract.test.ts` is where that is held.
 * ============================================================================
 */
export type RunInputFilter = (run: Pick<RunRecord, 'workflowId' | 'alertId'>) => boolean;

export interface RunReadOptions {
  limit: number;
  /** Lower bound on `startedAt`, so a short window does not page a year. */
  since?: string | null;
  /** Runs whose `input` the caller will read. Absent = every input. */
  inputOf?: RunInputFilter;
}

export interface RunStore {
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  setRunStatus(runId: string, status: RunStatus, error?: string | null): Promise<void>;
  /** Runs to resume at startup: everything not in a terminal state. */
  unfinishedRuns(): Promise<RunRecord[]>;

  /**
   * The most recent runs, newest first.
   *
   * ==========================================================================
   * THIS IS WHAT THE CONSOLE READS. IT USED TO READ n8n.
   *
   * The triage queue, the metrics and the Tracking tab were all built by
   * walking an n8n instance's execution list. That made the console unable to
   * show its own engine's work: the engine wrote `soc_run` and nothing ever
   * read it back. Removing n8n therefore is not a deletion, it is this method
   * plus `engine/cases.ts` — the console now reads the runs it produced.
   *
   * `since` bounds the window by start time so a console configured for a
   * two-hour window does not page through a year of history.
   * ==========================================================================
   */
  recentRuns(opts: RunReadOptions): Promise<RunRecord[]>;

  /**
   * The steps of several runs at once.
   *
   * `stepsOf` per run is one round trip per run, and the queue reads a hundred
   * of them on every refresh — the same shape as the "Promise.all over the
   * whole window" trap, moved into the database. One query, grouped here.
   */
  stepsOfMany(runIds: string[], opts?: StepReadOptions): Promise<Map<string, StepRecord[]>>;

  /**
   * Enregistre l'INTENTION d'exécuter une étape, avant de l'exécuter.
   * Doit être durable au retour : toute la sûreté des écritures en dépend.
   */
  beginStep(step: StepRecord): Promise<void>;
  endStep(
    runId: string,
    nodeId: string,
    attempt: number,
    patch: { status: StepStatus; output?: unknown; port?: string | null; error?: string | null },
  ): Promise<void>;
  stepsOf(runId: string): Promise<StepRecord[]>;

  createWait(wait: WaitRecord): Promise<void>;
  waitByToken(token: string): Promise<WaitRecord | null>;

  /**
   * The wait a run is still holding open — the question a human can answer.
   *
   * ==========================================================================
   * THE TOKEN IS A VERB, AND IT MUST NOT LEAVE THIS PROCESS
   *
   * The console answers an approval by naming the RUN, never the token:
   * `waitByToken` resolves a capability, and resolving one is irreversible.
   * The incident card that would have had to carry a token is read by the
   * assistant's `get_alert` and by every MCP client — a catalogue that is
   * closed and read-only precisely so that an injected instruction arrives at
   * a model holding no verb. Run ids already travel there.
   *
   * So the lookup lives here, on the far side of the boundary, and it answers
   * `null` for a wait already settled: the first answer stands, and there is
   * no second question to resolve.
   * ==========================================================================
   */
  openWaitOfRun(runId: string): Promise<WaitRecord | null>;
  resolveWait(token: string, payload: unknown): Promise<void>;
  /** Attentes dont l'échéance est dépassée et que personne n'a tranchées. */
  expiredWaits(now: string): Promise<WaitRecord[]>;

  /**
   * Prend le verrou d'exécution. `false` = quelqu'un d'autre l'a déjà.
   * Un moteur qui reprendrait une exécution déjà reprise ailleurs rejouerait
   * des étapes : mieux vaut refuser de démarrer.
   */
  claimRun(runId: string, owner: string): Promise<boolean>;
  releaseRun(runId: string, owner: string): Promise<void>;
}

/**
 * In-memory store. For the tests and the demonstration mode only.
 *
 * Deliberately NOT a bare object: it copies records on the way in and on the
 * way out. Without that a test could mutate the object it handed over and
 * watch "the store" change by itself — and a buggy engine would pass.
 */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();
  private steps: StepRecord[] = [];
  private waits = new Map<string, WaitRecord>();
  private locks = new Map<string, string>();

  private static copy<T>(value: T): T {
    return structuredClone(value);
  }

  async createRun(run: RunRecord): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
    // MÊME INVARIANT QUE LA BASE. Postgres le fait respecter par la contrainte
    // `soc_run_ended_consistency` ; sans ce garde, le magasin mémoire
    // accepterait une exécution que Postgres refuse — divergence trouvée par
    // le test de contrat, sur une vraie base.
    //
    // Une exécution « terminée » sans date de fin fausse toutes les mesures de
    // durée, et ne lève jamais.
    const terminal = run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
    if (terminal !== (run.endedAt !== null)) {
      throw new Error(
        `run ${run.id}: status \u201c${run.status}\u201d and an end date that is `
          + `${run.endedAt === null ? 'absent' : 'present'} are inconsistent.`,
      );
    }
    this.runs.set(run.id, MemoryRunStore.copy(run));
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? MemoryRunStore.copy(run) : null;
  }

  async setRunStatus(runId: string, status: RunStatus, error: string | null = null): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    run.status = status;
    run.error = error;
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      run.endedAt = new Date().toISOString();
    }
  }

  async unfinishedRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.status === 'running' || r.status === 'waiting')
      .map(MemoryRunStore.copy);
  }

  async recentRuns(opts: RunReadOptions): Promise<RunRecord[]> {
    const floor = opts.since ? Date.parse(opts.since) : null;
    return [...this.runs.values()]
      .filter((r) => floor === null || Date.parse(r.startedAt) >= floor)
      // Newest first, and `id` breaks the tie: two runs created in the same
      // millisecond must come back in a STABLE order, or a queue reshuffles
      // itself between two refreshes for no reason the operator can see.
      .sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || b.id.localeCompare(a.id))
      .slice(0, opts.limit)
      .map((r) => {
        const copy = MemoryRunStore.copy(r);
        // ON THE COPY, never on the record this store holds. The memory store
        // hands back copies precisely so a reader cannot reach into its
        // journal, and blanking the input in place would delete it for the
        // next reader — `getRun`, which is what a resume reads.
        if (opts.inputOf !== undefined && !opts.inputOf(copy)) copy.input = INPUT_NOT_READ;
        return copy;
      });
  }

  async stepsOfMany(
    runIds: string[],
    opts: StepReadOptions = {},
  ): Promise<Map<string, StepRecord[]>> {
    const wanted = new Set(runIds);
    const out = new Map<string, StepRecord[]>();
    for (const id of runIds) out.set(id, []);
    for (const step of this.steps) {
      if (!wanted.has(step.runId)) continue;
      const copy = MemoryRunStore.copy(step);
      // The projection is applied to the COPY. The memory store hands back
      // copies precisely so a reader cannot reach into what it holds, and
      // blanking the output in place would delete the journal it keeps.
      if (opts.outputsOf !== undefined && !opts.outputsOf.has(copy.nodeId)) {
        copy.output = OUTPUT_NOT_READ;
      }
      out.get(step.runId)!.push(copy);
    }
    return out;
  }

  async beginStep(step: StepRecord): Promise<void> {
    // N'ÉCRASE PAS une étape déjà commencée — divergence trouvée par le test
    // de contrat, que le magasin Postgres évitait déjà (`ON CONFLICT DO
    // NOTHING`). Une reprise peut retrouver une étape en cours ; recréer sa
    // trace effacerait précisément ce qui permet de savoir qu'une écriture
    // était en vol.
    const exists = this.steps.some(
      (s) => s.runId === step.runId && s.nodeId === step.nodeId && s.attempt === step.attempt,
    );
    if (exists) return;
    this.steps.push(MemoryRunStore.copy(step));
  }

  async endStep(
    runId: string,
    nodeId: string,
    attempt: number,
    patch: { status: StepStatus; output?: unknown; port?: string | null; error?: string | null },
  ): Promise<void> {
    const step = this.steps.find(
      (s) => s.runId === runId && s.nodeId === nodeId && s.attempt === attempt,
    );
    if (!step) throw new Error(`step ${nodeId}#${attempt} of ${runId} was never started`);
    step.status = patch.status;
    if ('output' in patch) step.output = MemoryRunStore.copy(patch.output);
    if ('port' in patch) step.port = patch.port ?? null;
    step.error = patch.error ?? null;
    step.endedAt = new Date().toISOString();
  }

  async stepsOf(runId: string): Promise<StepRecord[]> {
    return this.steps.filter((s) => s.runId === runId).map(MemoryRunStore.copy);
  }

  async createWait(wait: WaitRecord): Promise<void> {
    this.waits.set(wait.token, MemoryRunStore.copy(wait));
  }

  async waitByToken(token: string): Promise<WaitRecord | null> {
    const wait = this.waits.get(token);
    return wait ? MemoryRunStore.copy(wait) : null;
  }

  async openWaitOfRun(runId: string): Promise<WaitRecord | null> {
    // Insertion order, which is creation order — the same order the SQL side
    // gets from `ORDER BY created_at`. A run holds one open wait in this
    // pipeline; taking the oldest keeps the two implementations identical if
    // one ever holds two.
    for (const wait of this.waits.values()) {
      if (wait.runId === runId && !wait.resumedAt) return MemoryRunStore.copy(wait);
    }
    return null;
  }

  async resolveWait(token: string, payload: unknown): Promise<void> {
    const wait = this.waits.get(token);
    // ENGLISH, AND THE SAME SENTENCE `PgRunStore` THROWS. It reaches an
    // operator — `routes/approvals.ts` puts `err.message` straight into
    // `approvalFailed` — so the two stores saying it differently means the
    // console answers in a different language depending on which one is
    // mounted. `store-contract.test.ts` exists to stop exactly this drift and
    // could not see it: its Postgres half runs only when `MENATER_TEST_PG` is
    // set, and it never had been.
    if (!wait) throw new Error('unknown wait token');
    if (wait.resumedAt) throw new Error('that wait was already settled');
    wait.resumedAt = new Date().toISOString();
    wait.payload = MemoryRunStore.copy(payload);
  }

  async expiredWaits(now: string): Promise<WaitRecord[]> {
    return [...this.waits.values()]
      .filter((w) => !w.resumedAt && w.deadline <= now)
      .map(MemoryRunStore.copy);
  }

  async claimRun(runId: string, owner: string): Promise<boolean> {
    const held = this.locks.get(runId);
    if (held && held !== owner) return false;
    this.locks.set(runId, owner);
    return true;
  }

  async releaseRun(runId: string, owner: string): Promise<void> {
    if (this.locks.get(runId) === owner) this.locks.delete(runId);
  }

  /**
   * Simule un arrêt brutal du processus.
   *
   * Les données persistées SURVIVENT — c'est tout l'intérêt — mais les verrous
   * disparaissent, comme après un vrai redémarrage. Sans cette distinction, un
   * test de reprise ne prouverait rien.
   */
  simulateCrash(): void {
    this.locks.clear();
  }
}
