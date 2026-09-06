/**
 * Nœuds purs : déclencheurs, logique, mise en forme.
 *
 * ============================================================================
 * CE QUE « PUR » VEUT DIRE ICI, ET POURQUOI ÇA COMPTE
 *
 * Aucun de ces nœuds ne touche au monde extérieur. Le moteur peut donc les
 * rejouer librement après une interruption : recalculer coûte quelques
 * microsecondes et ne produit aucun effet de bord. C'est ce qui rend la
 * reprise après panne gratuite pour l'essentiel du graphe.
 *
 * ============================================================================
 * DEUX PIÈGES n8n RENDUS IMPOSSIBLES PAR CONSTRUCTION
 *
 *  1. LE SWITCH SANS SORTIE DE REPLI. Sous n8n, un Switch dont aucune règle ne
 *     correspondait sortait zéro item sur TOUTES ses sorties, et le flux
 *     s'arrêtait en affichant `success`. Ici `fallbackPort` est un champ
 *     OBLIGATOIRE du type : un switch sans repli ne compile pas.
 *
 *  2. `transform` N'EXÉCUTE PAS DE CODE FOURNI EN DONNÉE. Il désigne une
 *     fonction TypeScript enregistrée, par son nom. Les 973 lignes des 24
 *     nœuds `code` deviennent des fonctions typées et testées, pas des chaînes
 *     évaluées à l'exécution. Une définition de workflow reste de la donnée ;
 *     elle ne doit jamais pouvoir devenir du code.
 * ============================================================================
 */

import type { NodeHandler } from '../engine.ts';
import {
  evaluate,
  resolve,
  type Condition,
  type ResolveScope,
  type ValueRef,
} from '../values.ts';

/**
 * Ce qu'une transformation sait de l'exécution qui l'appelle.
 *
 * IL PASSE PAR L'APPEL, jamais par une variable de module. Une valeur propre à
 * une exécution rangée dans un global serait fausse dès que deux alertes sont
 * traitées en même temps — le cas normal — et elle l'était déjà quand il n'y en
 * avait qu'une : personne n'avait écrit l'affectation, et `run_id` partait vide
 * dans le journal d'audit sans que rien ne le dise.
 *
 * `scopeOf`, trois fonctions plus bas, lisait déjà `ctx.runId` correctement :
 * le bon motif existait à côté de celui qui ne marchait pas.
 */
export interface TransformRun {
  /** Identifiant de l'exécution en cours. */
  runId: string;
}

/**
 * Fonctions de transformation enregistrées.
 *
 * Une fonction PURE : mêmes entrées, mêmes sorties, aucun effet de bord. C'est
 * ce qui autorise le moteur à la rejouer sans réfléchir — et ce qui oblige le
 * contexte d'exécution à ARRIVER en argument plutôt qu'être lu quelque part.
 */
export type TransformFn = (
  input: unknown,
  vars: ReadonlyMap<string, unknown>,
  run: TransformRun,
) => unknown;

export class TransformRegistry {
  private readonly fns = new Map<string, TransformFn>();

  register(name: string, fn: TransformFn): this {
    if (this.fns.has(name)) throw new Error(`transform \u201c${name}\u201d is already registered`);
    this.fns.set(name, fn);
    return this;
  }

  get(name: string): TransformFn | undefined {
    return this.fns.get(name);
  }

  /** Noms connus — l'onglet Workflow les propose au lieu d'un champ libre. */
  names(): string[] {
    return [...this.fns.keys()].sort();
  }
}

/** Ce que les gestionnaires ont besoin de savoir, en plus du contexte du nœud. */
export interface PureDeps {
  transforms: TransformRegistry;
  /** Variables de pipeline, relues à CHAQUE exécution : les changer prend effet tout de suite. */
  vars: () => ReadonlyMap<string, unknown>;
  now: () => Date;
}

function scopeOf(ctx: Parameters<NodeHandler>[0], deps: PureDeps): ResolveScope {
  return {
    input: ctx.input,
    outputs: ctx.outputs,
    vars: deps.vars(),
    ctx: {
      now: deps.now().toISOString(),
      runId: ctx.runId,
      alertId: ctx.alertId,
      workflowId: ctx.workflow.id,
    },
  };
}

// --- Déclencheurs --------------------------------------------------------------

/**
 * Les trois déclencheurs passent leur entrée telle quelle.
 *
 * Ils existent quand même comme nœuds à part entière : c'est ce qui permet au
 * journal de montrer AVEC QUOI une exécution a démarré. Sous n8n, un
 * sous-workflow démarré à zéro item (`mode: "once"`) se terminait en `success`
 * sans rien exécuter, et il fallait un onglet entier pour le détecter.
 */
export const triggerHandler: NodeHandler = async (ctx) => ({ output: ctx.input });

// --- Logique -------------------------------------------------------------------

export function makeTransform(deps: PureDeps): NodeHandler {
  return async (ctx) => {
    const name = ctx.node.params.fn;
    if (typeof name !== 'string') {
      throw new Error(`\u201c${ctx.node.id}\u201d: missing \u201cfn\u201d parameter.`);
    }
    const fn = deps.transforms.get(name);
    if (!fn) {
      // On NOMME la fonction manquante et on liste ce qui existe : un
      // « transformation inconnue » nu enverrait fouiller le code.
      throw new Error(
        `Unknown transform \u201c${name}\u201d. Registered: ` +
          `${deps.transforms.names().join(', ') || '(aucune)'}.`,
      );
    }
    // Un nœud de JONCTION déclare ses entrées par référence : la fonction
    // reçoit alors un objet nommé plutôt que la sortie du premier amont
    // arrivé. Sans ça, `assembleEnriched` ne verrait qu'une des trois sources
    // — et rien ne le dirait.
    const wiring = ctx.node.params.inputs as Record<string, ValueRef> | undefined;
    if (wiring) {
      const scope = scopeOf(ctx, deps);
      const named: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(wiring)) named[key] = resolve(ref, scope);
      return { output: fn(named, deps.vars(), { runId: ctx.runId }) };
    }
    return { output: fn(ctx.input, deps.vars(), { runId: ctx.runId }) };
  };
}

