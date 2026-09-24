/**
 * @vitest-environment jsdom
 */
/**
 * Tests de la carte d'incident.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * C'est l'écran sur lequel un humain approuve ou refuse une action. Ce qu'il
 * montre des OBSERVABLES décide de ce que cette personne croit savoir, et deux
 * façons de se tromper n'y lèvent aucune erreur :
 *
 *   - taire un champ absent, ce qui le fait passer pour inexistant plutôt que
 *     pour vide — alors que « la donnée manquante est montrée comme
 *     manquante » ;
 *   - taire l'HÔTE, qui est la machine qu'une isolation viserait quand
 *     l'alerte ne porte pas d'adresse de destination. C'est le cas le plus
 *     courant, et c'était le cas jusqu'ici : le champ n'existait nulle part,
 *     ni dans le modèle, ni à l'écran.
 * ============================================================================
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { CaseView } from './CaseView.tsx';
import type { AlertCase, Approval } from '../lib/types.ts';

afterEach(cleanup);

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-2026-0823-0412',
    received_at: '2026-08-23T11:54:07.000Z',
    state: 'awaiting_approval',
    severity: 'high',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    source_ip: '185.220.101.47',
    dest_ip: '10.12.4.31',
    host: 'srv-bastion-01',
    raw_log: 'Aug 23 11:54:07 web01 sshd[2211]: Accepted password for root',
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

/** Le libellé et sa valeur vivent dans le même `<span>`. */
const fieldValue = (label: string): string => {
  const el = screen.getByText(label).closest('span');
  return (el?.textContent ?? '').replace(label, '').trim();
};

describe("la carte nomme la machine qu'une isolation viserait", () => {
  it("affiche l'hôte à côté des deux adresses", () => {
    render(<CaseView alertCase={kase()} onRefresh={() => {}} />);
    expect(fieldValue('Host')).toBe('srv-bastion-01');
    expect(fieldValue('Source')).toBe('185.220.101.47');
    expect(fieldValue('Destination')).toBe('10.12.4.31');
  });

  it("montre l'hôte absent COMME absent, au lieu de masquer la ligne", () => {
    // Masquer la ligne ferait croire que le champ n'existe pas. Le tiret dit
    // que la détection n'a nommé aucune machine — ce qui est précisément ce
    // qu'un approbateur doit savoir avant d'autoriser une isolation.
    render(<CaseView alertCase={kase({ host: null })} onRefresh={() => {}} />);
    expect(screen.getByText('Host')).toBeTruthy();
    expect(fieldValue('Host')).toBe('—');
  });

  it("n'invente pas d'hôte à partir de l'adresse de destination", () => {
    // Les deux champs répondent à deux questions différentes. Recopier l'une
    // dans l'autre donnerait une cible d'isolation qui n'a jamais été observée.
    render(<CaseView alertCase={kase({ host: null, dest_ip: '10.12.4.31' })} onRefresh={() => {}} />);
    expect(fieldValue('Host')).toBe('—');
    expect(fieldValue('Destination')).toBe('10.12.4.31');
  });
});

describe("l'identité de l'alerte est lisible sans dépliage", () => {
  it("porte l'identifiant et la règle qui a déclenché", () => {
    render(<CaseView alertCase={kase()} onRefresh={() => {}} />);
    expect(fieldValue('Id')).toBe('ALT-2026-0823-0412');
    expect(
      screen.getByText('Multiple failed SSH logins followed by successful auth'),
    ).toBeTruthy();
  });
});

/**
 * J0.3 — the card names the code that runs on this machine.
 *
 * Two failures are possible here and neither raises an error:
 *
 *   - saying WHICH repository without saying WHAT matched, which makes the
 *     claim uncheckable at the moment it matters most;
 *   - printing "not in the inventory" on a card of an install that has not
 *     filled the table in, which puts a line nobody can act on at the top of
 *     every incident.
 */
