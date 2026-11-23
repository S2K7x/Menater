/**
 * J0.8 — the operator's table names the code a promoted flaw came out of.
 *
 * ============================================================================
 * WHAT WAS MEASURED BEFORE ANY OF THIS WAS WRITTEN
 *
 * On an install whose service inventory maps `Billing API` to
 * `/srv/src/billing-api` and the machine `web-01`, driving the real pipeline
 * for one detection about that machine and one finding promoted out of a scan
 * of that very repository:
 *
 *   wazuh-7001    {"service":"Billing API", … ,"matched_on":"host"}
 *   vulnpipe-f81…  {"service":null,          … ,"matched_on":"scan_target"}
 *
 *   groupBySystem over the flaw alone → label "/srv/src/billing-api", services []
 *   search_alerts("billing api")      → 1 hit of 2
 *
 * So the console named the service on the detection and refused to name it on
 * the one case whose whole origin IS that code — and the tool whose own
 * description says *« use when the operator names a machine, an address, a
 * SERVICE »* could not find it that way.
 *
 * ============================================================================
 * WHY IT WAS `null`, AND WHY THAT PREMISE WAS WRONG
 *
 * `scanRepository`'s comment said the inventory *« is keyed on machines, which
 * this alert has none of »*. That is true of the inventory's INDEX — J0.3
 * builds one on the identifiers, because its question is *which repository
 * runs on this machine* — and false of its DATA: every entry also stores a
 * repository, so the table reads the other way round with no observable at
 * all. The same family as the guard that was right until a second thing could
 * answer, and as an invariant proved from a neighbouring constant.
 *
 * ============================================================================
 * THE CLAIMS THAT PASS BEFORE AND AFTER ARE THE POINT OF THIS FILE
 *
 * Naming the code must move no trust boundary. `extensions.vulnpipe.target` is
 * an open bag that `findingAlertId` does not cover (ROADMAP § 7), so what a
 * crafted bag can do is SELECT an entry — the string that comes back is the
 * operator's own either way. `matched_on` therefore stays `scan_target`,
 * `INVENTORY_MATCHES` goes on excluding the case, J0.7's count goes on
 * refusing it, and `repository` is still the string the bag carried. Four
 * tests here claim that side and are green before this change as much as
 * after; a mutation that promotes the case to an inventory match is red on
 * them.
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
import { findingToAlert } from './findings.ts';
import { declaredService } from './inventory.ts';
import { repositoryOf } from './snapshot.ts';
import { buildCases, CASE_INPUTS, CASE_OUTPUTS } from './engine/cases.ts';
import { DEFAULT_LOCALE } from './i18n.ts';
import { codeIncidents, groupBySystem } from '../src/lib/systems.ts';
import { INVENTORY_MATCHES } from '../src/lib/types.ts';
import type { RunRecord, StepRecord } from './engine/types.ts';
import type { AlertCase, InventoryEntry } from '../src/lib/types.ts';

const NOW = new Date('2026-11-23T02:00:00.000Z');
const SERVICE = 'Billing API';
const TARGET = '/srv/src/billing-api';
const MACHINE = 'web-01';

const entry = (over: Partial<InventoryEntry> = {}): InventoryEntry => ({
  service: SERVICE, identifiers: [MACHINE], repository: TARGET, ...over,
});

/** The inventory an install that has filled the table in actually holds. */
const INVENTORY: InventoryEntry[] = [entry()];

