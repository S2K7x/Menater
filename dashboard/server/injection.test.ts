/**
 * What the console's two injection buttons report, against the REAL pipeline.
 *
 * ============================================================================
 * WHY THIS RUNS THE ACTUAL WORKFLOW
 *
 * The question is not "does `injectAlert` map 400 to `ok: false`" — that is a
 * `switch` nobody gets wrong. The question is whether the pipeline, run for
 * real, actually reaches `respond-400` on the scenario the console ships for
 * exactly that purpose, and whether the reason it wrote is the reason we show.
 * A fixture of `{ status: 400 }` would prove the mapping and nothing about the
 * path, which is where the previous defect lived: the answer existed, and the
 * caller never asked for it.
 *
 * So this assembles the engine on an in-memory store, registers the real
 * workflows, and injects the real `SCENARIOS`. Only the outside is stubbed —
 * the database, the model, the network.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { Engine } from './engine/engine.ts';
import { MemoryRunStore } from './engine/store.ts';
import { buildRegistry } from './engine/transforms/registry.ts';
import { pureHandlers } from './engine/nodes/pure.ts';
import { ioHandlers } from './engine/nodes/io.ts';
import { controlHandlers } from './engine/nodes/control.ts';
import { PIPELINE_WORKFLOWS } from './engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './engine/workflows/routing.ts';
import { answerDetail, injectAlert } from './injection.ts';
import { scenarioById } from './scenarios.ts';
import { DEFAULT_LOCALE, messages } from './i18n.ts';

const NOW = new Date('2026-09-09T03:00:00.000Z');

/** The whole pipeline, with the database, the model and the network stubbed. */
function assemble(opts: { dedup?: boolean } = {}) {
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
    // No model key: the pipeline takes its fail-safe verdict, which is the
    // state this environment — and a fresh install — is actually in.
    secret: () => undefined,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: opts.dedup === true }];
      if (sql.includes('INSERT INTO soc_audit_log')) {
        return [{
          id: '4242',
          alert_id: 'x',
          prev_hash: 'aaaa',
          integrity_hash: 'bbbb',
          event_time: NOW.toISOString(),
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
  return engine;
}

/** A scenario, built as `/api/simulate` builds it. */
function scenario(id: string) {
  const sc = scenarioById(id);
  if (!sc) throw new Error(`unknown scenario ${id}`);
  return sc.build(NOW.toISOString(), 1) as Record<string, unknown>;
}

describe('an alert the pipeline REFUSES is not reported as injected', () => {
  it('reports the 400 and the reason, for the scenario that exists to be rejected', async () => {
    const engine = assemble();
    const alert = scenario('malformed');

    const result = await injectAlert(
      engine,
      { ...alert, source: 'simulator' },
      String(alert.alert_id),
    );

    // The pipeline rejected it. Anything else on this line is the console
    // telling an operator their test alert arrived when it did not.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    // And it says WHY. `severity: 'catastrophic'` is the whole point of the
    // scenario; a bare "rejected" would leave the operator to guess.
    expect(result.detail).toContain('invalid_severity');
    expect(result.detail).toContain('critical');
  });

  it('reports a duplicate as not accepted, and says the alert was already seen', async () => {
    const engine = assemble({ dedup: true });
    const alert = scenario('burst');

    const result = await injectAlert(
      engine,
      { ...alert, source: 'simulator' },
      String(alert.alert_id),
    );

    // 200 is the pipeline saying "already seen": no new chain was started, so
    // reporting an injection would send someone looking for a run that the
    // deduplication deliberately did not create.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.detail).toBe('duplicate, skipped');
  });
});

describe('an alert the pipeline ACCEPTS is reported as accepted', () => {
  it('answers 202 and names the run, on the reference scenario', async () => {
    const engine = assemble();
    const alert = scenario('brute-force');

    const result = await injectAlert(
      engine,
      { ...alert, source: 'simulator' },
      String(alert.alert_id),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(result.run_id).toBeTruthy();
    // Shadow mode with no model key: the chain still settles rather than
    // hanging, which is what makes 202 an honest answer here.
    expect(result.run_status).toBe('done');
  });

  it('accepts the shape most real detections have — no destination address', async () => {
    const engine = assemble();
    const alert = scenario('no-target');

    const result = await injectAlert(
      engine,
      { ...alert, source: 'simulator' },
      String(alert.alert_id),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
  });
});

describe('the reason is read from what the pipeline wrote, never invented', () => {
  it('joins the validation errors, which is what a sender has to fix', () => {
    expect(answerDetail({
      status: 'rejected',
      reason: 'schema_validation_failed',
      errors: ['missing_required_fields: raw_log', 'invalid_timestamp: not ISO-8601 parseable'],
    })).toBe('missing_required_fields: raw_log; invalid_timestamp: not ISO-8601 parseable');
  });

  it('never shows the pipeline identifier when there is nothing else to say', () => {
    // `reason` is a pipeline identifier and this console shows none raw. With
    // no errors and no detail, the short status word is the answer.
    expect(answerDetail({ status: 'error', reason: 'dedup_store_unavailable' })).toBe('error');
    expect(answerDetail({ reason: 'dedup_store_unavailable' })).toBeNull();
  });

  it('prefers the database message over the status word when there is one', () => {
    expect(answerDetail({ status: 'error', detail: 'connection refused' })).toBe('connection refused');
  });

  it('returns null rather than a placeholder for a body it cannot read', () => {
    expect(answerDetail(null)).toBeNull();
    expect(answerDetail('nope')).toBeNull();
    expect(answerDetail({ errors: [] })).toBeNull();
  });
});

describe('the sentence an operator reads carries the reason the pipeline wrote', () => {
  const am = messages(DEFAULT_LOCALE).api;

  it('names the status and the reason on a rejection', () => {
    const text = am.simulateRefused(
      'Malformed (rejected on purpose)', 400,
      'invalid_severity: expected one of low|medium|high|critical',
    );
    expect(text).toContain('400');
    expect(text).toContain('invalid_severity');
    expect(text).not.toMatch(/injected/i);
  });

  it('does not word a duplicate as a breakage, on either button', () => {
    // The `burst` scenario and a `same_id` replay both exist to SHOW
    // deduplication working. Saying "not accepted" over a red banner would
    // read as a fault on the one outcome those two controls are for.
    expect(am.simulateRefused('Same alert twice (deduplication)', 200, 'duplicate, skipped'))
      .toContain('no second chain was started');
    expect(am.replayRefused(200, 'duplicate, skipped')).toContain('nothing was replayed');
  });

  it('says a reason was not recorded rather than leaving a dangling sentence', () => {
    expect(am.simulateRefused('Brute force', 500, null)).toContain('no reason recorded');
    expect(am.replayRefused(500, null)).toContain('no reason recorded');
  });

  it('never claims an HTTP status the pipeline did not choose', () => {
    // `0` is "the run reached no `respond` node". Printing it as a status
    // would be inventing one; the sentence says what happened instead.
    expect(am.simulateRefused('Brute force', 0, 'node "validate" failed'))
      .toMatch(/reached no answer/i);
    expect(am.replayRefused(0, null)).toMatch(/reached no answer/i);
  });
});
