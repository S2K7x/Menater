/**
 * @vitest-environment jsdom
 */
/**
 * A button whose whole content is a drawing.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * `Icon` states its own contract in its header: *« Par defaut elles sont
 * decoratives (`aria-hidden`), le libelle etant porte par le texte voisin ;
 * passer `title` les rend annoncees. »* It keeps it — with no `title` the
 * `<svg>` carries `aria-hidden="true"`, so it contributes nothing to the name
 * of whatever contains it. That is right, and it is what stops « Add rule »
 * being read as « check Add rule ».
 *
 * It puts the whole obligation on the CALLER: an icon with no neighbouring
 * text leaves its button with no accessible name at all. Across 155 `<Icon>`
 * uses in this application exactly two controls do that, and they are the two
 * on every tuning-rule row — **edit** and **delete**.
 *
 * Measured in real Chromium (Playwright, accessibility snapshot) on the markup
 * the component actually renders, rather than deduced from the source:
 *
 *     === BEFORE (as shipped) ===
 *     button accessible names: "Disable", "", ""
 *     === AFTER (aria-label) ===
 *     button accessible names: "Disable", "Edit rule ...", "Delete rule ..."
 *
 * So a screen-reader user walking the rules list hears « Disable, button.
 * button. button. » on every row: three controls, two anonymous, and the way
 * to find out which one deletes the rule is to press it. WCAG 2.2 § 4.1.2
 * (Name, Role, Value), level A — on the screen `CLAUDE.md` calls the one
 * « where a team writes the rules deciding what stops reaching a human ».
 *
 * The rule already existed in this product, one file over: `Assistant.tsx`
 * gives its icon-only send button an `aria-label`. Same shape as the live
 * regions, as `readCapped`, as `redirect: 'manual'` — **the mirror of a rule
 * is not the rule.**
 *
 * ============================================================================
 * THE BOUNDARY, WHICH IS HALF THE FIX
 *
 * The plausible wrong fix is to give every `Icon` a `title`. That makes the
 * drawing announced BESIDE the text it decorates, so « Save rule » becomes
 * « check Save rule » on every button in the console — noise, bought with the
 * same edit. The third test claims that side and passes before AND after, on
 * purpose: it is what stops the next person "finishing the job".
 *
 * ============================================================================
 * AND THE SCOPE OF THE SWEEP
 *
 * The last test is the general guard, and an absence needs a scope. It covers
 * the four screens that render REPEATED ROW CONTROLS — a rules list, the
 * triage queue, an incident card, the trace log — because a row of icon
 * buttons is the natural thing to write there and the natural place for the
 * next one to land. It is not a claim about every screen in the console.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { api } from '../lib/api.ts';
import { RulesPage } from './RulesPage.tsx';
import { AlertQueue } from './AlertQueue.tsx';
import { CaseView } from './CaseView.tsx';
import { TracePanel } from './TracePanel.tsx';
import type { AlertCase, TraceReport, TuningRule } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ==========================================================================
 * Fixtures
 * ========================================================================== */

const rule = (over: Partial<TuningRule> = {}): TuningRule => ({
  id: 'r1',
  name: 'Known vulnerability scanner',
  enabled: true,
  priority: 10,
  conditions: [{ field: 'source_ip', op: 'equals', values: ['10.0.0.9'] }],
  action: 'allow',
  severity: null,
  owner: 'soc@example.com',
  reason: 'Authorised weekly scan from the security team appliance.',
  expires_at: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  match_count: 12,
  last_matched_at: '2026-09-18T00:00:00Z',
  ...over,
});

function mountRules(rules: TuningRule[] = [rule()]) {
  vi.spyOn(api, 'rules').mockResolvedValue({ rules } as Awaited<ReturnType<typeof api.rules>>);
  vi.spyOn(api, 'ruleTemplates').mockResolvedValue({ templates: [], drafts: [] });
  return render(<RulesPage />);
}

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-2026-0919-0412',
    received_at: '2026-09-19T11:54:07.000Z',
    state: 'awaiting_approval',
    severity: 'high',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    source_ip: '185.220.101.47',
    dest_ip: '10.12.4.31',
    host: 'srv-bastion-01',
    raw_log: 'Sep 19 11:54:07 web01 sshd[2211]: Accepted password for root',
    shadow_mode: false,
    executed: false,
    routing_outcome: null,
    enrichment: null,
    enrichment_meta: null,
    decision: null,
    approval: null,
    audit: null,
    stages: [],
    errors: [],
    attack: [],
    dwell_ms: null,
    ...over,
  }) as unknown as AlertCase;

const trace = (): TraceReport =>
  ({
    generated_at: '2026-09-19T09:05:00Z',
    window: { limit: 120, inspected: 3, attached: 3, oldest_at: null, newest_at: null, truncated: false },
    stall_after_ms: 300_000,
    chains: [{
      alert_id: 'ALT-1',
      received_at: '2026-09-19T08:55:00Z',
      last_activity_at: '2026-09-19T09:00:00Z',
      idle_ms: 1000,
      verdict: 'broken',
      steps: [{
        workflow: '01-Ingestion', execution_id: '100', status: 'success',
        handoff: 'items', started_at: '2026-09-19T09:00:00Z', duration_ms: 210,
      }],
      missing: [],
      terminal_reason: null,
      break_at: '02-Enrichment',
      replayable: true,
    }],
    orphans: [],
    executions: [{
      execution_id: '100', workflow: '01-Ingestion', status: 'error',
      note: 'E_LLM_TIMEOUT', started_at: '2026-09-19T09:00:00Z',
      duration_ms: 210, alert_id: 'ALT-1',
    }],
    counts: { broken: 1, stalled: 0, failed: 1, awaiting: 0, running: 0, complete: 0, orphans: 0, attention: 1 },
  }) as unknown as TraceReport;