export function makeSet(deps: PureDeps): NodeHandler {
  return async (ctx) => {
    const assignments = (ctx.node.params.assignments ?? []) as Array<{
      key: string;
      value: ValueRef;
    }>;
    const mode = (ctx.node.params.mode ?? 'merge') as 'merge' | 'replace';
    const scope = scopeOf(ctx, deps);

    const base =
      mode === 'merge' && ctx.input !== null && typeof ctx.input === 'object'
        ? { ...(ctx.input as Record<string, unknown>) }
        : {};

    for (const { key, value } of assignments) {
      base[key] = resolve(value, scope);
    }
    return { output: base };
  };
}

export function makeIf(deps: PureDeps): NodeHandler {
  return async (ctx) => {
    const condition = ctx.node.params.condition as Condition | undefined;
    if (!condition) throw new Error(`\u201c${ctx.node.id}\u201d: missing \u201ccondition\u201d parameter.`);
    const taken = evaluate(condition, scopeOf(ctx, deps));
    // L'entrée traverse le nœud : un `if` teste, il ne transforme pas.
    return { output: ctx.input, port: taken ? 'true' : 'false' };
  };
}

export function makeSwitch(deps: PureDeps): NodeHandler {
  return async (ctx) => {
    const cases = (ctx.node.params.cases ?? []) as Array<{ port: string; when: Condition }>;
    const fallbackPort = ctx.node.params.fallbackPort;
    if (typeof fallbackPort !== 'string' || fallbackPort === '') {
      // Le piège n8n, rendu impossible : pas de repli, pas d'exécution.
      throw new Error(
        `« ${ctx.node.id} » : un switch DOIT avoir une sortie de repli. Sans ` +
          `it, an unexpected value stops the flow while reporting \u201csuccess\u201d.`,
      );
    }

    const scope = scopeOf(ctx, deps);
    for (const branch of cases) {
      if (evaluate(branch.when, scope)) return { output: ctx.input, port: branch.port };
    }
    return { output: ctx.input, port: fallbackPort };
  };
}

/**
 * Fusionne les sorties de plusieurs nœuds nommés.
 *
 * Les sources sont désignées par IDENTIFIANT, pas par ordre d'arrivée : sous
 * n8n, l'entrée 1 et l'entrée 2 d'un Merge se distinguaient par un numéro, et
 * réordonner les liens intervertissait silencieusement les données.
 */
export const mergeHandler: NodeHandler = async (ctx) => {
  const sources = (ctx.node.params.sources ?? []) as string[];
  const merged: Record<string, unknown> = {};
  for (const nodeId of sources) {
    const value = ctx.outputs.get(nodeId);
    if (value !== null && typeof value === 'object') Object.assign(merged, value);
  }
  return { output: merged };
};

export const noopHandler: NodeHandler = async (ctx) => ({ output: ctx.input });

/**
 * Prépare une réponse HTTP.
 *
 * Le code de statut est un PARAMÈTRE de premier rang, pas une option enfouie :
 * sous n8n il vivait dans `options`, et l'oublier faisait répondre 200 à tout,
 * y compris aux rejets de schéma.
 */
export function makeRespond(deps: PureDeps): NodeHandler {
  return async (ctx) => {
    const status = ctx.node.params.status;
    if (typeof status !== 'number') {
      throw new Error(`\u201c${ctx.node.id}\u201d: \u201cstatus\u201d must be a number.`);
    }

    // `fn` BUILDS THE BODY, and it used to be ignored.
    //
    // `respond-400` is declared with `fn: 'rejectionBody'` and a `body` of
    // constant `null`. This handler read only `body`, so the sender was told
    // `400` with a null body — while `rejectionBody` had already computed the
    // sentence naming the missing fields, and it went nowhere.
    //
    // That is the alert contract's own promise broken at the last inch: "Says
    // WHAT is missing, not 'invalid'" is written on the node, and the thing
    // that says it was never called.
    const name = ctx.node.params.fn;
    if (typeof name === 'string') {
      const fn = deps.transforms.get(name);
      if (!fn) {
        throw new Error(
          `Unknown transform \u201c${name}\u201d. Registered: `
          + `${deps.transforms.names().join(', ') || '(none)'}.`,
        );
      }
      return {
        output: { __response: true, status, body: fn(ctx.input, deps.vars(), { runId: ctx.runId }) },
      };
    }

    const body = ctx.node.params.body as ValueRef | undefined;
    return {
      output: {
        __response: true,
        status,
        body: body ? resolve(body, scopeOf(ctx, deps)) : ctx.input,
      },
    };
  };
}

/** Tous les gestionnaires purs, prêts à être passés au moteur. */
export function pureHandlers(deps: PureDeps): Record<string, NodeHandler> {
  return {
    'trigger.webhook': triggerHandler,
    'trigger.subflow': triggerHandler,
    'trigger.error': triggerHandler,
    transform: makeTransform(deps),
    set: makeSet(deps),
    if: makeIf(deps),
    switch: makeSwitch(deps),
    merge: mergeHandler,
    noop: noopHandler,
    respond: makeRespond(deps),
  };
}
