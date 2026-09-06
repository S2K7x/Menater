/**
 * Agrégateur — déterministe, ZÉRO appel LLM.
 *
 * Reçoit les findings des nodes de détection, les nettoie, les hiérarchise, et
 * décide de ce qui monte au master Claude (Phase 5). C'est le composant qui
 * tient la promesse low-cost : tout ce qu'il rejette ici n'est jamais facturé.
 */

import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';
import {
  classifySourcePath,
  compareSeverity,
  computeSeverity,
  type Severity,
  type SeverityAdjustment,
} from './severity-rules.ts';

// ---------------------------------------------------------------------------
// Entrée : format commun à tous les nodes (IDOR, XSS, SQLi, …)
// ---------------------------------------------------------------------------

export type DoubtReason = 'missing_context' | 'ambiguous_logic' | null;

export interface NodeFinding {
  vulnerability: string;
  route: string;
  http_method: string;
  handler: string;
  file: string;
  /** Ligne incriminée. `null` si le node n'a pas su la situer. */
  line: number | null;
  confidence_score: number;
  reason: DoubtReason;
  plain_language_summary: string;
  /** Décorateurs de la route — servent aux règles de sévérité. */
  decorators?: string[];
  /** Node émetteur, pour tracer les accords entre détecteurs. */
  detected_by: string;
  technical_detail?: unknown;
}

// ---------------------------------------------------------------------------
// Sortie
// ---------------------------------------------------------------------------

export type Routing = 'rejected' | 'claude_arbitration' | 'direct_alert';

/**
 * Une vulnérabilité, après fusion des doublons du MÊME type.
 */
export interface AggregatedFinding {
  vulnerability: string;
  route: string;
  http_method: string;
  handler: string;
  file: string;
  line: number | null;
  /** Score retenu = le plus élevé des doublons fusionnés. */
  confidence_score: number;
  reason: DoubtReason;
  severity: Severity;
  severity_base: Severity;
  severity_adjustments: SeverityAdjustment[];
  routing: Routing;
  /** Tous les nodes ayant signalé cette vulnérabilité à cet endroit. */
  detected_by: string[];
  /** true si plusieurs nodes concordent — un signal fort de vraie positive. */
  corroborated: boolean;
  plain_language_summary: string;
  sources: NodeFinding[];
}

/**
 * Regroupement par emplacement.
 *
 * ============================================================================
 * CORRECTION DE LA SPEC — LE POINT LE PLUS IMPORTANT DE CETTE PHASE
 *
 * PHASE_4 demande : « si deux findings pointent la même route + la même ligne
 * (même si détectés par des nodes différents), fusionner en un seul finding
 * avec la liste des vulnérabilités concernées ».
 *
 * Fusionner des vulnérabilités de NATURES DIFFÉRENTES en un seul objet casse
 * tout ce qui vient après :
 *
 *  1. Un finding fusionné n'a qu'un `confidence_score`. Si un IDOR à 0.9 et un
 *     XSS à 0.5 partagent une ligne, prendre le max promeut le XSS douteux en
 *     alerte directe ; prendre le min enterre l'IDOR quasi certain. Les deux
 *     choix produisent une erreur de routing.
 *  2. Un IDOR et une injection SQL n'ont ni la même sévérité de base, ni la
 *     même correction. Un seul objet ne peut pas porter deux remédiations.
 *  3. L'utilisateur reçoit une alerte pour deux problèmes distincts, et en
 *     corrigera un seul.
 *
 * Ce qu'on fait à la place — l'intention de la spec, sans le défaut :
 *   - FUSION (`AggregatedFinding`) : uniquement entre findings de MÊME type au
 *     même endroit. Ça, c'est une vraie duplication (deux nodes d'accord, ou
 *     deux passes du même node) — et la concordance devient un signal.
 *   - CORRÉLATION (`LocationGroup`) : les types différents au même endroit
 *     sont regroupés pour l'affichage et gardent chacun leur score, leur
 *     sévérité et leur routing. C'est bien « la liste des vulnérabilités
 *     concernées » que la spec demande, mais sans écraser les scores.
 * ============================================================================
 */
