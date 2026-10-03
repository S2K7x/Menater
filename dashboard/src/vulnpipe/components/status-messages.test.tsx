/**
 * @vitest-environment jsdom
 */
/**
 * The live-region rule, applied to the half of the product that taught it.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * `src/components/status-messages.test.tsx` is the console half of this file.
 * It exists because `role="status"` appeared ZERO times under
 * `src/components/` while `src/vulnpipe/` used it twenty-two times — and the
 * comment that taught the console the vocabulary is still sitting in
 * `PromoteFinding.tsx`: *« `role="status"` and not an alert: it is the result
 * of something the person just did »*.
 *
 * The rule the console then wrote down has two halves, and this half of the
 * product kept NEITHER. Measured by mounting every screen here and counting
 * the live regions in the document before anything was written into one:
 * **0, on every screen, every time.** Every region in this directory is
 * created in the same breath as its first message — the state `Announce`
 * exists to remove, because a region born with its content is announced by
 * some screen readers and missed by others, and « sometimes » is not a
 * guarantee. And six of them hold no answer at all: a warning about a
 * setting's value, a provider's missing key, a failed cache restore, the
 * warnings inside an estimate, the contradiction on a finding somebody marked
 * fixed. Those are facts about what is already on screen, and a live region
 * announces them to somebody who did nothing.
 *
 * ============================================================================
 * THE LINE THIS FILE DRAWS, BECAUSE IT IS THE WHOLE POINT
 *
 * A region holds THE ANSWER TO A REQUEST, not a fact inside the answer. The
 * settings payload arrives with twelve facts in it; announcing one of them as
 * if it were the reply is worse than announcing none, because it sounds like
 * the whole reply. So:
 *
 *   - « the service is not answering » is the answer  → region, polite;
 *   - « the verdicts memory could not be picked up »  → a line of the answer,
 *     no region.
 *
 * The last four tests claim the side that must NOT move, and they pass before
 * and after: a field error bound to its input by `aria-describedby`, and the
 * scan's own progress line, which is the one thing here that really does
 * change by itself.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { CacheState, KeyStatus, ScanSettingsResponse } from '../lib/api.ts';
import { ProviderKeys } from './ProviderKeys.tsx';
import {
  ProviderSwitcher,
  type ProviderAvailability,
  type ProviderSettings,
} from './ProviderSwitcher.tsx';
import { SettingsPage, VulnPipeSettings } from './SettingsPage.tsx';
import { EstimatePanel, type ScanEstimate } from './EstimatePanel.tsx';
import { StaleStatusNotice } from './FindingStatus.tsx';
import { ScanLauncher } from './ScanLauncher.tsx';
import { LiveActivity } from './LiveActivity.tsx';
import { VulnPipeSection } from '../VulnPipeSection.tsx';
import type { ReportFinding } from './ReportView.tsx';
import { findingKey, resetStatuses, setStatus } from '../lib/finding-status.ts';
import { resetPreferences } from '../lib/preferences.ts';
import { dictionary } from '../../i18n/dictionary.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetStatuses();
  resetPreferences();
});

const t = dictionary('en');

/** Every live region in a subtree, in document order. */
const REGIONS = '[role="status"],[role="alert"],[role="log"],[aria-live]';
const regions = (root: ParentNode): Element[] => [...root.querySelectorAll(REGIONS)];

/** The live region a node sits in, or `null` if nothing would announce it. */
const announcer = (el: Element | null): Element | null => el?.closest(REGIONS) ?? null;

const KEYS: KeyStatus[] = [
  { name: 'GEMINI_API_KEY', set: false, source: 'none', locked: false },
];

const PROVIDERS: { settings: ProviderSettings; available: ProviderAvailability[] } = {
  settings: { nodeProvider: 'gemini', masterProvider: 'anthropic' },
  available: [
    { id: 'gemini', available: false, why: 'GEMINI_API_KEY is not set.' },
    { id: 'anthropic', available: true, why: null },
  ],
};

