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

import { render } from '../vulnpipe/test-utils.tsx';
import { CaseView } from './CaseView.tsx';
import type { AlertCase } from '../lib/types.ts';

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
});
