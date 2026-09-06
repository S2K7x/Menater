/**
 * Moteur d'exécution durable.
 *
 * ============================================================================
 * LA BOUCLE, EN UNE PHRASE
 *
 * Tant qu'il reste des nœuds prêts : enregistrer l'intention, exécuter,
 * enregistrer le résultat, suivre le port de sortie. Le journal est la vérité ;
 * la mémoire du processus n'est qu'un cache qu'on jette au redémarrage.
 *
 * ============================================================================
 * CE QUI SE PASSE À LA REPRISE — LE CŒUR DU FICHIER
 *
 * Au démarrage, `resume()` relit chaque exécution inachevée et rejoue son
 * journal. Trois cas, et le troisième est celui qui compte :
 *
 *   - étape `ok` : son résultat est REJOUÉ depuis le journal, jamais recalculé.
 *     C'est ce qui rend la reprise déterministe et gratuite.
 *
 *   - étape jamais commencée : elle s'exécute normalement.
 *
 *   - étape `running` retrouvée au démarrage : le processus est mort PENDANT.
 *     Pour un nœud `pure` ou `read`, on relance — au pire on recalcule ou on
 *     refait une lecture. Pour un nœud `write`, on NE RELANCE PAS : l'étape
 *     devient `indeterminate` et l'exécution s'arrête là, à trancher par un
 *     humain.
 *
 * Cette dernière ligne est le contraire de ce que font les moteurs grand
 * public, qui réessaient. Ici un `write`, c'est un message Slack d'approbation,
 * un ticket, une ligne dans une table d'audit dont la chaîne de hachage sert
 * précisément à prouver l'absence de doublon, ou une isolation d'hôte.
 * Réessayer tout seul serait plus pratique et strictement inacceptable.
 *
 * ============================================================================
 * CE QUE LE MOTEUR NE FAIT PAS
 *
 * Il n'évalue aucune expression. Un nœud reçoit ses paramètres typés et le
 * contexte de l'exécution ; c'est son gestionnaire qui décide. Il n'y a donc
 * ni `eval`, ni `new Function`, ni langage de gabarit — dans une console de
 * sécurité, ce n'est pas une simplification, c'est une surface d'attaque en
 * moins.
 * ============================================================================
 */

import { NODE_EFFECTS, type Edge, type NodeDef, type RunRecord, type StepRecord, type WorkflowDef } from './types.ts';
import type { RunStore } from './store.ts';

/** Ce qu'un gestionnaire de nœud reçoit. */
export interface NodeContext {
  runId: string;
  workflow: WorkflowDef;
  node: NodeDef;
  /** Sortie du nœud amont. */
  input: unknown;
  /** Sorties déjà produites, par identifiant de nœud. */
  outputs: ReadonlyMap<string, unknown>;
  /** Corrélation métier, si elle est connue. */
  alertId: string | null;
}

/**
 * Ce qu'un gestionnaire renvoie.
 *
 * `port` décide de la suite : c'est lui qui distingue la branche `true` d'un
 * `if` de sa branche `false`, ou la sortie `error` d'un appel HTTP raté.
 * Par défaut `main`.
 */
export interface NodeResult {
  output: unknown;
  port?: string;
  /**
   * Suspend l'exécution jusqu'à une reprise externe. Renvoyé par `wait`.
   * L'exécution passe en `waiting` — un état distinct de `running`, pour que
   * l'onglet Suivi ne compte pas une approbation en cours comme une panne.
   */
  suspend?: { token: string; deadlineMs: number };
}

export type NodeHandler = (ctx: NodeContext) => Promise<NodeResult>;

export class IndeterminateError extends Error {
  // Champ déclaré puis affecté, PAS une propriété de paramètre : le serveur
  // tourne sous `--experimental-strip-types` / `erasableSyntaxOnly`, qui
  // retire les types sans les compiler et refuse cette syntaxe.
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(
      `Step \u201c${nodeId}\u201d was changing something outside when the ` +
        `process stopped. The engine does not replay a write: its outcome is ` +
        `unknown and has to be settled by a human.`,
    );
    this.nodeId = nodeId;
  }
}

