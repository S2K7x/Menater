/**
 * @vitest-environment jsdom
 */
/**
 * Tests du statut par faille (point 6 du `ROADMAP.md`).
 *
 * Deux tests portent tout le reste :
 *
 *  1. « écarter une faille ne fait PAS monter le taux de correction ». Un outil
 *     dont le score s'améliore quand on écarte des alertes apprend à écarter
 *     des alertes. C'est le piège nommé dans le ROADMAP avant l'écriture du
 *     code, et la seule raison pour laquelle `fixRate` a un dénominateur
 *     particulier.
 *
 *  2. « marquée corrigée mais toujours détectée » doit être signalé. L'outil
 *     regarde le code, la case coche une intention : quand les deux se
 *     contredisent, c'est la case qui a tort.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { FindingCard, StatusSummary, type ReportFinding } from './ReportView.tsx';
import {
  findingKey,
  resetStatuses,
  setStatus,
  statusOf,
  statusStats,
} from '../lib/finding-status.ts';

beforeEach(() => resetStatuses());
afterEach(() => {
  cleanup();
  resetStatuses();
});

function makeFinding(route: string, over: Partial<ReportFinding> = {}): ReportFinding {
  return {
    severity: 'critical',
    report_level: 'critical',
    vulnerability: 'IDOR',
    route,
    http_method: 'GET',
    file: 'src/order.service.ts',
    line: 3,
    claude_verdict: 'confirmed',
    claude_reasoning: 'Lecture par identifiant sans filtre.',
    technical_summary: 'findById(id) sans userId.',
    plain_language_summary: "N'importe qui peut lire les commandes d'un autre.",
    suggested_fix_direction: 'Vérifier le propriétaire.',
    owasp_category: 'A01:2021 – Broken Access Control',
    evidence: 'code',
    local_confidence_score: 0.9,
    detected_by: ['idor'],
    code_excerpt: null,
    ...over,
  };
}

// ===========================================================================
// Le magasin et ses règles
// ===========================================================================

describe('Statuts', () => {
  it('identifie une faille indépendamment de son numéro de ligne', () => {
    // La ligne vient du modèle et bouge à la moindre édition au-dessus :
    // l'inclure ferait réapparaître comme neuve une faille déjà traitée.
    const a = makeFinding('/orders/:id', { line: 3 });
    const b = makeFinding('/orders/:id', { line: 41 });
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it('EXIGE une justification pour écarter, pas pour corriger', () => {
    const key = findingKey(makeFinding('/orders/:id'));

    // « Corrigé » : le scan suivant vérifiera tout seul.
    expect(setStatus(key, 'fixed')).toBe(true);
    expect(statusOf(key).status).toBe('fixed');

    // « Risque accepté » sans explication : refusé, et l'ancien statut tient.
    expect(setStatus(key, 'accepted', '   ')).toBe(false);
    expect(statusOf(key).status).toBe('fixed');

    expect(setStatus(key, 'accepted', 'Route interne, non exposée.')).toBe(true);
    expect(statusOf(key).note).toBe('Route interne, non exposée.');
  });

  it('revenir à « à traiter » efface la décision', () => {
    const key = findingKey(makeFinding('/orders/:id'));
    setStatus(key, 'false_positive', 'Le guard est ailleurs.');
    setStatus(key, 'open');
    expect(statusOf(key).status).toBe('open');
    expect(statusOf(key).note).toBe('');
  });
});

// ===========================================================================
// LE test : écarter ne doit pas améliorer le score
// ===========================================================================

describe('Taux de correction', () => {
  it("n'augmente PAS quand on écarte une faille", () => {
    const findings = [makeFinding('/a'), makeFinding('/b'), makeFinding('/c'), makeFinding('/d')];

    // Départ : 1 corrigée sur 4 à traiter.
    setStatus(findingKey(findings[0]!), 'fixed');
    const before = statusStats(findings);
    expect(before.fixRate).toBeCloseTo(0.25);

    // On écarte deux points. Ils sortent du numérateur ET du dénominateur :
    // le taux ne bouge pas d'un pouce.
    setStatus(findingKey(findings[1]!), 'accepted', 'Risque assumé.');
    setStatus(findingKey(findings[2]!), 'false_positive', 'Faux positif avéré.');

    const after = statusStats(findings);
    expect(after.fixRate).toBeCloseTo(0.5); // 1 corrigée / (1 corrigée + 1 restante)
    expect(after.accepted).toBe(1);
    expect(after.falsePositive).toBe(1);

    // Et surtout : écarter la DERNIÈRE faille restante ne donne pas 100 %.
    setStatus(findingKey(findings[3]!), 'accepted', 'Assumé aussi.');
    expect(statusStats(findings).fixRate).toBeCloseTo(1 / 1);
    // 1 corrigée sur 1 à traiter : la seule façon d'atteindre 100 % est bien
    // d'avoir corrigé tout ce qui restait à traiter, pas de l'avoir écarté.
    expect(statusStats(findings).open).toBe(0);
    expect(statusStats(findings).fixed).toBe(1);
  });

  it('ne félicite pas sur zéro faille', () => {
    // « 100 % corrigé » sur un rapport sans rien à traiter est une
    // félicitation vide de sens.
    expect(statusStats([]).fixRate).toBeNull();
  });

  it('compte les corrigées-mais-toujours-détectées', () => {
    const findings = [makeFinding('/a')];
    setStatus(findingKey(findings[0]!), 'fixed');
    // Elle est dans le rapport COURANT : donc encore détectée.
    expect(statusStats(findings).stale).toBe(1);
  });
});

// ===========================================================================
// L'écran
// ===========================================================================

describe('Statut à l écran', () => {
  it('permet de marquer corrigé en un clic', async () => {
    const finding = makeFinding('/orders/:id');
    render(<FindingCard finding={finding} />);

    await userEvent.click(screen.getByRole('button', { name: 'fixed' }));
    expect(statusOf(findingKey(finding)).status).toBe('fixed');
  });

  it('demande la justification avant d écarter, et refuse le vide', async () => {
    const finding = makeFinding('/orders/:id');
    render(<FindingCard finding={finding} />);

    await userEvent.click(screen.getByRole('button', { name: 'risk accepted' }));
    // Rien n'est enregistré tant que la raison n'est pas donnée.
    expect(statusOf(findingKey(finding)).status).toBe('open');

    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(statusOf(findingKey(finding)).status).toBe('open');

    await userEvent.type(screen.getByRole('textbox'), 'Route interne, jamais exposée.');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(statusOf(findingKey(finding)).status).toBe('accepted');
    expect(screen.getByText('Route interne, jamais exposée.')).toBeTruthy();
  });

  it('AVERTIT quand une faille marquée corrigée est encore détectée', async () => {
    const finding = makeFinding('/orders/:id');
    setStatus(findingKey(finding), 'fixed');
    render(<FindingCard finding={finding} />);

    expect(screen.getByRole('alert').textContent).toMatch(/still finds it/i);
  });

  it('estompe une faille écartée mais ne la RETIRE PAS', () => {
    const finding = makeFinding('/orders/:id');
    setStatus(findingKey(finding), 'accepted', 'Assumé.');
    const { container } = render(<FindingCard finding={finding} />);

    expect(container.querySelector('.vp-finding-aside')).not.toBeNull();
    // Toujours lisible : masquer offrirait un moyen de faire disparaître un
    // problème de l'écran sans l'avoir traité.
    expect(screen.getByText(finding.plain_language_summary)).toBeTruthy();
  });

  it('affiche le taux, et dit que les écartés n y comptent pas', () => {
    const findings = [makeFinding('/a'), makeFinding('/b')];
    setStatus(findingKey(findings[0]!), 'fixed');
    setStatus(findingKey(findings[1]!), 'accepted', 'Assumé.');

    render(<StatusSummary findings={findings} />);
    expect(screen.getByText(/100% of what needed handling is fixed/)).toBeTruthy();
    expect(screen.getByText(/never improves this figure/i)).toBeTruthy();
  });
});
