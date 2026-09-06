/**
 * Fournisseur Ollama (LLM local) — le mode 100 % gratuit de CLAUDE.md §1.
 *
 * ============================================================================
 * API RÉELLEMENT OBSERVÉE (probe : `node scripts/probe-ollama.mjs`)
 *   endpoint : POST http://localhost:11434/api/chat
 *   modèle testé : qwen3.5:9b (Q4_K_M, capabilities incluant "thinking")
 *
 *   Réponse : { model, created_at, message: { role, content, thinking? },
 *               done, done_reason, total_duration, prompt_eval_count,
 *               eval_count, ... }
 *
 * FAITS MESURÉS
 *  1. Les modèles « thinking » (qwen3.5) renvoient un champ `message.thinking`
 *     séparé — ~1050 caractères de raisonnement en plus de la réponse.
 *     `think: false` le supprime et fait passer l'appel de 8,9 s à 2,9 s.
 *  2. `format: 'json'` SEUL ne suffit pas : le modèle a renvoyé
 *     `confidence_score: 100.0` (hors plage 0-1) et un `reason` en texte libre.
 *     Il faut passer un JSON Schema complet dans `format` pour contraindre
 *     réellement les valeurs — l'`enum` est alors respecté.
 *  3. Le serveur local peut TOMBER en cours de série d'appels (observé une
 *     fois, ECONNREFUSED sur les appels suivants ; non reproductible ensuite).
 *     D'où le mapping explicite vers `unavailable` + `retryable: true` :
 *     un node ne doit jamais interpréter une mort du serveur comme un verdict.
 * ============================================================================
 */

import {
  LlmError,
  parseJsonOutput,
  withRetry,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type RetryOptions,
} from './types.ts';

const DEFAULT_BASE_URL = 'http://localhost:11434';

export interface OllamaOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Laisser false : le raisonnement visible triple la latence sans gain mesuré. */
  think?: boolean;
  /**
   * Réglage de la reprise sur erreur transitoire.
   *
   * Exposé pour les TESTS : sans lui, vérifier qu'une panne est bien signalée
   * demanderait d'attendre les vraies temporisations. La valeur de production
   * est le défaut de `withRetry` — il n'y a rien à régler pour l'utilisateur.
   */
  retry?: RetryOptions;
}

interface OllamaResponseBody {
  message?: { role?: string; content?: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
  error?: string;
}

export class OllamaClient implements LlmClient {
  readonly provider = 'ollama';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly think: boolean;
  private readonly retry?: RetryOptions;

  constructor(options: OllamaOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.think = options.think ?? false;
    this.retry = options.retry;
  }

  async complete<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    // Un serveur local qui n'a pas fini de charger son modèle répond
    // `unavailable` : c'est exactement le cas que la reprise doit couvrir.
    return withRetry(() => this.completeOnce<T>(request), this.retry);
  }

  private async completeOnce<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: this.think,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          // Schéma complet, pas `'json'` : sinon les valeurs partent hors plage (fait n°2).
          format: request.schema,
          options: { temperature: request.temperature ?? 0, seed: 42 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Serveur local arrêté ou tombé (fait n°3) — jamais un verdict.
      throw new LlmError(
        'ollama',
        'unavailable',
        `Serveur Ollama injoignable sur ${this.baseUrl} : ${(error as Error).message}. Est-il démarré (\`ollama serve\`) ?`,
        true
      );
    }

    const json = (await response.json()) as OllamaResponseBody;

    if (json.error || !response.ok) {
      throw new LlmError(
        'ollama',
        response.status === 404 ? 'unknown' : 'unavailable',
        `Ollama ${response.status} : ${json.error ?? 'erreur inconnue'}`,
        true
      );
    }

    const raw = json.message?.content ?? '';
    if (!raw) {
      throw new LlmError(
        'ollama',
        'bad_output',
        `Réponse vide (done_reason=${json.done_reason ?? 'inconnu'}).`,
        true
      );
    }

    return {
      parsed: parseJsonOutput<T>('ollama', raw),
      raw,
      provider: this.provider,
      model: this.model,
      usage: {
        input_tokens: json.prompt_eval_count ?? 0,
        output_tokens: json.eval_count ?? 0,
      },
      latency_ms: Date.now() - started,
    };
  }
}