const PORT_MAIN = 'main';
const PORT_ERROR = 'error';

export interface EngineOptions {
  store: RunStore;
  handlers: Partial<Record<string, NodeHandler>>;
  /** Identité de ce processus, pour les verrous. */
  owner?: string;
  /** Injectable pour rendre les tests déterministes. */
  now?: () => Date;
  /** Injectable : les identifiants d'exécution apparaissent dans les URLs. */
  newId?: () => string;
}

export class Engine {
  private readonly store: RunStore;
  private readonly handlers: Partial<Record<string, NodeHandler>>;
  private readonly owner: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly workflows = new Map<string, WorkflowDef>();
  private readonly orders = new Map<string, NodeDef[]>();

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.handlers = options.handlers;
    this.owner = options.owner ?? `console-${process.pid}`;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  register(workflow: WorkflowDef): void {
    assertAcyclic(workflow);
    this.workflows.set(workflow.id, workflow);
    this.orders.set(workflow.id, topologicalOrder(workflow));
  }

  /** Démarre une exécution et la mène aussi loin qu'elle peut aller. */
  /**
   * The HTTP answer a run decided on, if it reached a `respond` node.
   *
   * ==========================================================================
   * THE PIPELINE ALREADY DECIDES THIS. NOBODY WAS ASKING IT.
   *
   * `01-Ingestion` has four `respond` nodes — 400 invalid schema, 200
   * duplicate, 500 dedup unavailable, 202 accepted — and they exist for one
   * purpose: to be the answer the sender gets. The entry point ignored them and
   * returned a blanket `202 accepted` for every alert it started.
   *
   * So an alert the pipeline REFUSED, naming the missing fields, was reported
   * to its sender as accepted. The sender then has no reason to fix anything,
   * and the alert exists nowhere — the failure shows green at the only place
   * anybody was watching. That is the defect this product is built to make
   * impossible, sitting in its own front door.
   *
   * The LAST response wins: a graph reaching two `respond` nodes has taken a
   * branch after the first, and the later one is the one that describes where
   * it ended up.
   * ==========================================================================
   */
  async responseOf(runId: string): Promise<{ status: number; body: unknown } | null> {
    const steps = await this.store.stepsOf(runId);
    let answer: { status: number; body: unknown } | null = null;
    for (const step of steps) {
      const out = step.output as { __response?: boolean; status?: number; body?: unknown } | null;
      if (out && out.__response === true && typeof out.status === 'number') {
        answer = { status: out.status, body: out.body ?? null };
      }
    }
    return answer;
  }

