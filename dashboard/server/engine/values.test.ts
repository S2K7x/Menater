/**
 * Tests des références de valeurs et des conditions.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Ce module lit des chemins fournis par une DÉFINITION DE WORKFLOW, c'est-à-dire
 * par de la donnée éditable depuis l'interface. Deux familles de défauts s'y
 * cachent, et aucune ne lève d'erreur toute seule :
 *
 *   - la traversée de prototype : `__proto__.x` ne plante pas, il pollue ;
 *   - les coercitions de JavaScript : `'10' > 9` vaut `true`, `0 == ''` aussi.
 *     Sur une console de triage, ce sont des décisions FAUSSES rendues en
 *     silence — un seuil de confiance comparé comme une chaîne classe une
 *     alerte critique en faux positif.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  ConditionError,
  PathError,
  ResolveError,
  evaluate,
  parsePath,
  readPath,
  resolve,
  validateCondition,
  type ResolveScope,
} from './values.ts';

const scope = (over: Partial<ResolveScope> = {}): ResolveScope => ({
  input: {},
  outputs: new Map(),
  vars: new Map(),
  ctx: {},
  ...over,
});

describe('chemins', () => {
  it('lit un champ imbriqué', () => {
    expect(readPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('rend undefined pour un chemin qui ne mène nulle part', () => {
    // `undefined` et non `null` : « absent » et « vide » sont deux choses.
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });

  it('ne lit pas les propriétés héritées', () => {
    // `{}.toString` existe : sans `Object.hasOwn`, un chemin `toString`
    // renverrait une fonction là où le workflow attend une donnée.
    expect(readPath({}, 'toString')).toBeUndefined();
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'REFUSE de traverser « %s »',
    (segment) => {
      // La défense qui compte : une définition de workflow est de la donnée
      // éditable ; la laisser atteindre le prototype changerait le
      // comportement de tout le processus.
      expect(() => parsePath(`a.${segment}.b`)).toThrow(PathError);
    },
  );

  it('ne pollue rien, même sur une tentative directe', () => {
    expect(() => readPath({}, '__proto__.pollué')).toThrow(PathError);
    expect(({} as Record<string, unknown>).pollué).toBeUndefined();
  });
});

describe('résolution des références', () => {
  it('rend une constante telle quelle', () => {
    expect(resolve({ kind: 'const', value: 7 }, scope())).toBe(7);
  });

  it('lit l’entrée du nœud', () => {
    expect(resolve({ kind: 'input', path: 'x' }, scope({ input: { x: 'ok' } }))).toBe('ok');
  });

  it('lit la sortie d’un nœud par son IDENTIFIANT', () => {
    const s = scope({ outputs: new Map([['n-42', { verdict: 'true_positive' }]]) });
    expect(resolve({ kind: 'node', nodeId: 'n-42', path: 'verdict' }, s)).toBe('true_positive');
  });

  it('distingue « nœud jamais exécuté » de « champ absent »', () => {
    // Un défaut de CÂBLAGE ne se cherche pas au même endroit qu'une donnée
    // manquante. Le message doit envoyer au bon endroit.
    expect(() => resolve({ kind: 'node', nodeId: 'jamais', path: 'x' }, scope()))
      .toThrow(/produced no output/);
  });

  it('LÈVE sur une variable inexistante au lieu d’inventer', () => {
    // « Ne jamais combler un trou par une valeur par défaut. » Un seuil dont
    // la variable a été supprimée doit faire échouer le nœud, pas se comparer
    // silencieusement à zéro.
    expect(() => resolve({ kind: 'var', key: 'seuil' }, scope())).toThrow(ResolveError);
  });

  it('rend une variable existante, y compris si elle vaut 0 ou false', () => {
    const s = scope({ vars: new Map<string, unknown>([['a', 0], ['b', false]]) });
    expect(resolve({ kind: 'var', key: 'a' }, s)).toBe(0);
    expect(resolve({ kind: 'var', key: 'b' }, s)).toBe(false);
  });

  it('rend le contexte du moteur — ce qui remplace $now et $execution.id', () => {
    const s = scope({ ctx: { now: '2026-08-24T10:00:00Z', runId: 'run-1' } });
    expect(resolve({ kind: 'ctx', field: 'now' }, s)).toBe('2026-08-24T10:00:00Z');
    expect(resolve({ kind: 'ctx', field: 'runId' }, s)).toBe('run-1');
  });
});

describe('conditions', () => {
  const withInput = (input: unknown) => scope({ input });
  const at = (path: string) => ({ kind: 'input' as const, path });
  const val = (value: unknown) => ({ kind: 'const' as const, value });

  it('teste un booléen — la seule forme utilisée par les 6 workflows', () => {
    expect(evaluate({ left: at('ok'), op: 'isTrue' }, withInput({ ok: true }))).toBe(true);
    // STRICT : `1` n'est pas `true`, `'true'` non plus.
    expect(evaluate({ left: at('ok'), op: 'isTrue' }, withInput({ ok: 1 }))).toBe(false);
    expect(evaluate({ left: at('ok'), op: 'isTrue' }, withInput({ ok: 'true' }))).toBe(false);
  });

  it('distingue « absent » de « faux »', () => {
    expect(evaluate({ left: at('x'), op: 'missing' }, withInput({}))).toBe(true);
    expect(evaluate({ left: at('x'), op: 'missing' }, withInput({ x: false }))).toBe(false);
    expect(evaluate({ left: at('x'), op: 'exists' }, withInput({ x: 0 }))).toBe(true);
  });

  it('compare en égalité STRICTE', () => {
    // `0 == ''` et `null == undefined` valent `true` en JavaScript. Une console
    // de triage ne peut pas se le permettre.
    expect(evaluate({ left: at('a'), op: 'eq', right: val('') }, withInput({ a: 0 }))).toBe(false);
    expect(evaluate({ left: at('a'), op: 'eq', right: val(null) }, withInput({}))).toBe(false);
  });

  it('REFUSE de comparer numériquement ce qui n’est pas un nombre', () => {
    // LE TEST QUI COMPTE. `'10' > 9` vaut `true` en JavaScript, et `'9' > '10'`
    // aussi : comparer un seuil de confiance reçu en chaîne rendrait une
    // décision fausse SANS lever la moindre erreur.
    expect(() =>
      evaluate({ left: at('c'), op: 'gte', right: val(0.85) }, withInput({ c: '0.9' })),
    ).toThrow(ConditionError);
  });

  it('compare des nombres quand ce sont des nombres', () => {
    expect(evaluate({ left: at('c'), op: 'gte', right: val(0.85) }, withInput({ c: 0.9 }))).toBe(true);
    expect(evaluate({ left: at('c'), op: 'lt', right: val(0.85) }, withInput({ c: 0.9 }))).toBe(false);
  });

  it('teste l’appartenance à une liste', () => {
    const s = withInput({ sev: 'critical' });
    const list = val(['high', 'critical']);
    expect(evaluate({ left: at('sev'), op: 'in', right: list }, s)).toBe(true);
    expect(evaluate({ left: at('sev'), op: 'notIn', right: list }, s)).toBe(false);
  });

  it('refuse « in » sur autre chose qu’une liste', () => {
    expect(() =>
      evaluate({ left: at('a'), op: 'in', right: val('abc') }, withInput({ a: 'a' })),
    ).toThrow(ConditionError);
  });
});

describe('validation à la publication', () => {
  it('refuse un opérateur binaire sans valeur de droite', () => {
    // Refusé quand quelqu'un l'écrit dans le formulaire, pas découvert au
    // milieu d'une alerte critique trois semaines plus tard.
    expect(() => validateCondition({ left: { kind: 'const', value: 1 }, op: 'gte' }))
      .toThrow(ConditionError);
  });

  it('accepte un opérateur unaire sans valeur de droite', () => {
    expect(() => validateCondition({ left: { kind: 'input', path: 'ok' }, op: 'isTrue' }))
      .not.toThrow();
  });

  it('refuse un chemin dangereux avant toute exécution', () => {
    expect(() =>
      validateCondition({ left: { kind: 'input', path: '__proto__.x' }, op: 'exists' }),
    ).toThrow(PathError);
  });
});
