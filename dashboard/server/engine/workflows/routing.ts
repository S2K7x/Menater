/**
 * Définitions des workflows 04 → 06.
 *
 * ============================================================================
 * CE QUE LE PORTAGE A RETIRÉ ICI
 *
 * n8n : 32 + 10 + 17 = 59 nœuds. Ici : 37.
 *
 *   - 04 perdait 12 nœuds de plomberie : `noOp` de convergence, `set` de
 *     recopie, et les branches d'erreur qui reconstruisaient un contexte que
 *     le journal porte déjà.
 *
 *   - 06 perd sa DEUXIÈME FORME D'ENTRÉE. Il normalisait à la fois un contexte
 *     bâti à la main par les branches d'erreur de 01→05, et la forme
 *     `{ execution, workflow }` de l'Error Trigger natif de n8n. Cette seconde
 *     forme n'existe plus : un incident se construit depuis le journal
 *     d'exécution, qui connaît le nœud, le port, le message et l'horodatage.
 *
 * ============================================================================
 * LA CORRECTION LA PLUS SÉRIEUSE
 *
 * Le décompte du shadow mode ne vient plus de `$getWorkflowStaticData`, c'est-
 * à-dire de la mémoire du processus n8n, qui repartait de zéro à chaque
 * redémarrage. Il vient d'un `GROUP BY` sur `soc_audit_log`, append-only et à
 * chaînage de hachage. « 50 alertes observées » redevient une phrase vraie.
 *
 * ============================================================================
 * LA GARANTIE QUE CE FICHIER PORTE
 *
 * Aucun chemin ne mène à l'exécution d'une action sans être passé par
 * `attente` ET en être sorti par le port `main`. Le port `timeout` mène à
 * l'escalade, jamais à l'action. Un test le vérifie sur le graphe lui-même.
 * ============================================================================
 */

import type { WorkflowDef } from '../types.ts';

const fromInput = (path: string) => ({ kind: 'input' as const, path });
const fromNode = (nodeId: string, path: string) => ({ kind: 'node' as const, nodeId, path });
const fromVar = (key: string) => ({ kind: 'var' as const, key });
const link = (from: string, to: string, fromPort = 'main') => ({ from, fromPort, to });

// =============================================================================
// 04 — ACTION ROUTING
// =============================================================================

