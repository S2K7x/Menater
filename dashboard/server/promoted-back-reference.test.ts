/**
 * J0.5 — the report finds the case its own button opened.
 *
 * ============================================================================
 * WHY THIS TEST IS ON THE SERVER SIDE, AND THE LONG WAY ROUND
 *
 * The thing under test is a BROWSER module (`src/lib/promoted.ts`), and it
 * could be driven from a hand-written `AlertCase`. That fixture would prove
 * nothing. `cases.ts` read three node output fields under names the engine
 * does not write, for their whole life, because the reader and the fixtures
 * were written from the same memory as each other — which is why
 * `pipeline-to-case.test.ts` exists and why J0.1's own back-reference test
 * drives the real workflows.
 *
 * So this promotes a finding through the REAL `01-Ingestion`, reads the
 * journal the engine wrote with the projection `snapshot.ts` passes, hands it
 * to the REAL `buildCases`, resolves the repository the way `withRepositories`
 * does — and only then asks the browser's reader whether it recognises the
 * case. The harness is the one `findings.test.ts` already uses, for the same
 * reason.
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
import { injectAlert } from './injection.ts';
import { findingToAlert, scanRepository } from './findings.ts';
import { buildCases, CASE_INPUTS, CASE_OUTPUTS } from './engine/cases.ts';
import { DEFAULT_LOCALE } from './i18n.ts';
import { findingIdentityKey } from '../src/lib/finding-identity.ts';
import { promotedIndex } from '../src/lib/promoted.ts';
import type { RunRecord, StepRecord } from './engine/types.ts';
import type { AlertCase } from '../src/lib/types.ts';

const NOW = new Date('2026-10-19T02:00:00.000Z');

/** A finding as `ReportView` holds it — the shape the browser would send. */
function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: 'critical',
    report_level: 'critical',
    vulnerability: 'IDOR',
    route: '/orders/:id',
    http_method: 'GET',
    file: 'src/routes/orders.ts',
    line: 42,
    claude_verdict: 'confirmed',
    claude_reasoning: 'The handler reads the id straight off the params.',
    technical_summary: 'No ownership check between the lookup and the response.',
    plain_language_summary: 'Anyone logged in can read anyone else’s order.',
    suggested_fix_direction: 'Scope the query to the authenticated user.',
    owasp_category: 'A01:2021 Broken Access Control',
    evidence: 'code',
    local_confidence_score: 0.82,
    detected_by: ['idor-scanner', 'idor-llm'],
    code_excerpt: null,
    ...over,
  };
}

