/**
 * What the append-only chain records about the branches where something
 * actually HAPPENED.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 *
 * `04-Action-Routing` funnels seven branches into one `audit-record` node,
 * whose own note says the record is "identical whichever branch was taken".
 * `buildAuditRecord` reads that branch's outcome from the node immediately
 * upstream — `outcome: fromInput('')` — so every branch has to hand it a
 * ROUTING OUTCOME.
 *
 * Five of them do: `shadow-count`, `below-threshold`, `notify-failed`,
 * `rejected` and the error side of the escalation are all transforms that
 * compose `{ routing_outcome, executed, action_taken, approval, … }`.
 *
 * TWO OF THEM HAND IT THE RECEIPT OF AN I/O NODE INSTEAD, and they are exactly
 * the two branches where the pipeline touched the world:
 *
 *   `execute`          an `http` node, output `{ status, ok, body }`
 *   `escalate-timeout` a `notify` node, output `{ ts, transport }`
 *
 * Neither shape carries any of the five fields the record is made of, so
 * `buildAuditRecord` fell through to its own defaults on all of them. The row
 * sealed into `soc_audit_log` — append-only, hash-chained, and this product's
 * only tamper-evidence — therefore said, about a containment a human had just
 * approved and that had just run: `executed: false`, `action_taken: "none"`,
 * `routing_outcome: "unknown"`, and no approver, no reasoning, no approval
 * block at all. The record does not name the action it is evidence of, and it
 * cannot be corrected afterwards.
 *
 * ============================================================================
 * WHY THE EXISTING TESTS WERE GREEN OVER IT
 *
 * `approval-route.test.ts` asserts the row is NOT `rejected` and NOT
 * `timeout_escalated`, which `"unknown"` satisfies — the assertion was written
 * against a defect that wrote the WRONG word, and this one writes no word.
 * `routing.test.ts` calls `buildAuditRecord` directly with a hand-written
 * outcome (`{ routing_outcome: 'approved', executed: true, action_taken:
 * 'isolate_host_temporary' }`), which is the shape the graph never delivers:
 * a fixture written in the reader's vocabulary, the trap this repository
 * already carries. And `'approved'` is a sentence in `server/i18n.ts`'s
 * outcome catalogue that NOTHING in the engine produced.
 *
 * So these tests drive the REAL workflows through the REAL engine to a live
 * approval, answer it, and read the row back out of the run journal.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import { buildRegistry } from './transforms/registry.ts';
import { pureHandlers } from './nodes/pure.ts';
import { ioHandlers } from './nodes/io.ts';
import { controlHandlers } from './nodes/control.ts';
import { buildCases, CASE_INPUTS, CASE_OUTPUTS } from './cases.ts';
import { DEFAULT_LOCALE } from '../i18n.ts';
import { PIPELINE_WORKFLOWS } from './workflows/pipeline.ts';
import { ROUTING, ROUTING_WORKFLOWS } from './workflows/routing.ts';

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-audit-record-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const T0 = new Date('2026-09-29T10:00:00.000Z');
const ISOLATE = 'https://edr.test/isolate';
/** Deliberately not 30, which is the default: a default agrees with itself. */
const TIMEOUT_MINUTES = 45;

/**
 * The whole pipeline on an in-memory store, OUT of shadow mode, on a movable clock.
 *
 * `breakSecondChatPost` refuses the SECOND `chat.postMessage`, which is the
 * escalation: the first one is the approval request, and without it the run
 * never reaches a wait at all.
 */
