/**
 * 04-Action-Routing — shadow mode, approbation humaine, exécution.
 *
 * ============================================================================
 * LE DÉFAUT LE PLUS SÉRIEUX CORRIGÉ PAR LE PORTAGE
 *
 * Les compteurs de shadow mode vivaient dans `$getWorkflowStaticData('global')`
 * — de la MÉMOIRE DE PROCESSUS n8n. Ils repartaient donc de zéro à chaque
 * redémarrage du conteneur.
 *
 * Or ces compteurs décident d'une chose précise : la sortie du shadow mode à
 * 50 alertes observées. Un compteur remis à zéro sans que personne ne le sache
 * ne repousse pas la décision — il la rend ARBITRAIRE. « 50 alertes » pouvait
 * signifier 50 depuis le dernier redémarrage, c'est-à-dire n'importe quoi.
 *
 * Ici le décompte vient de `soc_audit_log`, qui est append-only et à chaînage
 * de hachage. Il survit à tout, et il est vérifiable.
 *
 * ============================================================================
 * TROIS GARANTIES QUE CE FICHIER PORTE
 *
 *  1. EN SHADOW MODE, ON NE FAIT RIEN. Aucune action, aucune notification
 *     bruyante. On compte, et on écrit ce qu'on AURAIT fait.
 *
 *  2. LE CATALOGUE EST FERMÉ, ET REVÉRIFIÉ APRÈS L'APPROBATION. Une action
 *     hors catalogue est rabattue sur `ticket`, même approuvée. C'est de la
 *     défense en profondeur : le garde-fou de 03 aurait déjà dû l'écarter.
 *
 *  3. LE SILENCE N'EST JAMAIS UN ACCORD. Trois issues distinctes — approuvé,
 *     rejeté, expiré — et l'expiration n'exécute rien.
 * ============================================================================
 */

import {
  ACTIONS, SEVERITIES, clip, isolationTarget,
  type Action, type EnrichedAlert, type FinalDecision, type Severity,
} from './domain.ts';

/** Ce que 04 reçoit de 03. */
export interface DecidedAlert extends EnrichedAlert {
  decision: FinalDecision;
  shadow_mode: boolean;
}

export interface RoutingGuard {
  payload_ok: boolean;
  missing_fields: string[];
  alert: DecidedAlert | null;
}

/** Garde d'entrée. Ne lève jamais : elle pose `payload_ok`. */
export function guardRoutingPayload(input: unknown): RoutingGuard {
  const b = (input ?? {}) as Record<string, unknown>;
  const d = (b.decision ?? {}) as Partial<FinalDecision>;
  const missing: string[] = [];

  // N1 — identity only. `source_ip` is an observable and may be absent.
  for (const f of ['alert_id', 'rule_name', 'severity']) {
    const v = b[f];
    if (v === undefined || v === null || String(v).trim() === '') missing.push(f);
  }
  // `shadow_mode` DOIT être un booléen : une chaîne « false » se lit comme
  // vraie en JavaScript, et déciderait d'exécuter pour de bon.
  if (typeof b.shadow_mode !== 'boolean') missing.push('shadow_mode');
  if (!['false_positive', 'true_positive', 'needs_human'].includes(d.verdict as string)) {
    missing.push('decision.verdict');
  }
  if (typeof d.confidence !== 'number') missing.push('decision.confidence');
  if (!ACTIONS.includes(d.recommended_action as Action)) missing.push('decision.recommended_action');

  const ok = missing.length === 0;
  return { payload_ok: ok, missing_fields: missing, alert: ok ? (b as unknown as DecidedAlert) : null };
}

// --- Shadow mode ----------------------------------------------------------------

export interface ShadowBaseline {
  count: number;
  by_verdict: Record<string, number>;
  by_action: Record<string, number>;
  fallbacks: number;
  degraded: number;
  threshold: number;
  ready_to_exit_shadow: boolean;
}

/**
 * Reconstruit le décompte depuis l'audit, PAS depuis la mémoire du processus.
 *
 * Voir l'en-tête : c'est la correction la plus sérieuse du portage. Les lignes
 * viennent d'un `GROUP BY` sur `soc_audit_log` ; cette fonction ne fait que
 * les mettre en forme, ce qui la rend testable sans base.
 */
