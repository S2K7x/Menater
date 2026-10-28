/**
 * @vitest-environment jsdom
 */
/**
 * The Health tab's injection follow-up, and the one verdict it is not allowed
 * to reach from a window nobody could read.
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 *
 * Pressing *Inject* sends a real alert into the pipeline and then FOLLOWS it:
 * `follow()` re-reads the snapshot every three seconds for forty-five, and
 * says where the alert got to. That loop had no test at all — `followDone`,
 * `followSeen` and `followLost` were referenced by no file under `src/`.
 *
 * Its three answers are not the same KIND of claim, which is what this file
 * separates:
 *
 *   `followDone` / `followSeen` are POSITIVE observations. They rest on a read
 *   that answered, and "more to come" is open-ended: a console that stops
 *   answering after step 01 makes them less useful and never false.
 *
 *   `followLost` is a NEGATIVE claim about the pipeline — *« produced no step
 *   in 45 s. It arrived nowhere: see the Tracking tab. »* It rests on the
 *   ABSENCE of the chain from a reading, so it is only true of a reading that
 *   happened. A failed read used to `continue` and be forgotten, so fifteen
 *   refusals in a row — a console restarted mid-follow, a session gone with
 *   it, a proxy dropping the most expensive read this console does — ended in
 *   that sentence, which sends an operator to the Tracking tab to look for a
 *   pipeline fault on the strength of a console fault.
 *
 * Same rule as `clean` requiring a source that ANSWERED on the Lookup tab, and
 * as the scan report refusing green when coverage is unknown: grey is the tone
 * of the undetermined, and a verdict needs something that answered.
 *
 * ============================================================================
 * WHY THE CHECK IS ON THE *LAST* READ AND NOT ON "ANY READ"
 *
 * A chain is PERSISTED — `soc_run` / `soc_run_step` — so the state the loop is
 * watching only ever grows. The final reading therefore carries the whole
 * evidence for a negative claim, and a read that failed in the middle costs
 * nothing: the next one that answers sees everything the one before it would
 * have. What invalidates *« no step in 45 s »* is the last read not answering,
 * not some earlier read not answering.
 *
 * ============================================================================
 * NO REAL WAITING
 *
 * The budget is forty-five seconds, so the clock is faked. A test that really
 * slept would be the kind this project removed once already — and the one the
 * suite would learn to re-run rather than believe.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { api, ApiError, AuthRequiredError } from '../lib/api.ts';
import { HealthPanel } from './HealthPanel.tsx';
import { consoleDictionary } from '../i18n/console.ts';
import type {
  ChainStep, ChainVerdict, ConsoleSnapshot, HealthReport, TraceStep,
} from '../lib/types.ts';
// The real catalogue, for the same reason the component fetches it rather than
// hard-coding it: there is one list of scenarios, and a button invented here
// could outlive the one the server actually offers.
import { SCENARIOS } from '../../server/scenarios.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const c = consoleDictionary('en');
const ALERT = 'ALT-2026-1028-0001';

/** The two numbers `follow()` runs on, repeated here so the clock can be driven. */
const BUDGET_MS = 45_000;
const EVERY_MS = 3_000;

/**
 * How many reads one budget buys: the loop sleeps first, then reads, and stops
 * once the clock has reached the deadline. Derived rather than counted by hand,
 * so the test below that needs the LAST read follows the two constants.
 */
const POLLS = Math.floor(BUDGET_MS / EVERY_MS);

/** One real scenario, reduced to what `GET /api/simulate/scenarios` answers. */
const SCENARIO = {
  id: SCENARIOS[0].id, title: SCENARIOS[0].title, purpose: SCENARIOS[0].purpose,
};

const HEALTH: HealthReport = {
  mode: 'live',
  engine: { reachable: true, url: 'postgres://localhost:5432/menater', detail: 'Engine mounted.' },
  workflows: [],
  audit_db: { healthy: true, detail: 'No database error seen in recent runs' },
  blocking_findings: [],
  checked_at: '2026-10-28T00:00:00Z',
};

