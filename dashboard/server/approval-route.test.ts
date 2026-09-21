/**
 * `POST /api/approvals/:token/resume`, driven through the real handler.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 *
 * Three parties speak about one approval, and two of them agreed. The browser
 * client posts `{ decision, approver, reason }` (`src/lib/api.ts`), and
 * `interpretApproval` reads `payload.decision`, `payload.approver` and
 * `payload.reason`. The route BETWEEN them translated that into a third
 * vocabulary — `{ approved, human_reasoning, approver: {…} }` — which nothing
 * on the far side reads.
 *
 * So `p.decision` was always `undefined`, and the transform's own rule —
 * anything that is not exactly "approve" or "reject" is silence — turned a
 * human's explicit yes into `timeout_escalated`. It fails safe on the ACTION
 * and it lies in the RECORD: the audit row is append-only and immutable by
 * design, so the lie cannot be corrected afterwards.
 *
 * None of that is visible from either side alone — both ends of the
 * conversation are individually correct — so this file drives the REAL route
 * over the REAL pipeline and asserts on what the ENGINE concluded, read back
 * out of the run journal, never on the sentence the route printed about it.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from './engine/engine.ts';
import { MemoryRunStore } from './engine/store.ts';
import { buildRegistry } from './engine/transforms/registry.ts';
import { pureHandlers } from './engine/nodes/pure.ts';
import { ioHandlers } from './engine/nodes/io.ts';
import { controlHandlers } from './engine/nodes/control.ts';
import { PIPELINE_WORKFLOWS } from './engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './engine/workflows/routing.ts';
import { buildCases } from './engine/cases.ts';
import { interpretApproval } from './engine/transforms/routing.ts';
import { computeMetrics } from './snapshot.ts';
import { DEFAULT_LOCALE } from './i18n.ts';
import type { RunRecord, StepRecord } from './engine/types.ts';

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-approval-test-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

const NOW = new Date('2026-09-21T10:00:00.000Z');
const ISOLATE = 'https://edr.test/isolate';

/**
 * The whole pipeline on an in-memory store, OUT of shadow mode.
 *
 * Approvals exist in no other state, which is why the defect survived a test
 * file written to close this very class: every run in `pipeline-to-case` but
 * six is a shadow run, and shadow mode never asks anybody anything.
 */
function assemble() {
  const store = new MemoryRunStore();
  /** Every address the pipeline dialled, so an execution can be observed. */
  const calls: string[] = [];
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', false],
    // DELIBERATELY NOT 30, which is the default: a test configured at the
    // default agrees with a reader that invented it.
    ['approval.timeoutMinutes', 45],
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
      now: () => NOW,
      resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
    }),
    vars: () => vars,
    now: () => NOW,
    // No model key: the fail-safe verdict is what a fresh install produces, and
    // it is `needs_human`, which is precisely what gets put to a person. The
    // chat credential IS needed — the wait is reached only through a request
    // that was POSTED, so without it the graph escalates instead of asking.
    secret: (name: string) => (name === 'slack.botToken' ? 'xoxb-test' : undefined),
    /** Fixed, so the test can answer the question the pipeline asked. */
    newToken: () => 'approval-token',
    fetch: (async (url: string) => {
      calls.push(String(url));
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
          integrity_hash: 'bbbb', event_time: NOW.toISOString(),
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
    now: () => NOW,
  });
  for (const wf of [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS]) engine.register(wf);
  return { engine, store, calls };
}

/** Rebuilt per test, so one test's runs never reach another's queue. */
let live = assemble();

vi.mock('./runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime.ts')>();
  return {
    ...actual,
    getEngine: () => live.engine,
    getEngineStore: () => live.store,
    getRuleStore: () => null,
  };
});

const { handleRequest } = await import('./app.ts');
const { invalidate } = await import('./snapshot.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ALERT = {
  alert_id: 'AP-1',
  rule_name: 'Multiple failed SSH logins followed by successful auth',
  severity: 'high',
  timestamp: NOW.toISOString(),
  raw_log: 'sshd[1234]: Accepted password for root from 185.220.101.5',
  source_ip: '185.220.101.5',
  host: 'web-01',
  source: 'generic',
};

