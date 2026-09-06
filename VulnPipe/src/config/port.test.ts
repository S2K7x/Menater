/**
 * Tests de résolution du port.
 *
 * ============================================================================
 * LA PANNE QU'ILS EMPÊCHENT DE REVENIR
 *
 * `Number(process.env.PORT ?? 4319)` a fait démarrer le service sur 5174 — le
 * port de l'interface web — parce qu'un harnais de prévisualisation posait
 * `PORT`. La console relayait toujours vers 4319 et répondait « démarrer le
 * service d'analyse » sur un service qui tournait déjà.
 *
 * Aucun de ces symptômes ne désigne la cause. D'où ces tests.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, PortError, portSource, resolvePort } from './port.ts';

describe('précédence', () => {
  it('le nom explicite gagne sur le nom générique', () => {
    // C'EST LE CŒUR DU CORRECTIF : `PORT` traîne dans l'environnement de
    // beaucoup de contextes, `VULNPIPE_API_PORT` n'y est jamais par accident.
    expect(resolvePort({ VULNPIPE_API_PORT: '4319', PORT: '5174' })).toBe(4319);
  });

  it('accepte le nom générique quand c’est le seul disponible', () => {
    // Conservé pour les hébergeurs qui n'offrent que `PORT`.
    expect(resolvePort({ PORT: '8080' })).toBe(8080);
  });

  it('retombe sur le défaut documenté', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
  });

  it('ignore une variable vide plutôt que de la lire comme un zéro', () => {
    expect(resolvePort({ VULNPIPE_API_PORT: '', PORT: '' })).toBe(DEFAULT_PORT);
  });
});

describe('valeur invalide', () => {
  it('REFUSE au lieu de retomber en silence sur le défaut', () => {
    // `Number('abc')` vaut `NaN`, et `listen(NaN)` prend un port ALÉATOIRE :
    // le service démarrerait « avec succès » à une adresse que personne ne
    // connaît. Exactement la panne qu'on vient de corriger.
    expect(() => resolvePort({ PORT: 'abc' })).toThrow(PortError);
  });

  it.each(['0', '65536', '-1', '3.5'])('refuse « %s »', (value) => {
    expect(() => resolvePort({ VULNPIPE_API_PORT: value })).toThrow(PortError);
  });

  it('nomme la variable fautive dans le message', () => {
    expect(() => resolvePort({ PORT: 'abc' })).toThrow(/PORT="abc"/);
  });
});

describe('provenance', () => {
  it('se dit, pour que le log réponde à « pourquoi pas 4319 ? »', () => {
    expect(portSource({ VULNPIPE_API_PORT: '1', PORT: '2' })).toBe('VULNPIPE_API_PORT');
    expect(portSource({ PORT: '2' })).toBe('PORT');
    expect(portSource({})).toBe('défaut');
  });
});
