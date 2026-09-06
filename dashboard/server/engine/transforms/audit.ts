/**
 * 05-Audit-Log — la trace, et les deux taux du shadow mode.
 *
 * ============================================================================
 * CE QUE CE WORKFLOW EST, ET CE QU'IL N'EST PAS
 *
 * Il écrit la PREUVE de ce qui s'est passé. Le journal d'exécution du moteur,
 * lui, est l'outil qui l'a fait. Les deux existent en parallèle et ne se
 * remplacent pas : confondre les deux laisserait le moteur écrire sa propre
 * preuve, et une preuve qu'on peut réécrire n'en est plus une.
 *
 * C'est pourquoi `soc_audit_log` reste inchangé par la sortie de n8n, avec sa
 * chaîne de hachage calculée PAR LA BASE — ni le pipeline, ni quiconque
 * disposant du compte applicatif ne peut forger un maillon cohérent.
 *
 * ============================================================================
 * NE JAMAIS LEVER ICI
 *
 * Une erreur dans ce fichier ne doit pas être ce qui fait perdre la trace.
 * `normalizeAuditRow` rend toujours une ligne, accompagnée de la liste de ce
 * qui cloche — c'est l'appelant qui décide, pas une exception.
 *
 * ============================================================================
 * LES DEUX TAUX NE SE CONFONDENT JAMAIS
 *
 *   `ai_false_positive_verdict_rate` — part des alertes classées faux positif.
 *     Mesure de DISTRIBUTION, pas de justesse. Elle ne dit rien de la qualité.
 *
 *   `human_disagreement_rate` — part des décisions soumises à un humain qu'il
 *     a REJETÉES. Seul proxy de faux positif observable sans vérité terrain.
 *     C'est celui-ci, et lui seul, qui conditionne la sortie du shadow mode.
 * ============================================================================
 */

import { ACTIONS, VERDICTS, type Action, type Verdict } from './domain.ts';

export interface AuditRow {
  alert_id: string | null;
  event_time: string;
  source_workflow: string;
  verdict: Verdict | null;
  confidence: number | null;
  recommended_action: Action | null;
  decision_source: string | null;
  is_fallback: boolean;
  executed: boolean;
  shadow_mode: boolean;
  routing_outcome: string | null;
  action_taken: string | null;
  human_approver: string | null;
  human_approver_id: string | null;
  human_override: boolean;
  human_reasoning: string | null;
  tokens_used: number | null;
  latency_ms: number | null;
  enrichment_sources_available: string[];
  rule_name: string | null;
  severity: string | null;
  source_ip: string | null;
  dest_ip: string | null;
  execution_id: string;
  payload: unknown;
}

export interface NormalizedAudit {
  row_ok: boolean;
  problems: string[];
  row: AuditRow;
}

/**
 * Met en forme une ligne d'audit.
 *
 * Accepte indifféremment un payload de 03 (décision seule) ou de 04 (décision
 * et routage) : la provenance se déduit de la présence de `routing_outcome`.
 */