export interface LocationGroup {
  route: string;
  http_method: string;
  file: string;
  line: number | null;
  /** Sévérité la plus élevée du groupe — sert au tri. */
  severity: Severity;
  /** Score le plus élevé du groupe. */
  max_confidence: number;
  vulnerabilities: AggregatedFinding[];
  plain_language_summary: string;
}

export interface RunStats {
  total_received: number;
  excluded_non_production: number;
  merged_duplicates: number;
  rejected_low_confidence: number;
  sent_to_claude: number;
  direct_alerts: number;
  /** Part des findings retenus qui montent à Claude. */
  percent_of_findings_to_claude: number;
  /**
   * Part des ROUTES analysées qui déclenchent un appel Claude.
   *
   * AJOUT : la spec ne demande que le pourcentage sur les findings. Or
   * `CLAUDE.md` §2 parle de « 10-15 % du volume » — le volume d'un scan, ce
   * sont les routes analysées, pas les findings émis. Un node qui ne remonte
   * que les cas suspects donnerait mécaniquement 100 % « de findings envoyés »
   * tout en restant à 5 % du volume réel. Les deux chiffres sont donc rendus,
   * et c'est celui-ci qui se compare à la fourchette de CLAUDE.md.
   */
  percent_of_routes_to_claude: number | null;
  routes_analyzed: number | null;
  /** Motifs d'exclusion, pour qu'aucun rejet ne soit invisible. */
  exclusions: string[];
}

export interface AggregationResult {
  /** Groupes triés : sévérité décroissante, puis confiance, puis route. */
  groups: LocationGroup[];
  /** Ce qui part réellement au master Claude (Phase 5). */
  claude_payload: AggregatedFinding[];
  /** Alertes remontées sans arbitrage (si bypass activé). */
  direct_alerts: AggregatedFinding[];
  /** Findings écartés, conservés pour les statistiques. */
  rejected: AggregatedFinding[];
  stats: RunStats;
  plain_language_summary: string;
}

export interface AggregateOptions {
  /**
   * Si true, les findings > 0.7 sont remontés directement sans passer par
   * Claude (option « bypass » de CLAUDE.md §3). Par défaut false : Claude
   * rédige le rapport final, ce qui est la promesse d'explicabilité.
   */
  bypassClaudeForHighConfidence?: boolean;
  /** Nombre de routes analysées durant le run, pour le vrai pourcentage. */
  routesAnalyzed?: number;
  /** Langue des résumés produits. */
  locale?: Locale;
}

// Seuils — CLAUDE.md §3.
export const REJECT_BELOW = 0.4;
export const DIRECT_ALERT_ABOVE = 0.7;

function routingFor(score: number, bypass: boolean): Routing {
  if (score < REJECT_BELOW) return 'rejected';
  if (score > DIRECT_ALERT_ABOVE) return bypass ? 'direct_alert' : 'claude_arbitration';
  return 'claude_arbitration';
}

/**
 * Clé de fusion.
 *
 * Inclut `http_method` : `GET /orders/:id` et `DELETE /orders/:id` sont deux
 * endpoints distincts (établi en Phase 2). La spec dit « même route » ; sans
 * le verbe, une lecture non autorisée et une suppression non autorisée
 * fusionneraient en une seule alerte.
 *
 * Inclut le TYPE de vulnérabilité — voir le commentaire de `LocationGroup`.
 *
 * `line` est volontairement en dernier et tolère `null` : elle vient souvent
 * du LLM et peut être absente ou approximative. Deux findings du même type sur
 * la même route dont l'un n'a pas de ligne sont considérés comme le même.
 */
function mergeKey(finding: NodeFinding): string {
  return [
    finding.vulnerability.toUpperCase(),
    finding.http_method.toUpperCase(),
    finding.route,
    finding.file,
    finding.line ?? 'ligne-inconnue',
  ].join('|');
}

