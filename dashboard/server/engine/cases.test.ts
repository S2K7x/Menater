/**
 * Building the console's view from the engine's own runs.
 *
 * ============================================================================
 * THE TWO THINGS THESE TESTS PROTECT
 *
 *  1. THE NODE CONTRACT. The console reads named node outputs to assemble a
 *     case. Renaming one in `workflows/` used to make the console blind IN
 *     SILENCE — cases with pieces missing rather than an error. Both halves
 *     now live in this repository, so the check can be exact.
 *
 *  2. THE TYPES THE DATABASE ACTUALLY RETURNS. `pg` hands back `bigint` as a
 *     string, and reading the audit row id as a number made every case look
 *     untraceable. A fixture written by hand would have used a number and
 *     proved nothing; these use the shapes the real database produced.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { buildCases, NODE_CONTRACT, WORKFLOW_LABELS } from './cases.ts';
import { PIPELINE_WORKFLOWS } from './workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './workflows/routing.ts';
import { DEFAULT_LOCALE } from '../i18n.ts';
import type { RunRecord, StepRecord } from './types.ts';

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  workflowId: '01-ingestion',
  workflowVersion: 1,
  status: 'done',
  alertId: 'ALT-1',
  input: {
    alert_id: 'ALT-1', rule_name: 'Multiple failed SSH logins', severity: 'high',
    raw_log: 'sshd invalid user', source_ip: '185.220.101.5', host: 'web-01',
  },
  startedAt: '2026-09-04T10:00:00.000Z',
  endedAt: '2026-09-04T10:00:01.000Z',
  error: null,
  ...over,
});

const step = (runId: string, nodeId: string, output: unknown): StepRecord => ({
  runId, nodeId, attempt: 1, status: 'ok', output, port: 'main', error: null,
  startedAt: '2026-09-04T10:00:00.500Z', endedAt: '2026-09-04T10:00:00.900Z',
});

const build = (runs: RunRecord[], steps: StepRecord[]) =>
  buildCases(runs, new Map(runs.map((r) => [r.id, steps.filter((s) => s.runId === r.id)])), {
    limit: 120, locale: DEFAULT_LOCALE, now: () => new Date('2026-09-04T10:00:05.000Z'),
  });

describe('the node contract', () => {
  it('names only nodes that exist in the workflows that run', () => {
    // THE CHECK THAT REPLACES THE OLD n8n DIAGNOSTIC. Renaming a node without
    // updating NODE_CONTRACT used to empty the queue in silence.
    const defs = new Map([...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS].map((w) => [w.id, w]));
    for (const [workflowId, nodeIds] of Object.entries(NODE_CONTRACT)) {
      const wf = defs.get(workflowId);
      expect(wf, `workflow ${workflowId} is not registered`).toBeDefined();
      const present = new Set(wf!.nodes.map((n) => n.id));
      for (const id of nodeIds) {
        expect(present.has(id), `${workflowId} has no node "${id}"`).toBe(true);
      }
    }
  });

  it('labels every workflow the engine runs', () => {
    for (const w of [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS]) {
      expect(WORKFLOW_LABELS[w.id], `no label for ${w.id}`).toBeTruthy();
    }
  });
});

describe('the audit row', () => {
  /** Exactly the shape the real Postgres returned: `row_id` is a STRING. */
  const exposed = {
    audit: {
      row_id: '2651',
      committed: true,
      prev_hash: '9eb21accc3ff',
      integrity_hash: '1eaada17883b',
    },
  };

  it('reads a bigint id that arrived as a string', () => {
    const r = run({ id: 'r5', workflowId: '05-audit-log' });
    const { cases } = build([r], [step('r5', 'expose', exposed)]);

    // The defect this pins: read as `typeof === 'number'` the id was null,
    // every case looked untraceable, and Health announced 38 lost audit rows
    // over a database whose hash chain was intact. A false red costs more than
    // no red at all.
    expect(cases[0].audit).toMatchObject({
      committed: true, row_id: 2651, integrity_hash: '1eaada17883b',
    });
  });

  it('still reports a genuinely failed write as not committed', () => {
    const r = run({ id: 'r5', workflowId: '05-audit-log' });
    const { cases } = build([r], [
      step('r5', 'expose', exposed),
      step('r5', 'write-failed', { error: 'the database refused the connection' }),
    ]);
    // The fix must not turn every write green: a `write-failed` step outranks
    // whatever `expose` claimed.
    expect(cases[0].audit?.committed).toBe(false);
    expect(cases[0].audit?.failure).toMatch(/refused/);
  });
});

