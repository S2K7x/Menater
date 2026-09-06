/**
 * Fournisseur Gemini (Google AI Studio).
 *
 * ============================================================================
 * API RÉELLEMENT OBSERVÉE (probe : `node scripts/probe-gemini.mjs`)
 *   endpoint : POST {BASE}/models/{model}:generateContent
 *   auth     : en-tête `x-goog-api-key` (PAS de clé dans l'URL — elle finirait
 *              dans les logs d'accès et les historiques shell)
 *
 *   Réponse (clés racine)  : candidates, usageMetadata, modelVersion, responseId
 *   candidates[0]          : content, finishReason, index
 *   content                : { parts: [...], role }
 *   parts[i]               : { text, thoughtSignature }
 *   usageMetadata          : { promptTokenCount, candidatesTokenCount,
 *                              totalTokenCount, thoughtsTokenCount, ... }
 *
 * FAITS MESURÉS QUI ONT DIRIGÉ CE CODE
 *  1. SANS `responseSchema`, gemini-3.5-flash répond en PROSE markdown
 *     ("Voici l'analyse... ### confidence_score **0.95**") et `JSON.parse`
 *     échoue. La sortie structurée n'est donc pas une optimisation, c'est
 *     une condition de fonctionnement.
 *  2. `thoughtsTokenCount` est le vrai poste de coût : 634 tokens de
 *     raisonnement pour 104 tokens de réponse (6×). `thinkingLevel: 'low'`
 *     le ramène à 299 et la latence de 3,7 s à 2,5 s — d'où le défaut ci-dessous.
 *  3. `temperature: 0` donne deux sorties strictement identiques : les tests
 *     peuvent s'appuyer dessus.
 *  4. Une clé invalide renvoie HTTP 400 / status INVALID_ARGUMENT (et non 401).
 * ============================================================================
 */

import {
  LlmError,
  parseJsonOutput,
  withRetry,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from './types.ts';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Rapide et peu coûteux : le rôle « premier filtre » de l'architecture. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Profondeur de raisonnement. 'low' par défaut : mesuré 2× moins de tokens
   * de pensée et ~30 % de latence en moins, pour un verdict équivalent sur nos
   * cas de test. Passer à 'high' seulement si le recall se dégrade.
   */
  thinkingLevel?: 'low' | 'high';
  timeoutMs?: number;
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { code?: number; status?: string; message?: string };
}

export class GeminiClient implements LlmClient {
  readonly provider = 'gemini';
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly thinkingLevel: 'low' | 'high';
  private readonly timeoutMs: number;

  /**
   * Passe à true dès que le modèle rejette `thinkingConfig`.
   *
   * Tous les modèles Gemini n'acceptent pas ce champ : `gemini-2.5-flash-lite`
   * répond `400 INVALID_ARGUMENT : Thinking level is not supported for this
   * model`. Plutôt qu'une liste de modèles codée en dur — qui serait fausse au
   * prochain modèle publié — on tente, on observe le refus, on réessaie sans,
   * et on s'en souvient pour les appels suivants.
   */
  private thinkingUnsupported = false;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) {
      throw new LlmError('gemini', 'auth', 'GEMINI_API_KEY manquante.', false);
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.thinkingLevel = options.thinkingLevel ?? 'low';
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private buildBody(request: LlmRequest): unknown {
    return {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        // Sans ces deux champs, la réponse est de la prose (fait n°1).
        responseMimeType: 'application/json',
        responseSchema: request.schema,
        temperature: request.temperature ?? 0,
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(this.thinkingUnsupported ? {} : { thinkingConfig: { thinkingLevel: this.thinkingLevel } }),
      },
    };
  }

  private async post(request: LlmRequest): Promise<{ response: Response; json: GeminiResponseBody }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(this.buildBody(request)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new LlmError(
        'gemini',
        'unavailable',
        `Appel Gemini impossible : ${(error as Error).message}`,
        true
      );
    }
    return { response, json: (await response.json()) as GeminiResponseBody };
  }

  async complete<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    // Reprise sur quota : le palier gratuit plafonne à 20 requêtes/minute et
    // l'API indique elle-même le délai à respecter.
    return withRetry(() => this.completeOnce<T>(request), {
      onWait: (ms) =>
        console.error(`[gemini] quota atteint, nouvelle tentative dans ${Math.round(ms / 1000)}s`),
    });
  }

  private async completeOnce<T>(request: LlmRequest): Promise<LlmResponse<T>> {
    const started = Date.now();

    let { response, json } = await this.post(request);

    // Le modèle refuse `thinkingConfig` : on retire le champ et on refait
    // l'appel une seule fois. Sans ça, tout un scan échoue sur un modèle
    // parfaitement utilisable — observé sur gemini-2.5-flash-lite.
    if (!this.thinkingUnsupported && /thinking/i.test(json.error?.message ?? '')) {
      this.thinkingUnsupported = true;
      ({ response, json } = await this.post(request));
    }

    if (json.error || !response.ok) {
      const status = json.error?.status ?? String(response.status);
      const message = json.error?.message ?? 'erreur inconnue';
      // Une clé invalide sort en 400 INVALID_ARGUMENT, pas en 401 (fait n°4).
      const kind =
        response.status === 429
          ? 'rate_limit'
          : response.status === 401 || response.status === 403 || /api key/i.test(message)
            ? 'auth'
            : response.status >= 500
              ? 'unavailable'
              : 'unknown';
      throw new LlmError('gemini', kind, `Gemini ${status} : ${message}`, kind !== 'auth');
    }

    const candidate = json.candidates?.[0];
    const raw = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    if (!raw) {
      throw new LlmError(
        'gemini',
        'bad_output',
        `Réponse vide (finishReason=${candidate?.finishReason ?? 'inconnu'}).`,
        true
      );
    }

    return {
      parsed: parseJsonOutput<T>('gemini', raw),
      raw,
      provider: this.provider,
      model: this.model,
      usage: {
        input_tokens: json.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        thinking_tokens: json.usageMetadata?.thoughtsTokenCount,
      },
      latency_ms: Date.now() - started,
    };
  }
}