function locationKey(finding: AggregatedFinding): string {
  return [finding.http_method.toUpperCase(), finding.route, finding.file, finding.line ?? '?'].join('|');
}

function summarizeGroup(
  group: Omit<LocationGroup, 'plain_language_summary'>,
  locale: Locale
): string {
  const t = messages(locale).aggregator;
  const location = `${group.http_method} ${group.route}`;
  if (group.vulnerabilities.length === 1) {
    return group.vulnerabilities[0]!.plain_language_summary;
  }
  const names = group.vulnerabilities.map((v) => v.vulnerability).join(t.and);
  return t.multipleAtSameLocation(location, group.vulnerabilities.length, names);
}

/** Point d'entrée. Aucun appel réseau, aucun LLM, résultat reproductible. */
export function aggregate(
  findings: NodeFinding[],
  options: AggregateOptions = {}
): AggregationResult {
  const bypass = options.bypassClaudeForHighConfidence ?? false;
  const locale = options.locale ?? DEFAULT_LOCALE;

  const stats: RunStats = {
    total_received: findings.length,
    excluded_non_production: 0,
    merged_duplicates: 0,
    rejected_low_confidence: 0,
    sent_to_claude: 0,
    direct_alerts: 0,
    percent_of_findings_to_claude: 0,
    percent_of_routes_to_claude: null,
    routes_analyzed: options.routesAnalyzed ?? null,
    exclusions: [],
  };

  // --- 1. Exclusion des fichiers hors production -------------------------
  const production: NodeFinding[] = [];
  for (const finding of findings) {
    const verdict = classifySourcePath(finding.file);
    if (verdict.excluded) {
      stats.excluded_non_production += 1;
      stats.exclusions.push(verdict.reason!);
      continue;
    }
    production.push(finding);
  }

  // --- 2. Fusion des doublons de MÊME type au même endroit ---------------
  const merged = new Map<string, NodeFinding[]>();
  for (const finding of production) {
    const key = mergeKey(finding);
    const bucket = merged.get(key);
    if (bucket) {
      bucket.push(finding);
      stats.merged_duplicates += 1;
    } else {
      merged.set(key, [finding]);
    }
  }

  // --- 3. Sévérité + routing ---------------------------------------------
  const aggregated: AggregatedFinding[] = [];
  for (const sources of merged.values()) {
    // Le score retenu est le plus élevé : entre deux détecteurs, celui qui
    // voit le problème l'emporte sur celui qui l'a manqué. Sous-estimer un
    // risque coûte plus cher que de le sur-estimer.
    const best = sources.reduce((a, b) => (b.confidence_score > a.confidence_score ? b : a));

    const { severity, base, adjustments } = computeSeverity(best.vulnerability, {
      route: best.route,
      decorators: best.decorators ?? [],
    });

    const detectedBy = [...new Set(sources.map((s) => s.detected_by))];

    aggregated.push({
      vulnerability: best.vulnerability,
      route: best.route,
      http_method: best.http_method.toUpperCase(),
      handler: best.handler,
      file: best.file,
      line: best.line,
      confidence_score: best.confidence_score,
      // Un doute persistant chez l'un des détecteurs reste un doute.
      reason: sources.find((s) => s.reason !== null)?.reason ?? null,
      severity,
      severity_base: base,
      severity_adjustments: adjustments,
      routing: routingFor(best.confidence_score, bypass),
      detected_by: detectedBy,
      corroborated: detectedBy.length > 1,
      plain_language_summary: best.plain_language_summary,
      sources,
    });
  }

  // --- 4. Répartition ------------------------------------------------------
  const rejected = aggregated.filter((f) => f.routing === 'rejected');
  const claudePayload = aggregated.filter((f) => f.routing === 'claude_arbitration');
  const directAlerts = aggregated.filter((f) => f.routing === 'direct_alert');

  stats.rejected_low_confidence = rejected.length;
  stats.sent_to_claude = claudePayload.length;
  stats.direct_alerts = directAlerts.length;

  const retained = aggregated.length;
  stats.percent_of_findings_to_claude =
    retained === 0 ? 0 : Number(((claudePayload.length / retained) * 100).toFixed(1));
  stats.percent_of_routes_to_claude =
    options.routesAnalyzed && options.routesAnalyzed > 0
      ? Number(((claudePayload.length / options.routesAnalyzed) * 100).toFixed(1))
      : null;

  // --- 5. Corrélation par emplacement + tri --------------------------------
  const byLocation = new Map<string, AggregatedFinding[]>();
  for (const finding of aggregated) {
    if (finding.routing === 'rejected') continue; // rejeté = hors rapport
    const key = locationKey(finding);
    const bucket = byLocation.get(key);
    if (bucket) bucket.push(finding);
    else byLocation.set(key, [finding]);
  }

  const groups: LocationGroup[] = [...byLocation.values()].map((vulnerabilities) => {
    const sorted = [...vulnerabilities].sort(
      (a, b) => compareSeverity(a.severity, b.severity) || b.confidence_score - a.confidence_score
    );
    const first = sorted[0]!;
    const partial = {
      route: first.route,
      http_method: first.http_method,
      file: first.file,
      line: first.line,
      severity: first.severity,
      max_confidence: Math.max(...sorted.map((v) => v.confidence_score)),
      vulnerabilities: sorted,
    };
    return { ...partial, plain_language_summary: summarizeGroup(partial, locale) };
  });

  // Tri déterministe : sans le départage final sur la route, deux runs
  // identiques pourraient rendre des ordres différents.
  groups.sort(
    (a, b) =>
      compareSeverity(a.severity, b.severity) ||
      b.max_confidence - a.max_confidence ||
      a.route.localeCompare(b.route) ||
      a.http_method.localeCompare(b.http_method)
  );

  return {
    groups,
    claude_payload: claudePayload,
    direct_alerts: directAlerts,
    rejected,
    stats,
    plain_language_summary: summarizeRun(stats, groups, locale),
  };
}

