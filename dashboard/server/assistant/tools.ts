/**
 * The assistant's tool catalogue.
 *
 * ============================================================================
 * A CLOSED, READ-ONLY LIST — AND THAT IS THE WHOLE SECURITY MODEL
 *
 * The console already has a closed catalogue of actions the pipeline may take
 * (`isolate_host_temporary`, `ticket`, `escalate`, `auto_close`) and a closed
 * catalogue of node types the engine may run. This is the third one, and it is
 * the strictest: it contains NO write at all.
 *
 * The assistant reads attacker-written text — that is its job, an operator
 * asking "explain this alert" is asking about a log someone else composed. The
 * literature measures unrestricted LLM access to log content at an 87%
 * prompt-injection success rate, and the defence it recommends is a quarantine
 * architecture: the model that reads untrusted content must not be the one
 * that can act. Here nothing can act. There is no tool that approves, isolates,
 * closes, replays, edits a rule, writes a setting or starts a scan. An
 * instruction smuggled through a log arrives at a model holding seven getters.
 *
 * A `TOOLS` entry with a side effect is therefore not a feature to review
 * carefully — it is a category error, and `tools.test.ts` fails on it.
 *
 * ============================================================================
 * TWO MORE RULES THAT DO NOT GUESS THEMSELVES
 *
 *  1. NO TOOL RETURNS A SECRET. `get_setup_state` reads through the same
 *     `publicView()` and `describeCredentials()` the browser gets: "set" or
 *     "absent", never a value. A model that has never seen a key cannot be
 *     talked into repeating one.
 *
 *  2. NO TOOL INVENTS A FIELD. Absent observables come back `null`, and the
 *     system prompt says what `null` means. Handing the model an em dash or an
 *     empty string is how "this alert has no destination address" becomes a
 *     confident sentence about an address that was never observed.
 * ============================================================================
 */

import { getConfig, publicView } from '../config.ts';
import { describeCredentials } from '../credentials.ts';
import { getRuleStore, ruleDb } from '../runtime.ts';
import { snapshot } from '../snapshot.ts';
import type { Locale } from '../i18n.ts';
import type { AlertCase } from '../../src/lib/types.ts';
import { UNTRUSTED_ALERT_FIELDS, fenceEnrichment, fenceFields, fenced, type Fence } from './sanitize.ts';
import type { ToolSpec } from './providers.ts';
import { GLOSSARY, lookupTerm } from './glossary.ts';
import { evaluateRules } from '../engine/transforms/tuning.ts';

/**
 * A tool as the model sees it, plus the function that answers it.
 *
 * The schema is hand-written JSON Schema rather than derived from a validation
 * library: the console API has ONE production dependency and this feature is
 * not the reason to add a second. Seven small schemas are cheaper than a
 * runtime the whole image then carries.
 */
