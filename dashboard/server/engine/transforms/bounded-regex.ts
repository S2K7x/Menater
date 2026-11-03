/**
 * Running a caller-supplied regular expression without being able to lose the
 * process.
 *
 * ============================================================================
 * THE DEFECT THIS EXISTS FOR, AND THE CLAIM IT REPLACES
 *
 * `tuning.ts` used to carry this sentence above `MAX_PATTERN` / `MAX_SUBJECT`:
 *
 *   "JavaScript cannot interrupt a running regex, so the only defence
 *    available here is to keep both the pattern and the subject small enough
 *    that even a pathological pattern terminates."
 *
 * The first half is true of a bare `RegExp.test`. The conclusion is false by
 * orders of magnitude, and the caps are not a defence. Measured on Node
 * 22.23.4, `(a+)+$` — six characters, well inside the 200-character cap —
 * against `'a'.repeat(n) + '!'`:
 *
 *     n = 20    14 ms        n = 28   3,686 ms
 *     n = 22    57 ms        n = 30  15,700 ms
 *     n = 24   230 ms        n = 32  60,000 ms
 *     n = 26   968 ms
 *
 * Roughly x4 per added character, and `MAX_SUBJECT` allows 2000 of them. A
 * regex cannot be interrupted and this API is single threaded, so ONE match
 * that does not return ends the console, the engine and both ingestion doors
 * for the life of the process — with no log line, because nothing throws.
 *
 * Four doors reach it. Three take the subject from text an attacker composed,
 * and one takes the pattern as well:
 *
 *   - the `tuning` node, on every alert, matching against `raw_log`;
 *   - `POST /api/rules/test`, which takes BOTH the rules and the alert from
 *     the body — about 150 bytes, and no session on an install with no console
 *     password, which is the shipped default;
 *   - `POST /api/rules`, which stores a pattern `validateRule` accepts
 *     (a nested quantifier is valid syntax), after which door one runs it;
 *   - the assistant's `test_rule`, i.e. also `POST /api/mcp` over a READ-ONLY
 *     bearer token. "They can change nothing" was true and did not mean they
 *     could not stop the console.
 *
 * ============================================================================
 * WHAT NODE ACTUALLY OFFERS, PROBED RATHER THAN READ
 *
 * `vm.Script.runInContext(ctx, { timeout })` DOES interrupt a running regular
 * expression: V8's backtracking loop has interrupt checks, and the watchdog
 * that fires the termination is a separate thread, so it works while the main
 * thread is blocked inside the match. Measured on Node 22.23.4 — `(a+)+$`
 * against 34 `a`s, which is about a minute bare, returns at the budget on
 * every shape probed, including the backreference form `(a*)*\1$`, and the
 * context goes on answering correctly afterwards.
 *
 * **`vm` is NOT used here as a sandbox, and it must not be read as one.** The
 * documentation is explicit that it is not a security boundary, and nothing
 * here depends on it being one: the pattern is a STRING this process compiles
 * with `new RegExp`, never source anybody supplied. What is borrowed is the
 * one property a bare call does not have — an execution that can be
 * terminated.
 *
 * ============================================================================
 * WHAT IS INSIDE THE TIMED REGION, AND WHAT IS DELIBERATELY NOT
 *
 * Only the MATCHING. The patterns are compiled by the caller and handed over
 * as `RegExp` objects, because compiling is bounded work by construction — a
 * compile parses a pattern of at most `MAX_PATTERN` characters and matches
 * nothing, so it cannot backtrack — while matching is the unbounded half this
 * file exists for. Putting the bounded half inside the budget spends the
 * budget on work that never needed it.
 *
 * That is not tidiness, it is the margin. Measured on the worst rule this
 * product's caps permit: with the compiles inside, the timed region costs
 * **32.4 ms on the first call and 6.7 ms warm**; with them outside, **3.7 ms
 * cold and 3.5 ms warm**, plus 2.3 ms of compiling that the budget no longer
 * pays for. The first version of this file compiled inside, and the headroom
 * assertion in the test was RED under full-suite load at 55.9 ms — a budget
 * whose margin depends on how busy the machine is is a budget that will
 * one day refuse a legal rule.
 *
 * ============================================================================
 * WHY A WHOLE RULE'S PATTERNS GO IN ONE RUN
 *
 * The interrupt is the cost, not the sandbox. Measured, same call, 2000-char
 * subject: `runInContext` WITHOUT `timeout` is 3.6 us, WITH it 126.5 us — the
 * watchdog is 123 of those 126. A bound paid per PATTERN would therefore turn
 * the one dry-run body this API accepts (256 kB, measured at 4,975 regex
 * conditions) from 11 ms into about 1.3 s: a cure that is its own denial of
 * service. Paid per RULE it is one watchdog for up to 25 conditions — 25
 * conditions in a single run measure 144 us against 126 us for one — so the
 * same body costs tens of milliseconds.
 *
 * That is also why `matchesRule` evaluates a rule's cheap operators FIRST: a
 * conjunction has no side effects, so the order is free, and a rule that
 * already fails on an `equals` never arms a watchdog at all.
 *
 * ============================================================================
 * TWO BOUNDS, AND THEY MEASURE DIFFERENT THINGS
 *
 * `RULE_BUDGET_MS` is what ONE rule's patterns may spend. `REQUEST_BUDGET_MS`
 * is what one evaluation — or one request, when the caller shares a budget
 * across several — may spend in total, overhead included, because the elapsed
 * time charged below is wall clock around the run and not the match alone.
 * Collapsing them into one number loses one of the two answers: without the
 * per-rule bound a single pattern spends everything, and without the total an
 * attacker simply sends more rules.
 *
 * Both are POLICY NUMBERS chosen against measurements, not maxima read off
 * this machine. The worst rule this product's own caps permit — 25 conditions
 * of 200 patterns of 200 characters each, every one of them matching only on
 * the last value, against a 2000-character subject — spends **3.7 ms of the
 * budget cold and 3.5 ms warm**. A realistic two-condition rule spends
 * 0.38 ms including its compiles.
 *
 * The COLD number is the one a budget is chosen against, and that is not a
 * detail: the first draft used 25 ms, taken from a probe that had warmed up
 * first, and the boundary test was RED — the budget refused the worst rule
 * this product's own caps permit, on the first alert after a restart, naming
 * it as too slow. A bound tuned on a warm measurement over-refuses exactly
 * once per process, which is the hardest moment to reproduce and the one an
 * operator meets first.
 *
 * So 100 ms is a 27x margin over the worst LEGAL rule and 263x over a real
 * one; and 250 ms is what one request may spend in total — about 650 realistic
 * rules, sixty absurd ones, or two and a half pathological ones before the
 * rest are refused without being run.
 *
 * ============================================================================
 * WHAT A BUDGET THAT RUNS OUT MEANS
 *
 * The rule does not match, and it is NAMED. Not matching is the same choice
 * `tuning.ts` already makes for a pattern that does not compile — "an invalid
 * pattern matches NOTHING; treating it as always true would silently allow
 * everything the rule names" — and it is fail-safe in the same direction: a
 * rule that cannot be decided cannot close an alert.
 *
 * Naming it is the other half, and it is not optional. `evaluateRules` already
 * returns `expired` rather than skipping an expired rule in silence, for the
 * reason written beside it: an exception that stops working without saying so
 * looks exactly like one that never worked. A pattern too expensive to run is
 * the same fact, and the operator who typed it is the only person who can fix
 * it.
 * ============================================================================
 */