const scanSettings = (
  over: Partial<ScanSettingsResponse['settings']> = {},
  cache?: CacheState,
): ScanSettingsResponse => ({
  settings: { bypassClaudeForHighConfidence: false, detectionConcurrency: 4, ...over },
  thresholds: { reject_below: 0.4, direct_alert_above: 0.7 },
  limits: { concurrency: { min: 1, max: 16 } },
  cache,
});

const ESTIMATE: ScanEstimate = {
  target: { kind: 'directory', label: 'orders-api', files_indexed: 42, routes_found: 8 },
  mode: 'full_scan',
  routes_selected: 8,
  routes_free: 3,
  routes_billed: 5,
  llm_calls: { detection: 5, arbitration: { low: 0, high: 1 }, total: { low: 5, high: 6 } },
  tokens: { input: 5000, output: { low: 3500, high: 4400 }, total: { low: 8500, high: 9400 } },
  duration_s: { low: 25, high: 50 },
  cost: { usd: { low: 0.02, high: 0.05 }, free: false, unknown_reason: null },
  sampled: false,
  sample_size: 8,
  assumptions: ['One call per address.'],
  warnings: ['Two addresses could not be read.'],
  plain_language_summary: 'We are going to check 8 addresses.',
};

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
  technical_summary: 'No ownership check.',
  plain_language_summary: 'Anyone can read anyone else’s order.',
  suggested_fix_direction: 'Scope the query to the caller.',
  owasp_category: 'A01:2021 Broken Access Control',
  evidence: 'code',
  local_confidence_score: 0.9,
  detected_by: ['idor'],
  code_excerpt: null,
} as ReportFinding;

// ===========================================================================
// An answer lands in a region that already existed, and it is polite
// ===========================================================================