export interface AssistantTool {
  name: string;
  /**
   * Written FOR THE MODEL, not for a developer. It says when to reach for the
   * tool, because a description that only says what the tool returns produces
   * an assistant that answers from memory and never calls it.
   */
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  locale: Locale;
  /** Per-request fence. Every untrusted string leaves through it. */
  fence: Fence;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const num = (v: unknown, fallback: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
};

/**
 * One alert, as a row in a list.
 *
 * Deliberately NOT the whole case: a list of twenty full cases is forty
 * thousand tokens of raw logs, and the model then has no budget left to read
 * the one the operator actually asked about. The row carries what decides
 * whether to open it.
 */
function alertRow(c: AlertCase, fence: Fence) {
  return {
    alert_id: c.alert_id,
    received_at: c.received_at,
    state: c.state,
    severity: c.severity,
    rule_name: fenced(fence, 'rule_name', c.rule_name),
    verdict: c.decision?.verdict ?? null,
    confidence: c.decision?.confidence ?? null,
    recommended_action: c.decision?.recommended_action ?? null,
    shadow_mode: c.shadow_mode,
    executed: c.executed,
    awaiting_approval: c.approval?.outcome === 'pending',
    host: c.host,
    source_ip: c.source_ip || null,
    dwell_ms: c.dwell_ms,
    error_count: c.errors.length,
  };
}

/**
 * One alert, whole.
 *
 * The untrusted fields go through the fence; everything else — verdicts,
 * confidences, timestamps, the approval record — is ours and travels plain.
 */
/**
 * One alert, whole — or only the parts asked for.
 *
 * THE SECTIONS ARE THE OPTIMISATION THAT PAYS MOST. A full case with enrichment,
 * stages and a long raw log serialises to several kilobytes; three of them in
 * one turn push the operator's actual question out of the context window, and
 * that failure is silent — the answer comes back fluent and about the wrong
 * thing. Returning fewer fields beats every other saving available here.
 *
 * The default is still everything, deliberately: a caller who does not know
 * what it needs must not get a truncated record it believes is complete. The
 * narrowing is opt-in, and the reply says what was left out.
 */
function alertDetail(c: AlertCase, fence: Fence, sections: string[] | null = null) {
  const want = (name: string) => sections === null || sections.includes(name);

  return {
    ...alertRow(c, fence),
    dest_ip: c.dest_ip || null,
    ...(sections === null
      ? {}
      : {
          sections_returned: sections,
          omitted_note:
            'Only the sections listed above were returned. Say your reading is partial rather than '
            + 'presenting it as the whole record.',
        }),
    ...(want('log') ? { raw_log: fenced(fence, 'raw_log', c.raw_log) } : {}),
    routing_outcome: c.routing_outcome,
    action_taken: c.action_taken,
    ...(want('decision') ? { decision: c.decision
      ? fenceFields(fence, c.decision as unknown as Record<string, unknown>, UNTRUSTED_ALERT_FIELDS)
      : null } : {}),
    /**
     * `enrichment` is third-party prose about an address the attacker chose —
     * see `fenceEnrichment`. `enrichment_meta` is not: its source lists are our
     * own names, `file_hash` is a hex match our regex made on the log, and the
     * rest are booleans and a timestamp. Fencing it too would dilute the mark.
     */
    ...(want('enrichment')
      ? { enrichment: fenceEnrichment(fence, c.enrichment), enrichment_meta: c.enrichment_meta }
      : {}),
    ...(want('approval') ? { approval: c.approval } : {}),
    ...(want('audit') ? { audit: c.audit } : {}),
    attack: c.attack,
    ...(want('stages') ? { stages: c.stages.map((s) => ({
      workflow: s.workflow,
      status: s.status,
      started_at: s.started_at,
      duration_ms: s.duration_ms,
      note: fenced(fence, 'stage_note', s.note),
    })) } : {}),
    ...(want('errors')
      ? { errors: c.errors.map((e) => fenceFields(fence, e as unknown as Record<string, unknown>, ['message'])) }
      : {}),
    /**
     * Said explicitly rather than left to inference. A model that sees no
     * `dest_ip` key cannot tell "the detection named none" from "the console
     * did not send it", and it will pick whichever reads better.
     */
    absent_observables: (['dest_ip', 'host', 'source_ip'] as const).filter((k) => !c[k]),
  };
}

export const TOOLS: AssistantTool[] = [
  {
    name: 'list_alerts',
    description:
      'The triage queue, newest first. Use for "what is waiting / what came in". Compact rows; '
      + 'get_alert for one in full.',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          description: 'Filter on the case state, e.g. "awaiting_approval", "closed", "failed".',
        },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        awaiting_human: {
          type: 'boolean',
          description: 'Only alerts that are blocking a human decision right now.',
        },
        limit: { type: 'integer', description: 'At most 25. Defaults to 10.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const snap = await snapshot(ctx.locale);
      const state = str(args.state);
      const severity = str(args.severity);
      let rows = snap.cases;
      if (state) rows = rows.filter((c) => c.state === state);
      if (severity) rows = rows.filter((c) => c.severity === severity);
      if (args.awaiting_human === true) {
        rows = rows.filter((c) => c.approval?.outcome === 'pending' || c.decision?.verdict === 'needs_human');
      }
      const limit = num(args.limit, 10, 25);
      return {
        // The count BEFORE the cap, so the assistant can say "12 of 40" rather
        // than presenting a truncated list as the whole queue.
        matched: rows.length,
        returned: Math.min(rows.length, limit),
        alerts: rows.slice(0, limit).map((c) => alertRow(c, ctx.fence)),
      };
    },
  },

