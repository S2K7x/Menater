/**
 * @vitest-environment jsdom
 */
/**
 * J0.1 — the control that sends a finding to the triage queue.
 *
 * ============================================================================
 * WHAT IS WORTH ASSERTING HERE
 *
 * Not that a button renders. Three things, and each of them is a defect this
 * product has paid for somewhere else:
 *
 *  1. THE SENTENCE SHOWN IS THE SERVER'S. `server/injection.ts` exists because
 *     two console buttons composed their own "injected!" over a pipeline that
 *     had refused the alert. A press answered `duplicate, skipped` must not
 *     read as a success here, and a press that failed must not read as one
 *     either — a failure that shows green is the defect the Tracking tab exists
 *     to expose.
 *  2. WHAT IT SENDS is the finding, with the scan run that gives it an
 *     identity. Without the run id it does not send at all, and says so.
 *  3. THE EXPLANATION IS FOLDED AND THE OUTCOME IS NOT (`CLARITY.md` § 3).
 *     Checked structurally rather than on rendered text: jsdom applies no
 *     stylesheet, so the browser measurement the project uses for this cannot
 *     be made here. See the test itself.
 *
 * The card is mounted WITH a finding in it, because a report with nothing in it
 * shows none of its defects.
 * ============================================================================
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { PromoteFinding } from './PromoteFinding.tsx';
import { FindingCard, type ReportFinding } from './ReportView.tsx';
import { resetPreferences } from '../lib/preferences.ts';

afterEach(() => {
  cleanup();
  resetPreferences();
  vi.restoreAllMocks();
});

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

/** Stubs the console route and hands back what it was called with. */
function stubRoute(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe('what the button sends', () => {
  it('posts the finding and the scan that gives it an identity', async () => {
    const fetchMock = stubRoute({ ok: true, response: 'It entered the triage queue.' });
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" target="acme/api" />);

    await userEvent.click(screen.getByRole('button', { name: /send to the triage queue/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('/api/findings/promote');
    expect(init.method).toBe('POST');

    const sent = JSON.parse(init.body);
    expect(sent.scan_run_id).toBe('scan-001');
    expect(sent.target).toBe('acme/api');
    // The whole finding, so the server maps it rather than the browser doing
    // it twice in two places that can disagree.
    expect(sent.finding.vulnerability).toBe('IDOR');
    expect(sent.finding.route).toBe('/orders/:id');
    expect(sent.finding.file).toBe('src/routes/orders.ts');
  });

  it('refuses to send, and says why, when the report has no scan run', async () => {
    const fetchMock = stubRoute({ ok: true, response: 'sent' });
    render(<PromoteFinding finding={FINDING} scanRunId={null} />);

    const button = screen.getByRole('button', { name: /send to the triage queue/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // Disabled AND explained. A control that is simply dead is one somebody
    // clicks three times and then reports as broken.
    expect(document.body.textContent).toMatch(/not attached to a scan run/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what the button reports back', () => {
  it('shows the server’s own sentence on success', async () => {
    stubRoute({ ok: true, response: '"IDOR in GET /orders/:id" entered the triage queue (done).' });
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" />);

    await userEvent.click(screen.getByRole('button', { name: /send to the triage queue/i }));

    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('entered the triage queue');
    expect(note.className).toContain('vp-promote-ok');
  });

  /**
   * THE ONE THAT MATTERS. The pipeline answering "already seen" is not a
   * success, and the console must not dress it as one — that is precisely the
   * defect `injection.ts` was written to close, on two other buttons.
   */
  it('does not dress a refusal as a success', async () => {
    stubRoute({
      ok: false,
      status: 200,
      response: '"IDOR in GET /orders/:id" was already sent from this scan, '
        + 'so no second case was opened — duplicate, skipped.',
    });
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" />);

    await userEvent.click(screen.getByRole('button', { name: /send to the triage queue/i }));

    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('already sent from this scan');
    expect(note.className).toContain('vp-promote-failed');
    expect(note.className).not.toContain('vp-promote-ok');
  });

  it('names the failure when the console cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" />);

    await userEvent.click(screen.getByRole('button', { name: /send to the triage queue/i }));

    const note = await screen.findByRole('status');
    // The cause, not a shrug — and the reassurance that matters after pressing
    // a button whose whole job is to send something somewhere.
    expect(note.textContent).toContain('Failed to fetch');
    expect(note.textContent).toMatch(/nothing entered the queue/i);
  });

  it('says nothing at all before it is pressed', () => {
    stubRoute({ ok: true, response: 'sent' });
    render(<PromoteFinding finding={FINDING} scanRunId="scan-001" />);
    // An outcome shown before there is one would be a claim about a press
    // nobody made.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('on the finding card', () => {
  it('is offered beside the actions that deal with the flaw in place', () => {
    stubRoute({ ok: true, response: 'sent' });
    render(<FindingCard finding={FINDING} scanRunId="scan-001" targetLabel="acme/api" />);

    expect(screen.getByRole('button', { name: /send to the triage queue/i })).toBeTruthy();
  });

  /**
   * The explanation of what promoting DOES is read once, so it belongs behind
   * the circled "i"; the label of the act, and the outcome of a press, report
   * and stay in the clear.
   *
   * ASSERTED STRUCTURALLY, NOT ON RENDERED TEXT. jsdom applies no stylesheet,
   * so `innerText` there returns the closed popover's contents too — the
   * measurement the project uses in a browser cannot be made here. What CAN be
   * checked is the thing the rule actually depends on: that the paragraph is
   * inside a CLOSED `details.soc-info`, which `styles.css` hides with
   * `.soc-info:not([open]) .soc-term-bubble { display: none }`. That rule's
   * existence is pinned separately, in `readability.test.tsx`.
   */
  it('folds the explanation and leaves the label and outcome in the clear', () => {
    stubRoute({ ok: true, response: 'sent' });
    const { container } = render(
      <FindingCard finding={FINDING} scanRunId="scan-001" />);

    const popover = container.querySelector('.vp-promote details.soc-info');
    expect(popover).toBeTruthy();
    expect((popover as HTMLDetailsElement).open).toBe(false);
    // The paragraph about the circuit lives INSIDE it, and nowhere else.
    expect(popover!.textContent).toMatch(/written into the audit chain/i);

    const outside = container.querySelector('.vp-promote-button');
    expect(outside!.textContent).toMatch(/send to the triage queue/i);
  });
});
