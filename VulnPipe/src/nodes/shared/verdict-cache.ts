/**
 * Cache des verdicts de détection : ne pas repayer une question déjà posée.
 *
 * ============================================================================
 * POURQUOI CE CACHE MANQUAIT, ET POURQUOI C'EST CELUI QUI COMPTE
 *
 * `master/arbitration-cache.ts` évite de repayer l'ARBITRE. Mais l'arbitre ne
 * voit que 10 à 15 % du volume (`CLAUDE.md` §2) : les 85 % restants sont les
 * appels de DÉTECTION, un par route que le scanner déterministe n'a pas su
 * trancher. Relancer un scan sur un dépôt inchangé les repayait tous — le
 * cache posé en Phase 5 couvrait donc la petite moitié de la facture, et
 * laissait la grande intacte.
 *
 * CE QUI ENTRE DANS LA CLÉ
 *
 * Exactement la question posée au modèle : le prompt système, le prompt
 * utilisateur, le fournisseur et le modèle. Rien d'autre, et surtout aucun
 * identifiant de route.
 *
 * C'est la même règle de sûreté que pour l'arbitre, pour la même raison. Une
 * clé du genre `IDOR:GET:/orders/:id` resservirait « vulnérable » sur du code
 * qu'on vient de corriger, ou « sain » sur du code qu'on vient de casser : un
 * faux négatif servi instantanément et gratuitement, le pire mode de
 * défaillance possible ici. Le prompt utilisateur contient le code réellement
 * montré au modèle ; le corriger change la clé, donc le verdict est
 * réellement recalculé. Dans le doute, le cache ne répond pas et on repaie.
 *
 * Le fournisseur et le modèle entrent aussi dans la clé : deux modèles ne
 * rendent pas le même verdict sur le même code, et resservir celui de l'un
 * sous le nom de l'autre fausserait toute mesure de calibration.
 *
 * MESURÉ, dépôt de test (4 adresses, dont 2 tranchées par le scanner) :
 *
 *     sans cache, deux scans : 2 appels facturés, puis 2 à nouveau
 *     avec cache,  deux scans : 2 appels facturés, puis 0
 *
 * Le second scan sur du code inchangé ne facture plus rien du tout.
 *
 * PORTÉE
 *
 * En mémoire, bornée, vidée au redémarrage — comme l'état des runs et comme le
 * cache d'arbitrage. La persistance est V1.1 du ROADMAP.
 * ============================================================================
 */

import { createHash } from 'node:crypto';

import { BoundedLru } from '../../shared/bounded-lru.ts';

/**
 * Plus haut que les 500 de l'arbitre : ce cache voit une entrée par ROUTE
 * analysée, là où l'arbitre n'en voit qu'une par signalement retenu.
 */
export const DEFAULT_MAX_ENTRIES = 2_000;

export interface VerdictCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, verdict: T): void;
}

export interface VerdictCacheKeyInput {
  provider: string;
  model: string;
  /** Le prompt système, mot pour mot. */
  system: string;
  /** Le prompt utilisateur, mot pour mot — c'est lui qui porte le code. */
  user: string;
  /**
   * Empreinte du schéma de sortie attendu.
   *
   * AJOUTÉ AVEC LA PERSISTANCE, et indispensable seulement à cause d'elle. En
   * mémoire, un redémarrage vidait le cache : une entrée ne pouvait pas
   * survivre à un déploiement qui modifie le schéma. Sur le disque, si — et
   * elle resservirait alors un verdict à qui manque un champ que le code
   * d'aujourd'hui lit, sans que sa clé ait bougé. Le schéma fait donc partie
   * de la question posée, au même titre que le prompt.
   */
  schema?: unknown;
}

/**
 * Empreinte de la question posée au détecteur.
 *
 * Le séparateur ` ` ne peut apparaître dans aucun des champs : sans lui,
 * deux découpages différents des mêmes caractères donneraient la même clé.
 */
export function verdictCacheKey(input: VerdictCacheKeyInput): string {
  const parts = [
    'v2',
    input.provider,
    input.model,
    input.system,
    input.user,
    input.schema === undefined ? '' : JSON.stringify(input.schema),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

/** Cache en mémoire, borné, à éviction du plus ancien accès. */
export class InMemoryVerdictCache implements VerdictCache {
  /** Exposé pour la persistance — voir `master/arbitration-cache.ts`. */
  readonly lru: BoundedLru<unknown>;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES, options: { maxAgeMs?: number | null } = {}) {
    this.lru = new BoundedLru<unknown>(maxEntries, { maxAgeMs: options.maxAgeMs });
  }

  /** Verdicts resservis, donc non repayés. */
  get hits(): number {
    return this.lru.hits;
  }

  get misses(): number {
    return this.lru.misses;
  }

  /** Entrées écartées pour cause d'âge — distinct d'une entrée jamais vue. */
  get expired(): number {
    return this.lru.expired;
  }

  get<T>(key: string): T | undefined {
    return this.lru.get(key) as T | undefined;
  }

  set<T>(key: string, verdict: T): void {
    this.lru.set(key, verdict);
  }

  get size(): number {
    return this.lru.size;
  }
}
