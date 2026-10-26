/**
 * The console's display dash, as the assistant's getters hand it to a model.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 *
 * `buildCases` mints `source_ip` and `dest_ip` as `'—'` when the detection
 * recorded none, and says why in as many words: *« `—` for the two addresses
 * is a DISPLAY value the console has always used for "not recorded"; `host`
 * stays a value or `null`, because it decides whether an isolation has a
 * target at all and a display dash must never travel as data. »* `AlertCase`
 * is the shape the browser renders, so that is right where it is written.
 *
 * `tools.ts` read it as data. Its own header, rule 2, states the defect:
 * *« NO TOOL INVENTS A FIELD. Absent observables come back `null` [...]
 * Handing the model an em dash or an empty string is how "this alert has no
 * destination address" becomes a confident sentence about an address that was
 * never observed. »* The rule was written at the top of the file that broke
 * it, and the guard exists twice elsewhere — `observable()` in
 * `server/inventory.ts` and `machineOf()` in `src/lib/systems.ts`, each with a
 * comment saying why. The one reader that hands the value to a MODEL had none.
 *
 * It is not a corner case: the alert contract says most real detections carry
 * no destination address, so `dest_ip` is `'—'` on the ordinary alert.
 *
 * ============================================================================
 * FOUR CONSEQUENCES, AND THEY ARE NOT THE SAME SIZE
 *
 *  1. `test_rule` INVERTS the operators that are about absence. It builds its
 *     dry-run alert with `source_ip: c.source_ip || null` and hands it to the
 *     real `evaluateRules`, whose own comment says *« ABSENT NEVER MATCHES
 *     [...] reading a missing `source_ip` as "empty, therefore equal to empty"
 *     [is a way] of inventing data »* — and `'—'` is neither `null` nor `''`,
 *     so it walks past that guard. Measured on an alert with no source
 *     address: `exists` true where the pipeline says false, `not_exists` false
 *     where the pipeline says true, `not_equals` true where the pipeline says
 *     false. Three of the nine operators, on the tool whose whole job is to
 *     answer *would my rule catch this* and *why was this closed without a
 *     decision* — so a team dry-runs a rule, is told the opposite of what the
 *     pipeline will do, and ships it.
 *
 *  2. `find_similar` MANUFACTURES relations, and the count is the ranking.
 *     `if (seed.dest_ip && c.dest_ip === seed.dest_ip)` is `'—' === '—'`, so
 *     any two alerts that recorded no destination "share" one. Measured on a
 *     four-case window seeded from a scheduled-task alert: 3 of 3 other cases
 *     came back similar, the two top-ranked on `['source_ip','dest_ip']`, and
 *     the strongest "match" was a promoted scan finding that names no machine
 *     at all. Zero of the three relations were real. `shared.length` is the
 *     sort key, so two alerts that recorded nothing outrank a pair sharing a
 *     real host — and the tool's own description offers it as the answer to
 *     *is this a one-off or a campaign?*
 *
 *  3. `absent_observables` DENIES an absence that is real. It is the one
 *     mechanism in that file built to stop the model guessing — *« a model
 *     that sees no `dest_ip` key cannot tell "the detection named none" from
 *     "the console did not send it", and it will pick whichever reads
 *     better »* — and `!c[k]` is false for `'—'`. Measured: `[]` on a
 *     detection with no destination, `['host']` on a promoted finding whose
 *     three observables are all absent.
 *
 *  4. The literal `'—'` reaches the model as an address VALUE, through
 *     `alertRow` (`list_alerts`, `search_alerts`, `get_attention`,
 *     `find_similar`, and `get_alert` via `alertDetail`) and through
 *     `find_similar`'s hand-built `seed`.
 *
 * ============================================================================
 * WHY THE LAST CLAIM IS A SUBTRACTION
 *
 * A test naming the fields it checks goes stale the day a reply gains one, and
 * it goes stale SILENTLY — the new field simply carries the dash, which is
 * exactly how this lasted. So the claim is inverted the way
 * `untrusted-host.test.ts` inverted its own: every tool is called, every
 * string of every reply is walked, and no string may BE the display value.
 * The next field that starts carrying an address is covered on the day it is
 * written.
 *
 * A subtraction needs a vacuity guard or it passes over a walk that found
 * nothing. So the window is asserted to hold the two shapes this is about —
 * an alert with no destination and an alert with no address at all — before
 * the subtraction is believed.
 *
 * ============================================================================
 * THE BOUNDARY, CLAIMED BY TESTS THAT PASS BEFORE AND AFTER
 *
 * The predicate is about the value THIS CONSOLE MINTS, not about censoring
 * input. `host` is left exactly as it was: `cases.ts` never writes a dash
 * there, so a `host` of `'—'` came out of a log and is somebody's chosen
 * string — reading it as absent would be the console discarding an
 * observable, which is the opposite mistake. A real address must still
 * travel, and a genuine shared host or source address must still relate two
 * alerts, or the fix would have traded a false positive for a false negative.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '../engine/engine.ts';
import { MemoryRunStore } from '../engine/store.ts';
import { buildRegistry } from '../engine/transforms/registry.ts';
import { pureHandlers } from '../engine/nodes/pure.ts';
import { ioHandlers } from '../engine/nodes/io.ts';
import { controlHandlers } from '../engine/nodes/control.ts';
import { PIPELINE_WORKFLOWS } from '../engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from '../engine/workflows/routing.ts';
import { RuleStore } from '../rules-store.ts';
import { evaluateRules, type Condition } from '../engine/transforms/tuning.ts';
import { newFence } from './sanitize.ts';

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-display-dash-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

const NOW = new Date('2026-10-26T03:00:00.000Z');

/** The console's display value for an address a detection did not record. */
const DASH = '—';

