/**
 * Persistance des caches de verdicts.
 *
 * ============================================================================
 * LA DÉCISION DE STOCKAGE, PRISE ICI
 *
 * `arbitration-cache.ts` disait « la persistance viendra avec le point 5 du
 * ROADMAP, qui demande une décision de stockage non tranchée ». La voici, et
 * son argument tient en une phrase : **un cache n'est pas une source de
 * vérité**. Le perdre coûte de l'argent, jamais une erreur — la pipeline
 * repose la question et obtient le même verdict.
 *
 * Donc pas de base de données. La console en a une (Postgres) ; VulnPipe n'en
 * a pas, et lui en imposer une pour ranger des données jetables serait payer
 * une dépendance, un schéma, des migrations et un service de plus au prix
 * d'une durabilité dont on n'a pas besoin. Un fichier suffit, et il se range
 * là où le magasin de clés se range déjà : `.vulnpipe/`, à côté de
 * `keys.json`. En Docker, ce dossier est le volume `vulnpipe-keys` monté sur
 * `/data` — le cache y survit donc à `docker compose down` sans qu'aucun
 * montage soit ajouté.
 *
 * ============================================================================
 * CE QUE LA PERSISTANCE CASSE, ET QU'IL FAUT RATTRAPER
 *
 * En mémoire, un redémarrage vidait tout. C'était un filet de sécurité que
 * personne n'avait choisi mais dont tout dépendait : une entrée ne pouvait pas
 * survivre au code qui l'avait produite. Sur le disque, si.
 *
 *  1. **Une entrée peut survivre à un changement de pipeline.** La clé porte
 *     le prompt, donc le code analysé — mais pas la forme de ce qui est
 *     STOCKÉ. Changer `IDOR_OUTPUT_SCHEMA`, ou ce que le node range dans le
 *     verdict, rendrait les entrées d'hier illisibles ou incomplètes sans que
 *     leur clé bouge. D'où `version` dans l'en-tête du fichier : elle décrit
 *     la forme rangée, et un fichier d'une autre version est IGNORÉ EN BLOC,
 *     jamais lu de travers.
 *
 *  2. **Un fichier peut être tronqué.** Une écriture interrompue laisserait un
 *     JSON incomplet, et un cache qui fait planter le service au démarrage
 *     serait bien pire que pas de cache. Écriture atomique (fichier temporaire
 *     puis `rename`, qui est atomique sur un même système de fichiers), et à
 *     la lecture, TOUTE anomalie ramène à « pas de cache » avec la raison.
 *
 *  3. **Il n'y a plus d'échappatoire.** Quand on soupçonnait un verdict
 *     figé, on redémarrait le service. Ça ne suffit plus : d'où
 *     `DELETE /cache` et le bouton correspondant dans les Réglages. Ajouter
 *     de la mémoire à un produit oblige à ajouter l'oubli.
 *
 *  4. **Deux processus peuvent écrire le même fichier** (file BullMQ,
 *     plusieurs workers). Le dernier écrit gagne, et l'autre perd ses entrées.
 *     Pour un cache c'est acceptable — on repaie — et le `rename` garantit que
 *     personne ne lit un état intermédiaire. Ce serait inacceptable pour une
 *     source de vérité ; c'en est une raison de plus de n'en pas faire une.
 * ============================================================================
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BoundedLru, LruEntry } from './bounded-lru.ts';

/**
 * Forme de ce qui est rangé.
 *
 * À INCRÉMENTER dès que change la structure d'un verdict mémorisé — le schéma
 * de sortie d'un détecteur, les champs d'un `ArbitratedFinding`, la façon dont
 * une clé est composée. Un oubli ici ne casse rien bruyamment : il resservirait
 * des verdicts mal formés, ce qui est exactement le genre de panne silencieuse
 * que ce produit refuse.
 */
export const CACHE_FORMAT_VERSION = 1;

/**
 * Âge maximal d'une entrée : trente jours.
 *
 * Pourquoi une limite : voir `bounded-lru.ts` — un nom de modèle est stable,
 * le modèle derrière ne l'est pas. Pourquoi celle-là plutôt qu'une autre :
 * elle est plus longue que n'importe quel cycle de développement (le code
 * bouge, donc la clé bouge, bien avant), et plus courte que l'intervalle
 * typique entre deux déplacements d'instantané chez un fournisseur. Une entrée
 * périmée coûte un appel, pas une erreur : dans le doute on repaie.
 */
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Plafond de taille du fichier, en octets.
 *
 * Les bornes du LRU comptent des ENTRÉES ; ce sont des octets qui remplissent
 * un disque. Un verdict est court, mais rien ne garantit qu'un modèle ne
 * renverra pas un raisonnement de dix mille caractères. Au-delà, on écrit ce
 * qui tient — les plus récemment utiles — et on le dit.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

