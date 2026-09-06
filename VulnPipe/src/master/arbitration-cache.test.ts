/**
 * Tests du cache d'arbitrage (point 7 du `ROADMAP.md`).
 *
 * Le test qui compte vraiment est « ne ressert PAS un verdict après
 * modification du code ». Un cache indexé sur le seul identifiant de route
 * resservirait « vulnérabilité confirmée » sur du code corrigé, ou « fausse
 * alerte » sur du code qu'on vient de casser — un faux verdict servi
 * instantanément et gratuitement, jamais revu par personne. Tout le reste de
 * ce fichier n'est que de l'économie ; celui-là est de la justesse.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  InMemoryArbitrationCache,
  arbitrationCacheKey,
  type CacheKeyInput,
} from './arbitration-cache.ts';
import { arbitrate, type ArbitratedFinding } from './claude-client.ts';
import { FakeLlmClient } from '../nodes/shared/llm/fake.ts';
import type { AggregatedFinding } from '../aggregator/aggregator.ts';
import type { ContextProvider } from '../nodes/shared/mcp-client.ts';

const FINDING: AggregatedFinding = {
  vulnerability: 'IDOR',
  route: '/orders/:id',
  http_method: 'GET',
  file: 'src/order.service.ts',
  line: 3,
  severity: 'critical',
  confidence_score: 0.85,
  reason: null,
  plain_language_summary: "N'importe qui peut lire les commandes d'un autre.",
  detected_by: ['idor'],
  corroborated: false,
} as AggregatedFinding;

const BASE: CacheKeyInput = {
  finding: FINDING,
  evidence: 'return this.db.orders.findOne({ id });',
  provider: 'anthropic',
  model: 'claude-opus-5',
  locale: 'en',
};

const VERDICT = {
  finding_id: 'IDOR:GET:/orders/:id',
  claude_verdict: 'confirmed',
  claude_reasoning: 'Lecture par identifiant sans filtre.',
  technical_summary: 'findById(id) sans userId.',
  plain_language_summary: "Quelqu'un peut lire les commandes d'un autre.",
  suggested_fix_direction: 'Vérifier le propriétaire.',
  owasp_category: 'A01:2021 – Broken Access Control',
};

/**
 * Fournisseur de contexte qui rend le code qu'on lui donne.
 *
 * Le bundle doit être RÉALISTE : `collectEvidence` lit `endpoint.code_snapshot`
 * et `endpoint.source`. Un faux objet incomplet fait tomber la collecte dans
 * son `catch`, qui renvoie un texte CONSTANT — et un test bâti là-dessus
 * vérifierait le contraire de ce qu'il annonce.
 */
function providerReturning(code: string): ContextProvider {
  return {
    getContext: async () =>
      ({
        endpoint: {
          route: '/orders/:id',
          http_method: 'GET',
          handler: 'getOrder',
          code_snapshot: code,
          source: { file: 'src/order.controller.ts', start_line: 5, end_line: 8 },
          framework_metadata: { guards: [], is_unguarded: true },
        },
        controller: 'OrderController',
        depth: 2,
        resolved_guards: [],
        resolved_calls: [],
        budget: { used_bytes: 0, limit_bytes: 24_000, truncated: false },
        reason: null,
        plain_language_summary: '',
      }) as unknown as Awaited<ReturnType<ContextProvider['getContext']>>,
    listRoutes: async () => [],
    close: async () => {},
  };
}

/** Fournisseur en panne : la collecte de code échoue, l'arbitrage se fait à l'aveugle. */
function brokenProvider(): ContextProvider {
  return {
    getContext: async () => {
      throw new Error('serveur de contexte injoignable');
    },
    listRoutes: async () => [],
    close: async () => {},
  };
}

// ===========================================================================
// La clé
// ===========================================================================

