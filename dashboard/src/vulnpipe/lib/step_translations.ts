/**
 * Traductions d'étapes — désormais servies par le catalogue i18n.
 *
 * Ce module existait avant le multilingue et exposait une table française
 * figée. Il ne détient plus de texte : il ne fait que ré-exporter ce que le
 * dictionnaire fournit pour la langue demandée.
 *
 * On le garde comme point d'accès pour ne pas disperser les imports dans tous
 * les composants, et parce que les fonctions utilitaires (ordre d'affichage,
 * glossaire, gravité) sont réellement de la logique d'affichage, pas du texte.
 */

import { dictionary, STEP_ORDER, type Locale, type StepName, type StepTranslation } from '../../i18n/dictionary.ts';

export { STEP_ORDER };
export type { StepName, StepTranslation };

export type StepStatus = 'running' | 'done' | 'failed' | 'skipped';

/** Table d'étapes pour une langue donnée. */
export function stepTranslations(locale: Locale): Record<StepName, StepTranslation> {
  return dictionary(locale).steps;
}

export function translateStep(step: StepName, status: StepStatus, locale: Locale): string {
  const t = dictionary(locale);
  const translation = t.steps[step];
  if (!translation) return t.timeline.fallback;
  if (status === 'failed') return translation.failed;
  // Une étape sautée n'est pas un échec : on la présente comme réglée.
  if (status === 'done' || status === 'skipped') return translation.done;
  return translation.running;
}

/**
 * Traduction d'un terme technique, ou null s'il n'est pas au glossaire.
 *
 * Contrainte de design conservée : un sigle technique peut apparaître, mais
 * jamais seul — toujours accompagné de son explication.
 */
export function explainTerm(term: string, locale: Locale): string | null {
  const glossary = dictionary(locale).glossary;
  return glossary[term] ?? glossary[term.toUpperCase()] ?? null;
}

/** Libellés des niveaux de gravité, côté utilisateur. */
export function severityLabel(
  severity: string,
  locale: Locale
): { label: string; explanation: string; tone: 'red' | 'orange' | 'grey' } {
  const entry = dictionary(locale).severity[severity] ?? dictionary(locale).severity.info!;
  const tone: 'red' | 'orange' | 'grey' =
    severity === 'critical' || severity === 'high' ? 'red' : severity === 'medium' ? 'orange' : 'grey';
  return { ...entry, tone };
}
