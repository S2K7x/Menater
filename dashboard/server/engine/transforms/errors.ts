/**
 * 06-Error-Handler — le dernier filet.
 *
 * ============================================================================
 * CE QUE LE PORTAGE A FAIT DISPARAÎTRE
 *
 * L'ancien nœud normalisait DEUX formes d'entrée : un contexte construit à la
 * main par les branches d'erreur de 01→05, et la forme `{ execution, workflow }`
 * de l'Error Trigger natif de n8n.
 *
 * La seconde n'existe plus, et la première non plus. Les six nœuds
 * « Build Error Ctx » recopiaient à la main ce que le moteur SAIT :
 * l'identifiant du nœud, le port emprunté, le message, l'horodatage, et
 * l'exécution qui les porte. Un incident se construit maintenant depuis le
 * journal, pas depuis une recopie qui pouvait diverger.
 *
 * ============================================================================
 * TROIS RÈGLES, ET ELLES N'ONT PAS CHANGÉ
 *
 *  1. NE JAMAIS LEVER. Si ce fichier casse, l'incident est muet. C'est la
 *     seule chose pire qu'un incident.
 *
 *  2. NE JAMAIS S'APPELER SOI-MÊME. Une erreur dans le gestionnaire d'erreurs
 *     ne déclenche pas le gestionnaire d'erreurs. La console reste le dernier
 *     endroit où la trace survit.
 *
 *  3. NE PAS POUVOIR JOURNALISER N'EST JAMAIS UNE RAISON DE NE PAS ALERTER.
 *     C'est une raison d'alerter PLUS FORT : si la base est muette, on ne peut
 *     plus compter les erreurs, donc on ne peut plus distinguer un incident
 *     isolé d'une panne générale.
 * ============================================================================
 */

import { clip } from './domain.ts';

export type ErrorSeverity = 'low' | 'medium' | 'high';

/**
 * Sévérité par code d'erreur.
 *
 * Le classement suit une seule question : QU'EST-CE QUI EST PERDU ?
 *   `low`    — le client a envoyé n'importe quoi. Ce n'est pas notre panne.
 *   `medium` — dégradation fonctionnelle, le pipeline continue.
 *   `high`   — perte de donnée, alerte bloquée, ou action impossible à valider.
 */
export const SEVERITY_BY_CODE: Record<string, ErrorSeverity> = {
  SCHEMA_VALIDATION_FAILED: 'low',

  LLM_SCHEMA_INVALID_AFTER_RETRIES: 'medium',
  PAYLOAD_SCHEMA_INVALID: 'medium',
  DEDUP_STORE_UNAVAILABLE: 'medium',

  SUBWORKFLOW_DISPATCH_FAILED: 'high',
  LLM_API_UNAVAILABLE: 'high',
  AUDIT_WRITE_FAILED: 'high',
  AUDIT_RECORD_UNUSABLE: 'high',
  APPROVAL_REQUEST_FAILED: 'high',
  ACTION_EXECUTION_FAILED: 'high',
  RESUME_CALLBACK_FAILED: 'high',
  /**
   * Propre au nouveau moteur : une écriture interrompue dont on ignore
   * l'issue. Toujours `high` — c'est précisément le cas où un humain doit
   * trancher, et où deviner serait le pire choix.
   */
  STEP_INDETERMINATE: 'high',
};

export interface ErrorEvent {
  workflow_id: string;
  node_id: string | null;
  error_code: string;
  error_message: string;
  severity: ErrorSeverity;
  severity_source: 'declared' | 'lookup table' | 'default';
  alert_id: string | null;
  run_id: string | null;
  requires_replay: boolean;
  received_at: string;
  details: Record<string, unknown> | null;
}

/**
 * Builds an incident from what the engine actually logged.
 *
 * No manual copying left: `runId`, `workflowId` and `nodeId` come from the run
 * journal, which is the source of truth. An incident can therefore no longer
 * name a step that does not exist.
 */
export function normalizeErrorEvent(
  input: unknown,
  now: () => Date = () => new Date(),
): ErrorEvent {
  const b = (input ?? {}) as Record<string, unknown>;
  const code = typeof b.error_code === 'string' ? b.error_code : null;
  const declared = ['low', 'medium', 'high'].includes(b.severity as string)
    ? (b.severity as ErrorSeverity)
    : null;

  return {
    workflow_id: (b.workflow_id as string) ?? 'unknown',
    node_id: (b.node_id as string) ?? null,
    error_code: code ?? 'UNSPECIFIED_ERROR',
    // 4000 characters: enough for a useful trace, bounded so a burst failure's
    // stack traces cannot fill the database.
    error_message: clip(b.error_message ?? b.message ?? 'no message provided', 4000),
    // Precedence: declared severity > lookup table > `medium`. The default is
    // NOT `low`: an error nobody could classify deserves to be looked at.
    severity: declared ?? (code ? SEVERITY_BY_CODE[code] : undefined) ?? 'medium',
    severity_source: declared
      ? 'declared'
      : code && SEVERITY_BY_CODE[code]
        ? 'lookup table'
        : 'default',
    alert_id: (b.alert_id as string) ?? null,
    run_id: (b.run_id as string) ?? null,
    requires_replay: b.requires_replay === true,
    received_at: now().toISOString(),
    details: (b.details as Record<string, unknown>) ?? null,
  };
}

