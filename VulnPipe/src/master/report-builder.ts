/**
 * Construction du rapport final — déterministe, aucun appel LLM.
 *
 * Sépare volontairement l'arbitrage (claude-client.ts) de l'assemblage : les
 * décisions structurelles du rapport — quoi montrer, comment compter, quoi
 * faire d'un verdict manquant — doivent être reproductibles et testables sans
 * réseau.
 */

import { readCodeExcerpt, type CodeExcerpt } from './code-excerpt.ts';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';
import type { AggregationResult, AggregatedFinding } from '../aggregator/aggregator.ts';
import type { Severity } from '../aggregator/severity-rules.ts';
import { compareSeverity } from '../aggregator/severity-rules.ts';
import { findingId, type ArbitrationOutcome, type ClaudeVerdict } from './claude-client.ts';

/**
 * Niveau d'affichage du rapport.
 *
 * L'Agrégateur travaille sur 5 niveaux (`info`…`critical`), le format de
 * sortie de PHASE_5 ne compte que `critical` et `warning` — sans jamais dire
 * comment passer de l'un à l'autre. On rend la correspondance explicite plutôt
 * que de la laisser implicite dans un `if`.
 */
export type ReportLevel = 'critical' | 'warning';

export function toReportLevel(severity: Severity): ReportLevel {
  return severity === 'critical' || severity === 'high' ? 'critical' : 'warning';
}

export interface ReportFinding {
  severity: Severity;
  report_level: ReportLevel;
  vulnerability: string;
  route: string;
  http_method: string;
  file: string;
  line: number | null;
  claude_verdict: ClaudeVerdict;
  claude_reasoning: string;
  technical_summary: string;
  plain_language_summary: string;
  suggested_fix_direction: string;
  owasp_category: string;
  /** `summary_only` = arbitré sans voir le code : à prendre avec prudence. */
  evidence: 'code' | 'summary_only' | 'not_arbitrated';
  local_confidence_score: number;
  detected_by: string[];
  /**
   * Le code en cause, capturé pendant le scan (voir `code-excerpt.ts`).
   * `null` quand il n'a pas pu être lu — la faille reste affichée sans lui.
   */
  code_excerpt: CodeExcerpt | null;
}

export interface ScanSummary {
  total_findings: number;
  critical: number;
  warning: number;
  /** Signalements écartés par l'arbitre — comptés, jamais cachés. */
  dismissed_by_arbiter: number;
  /** Signalements que l'arbitre n'a pas pu trancher (panne, réponse partielle). */
  not_arbitrated: number;
  plain_language_intro: string;
}

export interface SecurityReport {
  scan_summary: ScanSummary;
  findings: ReportFinding[];
  /**
   * Signalements rejetés par l'arbitre. La spec demande qu'ils n'apparaissent
   * pas dans le rapport visible — ils sont donc hors de `findings` — mais ils
   * restent ici pour la calibration des prompts des nodes locaux.
   */
  dismissed: Array<{
    vulnerability: string;
    route: string;
    http_method: string;
    local_confidence_score: number;
    claude_reasoning: string;
  }>;
  /**
   * Racine ABSOLUE du code analysé, quand elle survivra au scan.
   *
   * Sert au lien « ouvrir dans mon éditeur » : le navigateur a besoin d'un
   * chemin absolu, alors que `finding.file` est relatif. `null` pour un dépôt
   * GitHub — son clone temporaire est supprimé à la fin du scan, un lien vers
   * ce chemin pointerait dans le vide.
   */
  source_root: string | null;
  /** Statistiques du run de l'Agrégateur, reprises telles quelles. */
  aggregator_stats: AggregationResult['stats'];
  arbiter: { provider: string; model: string; calls: number; input_tokens: number; output_tokens: number };
}

/**
 * Détecte un patch de code dans un texte censé n'en contenir aucun.
 *
 * La spec pose la contrainte « ne fais jamais écrire à Claude un patch de code
 * complet ». Une instruction de prompt ne suffit pas à la garantir : un modèle
 * qui glisse un bloc ```ts dans `suggested_fix_direction` produirait exactement
 * ce que la contrainte veut éviter — un correctif d'apparence applicable, non
 * revu, dans un champ destiné à une explication. On vérifie donc en code.
 */
