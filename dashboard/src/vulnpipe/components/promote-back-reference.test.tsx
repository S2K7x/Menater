/**
 * @vitest-environment jsdom
 */
/**
 * J0.5 — what a finding card says about a promotion it already made.
 *
 * ============================================================================
 * THE CASE IS NOT HAND-WRITTEN
 *
 * The thing the index reads is `extensions.vulnpipe` plus the `scan_target`
 * stamp, and both are written by the server. `cases.ts` read three node fields
 * under names the engine does not write for their whole life, because the
 * reader and its fixtures were written from the same memory — so the case
 * driven through these cards is built by the REAL `findingToAlert` and stamped
 * by the REAL `scanRepository`, the way `src/lib/systems.test.ts` already does
 * it. `server/promoted-back-reference.test.ts` goes one further and runs the
 * whole pipeline; what is left for this file is the SCREEN.
 *
 * ============================================================================
 * FOUR CLAIMS, AND TWO OF THEM ARE ABOUT WHAT IS NOT SAID
 *
 *  1. The sentence names the state in the QUEUE's words, not a pipeline
 *     identifier shown raw.
 *  2. It is NOT a live region. It is a standing condition — re-derived on
 *     every snapshot poll — and `CLAUDE.md` records that a permanent
 *     announcement is the permanent alarm the `diagnostic_probe` row refuses.
 *     The region on this card belongs to the press.
 *  3. A finding the index does not hold gets no sentence at all. The window is
 *     bounded, so "not in the queue" is a claim this screen cannot scope.
 *  4. The promote button stays ENABLED. The dedup table is the authority on a
 *     second press, and a disabled control would be the console guessing its
 *     answer.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { consoleDictionary } from '../../i18n/console.ts';
import { findingToAlert, scanRepository } from '../../../server/findings.ts';
import { promotedIndex, promotedLink } from '../../lib/promoted.ts';
import type { AlertCase, CaseState } from '../../lib/types.ts';
import { PromoteFinding } from './PromoteFinding.tsx';
import { FindingCard, type ReportFinding } from './ReportView.tsx';
import { resetPreferences } from '../lib/preferences.ts';

afterEach(() => {
  cleanup();
  resetPreferences();
  vi.restoreAllMocks();
});

const NOW = new Date('2026-10-19T02:00:00.000Z');
const RUN = 'scan-001';

const FINDING: ReportFinding = {
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
  detected_by: ['idor-scanner'],
  code_excerpt: null,
};

/**
 * The case a promotion of `finding` would leave in the window.
 *
 * `findingToAlert` writes the bag and derives the id; `scanRepository` is the
 * resolution `snapshot.ts` runs on every rebuild and the stamp the index gates
 * on. Everything else is the queue's own shape and is not what is under test.
 */
function caseFor(
  finding: ReportFinding,
  state: CaseState = 'closed',
  scanRunId = RUN,
): AlertCase {
  const mapped = findingToAlert({ scan_run_id: scanRunId, target: 'acme/api', finding }, NOW);
  if (!mapped.ok) throw new Error(`mapping failed: ${mapped.errors.join('; ')}`);
  const extensions = mapped.alert.extensions as Record<string, unknown>;

  const kase = {
    alert_id: mapped.alert_id,
    received_at: NOW.toISOString(),
    state,
    severity: 'critical',
    rule_name: String(mapped.alert.rule_name),
    source_ip: '—',
    dest_ip: '—',
    host: null,
    raw_log: String(mapped.alert.raw_log),
    extensions,
    shadow_mode: true,
    executed: false,
    routing_outcome: null,
    action_taken: null,
    enrichment: null,
    enrichment_meta: null,
    decision: null,
    approval: null,
    audit: null,
    stages: [],
    errors: [],
    attack: [],
    dwell_ms: null,
    repository: null,
    code_lead: null,
  } as unknown as AlertCase;

  return { ...kase, repository: scanRepository(kase) };
}

/** The link the Code tab builds, through the product's own binding. */
function linkFor(cases: AlertCase[], scanRunId: string | null = RUN) {
  const open = vi.fn();
  return { promoted: promotedLink(promotedIndex(cases, scanRunId), open), open };
}

