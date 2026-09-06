/**
 * Le registre : le seul pont entre une définition et du code.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EXISTE
 *
 * Une définition de workflow désigne une transformation par son NOM. Ce
 * fichier est le seul endroit qui associe ce nom à une fonction TypeScript.
 * C'est ce qui permet à une définition de rester de la donnée — éditable,
 * versionnée, affichée — sans jamais pouvoir devenir du code.
 *
 * Un test vérifie que CHAQUE nom référencé par les six workflows est
 * enregistré ici. Sans lui, un nœud désignant une fonction disparue ne se
 * verrait qu'à l'exécution, sur l'alerte qui en dépend.
 *
 * ============================================================================
 * LES ADAPTATEURS DE BRANCHE
 *
 * La seconde moitié du fichier tient en quelques lignes par fonction et
 * remplace ce qui, sous n8n, était un nœud `set` : donner un nom à une issue.
 * « L'action a échoué », « personne n'a répondu », « la trace n'a pas pu être
 * écrite ». Ils existent séparément parce que chacun porte un CODE D'ERREUR
 * que 06 sait classer — les inventer au vol donnerait des incidents non
 * classés, c'est-à-dire des incidents qu'on ne priorise pas.
 * ============================================================================
 */

import { TransformRegistry, type TransformFn } from '../nodes/pure.ts';
import { REQUIRED_FIELDS, missingFields, type EnrichedAlert } from './domain.ts';
import { evaluateRules, type TuningRule } from './tuning.ts';
import {
  acceptedBody, dedupDownBody, duplicateBody, interpretDedup, rejectionBody,
  validateAlertSchema, type ValidationResult,
} from './ingestion.ts';
import { assembleEnriched, guardEnrichmentPayload, normalizeSource, skipped, type GuardResult } from './enrichment.ts';
import {
  buildCorrectionPrompt, buildDecisionPrompt, fallbackDecision, finalizeDecision,
  validateDecision, type ValidationOutcome,
} from './decision.ts';
import {
  buildApprovalRequest, buildAuditRecord, enforceCatalog, guardRoutingPayload,
  interpretApproval, shadowBaseline, shadowOutcome, type ApprovalRequest, type DecidedAlert,
} from './routing.ts';
import { exposeAuditAndMetrics, normalizeAuditRow } from './audit.ts';
import { assessError, normalizeErrorEvent, notificationOutcome, type Assessment } from './errors.ts';

export interface RegistryDeps {
  now: () => Date;
  /**
   * Lien de reprise d'une approbation, pour l'exécution DONNÉE.
   *
   * Il prend le run id en argument : le fabriquer à partir d'une variable de
   * module donnait la même URL à toutes les exécutions — et, l'affectation
   * n'ayant jamais été écrite, une URL sans identifiant du tout.
   */
  resumeUrl: (runId: string) => string;
}

/** Lit une variable, en refusant d'inventer une valeur absente. */
function need<T>(vars: ReadonlyMap<string, unknown>, key: string, kind: 'number' | 'string'): T {
  const value = vars.get(key);
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Variable \u201c${key}\u201d is absent. A default invented here would go ` +
        `unnoticed until the next alert.`,
    );
  }
  const cast = kind === 'number' ? Number(value) : String(value);
  if (kind === 'number' && !Number.isFinite(cast as number)) {
    throw new Error(`Variable « ${key} » : « ${String(value)} » n'est pas un nombre.`);
  }
  return cast as T;
}

const asRecord = (v: unknown) => (v ?? {}) as Record<string, unknown>;