describe('the code that runs on the machine', () => {
  const withRepo = () =>
    kase({
      repository: {
        service: 'orders-api',
        repository: '/srv/src/orders-api',
        matched_on: 'host',
        matched_value: 'srv-bastion-01',
      },
    });

  it('names the service, the target, and what matched', () => {
    render(<CaseView alertCase={withRepo()} onRefresh={() => {}} />);
    expect(screen.getByText('orders-api')).toBeTruthy();
    expect(screen.getByText('/srv/src/orders-api')).toBeTruthy();
    // The value that matched sits in the SAME sentence as the field that
    // matched: "matched on the host" alone would not say on which host, and
    // the hostname alone is already elsewhere on the card.
    expect(screen.getByText(/matched on the host/).textContent).toContain('srv-bastion-01');
  });

  it('says NOTHING when the inventory knows nothing about the machine', () => {
    render(<CaseView alertCase={kase({ repository: null })} onRefresh={() => {}} />);
    expect(screen.queryByText('Code running here')).toBeNull();
  });

  it('hands the repository over, and starts no scan', () => {
    const asked: string[] = [];
    render(
      <CaseView alertCase={withRepo()} onRefresh={() => {}} onAnalyse={(r) => asked.push(r)} />,
    );
    const button = screen.getByRole('button', { name: /Analyse this code/ });
    button.click();
    // The button PREPARES an analysis. Launching one is spending money, and it
    // stays the operator's click on the Code tab.
    expect(asked).toEqual(['/srv/src/orders-api']);
  });

  it('keeps the information when there is nowhere to jump to', () => {
    // Same rule as the Lookup jump above it: the fact is worth showing even
    // where the destination tab is not reachable.
    render(<CaseView alertCase={withRepo()} onRefresh={() => {}} />);
    expect(screen.getByText('/srv/src/orders-api')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Analyse this code/ })).toBeNull();
  });

  /**
   * J0.1's other half — a case opened by promoting a scan finding. It has no
   * host, so nothing above could ever have named it; what names it is the scan
   * it came out of.
   */
  describe('when the case came out of a scan', () => {
    const fromScan = () =>
      kase({
        host: null,
        repository: {
          service: null,
          repository: '/srv/src/orders-api',
          matched_on: 'scan_target' as const,
          matched_value: 'scan-77',
        },
      });

    it('names the scan rather than claiming an observable matched', () => {
      render(<CaseView alertCase={fromScan()} onRefresh={() => {}} />);
      expect(screen.getByText('/srv/src/orders-api')).toBeTruthy();
      // "matched on …" would send somebody looking for the observable that did
      // it, and this case carries none.
      expect(screen.queryByText(/matched on/)).toBeNull();
      expect(screen.getByText(/the scan this case came from/).textContent)
        .toContain('scan-77');
    });

    it('prints no service, rather than the target a second time', () => {
      const { container } = render(<CaseView alertCase={fromScan()} onRefresh={() => {}} />);
      // Nobody has told us what this service is called: the inventory holds
      // that name and is keyed on machines this alert does not have.
      expect(container.querySelector('.soc-inv-service')).toBeNull();
      expect(container.querySelectorAll('.soc-inv-target')).toHaveLength(1);
    });

    it('hands the scanned target to the Code tab, and starts nothing', () => {
      const asked: string[] = [];
      render(
        <CaseView alertCase={fromScan()} onRefresh={() => {}} onAnalyse={(r) => asked.push(r)} />,
      );
      screen.getByRole('button', { name: /Analyse this code/ }).click();
      expect(asked).toEqual(['/srv/src/orders-api']);
    });
  });
});

/* ==========================================================================
 * THE APPROVAL BANNER, WHOSE "ACCEPTED" BRANCH HAD NEVER RENDERED
 *
 * These cases are written by hand on purpose, and that is safe HERE: the
 * boundary under test is `AlertCase` → screen, and `AlertCase` is a declared
 * type. The boundary that a hand-written fixture cannot police is the one
 * above it — a node's output → `AlertCase` — and that is why the approval is
 * driven through the real pipeline in `engine/pipeline-to-case.test.ts`.
 *
 * It mattered: `cases.ts` read the settled approval under names the transform
 * does not write, so `outcome` was `rejected` for every answer a human gave,
 * `approver` was `null` and `triggers` was empty. Everything below rendered
 * one way and only one way — an orange warning saying "Declined by unknown",
 * with no reason and no list of why the person had been asked.
 * ========================================================================== */

