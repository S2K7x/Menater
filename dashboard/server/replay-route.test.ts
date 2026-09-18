/**
 * `POST /api/replay`, driven through the real handler.
 *
 * ============================================================================
 * THE GUARANTEE THIS CHANGE PUT AT RISK
 *
 * The original alert used to ride to the browser inside
 * `trace.chains[].payload`. It does not any more — the chain says only
 * `replayable`, and the route reads the five fields back on this side through
 * `replayPayload`. The size saving is worth nothing if that read is wrong:
 * a route that can no longer find the alert answers **409** on a case that is
 * perfectly replayable, and a route that replayed a RECONSTRUCTED alert would
 * be the invented default this product refuses everywhere.
 *
 * Neither of those is visible from `replayPayload` alone, so this file drives
 * the real handler over the real pipeline and asserts on what the ENGINE
 * received — the alert that was actually re-injected, read back out of the run
 * journal, not the sentence the route printed about it.
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

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-replay-test-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

const NOW = new Date('2026-09-18T10:00:00.000Z');

/** The whole pipeline on an in-memory store; only the outside is stubbed. */
function assemble() {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', true],
    ['approval.timeoutMinutes', 30],
    ['isolation.ttlMinutes', 60],
    ['shadow.exitThreshold', 50],
    ['notify.minSeverity', 'off'],
    ['endpoint.isolation', ''],
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
    secret: () => undefined,
    newToken: () => 'approval-token',
    fetch: (async () => new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch,
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
  return { engine, store };
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

const MARKER = 'RAWLOGMARKER-5d21b7';
const ALERT = {
  alert_id: 'RP-1',
  rule_name: 'Multiple failed SSH logins followed by successful auth',
  severity: 'high',
  timestamp: NOW.toISOString(),
  raw_log: `sshd[1234]: Accepted password for root from 185.220.101.5 ${MARKER}`,
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

beforeEach(() => {
  live = assemble();
  invalidate();
});

describe('replaying a case whose alert the console holds', () => {
  it('re-injects the REAL alert, field for field', async () => {
    await live.engine.start('01-ingestion', ALERT, ALERT.alert_id);

    const r = await call('POST', '/api/replay', { alert_id: 'RP-1' });

    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    // A DERIVED id, because re-posting the same one would be deduplicated.
    expect(r.json.alert_id).not.toBe('RP-1');
    expect(r.json.source_alert_id).toBe('RP-1');

    // WHAT THE ENGINE ACTUALLY RECEIVED, read back out of the journal. The
    // route's own sentence would say "replayed" either way.
    const runs = await live.store.recentRuns({ limit: 50 });
    const replayed = runs.find(
      (run) => run.workflowId === '01-ingestion' && run.alertId === r.json.alert_id,
    );
    expect(replayed).toBeDefined();
    const input = replayed!.input as Record<string, unknown>;
    expect(input.rule_name).toBe(ALERT.rule_name);
    expect(input.raw_log).toBe(ALERT.raw_log);
    expect(input.severity).toBe('high');
    expect(input.source_ip).toBe('185.220.101.5');
  });

  it('accepts it, so the replay produced a case and not a rejection', async () => {
    await live.engine.start('01-ingestion', ALERT, ALERT.alert_id);

    const r = await call('POST', '/api/replay', { alert_id: 'RP-1' });

    // 202 is the pipeline's own acceptance — the entry point's verdict, read
    // back rather than assumed. A payload arriving short of its required
    // fields would be a 400 here.
    expect(r.json.status).toBe(202);
  });

  it('never sent that alert to the browser in the first place', async () => {
    await live.engine.start('01-ingestion', ALERT, ALERT.alert_id);

    const snap = await call('GET', '/api/snapshot');
    const chain = snap.json.trace.chains.find((c: any) => c.alert_id === 'RP-1');

    expect(chain.replayable).toBe(true);
    // The whole answer, as the browser receives it: the raw log is on the
    // case, once, and nowhere in the trace.
    expect(JSON.stringify(snap.json.trace)).not.toContain(MARKER);
    expect(JSON.stringify(snap.json).split(MARKER).length - 1).toBe(1);
  });
});

describe('replaying a case whose alert the console does not hold', () => {
  it('refuses rather than replaying an alert reconstructed from memory', async () => {
    // Straight into 02: a chain exists, the webhook's own payload does not.
    await live.engine.start('02-enrichment', {
      alert: { alert_id: 'RP-2', rule_name: 'r', severity: 'low', raw_log: 'l' },
    }, 'RP-2');

    const r = await call('POST', '/api/replay', { alert_id: 'RP-2' });

    expect(r.status).toBe(409);
    expect(r.json.ok).toBe(false);
    expect(String(r.json.error)).toMatch(/RP-2/);
  });

  it('answers 404 for a case that is not in the window at all', async () => {
    const r = await call('POST', '/api/replay', { alert_id: 'nobody' });

    expect(r.status).toBe(404);
    expect(r.json.ok).toBe(false);
  });
});