export function buildRegistry(deps: RegistryDeps): TransformRegistry {
  const r = new TransformRegistry();
  const reg = (name: string, fn: TransformFn) => r.register(name, fn);

  // --- 01 Ingestion -----------------------------------------------------------
  reg('validateAlertSchema', (input) => validateAlertSchema(input, deps.now));
  reg('rejectionBody', (input) => rejectionBody(input as ValidationResult));
  reg('interpretDedup', (input) => interpretDedup(asRecord(input).rows));
  reg('acceptedBody', (input) => acceptedBody(String(asRecord(input).alert_id ?? '')));
  reg('duplicateBody', (input) => duplicateBody(String(asRecord(input).alert_id ?? '')));
  reg('dedupDownBody', (input) => {
    const b = asRecord(input);
    return dedupDownBody((b.alert_id as string) ?? null, b.error);
  });

  // --- 02 Enrichment ----------------------------------------------------------
  reg('guardEnrichmentPayload', (input) => guardEnrichmentPayload(input));
  reg('assembleEnriched', (input) => {
    const wired = asRecord(input);
    const guard = wired.guard as GuardResult;
    // Une source non interrogée n'est PAS un échec : le garde a décidé qu'il
    // n'y avait pas de question à poser, et `skipped` ne dégrade pas.
    const askVt = guard.has_hash;
    const askIp = guard.source_ip_is_private === false;
    return assembleEnriched(
      guard,
      {
        shodan: askIp
          ? normalizeSource('shodan', wired.shodan)
          : skipped('shodan', 'private source address: nothing to look up'),
        abuseipdb: askIp
          ? normalizeSource('abuseipdb', wired.abuseipdb)
          : skipped('abuseipdb', 'private source address: nothing to look up'),
        vt: askVt
          ? normalizeSource('vt', wired.virustotal)
          : skipped('virustotal', 'no hash in the raw log'),
      },
      deps.now,
    );
  });
  reg('enrichmentRejection', (input) => ({
    status: 'rejected',
    reason: 'PAYLOAD_SCHEMA_INVALID',
    missing_fields: (input as GuardResult).missing_fields,
  }));

  // --- 03 AI Decision ---------------------------------------------------------
  reg('guardDecisionPayload', (input) => {
    const b = asRecord(input);
    const missing = missingFields(b, REQUIRED_FIELDS);
    // `enrichment` en plus des sept champs : sans lui, le modèle déciderait
    // sur la seule règle de détection, ce que 02 existe pour éviter.
    if (!b.enrichment) missing.push('enrichment');
    const ok = missing.length === 0;
    return {
      payload_ok: ok,
      missing_fields: missing,
      alert: ok ? (b as unknown as EnrichedAlert) : null,
    };
  });
  reg('decisionRejection', (input) => ({
    status: 'rejected',
    reason: 'PAYLOAD_SCHEMA_INVALID',
    missing_fields: asRecord(input).missing_fields ?? [],
  }));
  reg('buildDecisionPrompt', (input) => {
    const alert = (asRecord(input).alert ?? input) as EnrichedAlert;
    return { alert_id: alert.alert_id, attempt: 1, ...buildDecisionPrompt(alert) };
  });
  reg('validateDecision', (input) => {
    const b = asRecord(input);
    const alert = (b.alert ?? {}) as EnrichedAlert;
    const meta = alert.enrichment_meta;
    return validateDecision(b.decision ?? b, {
      sourcesOk: meta?.sources_ok ?? [],
      sourcesUnavailable: meta?.sources_unavailable ?? [],
      attempt: Number(b.attempt ?? 1),
    });
  });
  reg('buildCorrectionPrompt', (input) => {
    const b = asRecord(input);
    return buildCorrectionPrompt(b.previous as ValidationOutcome, {
      alert_block: String(b.alert_block ?? ''),
    });
  });
  reg('fallbackSchemaInvalid', (input) => {
    const b = input as ValidationOutcome;
    return fallbackDecision('schema_invalid', { attempt: b.attempt, violations: b.violations });
  });
  reg('fallbackApiUnavailable', (input) => {
    const b = asRecord(input);
    return fallbackDecision('api_unavailable', { error: b.error ?? b.message });
  });
  reg('finalizeDecision', (input, vars) => {
    const b = asRecord(input);
    return finalizeDecision(b.alert as EnrichedAlert, b as never, vars, deps.now);
  });

  /**
   * Applies the team's tuning rules to a freshly validated alert.
   *
   * WHAT A RULE MAY DO, AND WHAT IT MAY NOT. It can close the alert as
   * known-good, soften or raise its severity, or force it to a human. It can
   * NEVER cause an action: there is no rule outcome that reaches the closed
   * action catalogue, and `closed_by_rule` leads to 05-Audit-Log, not to 04.
   *
   * A rules table that could not be read leaves `rows` empty, and an empty
   * rule set changes nothing. That direction is deliberate: losing the rules
   * makes the pipeline NOISIER, never more permissive.
   */
  reg('applyTuningRules', (input) => {
    const b = asRecord(input);
    const alert = asRecord(b.alert);
    const rows = Array.isArray(b.rows) ? (b.rows as TuningRule[]) : [];
    const outcome = evaluateRules(alert, rows, deps.now);

    const closing = outcome.action === 'allow' || outcome.action === 'suppress';

    return {
      // The alert as it continues: severity is the only field a rule rewrites.
      alert: { ...alert, severity: outcome.severity },
      closed_by_rule: closing,
      tuning: {
        matched_rule: outcome.rule ? { id: outcome.rule.id, name: outcome.rule.name } : null,
        action: outcome.action,
        note: outcome.note,
        severity_before: alert.severity ?? null,
        severity_after: outcome.severity,
        // `escalate` is not applied here: 03 is where a verdict is decided,
        // and forcing a human earlier would mean deciding without the model
        // having looked. It travels as a flag the last barrier honours.
        force_human: outcome.action === 'escalate',
        expired_rules: outcome.expired,
      },
      /**
       * The payload 05-Audit-Log receives, FLAT.
       *
       * It reads `alert_id` at the TOP level and answers `row_ok: false`
       * otherwise — which routes to `unusable` and writes nothing, while the
       * run still reports `done`. Nesting the alert under `alert` therefore
       * produced a rule-closed alert with no audit row at all: closed AND
       * dropped, the exact thing this action exists not to do, and green
       * everywhere.
       */
      ...(closing
        ? {
          audit_payload: {
            ...alert,
            severity: outcome.severity,
            source_workflow: '01-Ingestion (tuning rule)',
            decision: {
              verdict: 'false_positive',
              confidence: 1,
              reasoning: `Closed by a tuning rule: ${outcome.note}`,
              recommended_action: 'auto_close',
              data_lineage: ['tuning_rule'],
              decision_source: 'tuning_rule',
              is_fallback: false,
              guardrails_applied: [],
              validator_violations: null,
              model: null,
              attempts: null,
              usage: null,
              raw_confidence: null,
            },
            // A rule closing an alert is not an ACTION: nothing was executed,
            // and `shadow_mode` stays whatever the pipeline default is.
            executed: false,
            action_taken: 'auto_close',
            routing_outcome: 'closed_by_rule',
            tuning: {
              matched_rule: outcome.rule ? { id: outcome.rule.id, name: outcome.rule.name } : null,
              note: outcome.note,
            },
          },
        }
        : {}),
      ...(closing
        ? {
          decision: {
            verdict: 'false_positive',
            confidence: 1,
            reasoning: `Closed by a tuning rule: ${outcome.note}`,
            recommended_action: 'auto_close',
            data_lineage: ['tuning_rule'],
            decision_source: 'tuning_rule',
            is_fallback: false,
            guardrails_applied: [],
            validator_violations: null,
            model: null,
            attempts: null,
            usage: null,
            raw_confidence: null,
          },
          shadow_mode: false,
          execution_allowed: false,
          routing_outcome: 'closed_by_rule',
        }
        : {}),
    };
  });

  // --- 04 Action Routing ------------------------------------------------------
  reg('guardRoutingPayload', (input) => guardRoutingPayload(input));
  reg('shadowOutcome', (input, vars) => {
    const b = asRecord(input);
    const threshold = need<number>(vars, 'shadow.exitThreshold', 'number');
    return shadowOutcome(b.alert as DecidedAlert, shadowBaseline(b.rows, threshold));
  });
  reg('buildApprovalRequest', (input, vars, run) => {
    const alert = (asRecord(input).alert ?? input) as DecidedAlert;
    return buildApprovalRequest(
      alert,
      {
        ttlMinutes: need<number>(vars, 'isolation.ttlMinutes', 'number'),
        isolationEndpoint: need<string>(vars, 'endpoint.isolation', 'string'),
        approvalChannel: need<string>(vars, 'slack.approvalChannel', 'string'),
        escalationChannel: need<string>(vars, 'slack.escalationChannel', 'string'),
        timeoutMinutes: need<number>(vars, 'approval.timeoutMinutes', 'number'),
        // NOT through `need`: a console that has never set a notification
        // threshold must keep working, and the absence has a safe meaning
        // ("notify about everything") rather than being a configuration hole.
        minSeverity: vars.get('notify.minSeverity'),
        transport: vars.get('notify.transport'),
      },
      deps.resumeUrl(run.runId),
      deps.now,
    );
  });
  /**
   * An approval request that was NOT posted because of the severity threshold.
   *
   * It joins the same path as a request Slack refused: escalate, do not wait.
   * The difference is the reason, and the reason matters — "we chose not to
   * ask" and "we could not ask" call for different fixes.
   */
  reg('approvalBelowThreshold', (input) => {
    const request = asRecord(input);
    return {
      routing_outcome: 'not_notified',
      executed: false,
      action_taken: 'none',
      action_details: {
        reason: String(request.not_notified_reason ?? 'below the Slack notification threshold'),
        // SAID OUT LOUD, because this is the consequence somebody bought when
        // they raised the threshold: nobody was asked, so nothing is approved.
        consequence:
          'No approval was requested, so the alert was not left waiting for one. '
          + 'It is escalated and appears in the console queue; no action was executed.',
      },
      would_have_done: request.proposed_action ?? null,
      approval: null,
    };
  });

  reg('interpretApproval', (input, vars) => {
    const b = asRecord(input);
    return interpretApproval(
      b.request as ApprovalRequest,
      b.payload,
      need<number>(vars, 'approval.timeoutMinutes', 'number'),
      deps.now,
    );
  });
  reg('enforceCatalog', (input) => enforceCatalog(input as { proposed_action: string }));
  reg('buildAuditRecord', (input) => {
    const b = asRecord(input);
    return buildAuditRecord(b.alert as DecidedAlert, asRecord(b.outcome), deps.now);
  });

  // --- 05 Audit ---------------------------------------------------------------
  reg('normalizeAuditRow', (input, _vars, run) => normalizeAuditRow(input, run.runId, deps.now));
  reg('exposeAuditAndMetrics', (input) => {
    const b = asRecord(input);
    return exposeAuditAndMetrics(
      (b.committed as Record<string, unknown>) ?? null,
      (b.metrics as Record<string, unknown>) ?? null,
    );
  });

  // --- 06 Error Handler -------------------------------------------------------
  reg('normalizeErrorEvent', (input) => normalizeErrorEvent(input, deps.now));
  reg('assessError', (input, vars) => {
    const b = asRecord(input);
    return assessError(b.event as never, (b.db as Record<string, unknown>) ?? null, {
      windowMinutes: need<number>(vars, 'errors.windowMinutes', 'number'),
      threshold: need<number>(vars, 'errors.systemicThreshold', 'number'),
      suppressMinutes: need<number>(vars, 'errors.suppressMinutes', 'number'),
    });
  });
  reg('notificationOutcome', (input) => {
    const b = asRecord(input);
    return notificationOutcome(
      b.assessment as Assessment,
      (b.slack as Record<string, unknown>) ?? null,
      undefined,
      deps.now,
    );
  });

  // --- Adaptateurs de branche -------------------------------------------------
  //
  // Chacun porte un CODE D'ERREUR que 06 sait classer. Les inventer au vol
  // donnerait des incidents « non classés » — c'est-à-dire des incidents que
  // personne ne priorise.

  /** Fabrique une issue d'échec nommée. */
  const failure = (code: string, outcome: string, message: string): TransformFn => (input) => ({
    routing_outcome: outcome,
    executed: false,
    action_taken: 'none',
    action_details: { error_code: code, detail: message, cause: asRecord(input).error ?? null },
    approval: null,
  });

  reg('approvalRequestFailed', failure(
    'APPROVAL_REQUEST_FAILED',
    'approval_request_failed',
    // Sans question posée, attendre trente minutes n'a aucun sens : personne
    // ne peut répondre à un message qui n'existe pas.
    'The approval request could not be posted: no wait is open, so the alert is escalated.',
  ));
  reg('actionExecutionFailed', failure(
    'ACTION_EXECUTION_FAILED',
    'execution_failed',
    'The approved action failed. It is NOT retried automatically: its outcome is unknown.',
  ));

  reg('approvalTimedOut', (input, vars) => {
    const request = asRecord(input).request as ApprovalRequest;
    const minutes = need<number>(vars, 'approval.timeoutMinutes', 'number');
    const { approval } = interpretApproval(request, null, minutes, deps.now);
    return {
      routing_outcome: 'timeout_escalated',
      executed: false,
      action_taken: 'none',
      // LE SILENCE N'EST JAMAIS UN ACCORD : on écrit noir sur blanc ce qui
      // n'a PAS été fait.
      action_details: {
        reason: `No answer in ${minutes} minutes. No action executed.`,
        would_have_done: request?.proposed_action ?? null,
      },
      text: `:hourglass: Approval expired \u2014 ${request?.alert_id ?? '?'} \u2014 `
        + `${request?.proposed_action ?? '?'} was NOT executed after ${minutes} min.`,
      approval,
    };
  });

  reg('approvalRejected', (input) => {
    const b = asRecord(input);
    return {
      routing_outcome: 'rejected',
      executed: false,
      action_taken: 'none',
      action_details: { reason: 'Action refused by a human.' },
      // Un rejet est un DÉSACCORD explicite avec la recommandation de l'IA :
      // c'est lui qui alimente `human_disagreement_rate`, le seul proxy de
      // faux positif observable sans vérité terrain.
      approval: b.approval ?? null,
    };
  });

  reg('auditRecordUnusable', (input) => ({
    error_code: 'AUDIT_RECORD_UNUSABLE',
    severity: 'high',
    error_message: `Ligne d'audit inexploitable : ${(asRecord(input).problems as string[])?.join(' | ') ?? 'raison inconnue'}`,
    details: asRecord(input),
  }));
  reg('auditWriteFailed', (input) => ({
    error_code: 'AUDIT_WRITE_FAILED',
    severity: 'high',
    // Perdre la trace est un incident majeur : c'est la PREUVE de ce qui s'est
    // passé, et la seule chose qu'on ne peut pas reconstituer après coup.
    error_message: 'The audit write failed after retries: the trace of this alert is lost.',
    details: asRecord(input),
  }));

  return r;
}
