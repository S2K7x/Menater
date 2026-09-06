/**
 * File de messages de la pipeline.
 *
 * ============================================================================
 * ÉCART ASSUMÉ : LA FILE EST UNE INTERFACE, PAS BULLMQ EN DUR
 *
 * `CLAUDE.md` §5 tranche « BullMQ + Redis — pas de Celery/Temporal pour le
 * MVP, trop lourd pour un solo builder », et PHASE_6 demande de le mettre en
 * place. La décision d'architecture est bonne et n'est pas rouverte.
 *
 * Mais la coder en dur rend le MVP indémarrable : il faut un serveur Redis en
 * marche pour lancer le moindre scan, y compris le test de bout en bout que
 * cette phase demande de fournir. Un livrable qu'on ne peut pas exécuter sans
 * installer une base de données n'est pas un livrable.
 *
 * On garde donc l'architecture par file — étapes découplées, jobs
 * indépendants, reprise possible — derrière une interface à deux mises en
 * œuvre :
 *   - `InMemoryQueue` (défaut) : zéro dépendance, le scan tourne tout de suite.
 *   - `BullMqQueue`   : activée dès que `REDIS_URL` est défini, pour le
 *     déploiement réel et le traitement concurrent multi-process.
 *
 * Le reste du code ne connaît que `JobQueue` : passer de l'un à l'autre ne
 * change aucune ligne de la pipeline.
 * ============================================================================
 */

export interface JobQueue<T> {
  readonly name: string;
  /** Empile un job. Renvoie son identifiant. */
  add(payload: T): Promise<string>;
  /** Enregistre le traitement. Un seul processeur par file. */
  process(handler: (payload: T, jobId: string) => Promise<void>): void;
  /** Attend que la file soit vide (utile en test et en mode script). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/**
 * File en mémoire, traitement séquentiel.
 *
 * Suffisante pour un scan local : les étapes sont chaînées, et le parallélisme
 * utile (les nodes de détection) se fait à l'intérieur d'une étape via
 * `Promise.all`, pas entre jobs.
 */
export class InMemoryQueue<T> implements JobQueue<T> {
  readonly name: string;
  private handler: ((payload: T, jobId: string) => Promise<void>) | null = null;
  private readonly pending: Array<{ id: string; payload: T }> = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private counter = 0;

  constructor(name: string) {
    this.name = name;
  }

  async add(payload: T): Promise<string> {
    const id = `${this.name}-${++this.counter}`;
    this.pending.push({ id, payload });
    void this.pump();
    return id;
  }

  process(handler: (payload: T, jobId: string) => Promise<void>): void {
    this.handler = handler;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running || !this.handler) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        try {
          await this.handler(job.payload, job.id);
        } catch (error) {
          // Un job qui échoue ne doit pas bloquer la file. L'erreur remonte
          // par les événements de progression, pas par un crash silencieux.
          console.error(`[queue:${this.name}] job ${job.id} en échec :`, (error as Error).message);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  async drain(): Promise<void> {
    if (!this.running && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async close(): Promise<void> {
    this.pending.length = 0;
  }
}

/**
 * Forme minimale de BullMQ dont on a besoin.
 *
 * Typée localement plutôt qu'importée : `bullmq` est une dépendance
 * OPTIONNELLE, et `import type` la rendrait obligatoire à la compilation pour
 * tout le monde — y compris ceux qui n'utiliseront jamais Redis. On décrit
 * donc le contrat qu'on consomme, vérifié contre la doc BullMQ.
 */
interface BullMqModule {
  Queue: new (
    name: string,
    opts: { connection: { url: string } }
  ) => {
    add(name: string, data: unknown): Promise<{ id?: string | number }>;
    getJobCounts(...types: string[]): Promise<Record<string, number>>;
    close(): Promise<void>;
  };
  Worker: new (
    name: string,
    processor: (job: { id?: string | number; data: unknown }) => Promise<void>,
    opts: { connection: { url: string } }
  ) => { close(): Promise<void> };
}

/**
 * Adaptateur BullMQ, chargé dynamiquement.
 *
 * L'import est dynamique pour que `bullmq` reste optionnel : sans Redis ni le
 * paquet installé, le reste du projet fonctionne. Une dépendance obligatoire
 * pour une fonctionnalité optionnelle est un coût imposé à tous pour le
 * confort de quelques-uns.
 */
export async function createBullMqQueue<T>(name: string, redisUrl: string): Promise<JobQueue<T>> {
  let bullmq: BullMqModule;
  try {
    // Le specifier est construit à l'exécution : un littéral ferait résoudre
    // le module par TypeScript à la compilation, ce qui rétablirait la
    // dépendance obligatoire qu'on cherche justement à éviter.
    const moduleName = ['bull', 'mq'].join('');
    bullmq = (await import(moduleName)) as unknown as BullMqModule;
  } catch {
    throw new Error(
      "REDIS_URL est défini mais le paquet `bullmq` n'est pas installé. Lance `npm i bullmq`, ou retire REDIS_URL pour utiliser la file en mémoire."
    );
  }

  const connection = { url: redisUrl };
  const queue = new bullmq.Queue(name, { connection });
  let worker: { close(): Promise<void> } | null = null;

  return {
    name,
    async add(payload: T) {
      const job = await queue.add(name, payload);
      return String(job.id);
    },
    process(handler) {
      worker = new bullmq.Worker(
        name,
        async (job) => {
          await handler(job.data as T, String(job.id));
        },
        { connection }
      );
    },
    async drain() {
      // BullMQ traite en arrière-plan : on attend que le compteur retombe à 0.
      for (;;) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        const remaining = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
        if (remaining === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    async close() {
      await worker?.close();
      await queue.close();
    },
  };
}

/** Choisit l'implémentation selon l'environnement. */
export async function createQueue<T>(
  name: string,
  env: { REDIS_URL?: string } = process.env
): Promise<JobQueue<T>> {
  return env.REDIS_URL ? createBullMqQueue<T>(name, env.REDIS_URL) : new InMemoryQueue<T>(name);
}
