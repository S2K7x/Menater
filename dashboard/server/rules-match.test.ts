/**
 * The tuning-rule match counter, and the three doors an alert comes through.
 *
 * ============================================================================
 * WHAT WAS WRONG
 *
 * `soc_tuning_rule` carries `match_count` and `last_matched_at`,
 * `RuleStore.noteMatch` is the UPDATE that moves them, and `RulesPage` reads
 * them three times: the row says « Never matched », the sort puts a
 * never-matched rule in the attention tier, and the review banner counts it.
 *
 * `noteMatch` had NO CALLER. So every rule read `match_count: 0` for ever —
 * a rule actively silencing alerts was presented as debt to remove, and the
 * review banner stood permanently on a screen whose own header says a rule
 * that has matched nothing for a year is debt nobody remembers taking on.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Engine } from './engine/engine.ts';
import { MemoryRunStore } from './engine/store.ts';
import { pureHandlers } from './engine/nodes/pure.ts';
import { ioHandlers } from './engine/nodes/io.ts';
import { controlHandlers } from './engine/nodes/control.ts';
import { buildRegistry } from './engine/transforms/registry.ts';
import { INGESTION } from './engine/workflows/pipeline.ts';
import type { StepRecord } from './engine/types.ts';
import { injectAlert } from './injection.ts';
import { recordRuleMatch } from './rules-match.ts';

const NOW = new Date('2026-10-07T10:00:00Z');

/**
 * WHY THIS ONE READS THE SOURCE.
 *
 * `01-Ingestion` is started from three places — the push entry point, the
 * console's own injection (Health, replay, a promoted finding) and the pull
 * transport — and a counter wired to one of them is this repository's « a fix
 * applied at the front door and not at the two buttons behind it ». The set is
 * DERIVED from the product rather than listed, so a fourth door fails this
 * test on the day it is wired rather than on the day somebody remembers it.
 *
 * Comments AND import lines are stripped first. The comments for the reason
 * `scheduler.test.ts` gives — a paragraph above a call goes on vouching for a
 * call somebody removed — and the imports because `import { noteRuleMatch }`
 * survives the deletion of the only call to it: the first draft of this test
 * matched the bare name and was GREEN on a mutation that unwired the push door
 * and the pull door. A test that cannot fail is the defect it exists to catch,
 * rebuilt inside itself.
 */
const PRODUCT_FILES = [
  'webhook.ts', 'routes/ingest.ts', 'injection.ts', 'ingest/runtime.ts',
  'routes/findings.ts', 'routes/ops.ts', 'ingest/poller.ts', 'runtime.ts',
];

const sourceOf = (rel: string): string =>
  readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '');