interface CacheFile<T> {
  version: number;
  /** Quel cache : lire celui de l'arbitre comme celui des détections serait absurde. */
  kind: string;
  written_at: string;
  entries: Array<LruEntry<T>>;
}

export interface CacheStoreOptions {
  /** Chemin du fichier. Absent = résolu depuis l'environnement. */
  path?: string;
  /** Identifiant du cache, écrit et vérifié dans l'en-tête. */
  kind: string;
}

/** Dossier d'état de VulnPipe — le même que celui du magasin de clés. */
export function cacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VULNPIPE_CACHE_DIR) return env.VULNPIPE_CACHE_DIR;
  // Aligné sur `keystore.ts` : si le déploiement a déplacé le magasin de clés,
  // le cache le suit. Deux dossiers d'état pour un même service seraient une
  // occasion de n'en sauvegarder qu'un.
  if (env.VULNPIPE_KEYSTORE) return dirname(env.VULNPIPE_KEYSTORE);
  return join(process.cwd(), '.vulnpipe');
}

export function cachePath(kind: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDirectory(env), `cache-${kind}.json`);
}

/** Ce que le chargement a trouvé — destiné à être DIT, pas seulement journalisé. */
export interface LoadOutcome {
  kept: number;
  dropped: number;
  /** Pourquoi rien n'a été chargé, quand c'est le cas. `null` = tout va bien. */
  why: string | null;
}

/**
 * Recharge un cache depuis le disque.
 *
 * Ne lève JAMAIS. Un fichier absent, illisible, corrompu ou d'une autre
 * version donne « aucune entrée reprise » avec la raison : le service démarre,
 * et le premier scan repaie ce qu'il aurait pu éviter. C'est la seule
 * dégradation acceptable pour un cache.
 */
export function loadCache<T>(
  lru: BoundedLru<T>,
  options: CacheStoreOptions,
  env: NodeJS.ProcessEnv = process.env
): LoadOutcome {
  const file = options.path ?? cachePath(options.kind, env);

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Pas de fichier au premier démarrage : ce n'est pas une anomalie, et le
    // signaler comme telle ferait chercher un problème qui n'existe pas.
    if (code === 'ENOENT') return { kept: 0, dropped: 0, why: null };
    return { kept: 0, dropped: 0, why: `cache unreadable (${code ?? 'unknown'})` };
  }

  let parsed: CacheFile<T>;
  try {
    parsed = JSON.parse(raw) as CacheFile<T>;
  } catch {
    return { kept: 0, dropped: 0, why: 'cache file is not valid JSON — starting empty' };
  }

  if (parsed?.version !== CACHE_FORMAT_VERSION) {
    // Ignoré EN BLOC : lire des entrées d'une autre forme, c'est resservir des
    // verdicts mal formés sur du code qu'on croit avoir vérifié.
    return {
      kept: 0,
      dropped: Array.isArray(parsed?.entries) ? parsed.entries.length : 0,
      why: `cache written by another format (v${parsed?.version ?? '?'}) — starting empty`,
    };
  }

  if (parsed.kind !== options.kind) {
    return { kept: 0, dropped: 0, why: `cache file belongs to "${parsed.kind}" — ignored` };
  }

  if (!Array.isArray(parsed.entries)) {
    return { kept: 0, dropped: 0, why: 'cache file has no entries — starting empty' };
  }

  const { kept, dropped } = lru.restore(parsed.entries);
  return { kept, dropped, why: null };
}

/** Ce que l'écriture a fait. */
export interface SaveOutcome {
  written: number;
  /** Entrées laissées de côté faute de place. */
  truncated: number;
  /** Pourquoi rien n'a été écrit, quand c'est le cas. */
  why: string | null;
}

/**
 * Écrit un cache sur le disque, de façon atomique.
 *
 * Ne lève JAMAIS non plus : un disque plein ou un dossier en lecture seule ne
 * doit pas faire échouer un scan qui, lui, a parfaitement réussi.
 */