/**
 * Five alerts, chosen for the shapes this is about rather than for variety.
 *
 * `DASH-1` is the ORDINARY alert: a source address and no destination, which
 * the contract says is the common case. `DASH-2` and `DASH-3` recorded no
 * address at all and are about different machines — the pair that must not be
 * called related. `DASH-4` genuinely shares `DASH-1`'s host and source
 * address, and is what keeps the fix from being a false negative. `DASH-5`
 * carries the display character as its HOST, which is the boundary.
 *
 * They are all in the fixture rather than injected per test, because the
 * window is shared: a test that starts a run changes its neighbours' counts.
 */
const ALERTS = [
  {
    alert_id: 'DASH-1',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    severity: 'high',
    timestamp: NOW.toISOString(),
    raw_log: 'sshd[1234]: Accepted password for root from 185.220.101.5',
    source_ip: '185.220.101.5',
    host: 'web-01',
    source: 'generic',
  },
  {
    alert_id: 'DASH-2',
    rule_name: 'Scheduled task created on a domain controller',
    severity: 'medium',
    timestamp: NOW.toISOString(),
    raw_log: 'Security 4698: scheduled task created',
    host: 'dc-02',
    source: 'generic',
  },
  {
    alert_id: 'DASH-3',
    rule_name: 'Suspicious PowerShell encoded command',
    severity: 'low',
    timestamp: NOW.toISOString(),
    raw_log: 'powershell -enc SQBFAFgA',
    host: 'laptop-7',
    source: 'generic',
  },
  {
    alert_id: 'DASH-4',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    severity: 'high',
    timestamp: NOW.toISOString(),
    raw_log: 'sshd[9999]: Accepted password for admin from 185.220.101.5',
    source_ip: '185.220.101.5',
    host: 'web-01',
    source: 'generic',
  },
  // A host whose VALUE is the display character. `cases.ts` never writes one
  // there, so this came out of a log — see the boundary test.
  {
    alert_id: 'DASH-5',
    rule_name: 'Beacon to a known command and control address',
    severity: 'high',
    timestamp: NOW.toISOString(),
    raw_log: 'firewall: outbound 443 to 203.0.113.9',
    host: '\u2014',
    source: 'generic',
  },
];

/**
 * One rule per operator this is about, each on `source_ip`.
 *
 * `exists`, `not_exists` and `not_equals` are the three that ask about absence
 * — the ones a display dash inverts. `equals` is here as the control: it
 * agrees either way, which is what says the divergence is about absence and
 * not about the evaluator generally.
 */
const RULE_OPS: Array<{ op: Condition['op']; values: string[] }> = [
  { op: 'exists', values: [] },
  { op: 'not_exists', values: [] },
  { op: 'not_equals', values: ['10.0.0.1'] },
  { op: 'equals', values: ['10.0.0.1'] },
];