function assemble(breakSecondChatPost = false) {
  const store = new MemoryRunStore();
  const calls: string[] = [];
  let chatPosts = 0;
  let clock = T0;
  const now = () => clock;

  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', false],
    ['approval.timeoutMinutes', TIMEOUT_MINUTES],
    ['isolation.ttlMinutes', 60],
    ['shadow.exitThreshold', 50],
    ['slack.approvalChannel', '#soc-approvals'],
    ['slack.escalationChannel', '#soc-escalation'],
    ['slack.warningsChannel', '#soc-warnings'],
    ['slack.criticalChannel', '#soc-critical'],
    ['endpoint.isolation', ISOLATE],
    ['endpoint.ticket', ''],
    ['errors.windowMinutes', 60],
    ['errors.systemicThreshold', 5],
    ['errors.suppressMinutes', 30],
    ['llm.model', 'test/model'],
  ]);

  const deps = {
    transforms: buildRegistry({
      now,
      resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
    }),
    vars: () => vars,
    now,
    // No model key: the fail-safe verdict is `needs_human`, which is exactly
    // what gets put to a person. The chat credential IS needed — the wait is
    // only reached through a request that was POSTED.
    secret: (name: string) => (name === 'slack.botToken' ? 'xoxb-test' : undefined),
    newToken: () => 'approval-token',
    fetch: (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('chat.postMessage')) {
        chatPosts += 1;
        if (breakSecondChatPost && chatPosts === 2) {
          return new Response('{"ok":false,"error":"channel_not_found"}', {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response('{"ok":true,"ts":"1"}', {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
      if (sql.includes('soc_tuning_rule')) return [];
      if (sql.includes('INSERT INTO soc_audit_log')) {
        return [{
          id: '4242', alert_id: 'x', prev_hash: 'aaaa',
          integrity_hash: 'bbbb', event_time: now().toISOString(),
        }] as never[];
      }
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
    now,
  });
  for (const wf of [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS]) engine.register(wf);

  return { engine, store, calls, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

let live = assemble();
beforeEach(() => { live = assemble(); });

const ALERT = {
  alert_id: 'AU-1',
  rule_name: 'Multiple failed SSH logins followed by successful auth',
  severity: 'high',
  timestamp: T0.toISOString(),
  raw_log: 'sshd[1234]: Accepted password for root from 185.220.101.5',
  source_ip: '185.220.101.5',
  host: 'web-01',
  source: 'generic',
};

/** Start one alert and leave it waiting on a person, as the console would. */
async function awaitingApproval(): Promise<string> {
  await live.engine.start('01-ingestion', ALERT, ALERT.alert_id);
  expect(live.calls).toContain('https://slack.com/api/chat.postMessage');
  const runs = await live.store.recentRuns({ limit: 200, inputOf: CASE_INPUTS });
  return runs.find((r) => r.workflowId === '04-action-routing')!.id;
}

/** The record 04 composed, i.e. exactly what 05 seals into the hash chain. */
async function auditRecord(): Promise<Record<string, any>> {
  const runs = await live.store.recentRuns({ limit: 200, inputOf: CASE_INPUTS });
  const routing = runs.find((r) => r.workflowId === '04-action-routing')!;
  const steps = await live.store.stepsOf(routing.id);
  return steps.find((st) => st.nodeId === 'audit-record')?.output as Record<string, any>;
}

describe('the audit record of an executed action', () => {
  it('names the action that ran, and says it ran', async () => {
    const runId = await awaitingApproval();
    await live.engine.resumeRun(runId, {
      decision: 'approve', approver: 'alice', reason: 'Owner confirmed the maintenance window.',
    });
    // The containment really happened: this is the row that is evidence of it.
    expect(live.calls).toContain(ISOLATE);

    const row = await auditRecord();
    // `escalate`, not `isolate_host_temporary`: there is no model key here, so
    // 03 takes the fail-safe verdict, and `fallbackDecision` proposes the
    // weakest action in the catalogue. That is the pipeline being right — what
    // matters is that the row names the action the catalogue approved, and
    // `none` is what it said before.
    expect(row.action_taken).toBe('escalate');
    expect(row.executed).toBe(true);
    expect(row.routing_outcome).toBe('approved');
  });

  it('carries the human who approved it into the append-only row', async () => {
    const runId = await awaitingApproval();
    await live.engine.resumeRun(runId, {
      decision: 'approve', approver: 'alice', reason: 'Owner confirmed the maintenance window.',
    });

    // `normalizeAuditRow` reads `human_approver`, `human_approver_id`,
    // `human_override` and `human_reasoning` out of this block and out of
    // nothing else. Absent, the chain records a containment nobody authorised.
    const row = await auditRecord();
    expect(row.approval).toBeTruthy();
    expect(row.approval.approver?.slack_username).toBe('alice');
    expect(row.approval.human_reasoning).toMatch(/maintenance window/);
    expect(row.approval.outcome).toBe('approved');
  });

  it('lets the incident card name the same action the chain sealed', async () => {
    /*
     * The other reader of the same hole. `cases.ts` took `action_taken` off
     * the `execute` step under `action` / `executed_action`, and that step is
     * an `http` node whose output is `{ status, ok, body }` — so the card said
     * an action had been executed and could not say which one. Both readers
     * now take it from the node that STATES the outcome, which is what stops
     * the card and the append-only row ever disagreeing.
     */
    const runId = await awaitingApproval();
    await live.engine.resumeRun(runId, {
      decision: 'approve', approver: 'alice', reason: 'Owner confirmed the maintenance window.',
    });

    const runs = await live.store.recentRuns({ limit: 200, inputOf: CASE_INPUTS });
    // The projection `snapshot.ts` passes: this asserts on the row an operator
    // gets, so it reads the window production reads.
    const steps = await live.store.stepsOfMany(
      runs.map((r) => r.id), { outputsOf: CASE_OUTPUTS },
    );
    const { cases } = buildCases(runs, steps, { limit: 200, locale: DEFAULT_LOCALE, now: () => T0 });

    expect(cases[0].executed).toBe(true);
    expect(cases[0].action_taken).toBe('escalate');
    expect(cases[0].action_taken).toBe((await auditRecord()).action_taken);
  });
});

describe('the audit record of an approval nobody answered', () => {
  it('records the expiry as the expiry, not as an unknown outcome', async () => {
    await awaitingApproval();

    live.advance((TIMEOUT_MINUTES + 1) * 60_000);
    const swept = await live.engine.sweepExpiredWaits();
    expect(swept.resumed).toHaveLength(1);
    expect(swept.failed).toEqual([]);
    // Silence is never consent: the escalation was posted, the action was not.
    expect(live.calls).not.toContain(ISOLATE);

    const row = await auditRecord();
    expect(row.routing_outcome).toBe('timeout_escalated');
    expect(row.executed).toBe(false);
    expect(row.action_taken).toBe('none');
    // What the deadline was, and what would have been done — already composed
    // by `approvalTimedOut`, and discarded before it reached the chain.
    expect(String(row.action_details?.reason ?? '')).toContain(String(TIMEOUT_MINUTES));
    expect(row.would_have_done ?? row.action_details?.would_have_done).toBe('escalate');
    // Both ports of the escalation reach the record, and they are different
    // incidents: nobody answered AND nobody was told is not nobody answered.
    expect(row.action_details?.escalation_posted).toBe(true);
  });

  it('still records the expiry when the escalation itself could not be posted', async () => {
    /*
     * The `error` port of the escalation, which fed `audit-record` directly
     * too and produced the same `"unknown"`. It is the WORST row of the three
     * to lose: nobody answered, and nobody was told either, so the chain is
     * the only place that fact exists.
     */
    live = assemble(true);
    await awaitingApproval();

    live.advance((TIMEOUT_MINUTES + 1) * 60_000);
    expect((await live.engine.sweepExpiredWaits()).resumed).toHaveLength(1);

    const row = await auditRecord();
    expect(row.routing_outcome).toBe('timeout_escalated');
    expect(row.executed).toBe(false);
    expect(row.action_details?.escalation_posted).toBe(false);
    expect(String(row.action_details?.escalation_error ?? '')).toMatch(/channel_not_found/);
  });
});

describe('the branches that already worked', () => {
  it('still records a human refusal as a refusal', async () => {
    // The control. The defect is two branches reporting NOTHING, so a fix that
    // reports one constant everywhere has to fail here.
    const runId = await awaitingApproval();
    await live.engine.resumeRun(runId, {
      decision: 'reject', approver: 'bob', reason: 'That host is in use.',
    });
    expect(live.calls).not.toContain(ISOLATE);

    const row = await auditRecord();
    expect(row.routing_outcome).toBe('rejected');
    expect(row.executed).toBe(false);
    expect(row.approval?.approver?.slack_username).toBe('bob');
  });
});

describe('the graph itself', () => {
  it('composes the audit record from an outcome on every branch, never from an I/O receipt', () => {
    /*
     * The structural half, and the reason it is not redundant with the four
     * tests above: this defect is per-EDGE, and a run exercises one edge. An
     * eighth branch wired into `audit-record` from an `http`, `notify`,
     * `postgres` or `llm` node would rebuild it in a shape no behavioural test
     * covers — the record would fall back to its own defaults again, silently,
     * on whatever that branch is.
     *
     * A `transform` is the only node type in the catalogue whose job is to
     * STATE what happened. An I/O node returns a transport receipt: a status,
     * a message timestamp, a row count. Neither is an outcome.
     */
    const byId = new Map(ROUTING.nodes.map((n) => [n.id, n]));
    const upstream = ROUTING.edges
      .filter((e) => e.to === 'audit-record')
      .map((e) => ({ from: e.from, port: e.fromPort, type: byId.get(e.from)?.type }));

    expect(upstream.length).toBeGreaterThan(1);
    expect(upstream.filter((u) => u.type !== 'transform')).toEqual([]);
  });
});
