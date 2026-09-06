/**
 * Sélection du fournisseur de LLM par configuration.
 *
 * Un node de détection ne doit JAMAIS importer un fournisseur concret : il
 * reçoit un `LlmClient`. Changer de moteur = changer une variable
 * d'environnement, pas une ligne de code de détection.
 *
 *   VULNPIPE_LLM_PROVIDER = gemini | ollama | anthropic | openai | openrouter | custom
 *   VULNPIPE_LLM_MODEL    = surcharge du modèle (optionnel)
 *
 * Clés lues : GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,
 *             OPENROUTER_API_KEY, VULNPIPE_LLM_BASE_URL (pour `custom`).
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { DEFAULT_LOCALE, type Locale } from '../../../i18n/locale.ts';
import { messages } from '../../../i18n/messages.ts';
import { AnthropicClient, DEFAULT_ANTHROPIC_MODEL } from './anthropic.ts';
import { ClaudeSubscriptionClient, DEFAULT_SUBSCRIPTION_MODEL } from './claude-subscription.ts';
import { DEFAULT_GEMINI_MODEL, GeminiClient } from './gemini.ts';
import { OllamaClient } from './ollama.ts';
import { OpenAiCompatibleClient } from './openai-compatible.ts';
import { EFFORT_LEVELS, LlmError, type EffortLevel, type LlmClient } from './types.ts';

export type ProviderName =
  | 'gemini'
  | 'ollama'
  | 'anthropic'
  | 'claude-subscription'
  | 'openai'
  | 'openrouter'
  | 'custom';

export const SUPPORTED_PROVIDERS: ProviderName[] = [
  'gemini',
  'ollama',
  'anthropic',
  'claude-subscription',
  'openai',
  'openrouter',
  'custom',
];

/**
 * Claude Code est-il installé sur cette machine ?
 *
 * On cherche l'exécutable dans le PATH plutôt que de tenter un appel : c'est
 * synchrone, gratuit, et suffisant pour distinguer « pas installé » (message
 * actionnable) de « installé mais peut-être pas connecté » — ce second cas
 * n'est constatable qu'à l'appel, et on ne prétend donc rien à son sujet.
 */
export function claudeCodeInstalled(env: { PATH?: string } = process.env): boolean {
  const path = env.PATH;
  if (!path) return false;
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(join(directory, 'claude')));
}

export interface FactoryEnv {
  VULNPIPE_LLM_PROVIDER?: string;
  VULNPIPE_LLM_MODEL?: string;
  VULNPIPE_LLM_BASE_URL?: string;
  /** Profondeur de raisonnement : low | medium | high | xhigh | max. */
  VULNPIPE_LLM_EFFORT?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Nom alternatif rencontré dans la nature — les deux sont acceptés. */
  OPEN_ROUTER_API_KEY?: string;
  OLLAMA_HOST?: string;
}

/**
 * Fournisseur par défaut : Gemini.
 *
 * `CLAUDE.md` §1 vise le local gratuit comme cible, mais un défaut qui exige
 * un `ollama serve` en marche et un modèle de 6 Go téléchargé échoue au
 * premier lancement chez la plupart des utilisateurs. Gemini part d'une seule
 * clé et reste peu coûteux ; `VULNPIPE_LLM_PROVIDER=ollama` bascule en local.
 */
export const DEFAULT_PROVIDER: ProviderName = 'gemini';

/**
 * Lit un niveau d'effort, en refusant silencieusement ce qui n'en est pas un.
 *
 * Une valeur inconnue vaut « pas de choix » plutôt qu'une erreur : le défaut du
 * modèle est un repli sûr, et faire échouer un scan entier pour une faute de
 * frappe dans un réglage de confort serait disproportionné.
 */
export function parseEffort(value: string | undefined): EffortLevel | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim() as EffortLevel;
  return EFFORT_LEVELS.includes(normalized) ? normalized : undefined;
}

