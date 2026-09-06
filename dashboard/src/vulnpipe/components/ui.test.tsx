/**
 * @vitest-environment jsdom
 */
/**
 * Tests d'interface.
 *
 * PHASE_6 autorise « un script manuel documenté si le vrai E2E est trop
 * lourd ». On fait mieux : les trois affirmations que la spec demande de
 * vérifier à l'écran sont testées automatiquement, dans un vrai DOM.
 *   1. la timeline s'affiche dans le bon ordre
 *   2. le rapport montre le résumé en langage simple, sans jargon nu
 *   3. le détail technique est accessible mais REPLIÉ par défaut
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';

import { render } from '../test-utils.tsx';
import { userEvent } from '@testing-library/user-event';

import { ScanTimeline, reduceEvents, type StepEvent } from './ScanTimeline.tsx';
import { ReportView, FindingCard, VulnerabilityName, type ReportFinding } from './ReportView.tsx';
import { UsagePanel, formatCost } from './UsagePanel.tsx';
import { ProviderSwitcher } from './ProviderSwitcher.tsx';
import { PipelineExplainer } from './PipelineExplainer.tsx';
import { ScanLauncher } from './ScanLauncher.tsx';
import { STEP_ORDER, stepTranslations, translateStep } from '../lib/step_translations.ts';
import { dictionary } from '../../i18n/dictionary.ts';

// Le catalogue anglais sert de référence aux tests : c'est la langue par
// défaut du produit, donc celle que voit quelqu'un qui n'a rien réglé.
const STEP_TRANSLATIONS = stepTranslations('en');
const GLOSSARY = dictionary('en').glossary;

afterEach(cleanup);

function event(partial: Partial<StepEvent> & Pick<StepEvent, 'seq' | 'step' | 'status'>): StepEvent {
  return {
    run_id: 'run-1',
    plain_language: 'Message par défaut.',
    at: new Date().toISOString(),
    ...partial,
  } as StepEvent;
}

const IDOR_FINDING: ReportFinding = {
  severity: 'critical',
  report_level: 'critical',
  vulnerability: 'IDOR',
  route: '/orders/:id',
  http_method: 'GET',
  file: 'order.controller.ts',
  line: 12,
  claude_verdict: 'confirmed',
  claude_reasoning: "Le service lit la commande par son seul identifiant, sans vérifier le propriétaire.",
  technical_summary: 'IDOR sur GET /orders/:id : findById(id) sans filtre userId.',
  plain_language_summary:
    "N'importe qui peut voir les commandes d'un autre client en changeant le numéro dans l'adresse de la page.",
  suggested_fix_direction:
    "Il faut vérifier que la commande appartient bien à la personne connectée avant de la renvoyer.",
  owasp_category: 'A01:2021 – Broken Access Control',
  evidence: 'code',
  code_excerpt: {
    start_line: 10,
    lines: [
      '  @Get(\'/:id\')',
      '  async getOrder(@Param(\'id\') id: string) {',
      '    return this.orderService.findById(id);',
      '  }',
    ],
    highlight_line: 12,
    truncated: false,
  },
  local_confidence_score: 0.9,
  detected_by: ['idor-node'],
};

// ===========================================================================
// 1. Timeline
// ===========================================================================

describe('ScanTimeline', () => {
  it("affiche les étapes dans l'ordre de la pipeline, pas celui d'arrivée", () => {
    // Événements volontairement mélangés : deux nodes en parallèle ne
    // garantissent aucun ordre de livraison.
    render(
      <ScanTimeline
        events={[
          event({ seq: 3, step: 'aggregation', status: 'done', plain_language: 'Tri terminé.' }),
          event({ seq: 0, step: 'received', status: 'done', plain_language: 'Demande reçue.' }),
          event({ seq: 2, step: 'detection', status: 'done', plain_language: 'Adresses vérifiées.' }),
          event({ seq: 1, step: 'indexing', status: 'done', plain_language: 'Code lu.' }),
        ]}
      />
    );

    const items = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    const positions = [
      'Request received',
      'Reading your code',
      'Hunting for holes',
      'Sorting the results',
    ].map((label) => items.findIndex((text) => text.includes(label)));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => p >= 0)).toBe(true);
  });

  it('affiche du langage humain, jamais un nom de composant technique', () => {
    render(
      <ScanTimeline
        events={STEP_ORDER.map((step, index) =>
          event({
            seq: index,
            step,
            status: 'running',
            plain_language: translateStep(step, 'running', 'en'),
          })
        )}
      />
    );
    const text = document.body.textContent ?? '';
    for (const jargon of ['Node IDOR', 'MCP', 'aggregator', 'LLM', 'payload']) {
      expect(text).not.toContain(jargon);
    }
    expect(text).toContain("nobody can read another user's data");
  });

  it("n'efface jamais un échec avec un succès plus tardif", () => {
    // Sans cette règle, une étape partiellement en échec s'afficherait comme
    // réussie et l'utilisateur croirait à une couverture complète.
    const states = reduceEvents([
      event({ seq: 0, step: 'detection', status: 'failed', plain_language: "Une adresse n'a pas pu être vérifiée." }),
      event({ seq: 1, step: 'detection', status: 'done', plain_language: 'Toutes les adresses vérifiées.' }),
    ]);
    expect(states[0]!.status).toBe('failed');
    expect(states[0]!.message).toContain("n'a pas pu être vérifiée");
  });

  it("montre l'avancement chiffré quand une étape traite plusieurs éléments", () => {
    render(
      <ScanTimeline
        events={[
          event({
            seq: 0,
            step: 'detection',
            status: 'running',
            plain_language: 'On a vérifié 3 adresse(s) sur 7.',
            progress: { done: 3, total: 7 },
          }),
        ]}
      />
    );
    expect(screen.getByText('3 of 7')).toBeTruthy();
  });

  it('garde le détail technique replié par défaut', async () => {
    render(
      <ScanTimeline
        showTechnicalDetail
        events={[
          event({
            seq: 0,
            step: 'detection',
            status: 'failed',
            plain_language: "Une adresse n'a pas pu être vérifiée.",
            detail: 'LlmError: rate_limit sur GET /orders/:id',
          }),
        ]}
      />
    );

    expect(screen.queryByText(/LlmError/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Show technical detail/ }));
    expect(screen.getByText(/LlmError/)).toBeTruthy();
  });

  it('affiche un message d attente quand aucun événement n est encore arrivé', () => {
    render(<ScanTimeline events={[]} />);
    expect(screen.getByText(/The analysis is about to start/)).toBeTruthy();
  });
});

// ===========================================================================
// 2 et 3. Rapport
// ===========================================================================

describe('ReportView', () => {
  const report = {
    scan_summary: {
      total_findings: 1,
      critical: 1,
      warning: 0,
      dismissed_by_arbiter: 1,
      not_arbitrated: 0,
      plain_language_intro:
        "On a trouvé 1 point d'attention dans ton code, dont 1 qui mérite une correction rapide.",
    },
    findings: [IDOR_FINDING],
    dismissed: [{ vulnerability: 'IDOR', route: '/tags/:id', http_method: 'GET' }],
    source_root: '/home/moi/projet',
  };

  it('met le verdict global en haut, avant tout détail', () => {
    render(<ReportView report={report} />);
    expect(screen.getByText(/On a trouvé 1 point d'attention/)).toBeTruthy();
    // En anglais, comme le reste du produit : ces compteurs etaient ecrits en
    // francais dans le composant, hors catalogue.
    expect(screen.getByText('1 to fix now')).toBeTruthy();
  });

  it('affiche par défaut le résumé en langage simple et la gravité', () => {
    render(<ReportView report={report} />);
    expect(
      screen.getByText(/N'importe qui peut voir les commandes d'un autre client/)
    ).toBeTruthy();
    expect(screen.getByText('Fix soon')).toBeTruthy();
  });

  it('garde le détail technique REPLIÉ par défaut, et accessible au clic', async () => {
    render(<FindingCard finding={IDOR_FINDING} />);

    // Replié : ni analyse technique, ni fichier, ni catégorie OWASP.
    expect(screen.queryByText(/findById\(id\) sans filtre userId/)).toBeNull();
    expect(screen.queryByText(/order.controller.ts/)).toBeNull();

    const toggle = screen.getByRole('button', { name: /Show technical detail/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(toggle);
    expect(screen.getByText(/findById\(id\) sans filtre userId/)).toBeTruthy();
    expect(screen.getByText(/order.controller.ts \(line 12\)/)).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it("n'affiche jamais un sigle technique tout seul", async () => {
    render(<FindingCard finding={IDOR_FINDING} />);
    // Replié : aucun sigle visible du tout.
    expect(document.body.textContent).not.toContain('IDOR');

    await userEvent.click(screen.getByRole('button', { name: /Show technical detail/ }));
    // Déplié : le sigle apparaît, mais accompagné de sa traduction.
    const article = screen.getByRole('article');
    expect(within(article).getByText('IDOR')).toBeTruthy();
    expect(article.textContent).toContain(GLOSSARY.IDOR);
  });

  it('remplace un terme absent du glossaire plutôt que de montrer un sigle opaque', () => {
    render(<VulnerabilityName name="XXE" />);
    expect(screen.getByText('Security issue')).toBeTruthy();
    expect(document.body.textContent).not.toContain('XXE');
  });

  it('prévient quand un point n a pas été revérifié', () => {
    render(<FindingCard finding={{ ...IDOR_FINDING, evidence: 'not_arbitrated' }} />);
    expect(screen.getByRole('note').textContent).toContain('could not be double-checked');
  });

  it('prévient quand la seconde relecture n a pas tranché', () => {
    render(<FindingCard finding={{ ...IDOR_FINDING, claude_verdict: 'needs_human_review' }} />);
    expect(screen.getByRole('note').textContent).toContain('human check is needed');
  });

  it('dit clairement quand il n y a rien à signaler — et ce que ce vide vaut', () => {
    render(
      <ReportView
        report={{
          scan_summary: { ...report.scan_summary, total_findings: 0, critical: 0, warning: 0 },
          findings: [],
          dismissed: [],
          source_root: null,
        }}
      />
    );
    // Sans couverture transmise, l'ecran refuse le titre rassurant : il dit
    // qu'il ne sait pas ce qui a ete lu. Le detail des trois tons est teste
    // dans `nothing-found.test.tsx`.
    expect(screen.getByText('Nothing kept, coverage not reported')).toBeTruthy();
  });
});

// ===========================================================================
// Consommation (fonctionnalité demandée)
// ===========================================================================

describe('UsagePanel', () => {
  const usage = {
    totals: {
      calls: 5,
      input_tokens: 3759,
      output_tokens: 2296,
      thinking_tokens: 4100,
      cost_usd: 0,
      cost_partial: false,
      latency_ms: 12000,
    },
    by_stage: {
      detection: {
        calls: 4,
        input_tokens: 3000,
        output_tokens: 1800,
        thinking_tokens: 3500,
        cost_usd: 0,
        cost_partial: false,
        latency_ms: 9000,
      },
      master_review: {
        calls: 1,
        input_tokens: 759,
        output_tokens: 496,
        thinking_tokens: 600,
        cost_usd: 0,
        cost_partial: false,
        latency_ms: 3000,
      },
    },
    by_model: {
      'openrouter/openrouter/free': {
        calls: 5,
        input_tokens: 3759,
        output_tokens: 2296,
        thinking_tokens: 4100,
        cost_usd: 0,
        cost_partial: false,
        latency_ms: 12000,
      },
    },
    plain_language_summary: 'Ce scan a demandé 5 analyses par intelligence artificielle. Coût total : gratuit.',
  };

  it('affiche le coût et le volume, résumé replié par défaut', async () => {
    render(<UsagePanel usage={usage} />);
    // Vocabulaire volontaire : un scan sans coût se dit en JETONS consommés,
    // pas en « gratuit » — le but est que la personne comprenne où part sa
    // consommation, pas seulement si sa carte est débitée.
    expect(screen.getByText('no tokens used')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();

    expect(screen.queryByText('Par étape')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Show usage detail/ }));
    expect(screen.getByText('By step')).toBeTruthy();
    expect(screen.getByText('Hunting for holes')).toBeTruthy();
  });

  it('dit « non communiqué » plutôt que d inventer un coût', () => {
    // Un coût que le fournisseur ne donne pas s'affiche comme inconnu, jamais
    // comme « 0 $ » : ce serait présenter une absence d'information comme une
    // gratuité, à quelqu'un qui va pourtant payer.
    const en = dictionary('en');
    expect(formatCost({ ...usage.totals, cost_usd: null }, en)).toBe(
      'not reported by the provider'
    );
    expect(formatCost({ ...usage.totals, cost_usd: 0.0123, cost_partial: true }, en)).toContain(
      'partial'
    );
  });

  it('explique le poste « réflexion », le plus opaque de la facture', async () => {
    render(<UsagePanel usage={usage} />);
    await userEvent.click(screen.getByRole('button', { name: /Show usage detail/ }));
    expect(screen.getByText(/reasoning to itself/)).toBeTruthy();
  });
});

// ===========================================================================
// Bascule de fournisseur (fonctionnalité demandée)
// ===========================================================================

describe('ProviderSwitcher', () => {
  const available = [
    { id: 'gemini' as const, available: true, why: null },
    { id: 'openrouter' as const, available: true, why: null },
    { id: 'anthropic' as const, available: false, why: 'ANTHROPIC_API_KEY absente.' },
  ];
  const settings = { nodeProvider: 'gemini' as const, masterProvider: 'anthropic' as const };

  it('propose un fournisseur distinct pour les détecteurs et pour la relecture', () => {
    render(<ProviderSwitcher settings={settings} available={available} onChange={() => {}} />);
    expect(screen.getByLabelText(/Hunting for holes/)).toBeTruthy();
    expect(screen.getByLabelText(/Second opinion/)).toBeTruthy();
  });

  it('désactive un fournisseur sans clé au lieu de le masquer, et dit pourquoi', () => {
    render(<ProviderSwitcher settings={settings} available={available} onChange={() => {}} />);
    const option = screen.getAllByRole('option', { name: /Claude \(Anthropic\)/ })[0]!;
    expect(option.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('ANTHROPIC_API_KEY absente');
  });

  it("n'active « Appliquer » que si un réglage a changé", async () => {
    const onChange = vi.fn();
    render(<ProviderSwitcher settings={settings} available={available} onChange={onChange} />);

    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply.hasAttribute('disabled')).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText(/Hunting for holes/), 'openrouter');
    expect(apply.hasAttribute('disabled')).toBe(false);

    await userEvent.click(apply);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ nodeProvider: 'openrouter' }));
  });

  it('propose les modèles gratuits pour OpenRouter', async () => {
    render(<ProviderSwitcher settings={settings} available={available} onChange={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText(/Hunting for holes/), 'openrouter');
    const options = document.querySelectorAll('#vp-node-provider-suggestions option');
    expect([...options].map((o) => o.getAttribute('value'))).toContain('openrouter/free');
  });

  it('fige le réglage pendant un scan', () => {
    render(<ProviderSwitcher settings={settings} available={available} onChange={() => {}} disabled />);
    expect(screen.getByText(/A scan is running/)).toBeTruthy();
  });
});

// ===========================================================================
// Explication de la pipeline (le cœur de l'app pour un public non technique)
// ===========================================================================

describe('PipelineExplainer', () => {
  it("explique à quoi sert chaque étape, pas seulement son nom", () => {
    render(<PipelineExplainer />);
    // Un nom d'étape sans explication ne veut rien dire pour le persona cible.
    for (const step of STEP_ORDER) {
      expect(screen.getByText(STEP_TRANSLATIONS[step].why)).toBeTruthy();
    }
  });

  it('accompagne chaque étape d une analogie du quotidien', () => {
    render(<PipelineExplainer />);
    expect(screen.getByText(/Like taking a ticket when you walk into a waiting room/)).toBeTruthy();
    expect(screen.getByText(/like sorting your mail/i)).toBeTruthy();
  });

  it('explique le modèle de coût, promesse n°1 du produit', () => {
    render(<PipelineExplainer />);
    expect(screen.getByText(/Why this costs almost nothing/)).toBeTruthy();
  });

  it("met en avant l'étape en cours", () => {
    const { container } = render(<PipelineExplainer currentStep="detection" />);
    const current = container.querySelector('.vp-pipeline-step.vp-current');
    expect(current?.textContent).toContain('Hunting for holes');
    expect(current?.textContent).toContain('running');
  });

  it("n'emploie aucun terme technique dans les explications", () => {
    render(<PipelineExplainer />);
    const text = document.body.textContent ?? '';
    for (const jargon of ['index', 'MCP', 'LLM', 'API', 'node', 'payload', 'AST', 'JSON']) {
      expect(text).not.toContain(jargon);
    }
  });
});

describe('Timeline avec explications', () => {
  it('propose « À quoi ça sert ? » sous chaque étape, replié par défaut', async () => {
    render(
      <ScanTimeline
        showExplanations
        events={[event({ seq: 0, step: 'detection', status: 'running', plain_language: 'En cours.' })]}
      />
    );

    expect(screen.queryByText(STEP_TRANSLATIONS.detection.why)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'What is this for?' }));
    expect(screen.getByText(STEP_TRANSLATIONS.detection.why)).toBeTruthy();
  });
});

// ===========================================================================
// Formulaire de lancement
// ===========================================================================

describe('ScanLauncher', () => {
  it('pose des questions en français, sans vocabulaire technique', () => {
    render(<ScanLauncher onLaunch={() => {}} />);
    expect(screen.getByText('Which folder do you want to check?')).toBeTruthy();
    const text = document.body.textContent ?? '';
    for (const jargon of ['repo_path', 'full_scan', 'commit_sha', 'webhook', 'payload']) {
      expect(text).not.toContain(jargon);
    }
  });

  it('propose les trois formes de cible, dont le dépôt GitHub', async () => {
    // Une capacité que rien n'annonce n'existe pas pour qui l'ignore : les
    // trois onglets doivent être visibles sans avoir à deviner.
    render(<ScanLauncher onLaunch={() => {}} />);
    expect(screen.getByRole('tab', { name: /folder/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /single file/i })).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: /GitHub/i }));
    expect(screen.getByText('Which repository do you want to check?')).toBeTruthy();
  });

  it("cache le choix de l'étendue sur un fichier seul", async () => {
    // Comparer « ce qui a changé » n'a aucun sens quand la cible est un seul
    // fichier : proposer l'option laisserait croire à un tri qui n'existe pas.
    render(<ScanLauncher onLaunch={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: /single file/i }));
    expect(screen.queryByLabelText(/Only what changed/)).toBeNull();
  });

  it('refuse de lancer sans cible, et explique pourquoi', async () => {
    const onLaunch = vi.fn();
    render(<ScanLauncher onLaunch={onLaunch} />);
    await userEvent.click(screen.getByRole('button', { name: /Estimate/ }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Tell us what to analyze');
  });

  it('ne demande la version de départ que si le mode incrémental est choisi', async () => {
    render(<ScanLauncher onLaunch={() => {}} />);
    expect(screen.queryByLabelText(/Since which version/)).toBeNull();
    await userEvent.click(screen.getByLabelText(/Only what changed/));
    expect(screen.getByLabelText(/Since which version/)).toBeTruthy();
  });

  it('transmet le mode choisi', async () => {
    const onLaunch = vi.fn();
    render(<ScanLauncher onLaunch={onLaunch} defaultPath="/tmp/projet" />);
    await userEvent.click(screen.getByLabelText(/Only what changed/));
    await userEvent.click(screen.getByRole('button', { name: /Estimate/ }));
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ target: '/tmp/projet', mode: 'incremental_scan' })
    );
  });
});