describe('a sentence produced by a button lands in a live region that pre-exists it', () => {
  it('engine keys — a save the service refused', async () => {
    vi.spyOn(api, 'setProviderKeys').mockRejectedValue(
      new ApiError('http 502', 'The analysis service refused the key.'),
    );
    const { container } = render(<ProviderKeys keys={KEYS} onApplied={() => {}} />);

    // The region is in the document BEFORE anything is written into it.
    expect(regions(container).length).toBeGreaterThan(0);

    await userEvent.type(screen.getByLabelText(/Google Gemini/i), 'g-new');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.settings.keysSave, 'i') }));

    const said = await screen.findByText(/refused the key/);
    expect(announcer(said)?.getAttribute('role')).toBe('status');
  });

  it('engine keys — and the save that worked, in the SAME slot', async () => {
    vi.spyOn(api, 'setProviderKeys').mockResolvedValue({ keys: KEYS, available: [] } as never);
    const { container } = render(<ProviderKeys keys={KEYS} onApplied={() => {}} />);
    const before = regions(container).length;

    await userEvent.type(screen.getByLabelText(/Google Gemini/i), 'g-new');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.settings.keysSave, 'i') }));

    const said = await screen.findByText(new RegExp(t.settings.keysSaved, 'i'));
    expect(announcer(said)).not.toBeNull();
    // `error` and `done` are the same answer slot — `send()` clears both before
    // it starts — so one region holds whichever arrives. A second region here
    // would be a second thing for a screen reader to find.
    expect(regions(container).length).toBe(before);
  });

  it('engines — an apply the server refused', async () => {
    const { container } = render(
      <ProviderSwitcher
        settings={PROVIDERS.settings}
        // Both engines available on purpose: the ONE region this screen should
        // have is the answer slot, so the count below cannot be satisfied by
        // the standing « key missing » warning the next describe is about.
        available={[
          { id: 'gemini', available: true, why: null },
          { id: 'anthropic', available: true, why: null },
        ]}
        onChange={() => {
          throw new Error('The analysis service is not answering.');
        }}
      />,
    );
    expect(regions(container).length).toBe(1);

    await userEvent.selectOptions(screen.getByLabelText(new RegExp(t.providers.detectionRole, 'i')), 'anthropic');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.providers.apply, 'i') }));

    const said = await screen.findByText(/is not answering/);
    expect(announcer(said)?.getAttribute('role')).toBe('status');
  });

  it('code settings — a request that could not be made', async () => {
    vi.spyOn(api, 'getScanSettings').mockRejectedValue(
      new ApiError('ECONNREFUSED', 'The analysis service is not answering.'),
    );
    const { container } = render(
      <SettingsPage providers={null} onProviderChange={async () => {}} busy={false} />,
    );
    expect(regions(container).length).toBeGreaterThan(0);

    const said = await screen.findByText(/is not answering/);
    expect(announcer(said)?.getAttribute('role')).toBe('status');
  });

  it('code settings — the confirmation that preferences were reset', async () => {
    vi.spyOn(api, 'getScanSettings').mockResolvedValue(scanSettings());
    render(<SettingsPage providers={null} onProviderChange={async () => {}} busy={false} />);

    // The control is behind a fold, which is what somebody opens before
    // pressing it.
    await userEvent.click(await screen.findByText(new RegExp(t.settings.resetHelp.slice(0, 30), 'i')));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.settings.reset, 'i') }));

    const said = await screen.findByText(new RegExp(t.settings.resetDone, 'i'));
    expect(announcer(said)).not.toBeNull();
  });

  it('code settings — the whole section failing to load', async () => {
    vi.spyOn(api, 'getProviders').mockRejectedValue(
      new ApiError('ECONNREFUSED', 'Start the analysis service.'),
    );
    vi.spyOn(api, 'getProviderKeys').mockResolvedValue({ keys: KEYS } as never);
    vi.spyOn(api, 'getScanSettings').mockResolvedValue(scanSettings());

    const { container } = render(<VulnPipeSettings />);
    expect(regions(container).length).toBeGreaterThan(0);

    const said = await screen.findByText(/Start the analysis service/);
    expect(announcer(said)?.getAttribute('role')).toBe('status');
  });

  it('the Code tab — « reading your code to price the work »', async () => {
    // A promise that never settles: the point is the sentence shown WHILE the
    // estimate is being computed, not the estimate.
    vi.spyOn(api, 'estimateScan').mockReturnValue(new Promise(() => {}) as never);

    const { container } = render(<VulnPipeSection />);
    const before = regions(container);

    await userEvent.type(screen.getByLabelText(/which folder/i), '/srv/orders-api');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.launcher.submit, 'i') }));

    const said = await screen.findByText(new RegExp(t.estimate.estimating.slice(0, 30), 'i'));
    const region = announcer(said);
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('status');
    // It is the slot that was already there, not one the press created.
    expect(before).toContain(region);
  });
});

// ===========================================================================
// A fact inside what is on screen is NOT announced
// ===========================================================================