describe('every door that starts 01-Ingestion records the match', () => {
  /** The files that actually start the ingestion workflow, read from the code. */
  const starters = PRODUCT_FILES.filter((f) => /start\(\s*'01-ingestion'/.test(sourceOf(f)));

  it('finds the doors rather than trusting a list', () => {
    expect(starters).toEqual(['webhook.ts', 'injection.ts', 'ingest/runtime.ts']);
  });

  for (const file of ['webhook.ts', 'injection.ts', 'ingest/runtime.ts']) {
    it(`${file} records a rule match`, () => {
      // The push door answers from `webhook.ts` and the route beside it is
      // where the run id is acted on, the same split `invalidate()` already
      // takes: so either the starter itself or its route records it.
      const own = sourceOf(file);
      const route = file === 'webhook.ts' ? sourceOf('routes/ingest.ts') : '';
      // A CALL or a default, never a mention: `injectAlert` takes the recorder
      // as an argument so a test of what the pipeline answered does not reach
      // for the process's database.
      expect(`${own}\n${route}`).toMatch(/noteRuleMatch\(|=\s*noteRuleMatch\b/);
    });
  }

  it('says why it could not record, rather than failing in silence', () => {
    // « Never throw a silent error: every failure branch must log, notify, or
    // both » is a design rule, and the dropped promise is the one place no
    // behavioural test can see it: the wired reporter can only be exercised by
    // a real database refusing, which is a fact about the machine running the
    // suite and not about this code. So it is read.
    const wired = sourceOf('rules-match.ts');
    expect(wired).toMatch(/report:\s*\(line\)\s*=>\s*console\.error/);
  });
});

// --- The reading, driven through the REAL pipeline -----------------------------

/**
 * WHY THE GRAPH RUNS HERE.
 *
 * The id this module needs sits at `tuning.matched_rule.id` inside one node's
 * output. Reading a node's output under a field name somebody REMEMBERED is a
 * trap this repository has paid for three times in one file, and the remedy it
 * settled on is the one used here: the real workflow, the real transform
 * registry and the real engine produce the journal, so no fixture is written
 * from the same memory as the reader.
 */
describe('recordRuleMatch, on a journal the engine wrote', () => {
  const RULE = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Authorised scanner',
    enabled: true,
    priority: 10,
    conditions: [
      { field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] },
      { field: 'rule_name', op: 'contains', values: ['port scan'] },
    ],
    action: 'allow',
    severity: null,
    owner: 'shai',
    reason: 'weekly authorised scan',
    expires_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };

  const alert = (over: Record<string, unknown> = {}) => ({
    alert_id: 'W-1',
    rule_name: 'nmap port scan detected',
    severity: 'high',
    timestamp: '2026-10-07T09:00:00Z',
    raw_log: 'nmap -sS from 10.0.0.9',
    source_ip: '10.0.0.9',
    ...over,
  });

  /** Runs 01-Ingestion for real and hands back the journal it wrote. */
  async function journalOf(rules: unknown[], incoming: Record<string, unknown>) {
    const store = new MemoryRunStore();
    const vars = new Map<string, unknown>([['pipeline.shadowMode', true]]);
    const deps = {
      transforms: buildRegistry({
        now: () => NOW, resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
      }),
      vars: () => vars,
      now: () => NOW,
      secret: () => undefined,
      query: async (sql: string) => {
        if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
        if (sql.includes('soc_tuning_rule')) return rules as never[];
        return [];
      },
      runSubflow: async (workflowId: string) => ({ run_id: `sub-${workflowId}`, status: 'done' }),
    };
    const engine = new Engine({
      store,
      handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
      now: () => NOW,
    });
    engine.register(INGESTION);
    const run = await engine.start('01-ingestion', incoming, String(incoming.alert_id));
    return { runId: run.id, store };
  }

  /** The two collaborators, with a log of what the rule store was asked to do. */
  function recorder(
    store: { stepsOf: (runId: string) => Promise<StepRecord[]> } | null,
    opts: { noteFails?: string } = {},
  ) {
    const noted: string[] = [];
    const reported: string[] = [];
    return {
      noted,
      reported,
      deps: {
        engineStore: () => store,
        ruleStore: () => ({
          noteMatch: async (id: string) => {
            if (opts.noteFails) throw new Error(opts.noteFails);
            noted.push(id);
          },
        }),
        report: (line: string) => reported.push(line),
      },
    };
  }

  it('records the rule the pipeline actually matched', async () => {
    const { runId, store } = await journalOf([RULE], alert());
    const r = recorder(store);

    await expect(recordRuleMatch(runId, r.deps)).resolves.toBe('noted');
    expect(r.noted).toEqual([RULE.id]);
    expect(r.reported).toEqual([]);
  });

  it('counts a rule that forces a human, not only one that closes', async () => {
    // `escalate` does not close the alert, and the screen's claim is « this
    // rule has matched N alerts » — not « has closed N ». Counting only the
    // closing actions would under-report the rules a team is watching most.
    const { runId, store } = await journalOf(
      [{ ...RULE, action: 'escalate' }], alert(),
    );
    const r = recorder(store);

    await expect(recordRuleMatch(runId, r.deps)).resolves.toBe('noted');
    expect(r.noted).toEqual([RULE.id]);
  });

  it('writes nothing when no rule matched', async () => {
    const { runId, store } = await journalOf([RULE], alert({ source_ip: '203.0.113.7' }));
    const r = recorder(store);

    await expect(recordRuleMatch(runId, r.deps)).resolves.toBe('no_match');
    expect(r.noted).toEqual([]);
  });

  it('does not count an expired rule that would otherwise have matched', async () => {
    // `evaluateRules` reports it as EXPIRED rather than matched, and an
    // exception that has lapsed has not silenced anything. Counting it would
    // keep a dead rule out of the attention tier it belongs in.
    const { runId, store } = await journalOf(
      [{ ...RULE, expires_at: '2026-09-01T00:00:00Z' }], alert(),
    );
    const r = recorder(store);

    await expect(recordRuleMatch(runId, r.deps)).resolves.toBe('no_match');
    expect(r.noted).toEqual([]);
  });

  /**
   * The console's own door, driven for real.
   *
   * `injectAlert` is what Health's test alert, the Tracking tab's replay and a
   * promoted finding all go through, and it takes the recorder as an argument —
   * so this is the one door whose wiring can be CLAIMED rather than read off
   * the source. The other two are claimed structurally above.
   */
  it('the console injection door records the match it caused', async () => {
    const store = new MemoryRunStore();
    const noted: string[] = [];
    const vars = new Map<string, unknown>([['pipeline.shadowMode', true]]);
    const deps = {
      transforms: buildRegistry({
        now: () => NOW, resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
      }),
      vars: () => vars,
      now: () => NOW,
      secret: () => undefined,
      query: async (sql: string) => {
        if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
        if (sql.includes('soc_tuning_rule')) return [RULE] as never[];
        return [];
      },
      runSubflow: async (workflowId: string) => ({ run_id: `sub-${workflowId}`, status: 'done' }),
    };
    const engine = new Engine({
      store,
      handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
      now: () => NOW,
    });
    engine.register(INGESTION);

    const result = await injectAlert(engine, alert(), 'W-1', (runId) => { noted.push(runId); });

    expect(result.status).toBe(202);
    expect(noted).toEqual([result.run_id]);
    // And the run id it was handed is one this module can actually read.
    const r = recorder(store);
    await expect(recordRuleMatch(noted[0]!, r.deps)).resolves.toBe('noted');
    expect(r.noted).toEqual([RULE.id]);
  });

  it('writes nothing for a run that is not an ingestion', async () => {
    const store = new MemoryRunStore();
    const r = recorder(store);
    await expect(recordRuleMatch('no-such-run', r.deps)).resolves.toBe('no_match');
    expect(r.noted).toEqual([]);
  });
});

