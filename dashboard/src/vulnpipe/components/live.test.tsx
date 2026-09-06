/**
 * @vitest-environment jsdom
 */
/**
 * Suivi en direct et devis : les deux écrans qui décident si l'utilisateur
 * fait confiance à l'outil avant et pendant qu'il paie.
 */

import { screen, cleanup } from '@testing-library/react';

import { render } from '../test-utils.tsx';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

import { LiveActivity, computeCounters, currentRoute } from './LiveActivity.tsx';
import { EstimatePanel, humanDuration, type ScanEstimate } from './EstimatePanel.tsx';
import type { StepEvent } from './ScanTimeline.tsx';

let seq = 0;
function event(partial: Partial<StepEvent>): StepEvent {
  return {
    run_id: 'run-1',
    seq: seq++,
    step: 'detection',
    status: 'running',
    plain_language: 'texte',
    at: new Date().toISOString(),
    ...partial,
  } as StepEvent;
}

const verdict = (zone: 'sain' | 'a_verifier' | 'alerte', free = false, cached = false) =>
  event({
    route: { http_method: 'GET', route: '/orders/:id' },
    verdict: {
      vulnerability: 'IDOR',
      confidence_score: zone === 'alerte' ? 0.9 : zone === 'a_verifier' ? 0.6 : 0.1,
      zone,
      free,
      cached,
      plain_language_summary: `verdict ${zone}`,
    },
  });

describe('computeCounters', () => {
  it('classe les verdicts par zone', () => {
    const counters = computeCounters([verdict('alerte'), verdict('a_verifier'), verdict('sain', true)]);
    expect(counters).toMatchObject({ alerts: 1, greyZone: 1, safe: 1, freeVerdicts: 1 });
  });

  it('sépare « tranché sans IA » de « déjà connu »', () => {
    // Les deux sont gratuits, mais ne disent pas la même chose : le premier
    // mesure ce que les règles déterministes couvrent, le second ce qui n'a
    // pas bougé depuis le dernier scan. Les additionner ferait croire à une
    // couverture déterministe qu'on n'a pas.
    const counters = computeCounters([
      verdict('sain', true),
      verdict('sain', true, true),
      verdict('sain', true, true),
    ]);
    expect(counters.freeVerdicts).toBe(1);
    expect(counters.cachedVerdicts).toBe(2);
  });

  it('compte un verdict payé ni comme gratuit ni comme déjà connu', () => {
    const counters = computeCounters([verdict('alerte')]);
    expect(counters.freeVerdicts).toBe(0);
    expect(counters.cachedVerdicts).toBe(0);
  });

  it("ne double pas les compteurs quand le flux rejoue son historique", () => {
    // Le serveur rejoue tout l'historique à chaque reconnexion SSE. Un
    // compteur incrémental afficherait alors le double de la réalité.
    const usage = (calls: number) =>
      event({
        usage: {
          calls,
          input_tokens: calls * 100,
          output_tokens: calls * 50,
          thinking_tokens: 0,
          cost_usd: calls * 0.001,
          elapsed_ms: 1000,
        },
      });

    const counters = computeCounters([usage(1), usage(2), usage(3), usage(2)]);
    expect(counters.calls).toBe(3);
    expect(counters.costUsd).toBeCloseTo(0.003);
  });

  it('garde le coût à null tant que rien n\'est communiqué', () => {
    expect(computeCounters([verdict('sain')]).costUsd).toBeNull();
  });
});

describe('currentRoute', () => {
  it("retient l'adresse en cours tant qu'aucun verdict n'est tombé", () => {
    const inFlight = event({ route: { http_method: 'GET', route: '/orders/:id' } });
    expect(currentRoute([inFlight])?.route?.route).toBe('/orders/:id');
  });

  it("n'annonce plus rien une fois le verdict rendu", () => {
    expect(currentRoute([event({ route: { http_method: 'GET', route: '/a' } }), verdict('sain')])).toBeNull();
  });
});

