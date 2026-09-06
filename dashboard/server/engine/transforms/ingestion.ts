/**
 * 01-Ingestion — validation de schéma.
 *
 * ============================================================================
 * CE QUI A ÉTÉ SIMPLIFIÉ EN QUITTANT n8n
 *
 *  - LA BOUCLE `$input.all()` ET L'EMBALLAGE `{ json: … }` disparaissent. Le
 *    webhook reçoit une alerte, la fonction en rend une. Le protocole d'items
 *    de n8n servait n8n, pas le pipeline.
 *
 *  - `item.json.body || item.json` disparaît aussi : cette double lecture
 *    rattrapait le fait que n8n emballe différemment selon `rawBody`. Notre
 *    déclencheur passe le corps, point.
 *
 *  - LES TROIS NŒUDS « Build Error Ctx » ET LEURS TROIS APPELS AU GESTIONNAIRE
 *    D'ERREURS DISPARAISSENT. Ils reconstruisaient à la main ce que n8n ne
 *    portait pas : quel workflow, quelle étape, quelle erreur. Le journal
 *    d'exécution le sait déjà — identifiant de nœud, port emprunté, message,
 *    horodatage. Six nœuds de plomberie en moins, et l'information est plus
 *    juste puisqu'elle n'est plus recopiée.
 *
 * ============================================================================
 * CE QUI N'A PAS CHANGÉ, ET NE DOIT PAS
 *
 * LA FONCTION NE LÈVE JAMAIS. Elle rend toujours un résultat portant
 * `validation_ok`. Une alerte mal formée est une réponse 400 documentée, pas
 * une exception : l'appelant doit savoir CE QUI manque, et le pipeline doit
 * pouvoir répondre plutôt que de laisser une requête sans réponse.
 * ============================================================================
 */

import {
  IDENTITY_FIELDS, OBSERVABLE_FIELDS, SEVERITIES, clip, missingFields,
  type AlertPayload, type Observables, type Severity,
} from './domain.ts';

/**
 * Reads an observable: a real value, or `null`.
 *
 * `null` and `""` are NOT the same thing and must not be conflated. An empty
 * string travels through the pipeline looking like data, prints as a blank in
 * the UI, and reaches the model as though the source had answered. `null`
 * says the source never carried it.
 */
const observable = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

/**
 * Reconnaît un littéral IPv4 ou IPv6.
 *
 * Volontairement permissive, comme l'originale : elle écarte le texte libre,
 * pas les adresses exotiques. Un filtre strict rejetterait des alertes
 * légitimes venues d'équipements qui écrivent les adresses à leur façon — et
 * une alerte rejetée est une alerte perdue.
 */
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;

export interface ValidationResult {
  validation_ok: boolean;
  errors: string[];
  missing_fields: string[];
  received_at: string;
  payload: AlertPayload | null;
  /** Conservé UNIQUEMENT en cas de rejet : c'est ce qui permet d'expliquer. */
  raw_body: Record<string, unknown> | null;
}