import vm from 'node:vm';

/** What ONE rule's regular expressions may spend. See the header. */
export const RULE_BUDGET_MS = 100;

/** What one evaluation — or one request — may spend on them in total. */
export const REQUEST_BUDGET_MS = 250;

/**
 * The remaining allowance, shared by every match of one evaluation. A caller
 * that makes SEVERAL evaluations for one request passes one of these to all of
 * them, or the total it bounds is a total per call and not per request.
 */
export interface RegexBudget {
  remainingMs: number;
}

export const newRegexBudget = (ms: number = REQUEST_BUDGET_MS): RegexBudget => ({ remainingMs: ms });

/**
 * One condition: the subject read off the alert and bounded in size, and the
 * patterns ALREADY COMPILED. See the header for why the compiling is the
 * caller's and not this file's.
 */
export interface PreparedPatterns {
  subject: string;
  patterns: RegExp[];
}

export interface RegexVerdict {
  matched: boolean;
  /** The patterns could not be decided inside the budget. Never a match. */
  abandoned: boolean;
}

/**
 * The script is a constant and the context is reused: compiling either one per
 * call would add to the overhead the batching above exists to avoid. It does
 * one thing — a conjunction of conditions, each satisfied by any of its
 * patterns — and holds no `try`, because an unparseable pattern never reaches
 * it: `tuning.ts` keeps that decision, where it has always been.
 */
const MATCH = new vm.Script(
  'cs.every(function (c) { return c.rs.some(function (r) { return r.test(c.s); }); })',
);
const CONTEXT = vm.createContext(Object.create(null) as object);
const EMPTY: PreparedPatterns[] = [];

let runs = 0;

/**
 * How many times a watchdog has been armed since start.
 *
 * Exported for the tests, which assert the batching and the cheap-first
 * ordering by COUNTING the work rather than timing it: a stopwatch assertion
 * is the flaky kind this project has removed once already.
 */
export const sandboxRuns = (): number => runs;

/**
 * Do ALL of these conditions match, inside the budget?
 *
 * An empty list matches: a rule with no regular expression has nothing to
 * refuse here, and the caller has already decided the rest.
 */
export function boundedRegexMatch(conditions: PreparedPatterns[], budget: RegexBudget): RegexVerdict {
  if (conditions.length === 0) return { matched: true, abandoned: false };

  // `timeout` wants a positive integer, and a budget already spent must not be
  // rounded back up into one more run.
  const slice = Math.min(RULE_BUDGET_MS, Math.floor(budget.remainingMs));
  if (slice < 1) return { matched: false, abandoned: true };

  runs += 1;
  (CONTEXT as Record<string, unknown>).cs = conditions.map((c) => ({ s: c.subject, rs: c.patterns }));
  const started = process.hrtime.bigint();
  try {
    return { matched: MATCH.runInContext(CONTEXT, { timeout: slice }) === true, abandoned: false };
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return { matched: false, abandoned: true };
    }
    // Nothing else is expected: the only code that runs in there is the
    // constant above, over `RegExp` objects the caller has already compiled.
    // An error that is not the budget is a fault in this file, and a fault
    // that explains itself must not be dressed as a pattern being too slow.
    throw err;
  } finally {
    budget.remainingMs -= Number(process.hrtime.bigint() - started) / 1e6;
    // The context outlives the request, so what was handed to it must not: a
    // rule's subject is `raw_log`, i.e. up to 2000 characters of text somebody
    // else composed, per condition. Dropped as soon as the match is over.
    (CONTEXT as Record<string, unknown>).cs = EMPTY;
  }
}