export function createLlmClient(env: FactoryEnv = process.env as FactoryEnv): LlmClient {
  const requested = (env.VULNPIPE_LLM_PROVIDER ?? DEFAULT_PROVIDER).toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(requested as ProviderName)) {
    throw new LlmError(
      requested,
      'unknown',
      `Unknown provider "${requested}". Accepted values: ${SUPPORTED_PROVIDERS.join(', ')}.`,
      false
    );
  }

  const model = env.VULNPIPE_LLM_MODEL;
  const effort = parseEffort(env.VULNPIPE_LLM_EFFORT);

  switch (requested as ProviderName) {
    case 'gemini':
      return new GeminiClient({
        apiKey: requireKey(env.GEMINI_API_KEY, 'GEMINI_API_KEY', 'gemini'),
        model: model ?? DEFAULT_GEMINI_MODEL,
      });

    case 'ollama':
      return new OllamaClient({
        model: model ?? 'qwen3.5:9b',
        baseUrl: env.OLLAMA_HOST,
      });

    case 'anthropic':
      return new AnthropicClient({
        apiKey: env.ANTHROPIC_API_KEY,
        model: model ?? DEFAULT_ANTHROPIC_MODEL,
        effort,
      });

    // Abonnement Claude Pro/Max via Claude Code — aucune clé API à fournir :
    // l'authentification est la session que la personne a ouverte elle-même.
    case 'claude-subscription':
      return new ClaudeSubscriptionClient({
        model: model ?? DEFAULT_SUBSCRIPTION_MODEL,
        effort,
        onWarning: (text) => console.warn(`[VulnPipe] ${text}`),
      });

    case 'openai':
      return new OpenAiCompatibleClient({
        providerName: 'openai',
        apiKey: requireKey(env.OPENAI_API_KEY, 'OPENAI_API_KEY', 'openai'),
        model: model ?? 'gpt-5',
        baseUrl: 'https://api.openai.com/v1',
      });

    case 'openrouter':
      return new OpenAiCompatibleClient({
        providerName: 'openrouter',
        apiKey: requireKey(
          env.OPENROUTER_API_KEY ?? env.OPEN_ROUTER_API_KEY,
          'OPENROUTER_API_KEY (ou OPEN_ROUTER_API_KEY)',
          'openrouter'
        ),
        // `openrouter/free` route vers les modèles gratuits uniquement :
        // tarif 0 garanti, vérifié sur l'API (pricing prompt/completion = 0).
        model: model ?? 'openrouter/free',
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: { 'X-Title': 'VulnPipe' },
      });

    case 'custom': {
      const baseUrl = env.VULNPIPE_LLM_BASE_URL;
      if (!baseUrl) {
        throw new LlmError(
          'custom',
          'unknown',
          'VULNPIPE_LLM_BASE_URL is required when VULNPIPE_LLM_PROVIDER=custom.',
          false
        );
      }
      return new OpenAiCompatibleClient({
        providerName: 'custom',
        // Beaucoup de serveurs locaux OpenAI-compatibles ignorent la clé.
        apiKey: env.OPENAI_API_KEY ?? 'non-utilisee',
        model: model ?? 'local-model',
        baseUrl,
      });
    }
  }
}

function requireKey(value: string | undefined, envName: string, provider: string): string {
  if (!value) {
    throw new LlmError(
      provider,
      'auth',
      `${envName} is missing. Add it to .env (that file is git-ignored).`,
      false
    );
  }
  return value;
}

/**
 * Disponibilité réelle de chaque fournisseur.
 *
 * NE PAS déduire la disponibilité d'un `createLlmClient()` qui n'a pas levé :
 * le SDK Anthropic construit un client sans clé et n'échoue qu'au moment de
 * l'appel. L'interface annonçait donc « prêt » un fournisseur qui allait
 * planter en plein scan — bug attrapé par un test.
 */
export interface ProviderAvailability {
  id: ProviderName;
  available: boolean;
  /** Ce qui manque, formulé pour être actionnable. */
  why: string | null;
}

export function describeProviders(
  env: FactoryEnv = process.env as FactoryEnv,
  locale: Locale = DEFAULT_LOCALE
): ProviderAvailability[] {
  const t = messages(locale).providers;
  const ready = (id: ProviderName): ProviderAvailability => ({ id, available: true, why: null });
  const missing = (id: ProviderName, why: string): ProviderAvailability => ({
    id,
    available: false,
    why,
  });

  return SUPPORTED_PROVIDERS.map((id) => {
    switch (id) {
      case 'gemini':
        return env.GEMINI_API_KEY ? ready(id) : missing(id, t.missingKey('GEMINI_API_KEY'));
      case 'anthropic':
        return env.ANTHROPIC_API_KEY ? ready(id) : missing(id, t.missingAnthropic);
      case 'openai':
        return env.OPENAI_API_KEY ? ready(id) : missing(id, t.missingKey('OPENAI_API_KEY'));
      case 'openrouter':
        return env.OPENROUTER_API_KEY ?? env.OPEN_ROUTER_API_KEY
          ? ready(id)
          : missing(id, t.missingKey('OPENROUTER_API_KEY (or OPEN_ROUTER_API_KEY)'));
      case 'ollama':
        // Pas de clé, mais un serveur local doit tourner : on ne peut pas le
        // savoir sans requête réseau, donc on l'annonce comme utilisable et
        // c'est l'erreur d'appel qui informera précisément.
        return ready(id);
      case 'claude-subscription': {
        // Deux causes d'indisponibilité, distinctes et toutes deux actionnables.
        if (!claudeCodeInstalled(env as { PATH?: string })) {
          return missing(id, t.missingClaudeCode);
        }
        // Une clé API l'emporterait silencieusement sur l'abonnement : on
        // refuse de présenter comme « abonnement » ce qui serait facturé à
        // l'appel. Le fournisseur reste utilisable, mais on dit pourquoi il
        // ne ferait pas ce qu'il annonce.
        if (env.ANTHROPIC_API_KEY) return missing(id, t.apiKeyShadowsSubscription);
        return ready(id);
      }
      case 'custom':
        return env.VULNPIPE_LLM_BASE_URL ? ready(id) : missing(id, t.missingBaseUrl);
    }
  });
}
