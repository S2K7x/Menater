/**
 * Double de test déterministe.
 *
 * Pourquoi il existe : PHASE_3 demande d'exécuter les 3 cas contre un vrai
 * modèle. C'est fait — mais dans `scripts/bench-idor.mjs`, pas dans la suite
 * de tests. Une suite qui appelle une API réseau à chaque `npm test` est lente,
 * coûteuse, échoue sans clé, et surtout ne teste PAS le node : elle teste le
 * modèle. Les deux besoins sont réels et séparés :
 *
 *   - `npm test`      → logique du node (scanner, retry, garde-fous, agrégation)
 *                       avec ce faux client : rapide, hors-ligne, reproductible.
 *   - `npm run bench` → calibration du modèle sur les 3 cas réels, scores
 *                       relevés et recopiés dans node.test.ts.
 */

import type { LlmClient, LlmRequest, LlmResponse } from './types.ts';

export interface FakeTurn {
  /** Objet renvoyé comme `parsed`, ou fonction d'erreur à lever. */
  parsed?: unknown;
  error?: Error;
}

/**
 * Rejoue une séquence de réponses préprogrammées et enregistre les requêtes
 * reçues — ce qui permet d'affirmer que le node a bien renvoyé un contexte
 * plus profond lors du retry, par exemple.
 */
export class FakeLlmClient implements LlmClient {
  readonly provider = 'fake';
  readonly model = 'fake-model';

  readonly requests: LlmRequest[] = [];
  private readonly turns: FakeTurn[];
  private index = 0;

  constructor(turns: FakeTurn[]) {
    this.turns = turns;
  }

  get callCount(): number {
    return this.index;
  }

  async complete<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;

    if (!turn) throw new Error('FakeLlmClient : aucune réponse programmée.');
    if (turn.error) throw turn.error;

    return {
      parsed: turn.parsed as T,
      raw: JSON.stringify(turn.parsed),
      provider: this.provider,
      model: this.model,
      usage: { input_tokens: 100, output_tokens: 50 },
      latency_ms: 1,
    };
  }
}