export function shadowBaseline(rows: unknown, threshold: number): ShadowBaseline {
  const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  const by_verdict: Record<string, number> = {};
  const by_action: Record<string, number> = {};
  let count = 0;
  let fallbacks = 0;
  let degraded = 0;

  for (const row of list) {
    const n = Number(row.n ?? 0);
    count += n;
    if (typeof row.verdict === 'string') by_verdict[row.verdict] = (by_verdict[row.verdict] ?? 0) + n;
    if (typeof row.recommended_action === 'string') {
      by_action[row.recommended_action] = (by_action[row.recommended_action] ?? 0) + n;
    }
    if (row.is_fallback === true) fallbacks += n;
    if (row.degraded === true) degraded += n;
  }

  return {
    count, by_verdict, by_action, fallbacks, degraded, threshold,
    ready_to_exit_shadow: count >= threshold,
  };
}

export interface RoutingOutcome {
  routing_outcome: string;
  executed: boolean;
  action_taken: string;
  action_details: Record<string, unknown> | null;
  would_have_done?: string | null;
  baseline?: ShadowBaseline | null;
  approval: ApprovalRecord | null;
}

/** En shadow mode : on ne fait RIEN, on compte. */
export function shadowOutcome(alert: DecidedAlert, baseline: ShadowBaseline): RoutingOutcome {
  return {
    routing_outcome: 'shadow_logged',
    executed: false,
    action_taken: 'none',
    action_details: {
      reason: 'shadow_mode on: no real action, no noisy notification.',
    },
    would_have_done: alert.decision.recommended_action,
    baseline,
    approval: null,
  };
}

// --- Demande d'approbation --------------------------------------------------------

export interface ActionSpec {
  intent: string;
  blast_radius: string;
  rollback_plan: string;
}

/**
 * Le catalogue, FERMÉ. Uniquement des actions réversibles.
 *
 * Chaque entrée dit trois choses, et les trois sont obligatoires : ce que le
 * système propose de faire, ce que ça casse si c'est exécuté, et comment
 * annuler. Une action dont on ne sait pas écrire le plan d'annulation n'a rien
 * à faire ici.
 */
export function actionCatalog(
  alert: DecidedAlert,
  vars: { ttlMinutes: number; isolationEndpoint: string },
): Record<Action, ActionSpec> {
  const ttl = vars.ttlMinutes;
  // The same target the last barrier checked for. It cannot be `null` here —
  // `finalizeDecision` downgrades the action to `escalate` when there is no
  // host to name — but the catalogue says so out loud rather than trusting an
  // invariant it does not enforce itself.
  const target = isolationTarget(alert) ?? '(host unknown)';
  return {
    isolate_host_temporary: {
      intent: `Temporarily isolate ${target} from the network for ${ttl} minutes (network quarantine; the machine stays powered on and reachable from the console).`,
      blast_radius: `${target} loses all network connectivity for ${ttl} min: user sessions cut, hosted services unreachable, backups and monitoring failing on that host. No other host affected. No data touched.`,
      rollback_plan: `Automatic revert when the ${ttl} min TTL expires, with no intervention. Immediate manual revert: POST ${vars.isolationEndpoint}/revert with alert_id=${alert.alert_id} (effective in under 30 s).`,
    },
    ticket: {
      intent: `Open an investigation ticket assigned to the SOC team for alert ${alert.alert_id}.`,
      blast_radius: 'No technical impact. Creates an entry in the SOC work queue.',
      rollback_plan: 'Close the ticket. No side effects.',
    },
    escalate: {
      intent: `Escalate alert ${alert.alert_id} to a senior analyst with the full context.`,
      blast_radius: 'No technical impact. Costs analyst time.',
      rollback_plan: 'Close the escalation. No side effects.',
    },
    auto_close: {
      intent: `Close alert ${alert.alert_id} as a false positive.`,
      blast_radius: 'The alert leaves the work queue. If the verdict is wrong, real activity goes unnoticed.',
      rollback_plan: 'Reopen the alert from the audit trail: 05-Audit-Log keeps the full payload.',
    },
  };
}

/**
 * Does an alert of this severity reach Slack?
 *
 * ============================================================================
 * A NOTIFICATION THRESHOLD IS A SAFETY SETTING HERE, NOT A PREFERENCE
 *
 * Severity-based routing is the standard answer to alert fatigue, and this is
 * that setting: below the threshold, nothing is posted.
 *
 * But on THIS product the message being suppressed is often an approval
 * request — a question. Suppressing a question and then waiting thirty minutes
 * for its answer would be the worst of both: no human is asked, and the alert
 * sits blocked until it times out.
 *
 * So the rule is: a suppressed request is not posted AND not waited on. The
 * run escalates immediately, the case says why, and no action is executed. The
 * alert is still in the console queue — Slack is a notification channel, never
 * the system of record. Silence remains a refusal, exactly as it is when an
 * approval times out.
 *
 * `off` sends nothing at all. An unreadable or missing value falls back to
 * `low`, i.e. notify about everything: a threshold nobody set must not quietly
 * silence a console.
 * ============================================================================
 */