describe('stitching runs into a case', () => {
  it('assembles one case out of the five stages, in order', () => {
    const runs = [
      run({ id: 'r1', workflowId: '01-ingestion' }),
      run({ id: 'r2', workflowId: '02-enrichment', startedAt: '2026-09-04T10:00:01.000Z' }),
      run({ id: 'r3', workflowId: '03-ai-decision', startedAt: '2026-09-04T10:00:02.000Z' }),
      run({ id: 'r4', workflowId: '04-action-routing', startedAt: '2026-09-04T10:00:03.000Z' }),
      run({ id: 'r5', workflowId: '05-audit-log', startedAt: '2026-09-04T10:00:04.000Z' }),
    ];
    const steps = [
      step('r2', 'assemble', {
        enrichment: { shodan: { status: 'ok', source: 'shodan' } },
        enrichment_meta: { sources_ok: ['shodan'], sources_skipped: [], sources_unavailable: [], degraded: false },
      }),
      step('r3', 'finalize', {
        shadow_mode: true,
        decision: { verdict: 'needs_human', confidence: 0.4, recommended_action: 'escalate', reasoning: 'x', data_lineage: [] },
      }),
      step('r4', 'audit-record', { routing_outcome: 'shadow_logged' }),
      step('r5', 'expose', { audit: { row_id: '99', committed: true } }),
    ];
    const { cases } = build(runs, steps);

    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c.alert_id).toBe('ALT-1');
    expect(c.stages.map((s) => s.workflow)).toEqual([
      '01-Ingestion', '02-Enrichment', '03-AI-Decision', '04-Action-Routing', '05-Audit-Log',
    ]);
    expect(c.decision?.verdict).toBe('needs_human');
    expect(c.shadow_mode).toBe(true);
    expect(c.routing_outcome).toBe('shadow_logged');
    expect(c.state).toBe('closed');
    // Inferred from the rule name, and labelled as inferred on the card.
    expect(c.attack.map((a) => a.id)).toContain('T1110');
  });

  it('counts a run with no alert id as an orphan rather than dropping it', () => {
    // A console that filters in silence cannot answer "where did my run go".
    const { cases, trace } = build([run({ id: 'rX', alertId: null })], []);
    expect(cases).toHaveLength(0);
    expect(trace.orphans).toHaveLength(1);
    expect(trace.counts.attention).toBe(1);
  });

  it('shows a handoff that ran and passed NOTHING as a broken chain', () => {
    // The failure that reports success everywhere else, and the reason the
    // Tracking tab exists. `empty` and `absent` are different facts.
    const r = run({ id: 'r1', workflowId: '01-ingestion' });
    const { trace } = build([r], [
      { ...step('r1', 'to-enrichment', null), output: null },
    ]);
    expect(trace.chains[0].verdict).toBe('broken');
    expect(trace.chains[0].break_at).toBe('01-Ingestion');
  });

  it('does not call a still-running handoff absent', () => {
    // A run that has not reached the question yet has not failed it.
    const r = run({ id: 'r1', workflowId: '01-ingestion', status: 'running', endedAt: null });
    const { trace } = build([r], []);
    expect(trace.chains[0].verdict).not.toBe('broken');
  });

  it('never counts an approval wait as a stalled chain', () => {
    // The 30 approval minutes are a pause somebody asked for. Flagging them red
    // teaches an operator to ignore the colour that matters.
    const r = run({ id: 'r4', workflowId: '04-action-routing', status: 'waiting', endedAt: null,
      startedAt: '2026-09-04T09:00:00.000Z' });
    const { trace, cases } = build([r], []);
    expect(trace.chains[0].verdict).toBe('awaiting');
    expect(cases[0].state).toBe('awaiting_approval');
  });

  it('folds repeated identical stages instead of printing or hiding them', () => {
    // The pipeline amplifies: two alerts once produced twenty-five runs of 06.
    const runs = [
      run({ id: 'e1', workflowId: '06-error-handler', startedAt: '2026-09-04T10:00:01.000Z' }),
      run({ id: 'e2', workflowId: '06-error-handler', startedAt: '2026-09-04T10:00:02.000Z' }),
      run({ id: 'e3', workflowId: '06-error-handler', startedAt: '2026-09-04T10:00:03.000Z' }),
    ];
    const steps = runs.map((r) => step(r.id, 'normalize', { error_code: 'LLM_API_UNAVAILABLE' }));
    const { cases } = build(runs, steps);
    expect(cases[0].stages).toHaveLength(1);
    expect(cases[0].stages[0].repeat).toBe(3);
    expect(cases[0].errors).toHaveLength(3);
  });

  it('says the window was truncated rather than implying it saw everything', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run({ id: `r${i}`, alertId: `ALT-${i}` }));
    const { trace } = buildCases(runs, new Map(runs.map((r) => [r.id, []])), {
      limit: 5, locale: DEFAULT_LOCALE,
    });
    // "No broken chain" must not read as a statement about the whole history.
    expect(trace.window.truncated).toBe(true);
  });
});
