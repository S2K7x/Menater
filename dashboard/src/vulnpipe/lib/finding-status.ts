/**
 * Statut d'une faille : corrigée, risque accepté, fausse alerte.
 *
 * ============================================================================
 * POURQUOI
 *
 * Point 6 de la file d'attente du `ROADMAP.md`. Sans statut, chaque scan
 * repropose les mêmes points à l'identique, y compris ceux qu'on a déjà
 * examinés et écartés en connaissance de cause. C'est le mécanisme classique
 * de la fatigue d'alerte : au bout de trois scans, on ne lit plus rien.
 *
 * LE PIÈGE À NE PAS REPRODUIRE — noté dans le ROADMAP avant d'écrire ce fichier
 *
 * Un outil qui compte « failles corrigées » en incluant les alertes écartées
 * offre un moyen d'améliorer son score en masquant des problèmes. Ici :
 *   - `fixRate()` ne compte QUE `fixed`, et son dénominateur n'inclut que
 *     `fixed` et `open`. Écarter une faille ne fait pas monter le taux ;
 *   - les écartées sont comptées à part et RESTENT AFFICHÉES. Rien n'est
 *     jamais supprimé de l'écran.
 *
 * Et le garde-fou qui compte le plus : une faille marquée « corrigée » mais
 * TOUJOURS DÉTECTÉE au scan suivant est signalée comme telle (`isStale`).
 * L'outil regarde le code, pas la case cochée : si les deux se contredisent,
 * c'est la case qui a tort.
 *
 * OÙ C'EST STOCKÉ
 *
 * Dans le navigateur (`localStorage`), pas sur le serveur. Ce choix évite
 * d'engager la décision de format de stockage qu'appelle le point 5 du ROADMAP
 * (historique), et il est cohérent avec l'usage local mono-utilisateur posé
 * par `CLAUDE.md` §6. Conséquence assumée : les statuts ne suivent pas d'une
 * machine à l'autre, et ils sont perdus si on vide le navigateur.
 * ============================================================================
 */

import type { ReportFinding } from '../components/ReportView.tsx';

export type FindingStatus = 'open' | 'fixed' | 'accepted' | 'false_positive';

/** Statuts qui retirent une faille de la pile « à traiter », sans la cacher. */
export const DISMISSING_STATUSES: FindingStatus[] = ['accepted', 'false_positive'];

/**
 * Statuts exigeant une justification écrite.
 *
 * « Corrigé » n'en demande pas : le scan suivant le vérifiera tout seul. Les
 * deux autres, si : ils font sortir un problème réel de la pile sur la seule
 * parole de la personne, et dans six mois personne ne se souviendra pourquoi.
 */
export const STATUSES_NEEDING_NOTE: FindingStatus[] = ['accepted', 'false_positive'];

export interface StatusEntry {
  status: FindingStatus;
  /** Pourquoi. Vide seulement pour les statuts qui n'en exigent pas. */
  note: string;
  /** Date ISO de la décision, pour pouvoir la dater à l'écran. */
  at: string;
}

const STORAGE_KEY = 'vulnpipe.finding-status';
const ALL: FindingStatus[] = ['open', 'fixed', 'accepted', 'false_positive'];

/**
 * Identité stable d'une faille entre deux scans.
 *
 * Le numéro de ligne en est VOLONTAIREMENT absent : il vient du modèle et
 * bouge à la moindre ligne ajoutée au-dessus (limitation documentée en Phase 4
 * du ROADMAP). L'inclure ferait réapparaître comme neuve une faille déjà
 * traitée à chaque édition du fichier.
 */
export function findingKey(finding: {
  vulnerability: string;
  http_method: string;
  route: string;
  file: string;
}): string {
  return [finding.vulnerability, finding.http_method, finding.route, finding.file].join('|');
}

type Store = Record<string, StatusEntry>;

/** Relit le stockage en écartant tout ce qui n'a pas la forme attendue. */
function sanitize(raw: unknown): Store {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Store = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Partial<StatusEntry>;
    if (!ALL.includes(entry.status as FindingStatus)) continue;
    if (entry.status === 'open') continue; // « ouvert » est le défaut : rien à stocker
    out[key] = {
      status: entry.status as FindingStatus,
      note: typeof entry.note === 'string' ? entry.note : '',
      at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
    };
  }
  return out;
}

function read(): Store {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

let current: Store = read();
const listeners = new Set<() => void>();

export function getStatuses(): Store {
  return current;
}

export function statusOf(key: string): StatusEntry {
  return current[key] ?? { status: 'open', note: '', at: '' };
}

/**
 * Enregistre une décision.
 *
 * Refuse un statut qui exige une justification si elle est vide : sans ce
 * refus, le champ deviendrait décoratif et la traçabilité disparaîtrait.
 * Renvoie `false` plutôt que de lever — c'est une saisie utilisateur, pas un
 * bug.
 */
export function setStatus(key: string, status: FindingStatus, note = ''): boolean {
  const trimmed = note.trim();
  if (STATUSES_NEEDING_NOTE.includes(status) && trimmed.length === 0) return false;

  if (status === 'open') delete current[key];
  else current[key] = { status, note: trimmed, at: new Date().toISOString() };

  current = { ...current };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Stockage indisponible : la décision vaut pour la session en cours.
  }
  for (const listener of listeners) listener();
  return true;
}

export function resetStatuses(): void {
  current = {};
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // idem.
  }
  for (const listener of listeners) listener();
}

export function subscribeToStatuses(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Une faille marquée « corrigée » que le scan détecte encore.
 *
 * C'est le cas qui compte : l'outil regarde le code, la case coche une
 * intention. Quand les deux se contredisent, c'est la case qui a tort, et il
 * faut le dire au lieu de la croire sur parole.
 */
export function isStale(entry: StatusEntry, stillDetected: boolean): boolean {
  return entry.status === 'fixed' && stillDetected;
}

export interface StatusStats {
  open: number;
  fixed: number;
  accepted: number;
  falsePositive: number;
  /** Marquées corrigées mais toujours détectées. */
  stale: number;
  /**
   * Part des failles réellement traitées.
   *
   * Dénominateur : `fixed + open` UNIQUEMENT. Les alertes écartées en sont
   * exclues des deux côtés — sinon on ferait monter son taux en écartant.
   * `null` quand il n'y a rien à traiter : afficher « 100 % » sur zéro faille
   * serait une félicitation vide de sens.
   */
  fixRate: number | null;
}

/** Compte les statuts des failles d'un rapport donné. */
export function statusStats(findings: ReportFinding[], store: Store = current): StatusStats {
  const stats: StatusStats = { open: 0, fixed: 0, accepted: 0, falsePositive: 0, stale: 0, fixRate: null };

  for (const finding of findings) {
    const entry = store[findingKey(finding)] ?? { status: 'open' as FindingStatus, note: '', at: '' };
    if (entry.status === 'fixed') {
      stats.fixed += 1;
      // Toutes les failles passées ici sont, par construction, encore
      // détectées : elles sont dans le rapport du scan courant.
      if (isStale(entry, true)) stats.stale += 1;
    } else if (entry.status === 'accepted') stats.accepted += 1;
    else if (entry.status === 'false_positive') stats.falsePositive += 1;
    else stats.open += 1;
  }

  const denominator = stats.fixed + stats.open;
  stats.fixRate = denominator === 0 ? null : stats.fixed / denominator;
  return stats;
}
