/**
 * @vitest-environment jsdom
 */
/**
 * An answer that arrives while nobody is looking at the place it arrives in.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * Six screens of this console answer a question by writing a sentence into a
 * panel: the connectivity diagnostic, the test-alert injection, the MCP
 * self-test, the tuning-rule dry run, the database probe, the chain replay and
 * a manual lookup. The operator presses a button, waits, and a line appears
 * somewhere on the page — often far from the button, sometimes forty-five
 * seconds later.
 *
 * Nothing announced any of it. `role="status"` / `role="alert"` / `aria-live`
 * appeared **zero** times in `src/components/`, while the other half of the
 * same application — `src/vulnpipe/` — used them twenty-two times and had
 * written the rule down in a comment: *« `role="status"` and not an alert: it
 * is the result of something the person just did »*. The rule existed, on one
 * half of one product.
 *
 * For somebody working with a screen reader that is not a missing nicety: a
 * refusal and a success are both silence, which is the failure this console
 * exists to make impossible, committed against itself.
 *
 * ============================================================================
 * AND THE BOUNDARY, WHICH IS HALF THE POINT
 *
 * A live region is for a message that APPEARS BECAUSE SOMEBODY ACTED. A
 * standing condition — a broken chain read off the snapshot, a guarantee
 * printed above a field — must NOT be in one: the console re-renders on every
 * poll, and a permanent announcement is the permanent alarm this project
 * already refuses on the Tracking tab. The last two tests claim that side, so
 * the fix cannot be "widened" into noise.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { api, ApiError } from '../lib/api.ts';
import { HealthPanel } from './HealthPanel.tsx';
import { McpPanel } from './McpPanel.tsx';
import { RulesPage } from './RulesPage.tsx';
import { TracePanel } from './TracePanel.tsx';
import { IntelPanel } from './IntelPanel.tsx';
import { Assistant } from './Assistant.tsx';
import { consoleDictionary } from '../i18n/console.ts';
import type { HealthReport, TraceChain, TraceReport, TraceStep } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const c = consoleDictionary('en');

/** The live region a node sits in, or `null` if nothing would announce it. */
const announcer = (el: Element | null): Element | null =>
  el?.closest('[role="status"], [role="alert"], [role="log"], [aria-live]') ?? null;

const HEALTH: HealthReport = {
  mode: 'live',
  engine: { reachable: true, url: 'postgres://localhost:5432/menater', detail: 'Engine mounted.' },
  workflows: [],
  audit_db: { healthy: true, detail: 'Chain verified.' },
  blocking_findings: [],
  checked_at: '2026-09-19T00:00:00Z',
};

const step = (over: Partial<TraceStep> = {}): TraceStep => ({
  workflow: '01-Ingestion', execution_id: '100', status: 'success', handoff: 'items',
  started_at: '2026-09-19T09:00:00Z', duration_ms: 210, ...over,
});

const chain = (over: Partial<TraceChain> = {}): TraceChain => ({
  alert_id: 'ALT-1',
  received_at: '2026-09-19T08:55:00Z',
  last_activity_at: '2026-09-19T09:00:00Z',
  idle_ms: 1000,
  verdict: 'broken',
  steps: [step()],
  missing: [],
  terminal_reason: null,
  break_at: '02-Enrichment',
  replayable: true,
  ...over,
} as TraceChain);

const trace = (over: Partial<TraceReport> = {}): TraceReport => ({
  generated_at: '2026-09-19T09:05:00Z',
  window: { limit: 120, inspected: 3, attached: 3, oldest_at: null, newest_at: null, truncated: false },
  stall_after_ms: 300000,
  chains: [],
  orphans: [],
  executions: [],
  counts: { broken: 0, stalled: 0, failed: 0, awaiting: 0, running: 0, complete: 0, orphans: 0, attention: 0 },
  ...over,
});

