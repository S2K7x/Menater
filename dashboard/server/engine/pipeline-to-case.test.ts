/**
 * The real pipeline, and the case the console builds out of it.
 *
 * ============================================================================
 * THE CLASS OF DEFECT THIS FILE EXISTS TO CLOSE
 *
 * `cases.ts` reads named node outputs — and then reads NAMED FIELDS inside
 * them. `cases.test.ts` checks the node ids against the workflow definitions,
 * so a renamed node fails a test. Nothing checked the field names, and every
 * fixture in that file was written by hand from the same memory that wrote the
 * reader. Three defects got through that way, all found by injecting a real
 * alert and reading the screen:
 *
 *   - `validation.valid` where the transform writes `validation_ok`, so a
 *     REJECTED alert's stage note said "received and validated";
 *   - `tuning.routing_outcome`, which that transform does not produce at all;
 *   - `row_id` read as a number when Postgres hands back `bigint` as a string.
 *
 * A hand-written fixture cannot catch any of those, because it is written by
 * the same person making the same assumption. So this file writes NO fixture:
 * it runs the actual workflows through the actual engine, hands the resulting
 * runs and steps to `buildCases`, and asserts on what an operator would see.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { Engine } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import { buildRegistry } from './transforms/registry.ts';
import { pureHandlers } from './nodes/pure.ts';
import { ioHandlers } from './nodes/io.ts';
import { controlHandlers } from './nodes/control.ts';
import { PIPELINE_WORKFLOWS } from './workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './workflows/routing.ts';
import { buildCases } from './cases.ts';
import { DEFAULT_LOCALE } from '../i18n.ts';
import type { RunRecord, StepRecord } from './types.ts';

const NOW = new Date('2026-09-04T10:00:00.000Z');

/**
 * The whole pipeline, on an in-memory store.
 *
 * Only the OUTSIDE is stubbed — the database, the model, Slack, HTTP. Every
 * transform, every guardrail and every wire is the real one, which is the only
 * way a field-name mismatch can surface.
 */
function assemble(opts: { rules?: unknown[]; dedup?: boolean } = {}) {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', true],
    ['approval.timeoutMinutes', 30],
    ['isolation.ttlMinutes', 60],
    ['shadow.exitThreshold', 50],
    ['slack.approvalChannel', '#soc-approvals'],
    ['slack.escalationChannel', '#soc-escalation'],
    ['slack.warningsChannel', '#soc-warnings'],
    ['slack.criticalChannel', '#soc-critical'],
    ['endpoint.isolation', ''],
    ['endpoint.ticket', ''],
    ['errors.windowMinutes', 60],
    ['errors.systemicThreshold', 5],
    ['errors.suppressMinutes', 30],
    ['llm.model', 'test/model'],
  ]);

  let auditRow = 1000;
  const deps = {
    transforms: buildRegistry({
      now: () => NOW,
      resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
    }),
    vars: () => vars,
    now: () => NOW,
    // No model key: the pipeline takes its fail-safe verdict, which is the
    // state a fresh install is actually in.
    secret: () => undefined,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: opts.dedup === true }];
      if (sql.includes('soc_tuning_rule')) return (opts.rules ?? []) as never[];
      if (sql.includes('INSERT INTO soc_audit_log')) {
        auditRow += 1;
        // A STRING, exactly as `pg` returns a `bigserial`. This is the shape
        // that made every case look untraceable.
        return [{
          id: String(auditRow),
          alert_id: 'x',
          prev_hash: 'aaaa',
          integrity_hash: 'bbbb',
          event_time: NOW.toISOString(),
        }] as never[];
      }
      if (sql.includes('soc_metrics_7d')) return [{ alerts_total: 1 }] as never[];
      return [];
    },
    runSubflow: async (workflowId: string, input: unknown, alertId: string | null) => {
      const sub = await engine.start(workflowId, input, alertId);
      return { run_id: sub.id, status: sub.status };
    },
  };

  const engine: Engine = new Engine({
    store,
    handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
    now: () => NOW,
  });
  for (const wf of [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS]) engine.register(wf);
  return { engine, store };
}

/** Every run the store holds, with its steps — what `snapshot.ts` reads. */
async function collect(store: MemoryRunStore) {
  const runs: RunRecord[] = await store.recentRuns({ limit: 200 });
  const steps: Map<string, StepRecord[]> = await store.stepsOfMany(runs.map((r) => r.id));
  return buildCases(runs, steps, { limit: 200, locale: DEFAULT_LOCALE, now: () => NOW });
}

const ALERT = {
  alert_id: 'E2E-1',
  rule_name: 'Multiple failed SSH logins followed by successful auth',
  severity: 'high',
  timestamp: NOW.toISOString(),
  raw_log: 'sshd[1234]: Accepted password for root from 185.220.101.5',
  source_ip: '185.220.101.5',
  host: 'web-01',
};