describe('a finding that is already a case', () => {
  it('says so, in the queue’s own words for the state', () => {
    const { promoted } = linkFor([caseFor(FINDING, 'awaiting_approval')]);
    render(<PromoteFinding finding={FINDING} scanRunId={RUN} promoted={promoted} />);

    // The catalogue's string, not a second wording of it: `awaiting_approval`
    // is "Waiting on you" everywhere else in this console.
    const label = consoleDictionary('en').queue.states.awaiting_approval;
    expect(document.body.textContent).toContain(label);
    expect(document.body.textContent).toMatch(/already in the triage queue, from this scan/i);
  });

  /**
   * THE SENTENCE IS NOT AN ANNOUNCEMENT. It is derived from the snapshot, which
   * is replaced every few seconds, so a live region here would re-read it to a
   * screen-reader user for as long as the report stayed open.
   */
  it('is not in a live region, where the press’s own answer is', async () => {
    const { promoted } = linkFor([caseFor(FINDING)]);
    render(<PromoteFinding finding={FINDING} scanRunId={RUN} promoted={promoted} />);

    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelectorAll('[aria-live]').length).toBe(0);

    const sentence = [...document.querySelectorAll('p.vp-promote-note')]
      .find((p) => /already in the triage queue/i.test(p.textContent ?? ''));
    expect(sentence).toBeTruthy();
    expect(sentence!.getAttribute('role')).toBeNull();
  });

  it('offers the case, and hands the jump the alert id the server derived', async () => {
    const kase = caseFor(FINDING);
    const { promoted, open } = linkFor([kase]);
    render(<PromoteFinding finding={FINDING} scanRunId={RUN} promoted={promoted} />);

    await userEvent.click(screen.getByRole('button', { name: /open the case/i }));

    expect(open).toHaveBeenCalledWith(kase.alert_id);
    expect(kase.alert_id).toMatch(/^vulnpipe-[0-9a-f]{20}$/);
  });

  /**
   * The dedup table decides what a second press means, and it answers
   * `duplicate, skipped`. Disabling the button would be this console
   * pre-empting that answer — and the same flaw found by a LATER scan is a new
   * identity, which only the server knows.
   */
  it('leaves the button that sends it enabled', () => {
    const { promoted } = linkFor([caseFor(FINDING)]);
    render(<PromoteFinding finding={FINDING} scanRunId={RUN} promoted={promoted} />);

    const button = screen.getByRole('button', { name: /send to the triage queue/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows on the whole card, not only on the control in isolation', () => {
    const { promoted } = linkFor([caseFor(FINDING)]);
    render(<FindingCard finding={FINDING} scanRunId={RUN} promoted={promoted} />);

    expect(document.body.textContent).toMatch(/already in the triage queue/i);
    expect(screen.getByRole('button', { name: /open the case/i })).toBeTruthy();
  });
});

describe('what it refuses to claim', () => {
  it('says nothing about a finding the window does not hold', () => {
    // A real promotion of ANOTHER flaw of the same scan: the index is not
    // empty, so this is the discriminating case rather than an absent one.
    const other = caseFor({ ...FINDING, route: '/invoices/:id' });
    const { promoted } = linkFor([other]);
    render(<PromoteFinding finding={FINDING} scanRunId={RUN} promoted={promoted} />);

    expect(document.body.textContent).not.toMatch(/already in the triage queue/i);
    expect(screen.queryByRole('button', { name: /open the case/i })).toBeNull();
  });

  it('says nothing when the report cannot reach the queue at all', () => {
    render(<PromoteFinding finding={FINDING} scanRunId={RUN} promoted={null} />);

    expect(document.body.textContent).not.toMatch(/already in the triage queue/i);
    expect(screen.queryByRole('button', { name: /open the case/i })).toBeNull();
    // And the report is exactly what it was before J0.5.
    expect((screen.getByRole('button', { name: /send to the triage queue/i }) as HTMLButtonElement)
      .disabled).toBe(false);
  });

  /**
   * The scan run is part of the alert's identity, so a NEW scan of the same
   * code starts clean — the report of scan 2 must not present its findings as
   * already handled because scan 1's promotions are still in the window.
   */
  it('says nothing about this scan’s finding when the case belongs to another scan', () => {
    const { promoted } = linkFor([caseFor(FINDING, 'closed', 'scan-001')], 'scan-002');
    render(<PromoteFinding finding={FINDING} scanRunId="scan-002" promoted={promoted} />);

    expect(document.body.textContent).not.toMatch(/already in the triage queue/i);
  });
});

/**
 * THE CHAIN FROM THE WINDOW TO THE CARD, CLAIMED AT EVERY HOP.
 *
 * The link crosses four components, and dropping it at any one of them makes
 * the feature silent: the sentence simply never appears, and no test above
 * fails, because every one of them hands the card its link directly. That is
 * the shape of *"a fix applied at the front door and not at the two buttons
 * behind it"* — so the hops are asserted rather than assumed.
 *
 * COMMENTS ARE STRIPPED FIRST. Each hop is explained in a comment beside it,
 * and a test that reads the explanation goes on vouching for a prop somebody
 * removed — the lesson `n8n-removed.test.ts` and the `sweepExpiredWaits` caller
 * test were both written for.
 */
describe('the link reaches the card', () => {
  const source = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it.each([
    ['../../App.tsx', /<VulnPipeSection[^>]*\squeue=\{queue\}/],
    ['../VulnPipeSection.tsx', /<ReportView[\s\S]*?\spromoted=\{promoted\}/],
    ['./ReportView.tsx', /<FindingCard[\s\S]*?\spromoted=\{promoted\}/],
    ['./ReportView.tsx', /<PromoteFinding[\s\S]*?\spromoted=\{promoted\}/],
  ])('%s hands it on', (path, pattern) => {
    expect(source(path)).toMatch(pattern);
  });

  /**
   * And the hook that builds it sits ABOVE every conditional return in
   * `App.tsx`. Placed with the other derived values, signing in rendered fewer
   * hooks than the pass before and React unmounted the whole application —
   * `app-routing.test.tsx` caught it, and this says why the line is where it is.
   */
  it('is built before App can return early', () => {
    const app = source('../../App.tsx');
    expect(app.indexOf('const queue = useMemo(')).toBeGreaterThan(-1);
    expect(app.indexOf('const queue = useMemo(')).toBeLessThan(app.indexOf('if (authed === false)'));
  });
});