export function containsCodePatch(text: string): boolean {
  return (
    /```/.test(text) ||
    /^\s*[+-]{3}\s/m.test(text) || // en-têtes de diff
    /^\s*@@\s/m.test(text) || // hunks
    /^\s*[+-]\s*(const|let|var|function|return|if|await|import)\b/m.test(text)
  );
}

/** Remplace un patch détecté par une consigne, sans perdre l'information. */
function stripCodePatch(
  text: string,
  field: string,
  locale: Locale
): { text: string; stripped: boolean } {
  if (!containsCodePatch(text)) return { text, stripped: false };
  const withoutFences = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*[+-@].*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text:
      withoutFences.length > 30
        ? withoutFences
        : messages(locale).report.patchStripped(field),
    stripped: true,
  };
}

export interface BuildReportOptions {
  /** Routes analysées durant le scan, pour une introduction honnête. */
  routesAnalyzed?: number;
  /** Routes dont l'analyse a échoué : une couverture partielle doit se voir. */
  routesFailed?: number;
  /** Langue du rapport. */
  locale?: Locale;
  /**
   * Racine absolue du code analysé.
   *
   * Quand elle est fournie, chaque faille reçoit l'extrait de code en cause, lu
   * MAINTENANT — la cible peut être un clone temporaire effacé juste après.
   */
  sourceRoot?: string;
  /**
   * Cette racine existera-t-elle encore après le scan ? Faux pour un dépôt
   * GitHub. Décide de la présence du lien « ouvrir dans mon éditeur ».
   */
  sourceRootPersists?: boolean;
}

/** Assemble le rapport final à partir du résultat d'agrégation et de l'arbitrage. */
export function buildReport(
  aggregation: AggregationResult,
  arbitration: ArbitrationOutcome,
  options: BuildReportOptions = {}
): SecurityReport {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const t = messages(locale).report;

  // Le payload soumis à l'arbitre = tout ce que l'Agrégateur a retenu.
  const candidates: AggregatedFinding[] = [...aggregation.claude_payload, ...aggregation.direct_alerts];

  const byId = new Map(arbitration.arbitrated.map((a) => [a.finding_id, a]));
  const unarbitratedById = new Map(arbitration.unarbitrated.map((u) => [u.finding_id, u]));

  const findings: ReportFinding[] = [];
  const dismissed: SecurityReport['dismissed'] = [];
  let strippedPatches = 0;

  for (const finding of candidates) {
    const id = findingId(finding);
    const verdict = byId.get(id);

    // --- Cas 1 : pas de verdict (panne API, réponse incomplète) -----------
    // Le finding reste VISIBLE avec le verdict local. Le faire disparaître
    // parce que l'arbitre est tombé transformerait une panne en « rien à
    // signaler » — le mode de défaillance le plus dangereux d'un outil de
    // sécurité.
    if (!verdict) {
      const why = unarbitratedById.get(id)?.why ?? 'non soumis à l’arbitre';
      findings.push({
        severity: finding.severity,
        report_level: toReportLevel(finding.severity),
        vulnerability: finding.vulnerability,
        route: finding.route,
        http_method: finding.http_method,
        file: finding.file,
        line: finding.line,
        claude_verdict: 'needs_human_review',
        claude_reasoning: `Non vérifié par l'arbitre (${why}). Le verdict affiché est celui du détecteur automatique seul.`,
        technical_summary: t.suspected(
          finding.vulnerability,
          finding.http_method,
          finding.route,
          finding.confidence_score
        ),
        plain_language_summary: finding.plain_language_summary,
        suggested_fix_direction:
          'À faire vérifier par une personne : la seconde relecture automatique n’a pas pu avoir lieu.',
        owasp_category: 'non déterminée',
        evidence: 'not_arbitrated',
        local_confidence_score: finding.confidence_score,
        detected_by: finding.detected_by,
        code_excerpt: null,
      });
      continue;
    }

    // --- Cas 2 : rejeté par l'arbitre ------------------------------------
    if (verdict.claude_verdict === 'rejected') {
      dismissed.push({
        vulnerability: finding.vulnerability,
        route: finding.route,
        http_method: finding.http_method,
        local_confidence_score: finding.confidence_score,
        claude_reasoning: verdict.claude_reasoning,
      });
      continue;
    }

    // --- Cas 3 : confirmé ou à faire revoir -------------------------------
    const fix = stripCodePatch(verdict.suggested_fix_direction, 'suggested_fix_direction', locale);
    const plain = stripCodePatch(verdict.plain_language_summary, 'plain_language_summary', locale);
    if (fix.stripped || plain.stripped) strippedPatches += 1;

    findings.push({
      severity: finding.severity,
      report_level: toReportLevel(finding.severity),
      vulnerability: finding.vulnerability,
      route: finding.route,
      http_method: finding.http_method,
      file: finding.file,
      line: finding.line,
      claude_verdict: verdict.claude_verdict,
      claude_reasoning: verdict.claude_reasoning,
      technical_summary: verdict.technical_summary,
      plain_language_summary: plain.text,
      suggested_fix_direction: fix.text,
      owasp_category: verdict.owasp_category,
      evidence: verdict.evidence,
      local_confidence_score: finding.confidence_score,
      detected_by: finding.detected_by,
      code_excerpt: null,
    });
  }

  // Tri déterministe : gravité, puis confiance, puis route.
  findings.sort(
    (a, b) =>
      compareSeverity(a.severity, b.severity) ||
      b.local_confidence_score - a.local_confidence_score ||
      a.route.localeCompare(b.route) ||
      a.http_method.localeCompare(b.http_method)
  );

  const critical = findings.filter((f) => f.report_level === 'critical').length;
  const warning = findings.filter((f) => f.report_level === 'warning').length;
  const notArbitrated = findings.filter((f) => f.evidence === 'not_arbitrated').length;

  const summary: ScanSummary = {
    total_findings: findings.length,
    critical,
    warning,
    dismissed_by_arbiter: dismissed.length,
    not_arbitrated: notArbitrated,
    plain_language_intro: buildIntro(locale, {
      critical,
      warning,
      dismissed: dismissed.length,
      notArbitrated,
      strippedPatches,
      routesAnalyzed: options.routesAnalyzed,
      routesFailed: options.routesFailed,
    }),
  };

  return {
    scan_summary: summary,
    findings: options.sourceRoot
      ? findings.map((finding) => ({
          ...finding,
          code_excerpt: readCodeExcerpt(options.sourceRoot!, finding.file, finding.line),
        }))
      : findings,
    dismissed,
    source_root:
      options.sourceRoot !== undefined && options.sourceRootPersists === true
        ? options.sourceRoot
        : null,
    aggregator_stats: aggregation.stats,
    arbiter: {
      provider: arbitration.provider,
      model: arbitration.model,
      calls: arbitration.usage.calls,
      input_tokens: arbitration.usage.input_tokens,
      output_tokens: arbitration.usage.output_tokens,
    },
  };
}

function buildIntro(locale: Locale, input: {
  critical: number;
  warning: number;
  dismissed: number;
  notArbitrated: number;
  strippedPatches: number;
  routesAnalyzed?: number;
  routesFailed?: number;
}): string {
  const t = messages(locale).report;
  const total = input.critical + input.warning;
  const parts: string[] = [];

  if (total === 0) parts.push(t.allClear);
  else if (input.critical > 0) parts.push(t.foundWithCritical(total, input.critical));
  else parts.push(t.foundNonUrgent(total));

  if (input.dismissed > 0) parts.push(t.dismissed(input.dismissed));

  // La couverture partielle doit être dite, jamais déduite d'une absence.
  if (input.notArbitrated > 0) parts.push(t.notArbitrated(input.notArbitrated));

  if (input.routesFailed && input.routesFailed > 0) parts.push(t.routesFailed(input.routesFailed));
  else if (input.routesAnalyzed) parts.push(t.coverage(input.routesAnalyzed));

  if (input.strippedPatches > 0) parts.push(t.patchesDescribedInWords);

  return parts.join(' ');
}
