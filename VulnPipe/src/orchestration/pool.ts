/**
 * Exécution en parallèle BORNÉE.
 *
 * ============================================================================
 * POURQUOI PAS `Promise.all`
 *
 * La pipeline analysait ses routes une par une. Sur un dépôt de quarante
 * routes dont trente demandent un appel au modèle, à deux secondes l'appel,
 * la détection prenait une minute — passée à attendre le réseau, pas à
 * calculer. Les appels sont indépendants : rien ne justifiait de les
 * sérialiser.
 *
 * `Promise.all` sur la liste entière serait l'erreur inverse, et elle est
 * documentée dans la table des pièges de `CLAUDE.md` (côté console, sur les
 * détails de run n8n) : ouvrir cent requêtes d'un coup fait expirer les
 * dernières avant qu'elles soient servies, et on perd une analyse par
 * LENTEUR, pas par échec. Ici ce serait pire : le palier gratuit de Gemini
 * plafonne à vingt requêtes par minute, et trente appels simultanés se
 * feraient jeter en bloc.
 *
 * D'où une fenêtre glissante : au plus N tâches en vol, la suivante démarre
 * dès qu'une place se libère.
 *
 * MESURÉ, dépôt de test (4 adresses, appel simulé à 2 s), scan de bout en bout :
 *
 *     concurrence  1 : 8.14 s
 *     concurrence  2 : 4.15 s
 *     concurrence  4 : 2.15 s
 *     concurrence  8 : 2.15 s
 *
 * Le gain est linéaire jusqu'à la taille du lot, puis plat : à huit de front
 * pour quatre adresses il n'y a plus rien à recouvrir. C'est la raison pour
 * laquelle le devis compte des VAGUES et non une division (`estimator.ts`).
 *
 * DEUX GARANTIES QUE CE MODULE DOIT TENIR
 *
 *  1. **Les résultats sortent dans l'ordre des entrées.** L'ordre d'ACHÈVEMENT
 *     dépend de la latence du réseau ; un rapport dont les signalements
 *     changent d'ordre à chaque exécution est un rapport qu'on ne peut ni
 *     comparer ni tester. Le direct, lui, reste dans l'ordre où les choses
 *     arrivent — c'est son intérêt.
 *  2. **Aucune tâche n'est perdue.** On renvoie l'issue de chacune, succès ou
 *     échec, à la manière de `Promise.allSettled` : une route non analysée
 *     n'est pas une route saine, elle doit ressortir comme un échec.
 * ============================================================================
 */

export type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

/**
 * Concurrence par défaut de la détection.
 *
 * Quatre, et pas plus, parce que la valeur doit rester sûre sur le moteur le
 * plus contraint qu'on sache être utilisé : le palier gratuit de Gemini
 * (20 requêtes/minute). À quatre en vol pour des appels de deux à cinq
 * secondes, on reste sous le plafond, et `withRetry` couvre le dépassement
 * ponctuel. Qui a un quota confortable monte la valeur dans les réglages ;
 * le défaut ne doit pas casser l'installation la plus modeste.
 */
export const DEFAULT_DETECTION_CONCURRENCY = 4;

/** Bornes acceptées pour le réglage. */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

/**
 * Ramène une valeur quelconque dans les bornes, ou `null` si elle n'est pas
 * un entier utilisable.
 *
 * Renvoie `null` plutôt qu'une valeur de repli : l'appelant doit pouvoir
 * DIRE que l'entrée était invalide. Remplacer silencieusement `"beaucoup"`
 * par 4 ferait croire au réglage appliqué.
 */
export function normalizeConcurrency(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric)) return null;
  if (numeric < MIN_CONCURRENCY || numeric > MAX_CONCURRENCY) return null;
  return numeric;
}

/**
 * Applique `task` à chaque élément, au plus `concurrency` à la fois.
 *
 * @param onSettled appelé dès qu'une tâche retombe, dans l'ordre d'ACHÈVEMENT
 *   — c'est le crochet du direct. Les valeurs renvoyées, elles, restent dans
 *   l'ordre des entrées.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  concurrency: number,
  task: (item: In, index: number) => Promise<Out>,
  onSettled?: (outcome: Settled<Out>, item: In, index: number) => void
): Promise<Array<Settled<Out>>> {
  const results: Array<Settled<Out>> = new Array(items.length);
  if (items.length === 0) return results;

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index]!;
      let outcome: Settled<Out>;
      try {
        outcome = { status: 'fulfilled', value: await task(item, index) };
      } catch (reason) {
        outcome = { status: 'rejected', reason };
      }
      results[index] = outcome;
      // Le crochet est appelé APRÈS l'écriture du résultat : un observateur
      // qui inspecterait `results` depuis le crochet ne doit jamais y voir
      // un trou pour la tâche qu'on vient de lui annoncer.
      onSettled?.(outcome, item, index);
    }
  };

  // Les ouvriers ne rejettent jamais (tout est capté ci-dessus) : `Promise.all`
  // ici ne peut donc pas court-circuiter et abandonner des tâches en vol.
  await Promise.all(Array.from({ length: limit }, () => worker()));

  return results;
}
