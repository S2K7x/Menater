/**
 * @vitest-environment jsdom
 */
/**
 * What a promoted finding says was scanned — and why it cannot be the label.
 *
 * ============================================================================
 * THE TARGET ON THE ALERT IS THE ONE YOU CAN SCAN AGAIN
 *
 * The incident card hands the promoted case's target straight to the Code
 * tab's launcher. So it has to be the string the operator TYPED, and the
 * report header's `target.label` is not that: it is a display string, and for
 * a directory it is the last two path segments. Measured on `classifyTarget`
 * (VulnPipe/src/orchestration/scan-target.ts), on this machine:
 *
 *   classifyTarget('/tmp/probe/srv/src/orders-api')
 *     → { kind: 'directory', location: '/tmp/probe/srv/src/orders-api',
 *         label: 'src/orders-api' }
 *   classifyTarget('src/orders-api', '/tmp/probe/cwd')
 *     → { kind: 'directory', location: '/tmp/probe/cwd/src/orders-api' }
 *   classifyTarget('https://github.com/acme/billing/tree/main').label
 *     → 'acme/billing (main)'          … and re-classifying THAT throws
 *                                        "target not found"
 *
 * The second line is the one that costs: no error, no warning, and a different
 * directory that happens to exist. Sending somebody to read the wrong code
 * while an incident is open is the failure J0.3 refuses every resemblance in
 * order to avoid, and it would have arrived here through the back door.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderHook, act, waitFor, cleanup, screen, render as plainRender,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from './test-utils.tsx';
import { I18nProvider } from '../i18n/context.tsx';
import { DEFAULT_LOCALE } from '../i18n/dictionary.ts';
import { ThemeProvider } from '../theme/context.tsx';
import { useScan } from './lib/useScan.ts';
import { api, type RunSnapshot } from './lib/api.ts';
import { FindingCard, type ReportFinding } from './components/ReportView.tsx';
import { VulnPipeSection } from './VulnPipeSection.tsx';
import { resetPreferences } from './lib/preferences.ts';

afterEach(() => {
  cleanup();
  resetPreferences();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A real path, and the shortened label the service reports for it. */
const TYPED = '/srv/src/orders-api';
const LABEL = 'src/orders-api';

function snapshot(): RunSnapshot {
  return {
    run_id: 'run-1',
    status: 'done',
    events: [],
    error: null,
    report: { scan_summary: {} } as never,
    usage: null,
    estimate: null,
    target: { kind: 'directory', label: LABEL },
    effective_mode: null,
    routes_analyzed: null,
    routes_failed: null,
  };
}

async function scanOf(target: string) {
  vi.spyOn(api, 'estimateScan').mockResolvedValue({
    estimate_id: 'est-1', estimate: { plain_language_summary: 'ok' } as never,
  } as never);
  vi.spyOn(api, 'launchScan').mockResolvedValue({ run_id: 'run-1', notes: [] } as never);
  vi.spyOn(api, 'getRun').mockResolvedValue(snapshot());
  vi.spyOn(api, 'streamEvents').mockImplementation((_id, handlers) => {
    queueMicrotask(() => handlers.onEnd());
    return () => {};
  });

  const hook = renderHook(() => useScan());
  await act(async () => {
    await hook.result.current.estimate({ target, mode: 'full_scan' });
  });
  await act(async () => {
    await hook.result.current.confirm();
  });
  return hook;
}