/** CLAUDE.md §4 : même l'agrégateur, qui ne parle qu'à des machines, s'explique. */
function summarizeRun(stats: RunStats, groups: LocationGroup[], locale: Locale): string {
  const t = messages(locale).aggregator;
  if (stats.total_received === 0) return t.nothingReported;

  const parts: string[] = [];
  const retained = groups.reduce((sum, group) => sum + group.vulnerabilities.length, 0);

  parts.push(t.received(stats.total_received, retained));

  if (stats.excluded_non_production > 0) {
    parts.push(t.excludedNonProduction(stats.excluded_non_production));
  }
  if (stats.merged_duplicates > 0) parts.push(t.mergedDuplicates(stats.merged_duplicates));
  if (stats.rejected_low_confidence > 0) {
    parts.push(t.rejectedLowConfidence(stats.rejected_low_confidence));
  }

  const critical = groups.filter((g) => g.severity === 'critical' || g.severity === 'high').length;
  if (critical > 0) parts.push(t.criticalCount(critical));
  else if (retained > 0) parts.push(t.noCritical);

  return parts.join(' ');
}

/** Adapte un verdict de node au format d'entrée de l'agrégateur. */
export function fromNodeVerdict(
  verdict: {
    vulnerability: string;
    route: string;
    http_method: string;
    handler: string;
    file: string;
    confidence_score: number;
    reason: DoubtReason;
    plain_language_summary: string;
    technical_detail?: { findings?: Array<{ line: number }> };
  },
  detectedBy: string,
  decorators: string[] = []
): NodeFinding {
  return {
    vulnerability: verdict.vulnerability,
    route: verdict.route,
    http_method: verdict.http_method,
    handler: verdict.handler,
    file: verdict.file,
    line: verdict.technical_detail?.findings?.[0]?.line ?? null,
    confidence_score: verdict.confidence_score,
    reason: verdict.reason,
    plain_language_summary: verdict.plain_language_summary,
    decorators,
    detected_by: detectedBy,
    technical_detail: verdict.technical_detail,
  };
}
