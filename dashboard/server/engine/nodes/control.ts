/**
 * Nœuds d'orchestration : attente d'un humain, appel d'un sous-workflow.
 *
 * ============================================================================
 * `wait` — LE NŒUD LE PLUS SENSIBLE DE TOUT LE MOTEUR
 *
 * C'est lui qui tient la garantie centrale du produit : « aucune action
 * irréversible n'est déclenchée sans validation humaine explicite ».
 *
 * Il ne rend donc PAS une valeur : il rend une suspension. Le moteur écrit une
 * échéance en base, passe l'exécution en `waiting`, et rend la main. Le
 * processus peut s'arrêter, être déployé, redémarrer : l'attente survit,
 * puisqu'elle vit en base et non en mémoire.
 *
 * TROIS CHOSES QUE CE NŒUD NE FAIT PAS, ET C'EST VOULU :
 *
 *  1. IL NE DÉCIDE PAS À L'EXPIRATION. Le moteur fait sortir une attente échue
 *     par un port `timeout` DISTINCT du port principal. Le workflow doit le
 *     câbler explicitement — vers une escalade. Un port de repli qui
 *     retomberait sur `main` transformerait le silence en accord.
 *
 *  2. IL N'IDENTIFIE PERSONNE. Le jeton prouve qu'on détient le lien, pas
 *     qu'on est untel. L'identité de l'approbateur reste déclarative, comme
 *     elle l'est déjà dans la console — et c'est écrit plutôt que sous-entendu.
 *
 *  3. IL NE DEVINE PAS LA DURÉE. Le délai vient d'une variable de pipeline,
 *     donc modifiable dans l'interface sans redémarrer quoi que ce soit.
 *     C'était `SOC_ISOLATION_TTL_MINUTES` dans un `docker-compose`.
 * ============================================================================
 */

import type { NodeHandler } from '../engine.ts';
import { resolve, type ValueRef } from '../values.ts';
import type { PureDeps } from './pure.ts';

export interface ControlDeps extends PureDeps {
  /** Jeton d'attente. Injectable pour rendre les tests déterministes. */
  newToken?: () => string;
  /**
   * Démarre un sous-workflow et attend son résultat.
   * Fourni par l'assembleur, qui seul connaît le moteur complet.
   */
  runSubflow?: (workflowId: string, input: unknown, alertId: string | null) => Promise<unknown>;
}

export function makeWait(deps: ControlDeps): NodeHandler {
  const newToken = deps.newToken ?? (() => crypto.randomUUID());

  return async (ctx) => {
    const p = ctx.node.params as {
      /** Délai maximal, en minutes. Référence, donc modifiable dans l'interface. */
      timeoutMinutes: ValueRef;
    };
    const minutes = resolve(p.timeoutMinutes, {
      input: ctx.input,
      outputs: ctx.outputs,
      vars: deps.vars(),
      ctx: { now: deps.now().toISOString(), runId: ctx.runId, alertId: ctx.alertId },
    });

    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      // Une attente de durée inconnue est le pire des deux mondes : soit elle
      // n'expire jamais et bloque un cas indéfiniment, soit elle expire tout
      // de suite et escalade une alerte que personne n'a eu le temps de voir.
      throw new Error(
        `\u201c${ctx.node.id}\u201d: invalid timeout (${String(minutes)}). ` +
          `Check the pipeline variable that carries it.`,
      );
    }

    return {
      output: null,
      suspend: { token: newToken(), deadlineMs: minutes * 60_000 },
    };
  };
}

/**
 * Appelle un autre workflow et attend son résultat.
 *
 * CLASSÉ `write`, alors qu'un sous-workflow peut n'être qu'un calcul. C'est
 * délibéré : le moteur ne sait pas ce que l'appelé va faire, et l'appelé peut
 * poster sur Slack ou écrire en base. Le classer `read` autoriserait à le
 * rejouer après une interruption, donc à rejouer ses effets.
 *
 * Le piège n8n correspondant : `mode: "once"` sur un Execute Workflow démarrait
 * le sous-workflow avec ZÉRO item. Il se terminait en `success` sans rien
 * exécuter — 8 occurrences historiques sur cette instance. Ici l'entrée est
 * passée explicitement, et une entrée vide est refusée.
 */
export function makeSubflow(deps: ControlDeps): NodeHandler {
  return async (ctx) => {
    const p = ctx.node.params as { workflowId: string; input?: ValueRef };
    if (typeof p.workflowId !== 'string' || p.workflowId === '') {
      throw new Error(`« ${ctx.node.id} » : « workflowId » manquant.`);
    }
    if (!deps.runSubflow) {
      throw new Error('No sub-workflow runner was given to the engine.');
    }

    const payload = p.input
      ? resolve(p.input, {
          input: ctx.input,
          outputs: ctx.outputs,
          vars: deps.vars(),
          ctx: { now: deps.now().toISOString(), runId: ctx.runId, alertId: ctx.alertId },
        })
      : ctx.input;

    if (payload === undefined || payload === null) {
      throw new Error(
        `\u201c${ctx.node.id}\u201d: nothing to hand to \u201c${p.workflowId}\u201d. A ` +
          `sub-workflow started empty ends in \u201csuccess\u201d having done nothing.`,
      );
    }

    return { output: await deps.runSubflow(p.workflowId, payload, ctx.alertId) };
  };
}

export function controlHandlers(deps: ControlDeps): Record<string, NodeHandler> {
  return {
    wait: makeWait(deps),
    subflow: makeSubflow(deps),
  };
}
