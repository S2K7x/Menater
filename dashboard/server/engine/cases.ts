/**
 * The console's view, built from the engine's own runs.
 *
 * ============================================================================
 * WHAT THIS FILE REPLACES, AND WHY IT HAD TO EXIST
 *
 * The triage queue, the metrics and the Tracking tab used to be built by
 * walking an n8n instance's execution list. That was the last thing tying this
 * product to n8n, and it was the strangest one: the built-in engine wrote every
 * run to `soc_run` and `soc_run_step`, and NOTHING EVER READ THEM BACK. A
 * console running on its own engine showed an empty queue unless an n8n
 * happened to be attached.
 *
 * So removing n8n is not a deletion. It is this file: the console now reads the
 * runs it produced itself.
 *
 * ============================================================================
 * A CASE IS NOT A RUN
 *
 * The engine records one run per workflow started. An analyst thinks in ALERTS:
 * one thing to decide, which crosses six workflows. The two never coincide — a
 * single alert routinely produces five runs, and an error storm produces many
 * more. Runs are therefore stitched by `alert_id` into a CASE, which is the
 * unit of work every SOAR with real case management uses.
 *
 * WHAT THE STITCHING HIDES IS EXACTLY WHAT THE TRACKING TAB SHOWS, and that is
 * why both views are built here, in one pass, from one read: a broken chain and
 * a run attached to no alert disappear in the reduction, and rebuilding them
 * from a second query would let the two views disagree about the same window.
 *
 * ============================================================================
 * IT READS NODE IDS, AND THAT IS A CONTRACT
 *
 * `finalize`, `assemble`, `request`, `expose` — the console reads the output of
 * named nodes. Renaming one in `workflows/` makes this blind, in silence. That
 * coupling existed against n8n too (where renaming a node in the editor broke
 * the console); the difference is that both halves now live in this repository
 * and a test can hold them together. `NODE_CONTRACT` below is that test's list.
 * ============================================================================
 */

import {
  CHAIN_STEPS, UNEXPECTED_ORPHANS,
  type AlertCase, type Approval, type CaseState, type ChainStep, type Decision,
  type Enrichment, type EnrichmentMeta, type ErrorEvent, type Severity,
  type StageEvent, type TraceChain, type TraceExecution, type TraceReport, type TraceStep,
} from '../../src/lib/types.ts';
import { messages, type Locale } from '../i18n.ts';
import { tagAttack } from './attack.ts';
import type { RunRecord, StepRecord } from './types.ts';

/** Workflow id → the label the interface shows. */
export const WORKFLOW_LABELS: Record<string, string> = {
  '01-ingestion': '01-Ingestion',
  '02-enrichment': '02-Enrichment',
  '03-ai-decision': '03-AI-Decision',
  '04-action-routing': '04-Action-Routing',
  '05-audit-log': '05-Audit-Log',
  '06-error-handler': '06-Error-Handler',
};

/**
 * The node outputs this file reads, per workflow.
 *
 * Written down rather than scattered through the code because it IS the
 * coupling: `cases.test.ts` asserts every id here exists in the workflow
 * definitions, so renaming a node fails a test instead of silently emptying
 * the queue.
 */
export const NODE_CONTRACT: Record<string, string[]> = {
  '01-ingestion': ['validate', 'read-dedup', 'tuning', 'to-enrichment'],
  '02-enrichment': ['assemble', 'to-decision'],
  '03-ai-decision': ['finalize', 'to-routing'],
  '04-action-routing': [
    'shadow-count', 'request', 'notify?', 'below-threshold', 'interpret', 'timeout',
    'rejected', 'execute', 'execute-failed', 'audit-record', 'to-audit',
  ],
  '05-audit-log': ['normalize', 'append', 'expose', 'unusable', 'write-failed'],
  '06-error-handler': ['normalize', 'assess', 'outcome'],
};

/**
 * The pipeline's wiring order, used to break a timestamp tie.
 *
 * `06-error-handler` is last because it is never IN the sequence: it is called
 * from the error branch of any parent, so within one instant it belongs after
 * whatever raised it.
 */