export function reachesNotification(severity: unknown, minSeverity: unknown): boolean {
  const min = String(minSeverity ?? 'low');
  if (min === 'off') return false;
  const floor = SEVERITIES.indexOf(min as Severity);
  // An unknown threshold means notify about everything, never nothing.
  if (floor < 0) return true;
  const at = SEVERITIES.indexOf(String(severity ?? '') as Severity);
  // AN UNRATED ALERT ALWAYS NOTIFIES. Severity did not survive normalization,
  // so treating it as low enough to silence would quietly drop something that
  // might be a critical — the same rule the ingestion lanes apply.
  if (at < 0) return true;
  return at >= floor;
}

/**
 * Why an approval is being asked for. Written down in plain sight.
 *
 * An approver who does not know WHY they are being asked ends up clicking
 * "approve" by reflex — and the human guard becomes decorative.
 */
export function approvalTriggers(decision: FinalDecision): string[] {
  const triggers: string[] = [];
  if (decision.recommended_action === 'isolate_host_temporary') {
    triggers.push('a containment action is proposed (isolate_host_temporary)');
  }
  if (typeof decision.confidence === 'number' && decision.confidence < 0.85) {
    triggers.push(`confidence ${decision.confidence} < 0.85`);
  }
  if (decision.verdict === 'needs_human') triggers.push('verdict needs_human');
  if (decision.is_fallback) {
    triggers.push(`fallback decision: the model did not answer (${decision.decision_source})`);
  }
  return triggers.length > 0 ? triggers : ['default routing rule'];
}

export interface ApprovalRequest {
  alert_id: string;
  /**
   * Whether this request is posted to Slack at all.
   *
   * `false` does NOT mean the alert is ignored: it means nobody is asked, so
   * the run escalates instead of waiting for an answer that cannot come.
   */
  notify: boolean;
  /** Why it was not posted. `null` when it was. */
  not_notified_reason: string | null;
  proposed_action: Action;
  approval_triggers: string[];
  intent: string;
  blast_radius: string;
  rollback_plan: string;
  data_lineage: string[];
  ttl_minutes: number;
  resume_url: string;
  requested_at: string;
  slack: { channel: string; text: string; blocks: unknown[] };
  /**
   * The same request in Discord's vocabulary.
   *
   * Built from the structured facts, NOT converted from the Slack blocks: the
   * two are different languages, and a mapper between them would be a lossy
   * translator nobody could read or check.
   */
  discord: { content: string; embeds: unknown[] };
}