function assemble() {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', true], ['approval.timeoutMinutes', 30],
    ['isolation.ttlMinutes', 60], ['shadow.exitThreshold', 50],
    ['notify.minSeverity', 'off'], ['endpoint.isolation', ''], ['endpoint.ticket', ''],
    ['errors.windowMinutes', 60], ['errors.systemicThreshold', 5],
    ['errors.suppressMinutes', 30], ['llm.model', 'test/model'],
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
 * The window the browser receives.
 *
 * The journal, the REAL case builder with the projection `snapshot.ts` passes,
 * and `repositoryOf` — the funnel's own line, exported for this rather than
 * re-typed here. A test that spells the resolution itself vouches for its own
 * copy of it, which is the defect `pipeline-to-case.test.ts` exists to end.
 */
async function windowOf(
  store: MemoryRunStore, entries: InventoryEntry[] = INVENTORY,
): Promise<AlertCase[]> {
  const runs: RunRecord[] = await store.recentRuns({ limit: 200, inputOf: CASE_INPUTS });
  const steps: Map<string, StepRecord[]> = await store.stepsOfMany(
    runs.map((r) => r.id), { outputsOf: CASE_OUTPUTS },
  );
  const { cases } = buildCases(runs, steps, { limit: 200, locale: DEFAULT_LOCALE, now: () => NOW });
  return cases.map((c) => {
    const repository = repositoryOf(c, entries);
    return repository === null ? c : { ...c, repository };
  });
}

/** One finding, promoted out of a scan of `target`, through the real pipeline. */
async function promote(target: string | null = TARGET, scanRunId = 'scan-001') {
  const { engine, store } = assemble();
  const mapped = findingToAlert({
    scan_run_id: scanRunId,
    target,
    finding: {
      severity: 'critical', report_level: 'critical', vulnerability: 'IDOR',
      route: '/orders/:id', http_method: 'GET', file: 'src/routes/orders.ts', line: 42,
      plain_language_summary: 'Anyone logged in can read anyone else’s order.',
      suggested_fix_direction: 'Scope the query to the authenticated user.',
      code_excerpt: null, detected_by: [],
    },
  }, NOW);
  if (!mapped.ok) throw new Error(`mapping failed: ${mapped.errors.join('; ')}`);

  const result = await injectAlert(
    engine, { ...mapped.alert, source: 'vulnpipe' }, mapped.alert_id, () => {},
  );
  if (!result.ok) throw new Error(`the pipeline refused the promotion: ${result.detail}`);
  return { store, alertId: mapped.alert_id };
}

/** The one promoted case of a window, as the console would render it. */
const flawOf = (cases: AlertCase[]) =>
  cases.find((c) => c.repository?.matched_on === 'scan_target')!;

describe('the inventory names the code a promoted flaw came out of', () => {
  it('carries the operator’s own service name onto the case', async () => {
    const { store } = await promote();

    expect(flawOf(await windowOf(store)).repository).toEqual({
      service: SERVICE,
      repository: TARGET,
      matched_on: 'scan_target',
      matched_value: 'scan-001',
    });
  });

  /**
   * The By-system view's heading. Before this, a system whose cases are all
   * promoted flaws — the state of an install that has scanned its code and not
   * yet been attacked — was titled by the raw repository path, in the register
   * `soc-sys-name-literal` keeps for a value nobody named.
   */
  it('gives the By-system block a name instead of a path', async () => {
    const { store } = await promote();
    const cases = await windowOf(store);

    const { systems } = groupBySystem([flawOf(cases)]);

    expect(systems).toHaveLength(1);
    expect(systems[0]!.label).toBe(SERVICE);
    expect(systems[0]!.services).toEqual([SERVICE]);
  });

  /**
   * The ordinary two-instance configuration: one service, two machines, two
   * rows. `normalizeInventory` refuses a duplicate IDENTIFIER and allows two
   * entries to point at one repository, so this shape is legal and common.
   */
  it('answers when two entries agree on the name', () => {
    const entries = [entry(), entry({ identifiers: ['web-02'] })];

    expect(declaredService(TARGET, entries)).toBe(SERVICE);
  });

  /**
   * And refuses when they disagree. The door cannot refuse this — two services
   * sharing a monorepo is legitimate — so the resolver does, rather than
   * picking the first, which is the tie-break `inventory.ts`'s header exists
   * to avoid. It is the name an incident card prints.
   */
  it('refuses to pick a name when two entries give the code two', () => {
    const entries = [entry(), entry({ service: 'Invoicing API', identifiers: ['web-02'] })];

    expect(declaredService(TARGET, entries)).toBeNull();
  });

  /** A third entry agreeing with the first must not un-refuse that. */
  it('stays refused once two names have disagreed', () => {
    const entries = [
      entry(),
      entry({ service: 'Invoicing API', identifiers: ['web-02'] }),
      entry({ identifiers: ['web-03'] }),
    ];

    expect(declaredService(TARGET, entries)).toBeNull();
  });

  /**
   * The comparison is the inventory's own and nothing more. A near-match is a
   * guess, and a guess puts a real service's name on code nobody declared.
   */
  it('matches the way the inventory matches, and no more', () => {
    expect(declaredService(`  ${TARGET.toUpperCase()}  `, INVENTORY)).toBe(SERVICE);

    for (const near of [
      `${TARGET}/`, `${TARGET}.git`, 'src/billing-api', `${TARGET}-staging`, '/srv/src', '',
    ]) {
      expect(declaredService(near, INVENTORY)).toBeNull();
    }
  });

  /** Exported and callable with any list, so neither half may be assumed. */
  it('names nothing from an entry that names nothing', () => {
    expect(declaredService(TARGET, [entry({ service: '' })])).toBeNull();
    expect(declaredService(TARGET, [entry({ service: '   ' })])).toBeNull();
    expect(declaredService('', [entry({ repository: '' })])).toBeNull();
    expect(declaredService(TARGET, [])).toBeNull();
  });

  /* =======================================================================
     THE BOUNDARY. Green before this change as much as after — on purpose.
     ======================================================================= */

  it('leaves the case a scan_target, so the trust boundary has not moved', async () => {
    const { store } = await promote();

    const r = flawOf(await windowOf(store)).repository!;

    expect(r.matched_on).toBe('scan_target');
    expect(INVENTORY_MATCHES.has(r.matched_on)).toBe(false);
  });

  /**
   * J0.7's count is built only out of cases the operator's own inventory
   * answered. Naming the code must not make a promoted finding one of those:
   * a crafted `target` would then put a fabricated incident at the top of a
   * report about code somebody had just typed.
   */
  it('is still refused by the scan report’s incident count', async () => {
    const { store } = await promote();

    expect(codeIncidents(await windowOf(store), TARGET)).toBeNull();
  });

  /**
   * `repository` is still the string the bag carried, unvalidated and
   * unsubstituted. ROADMAP § 7's *« a scan target nobody authenticated »* is
   * untouched by this change, and quietly swapping the operator's spelling
   * into the launcher prefill would be one of the three options that entry
   * leaves to a human.
   */
  it('does not substitute the operator’s spelling for the one that was scanned', async () => {
    const { store } = await promote('/SRV/SRC/Billing-API');

    expect(flawOf(await windowOf(store)).repository).toEqual({
      service: SERVICE,
      repository: '/SRV/SRC/Billing-API',
      matched_on: 'scan_target',
      matched_value: 'scan-001',
    });
  });

  it('says nothing about code the table does not declare', async () => {
    const { store } = await promote('acme/not-in-the-table');

    expect(flawOf(await windowOf(store)).repository).toEqual({
      service: null,
      repository: 'acme/not-in-the-table',
      matched_on: 'scan_target',
      matched_value: 'scan-001',
    });
  });

  it('says nothing on an install with no inventory at all', async () => {
    const { store } = await promote();

    expect(flawOf(await windowOf(store, [])).repository).toEqual({
      service: null,
      repository: TARGET,
      matched_on: 'scan_target',
      matched_value: 'scan-001',
    });
  });

  /**
   * And a detection is resolved exactly as J0.3 resolved it. `repositoryOf`
   * is one funnel for two origins, so the half that already worked has to be
   * claimed here or a mutation could take the inventory's own answer away.
   */
  it('still resolves a detection by its observable', async () => {
    const { engine, store } = assemble();
    const sent = await injectAlert(engine, {
      alert_id: 'wazuh-7001',
      rule_name: 'Scan: cross-site scripting and file upload probing',
      severity: 'high',
      timestamp: NOW.toISOString(),
      raw_log: 'nginx: GET /orders/1 probing',
      host: MACHINE,
      source: 'wazuh',
    }, 'wazuh-7001', () => {});
    if (!sent.ok) throw new Error(`the pipeline refused the alert: ${sent.detail}`);

    const detection = (await windowOf(store)).find((c) => c.alert_id === 'wazuh-7001')!;

    expect(detection.repository).toEqual({
      service: SERVICE,
      repository: TARGET,
      matched_on: 'host',
      matched_value: MACHINE,
    });
  });
});
