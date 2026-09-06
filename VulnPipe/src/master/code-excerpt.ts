/**
 * Extrait de code joint à chaque faille du rapport.
 *
 * ============================================================================
 * POURQUOI
 *
 * Le rapport disait « order.service.ts (ligne 3) » et s'arrêtait là. On annonce
 * un problème ligne 3 à quelqu'un dont le produit suppose explicitement qu'il
 * ne sait pas lire du code (`CLAUDE.md` §1). Deux conséquences :
 *   - il ne peut pas juger le verdict, donc il doit croire l'outil sur parole ;
 *   - il ne peut pas non plus le transmettre à un assistant IA, qui est
 *     pourtant la façon dont cette cible corrige réellement son code.
 *
 * POURQUOI À LA CONSTRUCTION DU RAPPORT, ET PAS À L'AFFICHAGE
 *
 * L'interface tourne dans un navigateur : elle ne peut pas lire le disque. Et
 * pour un dépôt GitHub, le clone temporaire est SUPPRIMÉ à la fin du scan
 * (`scan-target.ts`) — un extrait lu plus tard ne trouverait plus rien. Il est
 * donc capturé pendant que la cible est encore montée, et voyage dans le
 * rapport.
 *
 * SÉCURITÉ
 *
 * Le contenu d'un dépôt analysé est de la DONNÉE NON FIABLE. Deux précautions :
 *   - le chemin lu est confiné sous la racine indexée (un `file` remontant en
 *     `../../etc/passwd` est refusé, pas lu) ;
 *   - le texte extrait n'est jamais interprété : il est tronqué, et l'interface
 *     le rend comme du texte. Il n'est jamais traité comme une instruction.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** Lignes de contexte affichées de part et d'autre de la ligne en cause. */
export const CONTEXT_LINES = 3;

/** Au-delà, une ligne est tronquée : une minifiée ferait exploser le rapport. */
export const MAX_LINE_LENGTH = 240;

export interface CodeExcerpt {
  /** Numéro de la première ligne de `lines`, en base 1. */
  start_line: number;
  /** Lignes de code, déjà tronquées. */
  lines: string[];
  /** Ligne en cause, en base 1. Toujours comprise dans l'intervalle extrait. */
  highlight_line: number;
  /** Vrai si au moins une ligne a été raccourcie — l'interface le signale. */
  truncated: boolean;
}

/**
 * Lit l'extrait autour de `line` dans `file` (relatif à `sourceRoot`).
 *
 * Renvoie `null` dès que quelque chose ne va pas — fichier absent, ligne hors
 * du fichier, chemin sortant de la racine. Un extrait manquant n'est jamais une
 * raison de faire échouer un rapport : la faille reste affichée sans son code.
 */
export function readCodeExcerpt(
  sourceRoot: string,
  file: string,
  line: number | null
): CodeExcerpt | null {
  if (line === null || !Number.isInteger(line) || line < 1) return null;

  // Confinement : on résout, puis on vérifie que le résultat est bien SOUS la
  // racine. `relative()` qui commence par `..` (ou un chemin absolu sur un
  // autre volume) signale une sortie de périmètre.
  const absolute = resolve(sourceRoot, file);
  const inside = relative(resolve(sourceRoot), absolute);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;

  let content: string;
  try {
    content = readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }

  const all = content.split('\n');
  if (line > all.length) return null;

  const start = Math.max(1, line - CONTEXT_LINES);
  const end = Math.min(all.length, line + CONTEXT_LINES);

  let truncated = false;
  const lines = all.slice(start - 1, end).map((raw) => {
    // Les tabulations rendent mal dans une largeur fixe : on les normalise.
    const normalized = raw.replace(/\t/g, '  ').replace(/\r$/, '');
    if (normalized.length <= MAX_LINE_LENGTH) return normalized;
    truncated = true;
    return `${normalized.slice(0, MAX_LINE_LENGTH)}…`;
  });

  return { start_line: start, lines, highlight_line: line, truncated };
}
