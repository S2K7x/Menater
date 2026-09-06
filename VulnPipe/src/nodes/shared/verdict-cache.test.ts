/**
 * Tests du cache de verdicts de détection.
 *
 * Le test qui compte n'est pas « le cache resert bien ». C'est celui qui
 * garantit qu'il NE resert PAS quand il ne doit pas : un verdict « sain »
 * resservi sur du code qu'on vient de casser, ou « vulnérable » sur du code
 * qu'on vient de corriger, serait un faux négatif instantané et gratuit — le
 * pire mode de défaillance possible pour ce produit.
 */

import { describe, it, expect } from 'vitest';

import { InMemoryVerdictCache, verdictCacheKey } from './verdict-cache.ts';

const BASE = {
  provider: 'gemini',
  model: 'gemini-3.5-flash',
  system: 'Consignes invariantes.',
  user: 'return this.db.orders.findOne({ id, userId: req.user.id });',
};

describe('Clé de cache des verdicts', () => {
  it('est stable pour une question identique', () => {
    expect(verdictCacheKey(BASE)).toBe(verdictCacheKey({ ...BASE }));
  });

  it('change dès que le code montré au modèle change', () => {
    // Le cas qui motive tout le reste : la protection retirée du filtre.
    const corrigé = { ...BASE, user: 'return this.db.orders.findOne({ id });' };
    expect(verdictCacheKey(corrigé)).not.toBe(verdictCacheKey(BASE));
  });

  it('change quand les consignes changent', () => {
    // Un prompt système retouché peut déplacer la calibration : le verdict
    // précédent n'est plus la réponse à la même question.
    expect(verdictCacheKey({ ...BASE, system: 'Autres consignes.' })).not.toBe(verdictCacheKey(BASE));
  });

  it('change de modèle en modèle et de fournisseur en fournisseur', () => {
    // Deux modèles ne rendent pas le même verdict sur le même code : resservir
    // celui de l'un sous le nom de l'autre fausserait toute calibration.
    expect(verdictCacheKey({ ...BASE, model: 'gemini-3.5-pro' })).not.toBe(verdictCacheKey(BASE));
    expect(verdictCacheKey({ ...BASE, provider: 'ollama' })).not.toBe(verdictCacheKey(BASE));
  });

  it('ne confond pas deux découpages différents des mêmes caractères', () => {
    // Sans séparateur non ambigu, `system: "ab", user: "c"` et
    // `system: "a", user: "bc"` donneraient la même clé.
    const a = verdictCacheKey({ ...BASE, system: 'ab', user: 'c' });
    const b = verdictCacheKey({ ...BASE, system: 'a', user: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('Cache en mémoire', () => {
  it('resert un verdict déjà rendu et le compte', () => {
    const cache = new InMemoryVerdictCache();
    const key = verdictCacheKey(BASE);

    expect(cache.get(key)).toBeUndefined();
    cache.set(key, { confidence_score: 0.1 });
    expect(cache.get<{ confidence_score: number }>(key)?.confidence_score).toBe(0.1);

    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("ne répond rien sur du code modifié, même si tout le reste est identique", () => {
    const cache = new InMemoryVerdictCache();
    cache.set(verdictCacheKey(BASE), { confidence_score: 0.1 });

    const cassé = { ...BASE, user: 'return this.db.orders.findOne({ id });' };
    expect(cache.get(verdictCacheKey(cassé))).toBeUndefined();
  });

  it('reste borné et évince le plus ancien accès', () => {
    const cache = new InMemoryVerdictCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // Relire `a` le remet en queue : c'est `b` qui doit sortir.
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("écraser une clé ne fait pas grossir le cache", () => {
    const cache = new InMemoryVerdictCache(10);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });
});