// --- A measurement must never be able to fail the alert ------------------------

/**
 * The whole reason this is fire-and-forget: `noteMatch`'s own header says a
 * counter is measurement, and measurement must never delay — or fail — the
 * handling of an alert. These claim that in the three ways it can break.
 */
describe('recordRuleMatch never costs the alert anything', () => {
  const steps = (output: unknown): StepRecord[] => [{
    runId: 'r', nodeId: 'tuning', attempt: 1, status: 'ok',
    output, port: 'main', error: null,
    startedAt: NOW.toISOString(), endedAt: NOW.toISOString(),
  }];

  const matched = { tuning: { matched_rule: { id: 'rule-1', name: 'x' } } };

  it('answers no_database rather than throwing when nothing is mounted', async () => {
    const reported: string[] = [];
    await expect(recordRuleMatch('r', {
      engineStore: () => null,
      ruleStore: () => null,
      report: (l) => reported.push(l),
    })).resolves.toBe('no_database');
    // Not a failure: an install with no database has no run to read either.
    expect(reported).toEqual([]);
  });

  it('reports a refused UPDATE and does not reject', async () => {
    const reported: string[] = [];
    await expect(recordRuleMatch('r', {
      engineStore: () => ({ stepsOf: async () => steps(matched) }),
      ruleStore: () => ({ noteMatch: async () => { throw new Error('permission denied'); } }),
      report: (l) => reported.push(l),
    })).resolves.toBe('failed');
    // SAID, not swallowed: every failure branch in this product logs or notifies.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('permission denied');
    expect(reported[0]).toContain('r');
  });

  it('reports a journal it could not read and does not reject', async () => {
    const reported: string[] = [];
    await expect(recordRuleMatch('r', {
      engineStore: () => ({ stepsOf: async () => { throw new Error('Database (SELECT): connect ECONNREFUSED'); } }),
      ruleStore: () => ({ noteMatch: async () => {} }),
      report: (l) => reported.push(l),
    })).resolves.toBe('failed');
    expect(reported[0]).toContain('ECONNREFUSED');
  });

  it('does not reject when a collaborator throws synchronously', async () => {
    // `noteRuleMatch` drops the promise on purpose, and an unhandled rejection
    // TERMINATES a Node 22 process — the trap this repository already paid for
    // on `pollSource`. So nothing in here may reject, including the lookups.
    await expect(recordRuleMatch('r', {
      engineStore: () => { throw new Error('engine key changed mid-flight'); },
      ruleStore: () => null,
      report: () => {},
    })).resolves.toBe('failed');
  });

  it('takes the last pass of a node the engine replayed', async () => {
    // A `pure` step whose process died is re-run on resume, so the node has two
    // entries. The one that stands is what it finally produced.
    const noted: string[] = [];
    await expect(recordRuleMatch('r', {
      engineStore: () => ({
        stepsOf: async () => [
          ...steps({ tuning: { matched_rule: { id: 'stale', name: 'x' } } }),
          ...steps(matched),
        ],
      }),
      ruleStore: () => ({ noteMatch: async (id: string) => { noted.push(id); } }),
      report: () => {},
    })).resolves.toBe('noted');
    expect(noted).toEqual(['rule-1']);
  });

  it('reads a malformed output as no match rather than crashing', async () => {
    for (const output of [null, 'nope', {}, { tuning: null }, { tuning: { matched_rule: null } },
      { tuning: { matched_rule: { id: 42 } } }, { tuning: { matched_rule: { id: '  ' } } }]) {
      await expect(recordRuleMatch('r', {
        engineStore: () => ({ stepsOf: async () => steps(output) }),
        ruleStore: () => ({ noteMatch: async () => { throw new Error('must not be called'); } }),
        report: () => {},
      })).resolves.toBe('no_match');
    }
  });
});