export const ROUTING: WorkflowDef = {
  id: '04-action-routing',
  name: 'Action & Routing',
  version: 1,
  nodes: [
    { id: 'in', type: 'trigger.subflow', label: 'Received from 03-AI-Decision', params: {}, position: { x: 0, y: 0 } },
    {
      id: 'guard', type: 'transform', label: 'Input guard',
      note: 'Requires `shadow_mode` to be a BOOLEAN: the string "false" is truthy in JavaScript.',
      params: { fn: 'guardRoutingPayload' }, position: { x: 180, y: 0 },
    },
    {
      id: 'payload-ok', type: 'if', label: 'Payload usable?',
      params: { condition: { left: fromInput('payload_ok'), op: 'isTrue' } },
      position: { x: 360, y: 0 },
    },
    { id: 'reject', type: 'respond', label: 'Decision unusable', params: { status: 422 }, position: { x: 540, y: 240 } },
    {
      id: 'shadow', type: 'if', label: 'Shadow mode?',
      note: 'The only branch that decides whether the real world is touched.',
      params: { condition: { left: fromInput('alert.shadow_mode'), op: 'isTrue' } },
      position: { x: 540, y: 0 },
    },
    // --- Branche shadow : on compte, on ne fait rien ---
    {
      id: 'baseline-query', type: 'postgres', label: 'Baseline count',
      note: 'From the audit log, NOT from process memory: a restart no longer resets the counter.',
      params: {
        sql:
          'SELECT verdict, recommended_action, is_fallback, count(*)::int AS n ' +
          'FROM soc_audit_log WHERE shadow_mode = true ' +
          'GROUP BY verdict, recommended_action, is_fallback',
        params: [],
      },
      retry: { attempts: 2, backoffMs: 300 },
      position: { x: 740, y: -160 },
    },
    {
      id: 'shadow-count', type: 'transform', label: 'Watch-only counters',
      params: { fn: 'shadowOutcome', inputs: { alert: fromNode('guard', 'alert'), rows: fromNode('baseline-query', 'rows') } },
      position: { x: 940, y: -160 },
    },
    // --- Branche réelle : approbation obligatoire ---
    {
      id: 'request', type: 'transform', label: 'Approval request',
      note: 'Intent, blast radius and rollback plan: all three are mandatory.',
      params: { fn: 'buildApprovalRequest', inputs: { alert: fromNode('guard', 'alert') } },
      position: { x: 740, y: 120 },
    },
    {
      id: 'notify?', type: 'if', label: 'Above the Slack threshold?',
      note: 'Below it nobody is asked \u2014 so the alert is not left waiting for an answer.',
      params: { condition: { left: fromNode('request', 'notify'), op: 'isTrue' } },
      position: { x: 940, y: 120 },
    },
    {
      id: 'post-approval', type: 'notify', label: 'Post the request',
      params: {
        channel: fromNode('request', 'slack.channel'),
        text: fromNode('request', 'slack.text'),
        blocks: fromNode('request', 'slack.blocks'),
        // The Discord form travels beside the Slack one; the node uses whichever
        // its transport speaks. Both were built from the same facts.
        embeds: fromNode('request', 'discord.embeds'),
      },
      position: { x: 1140, y: 60 },
    },
    {
      id: 'below-threshold', type: 'transform', label: 'Not notified \u2014 below threshold',
      note: 'A question nobody asked is never waited on. Escalates, and says why.',
      params: { fn: 'approvalBelowThreshold' },
      position: { x: 1140, y: 260 },
    },
    {
      id: 'notify-failed', type: 'transform', label: 'Request not posted',
      note: 'No question asked means no waiting: escalate instead of idling 30 min for nothing.',
      params: { fn: 'approvalRequestFailed' }, position: { x: 940, y: 320 },
    },
    {
      id: 'attente', type: 'wait', label: 'Human approval wait',
      note: 'Timeout held in a variable: editable in Settings, no restart.',
      params: { timeoutMinutes: fromVar('approval.timeoutMinutes') },
      position: { x: 1140, y: 120 },
    },
    {
      id: 'interpret', type: 'transform', label: 'Interpret the answer',
      note: 'Anything that is not exactly "approve" cannot execute.',
      params: { fn: 'interpretApproval', inputs: { request: fromNode('request', ''), payload: fromInput('') } },
      position: { x: 1340, y: 40 },
    },
    {
      id: 'timeout', type: 'transform', label: 'Timeout — no action',
      note: 'SILENCE IS NEVER CONSENT.',
      params: { fn: 'approvalTimedOut', inputs: { request: fromNode('request', '') } },
      position: { x: 1340, y: 280 },
    },
    {
      id: 'escalate-timeout', type: 'notify', label: 'Escalate on timeout',
      params: { channel: fromVar('slack.escalationChannel'), text: fromNode('timeout', 'text') },
      position: { x: 1540, y: 280 },
    },
    {
      id: 'approved', type: 'if', label: 'Approved?',
      params: { condition: { left: fromInput('outcome'), op: 'eq', right: { kind: 'const', value: 'approved' } } },
      position: { x: 1540, y: 40 },
    },
    {
      id: 'catalog', type: 'transform', label: 'Catalogue — defence in depth',
      note: 'Re-checked AFTER approval: 30 minutes and a possible resume sit between 03 and here.',
      params: { fn: 'enforceCatalog' }, position: { x: 1740, y: 0 },
    },
    {
      id: 'execute', type: 'http', label: 'Execute the approved action',
      params: {
        url: fromVar('endpoint.isolation'), method: 'POST',
        body: fromInput(''), timeoutMs: 10_000,
      },
      position: { x: 1940, y: 0 },
    },
    {
      id: 'execute-failed', type: 'transform', label: 'Action failed',
      params: { fn: 'actionExecutionFailed' }, position: { x: 1940, y: 200 },
    },
    {
      id: 'rejected', type: 'transform', label: 'Human rejection',
      note: 'A rejection is an explicit DISAGREEMENT: it feeds `human_disagreement_rate`.',
      params: { fn: 'approvalRejected' }, position: { x: 1740, y: 200 },
    },
    {
      id: 'audit-record', type: 'transform', label: 'Audit record',
      note: 'Identical whichever branch was taken.',
      params: { fn: 'buildAuditRecord', inputs: { alert: fromNode('guard', 'alert'), outcome: fromInput('') } },
      position: { x: 2160, y: 0 },
    },
    {
      id: 'to-audit', type: 'subflow', label: 'Hand off to 05-Audit-Log',
      params: { workflowId: '05-audit-log' }, position: { x: 2360, y: 0 },
    },
  ],
  edges: [
    link('in', 'guard'),
    link('guard', 'payload-ok'),
    link('payload-ok', 'reject', 'false'),
    link('payload-ok', 'shadow', 'true'),

    link('shadow', 'baseline-query', 'true'),
    link('baseline-query', 'shadow-count'),
    // Un décompte indisponible ne doit pas empêcher de tracer l'alerte.
    link('baseline-query', 'shadow-count', 'error'),
    link('shadow-count', 'audit-record'),

    link('shadow', 'request', 'false'),
    link('request', 'notify?'),
    link('notify?', 'post-approval', 'true'),
    // BELOW THE THRESHOLD: no question, therefore no waiting. It joins the
    // audit record directly, exactly like a request Slack refused.
    link('notify?', 'below-threshold', 'false'),
    link('below-threshold', 'audit-record'),
    link('post-approval', 'notify-failed', 'error'),
    link('notify-failed', 'audit-record'),
    link('post-approval', 'attente'),

    // LES DEUX PORTS DE L'ATTENTE, ET ILS NE MÈNENT PAS AU MÊME ENDROIT.
    link('attente', 'interpret', 'main'),
    link('attente', 'timeout', 'timeout'),

    link('timeout', 'escalate-timeout'),
    link('escalate-timeout', 'audit-record'),
    link('escalate-timeout', 'audit-record', 'error'),

    link('interpret', 'approved'),
    link('approved', 'catalog', 'true'),
    link('approved', 'rejected', 'false'),
    link('rejected', 'audit-record'),
    link('catalog', 'execute'),
    link('execute', 'execute-failed', 'error'),
    link('execute-failed', 'audit-record'),
    link('execute', 'audit-record'),

    link('audit-record', 'to-audit'),
  ],
};

