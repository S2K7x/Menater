/**
 * @vitest-environment jsdom
 */
/**
 * J0.7 — what the scan report says about the queue, and what it refuses to say.
 *
 * ============================================================================
 * THE HOLE, MEASURED BEFORE A LINE WAS WRITTEN
 *
 * Three cases in the window about a machine the service inventory maps to the
 * scanned target, two of them carrying T1190 and one waiting on a human — all
 * three resolved by the REAL `resolveRepository`, tagged by the REAL
 * `tagAttack` and `codeLead`. The rendered report named the service **0**
 * times, named the technique **0** times and said nothing about anything
 * waiting. Its only two mentions of the queue were the promote control's own
 * label and that control's `Explain` label, i.e. the door OUT.
 *
 * ============================================================================
 * FOUR OF THESE CLAIMS ARE ABOUT WHAT IS NOT SAID
 *
 *  1. A case whose answer came out of `extensions` is not counted. That is the
 *     security claim and it is driven through the real `findingToAlert` /
 *     `scanRepository` pair, because `findingAlertId` covers the flaw and the
 *     run and NOT the target.
 *  2. Nothing is said when nothing matches. The window is bounded and this tab
 *     renders with no snapshot at all, so an absence here has no scope.
 *  3. It is not in a live region. Standing state, re-derived on every poll; a
 *     permanent announcement is the permanent alarm this console refuses.
 *  4. It does not fold. It is a count and a state, and `CLARITY.md` § 3 keeps
 *     those on screen.
 *
 * And one boundary that passes BEFORE and after on purpose: a report handed no
 * queue at all renders exactly as it did before J0.7.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { consoleDictionary } from '../../i18n/console.ts';
import { codeIncidents, type CodeIncidentsLink } from '../../lib/systems.ts';
import { resolveRepository } from '../../../server/inventory.ts';
import { findingToAlert, scanRepository } from '../../../server/findings.ts';
import { tagAttack } from '../../../server/engine/attack.ts';
import { codeLead } from '../../../server/engine/code-lead.ts';
import type { AlertCase, Severity } from '../../lib/types.ts';
import { ReportView, type ReportFinding, type SecurityReport } from './ReportView.tsx';
import { resetPreferences } from '../lib/preferences.ts';

afterEach(() => {
  cleanup();
  resetPreferences();
  vi.restoreAllMocks();
});

/** Source with its comments stripped. A test must not read its own prose. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** The target as it was TYPED at launch, and the inventory line that names it. */
const TARGET = '/srv/src/billing-api';
const INVENTORY = [
  { service: 'Billing API', identifiers: ['web-01', '10.12.4.31'], repository: TARGET },
];

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-1',
    received_at: '2026-11-16T02:00:00.000Z',
    state: 'closed',
    severity: 'high' as Severity,
    rule_name: 'Something happened',
    source_ip: '185.220.101.47',
    dest_ip: '—',
    host: 'web-01',
    raw_log: 'log',
    extensions: null,
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
    ...over,
  }) as AlertCase;

/** A detection joined to its code by the real resolver and tagged by the real pair. */
function detection(over: Partial<AlertCase> = {}): AlertCase {
  const c = kase(over);
  const attack = tagAttack(c.rule_name, c.raw_log);
  return {
    ...c,
    attack,
    code_lead: codeLead(attack),
    repository: resolveRepository(c, INVENTORY),
  };
}

/**
 * A case opened by promoting a scan finding, through the real pair.
 *
 * Its `repository` is whatever string the scan carried — which is the string
 * an attacker can choose, since the derived alert id does not cover `target`.
 */