describe('LiveActivity', () => {
  it('montre les verdicts du plus récent au plus ancien', () => {
    render(
      <LiveActivity
        events={[verdict('sain'), verdict('alerte')]}
        currentStep="detection"
        running
      />
    );
    const items = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    const feedText = items.join(' | ');
    expect(feedText).toContain('Likely problem');
    expect(feedText).toContain('All clear');
  });

  it("affiche « — » et non « 0 $ » quand le coût n'est pas communiqué", () => {
    // Afficher 0 $ ferait croire à la gratuité un utilisateur qui paie.
    render(<LiveActivity events={[verdict('sain')]} currentStep="detection" running />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText(/not reported/)).toBeTruthy();
  });

  it("nomme l'adresse en cours d'examen", () => {
    render(
      <LiveActivity
        events={[event({ route: { http_method: 'POST', route: '/invoices/:id' } })]}
        currentStep="detection"
        running
      />
    );
    expect(screen.getByText(/POST \/invoices\/:id/)).toBeTruthy();
  });

  it('signale une adresse non vérifiée sans la faire passer pour saine', () => {
    render(
      <LiveActivity
        events={[event({ status: 'failed', route: { http_method: 'GET', route: '/x' } })]}
        currentStep="detection"
        running
      />
    );
    expect(screen.getByText(/Could not be checked/)).toBeTruthy();
  });
});

const ESTIMATE: ScanEstimate = {
  target: { kind: 'directory', label: 'mon-projet', files_indexed: 42, routes_found: 8 },
  mode: 'full_scan',
  routes_selected: 8,
  routes_free: 3,
  routes_billed: 5,
  llm_calls: { detection: 5, arbitration: { low: 0, high: 1 }, total: { low: 5, high: 6 } },
  tokens: { input: 5000, output: { low: 3500, high: 4400 }, total: { low: 8500, high: 9400 } },
  duration_s: { low: 25, high: 50 },
  cost: { usd: null, free: false, unknown_reason: 'The rate for gemini is not configured.' },
  sampled: false,
  sample_size: 8,
  assumptions: ['Test assumption'],
  warnings: [],
  plain_language_summary: 'We are going to check 8 addresses.',
};

describe('EstimatePanel', () => {
  it('met le temps en avant et parle une langue humaine', () => {
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/We are going to check 8 addresses/)).toBeTruthy();
    expect(screen.getByText('25 s – 50 s')).toBeTruthy();

    const text = document.body.textContent ?? '';
    for (const jargon of ['full_scan', 'repo_path', 'tokens', 'LLM']) {
      expect(text).not.toContain(jargon);
    }
  });

  it("affiche « Non chiffrable » plutôt que 0 $ quand le tarif est inconnu", () => {
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Not priceable')).toBeTruthy();
    expect(screen.getByText(/rate for gemini/)).toBeTruthy();
  });

  it('affiche la fourchette de prix quand elle est connue', () => {
    render(
      <EstimatePanel
        estimate={{ ...ESTIMATE, cost: { usd: { low: 0.02, high: 0.05 }, free: false, unknown_reason: null } }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText('$0.02 – $0.05')).toBeTruthy();
  });

  it('empêche de lancer un scan qui n\'a rien à analyser', () => {
    render(
      <EstimatePanel
        estimate={{ ...ESTIMATE, routes_selected: 0 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: /Nothing to analyze/ }).hasAttribute('disabled')).toBe(true);
  });

  it('laisse voir sur quoi repose le chiffrage', async () => {
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /What is this estimate based on/ }));
    expect(screen.getByText('Test assumption')).toBeTruthy();
  });

  it('confirme et annule', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={onConfirm} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: /Start the analysis/ }));
    expect(onConfirm).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Change target/ }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('humanDuration', () => {
  it('reste lisible à toutes les échelles', () => {
    expect(humanDuration(30)).toBe('30 s');
    expect(humanDuration(90)).toBe('2 min');
    expect(humanDuration(3900)).toBe('1 h 5');
  });
});

// ===========================================================================
// Basculement de langue
//
// Ces tests sont le seul garde-fou contre un sélecteur décoratif : un
// dictionnaire complet ne prouve rien si les composants ne le consultent pas.
// ===========================================================================

describe('labels come from the catalogue', () => {
  it("affiche l'anglais par défaut", () => {
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: /Start the analysis/ })).toBeTruthy();
    expect(screen.getByText('Time')).toBeTruthy();
  });

  it('translates the live-run verdicts too', () => {
    // The verdict word comes from the catalogue, not from the server payload.
    render(<LiveActivity events={[verdict('alerte')]} currentStep="detection" running />);
    expect(screen.getByText('Likely problem')).toBeTruthy();
  });

  it('passes server-written text through untouched', () => {
    // The summary is written server-side. The interface must not try to
    // rewrite it — it renders exactly what it was given.
    render(<EstimatePanel estimate={ESTIMATE} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/We are going to check 8 addresses/)).toBeTruthy();
  });
});
