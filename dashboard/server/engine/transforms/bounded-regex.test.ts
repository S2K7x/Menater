/**
 * A tuning rule's regular expressions, and the fact that one of them could
 * stop the console for the life of the process.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `tuning.ts` carried a comment saying the length caps were the defence
 * against catastrophic backtracking. They are not: `(a+)+$` is six characters
 * and the subject cap allows two thousand, so one match never returns — and
 * because nothing throws, there is no log line either. Four doors reach it,
 * and the sharpest takes the pattern AND the subject from one unauthenticated
 * request (`POST /api/rules/test`, about 150 bytes).
 *
 * The three claims below are the fix, and they are claims about WORK rather
 * than about wall clock wherever that is possible — a stopwatch assertion is
 * the flaky kind this project has removed once already:
 *
 *   1. a pattern that cannot finish is ABANDONED and NAMED, never awaited;
 *   2. the budget does not refuse work this product's own caps permit — the
 *      worst LEGAL rule still decides;
 *   3. the bound is paid once per rule, not once per pattern, and not at all
 *      for a rule that already failed on a cheap operator.
 *
 * The two tests that do look at the clock look at it with a margin of three
 * orders of magnitude, and they provoke real exponential backtracking rather
 * than borrowing a slow machine.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  boundedRegexMatch, newRegexBudget, sandboxRuns, REQUEST_BUDGET_MS, RULE_BUDGET_MS,
} from './bounded-regex.ts';
import {
  evaluateRules, matchesCondition, matchesRule, MAX_SUBJECT, type Condition, type TuningRule,
} from './tuning.ts';

/**
 * The classic exponential pattern. Measured bare on Node 22.23.4 against
 * `'a'.repeat(n) + '!'`: 0.23 s at n = 24, 3.7 s at 28, 15.7 s at 30, 60 s at
 * 32 — roughly x4 per character, and `MAX_SUBJECT` allows 2000 of them.
 */
const EXPONENTIAL = '(a+)+$';

/**
 * A subject of the size the matcher really sees in the pipeline, and one the
 * pattern above cannot match: the trailing character is what forces the
 * exhaustive backtrack. An all-`a` subject matches on the first path and
 * proves nothing — the first draft of this file used one.
 */
const NEVER_FINISHES = `${'a'.repeat(MAX_SUBJECT - 1)}!`;

const rule = (over: Partial<TuningRule> = {}): TuningRule => ({
  id: 'r1',
  name: 'Test rule',
  enabled: true,
  priority: 100,
  conditions: [{ field: 'raw_log', op: 'regex', values: [EXPONENTIAL] }],
  action: 'allow',
  severity: null,
  owner: 'shai',
  reason: 'because',
  expires_at: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  ...over,
});

describe('a pattern that cannot finish', () => {
  it('is interrupted rather than awaited', () => {
    /**
     * This is the premise the whole fix rests on, pinned deliberately: V8's
     * backtracking loop honours an interrupt, and the watchdog `vm` arms runs
     * on another thread, so it fires while this one is inside the match. If a
     * future runtime stops doing that, THIS goes red — instead of the console
     * going away the next time somebody writes a nested quantifier.
     */
    const started = Date.now();
    const verdict = boundedRegexMatch(
      [{ subject: NEVER_FINISHES, patterns: [new RegExp(EXPONENTIAL, 'i')] }],
      newRegexBudget(),
    );
    const elapsed = Date.now() - started;

    expect(verdict).toEqual({ matched: false, abandoned: true });
    // Three orders of magnitude of margin: bare, this subject does not finish
    // in any time anybody will wait for.
    expect(elapsed).toBeLessThan(5000);
  });

  it('leaves the rule not matching, and NAMES it', () => {
    // Not matching is the same answer an invalid pattern already gets, and it
    // is fail-safe in the same direction: a rule that could not be decided
    // cannot close an alert. Naming it is the other half — `expired` is a
    // list for exactly this reason.
    const outcome = evaluateRules({ raw_log: NEVER_FINISHES }, [rule({ name: 'Scanner noise' })]);

    expect(outcome.rule).toBeNull();
    expect(outcome.action).toBeNull();
    expect(outcome.abandoned).toEqual(['Scanner noise']);
  });

  it('does not report a rule that simply did not match as abandoned', () => {
    // The distinction the field exists for. Passes before and after.
    const outcome = evaluateRules({ raw_log: 'nothing like it' }, [
      rule({ conditions: [{ field: 'raw_log', op: 'regex', values: ['^absent$'] }] }),
    ]);
    expect(outcome.rule).toBeNull();
    expect(outcome.abandoned).toEqual([]);
  });

  it('does not report an invalid pattern as abandoned either', () => {
    // An unparseable pattern matches NOTHING and always did; it is a fault in
    // the rule, not a budget that ran out, and one word for both would be
    // reachable from a state it does not describe.
    const outcome = evaluateRules({ raw_log: 'anything' }, [
      rule({ conditions: [{ field: 'raw_log', op: 'regex', values: ['([unclosed'] }] }),
    ]);
    expect(outcome.rule).toBeNull();
    expect(outcome.abandoned).toEqual([]);
  });
});