function promotedCase(target: string): AlertCase {
  const outcome = findingToAlert(
    {
      scan_run_id: 'scan-001',
      target,
      finding: {
        vulnerability: 'IDOR', http_method: 'GET', route: '/orders/:id',
        file: 'src/routes/orders.ts', severity: 'high',
      },
    },
    new Date('2026-11-16T01:00:00.000Z'),
  );
  if (!outcome.ok) throw new Error(outcome.errors.join(', '));
  const alert = outcome.alert as Record<string, unknown>;
  const c = kase({
    alert_id: outcome.alert_id,
    rule_name: alert.rule_name as string,
    extensions: alert.extensions as Record<string, unknown>,
    host: null,
    dest_ip: '—',
  });
  return { ...c, repository: scanRepository(c) };
}

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

const REPORT: SecurityReport = {
  scan_summary: {
    total_findings: 1, critical: 1, warning: 0, dismissed_by_arbiter: 0,
    not_arbitrated: 0, plain_language_intro: 'One serious problem found.',
  },
  findings: [FINDING],
  dismissed: [],
  source_root: TARGET,
};

/** The link the Code tab builds, through the product's own function. */
function linkFor(cases: AlertCase[], target: string | null = TARGET) {
  const openSystems = vi.fn();
  const incidents = codeIncidents(cases, target);
  const link: CodeIncidentsLink | null = incidents === null
    ? null
    : { incidents, openSystems };
  return { link, openSystems };
}

function renderReport(link: CodeIncidentsLink | null) {
  render(
    <ReportView
      report={REPORT}
      target={{ label: 'src/billing-api' }}
      scanRunId="scan-001"
      scanTarget={TARGET}
      inQueue={link}
    />,
  );
}

describe('the report says what the queue holds about this code', () => {
  it('names the system, the count and how many are waiting on a human', () => {
    const { link } = linkFor([
      detection({ alert_id: 'ALT-A', state: 'awaiting_approval' }),
      detection({ alert_id: 'ALT-B', host: '10.12.4.31' }),
      // Another machine, so the count is about this code and not the window.
      detection({ alert_id: 'ALT-C', host: 'db-07' }),
    ]);
    renderReport(link);

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/2 alerts in the triage queue are about Billing API/);
    expect(text).toMatch(/your service inventory maps to this code/);
    // The queue's own vocabulary for a case that blocks, not a second wording.
    expect(text).toContain(consoleDictionary('en').systems.awaiting(1));
  });

  it('names the technique that says the way in was this code, and counts only it', () => {
    const { link } = linkFor([
      detection({
        alert_id: 'ALT-A',
        rule_name: 'Web attack: SQL injection attempt on /orders',
      }),
      detection({
        alert_id: 'ALT-B',
        rule_name: 'Cross-site scripting attempt blocked',
      }),
      detection({ alert_id: 'ALT-C', rule_name: 'Brute force: 40 failed SSH logins' }),
    ]);
    renderReport(link);

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/3 alerts in the triage queue are about Billing API/);
    expect(text).toMatch(
      /2 of them say the way in was the application itself \(T1190 — Exploit Public-Facing Application\)/,
    );
  });

  it('offers the screen that stacks them, and presses through to it', async () => {
    const { link, openSystems } = linkFor([detection({ alert_id: 'ALT-A' })]);
    renderReport(link);

    await userEvent.click(screen.getByRole('button', { name: /see them by system/i }));
    expect(openSystems).toHaveBeenCalledTimes(1);
  });

  /**
   * IT IS NOT AN ANNOUNCEMENT. The sentence is derived from the snapshot,
   * which is replaced every twenty seconds, so a live region would re-read it
   * for as long as the report stayed open.
   */
  it('is not in a live region, and is not folded away', () => {
    const { link } = linkFor([detection({ alert_id: 'ALT-A', state: 'awaiting_approval' })]);
    renderReport(link);

    const sentence = [...document.querySelectorAll('p.vp-queue-link-note')]
      .find((p) => /in the triage queue/i.test(p.textContent ?? ''));
    expect(sentence).toBeTruthy();
    expect(sentence!.getAttribute('role')).toBeNull();
    expect(sentence!.closest('[aria-live]')).toBeNull();
    expect(sentence!.closest('[role="status"]')).toBeNull();
    // A count and a state REPORT, so they stay on screen: `CLARITY.md` § 3.
    expect(sentence!.closest('details')).toBeNull();
  });

  /**
   * The accent is reserved for *something is waiting for a human*, and
   * `var(--accent)` as a text colour fails on two of the six themes
   * (ROADMAP § 7). The emphasis is weight, so the claim is the ELEMENT.
   */
  it('emphasises the waiting clause by weight and not by colour', () => {
    const { link } = linkFor([detection({ alert_id: 'ALT-A', state: 'awaiting_approval' })]);
    renderReport(link);

    const strong = [...document.querySelectorAll('p.vp-queue-link-note strong')]
      .map((e) => e.textContent ?? '');
    expect(strong.some((s) => /waiting on you/i.test(s))).toBe(true);
  });
});

