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

import type {
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  WaitRecord,
} from './types.ts';

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
  recentRuns(opts: { limit: number; since?: string | null }): Promise<RunRecord[]>;

  /**
   * The steps of several runs at once.
   *
   * `stepsOf` per run is one round trip per run, and the queue reads a hundred
   * of them on every refresh — the same shape as the "Promise.all over the
   * whole window" trap, moved into the database. One query, grouped here.
   */
  stepsOfMany(runIds: string[]): Promise<Map<string, StepRecord[]>>;

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

  async recentRuns(opts: { limit: number; since?: string | null }): Promise<RunRecord[]> {
    const floor = opts.since ? Date.parse(opts.since) : null;
    return [...this.runs.values()]
      .filter((r) => floor === null || Date.parse(r.startedAt) >= floor)
      // Newest first, and `id` breaks the tie: two runs created in the same
      // millisecond must come back in a STABLE order, or a queue reshuffles
      // itself between two refreshes for no reason the operator can see.
      .sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || b.id.localeCompare(a.id))
      .slice(0, opts.limit)
      .map((r) => MemoryRunStore.copy(r));
  }

  async stepsOfMany(runIds: string[]): Promise<Map<string, StepRecord[]>> {
    const wanted = new Set(runIds);
    const out = new Map<string, StepRecord[]>();
    for (const id of runIds) out.set(id, []);
    for (const step of this.steps) {
      if (!wanted.has(step.runId)) continue;
      out.get(step.runId)!.push(MemoryRunStore.copy(step));
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

  async resolveWait(token: string, payload: unknown): Promise<void> {
    const wait = this.waits.get(token);
    if (!wait) throw new Error(`jeton d'attente inconnu`);
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