const step = (workflow: ChainStep): TraceStep => ({
  workflow,
  execution_id: `run-${workflow}`,
  status: 'success',
  handoff: 'items',
  started_at: '2026-10-28T00:00:01Z',
  duration_ms: 120,
});

/**
 * A snapshot carrying whatever the follow-up is meant to see.
 *
 * `follow()` reads `trace.chains` and nothing else off it, which is asserted
 * rather than asserted-about: the `followDone` test below only passes because
 * the chain placed here is the one the loop finds.
 */
function snapshotWith(chain: { verdict: ChainVerdict; steps: TraceStep[] } | null): ConsoleSnapshot {
  return {
    cases: [],
    metrics: {
      window_label: 'test', alerts_total: 0, alerts_shadow: 0, alerts_live: 0,
      actions_executed: 0, awaiting_approval: 0, failed: 0, by_verdict: {}, by_severity: {},
      avg_confidence: null, avg_dwell_ms: null, p95_dwell_ms: null, tokens_total: 0,
      fallback_rate_pct: null, degraded_rate_pct: null, human_disagreement_rate_pct: null,
      shadow_baseline: { decisions: 0, threshold: 50, reached: false },
    },
    health: HEALTH,
    trace: {
      generated_at: '2026-10-28T00:00:02Z',
      window: {
        limit: 120, inspected: 0, attached: 0, oldest_at: null, newest_at: null, truncated: false,
      },
      stall_after_ms: 300_000,
      chains: chain
        ? [{
            alert_id: ALERT,
            received_at: '2026-10-28T00:00:01Z',
            last_activity_at: '2026-10-28T00:00:01Z',
            idle_ms: 0,
            verdict: chain.verdict,
            steps: chain.steps,
            missing: [],
            terminal_reason: null,
            break_at: null,
            replayable: true,
          }]
        : [],
      orphans: [],
      executions: [],
      counts: {
        broken: 0, stalled: 0, failed: 0, awaiting: 0, running: 0, complete: 0,
        orphans: 0, attention: 0,
      },
    },
  };
}

/**
 * Press *Inject*, then run the whole follow-up budget on a faked clock.
 *
 * `reads` is consulted once per poll: a `ConsoleSnapshot` is an answer, an
 * `Error` is a read that did not answer. The list is padded with its last
 * entry, so a one-element list describes every one of the fifteen reads.
 */
async function inject(reads: Array<ConsoleSnapshot | Error>) {
  vi.spyOn(api, 'scenarios').mockResolvedValue({ scenarios: [SCENARIO] });
  vi.spyOn(api, 'simulate').mockResolvedValue({
    ok: true, status: 202, alert_id: ALERT, response: 'accepted',
  });
  let n = 0;
  vi.spyOn(api, 'snapshot').mockImplementation(async () => {
    const answer = reads[Math.min(n, reads.length - 1)];
    n += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });

  vi.useFakeTimers();
  render(<HealthPanel health={HEALTH} onRefresh={() => {}} />);
  // The scenario list is fetched in an effect; flush it before pressing.
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: SCENARIO.title }));
  // `simulate()` has to settle before the loop it starts can be advanced.
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BUDGET_MS + EVERY_MS);
  });
  return { polls: n };
}

/** Every sentence the two live regions ended up carrying. */
const banners = (): string[] =>
  [...document.querySelectorAll('.soc-banner')].map((b) => b.textContent ?? '');