export function normalizeAuditRow(
  input: unknown,
  runId: string,
  now: () => Date = () => new Date(),
): NormalizedAudit {
  const b = (input ?? {}) as Record<string, unknown>;
  const d = (b.decision ?? {}) as Record<string, unknown>;
  const ap = (b.approval ?? null) as Record<string, unknown> | null;
  const approver = (ap?.approver ?? null) as Record<string, unknown> | null;
  const meta = (b.enrichment_meta ?? {}) as Record<string, unknown>;

  const cameFrom04 = b.routing_outcome !== undefined || b.executed !== undefined;

  const usage = (d.usage ?? {}) as Record<string, unknown>;
  const hasTokens = typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number';

  let latencyMs: number | null = null;
  if (typeof b.ingested_at === 'string') {
    const t0 = Date.parse(b.ingested_at);
    if (!Number.isNaN(t0)) latencyMs = Math.max(0, now().getTime() - t0);
  }

  const row: AuditRow = {
    alert_id: (b.alert_id as string) ?? null,
    event_time: now().toISOString(),
    source_workflow: (b.source_workflow as string) ?? (cameFrom04 ? '04-Action-Routing' : '03-AI-Decision'),
    verdict: VERDICTS.includes(d.verdict as Verdict) ? (d.verdict as Verdict) : null,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
    recommended_action: ACTIONS.includes(d.recommended_action as Action) ? (d.recommended_action as Action) : null,
    decision_source: (d.decision_source as string) ?? null,
    is_fallback: d.is_fallback === true,
    executed: b.executed === true,
    // Fail-safe : un `shadow_mode` qui n'est pas un booléen vaut `true`.
    shadow_mode: typeof b.shadow_mode === 'boolean' ? b.shadow_mode : true,
    routing_outcome: (b.routing_outcome as string) ?? null,
    action_taken: (b.action_taken as string) ?? null,
    human_approver: approver ? ((approver.slack_username as string) ?? null) : null,
    human_approver_id: approver ? ((approver.slack_user_id as string) ?? null) : null,
    // Un rejet humain est un DÉSACCORD EXPLICITE avec la recommandation de
    // l'IA. C'est la seule définition d'override observable sans vérité
    // terrain — et c'est elle qui alimente `human_disagreement_rate`.
    human_override: ap ? ap.outcome === 'rejected' : false,
    human_reasoning: ap ? ((ap.human_reasoning as string) ?? null) : null,
    tokens_used: hasTokens
      ? ((usage.input_tokens as number) ?? 0) + ((usage.output_tokens as number) ?? 0)
      : null,
    latency_ms: latencyMs,
    enrichment_sources_available: Array.isArray(meta.sources_ok) ? (meta.sources_ok as string[]) : [],
    rule_name: (b.rule_name as string) ?? null,
    severity: (b.severity as string) ?? null,
    source_ip: (b.source_ip as string) ?? null,
    dest_ip: (b.dest_ip as string) ?? null,
    execution_id: runId,
    payload: b,
  };

  const problems: string[] = [];
  if (!row.alert_id) problems.push('alert_id');
  if (row.shadow_mode && row.executed) {
    // Contradiction structurelle : la contrainte CHECK de la base rejetterait
    // la ligne. On corrige pour ne pas perdre la trace, ET on le signale —
    // une correction silencieuse masquerait un vrai défaut du routage.
    row.executed = false;
    problems.push('inconsistent shadow_mode=true with executed=true (executed forced to false)');
  }

  return { row_ok: row.alert_id !== null, problems, row };
}

export interface MetricsSnapshot {
  available: boolean;
  reason?: string;
  window?: string;
  [metric: string]: unknown;
}

/**
 * Instantané de mesures.
 *
 * SI LA REQUÊTE A ÉCHOUÉ, ON LE DIT. On ne renvoie pas des zéros qui
 * passeraient pour des mesures : « 0 % de désaccord humain » et « on ne sait
 * pas » mènent à des décisions opposées sur la sortie du shadow mode.
 */
export function exposeAuditAndMetrics(
  committed: Record<string, unknown> | null,
  metrics: Record<string, unknown> | null,
): Record<string, unknown> {
  const failed = !metrics || metrics.error !== undefined || metrics.alerts_total === undefined;

  return {
    source_workflow: '05-Audit-Log',
    audit: {
      committed: committed !== null,
      row_id: committed?.id ?? null,
      alert_id: committed?.alert_id ?? null,
      event_time: committed?.event_time ?? null,
      integrity_hash: committed?.integrity_hash ?? null,
      prev_hash: committed?.prev_hash ?? null,
      chain_verify_hint: "SELECT * FROM soc_audit_verify_chain() WHERE status <> 'ok';",
    },
    metrics: failed
      ? {
          available: false,
          reason: (metrics?.error as string) ?? 'the aggregate query is unavailable',
        }
      : {
          available: true,
          window: '7 jours glissants',
          alerts_total: metrics.alerts_total,
          alerts_shadow: metrics.alerts_shadow,
          alerts_live: metrics.alerts_live,
          actions_executed: metrics.actions_executed,
          avg_tokens_per_alert: metrics.avg_tokens_per_alert,
          tokens_total: metrics.tokens_total,
          avg_latency_ms: metrics.avg_latency_ms,
          p95_latency_ms: metrics.p95_latency_ms,
          avg_confidence: metrics.avg_confidence,
          // Les deux taux, nommés sans ambiguïté possible. Voir l'en-tête.
          ai_false_positive_verdict_rate_pct: metrics.ai_false_positive_verdict_rate,
          human_disagreement_rate_pct: metrics.human_disagreement_rate,
          fallback_rate_pct: metrics.fallback_rate,
          approval_timeout_rate_pct: metrics.approval_timeout_rate,
          shadow_baseline: {
            decisions: metrics.shadow_decisions,
            threshold: metrics.threshold,
            threshold_reached: metrics.threshold_reached,
          },
        },
  };
}