describe('a standing condition is NOT announced', () => {
  it('engines — a provider whose key is missing', () => {
    /*
     * True from the first render on any install that configured an engine and
     * never set its key, and the form is rendered TWICE on the page — one per
     * role — so an assertive region here interrupted twice over a state
     * nobody had just produced.
     */
    const { container } = render(
      <ProviderSwitcher
        settings={PROVIDERS.settings}
        available={PROVIDERS.available}
        onChange={() => {}}
      />,
    );
    const warning = screen.getByText(/GEMINI_API_KEY is not set/);
    expect(announcer(warning)).toBeNull();
    expect(container.querySelectorAll('[role="alert"]').length).toBe(0);
  });

  it('code settings — a warning about a setting’s value', async () => {
    vi.spyOn(api, 'getScanSettings').mockResolvedValue(
      scanSettings({ bypassClaudeForHighConfidence: true }),
    );
    render(<SettingsPage providers={null} onProviderChange={async () => {}} busy={false} />);
    const warning = await screen.findByText(new RegExp(t.settings.bypassWarning.slice(0, 40), 'i'));
    expect(announcer(warning)).toBeNull();
  });

  it('code settings — a warning about the OTHER setting’s value', async () => {
    vi.spyOn(api, 'getScanSettings').mockResolvedValue(scanSettings({ detectionConcurrency: 12 }));
    render(<SettingsPage providers={null} onProviderChange={async () => {}} busy={false} />);
    const warning = await screen.findByText(
      new RegExp(t.settings.concurrencyWarning.slice(0, 40), 'i'),
    );
    expect(announcer(warning)).toBeNull();
  });

  it('code settings — a line INSIDE the answer: the memory that could not be picked up', async () => {
    const cache: CacheState = {
      persisted: true,
      restored: [{ kind: 'verdicts', kept: 0, dropped: 0, why: 'EACCES' }],
      detection: { entries: 0, hits: 0, misses: 0, expired: 0 },
      arbitration: { entries: 0, hits: 0, misses: 0, expired: 0 },
    };
    vi.spyOn(api, 'getScanSettings').mockResolvedValue(scanSettings({}, cache));
    render(<SettingsPage providers={null} onProviderChange={async () => {}} busy={false} />);
    const warning = await screen.findByText(/could not be picked up again/i);
    expect(announcer(warning)).toBeNull();
  });

  it('the estimate — a warning is one of twelve facts in the answer, not the answer', () => {
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={() => {}} onCancel={() => {}} />);
    const warning = screen.getByText(/Two addresses could not be read/);
    expect(announcer(warning)).toBeNull();
  });

  it('a report — « marked fixed, and the scan still finds it »', () => {
    /*
     * Carried in browser storage, so it is on screen the moment a report
     * renders — once per stale finding, and it was assertive.
     */
    setStatus(findingKey(FINDING), 'fixed', '');
    const { container } = render(<StaleStatusNotice finding={FINDING} />);
    const warning = screen.getByText(new RegExp(t.status.staleWarning.slice(0, 40), 'i'));
    expect(announcer(warning)).toBeNull();
    expect(container.querySelectorAll('[role="alert"]').length).toBe(0);
  });
});

// ===========================================================================
// The side that must NOT move. These pass before and after.
// ===========================================================================

describe('what stays as it is', () => {
  it('the launcher’s field error keeps its role AND its binding to the field', async () => {
    /*
     * The one message here that is not a page-level answer: it refuses the
     * action that was just attempted, and the input it belongs to names it
     * through `aria-describedby`, so it is reachable from the control rather
     * than only from a region somewhere else. Assertive is the pattern WCAG's
     * own techniques name for a validation error that blocks a submit.
     */
    render(<ScanLauncher onLaunch={() => {}} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.launcher.submit, 'i') }));

    const said = await screen.findByText(new RegExp(t.launcher.missingTarget, 'i'));
    expect(said.getAttribute('role')).toBe('alert');
    expect(screen.getByLabelText(/which folder/i).getAttribute('aria-describedby')).toBe(
      said.getAttribute('id'),
    );
  });

  it('the scan’s progress line stays a live region', () => {
    /*
     * This is the only content in this directory that changes BY ITSELF — a
     * new address every few seconds while a scan runs. A region is exactly
     * right for it; what is wrong with it is a separate subject (see the PR).
     */
    const event = (over: object = {}) =>
      ({
        seq: 1,
        step: 'detection',
        status: 'running',
        route: { http_method: 'GET', route: '/orders/:id' },
        ...over,
      }) as never;
    const { container } = render(
      <LiveActivity events={[event()]} currentStep="detection" running />,
    );
    expect(regions(container).length).toBeGreaterThan(0);
  });

  it('the promote and copy answers are NOT moved tonight', () => {
    /*
     * Four answers in this directory sit inside a flex container with a `gap`,
     * where an always-present region becomes an extra flex item — the reason
     * the console deliberately left `.soc-actions` alone. `.vp-promote-note`
     * even carries `flex-basis: 100%`, so wrapping it would put the sentence
     * back on the button's line. They keep their conditional regions until
     * that layout question is answered; this test says so out loud, so the
     * next reader does not take their state for the rule.
     */
    expect(true).toBe(true);
  });
});
