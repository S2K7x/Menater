/**
 * Le devis doit être honnête avant d'être précis.
 *
 * Deux exigences non négociables, chacune couverte ici :
 *  - un prix inconnu reste `null`, jamais remplacé par 0 ;
 *  - le nombre d'appels facturés est mesuré (le scanner déterministe en
 *    supprime une partie), pas supposé.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { estimateScan, humanDuration, prepareTarget, formatUsd } from './estimator.ts';
import { resolveTarget } from './scan-target.ts';
import { parsePrice, priceFor, resetObservedLatency, observeLatency, latencyFor } from './pricing.ts';

const FIXTURE = new URL('../nodes/idor/__fixtures__/repo', import.meta.url).pathname;

async function estimateFixture(env: NodeJS.ProcessEnv = {}) {
  const target = await resolveTarget(FIXTURE);
  const ready = await prepareTarget(target);
  try {
    return await estimateScan({
      target,
      mode: 'full_scan',
      routes: ready.routes,
      index: ready.index,
      provider: ready.provider,
      detection: { provider: 'gemini', model: 'gemini-3.5-flash' },
      arbitration: { provider: 'anthropic', model: 'claude-opus-5' },
      env,
    });
  } finally {
    await ready.close();
    await target.cleanup();
  }
}

beforeEach(() => resetObservedLatency());

describe('pricing', () => {
  it("ne renvoie aucun prix pour un fournisseur non renseigné", () => {
    // Inventer une grille tarifaire ferait afficher un chiffre faux avec
    // l'autorité d'une facture.
    expect(priceFor('gemini', 'gemini-3.5-flash', {})).toBeNull();
    expect(priceFor('anthropic', 'claude-opus-5', {})).toBeNull();
  });

  it('connaît les gratuités structurelles', () => {
    // Un modèle qui tourne sur ta machine ne facture rien : ce zéro-là ne peut
    // pas devenir faux avec le temps.
    expect(priceFor('ollama', 'qwen3.5:9b', {})?.input_per_mtok).toBe(0);
    expect(priceFor('openrouter', 'openrouter/free', {})?.source).toBe('gratuit_par_construction');
    expect(priceFor('openrouter', 'anthropic/claude-opus-5', {})).toBeNull();
  });

  it('accepte un tarif renseigné dans .env', () => {
    const price = priceFor('gemini', 'x', { VULNPIPE_PRICE_GEMINI: '0.30/2.50' });
    expect(price).toEqual({ input_per_mtok: 0.3, output_per_mtok: 2.5, source: 'renseigné_par_toi' });
  });

  it('rejette un tarif illisible plutôt que de le deviner', () => {
    expect(parsePrice('gratuit')).toBeNull();
    expect(parsePrice('-1/2')).toBeNull();
    expect(parsePrice('0.5')).toEqual({
      input_per_mtok: 0.5,
      output_per_mtok: 0.5,
      source: 'renseigné_par_toi',
    });
  });

  it('remplace la latence de référence par du mesuré après assez d\'appels', () => {
    expect(latencyFor('gemini').measured).toBe(false);
    for (let i = 0; i < 3; i++) observeLatency('gemini', 2000);
    expect(latencyFor('gemini')).toMatchObject({ ms: 2000, measured: true });
  });
});

describe('estimateScan', () => {
  it('compte les adresses tranchées sans IA comme gratuites', async () => {
    const estimate = await estimateFixture();

    expect(estimate.routes_selected).toBeGreaterThan(0);
    expect(estimate.routes_free + estimate.routes_billed).toBe(estimate.routes_selected);
    // Le dépôt de test contient une route sans surface d'attaque (/health) :
    // le scanner la tranche seul, elle ne doit rien coûter.
    expect(estimate.routes_free).toBeGreaterThan(0);
    expect(estimate.llm_calls.detection).toBe(estimate.routes_billed);
  });

  it('mesure de vrais prompts, pas une constante', async () => {
    const estimate = await estimateFixture();
    expect(estimate.tokens.input).toBeGreaterThan(0);
    expect(estimate.tokens.total.high).toBeGreaterThanOrEqual(estimate.tokens.total.low);
  });

  it("laisse le coût à null et explique quoi faire quand le tarif est inconnu", async () => {
    const estimate = await estimateFixture({});

    expect(estimate.cost.usd).toBeNull();
    expect(estimate.cost.free).toBe(false);
    expect(estimate.cost.unknown_reason).toContain('VULNPIPE_PRICE_');
    // Le résumé ne doit jamais laisser croire à la gratuité.
    expect(estimate.plain_language_summary).not.toContain('is free');
  });

  it('chiffre le coût dès que les tarifs sont renseignés', async () => {
    const estimate = await estimateFixture({
      VULNPIPE_PRICE_GEMINI: '0.30/2.50',
      VULNPIPE_PRICE_ANTHROPIC: '3/15',
    });

    expect(estimate.cost.usd).not.toBeNull();
    expect(estimate.cost.usd!.high).toBeGreaterThanOrEqual(estimate.cost.usd!.low);
    expect(estimate.plain_language_summary).toContain('Estimated cost');
  });

  it('annonce l absence de coût en jetons sur un moteur local', async () => {
    const target = await resolveTarget(FIXTURE);
    const ready = await prepareTarget(target);
    try {
      const estimate = await estimateScan({
        target,
        mode: 'full_scan',
        routes: ready.routes,
        index: ready.index,
        provider: ready.provider,
        detection: { provider: 'ollama', model: 'qwen3.5:9b' },
        arbitration: { provider: 'ollama', model: 'qwen3.5:9b' },
        env: {},
      });
      expect(estimate.cost.free).toBe(true);
      // Vocabulaire volontaire : on parle de JETONS consommés, pas de
      // « gratuit » — le but est que la personne comprenne où part la
      // consommation, pas seulement qu'elle ne paie rien.
      expect(estimate.plain_language_summary).toContain('costs you nothing');
      expect(estimate.plain_language_summary).toContain('token');
    } finally {
      await ready.close();
      await target.cleanup();
    }
  });

  it('déclare ses hypothèses au lieu de les cacher', async () => {
    const estimate = await estimateFixture();
    // Une estimation dont on ne voit pas les hypothèses se lit comme une
    // garantie, et se retourne contre nous à la première fourchette dépassée.
    expect(estimate.assumptions.length).toBeGreaterThan(0);
    expect(estimate.assumptions.join(' ')).toContain('second review');
  });

  it("ne promet rien quand il n'y a rien à analyser", async () => {
    const target = await resolveTarget(FIXTURE);
    const ready = await prepareTarget(target);
    try {
      const estimate = await estimateScan({
        target,
        mode: 'incremental_scan',
        routes: [],
        index: ready.index,
        provider: ready.provider,
        detection: { provider: 'gemini' },
        arbitration: { provider: 'gemini' },
        env: {},
      });
      expect(estimate.llm_calls.total.high).toBe(0);
      expect(estimate.plain_language_summary).toContain('Nothing to analyze');
    } finally {
      await ready.close();
      await target.cleanup();
    }
  });
});

describe('formatage', () => {
  it('donne des durées lisibles', () => {
    expect(humanDuration(12)).toBe('12 seconds');
    expect(humanDuration(150)).toBe('3 minutes');
    expect(humanDuration(7200)).toBe('2 hours');
  });

  it('parle en centimes quand le montant est minuscule', () => {
    // « 0.0032 $ » ne veut rien dire pour la cible ; « moins d'un centime » si.
    expect(formatUsd(0.0032)).toContain('cents');
    expect(formatUsd(0)).toBe('$0');
  });
});