const WORKFLOW_ORDER = [
  '01-ingestion', '02-enrichment', '03-ai-decision',
  '04-action-routing', '05-audit-log', '06-error-handler',
];

const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;

/** The output of a node, or `null` if it never produced one. */
function outputOf(steps: StepRecord[], nodeId: string): Record<string, unknown> | null {
  // LAST attempt wins: a node retried after a transient failure is described by
  // what it finally produced, not by its first stumble.
  const matching = steps.filter((s) => s.nodeId === nodeId && s.output !== null && s.output !== undefined);
  if (matching.length === 0) return null;
  const last = matching[matching.length - 1];
  return typeof last.output === 'object' ? rec(last.output) : null;
}

const ran = (steps: StepRecord[], nodeId: string): boolean => steps.some((s) => s.nodeId === nodeId);

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() !== '' ? v : fallback;

/**
 * A number that may have arrived as a string.
 *
 * ============================================================================
 * `pg` RETURNS `bigint` AS A STRING, AND THAT COST A FALSE ALARM
 *
 * `soc_audit_log.id` is a `bigserial`, so the audit row's id reaches this file
 * as `"2651"`. Read with `typeof v === 'number'` it became `null`, every case
 * was recorded as having no committed audit row, and the Health tab announced
 * **"38 cases with no committed audit row: those decisions are not traceable"**
 * over a database whose hash chain was intact.
 *
 * That is the worst direction for this defect to point. The console exists to
 * make silent failures visible, and its whole risk grammar rests on red being
 * trustworthy; a red raised over healthy data teaches an operator to discount
 * the one screen that must never be discounted. Found by running it against
 * the real database — no hand-written fixture would have made the id a string.
 *
 * Same family as the documented trap where a `postgres` node answers
 * `{ rows: [...] }`: the shape was right and the TYPE was not.
 * ============================================================================
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const asSeverity = (v: unknown): Severity =>
  SEVERITIES.includes(v as Severity) ? (v as Severity) : 'medium';

/**
 * A run's status, in the vocabulary the interface already speaks.
 *
 * `waiting` is NOT an error and not a success: it is a human being asked a
 * question, and the whole product hinges on the difference.
 */
function stageStatus(run: RunRecord): StageEvent['status'] {
  if (run.status === 'done') return 'success';
  if (run.status === 'waiting') return 'waiting';
  if (run.status === 'running') return 'running';
  return 'error';
}

const durationOf = (run: RunRecord): number | null =>
  run.endedAt ? Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)) : null;

/**
 * One readable sentence about what a run did.
 *
 * Written HERE and not in the browser because it mixes prose with values taken
 * out of the run: recomposing it client-side would mean shipping a structure
 * and a template instead of a sentence, and the two would drift.
 */