describe('a sentence produced by a button lands in a live region', () => {
  it('Health — the injection verdict', async () => {
    vi.spyOn(api, 'scenarios').mockResolvedValue({
      scenarios: [{ id: 'malformed', title: 'Malformed alert', purpose: 'A rejection is a behaviour too' }],
    });
    /*
     * The `malformed` scenario on purpose: it is the one that ships to show
     * what a REFUSED alert tells its sender, so the sentence it produces is
     * the one an operator most needs and least expects.
     */
    vi.spyOn(api, 'simulate').mockResolvedValue({
      ok: false,
      status: 400,
      alert_id: '',
      response: 'invalid_severity: expected one of low|medium|high|critical',
    } as never);

    const { container } = render(<HealthPanel health={HEALTH} onRefresh={() => {}} />);
    await screen.findByText('Malformed alert');

    // The region is in the document BEFORE anything is written into it: a live
    // region created in the same breath as its content is announced by some
    // screen readers and missed by others, and "sometimes" is not a guarantee.
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByText('Malformed alert'));
    const verdict = await screen.findByText(/invalid_severity/);
    const region = announcer(verdict);
    expect(region).not.toBeNull();
    // POLITE, not assertive. Somebody who just pressed a button is waiting for
    // this sentence: interrupting them to deliver what they asked for buys
    // nothing and costs the reading they were in the middle of.
    expect(region!.getAttribute('role')).toBe('status');
  });

  it('Health — the connectivity diagnostic that could not run', async () => {
    vi.spyOn(api, 'scenarios').mockResolvedValue({ scenarios: [] });
    vi.spyOn(api, 'diagnostics').mockRejectedValue(
      new ApiError('No database configured. Settings → Database.'),
    );

    render(<HealthPanel health={HEALTH} onRefresh={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(c.health.run, 'i') }));
    const said = await screen.findByText(/No database configured/);
    expect(announcer(said)).not.toBeNull();
  });

  it('MCP — the self-test answer', async () => {
    vi.spyOn(api, 'mcpState').mockResolvedValue({
      enabled: true, token_set: true, live: true, path: '/api/mcp',
      tools: [], prompts: [], resources: [], protocol_versions: ['2025-06-18'],
    });
    vi.spyOn(api, 'mcpTest').mockResolvedValue({ ok: false, detail: 'The endpoint answered 404.' });

    render(<McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />);
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(c.mcp.test, 'i') }));
    const said = await screen.findByText(/answered 404/);
    expect(announcer(said)).not.toBeNull();
  });

  it('Rules — the dry run', async () => {
    vi.spyOn(api, 'rules').mockResolvedValue({ rules: [] });
    vi.spyOn(api, 'ruleTemplates').mockResolvedValue({ templates: [] } as never);
    vi.spyOn(api, 'testRules').mockResolvedValue({
      matched: null, expired: [], note: null, evaluated: 0,
    } as never);

    render(<RulesPage />);
    // The bench is behind a fold; opening it is what an operator does before
    // pressing the button, so the test does the same.
    const fold = await screen.findByText(new RegExp(c.rules.testTitle, 'i'));
    await userEvent.click(fold);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(c.rules.testRun, 'i') }));
    const said = await screen.findByText(new RegExp(c.rules.testNoMatch, 'i'));
    expect(announcer(said)).not.toBeNull();
  });

  it('Tracking — the replay answer', async () => {
    vi.spyOn(api, 'replay').mockResolvedValue({
      ok: false, status: 400, detail: 'invalid_dest_ip: not an IPv4/IPv6 literal',
    } as never);

    render(
      <TracePanel trace={trace({ chains: [chain()] })} onOpenCase={() => {}} onRefresh={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: new RegExp(c.trace.replay, 'i') }));
    const said = await screen.findByText(/invalid_dest_ip/);
    expect(announcer(said)).not.toBeNull();
  });

  it('Lookup — a lookup that could not be made', async () => {
    vi.spyOn(api, 'intelProviders').mockResolvedValue({ providers: [] } as never);
    vi.spyOn(api, 'intelLookup').mockRejectedValue(new ApiError('VirusTotal refused the key.'));

    render(<IntelPanel />);
    const field = await screen.findByPlaceholderText(c.intel.placeholder);
    await userEvent.type(field, '8.8.8.8');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(c.intel.run, 'i') }));
    const said = await screen.findByText(/VirusTotal refused/);
    expect(announcer(said)).not.toBeNull();
  });

  it('Assistant — the answer to the question that was just asked', async () => {
    vi.spyOn(api, 'assistantState').mockResolvedValue({
      ready: true, suggestions: [],
    } as never);
    vi.spyOn(api, 'assistantChat').mockResolvedValue({
      reply: 'Alert ALT-1 is waiting for an approval.',
      tools: [{ name: 'get_alert' }],
    } as never);

    render(<Assistant page={{ tab: 'alerts' }} />);
    await userEvent.click(screen.getByRole('button', { name: c.assistant.launcher }));
    const box = await screen.findByRole('textbox');
    await userEvent.type(box, 'why is it waiting?{Enter}');
    const said = await screen.findByText(/waiting for an approval/);
    expect(announcer(said)).not.toBeNull();
  });
});

describe('a standing condition is NOT announced', () => {
  it('Tracking — a broken chain read off the snapshot', () => {
    /*
     * This one is red on every poll until somebody fixes the pipeline. In a
     * live region it would be re-announced for as long as it lasts, and a
     * permanent alarm stops being read — the rule this tab already applies to
     * the diagnostic probe.
     */
    const { container } = render(
      <TracePanel
        trace={trace({ chains: [chain({ replayable: false })] })}
        onOpenCase={() => {}}
        onRefresh={() => {}}
      />,
    );
    const broken = container.querySelector('.soc-banner-error');
    expect(broken).not.toBeNull();
    expect(announcer(broken)).toBeNull();
  });

  it('Lookup — the guarantee printed above the field', async () => {
    vi.spyOn(api, 'intelProviders').mockResolvedValue({ providers: [] } as never);
    render(<IntelPanel />);
    const promise = await screen.findByText(new RegExp('THE PASSWORD DOES NOT LEAVE THIS BROWSER', 'i'));
    expect(announcer(promise)).toBeNull();
  });
});