const APPROVED: Approval = {
  requested_action: 'isolate_host_temporary',
  intent: 'Isolate srv-bastion-01 while the session is investigated.',
  blast_radius: 'The host loses network access. Sessions are cut.',
  rollback_plan: 'Reverts by itself after the TTL, or by hand.',
  triggers: ['confidence 0.71 < 0.85', 'a containment action is proposed'],
  outcome: 'approved',
  approver: {
    slack_username: 'alice', slack_user_id: null,
    responded_at: '2026-08-23T12:01:00.000Z',
    identity_source: 'console_self_declared', signature_verified: false,
  },
  human_reasoning: 'Confirmed with the owner: this login was not theirs.',
  timeout_minutes: 45,
  requested_at: '2026-08-23T11:55:00.000Z',
};

describe('an answered approval says what the human actually answered', () => {
  it('reads as accepted, by the person who accepted it, for their reason', () => {
    render(<CaseView alertCase={kase({ state: 'closed', executed: true, approval: APPROVED })} onRefresh={() => {}} />);

    expect(screen.getByText('Accepted by alice')).toBeTruthy();
    expect(screen.getByText(/Confirmed with the owner/)).toBeTruthy();
    // The two sentences the card used to show instead, on every approval.
    expect(screen.queryByText('Declined by unknown')).toBeNull();
    expect(screen.queryByText('No reason given.')).toBeNull();
  });

  it('shows why the person was asked, which is the case for asking them', () => {
    render(<CaseView alertCase={kase({ state: 'closed', executed: true, approval: APPROVED })} onRefresh={() => {}} />);

    expect(screen.getByText('Why you are being asked')).toBeTruthy();
    expect(screen.getByText(/confidence 0.71 < 0.85/)).toBeTruthy();
  });

  it('still reads as declined when it was declined', () => {
    // The control: the defect was a constant, so the fix must not be one.
    const declined: Approval = { ...APPROVED, outcome: 'rejected' };
    render(<CaseView alertCase={kase({ state: 'closed', approval: declined })} onRefresh={() => {}} />);

    expect(screen.getByText('Declined by alice')).toBeTruthy();
    expect(screen.queryByText('Accepted by alice')).toBeNull();
  });
});

/* ==========================================================================
 * THE BUTTONS THEMSELVES, WHICH WERE DISABLED ON EVERY REAL CASE
 *
 * `canSubmit = approver.trim().length > 0 && Boolean(execId) && !busy`, with
 * `execId = approval.execution_id` — a field `cases.ts` never wrote. So on a
 * real install both controls rendered `disabled` however carefully the
 * operator filled the form, and NOTHING said why: the other term of that
 * `&&` is their own name, so a greyed-out button reads as "you have not
 * finished typing". Only `demo.ts` set the field, which is why the screen
 * looked right in demonstration mode and only there.
 *
 * These two tests claim opposite sides of the same `&&`, on purpose: the fix
 * is a field that must be PRESENT, so a test that only checks the enabled
 * case would pass just as well against a component that ignores it.
 * ========================================================================== */

const PENDING: Approval = {
  ...APPROVED,
  outcome: 'pending',
  approver: null,
  human_reasoning: null,
  execution_id: '244e34dc-a79a-4cd8-85be-49d16785e124',
};

describe('an approval waiting on a human can actually be answered', () => {
  it('enables both controls once the operator has named themselves', async () => {
    const user = userEvent.setup();
    render(<CaseView alertCase={kase({ approval: PENDING })} onRefresh={() => {}} />);

    const accept = screen.getByRole('button', { name: /Accept/ });
    const refuse = screen.getByRole('button', { name: /Decline/ });
    // Before a name: correctly refused, and that half always worked.
    expect((accept as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByPlaceholderText('@first.last'), 'alice');

    expect((accept as HTMLButtonElement).disabled).toBe(false);
    expect((refuse as HTMLButtonElement).disabled).toBe(false);
  });

  it('is still refused when the case carries no execution to answer', async () => {
    // The control, and the state every real case was in. Written out because
    // the two reasons a button is disabled are indistinguishable on screen.
    const user = userEvent.setup();
    const orphaned: Approval = { ...PENDING, execution_id: null };
    render(<CaseView alertCase={kase({ approval: orphaned })} onRefresh={() => {}} />);

    await user.type(screen.getByPlaceholderText('@first.last'), 'alice');

    expect((screen.getByRole('button', { name: /Accept/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