/**
 * The controls a screen offers that assistive technology could not name.
 *
 * Uses Testing Library's own name computation — `{ name: /\S/ }` keeps only
 * the controls whose accessible name holds at least one non-space character —
 * rather than a hand-rolled reading of `aria-label`, which would agree with
 * whatever the fix happened to write.
 */
function unnamedControls(root: HTMLElement): HTMLElement[] {
  const scope = within(root);
  const all = [...scope.queryAllByRole('button'), ...scope.queryAllByRole('link')];
  const named = new Set<HTMLElement>([
    ...scope.queryAllByRole('button', { name: /\S/ }),
    ...scope.queryAllByRole('link', { name: /\S/ }),
  ]);
  return all.filter((el) => !named.has(el));
}

/** Names the offenders, so a failure says WHICH control rather than a count. */
const describeControls = (els: HTMLElement[]): string =>
  els.map((el) => el.outerHTML.slice(0, 160)).join('\n');

/* ==========================================================================
 * 1. The defect
 * ========================================================================== */

describe('a tuning rule row', () => {
  it('names every control it offers', async () => {
    const { container } = mountRules();
    await waitFor(() => expect(screen.getByText('Known vulnerability scanner')).toBeTruthy());

    const row = container.querySelector('.soc-rule-actions');
    expect(row).toBeTruthy();

    const unnamed = unnamedControls(row as HTMLElement);
    expect(
      unnamed.length,
      `controls with no accessible name:\n${describeControls(unnamed)}`,
    ).toBe(0);
  });

  it('says which rule the icon-only controls act on', async () => {
    // Two rows, so "Edit" and "Delete" on their own would not be enough: a
    // list of twenty rules would offer twenty identical pairs, and the button
    // that DELETES is among them.
    mountRules([
      rule(),
      rule({ id: 'r2', name: 'Noisy IDS signature', match_count: 0 }),
    ]);
    await waitFor(() => expect(screen.getByText('Known vulnerability scanner')).toBeTruthy());

    for (const name of ['Known vulnerability scanner', 'Noisy IDS signature']) {
      expect(screen.getByRole('button', { name: new RegExp(`^Edit .*${name}`) })).toBeTruthy();
      expect(screen.getByRole('button', { name: new RegExp(`^Delete .*${name}`) })).toBeTruthy();
    }
  });
});

/* ==========================================================================
 * 2. The boundary — passes before AND after, deliberately
 * ========================================================================== */

describe('an icon that decorates a label', () => {
  it('stays out of the accessible name', async () => {
    // The wrong way to close this defect is `title` on every `Icon`. That
    // would make the drawing announced beside the word it illustrates, and
    // « Add a rule » would be read as « check Add a rule » on every button in
    // the console. `Icon` keeps `aria-hidden` unless it is ASKED to speak.
    mountRules();
    await waitFor(() => expect(screen.getByText('Known vulnerability scanner')).toBeTruthy());

    // « New rule » is an icon followed by a word. Its accessible name is the
    // word, exactly — not « check New rule ».
    expect(screen.getByRole('button', { name: 'New rule' })).toBeTruthy();

    // And every decorative icon on the page keeps itself out of the tree.
    const decorative = document.querySelectorAll('.soc-icon > svg:not([role="img"])');
    expect(decorative.length).toBeGreaterThan(0);
    for (const svg of decorative) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

/* ==========================================================================
 * 3. The guard — the four screens that render repeated row controls
 * ========================================================================== */

describe('the screens that render a row of controls', () => {
  it('leaves no control unnamed — rules list', async () => {
    const { container } = mountRules([rule(), rule({ id: 'r2', name: 'Noisy IDS signature' })]);
    await waitFor(() => expect(screen.getByText('Noisy IDS signature')).toBeTruthy());
    const unnamed = unnamedControls(container);
    expect(unnamed.length, describeControls(unnamed)).toBe(0);
  });

  it('leaves no control unnamed — triage queue', () => {
    const { container } = render(
      <AlertQueue
        cases={[kase(), kase({ alert_id: 'ALT-2', state: 'closed', severity: 'low' })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const unnamed = unnamedControls(container);
    expect(unnamed.length, describeControls(unnamed)).toBe(0);
  });

  it('leaves no control unnamed — incident card', () => {
    const { container } = render(
      <CaseView alertCase={kase()} onRefresh={() => {}} onLookUp={() => {}} onAnalyse={() => {}} />,
    );
    const unnamed = unnamedControls(container);
    expect(unnamed.length, describeControls(unnamed)).toBe(0);
  });

  it('leaves no control unnamed — trace log', () => {
    const { container } = render(
      <TracePanel trace={trace()} onOpenCase={() => {}} onRefresh={() => {}} />,
    );
    const unnamed = unnamedControls(container);
    expect(unnamed.length, describeControls(unnamed)).toBe(0);
  });
});