export function buildApprovalRequest(
  alert: DecidedAlert,
  vars: {
    ttlMinutes: number;
    isolationEndpoint: string;
    approvalChannel: string;
    escalationChannel: string;
    timeoutMinutes: number;
    /** The lowest alert severity that reaches Slack. `off` sends nothing. */
    minSeverity?: unknown;
    /** `bot` or `webhook`. A webhook is locked to the channel it was made for. */
    transport?: unknown;
  },
  resumeUrl: string,
  now: () => Date = () => new Date(),
): ApprovalRequest {
  const d = alert.decision;
  const catalog = actionCatalog(alert, vars);
  // An unknown action falls back to `ticket`: we never build an approval
  // request for something we cannot describe.
  const proposed: Action = catalog[d.recommended_action] ? d.recommended_action : 'ticket';
  const spec = catalog[proposed];
  const triggers = approvalTriggers(d);

  const lineage = d.data_lineage.length > 0
    ? d.data_lineage.map((p) => `• \`${p}\``)
    : ['\u2022 _the model used no enrichment field_'];
  const sources = (['shodan', 'abuseipdb', 'vt'] as const).map(
    (s) => `\u2022 *${s}*: \`${alert.enrichment[s]?.status ?? 'absent'}\``,
  );

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: ':lock: Approval required \u2014 SOC action', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: `*${alert.alert_id}* \u2022 \`${alert.rule_name}\` \u2022 severity \`${alert.severity}\` \u2022 ${alert.source_ip} \u2192 ${alert.dest_ip} \u2022 _watch-only mode is off: this action will really be executed_` }] },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*AI verdict*\n\`${d.verdict}\`` },
      { type: 'mrkdwn', text: `*Confidence*\n\`${d.confidence}\`${d.raw_confidence !== d.confidence ? ` _(raw ${d.raw_confidence})_` : ''}` },
      { type: 'mrkdwn', text: `*Proposed action*\n\`${proposed}\`` },
      { type: 'mrkdwn', text: `*Source*\n\`${d.decision_source}\`` },
    ] },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*:dart: INTENT — what the system proposes to do*\n${spec.intent}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*:mag: DATA LINEAGE — what the decision rests on*\n${lineage.join('\n')}\n\n_Source status:_\n${sources.join('\n')}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*:boom: BLAST RADIUS — impact if executed*\n${spec.blast_radius}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*:leftwards_arrow_with_hook: ROLLBACK PLAN \u2014 how to undo*\n${spec.rollback_plan}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*:speech_balloon: Model reasoning*\n>${String(d.reasoning ?? '—').replace(/\n/g, ' ')}` } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: `:warning: *Approval requested because:* ${triggers.join('; ')}${d.guardrails_applied.length > 0 ? `\n:shield: *Guardrails applied:* ${d.guardrails_applied.join('; ')}` : ''}` }] },
    { type: 'actions', block_id: 'soc_approval_actions', elements: [
      { type: 'button', action_id: 'soc_open_form', style: 'primary',
        text: { type: 'plain_text', text: 'Open the approval form', emoji: true },
        url: resumeUrl },
    ] },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: `:hourglass_flowing_sand: With no answer within ${vars.timeoutMinutes} minutes, no action will be executed and the alert will be escalated to ${vars.escalationChannel}.` }] },
  ];

  // Decided HERE and carried on the request, so the graph can branch on it and
  // the case can say why nothing was posted. Computing it inside the notify
  // node would hide the decision inside an I/O step nobody reads.
  const notify = reachesNotification(alert.severity, vars.minSeverity);

  /*
    THE DISCORD FORM, BUILT FROM THE SAME FACTS — not converted from the blocks.

    Slack Block Kit and Discord embeds are different vocabularies, and a
    converter between them would be a lossy translator nobody could read or
    check. Both are rendered from the structured request, so the two say the
    same thing because they were written from the same source rather than
    because a mapper got it right.

    ONE embed, carrying the four things an approver has to weigh: what it would
    do, what it would break, how to undo it, and why they are being asked.
    Discord caps a whole embed at 6000 characters; these fields are short by
    construction, and `clip` stops a pathological reasoning string from costing
    the entire message.
  */
  const severityColour: Record<string, number> = {
    // Decimal, as Discord wants it.
    critical: 0xd63b3b, high: 0xd68a1e, medium: 0xd6c01e, low: 0x8a8a8a,
  };
  const discordEmbed = {
    title: `Approval required \u2014 ${proposed}`,
    description: clip(spec.intent, 900),
    color: severityColour[String(alert.severity)] ?? severityColour.low,
    fields: [
      { name: 'Alert', value: `\`${alert.alert_id}\` \u2014 ${clip(String(alert.rule_name ?? ''), 200)}`, inline: false },
      { name: 'AI verdict', value: `\`${d.verdict}\` (confidence ${d.confidence})`, inline: true },
      { name: 'Severity', value: `\`${alert.severity}\``, inline: true },
      { name: 'Blast radius \u2014 if executed', value: clip(spec.blast_radius, 900), inline: false },
      { name: 'Rollback plan', value: clip(spec.rollback_plan, 900), inline: false },
      { name: 'Why you are being asked', value: clip(triggers.join('; '), 900), inline: false },
      { name: 'Approve or refuse', value: resumeUrl, inline: false },
    ],
    footer: {
      text: `No answer within ${vars.timeoutMinutes} min: nothing is executed and the alert is escalated.`,
    },
  };

  return {
    alert_id: alert.alert_id,
    notify,
    not_notified_reason: notify
      ? null
      : String(vars.minSeverity ?? 'low') === 'off'
        ? 'Chat notifications are switched off (notify.minSeverity = off).'
        : `severity "${alert.severity}" is below the notification threshold `
          + `(notify.minSeverity = ${String(vars.minSeverity)}).`,
    proposed_action: proposed,
    approval_triggers: triggers,
    intent: spec.intent,
    blast_radius: spec.blast_radius,
    rollback_plan: spec.rollback_plan,
    data_lineage: d.data_lineage,
    ttl_minutes: vars.ttlMinutes,
    resume_url: resumeUrl,
    requested_at: now().toISOString(),
    discord: {
      content: `Approval required \u2014 ${alert.alert_id} \u2014 ${proposed}`,
      embeds: [discordEmbed],
    },
    slack: {
      channel: vars.approvalChannel,
      // The FALLBACK text, and it is what a phone notification shows: Slack
      // renders `blocks` in the client and `text` everywhere blocks cannot go.
      // It was the one Slack string still in French, because the blocks beside
      // it had been translated and this line reads like a duplicate of them.
      text: `Approval required \u2014 ${alert.alert_id} \u2014 ${proposed}`,
      blocks,
    },
  };
}