  {
    name: 'get_alert',
    description:
      'One alert in full: log, enrichment, verdict, approval, audit, errors. Call before '
      + 'explaining or assessing any named alert. Use `sections` to keep the reply small.',
    parameters: {
      type: 'object',
      properties: {
        alert_id: { type: 'string', description: 'The alert identifier, e.g. "alert-1234".' },
        sections: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['log', 'decision', 'enrichment', 'approval', 'audit', 'stages', 'errors'],
          },
          description: 'Which parts to include. Omit for all of them.',
        },
      },
      required: ['alert_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args.alert_id);
      if (!id) return { error: 'alert_id is required.' };
      const snap = await snapshot(ctx.locale);
      const found = snap.cases.find((c) => c.alert_id === id);
      if (!found) {
        // A near-miss list beats a bare "not found": most of the time the
        // operator typed the identifier from memory, or from a Slack message.
        const near = snap.cases
          .filter((c) => c.alert_id.includes(id) || id.includes(c.alert_id))
          .slice(0, 5)
          .map((c) => c.alert_id);
        return {
          error: `No alert "${id}" in the current execution window.`,
          window_note:
            'The console only holds a bounded window of executions. An older alert is not '
            + 'missing, it is out of view — say so rather than saying it does not exist.',
          similar_ids: near,
        };
      }
      const wanted = Array.isArray(args.sections)
        ? (args.sections as unknown[]).filter((x): x is string => typeof x === 'string')
        : null;
      return alertDetail(found, ctx.fence, wanted);
    },
  },

  {
    name: 'get_trace',
    description:
      'The execution chain behind one alert: which workflows ran and where it stopped. Use for '
      + '"why is it stuck, late, or never decided".',
    parameters: {
      type: 'object',
      properties: { alert_id: { type: 'string' } },
      required: ['alert_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args.alert_id);
      if (!id) return { error: 'alert_id is required.' };
      const snap = await snapshot(ctx.locale);
      const chain = snap.trace.chains.find((c) => c.alert_id === id);
      if (!chain) return { error: `No execution chain for "${id}" in the current window.` };
      return {
        alert_id: chain.alert_id,
        verdict: chain.verdict,
        idle_ms: chain.idle_ms,
        break_at: chain.break_at,
        missing_steps: chain.missing,
        terminal_reason: chain.terminal_reason,
        steps: chain.steps.map((s) => ({
          workflow: s.workflow,
          status: s.status,
          // `items` / `empty` / `absent`. The distinction IS the diagnosis: a
          // step that ran and passed nothing is not a step that never ran.
          handoff: s.handoff,
          started_at: s.started_at,
          duration_ms: s.duration_ms,
        })),
        meaning: {
          broken: 'A step ran and passed zero items to the next one. Nothing failed; nothing continued.',
          stalled: 'No new step for five minutes, outside an approval wait.',
          awaiting: 'Waiting on a human approval. That is not a failure.',
          complete: 'The five steps ran and the audit row was written.',
        },
      };
    },
  },

  {
    name: 'get_metrics',
    description:
      'Pipeline figures over the window: volumes, verdicts, the two shadow-mode rates, dwell '
      + 'times.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const snap = await snapshot(ctx.locale);
      return {
        ...snap.metrics,
        rate_meanings: {
          ai_false_positive_verdict_rate:
            'The share of alerts CLASSED as false positives. A measure of distribution, not of '
            + 'correctness. Never present it as an accuracy figure.',
          human_disagreement_rate:
            'The share of decisions put to a human that they rejected. The only false-positive '
            + 'proxy observable without ground truth, and the one that gates leaving shadow mode.',
        },
      };
    },
  },

  {
    name: 'get_health',
    description:
      'Connectivity and pipeline health. Use when something is reported not working.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const snap = await snapshot(ctx.locale);
      return {
        ...snap.health,
        attention_counts: snap.trace.counts,
        window: snap.trace.window,
      };
    },
  },

  {
    name: 'list_rules',
    description:
      'The tuning rules: what this team declared normal. Use when an alert was closed or softened '
      + 'without a model decision.',
    parameters: {
      type: 'object',
      properties: {
        enabled_only: { type: 'boolean', description: 'Defaults to true.' },
        limit: { type: 'integer', description: 'At most 50. Defaults to 20.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const store = getRuleStore();
      if (!store) {
        return {
          error: 'The rule store is unavailable: no database is configured for this console.',
          consequence: 'Alerts are triaged untuned. That makes the pipeline noisier, never more permissive.',
        };
      }
      const rules = await ruleDb(() => store.list());
      const enabledOnly = args.enabled_only !== false;
      const rows = (enabledOnly ? rules.filter((r) => r.enabled) : rules).slice(0, num(args.limit, 20, 50));
      return {
        total: rules.length,
        returned: rows.length,
        rules: rows.map((r) => ({
          id: r.id,
          name: fenced(ctx.fence, 'rule_name', r.name),
          action: r.action,
          enabled: r.enabled,
          priority: r.priority,
          owner: r.owner,
          reason: fenced(ctx.fence, 'rule_reason', r.reason),
          expires_at: r.expires_at ?? null,
          conditions: r.conditions,
        })),
        ordering: 'First match wins, ordered by priority, ties broken on id.',
      };
    },
  },

  {
    name: 'search_alerts',
    description:
      'Find alerts by free text over id, detection name, host and IPs. Use when the operator '
      + 'names a machine, an address or a kind of detection rather than an id.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to look for, e.g. "srv-bastion", "185.220", "ssh".',
        },
        limit: { type: 'integer', description: 'At most 25. Defaults to 10.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const q = str(args.query)?.toLowerCase();
      if (!q) return { error: 'query is required.' };
      const snap = await snapshot(ctx.locale);
      // Searched on the RAW values, never on the fenced ones: a fence would put
      // its nonce in the middle of the haystack and break every match.
      const hits = snap.cases.filter((c) =>
        [c.alert_id, c.rule_name, c.host ?? '', c.source_ip, c.dest_ip]
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
      return {
        query: q,
        matched: hits.length,
        returned: Math.min(hits.length, num(args.limit, 10, 25)),
        // The raw log is deliberately NOT searched: it is the largest field and
        // the one an attacker controls, so a match in it is a match on text
        // chosen by them. Say so rather than let the caller assume coverage.
        searched_fields: ['alert_id', 'rule_name', 'host', 'source_ip', 'dest_ip'],
        alerts: hits.slice(0, num(args.limit, 10, 25)).map((c) => alertRow(c, ctx.fence)),
      };
    },
  },

  {
    name: 'get_attention',
    description:
      'What needs a human now: approvals waiting, broken chains, blocking findings. Prefer this '
      + 'over list_alerts + get_health + get_metrics.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const snap = await snapshot(ctx.locale);
      const waiting = snap.cases.filter((c) => c.approval?.outcome === 'pending');
      const failed = snap.cases.filter((c) => c.state === 'failed');
      return {
        awaiting_approval: {
          count: waiting.length,
          // The oldest first: an approval window expires, and silence is never
          // consent — a timeout executes nothing, so the alert simply rots.
          alerts: waiting
            .sort((a, b) => a.received_at.localeCompare(b.received_at))
            .slice(0, 10)
            .map((c) => alertRow(c, ctx.fence)),
        },
        failed: { count: failed.length, alerts: failed.slice(0, 5).map((c) => alertRow(c, ctx.fence)) },
        chains: snap.trace.counts,
        blocking_findings: snap.health.blocking_findings,
        mode: snap.health.mode,
        note:
          snap.health.mode === 'demo'
            ? 'This console is showing SAMPLE DATA: no live source is attached. Say so before '
              + 'reporting any of these numbers as the state of a real pipeline.'
            : null,
      };
    },
  },

  {
    name: 'explain_term',
    description:
      'What a word means IN THIS PRODUCT (shadow_mode, needs_human, the two false-positive rates, '
      + 'broken chain). Several have an ordinary meaning that is wrong here.',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'The word to explain. Omit to list every term.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const term = str(args.term);
      if (!term) return { terms: GLOSSARY };
      const { entry, suggestions } = lookupTerm(term);
      if (entry) return entry;
      return {
        error: `No glossary entry for "${term}".`,
        // Answering with the list beats answering with nothing: the caller
        // would otherwise fall back on what it already believes the word means.
        available: suggestions,
      };
    },
  },

  {
    name: 'find_similar',
    description:
      'Other alerts sharing this one\u2019s host, source address or detection. Use to answer "is this '
      + 'a one-off or a campaign?" before assessing a single alert in isolation.',
    parameters: {
      type: 'object',
      properties: {
        alert_id: { type: 'string' },
        limit: { type: 'integer', description: 'At most 25. Defaults to 10.' },
      },
      required: ['alert_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args.alert_id);
      if (!id) return { error: 'alert_id is required.' };
      const snap = await snapshot(ctx.locale);
      const seed = snap.cases.find((c) => c.alert_id === id);
      if (!seed) return { error: `No alert "${id}" in the current execution window.` };

      // Scored rather than filtered: a shared host AND a shared rule is a much
      // stronger signal than either alone, and a flat filter cannot say so.
      const scored = snap.cases
        .filter((c) => c.alert_id !== id)
        .map((c) => {
          const shared: string[] = [];
          if (seed.host && c.host === seed.host) shared.push('host');
          if (seed.source_ip && c.source_ip === seed.source_ip) shared.push('source_ip');
          if (seed.rule_name && c.rule_name === seed.rule_name) shared.push('rule_name');
          if (seed.dest_ip && c.dest_ip === seed.dest_ip) shared.push('dest_ip');
          return { c, shared };
        })
        .filter((x) => x.shared.length > 0)
        .sort((a, b) => b.shared.length - a.shared.length);

      return {
        seed: { alert_id: seed.alert_id, host: seed.host, source_ip: seed.source_ip || null },
        matched: scored.length,
        // Said explicitly: an empty result on a bounded window means "none in
        // view", not "none exist", and the two lead to different decisions.
        window_note:
          'Only the current execution window was searched. No match here does not mean no match ever.',
        similar: scored.slice(0, num(args.limit, 10, 25)).map((x) => ({
          ...alertRow(x.c, ctx.fence),
          shared_with_seed: x.shared,
        })),
      };
    },
  },

  {
    name: 'explain_verdict',
    description:
      'Why one alert got the verdict it did: what the model relied on, what capped its confidence, '
      + 'and what intelligence was missing. Use before repeating a confidence figure.',
    parameters: {
      type: 'object',
      properties: { alert_id: { type: 'string' } },
      required: ['alert_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args.alert_id);
      if (!id) return { error: 'alert_id is required.' };
      const snap = await snapshot(ctx.locale);
      const c = snap.cases.find((x) => x.alert_id === id);
      if (!c) return { error: `No alert "${id}" in the current execution window.` };
      if (!c.decision) {
        return {
          alert_id: id,
          verdict: null,
          why: 'No decision was recorded for this alert. Look at get_trace: the chain may not have '
            + 'reached the decision step.',
        };
      }

      const meta = c.enrichment_meta;
      return {
        alert_id: id,
        verdict: c.decision.verdict,
        confidence: c.decision.confidence,
        // The number BEFORE the caps, next to the number after them. Reporting
        // only the capped figure hides that a guardrail acted; reporting only
        // the raw one reports something the pipeline did not act on.
        raw_confidence: c.decision.raw_confidence ?? null,
        guardrails_applied: c.decision.guardrails_applied ?? [],
        is_fallback: c.decision.is_fallback,
        fallback_meaning: c.decision.is_fallback
          ? 'This verdict was NOT produced by a model. It is the fail-safe: needs_human, confidence '
            + '0. Usually a missing or refused model key.'
          : null,
        decision_source: c.decision.decision_source,
        model: c.decision.model,
        data_lineage: c.decision.data_lineage ?? [],
        reasoning: fenced(ctx.fence, 'reasoning', c.decision.reasoning),
        intelligence: meta
          ? {
              sources_ok: meta.sources_ok,
              sources_unavailable: meta.sources_unavailable,
              degraded: meta.degraded,
              degraded_meaning: meta.degraded
                ? 'At least one enrichment source did not answer, so part of the picture is missing. '
                  + 'Say which, rather than presenting the verdict as fully corroborated.'
                : null,
            }
          : null,
        recommended_action: c.decision.recommended_action,
        executed: c.executed,
        shadow_mode: c.shadow_mode,
      };
    },
  },

  {
    name: 'get_timeline',
    description:
      'What happened over the window, oldest first: arrivals, decisions, approvals, failures. Use '
      + 'for "what happened while I was away".',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'At most 50 events. Defaults to 25.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const snap = await snapshot(ctx.locale);
      const events: Array<Record<string, unknown>> = [];

      for (const c of snap.cases) {
        events.push({
          at: c.received_at,
          event: 'received',
          alert_id: c.alert_id,
          severity: c.severity,
          rule_name: fenced(ctx.fence, 'rule_name', c.rule_name),
        });
        if (c.decision) {
          events.push({
            at: c.received_at,
            event: 'decided',
            alert_id: c.alert_id,
            verdict: c.decision.verdict,
            confidence: c.decision.confidence,
            is_fallback: c.decision.is_fallback,
          });
        }
        if (c.approval?.outcome && c.approval.outcome !== 'pending') {
          events.push({
            at: c.approval.requested_at ?? c.received_at,
            event: `approval_${c.approval.outcome}`,
            alert_id: c.alert_id,
            // The approver's declared identity, and it is DECLARED: the
            // console's lock protects access, it identifies nobody.
            approver: c.approval.approver?.slack_username ?? null,
            identity_source: c.approval.approver?.identity_source ?? null,
          });
        }
        for (const e of c.errors) {
          events.push({
            at: e.at,
            event: 'error',
            alert_id: c.alert_id,
            workflow: e.workflow,
            error_code: e.error_code,
            requires_replay: e.requires_replay,
          });
        }
      }

      events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const limit = num(args.limit, 25, 50);
      return {
        window: snap.metrics.window_label,
        total_events: events.length,
        // The LAST n, not the first: "what happened while I was away" is a
        // question about the recent end of the window.
        events: events.slice(-limit),
      };
    },
  },

  {
    name: 'test_rule',
    description:
      'Dry run: which tuning rule would match a given alert, and what it would do. Changes nothing. '
      + 'Use to answer "why was this closed without a decision" or "would my rule catch this".',
    parameters: {
      type: 'object',
      properties: {
        alert_id: {
          type: 'string',
          description: 'Test the stored rules against this alert from the queue.',
        },
      },
      required: ['alert_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args.alert_id);
      if (!id) return { error: 'alert_id is required.' };
      const store = getRuleStore();
      if (!store) return { error: 'The rule store is unavailable: no database is configured.' };
      const snap = await snapshot(ctx.locale);
      const c = snap.cases.find((x) => x.alert_id === id);
      if (!c) return { error: `No alert "${id}" in the current execution window.` };

      const rules = await ruleDb(() => store.list());
      const alert = {
        alert_id: c.alert_id,
        rule_name: c.rule_name,
        severity: c.severity,
        source_ip: c.source_ip || null,
        dest_ip: c.dest_ip || null,
        host: c.host,
        raw_log: c.raw_log,
      };
      const outcome = evaluateRules(alert, rules);

      return {
        alert_id: id,
        matched: outcome.rule ? { name: fenced(ctx.fence, 'rule_name', outcome.rule.name), id: outcome.rule.id } : null,
        action: outcome.action,
        resulting_severity: outcome.severity,
        note: outcome.note ? fenced(ctx.fence, 'rule_note', outcome.note) : null,
        // Named rather than silently skipped: an expired exception that stops
        // working without saying so looks exactly like one that never worked.
        expired_rules_skipped: outcome.expired,
        ordering: 'First match wins, ordered by priority, ties broken on id.',
        dry_run: true,
      };
    },
  },

  {
    name: 'get_setup_state',
    description:
      'What is still missing before this installation can triage: credentials, ingestion, '
      + 'database, shadow mode. Says whether a key is SET, never its value.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cfg = getConfig();
      const view = publicView();
      const creds = describeCredentials();
      return {
        credentials: creds.map((c) => ({
          label: c.label,
          set: c.set,
          required: c.required,
          source: c.source,
          where_to_set: 'Settings → Credentials',
        })),
        shadow_mode: cfg.pipeline.shadowMode,
        shadow_mode_meaning:
          'In shadow mode the pipeline decides and records but executes nothing. It is the '
          + 'default, and leaving it is gated on the human disagreement rate.',
        ingestion: { mode: view.webhook.mode, shared_secret_set: view.webhook.secretSet },
        database: { host: view.database.host, name: view.database.database, password_set: view.database.passwordSet },
        access_lock: view.auth.enabled,
        note:
          'Without the triage model key, every alert takes the fail-safe verdict: needs_human, '
          + 'confidence 0. The pipeline runs; nothing is triaged.',
      };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * The catalogue in the neutral shape `providers.ts` translates from.
 *
 * NOT an OpenAI-shaped payload any more: the four providers disagree about
 * where a tool's schema goes and what it may contain, and baking one of their
 * shapes in here made the other three the exception.
 */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  }));
}

/**
 * Runs one tool call.
 *
 * A tool that throws returns its message AS A RESULT, not as a thrown error:
 * the loop must be able to tell the model "that lookup failed, here is why" and
 * let it answer the operator. Aborting the whole turn on an unreachable
 * database would replace a usable answer with a spinner.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { error: `No tool named "${name}".` };
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    return { error: `${name} failed: ${(err as Error).message}` };
  }
}