// =============================================================================
// 05 — AUDIT LOG
// =============================================================================

export const AUDIT: WorkflowDef = {
  id: '05-audit-log',
  name: 'Audit Log',
  version: 1,
  nodes: [
    { id: 'in', type: 'trigger.subflow', label: 'Received from 03 or 04', params: {}, position: { x: 0, y: 0 } },
    {
      id: 'normalize', type: 'transform', label: 'Shape the row',
      note: 'Never throws: an error here must not be what loses the record.',
      params: { fn: 'normalizeAuditRow' }, position: { x: 200, y: 0 },
    },
    {
      id: 'row-ok', type: 'if', label: 'Row usable?',
      params: { condition: { left: fromInput('row_ok'), op: 'isTrue' } },
      position: { x: 400, y: 0 },
    },
    {
      id: 'unusable', type: 'transform', label: 'Row unusable',
      note: 'With no alert_id the row attaches to nothing: say so rather than write an orphan.',
      params: { fn: 'auditRecordUnusable' }, position: { x: 600, y: 200 },
    },
    {
      id: 'append', type: 'postgres', label: 'Append-only write',
      note: 'The hash chain is computed BY THE DATABASE: the pipeline cannot forge a link.',
      params: {
        sql:
          'INSERT INTO soc_audit_log (alert_id, source_workflow, verdict, confidence, ' +
          'recommended_action, decision_source, is_fallback, executed, shadow_mode, ' +
          'routing_outcome, action_taken, human_approver, human_approver_id, human_override, ' +
          'human_reasoning, tokens_used, latency_ms, enrichment_sources_available, ' +
          'rule_name, severity, source_ip, dest_ip, execution_id, payload) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ' +
          'RETURNING id, alert_id, event_time, prev_hash, integrity_hash',
        params: [
          fromNode('normalize', 'row.alert_id'), fromNode('normalize', 'row.source_workflow'),
          fromNode('normalize', 'row.verdict'), fromNode('normalize', 'row.confidence'),
          fromNode('normalize', 'row.recommended_action'), fromNode('normalize', 'row.decision_source'),
          fromNode('normalize', 'row.is_fallback'), fromNode('normalize', 'row.executed'),
          fromNode('normalize', 'row.shadow_mode'), fromNode('normalize', 'row.routing_outcome'),
          fromNode('normalize', 'row.action_taken'), fromNode('normalize', 'row.human_approver'),
          fromNode('normalize', 'row.human_approver_id'), fromNode('normalize', 'row.human_override'),
          fromNode('normalize', 'row.human_reasoning'), fromNode('normalize', 'row.tokens_used'),
          fromNode('normalize', 'row.latency_ms'), fromNode('normalize', 'row.enrichment_sources_available'),
          fromNode('normalize', 'row.rule_name'), fromNode('normalize', 'row.severity'),
          fromNode('normalize', 'row.source_ip'), fromNode('normalize', 'row.dest_ip'),
          fromNode('normalize', 'row.execution_id'), fromNode('normalize', 'row.payload'),
        ],
      },
      retry: { attempts: 3, backoffMs: 500 },
      position: { x: 600, y: 0 },
    },
    {
      id: 'write-failed', type: 'transform', label: 'Audit write impossible',
      note: 'Losing the record is a `high` incident: it is the proof of what happened.',
      params: { fn: 'auditWriteFailed' }, position: { x: 800, y: 200 },
    },
    {
      id: 'metrics', type: 'postgres', label: 'Metrics snapshot',
      note: 'BOTH rates, named separately. A failed query says "unavailable", never zero.',
      params: { sql: 'SELECT * FROM soc_metrics_7d()', params: [] },
      retry: { attempts: 1, backoffMs: 200 },
      position: { x: 800, y: 0 },
    },
    {
      id: 'expose', type: 'transform', label: 'Proof + metrics',
      params: {
        fn: 'exposeAuditAndMetrics',
        inputs: { committed: fromNode('append', 'rows.0'), metrics: fromNode('metrics', 'rows.0') },
      },
      position: { x: 1020, y: 0 },
    },
  ],
  edges: [
    link('in', 'normalize'),
    link('normalize', 'row-ok'),
    link('row-ok', 'unusable', 'false'),
    link('row-ok', 'append', 'true'),
    link('append', 'write-failed', 'error'),
    link('append', 'metrics'),
    // Des mesures indisponibles ne doivent pas faire échouer l'écriture, qui
    // est la partie qui compte : la preuve est déjà en base à ce stade.
    link('metrics', 'expose'),
    link('metrics', 'expose', 'error'),
  ],
};