describe('what the report refuses to claim', () => {
  /**
   * THE SECURITY CLAIM. A promoted finding's `repository` comes out of
   * `extensions`, an open bag the derived alert id does not cover for
   * `target` — so counted, anything that can post an alert could put a
   * fabricated incident at the top of a report about code somebody just typed.
   */
  it('does not count a case whose answer came out of `extensions`', () => {
    const forged = promotedCase(TARGET);
    expect(forged.repository?.matched_on).toBe('scan_target');
    expect(forged.repository?.repository).toBe(TARGET);

    const { link } = linkFor([forged]);
    expect(link).toBeNull();
    renderReport(link);
    expect(document.body.textContent ?? '').not.toMatch(/in the triage queue (is|are) about/);
  });

  it('says nothing about a code the window holds no alert for', () => {
    // A non-empty window, so this is the discriminating case: there ARE
    // inventory-matched alerts, about another piece of code.
    const { link } = linkFor(
      [detection({ alert_id: 'ALT-A' })],
      '/srv/src/orders-api',
    );
    expect(link).toBeNull();
    renderReport(link);
    expect(document.body.textContent ?? '').not.toMatch(/in the triage queue (is|are) about/);
  });

  /**
   * THE BOUNDARY, green before AND after. The Code tab is rendered beside the
   * snapshot's error screen on purpose, so a console that cannot reach its
   * database still runs a scan — and then the report is exactly what it was.
   */
  it('renders the report unchanged when it cannot reach the queue at all', () => {
    renderReport(null);

    const text = document.body.textContent ?? '';
    expect(text).toContain('One serious problem found.');
    expect(document.querySelectorAll('p.vp-queue-link-note').length).toBe(0);
    expect(screen.queryByRole('button', { name: /see them by system/i })).toBeNull();
    // The report's own controls are untouched.
    expect(screen.getByRole('button', { name: /send to the triage queue/i })).toBeTruthy();
  });
});

/**
 * THE CALL SITE, because the defect it would carry is silent.
 *
 * `ReportView` takes two different strings about one target: `target.label`,
 * which `shortLabel()` cut to its last two path segments for a header, and
 * `scanTarget`, which is what was typed. Handing the label to `codeIncidents`
 * would compare `src/billing-api` against an inventory line reading
 * `/srv/src/billing-api`, match nothing, and say nothing — a feature that
 * looks shipped and never fires, on an install where the join is correct.
 *
 * This repository has already paid for that twice: the launcher prefill and
 * the replay payload both travelled a display string as an input. So the claim
 * is on the call, not on a rendered sentence, because no rendering can tell a
 * join that found nothing from a join that was never asked.
 */
describe('the target the walk is given', () => {
  it('is the string that was typed, never the header’s shortened label', () => {
    const src = code(readFileSync(join(import.meta.dirname, '..', 'VulnPipeSection.tsx'), 'utf8'));
    const call = /codeIncidents\(([^)]*)\)/.exec(src);
    expect(call, 'VulnPipeSection no longer calls codeIncidents').not.toBeNull();
    expect(call![1]).toContain('state.launchedTarget');
    expect(call![1]).not.toContain('label');
  });
});
