/**
 * The window must fetch no step output the case builder will not open.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 *
 * `NODE_CONTRACT` is per-workflow and it is also the query: `CASE_OUTPUTS` is
 * its flattened union, and `stepsOfMany` filters on `node_id` ALONE. So the
 * projection cannot tell two different nodes apart when they share an id —
 * and the six workflows contained two such pairs:
 *
 *   - `validate` is owned by `01-ingestion` (schema validation, read by
 *     `noteFor`) AND by `03-ai-decision` (the decision guardrails, read by
 *     nobody);
 *   - `normalize` is owned by `05-audit-log` (shaping the audit row, read by
 *     nobody) AND by `06-error-handler` (the incident, read for its
 *     `error_code`, `workflow` and `message`).
 *
 * Asking for one therefore fetched the other. Measured on a real PostgreSQL 16
 * over a window seeded by driving the six workflows (100 alerts, 500 runs,
 * 4,100 steps): `05-audit-log`'s row output is 4,297 B per alert and the
 * largest single output in the projection — **412,830 bytes of jsonb per
 * rebuild, read, sent and `JSON.parse`d for nothing**, every 15 s, on the
 * single thread that also answers the ingestion webhook.
 *
 * ============================================================================
 * WHY A UNIQUE NAME AND NOT A CLEVERER QUERY
 *
 * Every way of telling the two apart inside SQL was measured, and each costs
 * about what it saves — so the cheapest discriminator is a name no other
 * workflow uses. The numbers are in the pull request; the short version is
 * that a join on `(workflow_id, node_id)`, per-workflow `OR` groups and a
 * second round trip all came out between −0.3 ms and +0.1 ms, against
 * **+3.26 ms (14.5 % of the console's hottest query)** for simply not sharing
 * the id.
 *
 * So the invariant below is what keeps the flat projection EXACT, and the
 * comment on `CASE_OUTPUTS` no longer has to call itself "deliberately
 * coarser". The first claim is the structure; the second drives the real
 * pipeline, because a structural rule about ids says nothing about the bytes
 * a window actually carries.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Engine } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import { buildRegistry } from './transforms/registry.ts';
import { pureHandlers } from './nodes/pure.ts';
import { ioHandlers } from './nodes/io.ts';
import { controlHandlers } from './nodes/control.ts';
import { PIPELINE_WORKFLOWS } from './workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './workflows/routing.ts';
import { NODE_CONTRACT, CASE_OUTPUTS, CASE_INPUTS } from './cases.ts';
import { OUTPUT_NOT_READ } from './types.ts';
import type { RunRecord, StepRecord } from './types.ts';

const WORKFLOWS = [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS];

describe('the flat projection is exact', () => {
  it('declares no node id that more than one workflow owns', () => {
    // THE INVARIANT. `stepsOfMany` filters on `node_id` alone, so a declared
    // id a second workflow also owns is an output fetched for every run of
    // that second workflow — silently, and for nothing.
    const owners = new Map<string, string[]>();
    for (const wf of WORKFLOWS) {
      for (const node of wf.nodes) {
        const list = owners.get(node.id) ?? [];
        list.push(wf.id);
        owners.set(node.id, list);
      }
    }

    const declared = [...new Set(Object.values(NODE_CONTRACT).flat())];
    // NON-VACUITY, BOTH SIDES. A walk that found no node, or a contract that
    // declared nothing, would satisfy every assertion below it.
    expect(owners.size, 'no node found — has the workflow shape changed?').toBeGreaterThan(60);
    expect(declared.length, 'NODE_CONTRACT declares nothing').toBeGreaterThan(20);

    for (const id of declared) {
      const by = owners.get(id) ?? [];
      expect(
        by.length,
        `"${id}" is owned by ${by.join(' and ')}: asking for one fetches the other, `
          + 'because the projection filters on node_id alone',
      ).toBe(1);
    }
  });

  it('declares no node id the case builder never names', () => {
    // THE OTHER MISSING HALF. `cases.test.ts` checks that every id the reader
    // READS is declared; nothing checked the converse, so the contract could
    // declare an id no branch opens — and `CASE_OUTPUTS` is the query, so the
    // window fetched that output, sent it and `JSON.parse`d it for nothing.
    // `notify?`, `execute-failed` and `outcome` were exactly that, and
    // re-adding the audit row's node here is the mistake this refuses.
    //
    // COMMENTS ARE STRIPPED FIRST. Measured, the strip changes nothing today
    // — `cases.ts` quotes `outputOf(steps, '…')` in its prose only with an
    // ellipsis, so the extracted set is 21 ids either way — and it is kept
    // because this file's comments DO name node ids, and the next one to quote
    // a real call would make a dead declaration look named. No mutation can
    // kill this line; the measurement is here so nobody reads it as tested.
    const src = readFileSync(new URL('./cases.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    // The three ways this file can name a node, and nothing else counts.
    const opened = new Set([...src.matchAll(/outputOf\(steps, '([^']+)'\)/g)].map((m) => m[1]));
    const existence = new Set([...src.matchAll(/\bran\(steps, '([^']+)'\)/g)].map((m) => m[1]));
    // The handoff node is found by PREFIX (`NODE_CONTRACT[wf].find(n =>
    // n.startsWith('to-'))`), so a `to-…` id is named by that lookup.
    const byPrefix = (id: string) => src.includes("startsWith('to-')") && id.startsWith('to-');

    expect(opened.size, 'no outputOf call site found — has the reader moved?').toBeGreaterThan(10);
    expect(existence.size, 'no ran() call site found — has the reader moved?').toBeGreaterThan(0);

    for (const [workflowId, nodeIds] of Object.entries(NODE_CONTRACT)) {
      for (const id of nodeIds) {
        expect(
          opened.has(id) || existence.has(id) || byPrefix(id),
          `${workflowId} declares "${id}" and cases.ts never names it: the window `
            + 'fetches that output and no branch opens it',
        ).toBe(true);
      }
    }
  });

  it('declares every node id the case builder names through ran()', () => {
    // THE CONVERSE, FOR THE READ THE EXISTING CHECK CANNOT SEE.
    // `cases.test.ts` asserts that every id reached through `outputOf` is
    // declared — the half that was written when the contract became the
    // query. `ran(steps, '…')` is the other way this file names a node, and
    // nothing covered it: `attente` could be dropped from the contract and
    // every test stayed green, which is the rename blindness the table exists
    // to prevent, on the id whose rename would null EVERY approval.
    const src = readFileSync(new URL('./cases.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const named = [...new Set([...src.matchAll(/\bran\(steps, '([^']+)'\)/g)].map((m) => m[1]))];
    expect(named.length, 'no ran() call site found — has the reader moved?').toBeGreaterThan(0);
    const declared = new Set(Object.values(NODE_CONTRACT).flat());
    for (const id of named) {
      expect(declared.has(id), `cases.ts asks whether "${id}" ran and NODE_CONTRACT does not declare it`)
        .toBe(true);
    }
  });

  it('carries no output for a run whose workflow does not declare it', async () => {
    // DRIVEN, NOT REASONED. The claim is about the bytes a window carries, so
    // it runs the real workflows through the real engine and reads the window
    // back with the projection `snapshot.ts` passes.
    const { engine, store } = assemble();
    await engine.start('01-ingestion', ALERT, ALERT.alert_id);

    const runs: RunRecord[] = await store.recentRuns({ limit: 200, inputOf: CASE_INPUTS });
    const steps: Map<string, StepRecord[]> = await store.stepsOfMany(
      runs.map((r) => r.id),
      { outputsOf: CASE_OUTPUTS },
    );

    // The pipeline has to have REACHED the nodes this is about, or the window
    // is empty of exactly what would fail. `03-ai-decision` only runs its
    // guardrails when the provider answered, which is why this harness stubs
    // a compliant decision rather than letting the fail-safe verdict fire.
    const reached = new Set<string>();
    for (const list of steps.values()) for (const s of list) reached.add(s.nodeId);
    expect(reached, 'the decision guardrails never ran: nothing to measure')
      .toContain('validate-decision');
    expect(reached, 'the audit row was never shaped: nothing to measure')
      .toContain('shape-row');

    const byRun = new Map(runs.map((r) => [r.id, r]));
    const carried: string[] = [];
    for (const [runId, list] of steps) {
      const wf = byRun.get(runId)!.workflowId;
      const wanted = new Set(NODE_CONTRACT[wf] ?? []);
      for (const s of list) {
        if (s.output === OUTPUT_NOT_READ) continue;
        if (!wanted.has(s.nodeId)) carried.push(`${wf}/${s.nodeId}`);
      }
    }
    expect(carried, 'the window fetched outputs no branch of the case builder opens')
      .toEqual([]);
  });
});

// --- The harness ---------------------------------------------------------------

const NOW = new Date('2026-11-27T04:00:00.000Z');

/** A decision carrying the five keys the model node refuses an answer without. */
const DECISION = {
  verdict: 'true_positive',
  confidence: 0.82,
  reasoning: 'Repeated authentication failures from one address followed by a success. '
    + 'No enrichment source was unavailable.',
  recommended_action: 'escalate',
  data_lineage: ['alert.rule_name', 'alert.raw_log'],
};

