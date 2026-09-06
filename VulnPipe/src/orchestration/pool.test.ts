/**
 * Tests du parallélisme borné.
 *
 * Ce qui est vérifié ici n'est pas « ça va plus vite » — une mesure de durée
 * en test est un test qui rougit sur une machine chargée. Ce sont les trois
 * propriétés dont le reste de la pipeline dépend :
 *
 *   1. la borne est réellement tenue (sinon le quota du fournisseur saute) ;
 *   2. les résultats sortent dans l'ordre des ENTRÉES (sinon le rapport change
 *      d'ordre à chaque exécution et n'est plus comparable) ;
 *   3. une tâche qui échoue ne fait perdre aucune des autres.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_DETECTION_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  mapWithConcurrency,
  normalizeConcurrency,
} from './pool.ts';

/** Attend un tour de boucle : suffit à laisser les autres tâches démarrer. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('mapWithConcurrency', () => {
  it("ne dépasse jamais la borne, même quand il reste beaucoup à faire", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([...Array(20).keys()], 4, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return value;
    });

    expect(peak).toBe(4);
  });

  it('occupe réellement la fenêtre plutôt que de traiter un par un', async () => {
    let peak = 0;
    let inFlight = 0;

    await mapWithConcurrency([...Array(10).keys()], 5, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return value;
    });

    // Sans parallélisme le pic vaudrait 1 : c'est la régression que ce test
    // attrape si quelqu'un remet une boucle séquentielle.
    expect(peak).toBe(5);
  });

  it("rend les résultats dans l'ordre des entrées, pas dans celui des réponses", async () => {
    // La première tâche est la plus lente : elle finit dernière. Son résultat
    // doit néanmoins ressortir en tête.
    const delays = [40, 5, 5, 5];
    const settled = await mapWithConcurrency(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });

    expect(settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : null))).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("annonce les achèvements dans l'ordre d'arrivée — c'est ce que le direct montre", async () => {
    const finished: number[] = [];
    await mapWithConcurrency([40, 5], 2, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    }, (_outcome, _item, index) => finished.push(index));

    expect(finished).toEqual([1, 0]);
  });

  it('ne perd aucune tâche quand une autre échoue', async () => {
    const settled = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      if (value === 2) throw new Error('boum');
      return value * 10;
    });

    expect(settled.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    // Le motif de l'échec est conservé : une route non analysée doit pouvoir
    // être NOMMÉE dans le rapport, pas juste comptée.
    expect(settled[1]!.status === 'rejected' && (settled[1]!.reason as Error).message).toBe('boum');
  });

  it('traite tout le lot même quand la première tâche échoue immédiatement', async () => {
    // Avec `Promise.all`, un rejet en tête abandonne les tâches en vol.
    let ran = 0;
    await mapWithConcurrency([...Array(8).keys()], 3, async (value) => {
      ran += 1;
      if (value === 0) throw new Error('immédiat');
      return value;
    });

    expect(ran).toBe(8);
  });

  it('accepte une liste vide sans rien lancer', async () => {
    let ran = 0;
    const settled = await mapWithConcurrency([], 4, async () => {
      ran += 1;
    });
    expect(settled).toEqual([]);
    expect(ran).toBe(0);
  });

  it("ramène une borne plus large que le lot à la taille du lot", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 16, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return value;
    });
    expect(peak).toBe(2);
  });

  it('à 1, se comporte exactement comme une boucle séquentielle', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([...Array(5).keys()], 1, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return value;
    });
    expect(peak).toBe(1);
  });
});

describe('normalizeConcurrency', () => {
  it('accepte les entiers dans les bornes', () => {
    expect(normalizeConcurrency(MIN_CONCURRENCY)).toBe(MIN_CONCURRENCY);
    expect(normalizeConcurrency(MAX_CONCURRENCY)).toBe(MAX_CONCURRENCY);
    expect(normalizeConcurrency('6')).toBe(6);
  });

  it('refuse plutôt que de rabattre en silence', () => {
    // Rabattre 200 sur 16 ferait croire au réglage appliqué. L'appelant doit
    // pouvoir DIRE que l'entrée était mauvaise.
    for (const bad of [0, -1, 200, 2.5, 'beaucoup', '', null, undefined, NaN, {}]) {
      expect(normalizeConcurrency(bad)).toBeNull();
    }
  });

  it('garde un défaut sûr pour le palier gratuit le plus étroit', () => {
    // Gemini gratuit : 20 requêtes/minute. Le défaut doit rester dessous avec
    // de la marge, sinon une installation sans clé payante croule sur les 429.
    expect(DEFAULT_DETECTION_CONCURRENCY).toBeLessThanOrEqual(5);
    expect(DEFAULT_DETECTION_CONCURRENCY).toBeGreaterThan(1);
  });
});