export function validateAlertSchema(
  input: unknown,
  now: () => Date = () => new Date(),
  source = 'generic',
): ValidationResult {
  const body = (input ?? {}) as Record<string, unknown>;
  const errors: string[] = [];

  // N1 — ONLY IDENTITY IS MANDATORY. An observable that the source never
  // carried is not a malformed alert; it is an alert about something that has
  // no source address, or no destination, or no user. Most of them are.
  const missing = missingFields(body, IDENTITY_FIELDS);
  if (missing.length > 0) errors.push(`missing_required_fields: ${missing.join(', ')}`);

  if (!missing.includes('severity') && !SEVERITIES.includes(String(body.severity).toLowerCase() as Severity)) {
    errors.push(`invalid_severity: expected one of ${SEVERITIES.join('|')}`);
  }
  if (!missing.includes('timestamp') && Number.isNaN(Date.parse(String(body.timestamp)))) {
    errors.push('invalid_timestamp: not ISO-8601 parseable');
  }

  // An address that is PRESENT must still be an address. Absent is fine;
  // present-and-nonsense is a mapping bug, and saying so is how it gets found.
  const observables = {} as Observables;
  for (const field of OBSERVABLE_FIELDS) observables[field] = observable(body[field]);
  for (const field of ['source_ip', 'dest_ip'] as const) {
    const v = observables[field];
    if (v !== null && !IP_RE.test(v)) {
      errors.push(`invalid_${field}: not an IPv4/IPv6 literal`);
    }
  }

  const ok = errors.length === 0;
  const at = now().toISOString();

  // Whatever the mapping had no canonical home for, kept whole. The known
  // keys are removed so `extensions` is the remainder, not a duplicate.
  const known = new Set<string>([
    ...IDENTITY_FIELDS, ...OBSERVABLE_FIELDS,
    'source', 'extensions', 'ingested_at', 'source_workflow', 'shadow_mode',
  ]);
  const extensions: Record<string, unknown> = {
    ...(body.extensions as Record<string, unknown> ?? {}),
  };
  for (const [k, v] of Object.entries(body)) if (!known.has(k)) extensions[k] = v;

  return {
    validation_ok: ok,
    errors,
    missing_fields: missing,
    received_at: at,
    payload: ok
      ? {
          ...observables,
          alert_id: String(body.alert_id).trim(),
          rule_name: String(body.rule_name),
          severity: String(body.severity).toLowerCase() as Severity,
          timestamp: new Date(String(body.timestamp)).toISOString(),
          raw_log: String(body.raw_log),
          // The ROUTE says which system this came from, never the payload: a
          // sender does not get to claim it is something else.
          source,
          extensions,
          ingested_at: at,
          source_workflow: '01-Ingestion',
          // Valeur de départ, PAS la décision finale : c'est 03 qui tranche,
          // et son défaut est également `true`. Deux couches, même sens.
          shadow_mode: true,
        }
      : null,
    raw_body: ok ? null : body,
  };
}

/** Corps de la réponse 400. Il doit dire CE QUI manque, pas « invalide ». */
export function rejectionBody(result: ValidationResult): Record<string, unknown> {
  return {
    status: 'rejected',
    reason: 'schema_validation_failed',
    errors: result.errors,
    missing_fields: result.missing_fields,
    // L'identifiant même d'une alerte rejetée aide à la retrouver côté émetteur.
    alert_id: result.raw_body ? (result.raw_body.alert_id ?? null) : null,
  };
}

/**
 * Interprète le résultat de la déduplication.
 *
 * La requête SQL fait le travail (CTE + INSERT dans la même transaction, donc
 * pas de course sur un réessai réseau) ; cette fonction ne fait que nommer son
 * résultat. Elle existe séparément pour être testable sans base de données.
 */
export function interpretDedup(rows: unknown): { is_duplicate: boolean } {
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) {
    // Zéro ligne d'une requête qui doit toujours en rendre une : on ne devine
    // PAS « pas un doublon ». Traiter une réponse vide comme un feu vert
    // laisserait passer les doublons le jour où la requête change.
    throw new Error(
      `Deduplication returned no row. With no answer we cannot ` +
        `affirmer que l'alerte est nouvelle.`,
    );
  }
  return { is_duplicate: first.is_duplicate === true };
}

export const acceptedBody = (alertId: string) => ({
  status: 'accepted',
  alert_id: alertId,
  pipeline_triggered: true,
  next_workflow: '02-Enrichment',
});

export const duplicateBody = (alertId: string) => ({
  status: 'duplicate, skipped',
  alert_id: alertId,
  pipeline_triggered: false,
});

export const dedupDownBody = (alertId: string | null, detail?: unknown) => ({
  status: 'error',
  reason: 'dedup_store_unavailable',
  alert_id: alertId,
  // `retry_safe` dit à l'émetteur qu'il PEUT rejouer : la déduplication n'a
  // pas eu lieu, donc rien n'a été consommé.
  retry_safe: true,
  detail: detail === undefined ? undefined : clip(detail),
});