function noteFor(run: RunRecord, steps: StepRecord[], sg: ReturnType<typeof messages>['stages']): string {
  const wf = run.workflowId;

  if (wf === '01-ingestion') {
    // `validation_ok`, NOT `valid`. Read under the wrong name it was always
    // `undefined`, so a rejected alert — whose stage note is the ONLY place the
    // reason appears on the case card — was described as "received and
    // validated". The transform names the field in its own header; this read it
    // from memory. Found by injecting an invalid alert and reading the card.
    const validation = outputOf(steps, 'validate');
    if (validation && validation.validation_ok === false) {
      const errors = Array.isArray(validation.errors) ? validation.errors.join(', ') : '';
      return sg.rejected(errors || sg.unknown);
    }
    const dedup = outputOf(steps, 'read-dedup');
    if (dedup && dedup.is_duplicate === true) return sg.outcomes.duplicate ?? 'duplicate';
    const down = outputOf(steps, 'respond-500');
    if (down) return sg.dedupUnavailable(str(rec(down.body).error, sg.unknown));
    return sg.received;
  }

  if (wf === '02-enrichment') {
    const assembled = outputOf(steps, 'assemble');
    const meta = rec(assembled?.enrichment_meta);
    const ok = Array.isArray(meta.sources_ok) ? (meta.sources_ok as string[]) : [];
    return sg.sources(ok.length ? ok.join(', ') : sg.noneLabel, meta.degraded === true);
  }

  if (wf === '03-ai-decision') {
    const final = outputOf(steps, 'finalize');
    const decision = rec(final?.decision);
    const verdict = str(decision.verdict, sg.unknown);
    const confidence = typeof decision.confidence === 'number' ? decision.confidence : null;
    return sg.decision(
      sg.verdicts[verdict] ?? verdict,
      confidence,
      decision.is_fallback === true,
    );
  }

  if (wf === '04-action-routing') {
    if (run.status === 'waiting') return sg.awaitingApproval;
    const audit = outputOf(steps, 'audit-record');
    const outcome = str(rec(audit).routing_outcome);
    if (outcome) return sg.outcomes[outcome] ?? outcome;
    const interpreted = outputOf(steps, 'interpret');
    const who = str(rec(rec(interpreted).approver).slack_username);
    if (who) return sg.approved(who);
    return sg.unknown;
  }

  if (wf === '05-audit-log') {
    const exposed = outputOf(steps, 'expose') ?? outputOf(steps, 'append');
    const row = num(rec(rec(exposed).audit).row_id ?? rec(exposed).row_id);
    if (row !== null) return sg.auditSealed(row);
    const failed = outputOf(steps, 'write-failed') ?? outputOf(steps, 'unusable');
    if (failed) return sg.auditLost(str(failed.error ?? failed.reason, sg.unknown));
    return sg.unknown;
  }

  if (wf === '06-error-handler') {
    const normalized = outputOf(steps, 'normalize');
    return sg.errorHandled(str(rec(normalized).error_code, sg.unknown));
  }

  return sg.unknown;
}

/** A fresh, empty case. Everything absent stays absent — nothing is invented. */
function blankCase(alertId: string, receivedAt: string): AlertCase {
  return {
    alert_id: alertId,
    received_at: receivedAt,
    state: 'ingested',
    severity: 'medium',
    rule_name: '',
    source_ip: '—',
    dest_ip: '—',
    host: null,
    raw_log: '',
    extensions: null,
    shadow_mode: false,
    executed: false,
    routing_outcome: null,
    action_taken: null,
    enrichment: null,
    enrichment_meta: null,
    decision: null,
    approval: null,
    audit: null,
    stages: [],
    errors: [],
    attack: [],
    dwell_ms: null,
  };
}

/**
 * The identity fields, taken from the payload that entered the pipeline.
 *
 * `—` for the two addresses is a DISPLAY value the console has always used for
 * "not recorded"; `host` stays a value or `null`, because it decides whether an
 * isolation has a target at all and a display dash must never travel as data.
 */
function applyAlertFields(c: AlertCase, alert: Record<string, unknown>): void {
  c.severity = asSeverity(alert.severity);
  c.rule_name = str(alert.rule_name, c.rule_name);
  c.source_ip = str(alert.source_ip, c.source_ip === '' ? '—' : c.source_ip);
  c.dest_ip = str(alert.dest_ip, c.dest_ip === '' ? '—' : c.dest_ip);
  const host = str(alert.host);
  if (host) c.host = host;
  c.raw_log = str(alert.raw_log, c.raw_log);
  // NOTHING IS DISCARDED. Whatever the mapping had no column for rides in
  // `extensions`, and it has to reach the card: it is the raw material of an
  // audited decision, and the last place losing something is acceptable.
  const ext = alert.extensions;
  if (ext && typeof ext === 'object' && Object.keys(ext).length > 0) {
    c.extensions = { ...c.extensions, ...(ext as Record<string, unknown>) };
  }
}

/**
 * Where the case stands, from what actually happened.
 *
 * ORDER MATTERS AND IT IS NOT ALPHABETICAL. `awaiting_approval` outranks
 * everything below it because it is the only state that blocks a human, and
 * `failed` outranks the rest because a technical failure must not be dressed up
 * as a completed triage.
 */
