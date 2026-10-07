/**
 * Recording that a tuning rule matched.
 *
 * ============================================================================
 * THE COUNTER THE RULES SCREEN READS, AND THE WRITER IT NEVER HAD
 *
 * `soc_tuning_rule` declares `match_count` and `last_matched_at`,
 * `RuleStore.noteMatch` is the UPDATE that moves them, and `RulesPage` reads
 * them three times over: each row prints « Never matched » or « N matches »,
 * `rank()` lifts an enabled rule that has matched nothing into the attention
 * tier, and the review banner at the top of the screen counts those rules.
 *
 * `noteMatch` HAD NO CALLER. Nothing in the product — not the engine, not the
 * routes, not a trigger in `sql/` — ever incremented it, so every rule on
 * every install read `match_count: 0` for its whole life. A rule quietly
 * closing a thousand alerts a week was therefore presented as debt to remove,
 * on the screen whose own header says a rule that has matched nothing for a
 * year is debt nobody remembers taking on — and the review banner stood
 * permanently lit, which is the permanent alarm this console refuses
 * everywhere else. The one test fixture that touched it handed the screen
 * `match_count: 12`, a value the pipeline could not produce.
 *
 * ============================================================================
 * WHY THE WRITE IS HERE AND NOT IN THE GRAPH
 *
 * The obvious home is a `postgres` node after `tuning` in `01-Ingestion`. It
 * is the wrong one, and `NODE_EFFECTS` says why: `postgres` is classed `write`
 * without nuance, so a counter node interrupted mid-run would mark the step
 * `indeterminate` and FAIL the alert's run, leaving it for a human to settle.
 * Paying for a statistic with a triage that has to be settled by hand
 * contradicts the rule `noteMatch` states in its own header — a counter is
 * measurement, and measurement must never be able to delay or fail the
 * handling of an alert.
 *
 * So it sits outside the graph, after the run, and it is fire-and-forget:
 * `recordRuleMatch` never rejects, and a failure is SAID rather than
 * swallowed. The cost is one extra journal read per alert, off the answer's
 * path, and a lost increment costs a slightly stale statistic — which is
 * exactly what the store's header promised all along.
 *
 * It is called from all three doors that start `01-Ingestion`. `grep` for the
 * other callers of the thing you fixed: wiring the push entry point alone
 * would be this repository's « a fix applied at the front door and not at the
 * two buttons behind it », and `rules-match.test.ts` derives the set of doors
 * from the code rather than trusting a list.
 * ============================================================================
 */

import { errorText } from './engine/engine.ts';
import type { StepRecord } from './engine/types.ts';
import { getEngineStore, getRuleStore } from './runtime.ts';

export type MatchNoteOutcome = 'noted' | 'no_match' | 'no_database' | 'failed';

export interface MatchNoteDeps {
  engineStore: () => { stepsOf: (runId: string) => Promise<StepRecord[]> } | null;
  ruleStore: () => { noteMatch: (ruleId: string) => Promise<void> } | null;
  report?: (line: string) => void;
}

/**
 * The rule `01-Ingestion` matched, read off the journal it wrote.
 *
 * LAST PASS WINS and the filter is on the OUTPUT, not on the status — the
 * same two rules `outputOf` in `cases.ts` applies to the same journal, for the
 * same reasons: a `pure` step whose process died is replayed on resume, so what
 * stands is what the node finally produced, and a step that has not produced
 * anything carries `null` whatever its status says.
 *
 * Anything that is not a non-empty string id reads as « no rule matched ».
 * This runs after an alert has already been handled, so a shape it does not
 * recognise must cost nothing.
 *
 * NOT exported: `recordRuleMatch` is its only caller, and an export with no
 * caller is the shape of the defect this file exists to close.
 */
function matchedRuleId(steps: StepRecord[]): string | null {
  let id: string | null = null;
  for (const step of steps) {
    if (step.nodeId !== 'tuning') continue;
    if (step.output === null || step.output === undefined) continue;
    const out = step.output as { tuning?: { matched_rule?: { id?: unknown } | null } };
    const candidate = typeof out === 'object' ? out.tuning?.matched_rule?.id : undefined;
    id = typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null;
  }
  return id;
}

/** One alert's worth of bookkeeping. Resolves with what happened; never rejects. */
export async function recordRuleMatch(
  runId: string,
  deps: MatchNoteDeps,
): Promise<MatchNoteOutcome> {
  try {
    const journal = deps.engineStore();
    const rules = deps.ruleStore();
    // No database means no run to read either, so this is not a failure: it is
    // the state an unconfigured install is legitimately in.
    if (!journal || !rules) return 'no_database';

    const ruleId = matchedRuleId(await journal.stepsOf(runId));
    if (ruleId === null) return 'no_match';

    await rules.noteMatch(ruleId);
    return 'noted';
  } catch (err) {
    deps.report?.(
      `could not record a tuning-rule match for run ${runId} — ${errorText(err)}`,
    );
    return 'failed';
  }
}

/**
 * The wired form the doors call, and the promise they deliberately drop.
 *
 * Dropped because awaiting it would put a counter on the path that answers a
 * sender. `recordRuleMatch` resolves for every outcome including its own
 * failures, so nothing here can reject — an unhandled rejection terminates a
 * Node 22 process, and `rules-match.test.ts` pins that contract rather than
 * leaving a `.catch` to imply it.
 */
export function noteRuleMatch(runId: string): void {
  void recordRuleMatch(runId, {
    engineStore: getEngineStore,
    ruleStore: getRuleStore,
    report: (line) => console.error(`[menater] ${line}`),
  });
}
