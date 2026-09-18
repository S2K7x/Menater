/**
 * The original alert stays on the server, and the Tracking tab gets a boolean.
 *
 * ============================================================================
 * WHAT THIS PINS, AND WHY IT IS NOT COSMETIC
 *
 * `trace.chains[].payload` carried the five fields of the alert as the webhook
 * received it — `source_ip`, `dest_ip`, `rule_name`, `severity`, `raw_log` —
 * all the way to the browser. The browser's ONLY use of it was
 * `if (!chain.payload)`, to decide whether to offer the replay button;
 * `POST /api/replay` re-reads the payload SERVER-side out of its own snapshot,
 * so the five fields never needed to make the trip.
 *
 * `raw_log` dominates it, which makes this a second copy of ATTACKER-COMPOSED
 * TEXT on the wire, for nothing — the case already carries it.
 *
 * Two guarantees have to hold together, and either one alone is a defect:
 *
 *   - what LEAVES the server says only whether a replay is possible;
 *   - what the replay route READS is still the real payload, so a replay
 *     replays the alert that arrived rather than one reconstructed from
 *     memory. Dropping the second half would turn a size saving into the
 *     invented-default this product refuses everywhere.
 *
 * So this file writes no fixture: it runs the real workflows through the real
 * engine, hands the runs to `buildCases`, and reads the answer off the
 * SERIALISED trace — the bytes a browser would actually receive.
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
import { buildCases, replayPayload } from './cases.ts';
import { DEFAULT_LOCALE } from '../i18n.ts';
import type { RunRecord, StepRecord } from './types.ts';

const NOW = new Date('2026-09-18T10:00:00.000Z');

/** The whole pipeline; only the database, the model and the network are stubbed. */
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

async function collect(store: MemoryRunStore) {
  const runs: RunRecord[] = await store.recentRuns({ limit: 200 });
  const steps: Map<string, StepRecord[]> = await store.stepsOfMany(runs.map((r) => r.id));
  return buildCases(runs, steps, { limit: 200, locale: DEFAULT_LOCALE, now: () => NOW });
}

/**
 * A raw log with a string nothing else in the pipeline can produce, so
 * counting its occurrences in the serialised trace counts COPIES of the alert
 * and never a coincidence.
 */
const MARKER = 'RAWLOGMARKER-8f3a1c';
const ALERT = {
  alert_id: 'TP-1',
  rule_name: 'Multiple failed SSH logins followed by successful auth',
  severity: 'high',
  timestamp: NOW.toISOString(),
  raw_log: `sshd[1234]: Accepted password for root from 185.220.101.5 ${MARKER}`,
  source_ip: '185.220.101.5',
  host: 'web-01',
};

/** How many times a string occurs in some serialised value. */
function occurrences(value: unknown, needle: string): number {
  return JSON.stringify(value).split(needle).length - 1;
}

describe('what the trace sends to the browser', () => {
  it('does not carry the original alert, only whether it can be replayed', async () => {
    const { engine, store } = assemble();
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { trace } = await collect(store);

    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].replayable).toBe(true);
    // THE BYTES, not the object: a field left on the chain under another name
    // would still be on the wire.
    expect(Object.keys(trace.chains[0])).not.toContain('payload');
    expect(occurrences(trace.chains, MARKER)).toBe(0);
  });

  /**
   * The duplication this removes. The case has always carried `raw_log` — the
   * incident card shows it — so the chain's copy was the SECOND, and gzip
   * cannot collapse it: the two sat tens of kilobytes apart, far outside
   * DEFLATE's 32 KiB window.
   */
  it('leaves exactly one copy of the attacker-composed log in the snapshot', async () => {
    const { engine, store } = assemble();
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { cases, trace } = await collect(store);

    expect(occurrences(cases, MARKER)).toBe(1);
    expect(occurrences({ cases, trace }, MARKER)).toBe(1);
  });

  it('says a chain that never went through ingestion cannot be replayed', async () => {
    const { engine, store } = assemble();
    // Straight into 02: a chain exists, and the console never saw the alert
    // the webhook received.
    await engine.start('02-enrichment', {
      alert: { alert_id: 'TP-2', rule_name: 'r', severity: 'low', raw_log: 'l' },
    }, 'TP-2');
    const { trace } = await collect(store);

    const chain = trace.chains.find((c) => c.alert_id === 'TP-2');
    expect(chain).toBeDefined();
    expect(chain!.replayable).toBe(false);
  });
});

describe('what the replay route still reads', () => {
  it('holds the real payload server-side, field for field', async () => {
    const { engine, store } = assemble();
    await engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const { trace } = await collect(store);

    const payload = replayPayload(trace, 'TP-1');
    expect(payload).not.toBeNull();
    expect(payload!.rule_name).toBe(ALERT.rule_name);
    expect(payload!.raw_log).toBe(ALERT.raw_log);
    expect(payload!.severity).toBe('high');
    expect(payload!.source_ip).toBe('185.220.101.5');
    // ABSENT STAYS ABSENT. This alert carries no destination — most real
    // detections do not — and what is kept has to be what the webhook
    // received, because it is fed back into the pipeline on a replay. It used
    // to be stored as the display em dash, which the entry point's own
    // validator rejects as `invalid_dest_ip`: present-and-nonsense, which is
    // exactly the mapping bug that check exists to catch.
    expect(payload!.dest_ip).toBeNull();
  });

  /**
   * The five fields have to be VALID INPUT, not a card's worth of display
   * strings. `source_ip` took the same em dash and would refuse the same way
   * on an alert that carries no source address.
   */
  it('keeps an absent source address absent too', async () => {
    const { engine, store } = assemble();
    const { source_ip, ...noSource } = ALERT;
    await engine.start('01-ingestion', { ...noSource, source: 'generic' }, ALERT.alert_id);
    const { trace } = await collect(store);

    expect(replayPayload(trace, 'TP-1')!.source_ip).toBeNull();
  });

  it('answers null for a chain it never saw the alert of, so the route refuses', async () => {
    const { engine, store } = assemble();
    await engine.start('02-enrichment', {
      alert: { alert_id: 'TP-2', rule_name: 'r', severity: 'low', raw_log: 'l' },
    }, 'TP-2');
    const { trace } = await collect(store);

    expect(replayPayload(trace, 'TP-2')).toBeNull();
    expect(replayPayload(trace, 'no-such-alert')).toBeNull();
  });

  /**
   * THE PAYLOADS BELONG TO ONE TRACE, and that is the safety argument rather
   * than a detail: they are held against the object `buildCases` returned, so
   * a snapshot that has been rebuilt cannot be answered out of the previous
   * one's alerts, and they are collected with it instead of living for the
   * process's lifetime.
   */
  it('does not answer one trace out of another trace payloads', async () => {
    const a = assemble();
    await a.engine.start('01-ingestion', { ...ALERT, source: 'generic' }, ALERT.alert_id);
    const first = await collect(a.store);

    const b = assemble();
    const second = await collect(b.store);

    expect(replayPayload(first.trace, 'TP-1')).not.toBeNull();
    expect(replayPayload(second.trace, 'TP-1')).toBeNull();
  });
});