// --- Issue de l'approbation --------------------------------------------------------

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout_escalated';

export interface ApprovalRecord {
  requested_action: Action;
  intent: string;
  blast_radius: string;
  rollback_plan: string;
  triggers: string[];
  requested_at: string | null;
  outcome: ApprovalOutcome;
  approver: {
    slack_username: string | null;
    responded_at: string;
    /**
     * `self_declared` : LE JETON PROUVE QU'ON DÉTIENT LE LIEN, PAS QU'ON EST
     * UNTEL. Le dire explicitement vaut mieux que de laisser croire à une
     * authentification. L'audit porte cette mention.
     */
    identity_source: 'self_declared';
    signature_verified: false;
  } | null;
  human_reasoning: string | null;
  timeout_minutes: number;
}

/**
 * Interprète ce qu'un humain a répondu — ou n'a pas répondu.
 *
 * `payload === null` signifie que l'attente a expiré : c'est le moteur qui le
 * pose, en sortant par le port `timeout`. Toute réponse qui n'est pas
 * exactement « approve » compte comme un refus : on n'approuve jamais par
 * défaut d'interprétation.
 */
export function interpretApproval(
  request: ApprovalRequest,
  payload: unknown,
  timeoutMinutes: number,
  now: () => Date = () => new Date(),
): { outcome: ApprovalOutcome; approval: ApprovalRecord; proposed_action: Action } {
  const p = (payload ?? null) as { decision?: string; approver?: string; reason?: string } | null;

  let outcome: ApprovalOutcome;
  let approver: ApprovalRecord['approver'] = null;
  let reasoning: string | null = null;

  if (p === null || (p.decision !== 'approve' && p.decision !== 'reject')) {
    outcome = 'timeout_escalated';
  } else {
    outcome = p.decision === 'approve' ? 'approved' : 'rejected';
    approver = {
      slack_username: (p.approver ?? '').trim() || null,
      responded_at: now().toISOString(),
      identity_source: 'self_declared',
      signature_verified: false,
    };
    reasoning = (p.reason ?? '').trim() || null;
  }

  return {
    outcome,
    proposed_action: request.proposed_action,
    approval: {
      requested_action: request.proposed_action,
      intent: request.intent,
      blast_radius: request.blast_radius,
      rollback_plan: request.rollback_plan,
      triggers: request.approval_triggers,
      requested_at: request.requested_at,
      outcome,
      approver,
      human_reasoning: reasoning,
      timeout_minutes: timeoutMinutes,
    },
  };
}

/**
 * Défense en profondeur : revérifie le catalogue APRÈS l'approbation.
 *
 * Le garde-fou de 03 aurait déjà dû écarter une action hors catalogue. Cette
 * fonction existe parce que « aurait dû » n'est pas une garantie : entre 03 et
 * ici, il y a un appel réseau, une attente de trente minutes et une reprise
 * possible après redémarrage.
 */
export function enforceCatalog<T extends { proposed_action: string }>(
  input: T,
): T & { action_blocked: boolean; proposed_action: Action; block_reason?: string } {
  if (ACTIONS.includes(input.proposed_action as Action)) {
    return { ...input, action_blocked: false, proposed_action: input.proposed_action as Action };
  }
  return {
    ...input,
    action_blocked: true,
    proposed_action: 'ticket',
    block_reason: `Action "${clip(input.proposed_action, 60)}" is outside the reversible catalogue: downgraded to ticket.`,
  };
}

/** Enregistrement d'audit, identique quelle que soit la branche empruntée. */
export function buildAuditRecord(
  alert: DecidedAlert,
  outcome: Partial<RoutingOutcome> & { outcome?: string },
  now: () => Date = () => new Date(),
): Record<string, unknown> {
  return {
    ...alert,
    source_workflow: '04-Action-Routing',
    routed_at: now().toISOString(),
    routing_outcome: outcome.routing_outcome ?? outcome.outcome ?? 'unknown',
    executed: outcome.executed === true,
    action_taken: outcome.action_taken ?? 'none',
    action_details: outcome.action_details ?? null,
    approval: outcome.approval ?? null,
    baseline: outcome.baseline ?? null,
    would_have_done: outcome.would_have_done ?? null,
  };
}