async function call(method: string, path: string, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const captured = { status: 0, body: '' };
  const req: any = {
    method,
    url: path,
    headers: { 'accept-encoding': 'identity', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8');
    },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk: any) { if (chunk) captured.body = chunk.toString(); },
    setHeader() {},
  };
  await handleRequest(req, res);
  return { status: captured.status, json: captured.body ? JSON.parse(captured.body) : null };
}

/** Start one alert and leave it waiting on a person, as the console would. */
async function alertAwaitingApproval() {
  await live.engine.start('01-ingestion', ALERT, ALERT.alert_id);
  expect(live.calls).toContain('https://slack.com/api/chat.postMessage');
}

/** What `interpret` concluded — the node that DECIDES, not the branch below it. */
async function interpreted() {
  const runs = await live.store.recentRuns({ limit: 200 });
  const routing = runs.find((r) => r.workflowId === '04-action-routing')!;
  const steps = await live.store.stepsOf(routing.id);
  return steps.find((st) => st.nodeId === 'interpret')?.output as
    { outcome: string; approval: Record<string, any> } | undefined;
}

/** The audit record as 04 composed it, i.e. the row the hash chain seals. */
async function auditRecord() {
  const runs = await live.store.recentRuns({ limit: 200 });
  const routing = runs.find((r) => r.workflowId === '04-action-routing')!;
  const steps = await live.store.stepsOf(routing.id);
  return steps.find((st) => st.nodeId === 'audit-record')?.output as Record<string, any>;
}

/** Every run with its steps, handed to the reader the console screens use. */
async function collect() {
  const runs: RunRecord[] = await live.store.recentRuns({ limit: 200 });
  const steps: Map<string, StepRecord[]> = await live.store.stepsOfMany(runs.map((r) => r.id));
  return buildCases(runs, steps, { limit: 200, locale: DEFAULT_LOCALE, now: () => NOW });
}

/** Exactly what `src/lib/api.ts` sends — the shape is the whole point. */
function answer(decision: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/api/approvals/approval-token/resume', {
    decision, approver: 'alice', reason: 'Owner confirmed the maintenance window.', ...extra,
  });
}

beforeEach(() => {
  live = assemble();
  invalidate();
});