describe("Clé de cache d'arbitrage", () => {
  it('est stable pour une question identique', () => {
    expect(arbitrationCacheKey(BASE)).toBe(arbitrationCacheKey({ ...BASE }));
  });

  it('CHANGE dès que le code montré change', () => {
    // Le point crucial : c'est le code qui décide du verdict.
    const corrige = { ...BASE, evidence: 'return this.db.orders.findOne({ id, userId });' };
    expect(arbitrationCacheKey(corrige)).not.toBe(arbitrationCacheKey(BASE));
  });

  it('change avec le modèle et le fournisseur', () => {
    // Le ROADMAP documente que deux modèles ne rendent pas le même verdict :
    // un cache partagé entre modèles servirait l'avis de l'autre.
    expect(arbitrationCacheKey({ ...BASE, model: 'autre-modele' })).not.toBe(
      arbitrationCacheKey(BASE)
    );
    expect(arbitrationCacheKey({ ...BASE, provider: 'gemini' })).not.toBe(
      arbitrationCacheKey(BASE)
    );
    // La langue fait TOUJOURS partie de la clé — les résumés sont rédigés dans
    // la langue demandée — mais le catalogue n'en compte plus qu'une, donc il
    // n'y a plus de seconde valeur avec laquelle le vérifier. L'assertion est
    // retirée plutôt que réécrite en comparant `'en'` à lui-même, ce qui
    // passerait sans rien prouver.
  });

  it('change avec ce que le détecteur local en a dit', () => {
    expect(
      arbitrationCacheKey({ ...BASE, finding: { ...FINDING, confidence_score: 0.45 } })
    ).not.toBe(arbitrationCacheKey(BASE));
    expect(
      arbitrationCacheKey({ ...BASE, finding: { ...FINDING, reason: 'missing_context' } })
    ).not.toBe(arbitrationCacheKey(BASE));
  });

  it('ne confond pas deux découpages des mêmes caractères', () => {
    const a = arbitrationCacheKey({ ...BASE, finding: { ...FINDING, route: '/a', file: 'b/c.ts' } });
    const b = arbitrationCacheKey({ ...BASE, finding: { ...FINDING, route: '/ab', file: '/c.ts' } });
    expect(a).not.toBe(b);
  });
});

// ===========================================================================
// Le magasin
// ===========================================================================