describe('the target a scan remembers', () => {
  it('is the one that was typed, not the one the report prints', async () => {
    const hook = await scanOf(TYPED);
    await waitFor(() => expect(hook.result.current.state.phase).toBe('done'));

    expect(hook.result.current.state.launchedTarget).toBe(TYPED);
    // The two are genuinely different, which is the whole point: the label
    // resolves somewhere else, and the card would have offered that instead.
    expect(hook.result.current.state.snapshot?.target?.label).toBe(LABEL);
    expect(hook.result.current.state.launchedTarget)
      .not.toBe(hook.result.current.state.snapshot?.target?.label);
  });

  it('is nothing at all before a scan has been launched', () => {
    // A target nobody has scanned is not a target to name on an alert.
    const hook = renderHook(() => useScan());
    expect(hook.result.current.state.launchedTarget).toBeNull();
  });
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

describe('what the promote button puts on the alert', () => {
  it('sends the scanned target through, byte for byte', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200, json: async () => ({ ok: true, response: 'It entered the triage queue.' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    render(<FindingCard finding={FINDING} scanRunId="scan-001" scanTarget={TYPED} />);
    await userEvent.click(screen.getByRole('button', { name: /send to the triage queue/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock as unknown as { mock: { calls: [string, { body: string }][] } })
        .mock.calls[0][1].body,
    );
    expect(body.target).toBe(TYPED);
  });
});

/**
 * The whole loop, through the tab that actually wires it.
 *
 * The two tests above check the ends: the hook remembers what was typed, and
 * the card sends what it is handed. Neither of them would notice `ReportView`
 * being handed `target.label` again by the section in between — which is the
 * shape the defect had in the first place, and the one line of this change
 * that nothing else covers.
 */
describe('a scan run in the Code tab, then a finding sent to the queue', () => {
  const ESTIMATE = {
    target: { kind: 'directory', label: LABEL, files_indexed: 42, routes_found: 8 },
    mode: 'full_scan',
    routes_selected: 8, routes_free: 3, routes_billed: 5,
    llm_calls: { detection: 5, arbitration: { low: 0, high: 1 }, total: { low: 5, high: 6 } },
    tokens: { input: 5000, output: { low: 3500, high: 4400 }, total: { low: 8500, high: 9400 } },
    duration_s: { low: 25, high: 50 },
    cost: { usd: null, free: false, unknown_reason: 'no rate configured' },
    sampled: false, sample_size: 8, assumptions: [], warnings: [],
    plain_language_summary: 'We are going to check 8 addresses.',
  };

  const REPORT = {
    scan_summary: {
      total_findings: 1, critical: 1, warning: 0,
      dismissed_by_arbiter: 0, not_arbitrated: 0,
      plain_language_intro: 'One thing to fix.',
    },
    findings: [FINDING],
    dismissed: [],
    source_root: '/srv/src/orders-api',
  };

  it('puts the typed target on the alert, never the report header label', async () => {
    vi.spyOn(api, 'estimateScan').mockResolvedValue({
      estimate_id: 'est-1', estimate: ESTIMATE,
    } as never);
    vi.spyOn(api, 'launchScan').mockResolvedValue({ run_id: 'run-1', notes: [] } as never);
    vi.spyOn(api, 'getRun').mockResolvedValue({ ...snapshot(), report: REPORT } as never);
    vi.spyOn(api, 'streamEvents').mockImplementation((_id, handlers) => {
      queueMicrotask(() => handlers.onEnd());
      return () => {};
    });
    const fetchMock = vi.fn(async () => ({
      status: 200, json: async () => ({ ok: true, response: 'It entered the triage queue.' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    plainRender(
      <ThemeProvider>
        <I18nProvider initialLocale={DEFAULT_LOCALE}>
          <VulnPipeSection prefill={null} />
        </I18nProvider>
      </ThemeProvider>,
    );

    const field = document.querySelector('#vp-target') as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, TYPED);
    await userEvent.click(screen.getByRole('button', { name: 'Estimate, then analyze' }));

    // The estimate is a price, and accepting one is the spend. It stays a
    // click here too, exactly as it is for an operator.
    const confirm = await screen.findByRole('button', { name: 'Start the analysis' });
    await userEvent.click(confirm);

    const promote = await screen.findByRole(
      'button', { name: /send to the triage queue/i }, { timeout: 4000 },
    );
    await userEvent.click(promote);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock as unknown as { mock: { calls: [string, { body: string }][] } })
        .mock.calls[0][1].body,
    );
    expect(body.target).toBe(TYPED);
    expect(body.target).not.toBe(LABEL);
  });
});