function deriveState(c: AlertCase, waiting: boolean, failed: boolean): CaseState {
  if (waiting) return 'awaiting_approval';
  if (failed) return 'failed';
  if (c.executed) return 'actioned';
  if (c.routing_outcome) return 'closed';
  if (c.decision) return 'decided';
  if (c.enrichment) return 'enriched';
  return 'ingested';
}

export interface CaseBuild {
  cases: AlertCase[];
  trace: TraceReport;
}

const STALL_AFTER_MS = 5 * 60 * 1000;
/** An approval legitimately waits. Its 30 minutes are never counted as a stall. */
const APPROVAL_GRACE_MS = 30 * 60 * 1000;

/**
 * Build both views — the stitched cases and the unreduced trace — in one pass.
 */
export function buildCases(
  runs: RunRecord[],
  stepsByRun: Map<string, StepRecord[]>,
  opts: { limit: number; locale: Locale; now?: () => Date },
): CaseBuild {
  const msg = messages(opts.locale);
  const sg = msg.stages;
  const now = (opts.now ?? (() => new Date()))();

  const cases = new Map<string, AlertCase>();
  const chains = new Map<string, TraceStep[]>();
  const executions: TraceExecution[] = [];
  const orphans: TraceExecution[] = [];
  const payloads = new Map<string, TraceChain['payload']>();

  // Oldest first: a case is a story, and the stages have to read in the order
  // they happened rather than in the order the query returned them.
  //
  // THE TIE-BREAK IS THE PIPELINE'S OWN ORDER, and it is not decoration. A
  // sub-workflow is started by its parent, so under load the two runs land in
  // the SAME MILLISECOND — and sorted on the timestamp alone the case card
  // showed "03-AI-Decision → 01-Ingestion → …", which reads as a chain that ran
  // backwards. Run ids are UUIDs, so they order nothing. Within one instant the
  // canonical order is the one the pipeline is wired in.
  const ordered = [...runs].sort(
    (a, b) => (Date.parse(a.startedAt) - Date.parse(b.startedAt))
      || (WORKFLOW_ORDER.indexOf(a.workflowId) - WORKFLOW_ORDER.indexOf(b.workflowId)),
  );

  for (const run of ordered) {
    const steps = stepsByRun.get(run.id) ?? [];
    const label = WORKFLOW_LABELS[run.workflowId] ?? null;
    const alertId = run.alertId;

    const exec: TraceExecution = {
      execution_id: run.id,
      workflow_id: run.workflowId,
      workflow: label,
      status: run.status,
      started_at: run.startedAt,
      duration_ms: durationOf(run),
      alert_id: alertId,
      orphan_reason: null,
      note: run.error,
      handoff: 'n/a',
      // No editor to link to any more. The run is inspectable in this console,
      // which is the point of having stopped depending on another one.
    };

    // --- The handoff contract: a step that ran and passed NOTHING -----------
    const handoffNode = NODE_CONTRACT[run.workflowId]?.find((n) => n.startsWith('to-'));
    if (handoffNode) {
      // `empty` and `absent` are DIFFERENT failures, and conflating them is the
      // defect the Tracking tab exists to expose: a handoff that ran and passed
      // nothing reports success, a handoff that never ran does not. A run still
      // going has not reached the question yet — `n/a`, not a failure.
      const out = outputOf(steps, handoffNode);
      exec.handoff = !ran(steps, handoffNode)
        ? (run.status === 'running' || run.status === 'waiting' ? 'n/a' : 'absent')
        : (out === null ? 'empty' : 'items');
    }

    if (!alertId) {
      // THE CONNECTIVITY PROBE IS EXPECTED, AND MUST NOT BE COUNTED.
      //
      // The Health tab's probe deliberately posts an invalid payload to prove
      // the entry point and the schema validator work end to end. It has no
      // `alert_id` by design, so it lands here — and counted as an anomaly it
      // makes the Tracking tab raise `attention` after every connectivity
      // test. A permanent alarm stops being read, which costs more than the
      // alarm was ever worth.
      //
      // It is LISTED, never counted: `UNEXPECTED_ORPHANS` is the list the
      // counter uses, and `diagnostic_probe` is deliberately not in it.
      const marker = rec(run.input).diagnostic_probe === true
        || rec(rec(run.input).extensions).diagnostic_probe === true;
      exec.orphan_reason = marker
        ? 'diagnostic_probe'
        : steps.length === 0 ? 'empty_input' : 'no_alert_id';
      orphans.push(exec);
      executions.push(exec);
      continue;
    }

    executions.push(exec);

    let c = cases.get(alertId);
    if (!c) {
      c = blankCase(alertId, run.startedAt);
      cases.set(alertId, c);
    }

    // The original payload, read from the run that received it. A case that
    // never went through 01 keeps `null`: `POST /api/replay` refuses rather
    // than replaying an alert reconstructed from memory.
    if (run.workflowId === '01-ingestion') {
      const alert = rec(run.input);
      applyAlertFields(c, alert);
      c.received_at = run.startedAt;
      payloads.set(alertId, {
        source_ip: str(alert.source_ip, '—'),
        dest_ip: str(alert.dest_ip, '—'),
        rule_name: str(alert.rule_name),
        severity: asSeverity(alert.severity),
        raw_log: str(alert.raw_log),
      });
      const tuning = outputOf(steps, 'tuning');
      if (tuning && tuning.closed_by_rule === true) {
        // `applyTuningRules` reports the ACTION it took, not a routing outcome:
        // there is no `routing_outcome` on that output, so reading one gave a
        // silent fallback on every rule-closed alert. The action is the honest
        // name — `allow` and `suppress` are the two that close.
        c.routing_outcome = str(rec(tuning.tuning).action, 'rule_closed');
      }
    }

    if (run.workflowId === '02-enrichment') {
      const assembled = outputOf(steps, 'assemble');
      if (assembled) {
        applyAlertFields(c, assembled);
        if (assembled.enrichment) c.enrichment = assembled.enrichment as Enrichment;
        if (assembled.enrichment_meta) c.enrichment_meta = assembled.enrichment_meta as EnrichmentMeta;
      }
    }

    if (run.workflowId === '03-ai-decision') {
      const final = outputOf(steps, 'finalize');
      if (final) {
        applyAlertFields(c, final);
        if (final.decision) c.decision = final.decision as Decision;
        c.shadow_mode = final.shadow_mode === true;
      }
    }

    if (run.workflowId === '04-action-routing') {
      const request = outputOf(steps, 'request');
      const interpreted = outputOf(steps, 'interpret');
      const timedOut = outputOf(steps, 'timeout');
      const refused = outputOf(steps, 'rejected');
      const audit = outputOf(steps, 'audit-record');
      const executed = outputOf(steps, 'execute');
      const shadow = outputOf(steps, 'shadow-count');

      if (request) {
        const ap = rec(request.approval ?? request);
        c.approval = {
          requested_action: (ap.requested_action ?? ap.proposed_action) as Approval['requested_action'],
          intent: str(ap.intent),
          blast_radius: str(ap.blast_radius),
          rollback_plan: str(ap.rollback_plan),
          triggers: Array.isArray(ap.triggers) ? (ap.triggers as string[]) : [],
          outcome: 'pending',
          approver: null,
          human_reasoning: null,
          timeout_minutes: typeof ap.timeout_minutes === 'number' ? ap.timeout_minutes : 30,
          requested_at: str(ap.requested_at) || run.startedAt,
        };
      }
      if (c.approval) {
        if (interpreted) {
          const approved = rec(interpreted).approved === true;
          c.approval.outcome = approved ? 'approved' : 'rejected';
          c.approval.approver = (rec(interpreted).approver ?? null) as Approval['approver'];
          c.approval.human_reasoning = str(rec(interpreted).human_reasoning) || null;
        }
        if (refused) c.approval.outcome = 'rejected';
        if (timedOut) c.approval.outcome = 'timeout_escalated';
      }

      // NEVER ASKED MEANS NO APPROVAL, not a pending one.
      //
      // `request` runs before the threshold branch, so its output is there
      // either way — and reading it unconditionally put a `pending` approval on
      // a CLOSED case, which reads as a decision still waiting for somebody. An
      // approval nobody was asked for is invented data on the card; the
      // routing outcome already says what happened.
      if (ran(steps, 'below-threshold')) c.approval = null;

      if (executed) {
        c.executed = true;
        c.action_taken = str(rec(executed).action ?? rec(executed).executed_action) || null;
      }
      // `below-threshold` is read DIRECTLY, not only through the audit record it
      // feeds. The reason an alert was never notified is the one thing the card
      // has to say about it, and it must not be lost if the audit write fails —
      // that would leave a closed case with no explanation at all.
      const suppressed = outputOf(steps, 'below-threshold');
      const outcome = str(rec(audit).routing_outcome)
        || str(rec(shadow).routing_outcome)
        || str(rec(suppressed).routing_outcome);
      if (outcome) c.routing_outcome = outcome;
    }

    if (run.workflowId === '05-audit-log') {
      const exposed = outputOf(steps, 'expose') ?? outputOf(steps, 'append');
      const failed = outputOf(steps, 'write-failed') ?? outputOf(steps, 'unusable');
      const body = rec(rec(exposed).audit ?? exposed);
      const rowId = num(body.row_id);
      c.audit = {
        // The pipeline SAYS whether it committed; that is a fact it holds and
        // we do not have to re-derive. The row id corroborates it — deriving
        // `committed` from the id alone is what turned a string into 38
        // untraceable decisions.
        committed: (body.committed === true || rowId !== null) && !failed,
        row_id: rowId,
        integrity_hash: str(body.integrity_hash) || null,
        prev_hash: str(body.prev_hash) || null,
        failure: failed ? str(rec(failed).error ?? rec(failed).reason, sg.unknown) : null,
      };
    }

    if (run.workflowId === '06-error-handler') {
      const normalized = outputOf(steps, 'normalize');
      const assessed = outputOf(steps, 'assess');
      c.errors.push({
        workflow: str(rec(normalized).workflow, run.workflowId),
        error_code: str(rec(normalized).error_code, 'unknown'),
        message: str(rec(normalized).message ?? run.error, sg.unknown),
        severity: (str(rec(assessed).severity, 'medium')) as ErrorEvent['severity'],
        at: run.startedAt,
        requires_replay: rec(assessed).requires_replay === true,
      });
    }

    // --- The stage line, and the trace step beside it ----------------------
    const status = stageStatus(run);
    const note = noteFor(run, steps, sg);
    const previous = c.stages[c.stages.length - 1];
    // FOLDED, NOT DROPPED. The pipeline amplifies — two alerts once produced
    // twenty-five runs of 06 — and printing all of them drowns the card while
    // hiding them hides the defect. The repeat count is the honest middle.
    if (previous && previous.workflow === (label ?? run.workflowId)
      && previous.note === note && previous.status === status) {
      previous.repeat = (previous.repeat ?? 1) + 1;
    } else {
      c.stages.push({
        workflow: label ?? run.workflowId,
        execution_id: run.id,
        status,
        started_at: run.startedAt,
        duration_ms: durationOf(run),
        note,
      });
    }

    // Only the five pipeline stages belong to a chain. 06 is called from the
    // error branch of any parent and never sits IN the sequence — putting it
    // there would make every handled incident look like a sixth step nobody
    // designed.
    if (CHAIN_STEPS.includes(label as ChainStep)) {
      const chain = chains.get(alertId) ?? [];
      chain.push({
        workflow: label as ChainStep,
        execution_id: run.id,
        status: status === 'success' ? 'success' : status,
        started_at: run.startedAt,
        duration_ms: durationOf(run),
        handoff: exec.handoff,
      });
      chains.set(alertId, chain);
    }
  }

  // --- Second pass: the states, which depend on the whole case -------------
  for (const c of cases.values()) {
    const waiting = c.stages.some((s) => s.status === 'waiting');
    const failed = c.stages.some((s) => s.status === 'error') || c.errors.length > 0;
    c.state = deriveState(c, waiting, failed);
    // INFERRED from the rule name and the log, and labelled as inferred on the
    // card. A technique asserted without saying where it came from is the kind
    // of false rigour this product refuses everywhere else.
    c.attack = tagAttack(c.rule_name, c.raw_log);
    const last = c.stages[c.stages.length - 1];
    c.dwell_ms = last
      ? Math.max(0, Date.parse(last.started_at) + (last.duration_ms ?? 0) - Date.parse(c.received_at))
      : null;
  }

  const list = [...cases.values()];
  const times = ordered.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite);

  const traceChains: TraceChain[] = [...chains.entries()].map(([alertId, steps]) => {
    const c = cases.get(alertId)!;
    const lastAt = steps.reduce(
      (acc, s) => Math.max(acc, Date.parse(s.started_at ?? '') + (s.duration_ms ?? 0)), 0,
    );
    const idle = now.getTime() - lastAt;
    const awaiting = steps.some((s) => s.status === 'waiting');
    const broken = steps.find((s) => s.handoff === 'empty');
    const complete = c.audit !== null;
    // The 30 approval minutes are NEVER counted as a stall: a pipeline waiting
    // for a person is working exactly as designed, and flagging it red would
    // teach an operator to ignore the colour that matters.
    const stalled = !awaiting && !complete && idle > STALL_AFTER_MS
      && idle < APPROVAL_GRACE_MS + STALL_AFTER_MS;

    const verdict: TraceChain['verdict'] = broken ? 'broken'
      : c.state === 'failed' ? 'failed'
        : awaiting ? 'awaiting'
          : complete ? 'complete'
            : stalled ? 'stalled' : 'running';

    return {
      alert_id: alertId,
      received_at: c.received_at,
      last_activity_at: new Date(lastAt).toISOString(),
      idle_ms: idle,
      verdict,
      steps,
      // The stages that never ran for this case. A short chain is not
      // necessarily broken — a duplicate legitimately stops at 01 — so this is
      // a list to READ beside the verdict, not a verdict of its own.
      missing: CHAIN_STEPS.filter((w) => !steps.some((s) => s.workflow === w)),
      terminal_reason: complete ? 'audited' : null,
      break_at: broken ? broken.workflow : null,
      payload: payloads.get(alertId) ?? null,
    } as TraceChain;
  });

  const counts = {
    broken: traceChains.filter((c) => c.verdict === 'broken').length,
    stalled: traceChains.filter((c) => c.verdict === 'stalled').length,
    failed: traceChains.filter((c) => c.verdict === 'failed').length,
    awaiting: traceChains.filter((c) => c.verdict === 'awaiting').length,
    running: traceChains.filter((c) => c.verdict === 'running').length,
    complete: traceChains.filter((c) => c.verdict === 'complete').length,
    // ONLY THE UNEXPECTED ONES. A diagnostic probe is a run we caused on
    // purpose; counting it would light the tab after every health check.
    orphans: orphans.filter(
      (o) => o.orphan_reason && UNEXPECTED_ORPHANS.includes(o.orphan_reason),
    ).length,
    attention: 0,
  };
  counts.attention = counts.broken + counts.stalled + counts.orphans;

  return {
    cases: list,
    trace: {
      generated_at: now.toISOString(),
      window: {
        limit: opts.limit,
        inspected: runs.length,
        attached: runs.length - orphans.length,
        oldest_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
        newest_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
        // The window is FULL, so older runs exist that this view knows nothing
        // about. Saying so beats letting someone read "no broken chain" as a
        // statement about their whole history.
        truncated: runs.length >= opts.limit,
      },
      stall_after_ms: STALL_AFTER_MS,
      chains: traceChains,
      orphans,
      executions,
      counts,
    },
  };
}