export function saveCache<T>(
  lru: BoundedLru<T>,
  options: CacheStoreOptions,
  env: NodeJS.ProcessEnv = process.env
): SaveOutcome {
  const file = options.path ?? cachePath(options.kind, env);
  let entries = lru.entriesToPersist();
  let truncated = 0;

  let body = serialize(options.kind, entries);
  // Trop gros : on retire les plus anciennes — celles que le LRU jetterait de
  // toute façon en premier — jusqu'à tenir. Écrire un fichier qu'on refusera
  // de relire n'aurait aucun sens.
  while (body.length > MAX_FILE_BYTES && entries.length > 0) {
    const removed = Math.max(1, Math.ceil(entries.length * 0.1));
    entries = entries.slice(removed);
    truncated += removed;
    body = serialize(options.kind, entries);
  }

  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, body, { mode: 0o600 });
    // `rename` sur le même système de fichiers est atomique : un lecteur voit
    // l'ancien fichier ou le nouveau, jamais un fichier à moitié écrit.
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    // Le temporaire ne doit pas rester à traîner si le renommage a échoué.
    try {
      unlinkSync(temporary);
    } catch {
      // rien à faire : on est déjà dans le chemin d'échec
    }
    return { written: 0, truncated, why: (error as Error).message };
  }

  return { written: entries.length, truncated, why: null };
}

function serialize<T>(kind: string, entries: Array<LruEntry<T>>): string {
  const file: CacheFile<T> = {
    version: CACHE_FORMAT_VERSION,
    kind,
    written_at: new Date().toISOString(),
    entries,
  };
  return JSON.stringify(file);
}

/** Efface le fichier. Absent = déjà effacé, ce n'est pas une erreur. */
export function deleteCacheFile(options: CacheStoreOptions, env: NodeJS.ProcessEnv = process.env): void {
  const file = options.path ?? cachePath(options.kind, env);
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Écrivain différé.
 *
 * POURQUOI DIFFÉRÉ. Un scan de quarante routes produit quarante écritures ;
 * sérialiser deux mille entrées à chaque fois mettrait du disque sur le chemin
 * critique d'un appel réseau, pour un fichier qui serait réécrit une seconde
 * plus tard. On regroupe donc, et on garantit une écriture finale à l'arrêt —
 * c'est elle qui fait toute la différence entre « le cache survit » et « le
 * cache survit sauf au dernier scan », qui est justement le seul qui compte
 * quand on relance juste après.
 */
export class DebouncedCacheWriter<T> {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  // Champs DÉCLARÉS puis assignés, jamais des « parameter properties ».
  // Celles-ci passent `tsc` et vitest, et font échouer le service AU
  // DÉMARRAGE sous `node --experimental-strip-types`, qui retire les types
  // sans compiler. Le piège est dans la table de CLAUDE.md, et il a été
  // retouché ici : les tests ne l'attrapent pas, seule une exécution réelle
  // le fait.
  private readonly lru: BoundedLru<T>;
  private readonly options: CacheStoreOptions;
  private readonly delayMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    lru: BoundedLru<T>,
    options: CacheStoreOptions,
    delayMs = 2_000,
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.lru = lru;
    this.options = options;
    this.delayMs = delayMs;
    this.env = env;
  }

  /** Signale un changement. L'écriture suivra, groupée. */
  touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
    // Ce minuteur ne doit jamais empêcher le processus de s'arrêter : c'est
    // `flush()` à l'arrêt qui garantit la dernière écriture, pas lui.
    this.timer.unref?.();
  }

  /**
   * Écrit tout de suite si quelque chose a changé.
   *
   * `force` écrit même sans changement annoncé. C'est ce que `close()`
   * utilise, et ce n'est pas un détail de confort : le drapeau `dirty` n'est
   * levé que par `touch()`, donc toute entrée posée dans le LRU sans passer
   * par là serait perdue à l'arrêt — silencieusement. La garantie de dernière
   * écriture ne doit dépendre d'aucune comptabilité tenue ailleurs.
   */
  flush(options: { force?: boolean } = {}): SaveOutcome | null {
    if (!this.dirty && !options.force) return null;
    // Rien à ranger : écrire un fichier vide ne rendrait service à personne,
    // et effacerait ce qu'un autre processus vient peut-être d'écrire.
    if (options.force && !this.dirty && this.lru.size === 0) return null;
    this.dirty = false;
    return saveCache(this.lru, this.options, this.env);
  }

  /** Écrit une dernière fois et arrête le minuteur. */
  close(): SaveOutcome | null {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.flush({ force: true });
  }

  /**
   * Efface le contenu ET le fichier — l'échappatoire que la mémoire offrait.
   *
   * Le LRU est vidé AVANT le fichier : un `close()` qui surviendrait entre les
   * deux écrirait un cache vide, jamais l'ancien contenu. Un bouton d'oubli
   * que la fermeture défait serait un bouton qui ment.
   */
  forget(): void {
    this.lru.clear();
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    deleteCacheFile(this.options, this.env);
  }
}