describe('Cache en mémoire', () => {
  it('rend ce qu on lui a confié et compte les succès', () => {
    const cache = new InMemoryArbitrationCache();
    expect(cache.get('k')).toBeUndefined();
    expect(cache.misses).toBe(1);

    cache.set('k', VERDICT as ArbitratedFinding);
    expect(cache.get('k')).toEqual(VERDICT);
    expect(cache.hits).toBe(1);
  });

  it('reste borné et évince la plus ancienne entrée', () => {
    // Le serveur tourne longtemps : un cache non borné est une fuite mémoire.
    const cache = new InMemoryArbitrationCache(2);
    cache.set('a', VERDICT as ArbitratedFinding);
    cache.set('b', VERDICT as ArbitratedFinding);
    cache.set('c', VERDICT as ArbitratedFinding);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('garde en vie ce qui vient d être relu', () => {
    const cache = new InMemoryArbitrationCache(2);
    cache.set('a', VERDICT as ArbitratedFinding);
    cache.set('b', VERDICT as ArbitratedFinding);
    cache.get('a'); // 'a' redevient la plus récente
    cache.set('c', VERDICT as ArbitratedFinding);

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

// ===========================================================================
// L'arbitrage câblé sur le cache
// ===========================================================================

describe('Arbitrage avec cache', () => {
  it("n'appelle PAS le modèle deux fois pour le même code", async () => {
    const cache = new InMemoryArbitrationCache();
    const provider = providerReturning('return this.db.orders.findOne({ id });');

    const first = new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]);
    const outcome1 = await arbitrate([FINDING], { llm: first, contextProvider: provider, cache, locale: 'en' });
    expect(outcome1.usage.calls).toBe(1);
    expect(outcome1.cache_hits).toBe(0);

    // Deuxième scan, code identique : aucun appel, mais le verdict est là.
    const second = new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]);
    const spy = vi.spyOn(second, 'complete');
    const outcome2 = await arbitrate([FINDING], { llm: second, contextProvider: provider, cache, locale: 'en' });

    expect(spy).not.toHaveBeenCalled();
    expect(outcome2.usage.calls).toBe(0);
    expect(outcome2.cache_hits).toBe(1);
    expect(outcome2.arbitrated[0]!.claude_verdict).toBe('confirmed');
    expect(outcome2.unarbitrated).toEqual([]);
  });

  it('REDEMANDE un verdict quand le code a changé', async () => {
    // Le test qui justifie tout le reste : après correction, on ne doit
    // surtout pas resservir « vulnérabilité confirmée ».
    const cache = new InMemoryArbitrationCache();

    const before = new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]);
    await arbitrate([FINDING], {
      llm: before,
      contextProvider: providerReturning('findOne({ id });'),
      cache,
      locale: 'en',
    });

    const rejected = { ...VERDICT, claude_verdict: 'rejected', claude_reasoning: 'Le filtre est présent.' };
    const after = new FakeLlmClient([{ parsed: { verdicts: [rejected] } }]);
    const outcome = await arbitrate([FINDING], {
      llm: after,
      // Code corrigé : le filtre userId est là.
      contextProvider: providerReturning('findOne({ id, userId });'),
      cache,
      locale: 'en',
    });

    expect(outcome.cache_hits).toBe(0);
    expect(outcome.usage.calls).toBe(1);
    expect(outcome.arbitrated[0]!.claude_verdict).toBe('rejected');
  });

  it('ne mémorise pas un verdict qui n a jamais été rendu', async () => {
    // Réponse incomplète : le finding ressort en `unarbitrated`. Il doit être
    // redemandé au scan suivant, pas figé dans le cache.
    const cache = new InMemoryArbitrationCache();
    const provider = providerReturning('findOne({ id });');

    const empty = new FakeLlmClient([{ parsed: { verdicts: [] } }]);
    const outcome1 = await arbitrate([FINDING], { llm: empty, contextProvider: provider, cache, locale: 'en' });
    expect(outcome1.unarbitrated).toHaveLength(1);
    expect(cache.size).toBe(0);

    const second = new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]);
    const outcome2 = await arbitrate([FINDING], { llm: second, contextProvider: provider, cache, locale: 'en' });
    expect(outcome2.usage.calls).toBe(1);
    expect(outcome2.arbitrated).toHaveLength(1);
  });

  it('garde les verdicts déjà connus même si l arbitre tombe', async () => {
    const cache = new InMemoryArbitrationCache();
    const provider = providerReturning('findOne({ id });');

    await arbitrate([FINDING], {
      llm: new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]),
      contextProvider: provider,
      cache,
      locale: 'en',
    });

    const autre: AggregatedFinding = { ...FINDING, route: '/invoices/:id' };
    const enPanne = new FakeLlmClient([{ error: new Error('réseau coupé') }]);
    const outcome = await arbitrate([FINDING, autre], {
      llm: enPanne,
      contextProvider: provider,
      cache,
      locale: 'en',
    });

    // Le connu reste acquis, l'inconnu est signalé — rien ne disparaît.
    expect(outcome.cache_hits).toBe(1);
    expect(outcome.arbitrated).toHaveLength(1);
    expect(outcome.unarbitrated.map((u) => u.finding_id)).toEqual(['IDOR:GET:/invoices/:id']);
  });

  it("ne mémorise PAS un verdict rendu sans avoir vu le code", async () => {
    // Serveur de contexte injoignable : l'arbitre tranche sur le seul résumé.
    // Le texte de preuve est alors CONSTANT — sa clé ne bougerait pas quand le
    // code change, et le cache resservirait ce verdict aveugle sur du code
    // corrigé. On refuse donc de le mémoriser.
    const cache = new InMemoryArbitrationCache();
    const aveugle = brokenProvider();

    const outcome1 = await arbitrate([FINDING], {
      llm: new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]),
      contextProvider: aveugle,
      cache,
      locale: 'en',
    });
    expect(outcome1.arbitrated[0]!.evidence).toBe('summary_only');
    expect(cache.size).toBe(0);

    // Le scan suivant repose donc bien la question.
    const outcome2 = await arbitrate([FINDING], {
      llm: new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]),
      contextProvider: aveugle,
      cache,
      locale: 'en',
    });
    expect(outcome2.usage.calls).toBe(1);
    expect(outcome2.cache_hits).toBe(0);
  });

  it('sans cache fourni, le comportement est inchangé', async () => {
    const provider = providerReturning('findOne({ id });');
    const first = new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]);
    const second = new FakeLlmClient([{ parsed: { verdicts: [VERDICT] } }]);

    const a = await arbitrate([FINDING], { llm: first, contextProvider: provider, locale: 'en' });
    const b = await arbitrate([FINDING], { llm: second, contextProvider: provider, locale: 'en' });

    expect(a.usage.calls).toBe(1);
    expect(b.usage.calls).toBe(1);
    expect(b.cache_hits).toBe(0);
  });
});