  async start(workflowId: string, input: unknown, alertId: string | null = null): Promise<RunRecord> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`workflow « ${workflowId} » inconnu`);

    const run: RunRecord = {
      id: this.newId(),
      workflowId: workflow.id,
      // La VERSION est figée à la création : republier un workflow ne doit pas
      // changer le graphe d'une exécution en cours de route.
      workflowVersion: workflow.version,
      status: 'running',
      alertId,
      input,
      startedAt: this.now().toISOString(),
      endedAt: null,
      error: null,
    };
    await this.store.createRun(run);
    await this.store.claimRun(run.id, this.owner);
    return this.drive(run, workflow);
  }

  /**
   * Reprend toutes les exécutions inachevées. À appeler au démarrage.
   *
   * Les exécutions en `waiting` ne sont PAS relancées : elles attendent une
   * décision humaine, et le redémarrage du serveur n'en est pas une.
   */
  async resume(): Promise<RunRecord[]> {
    const resumed: RunRecord[] = [];
    for (const run of await this.store.unfinishedRuns()) {
      const workflow = this.workflows.get(run.workflowId);
      if (!workflow) continue;
      if (run.status === 'waiting') continue;
      if (!(await this.store.claimRun(run.id, this.owner))) continue;
      resumed.push(await this.drive(run, workflow));
    }
    return resumed;
  }

  /** Reprend une exécution suspendue, sur présentation de son jeton. */
  async resumeWait(token: string, payload: unknown): Promise<RunRecord | null> {
    const wait = await this.store.waitByToken(token);
    if (!wait) return null;
    if (wait.resumedAt) return this.store.getRun(wait.runId);

    await this.store.resolveWait(token, payload);
    const run = await this.store.getRun(wait.runId);
    if (!run) return null;
    const workflow = this.workflows.get(run.workflowId);
    if (!workflow) return run;

    // L'étape d'attente se conclut avec ce que l'humain a transmis.
    await this.store.endStep(run.id, wait.nodeId, 1, {
      status: 'ok',
      output: payload,
      port: PORT_MAIN,
    });
    await this.store.setRunStatus(run.id, 'running');
    await this.store.claimRun(run.id, this.owner);
    return this.drive({ ...run, status: 'running' }, workflow);
  }

  /**
   * Fait expirer les attentes échues.
   *
   * L'EXPIRATION N'EST PAS UN ACCORD. Elle emprunte le port `timeout`, une
   * branche distincte que le workflow doit traiter explicitement — vers une
   * escalade, jamais vers l'exécution de l'action. Un moteur qui laisserait
   * l'attente retomber sur `main` transformerait le silence en approbation.
   */
  async sweepExpiredWaits(): Promise<string[]> {
    const expired = await this.store.expiredWaits(this.now().toISOString());
    const touched: string[] = [];
    for (const wait of expired) {
      const run = await this.store.getRun(wait.runId);
      if (!run || run.status !== 'waiting') continue;
      const workflow = this.workflows.get(run.workflowId);
      if (!workflow) continue;

      await this.store.resolveWait(wait.token, null);
      await this.store.endStep(run.id, wait.nodeId, 1, {
        status: 'ok',
        output: { timed_out: true },
        port: 'timeout',
      });
      await this.store.setRunStatus(run.id, 'running');
      await this.store.claimRun(run.id, this.owner);
      await this.drive({ ...run, status: 'running' }, workflow);
      touched.push(run.id);
    }
    return touched;
  }

  // --- Boucle d'exécution ----------------------------------------------------

  private async drive(run: RunRecord, workflow: WorkflowDef): Promise<RunRecord> {
    const journal = await this.store.stepsOf(run.id);

    // Le journal est rejoué AVANT toute exécution : c'est ce qui rend une
    // reprise identique à un premier passage, du point de vue du graphe.
    const outputs = new Map<string, unknown>();
    const ports = new Map<string, string>();
    for (const step of journal) {
      if (step.status === 'ok') {
        outputs.set(step.nodeId, step.output);
        ports.set(step.nodeId, step.port ?? PORT_MAIN);
      }
    }

    // Une écriture interrompue arrête tout, ici, avant la moindre reprise.
    const orphan = journal.find(
      (s) => s.status === 'running' && NODE_EFFECTS[nodeOf(workflow, s.nodeId).type] === 'write',
    );
    if (orphan) {
      await this.store.endStep(run.id, orphan.nodeId, orphan.attempt, {
        status: 'indeterminate',
        error: new IndeterminateError(orphan.nodeId).message,
      });
      await this.store.setRunStatus(run.id, 'failed', new IndeterminateError(orphan.nodeId).message);
      await this.store.releaseRun(run.id, this.owner);
      return { ...run, status: 'failed' };
    }

    // Une lecture ou un calcul interrompu se rejoue : on efface simplement sa
    // trace pour que la boucle le reprenne comme s'il n'avait pas eu lieu.
    for (const step of journal) {
      if (step.status === 'running') {
        await this.store.endStep(run.id, step.nodeId, step.attempt, {
          status: 'skipped',
          error: 'interrupted \u2014 replayed',
        });
      }
    }

    // Nœuds dont on sait qu'ils ne tourneront pas : branche non prise.
    const dead = new Set<string>();
    const order = this.orders.get(workflow.id) ?? topologicalOrder(workflow);

    let guard = 0;
    const MAX_STEPS = 500;

    for (;;) {
      if (++guard > MAX_STEPS) {
        const message = `More than ${MAX_STEPS} steps: the graph is looping.`;
        await this.store.setRunStatus(run.id, 'failed', message);
        await this.store.releaseRun(run.id, this.owner);
        return { ...run, status: 'failed', error: message };
      }

      const next = readyNode(order, workflow, outputs, ports, dead, run.input);
      if (!next) break;

      const attempt = 1;
      const started = this.now().toISOString();
      const record: StepRecord = {
        runId: run.id,
        nodeId: next.node.id,
        attempt,
        status: 'running',
        output: null,
        port: null,
        error: null,
        startedAt: started,
        endedAt: null,
      };
      // L'INTENTION EST DURABLE AVANT L'ACTION. Toute la sûreté des écritures
      // tient à cette ligne : après elle, une interruption laisse une trace.
      await this.store.beginStep(record);

      const handler = this.handlers[next.node.type];
      if (!handler) {
        const message = `Aucun gestionnaire pour le type « ${next.node.type} ».`;
        await this.store.endStep(run.id, next.node.id, attempt, { status: 'failed', error: message });
        await this.store.setRunStatus(run.id, 'failed', message);
        await this.store.releaseRun(run.id, this.owner);
        return { ...run, status: 'failed', error: message };
      }

      let result: NodeResult;
      try {
        result = await handler({
          runId: run.id,
          workflow,
          node: next.node,
          input: next.input,
          outputs,
          alertId: run.alertId,
        });
      } catch (err) {
        const message = (err as Error).message;
        await this.store.endStep(run.id, next.node.id, attempt, {
          status: 'failed',
          error: message,
          port: PORT_ERROR,
        });
        // Une branche d'erreur câblée absorbe l'échec ; sans elle, l'exécution
        // s'arrête. Jamais d'échec silencieux : le journal porte la trace dans
        // les deux cas.
        if (hasPort(workflow, next.node.id, PORT_ERROR)) {
          outputs.set(next.node.id, { error: message });
          ports.set(next.node.id, PORT_ERROR);
          continue;
        }
        await this.store.setRunStatus(run.id, 'failed', message);
        await this.store.releaseRun(run.id, this.owner);
        return { ...run, status: 'failed', error: message };
      }

      if (result.suspend) {
        await this.store.createWait({
          runId: run.id,
          nodeId: next.node.id,
          token: result.suspend.token,
          deadline: new Date(this.now().getTime() + result.suspend.deadlineMs).toISOString(),
          resumedAt: null,
          payload: null,
        });
        // L'étape reste `running` : elle n'a pas abouti, elle attend. La
        // marquer `ok` ferait croire le nœud franchi.
        await this.store.setRunStatus(run.id, 'waiting');
        await this.store.releaseRun(run.id, this.owner);
        return { ...run, status: 'waiting' };
      }

      const port = result.port ?? PORT_MAIN;
      await this.store.endStep(run.id, next.node.id, attempt, {
        status: 'ok',
        output: result.output,
        port,
      });
      outputs.set(next.node.id, result.output);
      ports.set(next.node.id, port);
    }

    await this.store.setRunStatus(run.id, 'done');
    await this.store.releaseRun(run.id, this.owner);
    return { ...run, status: 'done' };
  }
}

