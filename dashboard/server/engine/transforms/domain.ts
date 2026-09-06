/**
 * Le vocabulaire du pipeline, typé.
 *
 * ============================================================================
 * CE QUE CE FICHIER GAGNE PAR RAPPORT À n8n
 *
 * Sous n8n, ces formes n'existaient nulle part : chaque nœud `code` recomposait
 * son objet à la main, et une faute de frappe dans `enrichment_meta.degraded`
 * ne se voyait qu'à l'exécution — sur l'alerte qui en dépendait.
 *
 * Ici les mêmes formes sont des types. Un champ mal orthographié ne compile
 * pas, et les 973 lignes de JavaScript deviennent vérifiables sans exécuter le
 * pipeline.
 *
 * ============================================================================
 * LES LISTES FERMÉES SONT DES CONSTANTES, PAS DES COMMENTAIRES
 *
 * `VERDICTS` et `ACTIONS` étaient recopiés dans trois nœuds différents de deux
 * workflows. Une seule source ici — et le catalogue d'actions reste fermé :
 * rien d'autre n'est implémentable, même derrière une approbation.
 * ============================================================================
 */

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ['false_positive', 'true_positive', 'needs_human'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Catalogue FERMÉ des actions. Rien d'autre n'est implémentable, même derrière
 * une approbation humaine — c'est une règle de conception, pas une limitation
 * temporaire.
 */
export const ACTIONS = ['auto_close', 'escalate', 'isolate_host_temporary', 'ticket'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * N1 — TWO TIERS, AND THE DIFFERENCE MATTERS.
 *
 * There used to be one flat list of seven required fields. Every one of them
 * had to be present or the alert was answered `400` and lost. That worked for
 * exactly one shape of sender — a hand-written one — and rejected the rest of
 * the world: a real Wazuh alert arrives with six of the seven absent, and
 * `dest_ip` in particular does not exist for most detections, because most
 * detections have no destination.
 *
 * Rejecting an alert because a field is missing is the harshest possible way
 * to "fill a hole with a default": it replaces the alert with nothing. § 8 has
 * always said an absent value is displayed as absent. These two lists are that
 * rule applied at the front door.
 */

/**
 * IDENTITY — without these an alert cannot be triaged, stored or explained,
 * so their absence IS a rejection, and the rejection names them.
 */
export const IDENTITY_FIELDS = [
  'alert_id', 'rule_name', 'severity', 'timestamp', 'raw_log',
] as const;

/**
 * OBSERVABLES — the facts a detection may or may not carry. Absent stays
 * absent, all the way to the operator's screen and to the model's prompt.
 *
 * NOTHING DOWNSTREAM MAY INVENT ONE. `isolate_host_temporary` in particular
 * refuses to run when it has no host to isolate, rather than isolating
 * `undefined` — see `buildApprovalRequest` in `routing.ts`.
 */
export const OBSERVABLE_FIELDS = [
  'source_ip', 'dest_ip', 'user', 'host', 'process', 'file_path', 'url',
] as const;

/** Kept for the readers that still mean "everything an alert can carry". */
export const REQUIRED_FIELDS = IDENTITY_FIELDS;

export type Observables = {
  [K in (typeof OBSERVABLE_FIELDS)[number]]: string | null;
};

export interface AlertPayload extends Observables {
  alert_id: string;
  rule_name: string;
  severity: Severity;
  timestamp: string;
  raw_log: string;
  /**
   * Which system produced this alert — `wazuh`, `splunk`, `generic`…
   *
   * Derived from the route that received it, never from the payload: a sender
   * does not get to claim it is something else, and the normalizer that ran is
   * a fact about our own plumbing.
   */
  source: string;
  /**
   * Every vendor field the mapping had no canonical home for, intact.
   *
   * Dropping them would make the pipeline lossy in the one place that must not
   * be: the raw material of an audited decision.
   */
  extensions: Record<string, unknown>;
  ingested_at: string | null;
  source_workflow: string;
  shadow_mode: boolean;
}

/** État d'une source d'enrichissement. Les trois cas sont distincts et le restent. */
export type SourceStatus = 'ok' | 'skipped' | 'unavailable';

export interface SourceResult {
  status: SourceStatus;
  source: string;
  reason?: string;
  http_status?: number | null;
  [field: string]: unknown;
}

export interface Enrichment {
  shodan: SourceResult;
  abuseipdb: SourceResult;
  vt: SourceResult;
}

export interface EnrichmentMeta {
  enriched_at: string;
  file_hash: string | null;
  file_hash_type: 'md5' | 'sha1' | 'sha256' | null;
  source_ip_is_private: boolean | null;
  sources_ok: string[];
  sources_skipped: string[];
  sources_unavailable: string[];
  /** Au moins une source indisponible. Plafonne la confiance en aval. */
  degraded: boolean;
}

export interface EnrichedAlert extends AlertPayload {
  enrichment: Enrichment;
  enrichment_meta: EnrichmentMeta;
}

/** Ce que le modèle doit produire. Exactement ces cinq clés, rien d'autre. */
export interface ModelDecision {
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  recommended_action: Action;
  data_lineage: string[];
}

export const DECISION_KEYS = [
  'verdict', 'confidence', 'reasoning', 'recommended_action', 'data_lineage',
] as const;

export interface FinalDecision extends ModelDecision {
  /** Confiance AVANT plafonnement. Sans elle, un plafond est invisible. */
  raw_confidence: number | null;
  decision_source: string;
  model: string | null;
  attempts: number | null;
  usage: { input_tokens: number | null; output_tokens: number | null } | null;
  is_fallback: boolean;
  /** Les corrections déterministes appliquées après le modèle, en clair. */
  guardrails_applied: string[];
  validator_violations: string[] | null;
}

// --- Petits utilitaires partagés ------------------------------------------------

/**
 * The machine `isolate_host_temporary` would quarantine, or `null`.
 *
 * WHY THIS IS NOT JUST `dest_ip`. Since N1 the observables are optional, and
 * most sources carry no destination at all: a Wazuh detection names the
 * affected machine as its agent, not as a destination address. Both fields
 * mean "the box to cut off the network", so both are accepted — and when
 * neither is present there is NOTHING TO ISOLATE.
 *
 * That last case is the point of this function. Without it the pipeline would
 * compose "Isoler temporairement undefined du réseau" and put it in front of a
 * human for approval. An action whose target is unknown is not an action.
 */
export function isolationTarget(alert: {
  dest_ip?: string | null; host?: string | null;
}): string | null {
  const candidate = alert.dest_ip ?? alert.host ?? null;
  if (candidate === null) return null;
  const trimmed = String(candidate).trim();
  return trimmed === '' ? null : trimmed;
}


/** Champ manquant, vide, ou fait uniquement d'espaces. */
export function missingFields(
  body: Record<string, unknown>,
  required: readonly string[] = REQUIRED_FIELDS,
): string[] {
  return required.filter((f) => {
    const v = body[f];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

/**
 * Tronque un texte pour un message d'erreur.
 *
 * Les messages du pipeline finissent dans Slack et dans la table d'audit : une
 * trace de 800 caractères noie la cause sous du bruit — constaté à l'écran.
 */
export const clip = (value: unknown, max = 300): string =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
