/**
 * @vitest-environment jsdom
 */
/**
 * J0.4 — what the system view must show, and what it must not claim.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * An overview is a claim about coverage, and the dangerous failure of one is
 * silent: it renders, it looks calm, and it is calm about something nobody
 * looked at. Four of the claims below would break with no error anywhere.
 *
 *  - **The join**: a machine's alerts and its code's flaws in ONE block is the
 *    whole feature. Rendered as two, every block is half a story and the
 *    screen counts twice as many systems as there are.
 *  - **The scope sentence**: the flaw half is read out of the QUEUE, not out
 *    of scan reports. Behind a fold, it becomes an empty list that reads as
 *    "this code is clean" — the reassurance over a hole this product refuses
 *    everywhere else.
 *  - **No green on an absence.** A check mark next to "no flaw promoted" would
 *    congratulate a scan nobody ran.
 *  - **The unattributed count**: cases naming neither a machine nor any code
 *    are in the queue and not on this screen, and an overview that omits part
 *    of the queue without saying so is the failure that shows green.
 *
 * Two tests claim a BOUNDARY and pass before this screen existed as much as
 * after: nothing standing goes in a live region, and the code line is absent
 * when nothing named the code. They are here to stop the next change from
 * quietly crossing either.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { SystemPanel } from './SystemPanel.tsx';
import { consoleDictionary } from '../i18n/console.ts';
import type { AlertCase, Severity } from '../lib/types.ts';
import { findingToAlert, scanRepository } from '../../server/findings.ts';
import { resolveRepository } from '../../server/inventory.ts';

afterEach(cleanup);

const t = consoleDictionary('en').systems;

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-1',
    received_at: new Date().toISOString(),
    state: 'closed',
    severity: 'medium' as Severity,
    rule_name: 'Something happened',
    source_ip: '185.220.101.47',
    dest_ip: '—',
    host: null,
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

const INVENTORY = [
  { service: 'Billing API', identifiers: ['web-01'], repository: '/srv/src/billing-api' },
];

/** A detection about a machine, resolved by the real inventory resolver. */
function detection(over: Partial<AlertCase> = {}): AlertCase {
  const c = kase(over);
  return { ...c, repository: resolveRepository(c, INVENTORY) };
}

/** A case opened by promoting a finding, through the real promote pair. */
function promoted(target: string): AlertCase {
  const outcome = findingToAlert(
    {
      scan_run_id: 'run-1',
      target,
      finding: {
        vulnerability: 'IDOR', http_method: 'GET', route: '/orders/:id',
        file: 'src/routes/orders.ts', severity: 'high',
      },
    },
    new Date(),
  );
  if (!outcome.ok) throw new Error(outcome.errors.join(', '));
  const alert = outcome.alert as Record<string, unknown>;
  const c = kase({
    alert_id: outcome.alert_id,
    rule_name: alert.rule_name as string,
    severity: 'high',
    extensions: alert.extensions as Record<string, unknown>,
  });
  return { ...c, repository: scanRepository(c) };
}

describe('the two halves of one system are on one screen', () => {
  it('shows the alert about the machine and the flaw in its code together', () => {
    render(
      <SystemPanel
        cases={[
          detection({ alert_id: 'ALT-A', host: 'web-01', rule_name: 'Failed SSH logins' }),
          promoted('/srv/src/billing-api'),
        ]}
        onSelect={() => {}}
      />,
    );

    // One system, named by the inventory, carrying both lists.
    expect(screen.getByRole('heading', { level: 3, name: 'Billing API' })).toBeTruthy();
    expect(screen.getByText(t.shown(1))).toBeTruthy();
    expect(screen.getByText(t.alertsLabel(1))).toBeTruthy();
    expect(screen.getByText(t.flawsLabel(1))).toBeTruthy();
    expect(screen.getByText('Failed SSH logins')).toBeTruthy();
    expect(screen.getByText('IDOR in GET /orders/:id')).toBeTruthy();
    expect(screen.getByText('/srv/src/billing-api')).toBeTruthy();
    expect(screen.getByText('web-01')).toBeTruthy();
  });

  it('opens the case a row names', async () => {
    const onSelect = vi.fn();
    render(
      <SystemPanel
        cases={[detection({ alert_id: 'ALT-A', host: 'web-01', rule_name: 'Failed SSH logins' })]}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Failed SSH logins/ }));
    expect(onSelect).toHaveBeenCalledWith('ALT-A');
  });

  it('names the system on the analyse button, which repeats once per block', async () => {
    // A control that repeats per row must say WHICH row: twenty identical
    // "Analyse this code" buttons name nothing, and one of them opens the
    // wrong repository.
    const onAnalyse = vi.fn();
    render(
      <SystemPanel
        cases={[
          detection({ alert_id: 'ALT-A', host: 'web-01' }),
          promoted('acme/checkout'),
        ]}
        onSelect={() => {}}
        onAnalyse={onAnalyse}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: t.analyseLabel('acme/checkout') }),
    );
    expect(onAnalyse).toHaveBeenCalledWith('acme/checkout');
    expect(screen.getByRole('button', { name: t.analyseLabel('Billing API') })).toBeTruthy();
  });
});