// =============================================================================
// 06 — ERROR HANDLER
// =============================================================================

export const ERRORS: WorkflowDef = {
  id: '06-error-handler',
  name: 'Error Handler',
  version: 1,
  nodes: [
    {
      id: 'in', type: 'trigger.error', label: 'Engine incident',
      note: 'Built from the run LOG: node, port, message, timestamp. No manual copying left.',
      params: {}, position: { x: 0, y: 0 },
    },
    {
      id: 'normalize', type: 'transform', label: 'Normalize the incident',
      params: { fn: 'normalizeErrorEvent' }, position: { x: 200, y: 0 },
    },
    {
      id: 'log', type: 'postgres', label: 'Log + sliding window',
      params: {
        sql:
          'WITH ins AS (INSERT INTO soc_error_log (workflow_id, node_id, error_code, ' +
          'error_message, severity, alert_id, run_id, details) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id) ' +
          'SELECT (SELECT id FROM ins) AS error_id, ' +
          '(SELECT count(*)::int FROM soc_error_log WHERE created_at > now() - ($9 || \' minutes\')::interval) AS errors_in_window, ' +
          '(SELECT extract(epoch FROM now() - max(created_at))/60 FROM soc_error_log WHERE systemic = true) AS minutes_since_systemic',
        params: [
          fromNode('normalize', 'workflow_id'), fromNode('normalize', 'node_id'),
          fromNode('normalize', 'error_code'), fromNode('normalize', 'error_message'),
          fromNode('normalize', 'severity'), fromNode('normalize', 'alert_id'),
          fromNode('normalize', 'run_id'), fromNode('normalize', 'details'),
          fromVar('errors.windowMinutes'),
        ],
      },
      position: { x: 400, y: 0 },
    },
    {
      id: 'assess', type: 'transform', label: 'Severity + burst',
      note: 'A silent database does not stop us alerting: it stops us counting, so we alert louder.',
      params: { fn: 'assessError', inputs: { event: fromNode('normalize', ''), db: fromNode('log', 'rows.0') } },
      position: { x: 620, y: 0 },
    },
    {
      id: 'route', type: 'switch', label: 'Route de notification',
      params: {
        cases: [
          { port: 'silencieux', when: { left: fromInput('route'), op: 'in', right: { kind: 'const', value: ['low', 'suppressed'] } } },
          { port: 'systemique', when: { left: fromInput('route'), op: 'eq', right: { kind: 'const', value: 'systemic' } } },
          { port: 'moyen', when: { left: fromInput('route'), op: 'eq', right: { kind: 'const', value: 'medium' } } },
        ],
        // Repli OBLIGATOIRE : une route inconnue notifie au canal critique
        // plutôt que de disparaître.
        fallbackPort: 'critique',
      },
      position: { x: 840, y: 0 },
    },
    {
      id: 'notify-warning', type: 'notify', label: 'Warnings channel',
      params: { channel: fromVar('slack.warningsChannel'), text: fromNode('assess', 'event.error_message') },
      position: { x: 1060, y: 120 },
    },
    {
      id: 'notify-critical', type: 'notify', label: 'Critical channel',
      params: { channel: fromVar('slack.criticalChannel'), text: fromNode('assess', 'event.error_message') },
      position: { x: 1060, y: -120 },
    },
    {
      id: 'outcome', type: 'transform', label: 'Conclusion (never throws)',
      note: 'NEVER calls 06: an error in the error handler does not call it again. The console is the last place the record survives.',
      params: { fn: 'notificationOutcome', inputs: { assessment: fromNode('assess', ''), slack: fromInput('') } },
      position: { x: 1300, y: 0 },
    },
  ],
  edges: [
    link('in', 'normalize'),
    link('normalize', 'log'),
    // La branche d'erreur ET la branche normale mènent à l'évaluation : ne pas
    // pouvoir journaliser n'est jamais une raison de ne pas alerter.
    link('log', 'assess'),
    link('log', 'assess', 'error'),
    link('assess', 'route'),
    link('route', 'outcome', 'silencieux'),
    link('route', 'notify-critical', 'systemique'),
    link('route', 'notify-warning', 'moyen'),
    link('route', 'notify-critical', 'critique'),
    link('notify-warning', 'outcome'),
    link('notify-warning', 'outcome', 'error'),
    link('notify-critical', 'outcome'),
    link('notify-critical', 'outcome', 'error'),
  ],
};

export const ROUTING_WORKFLOWS = [ROUTING, AUDIT, ERRORS];