// --- Parcours du graphe --------------------------------------------------------

function nodeOf(workflow: WorkflowDef, id: string): NodeDef {
  const node = workflow.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node \u201c${id}\u201d is not in workflow ${workflow.id}`);
  return node;
}

function hasPort(workflow: WorkflowDef, nodeId: string, port: string): boolean {
  return workflow.edges.some((e) => e.from === nodeId && e.fromPort === port);
}

const isTrigger = (node: NodeDef) => node.type.startsWith('trigger.');

/**
 * Ordre topologique des nœuds. Calculé une fois, à l'enregistrement.
 *
 * C'est lui qui rend la détection des nœuds prêts simple ET correcte : parcouru
 * dans cet ordre, un nœud n'est examiné qu'une fois le sort de tous ses amonts
 * connu.
 */
export function topologicalOrder(workflow: WorkflowDef): NodeDef[] {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const queue = workflow.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Le prochain nœud exécutable, ou `null`.
 *
 * ============================================================================
 * POURQUOI CE N'EST PAS « le premier nœud avec un lien actif »
 *
 * C'est ce que faisait la première version, et les définitions de 02 l'ont
 * démasquée : le nœud d'assemblage reçoit les TROIS sources d'enrichissement.
 * Démarrer dès qu'une seule a répondu l'aurait fait travailler sur un tiers
 * des données — sans erreur, sans trace, avec un résultat plausible. Le pire
 * genre de défaut.
 *
 * Un nœud est donc prêt quand :
 *   - le sort de TOUS ses amonts est connu (abouti, ou définitivement écarté) ;
 *   - et au moins un lien entrant est actif.
 *
 * Un nœud dont tous les amonts sont connus et dont AUCUN lien n'est actif est
 * écarté : sa branche n'a pas été prise. C'est ce qui débloque les nœuds
 * situés plus loin, sans avoir à deviner.
 * ============================================================================
 */
function readyNode(
  order: NodeDef[],
  workflow: WorkflowDef,
  outputs: ReadonlyMap<string, unknown>,
  ports: ReadonlyMap<string, string>,
  dead: Set<string>,
  runInput: unknown,
): { node: NodeDef; input: unknown } | null {
  for (const node of order) {
    if (outputs.has(node.id) || dead.has(node.id)) continue;

    const incoming = workflow.edges.filter((e) => e.to === node.id);
    if (incoming.length === 0) {
      if (isTrigger(node)) return { node, input: runInput };
      // Un nœud sans amont qui n'est pas un déclencheur ne s'exécutera jamais.
      dead.add(node.id);
      continue;
    }

    const settled = (id: string) => outputs.has(id) || dead.has(id);
    if (!incoming.every((e) => settled(e.from))) continue;

    const active = incoming.filter((e) => ports.get(e.from) === e.fromPort);
    if (active.length === 0) {
      // Aucune branche entrante n'a été prise : ce nœud ne tournera pas. Le
      // marquer libère ses avals, au lieu de laisser l'exécution s'arrêter en
      // silence — le piège du Switch sans repli, mais côté aval.
      dead.add(node.id);
      continue;
    }
    // Sur une jonction, l'entrée « principale » est celle du premier lien
    // actif ; les autres sorties restent lisibles via `outputs`, et un nœud de
    // jonction les désigne par identifiant plutôt que par ordre d'arrivée.
    return { node, input: outputs.get(active[0].from) };
  }
  return null;
}

/**
 * Refuse un graphe cyclique À LA PUBLICATION, pas à l'exécution.
 *
 * Un cycle ne se manifeste sinon qu'en production, sous la forme d'une
 * exécution qui tourne jusqu'au garde-fou de 500 étapes — un symptôme qui ne
 * désigne pas sa cause.
 */
export function assertAcyclic(workflow: WorkflowDef): void {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of workflow.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const state = new Map<string, 'open' | 'closed'>();
  const walk = (id: string, path: string[]): void => {
    const seen = state.get(id);
    if (seen === 'closed') return;
    if (seen === 'open') {
      throw new Error(`Cycle dans « ${workflow.id} » : ${[...path, id].join(' → ')}`);
    }
    state.set(id, 'open');
    for (const edge of outgoing.get(id) ?? []) walk(edge.to, [...path, id]);
    state.set(id, 'closed');
  };

  for (const node of workflow.nodes) walk(node.id, []);
}