describe('what the screen refuses to claim', () => {
  it('states what the flaw half covers, in the clear', () => {
    render(<SystemPanel cases={[detection({ host: 'web-01' })]} onSelect={() => {}} />);
    const scope = screen.getByText(t.scope);
    // IN THE CLEAR, not behind the disc: an empty flaw list with its scope
    // folded reads as "this code is clean", about a scan nobody ran.
    expect(scope.closest('details')).toBeNull();
  });

  it('takes no green on an empty flaw list', () => {
    render(<SystemPanel cases={[detection({ host: 'web-01' })]} onSelect={() => {}} />);
    const line = screen.getByText(t.noFlaws);
    expect(line.className).toContain('soc-quiet');
    // `soc-quiet-ok` is what draws the green check. Green means "everything
    // was read and nothing found"; here nothing was read.
    expect(line.className).not.toContain('soc-quiet-ok');
  });

  it('counts the cases it could not attribute, instead of dropping them', () => {
    render(
      <SystemPanel
        cases={[
          detection({ alert_id: 'ALT-A', host: 'web-01' }),
          kase({ alert_id: 'ALT-B' }),
          kase({ alert_id: 'ALT-C' }),
        ]}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(t.unattributed(2))).toBeTruthy();
  });

  it('says why the flaw half is empty when nothing maps the machine to code', () => {
    // Two states, two sentences. "None promoted" is a claim about what people
    // did; on a machine the inventory says nothing about, we could not have
    // listed a flaw at all, and a sentence must not be reachable from a state
    // it does not describe.
    render(
      <SystemPanel
        cases={[
          detection({ alert_id: 'ALT-A', host: 'web-01' }),
          kase({ alert_id: 'ALT-B', host: 'db-07' }),
        ]}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(t.noCodeMapped)).toBeTruthy();
    expect(screen.getByText(t.noFlaws)).toBeTruthy();
  });

  it('says nothing about the code when nothing named it', () => {
    // The boundary J0.3 drew: an install that has not filled the inventory in
    // must not carry a line nobody can act on on every block.
    const { container } = render(
      <SystemPanel
        cases={[kase({ alert_id: 'ALT-A', host: 'db-07' })]}
        onSelect={() => {}}
        onAnalyse={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'db-07' })).toBeTruthy();
    expect(container.querySelector('.soc-sys-target')).toBeNull();
    expect(screen.queryByText(t.code)).toBeNull();
    expect(screen.queryByRole('button', { name: t.analyseLabel('db-07') })).toBeNull();
  });

  it('puts nothing standing in a live region', () => {
    // The console re-renders on every poll. A standing condition inside a
    // region is announced for as long as it lasts, and a permanent alarm
    // stops being read — the rule the diagnostic probe already taught this
    // product. Nothing on this screen is produced by pressing a button.
    const { container } = render(
      <SystemPanel
        cases={[detection({ host: 'web-01' }), kase({ alert_id: 'ALT-B' })]}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('says the window is empty rather than showing an empty list', () => {
    render(<SystemPanel cases={[]} onSelect={() => {}} />);
    expect(screen.getByText(t.empty)).toBeTruthy();
    expect(screen.getByText(t.shown(0))).toBeTruthy();
  });
});