const ruleRow = (op: Condition['op'], values: string[], priority: number) => ({
  id: `r-${op}`,
  name: `source_ip ${op}`,
  enabled: true,
  priority,
  conditions: [{ field: 'source_ip', op, values }],
  action: 'auto_close',
  severity: null,
  owner: 'soc',
  reason: 'A dry run of the absence operators.',
  expires_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  match_count: 0,
  last_matched_at: null,
});

function assemble() {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', true],
    ['approval.timeoutMinutes', 45],
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

  const deps = {
    transforms: buildRegistry({
      now: () => NOW,
      resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
    }),
    vars: () => vars,
    now: () => NOW,
    // No model key: the run takes the fail-safe verdict, which is what an
    // install with no key does and is all this file needs — nothing here
    // depends on what a model answered.
    secret: () => undefined,
    newToken: () => 'approval-token',
    fetch: (async () => new Response('{"ok":true,"ts":"1"}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
      // No tuning rule runs in the PIPELINE: the rules below are the dry
      // run's subject, and letting one close an alert would empty the window.
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

let live = assemble();

/** A store holding whatever the current test put in it. */
const storeOf = (rows: unknown[]) => new RuleStore({
  query: async () => ({ rows }),
} as unknown as ConstructorParameters<typeof RuleStore>[0]);

const ALL_RULES = RULE_OPS.map((r, i) => ruleRow(r.op, r.values, 10 + i));

/**
 * What `getRuleStore()` answers. Swappable, because the per-operator test
 * needs the dry run to see ONE rule at a time: with all four loaded, first
 * match wins and three of them are never reached.
 */
let rules = storeOf(ALL_RULES);

vi.mock('../runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime.ts')>();
  return {
    ...actual,
    getEngine: () => live.engine,
    getEngineStore: () => live.store,
    getRuleStore: () => rules,
  };
});

const { TOOLS } = await import('./tools.ts');
const { invalidate, snapshot } = await import('../snapshot.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

beforeAll(async () => {
  live = assemble();
  invalidate();
  for (const alert of ALERTS) {
    await live.engine.start('01-ingestion', alert, alert.alert_id);
  }
  invalidate();
});

const tool = (name: string) => {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool "${name}"`);
  return found;
};

const call = async (name: string, args: Record<string, unknown> = {}) =>
  tool(name).run(args, { locale: 'en', fence: newFence() }) as Promise<Record<string, unknown>>;

/** Every string in a reply, with the path it sits at. */
function strings(value: unknown, path = ''): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => strings(v, path === '' ? k : `${path}.${k}`));
  }
  return [];
}

/**
 * The fourteen tools, each with arguments that actually return an alert — a
 * tool answering "alert_id is required" walks over nothing.
 */
const ARGS: Record<string, Record<string, unknown>> = {
  list_alerts: {},
  get_alert: { alert_id: 'DASH-2' },
  get_trace: { alert_id: 'DASH-2' },
  get_metrics: {},
  get_health: {},
  list_rules: {},
  search_alerts: { query: 'dash' },
  get_attention: {},
  explain_term: {},
  find_similar: { alert_id: 'DASH-2' },
  explain_verdict: { alert_id: 'DASH-2' },
  get_timeline: {},
  test_rule: { alert_id: 'DASH-2' },
  get_setup_state: {},
};

describe('an address the detection did not record', () => {
  /**
   * THE VACUITY GUARD, and it runs first on purpose.
   *
   * Everything below is satisfied by a window that did not build. These are
   * the two shapes the finding is about, read off the snapshot the tools read.
   */
  it('is a display dash on the CASE, on both of the shapes this is about', async () => {
    const snap = await snapshot('en');
    const byId = new Map(snap.cases.map((c) => [c.alert_id, c]));
    expect(snap.cases).toHaveLength(ALERTS.length);

    // The ordinary alert: an address was recorded, a destination was not.
    expect(byId.get('DASH-1')!.source_ip).toBe('185.220.101.5');
    expect(byId.get('DASH-1')!.dest_ip).toBe(DASH);
    // And one that recorded neither.
    expect(byId.get('DASH-2')!.source_ip).toBe(DASH);
    expect(byId.get('DASH-2')!.dest_ip).toBe(DASH);
    // `host` is never a dash — which is why the fix leaves it alone.
    expect(byId.get('DASH-2')!.host).toBe('dc-02');
  });

  /**
   * CONSEQUENCE 1, and the one that changes what a team ships.
   *
   * The claim is not "the dry run matches nothing" — it is that the dry run
   * and the pipeline AGREE. `evaluateRules` is called here on the alert as the
   * pipeline evaluated it, with the two addresses absent, and the tool must
   * reach the same rule.
   */
  it('makes the dry run agree with the pipeline, operator by operator', async () => {
    const snap = await snapshot('en');
    const kase = snap.cases.find((c) => c.alert_id === 'DASH-2')!;

    /** The alert as `01-Ingestion` received it: neither address was there. */
    const asIngested = {
      alert_id: kase.alert_id,
      rule_name: kase.rule_name,
      severity: kase.severity,
      source_ip: null,
      dest_ip: null,
      host: kase.host,
      raw_log: kase.raw_log,
    };

    const diverged: string[] = [];
    for (const { op, values } of RULE_OPS) {
      // One rule at a time: with all four loaded, first match wins and three
      // of them are never reached, so three quarters of the claim would be
      // vacuous.
      rules = storeOf([ruleRow(op, values, 10)]);
      const expected = evaluateRules(asIngested, await rules.list());
      const dryRun = await call('test_rule', { alert_id: 'DASH-2' });
      const matched = (dryRun.matched as { id: string } | null)?.id ?? null;

      if (matched !== (expected.rule?.id ?? null) || dryRun.action !== expected.action) {
        diverged.push(
          `source_ip ${op}: test_rule=${JSON.stringify(matched)} `
          + `pipeline=${JSON.stringify(expected.rule?.id ?? null)}`,
        );
      }
    }
    rules = storeOf(ALL_RULES);

    expect(diverged).toEqual([]);
  });

  /**
   * THE VACUITY GUARD for the rule above.
   *
   * It compares two answers, so it is satisfied by a pair that both say "no
   * rule matched" — which is what a `test_rule` returning an error would do.
   * These are the operators that MUST match an alert carrying no source
   * address, read off the pipeline's own side.
   */
  it('has absence operators that really do match an alert with no address', async () => {
    const snap = await snapshot('en');
    const kase = snap.cases.find((c) => c.alert_id === 'DASH-2')!;
    const asIngested = {
      alert_id: kase.alert_id, rule_name: kase.rule_name, severity: kase.severity,
      source_ip: null, dest_ip: null, host: kase.host, raw_log: kase.raw_log,
    };

    const verdicts = Object.fromEntries(await Promise.all(RULE_OPS.map(async ({ op, values }) => [
      op,
      evaluateRules(asIngested, await storeOf([ruleRow(op, values, 10)]).list()).rule?.id ?? null,
    ])));

    expect(verdicts).toEqual({
      exists: null,
      not_exists: 'r-not_exists',
      not_equals: null,
      equals: null,
    });
  });

  /**
   * CONSEQUENCE 2, measured on the pair that recorded nothing.
   *
   * `DASH-2` and `DASH-3` are about different machines, carry different
   * detections and recorded no address between them. There is nothing to
   * share, so they must not appear related — and `dest_ip` / `source_ip` must
   * not appear in any `shared_with_seed` on this window.
   */
  it('never relates two alerts by an observable neither of them recorded', async () => {
    const out = await call('find_similar', { alert_id: 'DASH-2' });
    const similar = out.similar as Array<{ alert_id: string; shared_with_seed: string[] }>;

    const shared = new Map(similar.map((s) => [s.alert_id, s.shared_with_seed]));
    expect(shared.get('DASH-3')).toBeUndefined();

    for (const row of similar) {
      expect(row.shared_with_seed).not.toContain('dest_ip');
      expect(row.shared_with_seed).not.toContain('source_ip');
    }
  });

  /**
   * THE BOUNDARY of consequence 2 — green before AND after, on purpose.
   *
   * `DASH-4` shares `DASH-1`'s host, source address and detection name. A fix
   * that stopped relating them would have traded a false positive for a false
   * negative, which is not a fix.
   */
  it('still relates two alerts that share a real host and a real address', async () => {
    const out = await call('find_similar', { alert_id: 'DASH-1' });
    const similar = out.similar as Array<{ alert_id: string; shared_with_seed: string[] }>;
    const four = similar.find((s) => s.alert_id === 'DASH-4');

    expect(four).toBeDefined();
    expect(four!.shared_with_seed).toContain('host');
    expect(four!.shared_with_seed).toContain('source_ip');
    expect(four!.shared_with_seed).toContain('rule_name');
  });

  /**
   * And the same pair must not ALSO be credited with the destination neither
   * of them recorded — the defect is additive, so a genuine relation carried
   * it too and made a three-way match look like a four-way one.
   */
  it('does not add an unrecorded destination to a genuine relation', async () => {
    const out = await call('find_similar', { alert_id: 'DASH-1' });
    const similar = out.similar as Array<{ alert_id: string; shared_with_seed: string[] }>;
    const four = similar.find((s) => s.alert_id === 'DASH-4')!;
    expect(four.shared_with_seed).not.toContain('dest_ip');
  });

  /**
   * CONSEQUENCE 3. The list must name every observable the detection did not
   * record — all three on an alert that carried none, and the destination on
   * the ordinary alert that carried a source address.
   */
  it('names every observable the detection did not record', async () => {
    // `DASH-2` recorded neither address; it DID name a host, so `host` is
    // correctly not in the list — which is what keeps this from passing on a
    // version that simply names all three.
    const none = await call('get_alert', { alert_id: 'DASH-2' });
    expect(none.absent_observables).toEqual(['dest_ip', 'source_ip']);

    const ordinary = await call('get_alert', { alert_id: 'DASH-1' });
    expect(ordinary.absent_observables).toEqual(['dest_ip']);
  });

  /**
   * THE `host` BOUNDARY — green before AND after.
   *
   * `cases.ts` never writes a dash into `host`, so a `host` of `'—'` came out
   * of a log: it is a string somebody chose, and the plausible wrong fix is to
   * read it through the same predicate. That would be this console discarding
   * an observable a detection DID record — the opposite mistake, and on the
   * field that decides whether an isolation has a target at all.
   *
   * It travels, and it travels FENCED, which is what X2.2 established: a
   * machine name is free text the ingestion contract does not validate.
   */
  it('still carries a host whose value happens to be the dash, fenced', async () => {
    const snap = await snapshot('en');
    expect(snap.cases.find((c) => c.alert_id === 'DASH-5')!.host).toBe(DASH);

    const detail = await call('get_alert', { alert_id: 'DASH-5' });
    expect(String(detail.host)).toContain(DASH);
    expect(detail.absent_observables).toEqual(['dest_ip', 'source_ip']);
  });

  /**
   * CONSEQUENCE 4, as a SUBTRACTION over the whole catalogue.
   *
   * Not "is `dest_ip` null in `get_alert`" — "did anything leave carrying the
   * console's display value", whatever field it travelled under.
   */
  it('hands no tool reply a string that IS the display dash', async () => {
    const carried: string[] = [];
    for (const t of TOOLS) {
      const out = await t.run(ARGS[t.name] ?? {}, { locale: 'en', fence: newFence() });
      for (const s of strings(out)) {
        if (s.text.trim() === DASH) carried.push(`${t.name}:${s.path}`);
      }
    }
    expect(carried).toEqual([]);
  });

  /**
   * THE OTHER BOUNDARY — green before AND after.
   *
   * A real address must still travel, in the row and in the detail, or the
   * subtraction above is satisfied by a reply that says nothing.
   */
  it('still hands the model an address the detection did record', async () => {
    const detail = await call('get_alert', { alert_id: 'DASH-1' });
    expect(detail.source_ip).toBe('185.220.101.5');

    const list = await call('list_alerts', {});
    const rows = list.alerts as Array<{ alert_id: string; source_ip: string | null }>;
    expect(rows.find((r) => r.alert_id === 'DASH-1')!.source_ip).toBe('185.220.101.5');
    expect(rows.find((r) => r.alert_id === 'DASH-2')!.source_ip).toBeNull();
  });
});