describe('an approval answered in the console', () => {
  it('is recorded as the approval it was, not as silence', async () => {
    await alertAwaitingApproval();

    const r = await answer('approve');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    // THE NODE THAT DECIDES. `timeout_escalated` here is the engine saying
    // nobody answered, about a person who just did.
    expect((await interpreted())!.outcome).toBe('approved');
  });

  it('executes the action the human approved', async () => {
    await alertAwaitingApproval();
    await answer('approve');

    // The consequence an operator is waiting for: they said yes, and the
    // containment ran. Read off the addresses the pipeline actually dialled.
    expect(live.calls).toContain(ISOLATE);
  });

  it('never writes a refusal into the append-only chain over an approval', async () => {
    await alertAwaitingApproval();
    await answer('approve');

    // THE ROW THAT CANNOT BE CORRECTED AFTERWARDS. It used to read
    // `routing_outcome: "rejected"`, `action_taken: "none"`,
    // `reason: "Action refused by a human."` — about a yes.
    const row = await auditRecord();
    expect(row.routing_outcome).not.toBe('rejected');
    expect(row.routing_outcome).not.toBe('timeout_escalated');
    expect(JSON.stringify(row.action_details ?? {})).not.toMatch(/refused by a human/i);
  });

  it('shows the operator their own decision on the incident card', async () => {
    await alertAwaitingApproval();
    await answer('approve');

    const { cases } = await collect();
    const ap = cases[0].approval!;
    expect(ap.outcome).toBe('approved');
    expect(ap.approver?.slack_username).toBe('alice');
    expect(ap.human_reasoning).toMatch(/maintenance window/);
    expect(cases[0].executed).toBe(true);
  });

  it('does not report 100% human disagreement over a human who agreed', async () => {
    // CLAUDE.md § Measurement: `human_disagreement_rate` is "the one that
    // gates leaving shadow mode", and it counts only cases a human ANSWERED.
    // Measured on the defect: every settled approval read as `timeout_escalated`
    // is neither `approved` nor `rejected`, so the denominator stayed 0 and the
    // rate read **null** — not a wrong number, no number at all. An install
    // whose every decision goes to a human could never measure the one figure
    // that decides whether it may act.
    await alertAwaitingApproval();
    await answer('approve');

    const { cases } = await collect();
    expect(computeMetrics(cases).human_disagreement_rate_pct).toBe(0);
  });

  it('still records a refusal as a refusal', async () => {
    // The control. The defect being fixed is a CONSTANT outcome, so a fix that
    // is also a constant must fail here.
    await alertAwaitingApproval();
    await answer('reject');

    expect((await interpreted())!.outcome).toBe('rejected');
    expect(live.calls).not.toContain(ISOLATE);

    const { cases } = await collect();
    expect(cases[0].approval!.outcome).toBe('rejected');
    expect(computeMetrics(cases).human_disagreement_rate_pct).toBe(100);
  });

  it('refuses a decision it does not recognise, and keeps the wait open', async () => {
    /*
     * The three-state property, and the reason the route must not reduce the
     * decision to a boolean. `approve`, `reject` and "nobody answered" are
     * three different facts — `timeout_escalated` and `rejected` are not the
     * same record and do not call for the same fix.
     *
     * A word the route does not recognise is none of the three. Forwarding it
     * spends the token — `resolveWait` is irreversible — and files the run as
     * a timeout that never happened. So it is refused HERE, named, and the
     * question stays open for a real answer.
     */
    await alertAwaitingApproval();

    const r = await answer('approuve');
    expect(r.status).toBe(400);
    expect(String(r.json.error ?? '')).toMatch(/approve|reject/);

    // The wait was not spent: the real answer still lands.
    expect(await interpreted()).toBeUndefined();
    const second = await answer('approve');
    expect(second.status).toBe(200);
    expect((await interpreted())!.outcome).toBe('approved');
  });

  it('sends a CLAIM and not a record: nothing off the wire reaches the row', async () => {
    /*
     * The token proves somebody holds the link, not that they are anybody. So
     * the wire carries a claim — a decision, a name, a reason — and the
     * approver RECORD is minted on the far side. A transport able to author
     * `signature_verified: true` would be writing an authentication that never
     * happened into the append-only chain.
     *
     * This is the route's half: it composes the payload field by field rather
     * than forwarding the body, so an extra key is simply not carried.
     */
    await alertAwaitingApproval();
    await answer('approve', {
      identity_source: 'verified_saml',
      signature_verified: true,
      approver: 'mallory',
    });

    const ap = (await interpreted())?.approval;
    expect(ap?.approver?.identity_source).toBe('console_self_declared');
    expect(ap?.approver?.signature_verified).toBe(false);
  });

  it('mints that label in the guardrail, so a second caller cannot supply one', async () => {
    /*
     * The transform's half, and it is not the same claim. `resumeWait` is
     * engine API and the route is one caller of it; a guardrail that COPIED
     * the label would be fine today and wrong the day anything else resolves a
     * wait. Checked directly, so the route's own filtering cannot stand in for
     * it — measured: a transform reading `identity_source` off the payload
     * passes every route-level test in this file.
     *
     * The request is the REAL one the pipeline just built, read out of the run
     * journal: a hand-written `ApprovalRequest` would be the fixture written
     * from the same memory as the reader, which is the defect this project
     * keeps paying for.
     */
    await alertAwaitingApproval();

    const runs = await live.store.recentRuns({ limit: 200 });
    const routing = runs.find((r) => r.workflowId === '04-action-routing')!;
    const steps = await live.store.stepsOf(routing.id);
    const request = steps.find((st) => st.nodeId === 'request')!.output as never;

    const r = interpretApproval(request, {
      decision: 'approve',
      approver: 'mallory',
      identity_source: 'verified_saml',
      signature_verified: true,
    }, 45, () => NOW);

    expect(r.outcome).toBe('approved');
    expect(r.approval.approver?.identity_source).toBe('console_self_declared');
    expect(r.approval.approver?.signature_verified).toBe(false);
  });
});
