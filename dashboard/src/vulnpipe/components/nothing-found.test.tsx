/**
 * @vitest-environment jsdom
 */
/**
 * L'ecran « aucune faille trouvee ».
 *
 * ============================================================================
 * CE QUE CES TESTS PROTEGENT
 *
 * C'est le seul ecran de ce produit dont le contenu est une ABSENCE, et une
 * absence se raconte de trois facons qui n'ont pas la meme valeur :
 *
 *   « on a tout lu, il n'y a rien »            — un resultat ;
 *   « on n'a pas pu tout lire, dans le reste
 *      il n'y a rien »                         — un resultat partiel ;
 *   « on a relu ce qui a change, il n'y a
 *      rien de nouveau »                       — ne dit rien du projet.
 *
 * La version d'avant les affichait avec LA MEME PHRASE et LE MEME VERT. C'est
 * la faute que l'onglet Suivi existe pour exposer, transposee dans l'autre
 * moitie du produit : un trou qui s'affiche vert.
 *
 * Les tests reclament donc, dans l'ordre : que le titre change quand la
 * couverture est partielle, que la cause soit nommee, et que l'ecran REFUSE
 * de se prononcer quand il ne sait pas ce qu'il a couvert.
 * ============================================================================
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { render } from '../test-utils.tsx';
import { NothingFound, ReportView, type ScanCoverage } from './ReportView.tsx';
import type { ReportFinding, SecurityReport } from './ReportView.tsx';

afterEach(cleanup);

const coverage = (over: Partial<ScanCoverage> = {}): ScanCoverage => ({
  mode: 'full_scan',
  filesIndexed: 214,
  routesFound: 41,
  routesAnalyzed: 41,
  routesFailed: 0,
  ...over,
});

describe('une couverture complete donne un resultat', () => {
  it('nomme ce qui a ete lu, chiffre par chiffre', () => {
    render(<NothingFound coverage={coverage()} />);
    expect(screen.getByText('No flaw found')).toBeTruthy();
    expect(screen.getByText('214 files indexed')).toBeTruthy();
    expect(screen.getByText('41 addresses found')).toBeTruthy();
    expect(screen.getByText('41 addresses analysed')).toBeTruthy();
    expect(screen.getByText('The whole project')).toBeTruthy();
  });

  it('ne pose aucune reserve quand il n y en a pas', () => {
    const { container } = render(<NothingFound coverage={coverage()} />);
    expect(container.querySelectorAll('.vp-nothing-caveat')).toHaveLength(0);
    expect(container.querySelector('.vp-nothing-partial')).toBeNull();
    expect(container.querySelector('.vp-nothing-clear')).toBeTruthy();
  });
});

describe('une adresse non lue n est pas une adresse propre', () => {
  it('change LE TITRE, pas seulement une note en bas', () => {
    // Le titre est ce qu'on retient. Laisser « aucune faille trouvee » en tete
    // et poser la reserve sous le pli de l'ecran reviendrait a la cacher.
    render(<NothingFound coverage={coverage({ routesFailed: 6, routesAnalyzed: 35 })} />);
    expect(screen.getByText('No flaw found in what we could check')).toBeTruthy();
    expect(screen.queryByText('No flaw found')).toBeNull();
  });

  it('nomme la cause et ce qu elle retire a la phrase', () => {
    render(<NothingFound coverage={coverage({ routesFailed: 6 })} />);
    expect(screen.getByText('6 addresses could not be analysed')).toBeTruthy();
    expect(screen.getByText(/Nothing is known about them/)).toBeTruthy();
  });

  it('bascule la couleur, parce qu elle est lue avant les mots', () => {
    const { container } = render(<NothingFound coverage={coverage({ routesFailed: 1 })} />);
    expect(container.querySelector('.vp-nothing-partial')).toBeTruthy();
  });

  it('le dit AUSSI quand le rapport n est pas vide', () => {
    // Un rapport qui contient une faille et tait douze adresses non lues
    // borne mal ce qu'il couvre : le constat ne depend pas du vide. Le test
    // porte donc une VRAIE faille — sinon il emprunterait le chemin de
    // l'ecran vide et prouverait autre chose que ce qu'il annonce.
    const withFinding: SecurityReport = {
      ...report({ total_findings: 1, critical: 1 }),
      findings: [finding()],
    };
    render(<ReportView report={withFinding} coverage={coverage({ routesFailed: 12 })} />);
    expect(screen.getByText('1 to fix now')).toBeTruthy();
    expect(screen.getByText('12 addresses could not be analysed')).toBeTruthy();
  });
});

describe('un scan incremental ne dit rien du reste du projet', () => {
  it('le titre et la reserve le disent, meme sans aucun echec', () => {
    render(<NothingFound coverage={coverage({ mode: 'incremental_scan' })} />);
    expect(screen.getByText('No flaw found in what we could check')).toBeTruthy();
    expect(screen.getByText(/says nothing about the rest of the project/)).toBeTruthy();
  });
});

describe('une couverture inconnue ne se comble pas', () => {
  it('refuse le titre flatteur et dit qu il ne sait pas', () => {
    // « Aucune faille trouvee » sur un scan qui n'a pas dit ce qu'il a lu
    // serait une conclusion tiree d'une absence de donnee — exactement ce que
    // ce produit refuse partout ailleurs.
    render(<NothingFound coverage={null} />);
    expect(screen.queryByText('No flaw found')).toBeNull();
    expect(screen.getByText('Nothing kept, coverage not reported')).toBeTruthy();
    expect(screen.getByText(/cannot be said here/)).toBeTruthy();
  });

  it('NE PREND PAS LE VERT : il ne rassure pas sur ce qu il ignore', () => {
    // La premiere version prenait le vert par defaut — elle reproduisait,
    // dans l'ecran cense supprimer ce defaut, un trou qui s'affiche vert.
    const { container } = render(<NothingFound coverage={null} />);
    expect(container.querySelector('.vp-nothing-clear')).toBeNull();
    expect(container.querySelector('.vp-nothing-unknown')).toBeTruthy();
  });

  it('ne fabrique pas de chiffre a partir de rien', () => {
    const { container } = render(
      <NothingFound coverage={coverage({ routesAnalyzed: null, filesIndexed: null, routesFound: null, mode: null })} />,
    );
    expect(container.querySelectorAll('.vp-nothing-facts li')).toHaveLength(0);
  });
});

describe('un vide a une raison, et elle se montre', () => {
  it('dit que la seconde relecture a ecarte des candidats', () => {
    // Sans ca, un vide se lit comme « il n'a rien cherche ».
    render(
      <NothingFound
        coverage={coverage()}
        dismissedCount={2}
        dismissed={[
          { vulnerability: 'IDOR', route: '/orders/:id', http_method: 'GET' },
          { vulnerability: 'IDOR', route: '/invoices/:id', http_method: 'GET' },
        ]}
      />,
    );
    expect(screen.getByText(/2 candidates were found and dropped/)).toBeTruthy();
    // La liste est repliee : c'est une piece, pas un constat.
    const item = screen.getByText('/invoices/:id', { exact: false });
    expect(item.closest('details')!.open).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */

function finding(): ReportFinding {
  return {
    severity: 'high',
    report_level: 'critical',
    vulnerability: 'IDOR',
    route: '/orders/:id',
    http_method: 'GET',
    file: 'order.controller.ts',
    line: 12,
    claude_verdict: 'confirmed',
    claude_reasoning: 'No ownership check.',
    technical_summary: 'findById(id) with no userId filter.',
    plain_language_summary: 'Anyone can read another customer order.',
    suggested_fix_direction: 'Filter on the signed-in user.',
    owasp_category: 'A01',
    evidence: 'code',
    local_confidence_score: 0.9,
    detected_by: ['static'],
    code_excerpt: null,
  };
}

function report(over: Partial<SecurityReport['scan_summary']> = {}): SecurityReport {
  return {
    scan_summary: {
      total_findings: 0,
      critical: 0,
      warning: 0,
      dismissed_by_arbiter: 0,
      not_arbitrated: 0,
      plain_language_intro: 'We read the code and kept nothing.',
      ...over,
    },
    findings: [],
    dismissed: [],
    source_root: null,
  };
}