export type ErrorRoute = ErrorSeverity | 'systemic' | 'suppressed';

export interface Assessment {
  event: ErrorEvent;
  db: { logged: boolean; error_id: string | null; log_failure: string | null };
  window: {
    minutes: number;
    threshold: number;
    errors_in_window: number | null;
    minutes_since_last_systemic: number | null;
    suppress_minutes: number;
  };
  route: ErrorRoute;
  escalated_because_db_down: boolean;
}

/**
 * Décide la route.
 *
 * UNE RAFALE NE DOIT PAS PRODUIRE N NOTIFICATIONS IDENTIQUES. Au-delà du
 * seuil, l'alerte « panne systémique » REMPLACE l'alerte individuelle — et
 * elle-même est supprimée si la même a déjà été envoyée récemment. Vingt
 * messages identiques dans un canal, c'est un canal que plus personne ne lit.
 */
export function assessError(
  event: ErrorEvent,
  db: Record<string, unknown> | null,
  vars: { windowMinutes: number; threshold: number; suppressMinutes: number },
): Assessment {
  const logged = db !== null && db.error_id !== undefined && db.error_id !== null;
  const errorsInWindow = logged ? Number(db!.errors_in_window) : null;
  const minutesSince =
    logged && db!.minutes_since_systemic !== null && db!.minutes_since_systemic !== undefined
      ? Number(db!.minutes_since_systemic)
      : null;

  const overThreshold = logged && (errorsInWindow ?? 0) >= vars.threshold;
  const suppressed = overThreshold && minutesSince !== null && minutesSince < vars.suppressMinutes;
  const systemic = overThreshold && !suppressed;

  let route: ErrorRoute;
  if (systemic) route = 'systemic';
  else if (suppressed) route = 'suppressed';
  else if (['low', 'medium', 'high'].includes(event.severity)) route = event.severity;
  // Une sévérité inattendue ne doit pas faire disparaître l'incident : elle
  // est traitée comme `high`. Mieux vaut une notification de trop qu'un silence.
  else route = 'high';

  return {
    event,
    db: {
      logged,
      error_id: logged ? String(db!.error_id) : null,
      log_failure: logged ? null : clip(db?.error ?? 'insertion en base impossible'),
    },
    window: {
      minutes: vars.windowMinutes,
      threshold: vars.threshold,
      errors_in_window: errorsInWindow,
      minutes_since_last_systemic: minutesSince,
      suppress_minutes: vars.suppressMinutes,
    },
    route,
    // Si la base est muette, on ne peut plus compter : on force la remontée.
    escalated_because_db_down: !logged,
  };
}

export type NotificationStatus = 'sent' | 'skipped' | 'failed_abandoned';

/** Journal de dernier recours, injectable pour que les tests l'observent. */
export type LastResortLog = (line: string) => void;

/**
 * Conclut. NE LÈVE JAMAIS, N'APPELLE JAMAIS 06.
 *
 * Quand la notification échoue, la trace part sur la sortie console — le
 * dernier endroit où elle survit quand la base et Slack sont tous deux muets.
 */
export function notificationOutcome(
  assessment: Assessment,
  slackResponse: Record<string, unknown> | null,
  log: LastResortLog = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Record<string, unknown> {
  const a = assessment;
  const r = slackResponse;
  let status: NotificationStatus;
  let detail: string;

  if (a.route === 'low' || a.route === 'suppressed') {
    status = 'skipped';
    detail =
      a.route === 'low'
        ? 'severity low: logged only, no notification.'
        : `systemic failure already reported ${Math.round(a.window.minutes_since_last_systemic ?? 0)} min ago: notification suppressed so the same alarm is not repeated.`;
  } else if (r && (r.ok === true || r.ts)) {
    status = 'sent';
    detail = `Slack ok, ts=${r.ts ?? '?'} channel=${r.channel ?? '?'}`;
  } else {
    status = 'failed_abandoned';
    const reason = r?.error ?? (r?.ok === false ? 'Slack answered ok:false' : 'no Slack answer');
    detail = `ABANDONED: ${clip(reason)}`;
    log(
      `[06-Error-Handler][NOTIFICATION ABANDONED] route=${a.route} ` +
        `workflow=${a.event.workflow_id} code=${a.event.error_code} ` +
        `severity=${a.event.severity} error_id=${a.db.error_id} ` +
        `alert_id=${a.event.alert_id} | message=${a.event.error_message}`,
    );
  }

  if (!a.db.logged) {
    log(
      `[06-Error-Handler][DATABASE UNAVAILABLE] the error could not be logged: ` +
        `${a.db.log_failure} | workflow=${a.event.workflow_id} code=${a.event.error_code}`,
    );
  }

  return {
    source_workflow: '06-Error-Handler',
    handled_at: now().toISOString(),
    route: a.route,
    severity: a.event.severity,
    workflow_id: a.event.workflow_id,
    error_code: a.event.error_code,
    alert_id: a.event.alert_id,
    error_id: a.db.error_id,
    db_logged: a.db.logged,
    notification: { status, detail, channel: r?.channel ?? null },
    window: a.window,
  };
}
