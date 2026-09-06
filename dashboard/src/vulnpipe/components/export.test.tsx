/**
 * @vitest-environment jsdom
 */
/**
 * Tests de l'export du rapport (point 4 du `ROADMAP.md`).
 *
 * Ce qui compte, et qui n'est pas cosmétique :
 *   - l'ordre du document : le langage simple AVANT le jargon, comme à l'écran ;
 *   - les alertes écartées restent comptées, jamais passées sous silence ;
 *   - AUCUN chemin absolu ne fuit dans un document fait pour être partagé ;
 *   - un fichier analysé contenant ``` ne doit pas casser le document ;
 *   - un échec de copie doit se voir.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { ReportExport, type ReportFinding, type SecurityReport } from './ReportView.tsx';
import { fenceFor, reportFileName, reportToMarkdown } from '../lib/report-markdown.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FINDING: ReportFinding = {
  severity: 'critical',
  report_level: 'critical',
  vulnerability: 'IDOR',
  route: '/orders/:id',
  http_method: 'GET',
  file: 'src/order.service.ts',
  line: 3,
  claude_verdict: 'confirmed',
  claude_reasoning: 'Lecture par identifiant sans filtre de propriétaire.',
  technical_summary: 'findById(id) sans filtre userId.',
  plain_language_summary:
    "N'importe qui peut lire les commandes d'un autre en changeant le numéro dans l'adresse.",
  suggested_fix_direction: 'Vérifier que la commande appartient à la personne connectée.',
  owasp_category: 'A01:2021 – Broken Access Control',
  evidence: 'code',
  local_confidence_score: 0.9,
  detected_by: ['idor'],
  code_excerpt: {
    start_line: 2,
    lines: ['  async findById(id: string) {', '    return this.db.orders.findOne({ id });'],
    highlight_line: 3,
    truncated: false,
  },
};

const REPORT: SecurityReport = {
  scan_summary: {
    total_findings: 1,
    critical: 1,
    warning: 0,
    dismissed_by_arbiter: 2,
    not_arbitrated: 0,
    plain_language_intro: "On a trouvé 1 point d'attention sur ton application.",
  },
  findings: [FINDING],
  dismissed: [],
  source_root: '/Users/prenom/projets/mon-app',
};

const AT = new Date('2026-08-19T10:00:00Z');

// ===========================================================================
// Le document
// ===========================================================================

describe('Rapport en Markdown', () => {
  it('met le langage simple avant le détail technique', () => {
    const md = reportToMarkdown(REPORT, 'en', { generatedAt: AT });

    const plain = md.indexOf(FINDING.plain_language_summary);
    const technical = md.indexOf(FINDING.technical_summary);
    expect(plain).toBeGreaterThan(-1);
    expect(technical).toBeGreaterThan(-1);
    // L'ordre de l'écran est l'ordre du document : sinon l'export annule le
    // travail d'explicabilité.
    expect(plain).toBeLessThan(technical);
  });

  it('reprend le résumé, les compteurs et la piste de correction', () => {
    const md = reportToMarkdown(REPORT, 'en', { generatedAt: AT });
    expect(md).toContain(REPORT.scan_summary.plain_language_intro);
    expect(md).toContain('**1** to fix quickly');
    expect(md).toContain(FINDING.suggested_fix_direction);
    expect(md).toContain('GET /orders/:id');
  });

  it('compte les fausses alertes écartées au lieu de les taire', () => {
    const md = reportToMarkdown(REPORT, 'en', { generatedAt: AT });
    expect(md).toContain('2 false alarm');
  });

  it('ne laisse fuir AUCUN chemin absolu', () => {
    // Le document est fait pour être partagé : `/Users/prenom/...` révèle le
    // nom de la personne et l'arborescence de sa machine.
    const md = reportToMarkdown(REPORT, 'en', {
      generatedAt: AT,
      targetLabel: 'projets/mon-app',
    });
    expect(md).not.toContain('/Users/prenom');
    expect(md).not.toContain(REPORT.source_root!);
    // Le libellé court, lui, est utile et inoffensif.
    expect(md).toContain('projets/mon-app');
  });

  it('signale un point qui n a pas pu être revérifié', () => {
    const md = reportToMarkdown(
      { ...REPORT, findings: [{ ...FINDING, claude_verdict: 'needs_human_review' }] },
      'en',
      { generatedAt: AT }
    );
    expect(md).toMatch(/could not be double-checked/i);
  });

  it('dit clairement quand il n y a rien à signaler', () => {
    const md = reportToMarkdown(
      {
        ...REPORT,
        scan_summary: { ...REPORT.scan_summary, total_findings: 0, critical: 0, warning: 0 },
        findings: [],
      },
      'en',
      { generatedAt: AT }
    );
    expect(md).toContain('No issue');
  });

  it('renders in English', () => {
    // The catalogue is down to one locale; the machinery stays because it is
    // what keeps user-facing strings out of the components.
    expect(reportToMarkdown(REPORT, 'en', { generatedAt: AT })).toContain('# Security report');
  });

  it('ne contient aucun JSON brut', () => {
    // Règle produit : l'utilisateur ne doit jamais lire de JSON technique.
    const md = reportToMarkdown(REPORT, 'en', { generatedAt: AT });
    expect(md).not.toContain('"confidence_score"');
    expect(md).not.toContain('local_confidence_score');
  });
});

// ===========================================================================
// Le piège du bloc de code
// ===========================================================================

describe('Clôture de bloc de code', () => {
  it('choisit une clôture plus longue que le contenu', () => {
    expect(fenceFor('const a = 1;')).toBe('```');
    expect(fenceFor('voici ``` un bloc')).toBe('````');
    expect(fenceFor('et ````` cinq')).toBe('``````');
  });

  it('un fichier analysé contenant ``` ne casse pas le document', () => {
    // Le code vient d'un dépôt inconnu : un README embarqué dans une chaîne
    // refermerait le bloc en plein milieu et le reste du rapport
    // s'afficherait comme du code.
    const piege: ReportFinding = {
      ...FINDING,
      code_excerpt: {
        start_line: 1,
        lines: ['const doc = "```js";'],
        highlight_line: 1,
        truncated: false,
      },
    };
    const md = reportToMarkdown({ ...REPORT, findings: [piege] }, 'en', { generatedAt: AT });

    const fence = '````';
    expect(md).toContain(`${fence}\n`);
    // Le contenu est bien à l'intérieur, et le document se termine par le
    // pied de page : rien n'a été avalé par le bloc.
    expect(md).toContain('const doc = "```js";');
    expect(md.trimEnd().endsWith('_')).toBe(true);
  });
});

// ===========================================================================
// Nom de fichier
// ===========================================================================

describe('Nom du fichier téléchargé', () => {
  it('est daté, sans espace ni accent', () => {
    expect(reportFileName({ targetLabel: 'Mon Àpp/Api', generatedAt: AT })).toBe(
      'vulnpipe-mon-app-api-2026-08-19.md'
    );
  });

  it('reste valide sans libellé de cible', () => {
    expect(reportFileName({ generatedAt: AT })).toBe('vulnpipe-scan-2026-08-19.md');
  });
});

// ===========================================================================
// Les boutons
// ===========================================================================

describe('Boutons d export', () => {
  it('copie le rapport au clic', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<ReportExport report={REPORT} meta={{ targetLabel: 'mon-app', generatedAt: AT }} />);
    await userEvent.click(screen.getByRole('button', { name: /copy the report/i }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]![0]).toContain('# Security report');
    expect(await screen.findByText(/report copied/i)).toBeTruthy();
  });

  it('AFFICHE l échec de copie au lieu de ne rien faire', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('refusé')) },
    });

    render(<ReportExport report={REPORT} meta={{ generatedAt: AT }} />);
    await userEvent.click(screen.getByRole('button', { name: /copy the report/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('propose le téléchargement sous un nom daté, et libère la mémoire', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:faux');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    let downloaded: string | null = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      downloaded = this.download;
    };

    try {
      render(<ReportExport report={REPORT} meta={{ targetLabel: 'mon-app', generatedAt: AT }} />);
      await userEvent.click(screen.getByRole('button', { name: /download/i }));
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }

    expect(downloaded).toBe('vulnpipe-mon-app-2026-08-19.md');
    // Sans révocation, chaque export garderait le rapport en mémoire jusqu'au
    // rechargement de la page.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:faux');
  });
});