describe('the budget does not refuse work the product allows', () => {
  it('still decides the worst rule this product\'s own caps permit', () => {
    /**
     * MAX_CONDITIONS 25 x MAX_VALUES 200 patterns of MAX_PATTERN characters,
     * every condition matching only on its LAST value so nothing
     * short-circuits, against a MAX_SUBJECT subject.
     *
     * This test is what refuses a future "just lower the budget", and it has
     * already done its job once: at 25 ms — a number taken from a probe that
     * had warmed up — it was RED, because the FIRST call in a process costs
     * 25.7 ms against 7.2 ms warm. Over-refusing a legal rule is a silent
     * hole, not a saving, so the headroom is asserted as well as the verdict.
     */
    const subject = 'Failed password for root from 10.0.0.9 port 51002 ssh2 '
      .repeat(40).slice(0, MAX_SUBJECT);
    const values = [
      ...Array.from({ length: 199 }, (_, i) => `(?:never${i}|nope${i})`.padEnd(200, 'x').slice(0, 200)),
      'failed password for root',
    ];
    const conditions: Condition[] = Array.from({ length: 25 }, () => ({
      field: 'raw_log', op: 'regex', values,
    }));

    const budget = newRegexBudget();
    const outcome = evaluateRules({ raw_log: subject }, [rule({ conditions, action: 'escalate' })], undefined, budget);

    expect(outcome.abandoned).toEqual([]);
    expect(outcome.rule?.name).toBe('Test rule');
    // And it left room: the worst rule the caps permit must spend well under
    // what ONE rule is allowed, or the margin is nominal.
    expect(REQUEST_BUDGET_MS - budget.remainingMs).toBeLessThan(RULE_BUDGET_MS / 2);
  });

  it('gives the same verdict whether a condition is matched alone or inside a rule', () => {
    // `matchesCondition` runs one condition and `matchesRule` batches all of
    // them into a single run: two sizes of one call, and nothing may depend on
    // which was used.
    const alert = { raw_log: 'Failed password for root', rule_name: 'sshd' };
    const cases: Condition[] = [
      { field: 'raw_log', op: 'regex', values: ['failed password'] },
      { field: 'raw_log', op: 'regex', values: ['^nothing'] },
      { field: 'raw_log', op: 'regex', values: ['([unclosed'] },
      { field: 'raw_log', op: 'regex', values: [] },
      { field: 'absent_field', op: 'regex', values: ['anything'] },
      { field: 'raw_log', op: 'regex', values: ['^never$', 'root$'] },
    ];
    for (const c of cases) {
      expect(matchesRule(alert, rule({ conditions: [c] })), JSON.stringify(c))
        .toBe(matchesCondition(alert, c));
    }
  });
});

describe('the bound cannot be walked around by re-inlining the match', () => {
  /**
   * The subtraction rather than the list, because this defect is per-CALL-SITE
   * and the plausible regression is somebody putting the three-line version
   * back for "one small case". Both directions are claimed: a rule-supplied
   * pattern is never EXECUTED in `tuning.ts`, and the matcher is still called
   * there — a sweep that matches nothing agrees with everything.
   *
   * Comments are stripped first: this file's own prose quotes the shape it
   * hunts, and so does `tuning.ts`'s.
   */
  const source = readFileSync(new URL('./tuning.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never runs a pattern it built itself', () => {
    // `validateRule` still COMPILES one to check its syntax, which cannot
    // backtrack because nothing is matched against it. Executing is the line.
    expect(source).toMatch(/new RegExp\(/);
    expect(source).not.toMatch(/new RegExp\([^)]*\)\s*\.\s*(?:test|exec)\(/);
  });

  it('still goes through the matcher', () => {
    expect(source).toMatch(/boundedRegexMatch\(/);
  });
});

describe('what the bound costs, counted rather than timed', () => {
  it('arms one watchdog per rule, not one per pattern', () => {
    // The interrupt is the cost — 3.6 us without `timeout`, 126.5 us with — so
    // a bound paid per pattern would be its own denial of service. A mutation
    // that goes back to one run per condition fails here.
    const alert = { raw_log: 'Failed password for root' };
    const conditions: Condition[] = Array.from({ length: 10 }, () => ({
      field: 'raw_log', op: 'regex', values: ['failed password'],
    }));

    const before = sandboxRuns();
    expect(matchesRule(alert, rule({ conditions }))).toBe(true);
    expect(sandboxRuns() - before).toBe(1);
  });

  it('arms none at all for a rule that already failed on a cheap operator', () => {
    // A conjunction has no side effects, so evaluating the cheap operators
    // first is free — and it is what keeps a rule set of ordinary rules from
    // paying the watchdog once per rule per alert.
    const alert = { raw_log: 'Failed password for root', source_ip: '203.0.113.7' };
    const r = rule({
      conditions: [
        { field: 'raw_log', op: 'regex', values: [EXPONENTIAL] },
        { field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] },
      ],
    });

    const before = sandboxRuns();
    expect(matchesRule(alert, r)).toBe(false);
    expect(sandboxRuns() - before).toBe(0);
  });

  it('stops spending once ONE evaluation has used its total', () => {
    /**
     * Two bounds that measure different things. Without the total, an attacker
     * does not need a slower pattern — only more rules: the 256 kB body this
     * API accepts holds 199 of them.
     */
    const rules = Array.from({ length: 20 }, (_, i) => rule({ id: `r${i}`, name: `rule ${i}` }));
    const budget = newRegexBudget();

    const before = sandboxRuns();
    const outcome = evaluateRules({ raw_log: NEVER_FINISHES }, rules, undefined, budget);
    const runs = sandboxRuns() - before;

    // Every rule is named: a budget spent by an earlier rule must not make a
    // later one look like a rule that did not match.
    expect(outcome.abandoned).toHaveLength(20);
    // Under a millisecond left is what "spent" means here: `timeout` wants a
    // positive integer, so a remainder below 1 ms buys no further run.
    expect(budget.remainingMs).toBeLessThan(1);
    // And the work stopped: strictly fewer runs than rules, bounded by the
    // total over the per-rule slice.
    expect(runs).toBeLessThan(20);
    expect(runs).toBeLessThanOrEqual(Math.ceil(REQUEST_BUDGET_MS / RULE_BUDGET_MS) + 1);
  });
});