const ALERT = {
  alert_id: 'PROJ-1',
  rule_name: 'Multiple failed SSH logins followed by successful auth',
  severity: 'high',
  timestamp: NOW.toISOString(),
  raw_log: 'sshd[1234]: Accepted password for root from 185.220.101.5',
  source_ip: '185.220.101.5',
  host: 'web-01',
  source: 'generic',
};

/**
 * The whole pipeline on an in-memory store, with a provider that ANSWERS.
 *
 * Only the outside is stubbed — the database, the model, the chat transport.
 * The model stub is what makes `03-ai-decision` reach its own guardrail node:
 * with no key the run takes the fail-safe branch, and the node this test is
 * about never runs.
 */
function assemble() {
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
    secret: (name: string) => (name === 'openrouter.apiKey' ? 'stub-key' : undefined),
    newToken: () => 'approval-token',
    fetch: (async (url: string) => {
      if (String(url).includes('chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(DECISION) } }],
            usage: { prompt_tokens: 1200, completion_tokens: 120 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"ok":true,"ts":"1"}', {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
      if (sql.includes('soc_tuning_rule')) return [] as never[];
      if (sql.includes('INSERT INTO soc_audit_log')) {
        auditRow += 1;
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
  for (const wf of WORKFLOWS) engine.register(wf);
  return { engine, store };
}
