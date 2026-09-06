/**
 * LRU borné — la mécanique commune aux deux caches de la pipeline.
 *
 * Il en existe deux : celui de l'arbitre (`master/arbitration-cache.ts`) et
 * celui des verdicts de détection (`nodes/shared/verdict-cache.ts`). Les deux
 * ont la même exigence — ne jamais grossir sans fin sur un serveur qui tourne
 * des semaines, et pouvoir DIRE combien de fois ils ont répondu — et la même
 * mécanique. La dupliquer aurait donné deux comportements d'éviction qui
 * divergent au premier correctif appliqué d'un seul côté.
 *
 * Ce qui reste propre à chaque cache, et n'a rien à faire ici : la
 * construction de la clé. C'est elle qui porte la sûreté (voir le long
 * commentaire de `arbitration-cache.ts` : une clé trop courte resservirait un
 * verdict périmé sur du code corrigé), et elle dépend entièrement de ce qu'on
 * mémorise.
 *
 * `Map` conserve l'ordre d'insertion : relire une entrée la réinsère en queue,
 * ce qui suffit à obtenir un comportement LRU sans structure dédiée.
 *
 * ============================================================================
 * POURQUOI UNE DATE DE PÉREMPTION EST APPARUE AVEC LA PERSISTANCE
 *
 * Tant que ces caches vivaient en mémoire, un redémarrage les vidait : une
 * entrée avait au plus la durée de vie du processus, et se demander si elle
 * était « encore valable » n'avait pas de sens.
 *
 * Sur le disque, elle survit à tout — y compris à ce qui la rend fausse sans
 * changer sa clé. La clé porte le nom du modèle (`claude-opus-5`), pas le
 * modèle : les fournisseurs déplacent l'instantané servi derrière un nom
 * stable. Un verdict de six mois resservi sous ce nom serait rendu par un
 * moteur qui n'existe plus.
 *
 * D'où un âge maximal. Généreux, parce qu'un cache expiré ne coûte pas une
 * erreur, il coûte un appel : la direction sûre est de repayer, jamais de
 * resservir dans le doute.
 * ============================================================================
 */

/** Une entrée telle qu'elle se range sur le disque. */
export interface LruEntry<T> {
  key: string;
  value: T;
  /** Date d'écriture, en millisecondes depuis l'époque. */
  at: number;
}

export class BoundedLru<T> {
  private readonly entries = new Map<string, LruEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxAgeMs: number | null;
  /** Injectable pour rendre les tests de péremption déterministes. */
  private readonly now: () => number;

  /** Verdicts resservis, et questions posées pour rien. */
  hits = 0;
  misses = 0;
  /**
   * Entrées écartées parce que trop vieilles.
   *
   * Comptées à part des `misses` : « je ne l'avais pas » et « je l'avais mais
   * je ne m'y fie plus » ne disent pas la même chose d'un cache, et seule la
   * seconde justifie de revoir l'âge maximal.
   */
  expired = 0;

  constructor(
    maxEntries: number,
    options: { maxAgeMs?: number | null; now?: () => number } = {}
  ) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxAgeMs = options.maxAgeMs ?? null;
    this.now = options.now ?? Date.now;
  }

  private isStale(entry: LruEntry<T>): boolean {
    if (this.maxAgeMs === null) return false;
    return this.now() - entry.at > this.maxAgeMs;
  }

  get(key: string): T | undefined {
    const found = this.entries.get(key);
    if (found === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (this.isStale(found)) {
      // Retirée tout de suite : la garder ferait recompter la même péremption
      // à chaque lecture, et la ferait occuper une place pour rien.
      this.entries.delete(key);
      this.expired += 1;
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, found);
    this.hits += 1;
    return found.value;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { key, value, at: this.now() });
    this.evict();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Les entrées vivantes, de la plus ancienne à la plus récemment lue.
   *
   * L'ordre compte : c'est celui que `restore` doit retrouver pour que
   * l'éviction reprenne où elle en était. Le sauvegarder à l'envers ferait
   * jeter en premier, au chargement suivant, ce qui vient d'être le plus utile.
   */
  entriesToPersist(): Array<LruEntry<T>> {
    return [...this.entries.values()].filter((entry) => !this.isStale(entry));
  }

  /**
   * Recharge des entrées lues sur le disque.
   *
   * Les périmées sont écartées ICI plutôt qu'à la première lecture : sans ça,
   * un cache rechargé annoncerait deux mille entrées dont la moitié
   * disparaîtrait au premier accès — un chiffre qu'on ne peut pas expliquer.
   *
   * Renvoie ce qui a été gardé et ce qui a été écarté, pour que l'appelant
   * puisse le DIRE plutôt que de laisser croire à une reprise intégrale.
   */
  restore(entries: Array<LruEntry<T>>): { kept: number; dropped: number } {
    let kept = 0;
    let dropped = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.at !== 'number') {
        dropped += 1;
        continue;
      }
      if (this.isStale(entry)) {
        dropped += 1;
        continue;
      }
      this.entries.delete(entry.key);
      this.entries.set(entry.key, entry);
      kept += 1;
    }
    // Un fichier écrit par une version qui tolérait plus d'entrées ne doit pas
    // faire dépasser la borne d'aujourd'hui.
    const before = this.entries.size;
    this.evict();
    dropped += before - this.entries.size;
    return { kept: kept - (before - this.entries.size), dropped };
  }

  /** Vide tout. Les compteurs restent : ils décrivent la session, pas le contenu. */
  clear(): void {
    this.entries.clear();
  }
}