/** The four fields the report would look the finding up by. */
function identityOf(over: Record<string, unknown> = {}) {
  const f = finding(over);
  return {
    vulnerability: String(f.vulnerability),
    http_method: String(f.http_method),
    route: String(f.route),
    file: String(f.file),
  };
}

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
    // No model key: the fail-safe verdict, which is the state a fresh install
    // and this environment are both actually in.
    secret: () => undefined,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
      if (sql.includes('INSERT INTO soc_audit_log')) {
        return [{
          id: '4242', alert_id: 'x', prev_hash: 'aaaa', integrity_hash: 'bbbb',
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
  return { engine, store };
}

/**
 * The window the browser receives: the journal, the real case builder, and the
 * repository resolution `withRepositories` performs on every rebuild. The
 * inventory half of that line cannot answer here — a promoted alert carries no
 * host — so `scanRepository` is the only resolver with anything to say.
 */
async function windowOf(store: MemoryRunStore): Promise<AlertCase[]> {
  const runs: RunRecord[] = await store.recentRuns({ limit: 200, inputOf: CASE_INPUTS });
  const steps: Map<string, StepRecord[]> = await store.stepsOfMany(
    runs.map((r) => r.id),
    { outputsOf: CASE_OUTPUTS },
  );
  const { cases } = buildCases(runs, steps, { limit: 200, locale: DEFAULT_LOCALE, now: () => NOW });
  return cases.map((c) => {
    const repository = scanRepository(c);
    return repository === null ? c : { ...c, repository };
  });
}

/** Promotes one finding of one scan through the pipeline, and returns the window. */
async function promoted(over: Record<string, unknown> = {}, scanRunId = 'scan-001') {
  const { engine, store } = assemble();
  const mapped = findingToAlert(
    { scan_run_id: scanRunId, target: 'acme/api', finding: finding(over) },
    NOW,
  );
  if (!mapped.ok) throw new Error(`mapping failed: ${mapped.errors.join('; ')}`);

  const result = await injectAlert(
    engine, { ...mapped.alert, source: 'vulnpipe' }, mapped.alert_id, () => {},
  );
  if (!result.ok) throw new Error(`the pipeline refused the promotion: ${result.detail}`);

  return { cases: await windowOf(store), alertId: mapped.alert_id };
}

describe('a promotion the report can find again', () => {
  it('is recognised on the case the REAL pipeline and case builder produce', async () => {
    const { cases, alertId } = await promoted();

    const found = promotedIndex(cases, 'scan-001').get(findingIdentityKey(identityOf()));

    expect(found).toEqual({
      alert_id: alertId,
      // Shadow mode and no model key: the alert is handled and closed. The
      // value is asserted rather than copied off the case, because what the
      // report prints is this word, through `queue.states`.
      state: 'closed',
      received_at: NOW.toISOString(),
    });
  });

  /**
   * The identity rule J0.1 chose, read from the report's side. The scan run is
   * part of the alert's id precisely so a flaw regressed next month can be
   * triaged again — so a NEW scan's report must show its findings as fresh,
   * not as already handled six months ago.
   */
  it('belongs to its own scan, so a later scan of the same flaw starts clean', async () => {
    const { cases } = await promoted();

    expect(promotedIndex(cases, 'scan-002').size).toBe(0);
  });

  it('does not answer for a different flaw of the same scan', async () => {
    const { cases } = await promoted();
    const index = promotedIndex(cases, 'scan-001');

    expect(index.get(findingIdentityKey(identityOf({ route: '/invoices/:id' })))).toBeUndefined();
    expect(index.get(findingIdentityKey(identityOf({ vulnerability: 'SQLI' })))).toBeUndefined();
    expect(index.get(findingIdentityKey(identityOf({ http_method: 'POST' })))).toBeUndefined();
    expect(index.get(findingIdentityKey(identityOf({ file: 'src/other.ts' })))).toBeUndefined();
  });

  /**
   * THE LINE NUMBER IS NOT PART OF THE IDENTITY, on either side. It comes from
   * the model and moves whenever a line is added above it, so a report read
   * after an edit must still recognise its own promotion.
   */
  it('still recognises the finding after the line it sits on has moved', async () => {
    const { cases, alertId } = await promoted({ line: 42 });

    expect(promotedIndex(cases, 'scan-001').get(findingIdentityKey(identityOf({ line: 900 })))
      ?.alert_id).toBe(alertId);
  });

  /**
   * WHY THE KEY IS SHARED RATHER THAN SPELLED TWICE. The writer stores a field
   * trimmed and cut at 2,000 characters; the report holds the raw one. Compared
   * as they are, a long route would silently stop matching the case it opened —
   * and nothing would fail, because the only thing lost is a sentence.
   */
  it('matches a finding whose route was long enough for the writer to clip it', async () => {
    const route = `/orders/${'x'.repeat(4000)}`;
    const { cases, alertId } = await promoted({ route });

    expect(promotedIndex(cases, 'scan-001').get(findingIdentityKey(identityOf({ route })))
      ?.alert_id).toBe(alertId);
  });

  it('matches a finding whose fields the report holds with stray whitespace', async () => {
    const { cases, alertId } = await promoted();

    expect(promotedIndex(cases, 'scan-001')
      .get(findingIdentityKey(identityOf({ route: '  /orders/:id  ' })))?.alert_id).toBe(alertId);
  });
});

describe('what it refuses to claim', () => {
  it('says nothing when the report has no scan run to ask about', async () => {
    const { cases } = await promoted();

    expect(promotedIndex(cases, null).size).toBe(0);
    expect(promotedIndex(cases, '   ').size).toBe(0);
  });

  /**
   * `extensions` is an open bag, so a log source can put a `vulnpipe` key in
   * it. The integrity comes from the server's stamp: `matched_on:
   * 'scan_target'` is only written when `scanRepository` recomputed the alert
   * id from that bag and it matched.
   *
   * Both halves are driven here. A real bag pasted onto somebody else's alert
   * keeps a `repository` of `null` — so this reader never sees it — and a bag
   * whose identity was rewritten under the id derived from the original one
   * fails the same check.
   */
  it('ignores a vulnpipe bag the alert id was not derived from', async () => {
    const { cases, alertId } = await promoted();
    const real = cases.find((c) => c.alert_id === alertId);
    if (!real) throw new Error('the promotion produced no case');
    const bag = (real.extensions as Record<string, unknown>).vulnpipe as Record<string, unknown>;

    const forged: AlertCase[] = [
      // The real bag, on an alert from a log source.
      { ...real, alert_id: 'wazuh-1', extensions: { vulnpipe: bag },
        repository: scanRepository({ alert_id: 'wazuh-1', extensions: { vulnpipe: bag } }) },
      // The right id, a rewritten flaw.
      { ...real,
        extensions: { vulnpipe: { ...bag, file: 'src/payroll.ts' } },
        repository: scanRepository({
          alert_id: alertId, extensions: { vulnpipe: { ...bag, file: 'src/payroll.ts' } },
        }) },
    ];

    expect(promotedIndex(forged, 'scan-001').size).toBe(0);
  });

  /**
   * An ordinary alert the service inventory DID resolve is not a promotion.
   * `matched_on` is the discriminator and not the mere presence of a
   * repository — otherwise every machine the inventory maps would be read as
   * having had findings promoted out of it.
   */
  it('ignores a case whose repository came from the service inventory', async () => {
    const { cases, alertId } = await promoted();
    const real = cases.find((c) => c.alert_id === alertId);
    if (!real) throw new Error('the promotion produced no case');

    const fromInventory: AlertCase = {
      ...real,
      repository: {
        service: 'orders', repository: 'acme/api',
        matched_on: 'host', matched_value: 'scan-001',
      },
    };

    expect(promotedIndex([fromInventory], 'scan-001').size).toBe(0);
  });
});