describe('a valid alert, end to end, as the console shows it', () => {
  it('produces a case whose every displayed field is populated', async () => {
    const { engine, store } = assemble();
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { cases } = await collect(store);

    expect(cases).toHaveLength(1);
    const c = cases[0];

    // Identity, read off the payload that entered the pipeline.
    expect(c.alert_id).toBe('E2E-1');
    expect(c.rule_name).toBe(ALERT.rule_name);
    expect(c.severity).toBe('high');
    expect(c.source_ip).toBe('185.220.101.5');
    expect(c.host).toBe('web-01');
    expect(c.raw_log).toContain('Accepted password');

    // The five stages, in order.
    expect(c.stages.map((s) => s.workflow)).toEqual([
      '01-Ingestion', '02-Enrichment', '03-AI-Decision', '04-Action-Routing', '05-Audit-Log',
    ]);

    // Enrichment: no key, so nothing ANSWERED — and that is said, not hidden
    // behind a reassuring "clean".
    expect(c.enrichment).not.toBeNull();
    expect(c.enrichment_meta).not.toBeNull();
    expect(c.enrichment_meta!.sources_ok).toHaveLength(0);

    // The fail-safe verdict, which is what a console with no model key produces.
    expect(c.decision).not.toBeNull();
    expect(c.decision!.verdict).toBe('needs_human');
    expect(c.decision!.confidence).toBe(0);
    expect(c.decision!.is_fallback).toBe(true);

    // Shadow mode is the default, so nothing touched the outside world.
    expect(c.shadow_mode).toBe(true);
    expect(c.executed).toBe(false);
    expect(c.routing_outcome).toBeTruthy();

    // The audit row, with the id arriving as a STRING from the database.
    expect(c.audit).not.toBeNull();
    expect(c.audit!.committed).toBe(true);
    expect(typeof c.audit!.row_id).toBe('number');
    expect(c.audit!.integrity_hash).toBeTruthy();

    // Inferred, and labelled as inferred on the card.
    expect(c.attack.map((a) => a.id)).toContain('T1110');

    // Not one stage note falls back to "unknown": every one of them is a field
    // this file could have read under the wrong name.
    for (const s of c.stages) {
      expect(s.note, `${s.workflow} has no readable note`).toBeTruthy();
      expect(s.note.toLowerCase(), `${s.workflow} fell back to "unknown"`).not.toBe('unknown');
    }
  });

  it('reports the chain as complete, with nothing needing attention', async () => {
    const { engine, store } = assemble();
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { trace } = await collect(store);

    expect(trace.counts.broken).toBe(0);
    expect(trace.counts.attention).toBe(0);
    expect(trace.counts.complete).toBe(1);
    expect(trace.chains[0].missing).toHaveLength(0);
    // The payload is held, so a replay would replay the real alert rather than
    // one reconstructed from memory.
    expect(trace.chains[0].payload).not.toBeNull();
    expect(trace.chains[0].payload!.rule_name).toBe(ALERT.rule_name);
  });
});

describe('an invalid alert', () => {
  it('is REJECTED, and the case says which fields were missing', async () => {
    const { engine, store } = assemble();
    // No alert_id, no rule_name, no timestamp, no raw_log.
    await engine.start('01-ingestion', { severity: 'high', source: 'generic' }, null);

    const response = await engine.responseOf(
      (await store.recentRuns({ limit: 1 }))[0].id,
    );
    // THE PIPELINE'S OWN VERDICT. The entry point returns this rather than a
    // blanket 202, so the sender learns its alert was refused.
    expect(response?.status).toBe(400);
    expect(JSON.stringify(response?.body)).toMatch(/missing_required_fields/);

    const { trace } = await collect(store);
    const orphan = trace.orphans[0];
    expect(orphan).toBeDefined();
    // It has no alert_id, so it attaches to no case — and it is LISTED.
    expect(orphan.orphan_reason).toBe('no_alert_id');
  });

  it('does not make the diagnostic probe look like an anomaly', async () => {
    const { engine, store } = assemble();
    // The Health tab's probe is invalid ON PURPOSE, to prove the entry point
    // and the validator work. Counting it would raise `attention` after every
    // connectivity test, and a permanent alarm stops being read.
    await engine.start('01-ingestion', { diagnostic_probe: true, source: 'generic' }, null);
    const { trace } = await collect(store);

    expect(trace.orphans).toHaveLength(1);
    expect(trace.orphans[0].orphan_reason).toBe('diagnostic_probe');
    expect(trace.counts.orphans).toBe(0);
    expect(trace.counts.attention).toBe(0);
  });
});

describe('a duplicate', () => {
  it('stops at 01 without costing an enrichment or a model call', async () => {
    const { engine, store } = assemble({ dedup: true });
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { cases } = await collect(store);

    const stages = cases[0].stages.map((s) => s.workflow);
    expect(stages).toEqual(['01-Ingestion']);
    expect(cases[0].decision).toBeNull();
  });
});

describe('a tuning rule that closes an alert', () => {
  it('routes straight to the audit log, and the case names the action', async () => {
    const RULE = {
      id: 'r1',
      name: 'weekly authorised scan',
      enabled: true,
      priority: 10,
      // `values` is a LIST, compared as OR \u2014 not a single `value`.
      conditions: [{ field: 'rule_name', op: 'contains', values: ['failed SSH'] }],
      action: 'allow',
      severity: null,
      owner: 'qa',
      reason: 'authorised',
      expires_at: null,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    };
    const { engine, store } = assemble({ rules: [RULE] });
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { cases } = await collect(store);

    const stages = cases[0].stages.map((s) => s.workflow);
    expect(stages).toContain('05-Audit-Log');
    expect(stages).not.toContain('03-AI-Decision');
    // CLOSED, NOT DROPPED — and the outcome is the action the rule took, read
    // from the field the transform actually writes.
    expect(cases[0].routing_outcome).toBe('allow');
    expect(cases[0].state).toBe('closed');
  });
});
