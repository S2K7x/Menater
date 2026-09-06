/**
 * Fournisseur Anthropic (Claude) via le SDK officiel `@anthropic-ai/sdk`.
 *
 * Deux usages dans VulnPipe :
 *  - comme moteur d'un node de détection, si l'utilisateur préfère payer
 *    plutôt que faire tourner un modèle local ;
 *  - comme master en Phase 5, appelé par l'Agrégateur (CLAUDE.md §2).
 *
 * ============================================================================
 * CONTRAINTES D'API À NE PAS OUBLIER (SDK 0.117.1)
 *
 *  1. `temperature` est REFUSÉ (HTTP 400) sur les modèles récents
 *     (Opus 5, Sonnet 5, Opus 4.7/4.8). C'est le piège n°1 d'une couche
 *     multi-fournisseurs : le contrat `LlmRequest` porte un `temperature`
 *     que Gemini, Ollama et OpenAI acceptent — ici il doit être IGNORÉ,
 *     pas transmis. Le déterminisme se pilote par le prompt.
 *  2. Le prefill de tour assistant (« {"vulnerability": ») est également
 *     refusé sur ces modèles. Pour contraindre le JSON, on passe par
 *     `output_config.format` (sorties structurées), pas par un prefill.
 *  3. `max_tokens` : ~16000 en non-streaming (au-delà, risque de timeout HTTP
 *     côté SDK). On reste sous ce seuil, un verdict est court.
 *  4. La pensée est active par défaut sur Opus 5 et compte dans `max_tokens`.
 * ============================================================================
 */

import Anthropic from '@anthropic-ai/sdk';

import {
  cacheableSystem,
  LlmError,
  parseJsonOutput,
  withRetry,
  type EffortLevel,
  type RetryOptions,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from './types.ts';

/** Modèle par défaut : le plus capable, cf. rôle d'arbitre en Phase 5. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Profondeur de raisonnement. Absent = défaut du modèle (`high`). */
  effort?: EffortLevel;
  /**
   * Réglage de la reprise sur erreur transitoire.
   *
   * Exposé pour les TESTS : sans lui, vérifier qu'une panne est bien signalée
   * demanderait d'attendre les vraies temporisations. La valeur de production
   * est le défaut de `withRetry` — il n'y a rien à régler pour l'utilisateur.
   */
  retry?: RetryOptions;
}

export class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic';
  readonly model: string;

  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly effort?: EffortLevel;
  private readonly retry?: RetryOptions;

  constructor(options: AnthropicOptions = {}) {
    // Le SDK résout aussi ANTHROPIC_API_KEY / profil `ant auth login` seul.
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.maxTokens = options.maxTokens ?? 8_000;
    this.effort = options.effort;
    this.retry = options.retry;
  }

  async complete<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    // La reprise sur erreur transitoire n'était câblée que sur Gemini. Un 429
    // ou un 529 côté Anthropic faisait donc perdre la route pour de bon —
    // et une route non analysée n'est pas une route saine.
    return withRetry(() => this.completeOnce<T>(request), this.retry);
  }

  private async completeOnce<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    const started = Date.now();

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        // Le prompt système part en BLOC MARQUÉ POUR LE CACHE quand il est
        // assez long pour que ce soit permis. C'est le seul texte strictement
        // invariant d'un scan : mêmes consignes et mêmes exemples de
        // calibration pour les quarante routes. Sans marquage, on repayait
        // ce préfixe plein tarif à chaque route ; avec, la première le paie
        // et les suivantes le relisent à 10 %.
        //
        // Le seuil vient de l'API : en dessous d'un millier de tokens un bloc
        // n'est pas mis en cache, et le marquer coûterait la prime d'écriture
        // sans jamais rien rendre. On estime en caractères (~4 par token),
        // parce que le compte exact n'est connu qu'après l'appel.
        system: cacheableSystem(request.system),
        messages: [{ role: 'user', content: request.user }],
        // Sorties structurées — remplace le prefill, refusé sur ces modèles.
        output_config: {
          format: {
            type: 'json_schema',
            schema: { ...request.schema, additionalProperties: false },
          },
          // Omis quand l'utilisateur n'a rien choisi : le défaut du modèle
          // (`high`) vaut mieux qu'une valeur qu'on aurait inventée.
          ...(this.effort ? { effort: this.effort } : {}),
        },
        // `temperature` volontairement ABSENT : 400 sur les modèles récents.
      } as Anthropic.MessageCreateParamsNonStreaming);

      if (message.stop_reason === 'refusal') {
        throw new LlmError(
          'anthropic',
          'bad_output',
          "Claude a refusé la requête (classificateurs de sécurité). L'analyse n'a pas eu lieu : ne pas considérer cette route comme saine.",
          false
        );
      }

      const raw = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (!raw) {
        throw new LlmError(
          'anthropic',
          'bad_output',
          `Réponse sans texte (stop_reason=${message.stop_reason}).`,
          true
        );
      }

      return {
        parsed: parseJsonOutput<T>('anthropic', raw),
        raw,
        provider: this.provider,
        model: this.model,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          // Les jetons relus depuis le cache sont facturés à 10 % : les
          // confondre avec des jetons d'entrée pleins ferait afficher une
          // dépense que personne n'a payée.
          cached_input_tokens:
            (message.usage.cache_read_input_tokens ?? 0) || undefined,
        },
        latency_ms: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;

      // Exceptions typées du SDK — jamais de comparaison de chaînes.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new LlmError('anthropic', 'auth', 'Clé API Anthropic invalide ou absente.', false);
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new LlmError('anthropic', 'rate_limit', 'Quota Anthropic dépassé.', true);
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new LlmError('anthropic', 'unavailable', 'API Anthropic injoignable.', true);
      }
      if (error instanceof Anthropic.APIError) {
        throw new LlmError(
          'anthropic',
          error.status && error.status >= 500 ? 'unavailable' : 'unknown',
          `Anthropic ${error.status} : ${error.message}`,
          !!error.status && error.status >= 500
        );
      }
      throw new LlmError('anthropic', 'unknown', (error as Error).message, false);
    }
  }
}