describe('a verdict about the pipeline needs a read that answered', () => {
  it('fifteen refused reads do not become "it arrived nowhere"', async () => {
    const { polls } = await inject([new ApiError('Database (SELECT): connect ECONNREFUSED 127.0.0.1:5432')]);
    // Pinned, because the test above depends on which read is the last one.
    expect(polls).toBe(POLLS);

    const said = banners().join(' | ');
    // THE CLAIM: the negative verdict is not reachable from here.
    expect(said).not.toContain(c.health.followLost(ALERT, 45));
    // And what IS said names the console rather than the pipeline, and carries
    // the server's own reason — the only thing that tells an operator where to
    // look.
    expect(said).toContain('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('a session that lapsed mid-follow says so too, not "nowhere"', async () => {
    await inject([new AuthRequiredError('Authentication required.')]);
    const said = banners().join(' | ');
    expect(said).not.toContain(c.health.followLost(ALERT, 45));
  });

  it('the LAST read is what carries it: fourteen answers and a final refusal is not a verdict', async () => {
    // The rule the fix is written on. A chain is persisted, so the final
    // reading holds the whole evidence for a negative claim — and it is that
    // reading, not some earlier one, that has to have answered.
    const answered = snapshotWith(null);
    await inject([
      ...Array.from({ length: POLLS - 1 }, () => answered),
      new ApiError('The console server is not answering.'),
    ]);
    const said = banners().join(' | ');
    expect(said).not.toContain(c.health.followLost(ALERT, 45));
    expect(said).toContain(c.health.followUnread(ALERT, 'The console server is not answering.'));
  });

  it('the two sentences differ: a window nobody read is not an empty window', async () => {
    await inject([new ApiError('The console server is not answering.')]);
    const unread = banners().join(' | ');
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await inject([snapshotWith(null)]);
    const empty = banners().join(' | ');
    expect(unread).not.toBe(empty);
  });
});

describe('the answers that were already right, and stay right', () => {
  it('reads that answered and never held the alert keep the negative verdict', async () => {
    await inject([snapshotWith(null)]);
    expect(banners().join(' | ')).toContain(c.health.followLost(ALERT, 45));
  });

  it('a chain that completes is still the green one', async () => {
    await inject([snapshotWith({ verdict: 'complete', steps: [step('01-Ingestion'), step('05-Audit-Log')] })]);
    const said = banners().join(' | ');
    expect(said).toContain(c.health.followDone(ALERT));
    expect(document.querySelector('.soc-banner-ok')).not.toBeNull();
  });

  it('a step seen before the console went quiet is reported, not overwritten', async () => {
    // A positive observation rests on the read that made it, so a later
    // refusal does not take it away — and `followSeen`'s "more to come" is
    // already the open-ended form.
    await inject([
      snapshotWith({ verdict: 'running', steps: [step('01-Ingestion')] }),
      new ApiError('The console server is not answering.'),
    ]);
    expect(banners().join(' | ')).toContain(c.health.followSeen(ALERT, '01-Ingestion'));
  });
});

/**
 * The read the panel makes BEFORE anyone presses anything.
 *
 * The scenario catalogue comes from the server on purpose — *« so the buttons
 * cannot drift from the catalogue that actually builds the alerts »* — and
 * `.catch(() => setScenarios([]))` turned a read that did not answer into an
 * empty list. There is no other way to inject (`health.inject`, the single
 * button this screen used to have, is referenced by nothing), so the block
 * rendered its title, its label, and no control and no reason: a failed read
 * shown as *there is nothing to inject*, on the tab whose job is to say what
 * is wrong. Same rule as the verdict above, one function up — and a STANDING
 * condition, so deliberately not in a live region.
 */
describe('the scenario catalogue is a read, and a read can fail', () => {
  async function mount(answer: Error | Array<{ id: string; title: string; purpose: string }>) {
    if (answer instanceof Error) vi.spyOn(api, 'scenarios').mockRejectedValue(answer);
    else vi.spyOn(api, 'scenarios').mockResolvedValue({ scenarios: answer });
    render(<HealthPanel health={HEALTH} onRefresh={() => {}} />);
    await act(async () => {});
  }

  it('says the list could not be read, with the reason, instead of offering nothing', async () => {
    await mount(new ApiError('The console server is not answering.'));
    const said = document.body.textContent ?? '';
    expect(said).toContain(c.health.scenariosUnread('The console server is not answering.'));
    // And it is not announced: nobody pressed anything, and the console
    // re-renders on every poll — a permanent announcement is the permanent
    // alarm this product refuses.
    const note = screen.getByText(new RegExp(c.health.scenariosUnread(''), 'i'));
    expect(note.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });

  it('a catalogue that answered renders its buttons and no such note', async () => {
    await mount([SCENARIO]);
    expect(screen.getByRole('button', { name: SCENARIO.title })).not.toBeNull();
    expect(document.body.textContent ?? '').not.toContain(c.health.scenariosUnread(''));
  });
});
