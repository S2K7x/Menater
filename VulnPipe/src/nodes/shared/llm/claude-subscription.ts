/**
 * Fournisseur « abonnement Claude » — passe par Claude Code, pas par l'API payante.
 *
 * ============================================================================
 * CE QUE ÇA PERMET, ET POURQUOI C'EST LÉGITIME
 *
 * Quelqu'un qui paie déjà un abonnement Claude Pro ou Max n'a aucune envie de
 * repayer des jetons d'API pour faire tourner VulnPipe. Anthropic prévoit ce
 * cas : le **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) s'authentifie
 * via la session Claude Code de la personne, et sa documentation officielle dit
 * noir sur blanc que « l'usage du Claude Agent SDK, de `claude -p` et des
 * applications tierces tire sur les limites d'usage de l'abonnement ».
 *
 * C'est donc l'inverse d'un contournement : on utilise le client officiel
 * d'Anthropic, sur la session que la personne a ouverte elle-même.
 *
 * LA LIMITE À NE PAS FRANCHIR
 *
 * Ce chemin vaut pour un usage **local et mono-utilisateur** — exactement le
 * cadre posé par `CLAUDE.md` §6. Faire tourner un service hébergé qui
 * consommerait l'abonnement d'un tiers, ou collecter des jetons OAuth
 * d'utilisateurs, sort des conditions d'utilisation d'Anthropic. VulnPipe ne
 * demande donc AUCUN jeton : il se contente de constater que Claude Code est
 * installé et connecté sur cette machine.
 *
 * CE QUE ÇA COÛTE VRAIMENT (mesuré, pas supposé)
 *
 * Sondage du 2026-08-19 sur `@anthropic-ai/claude-agent-sdk` 0.3.235 :
 * un appel trivial (8 jetons de sortie) transporte tout de même ~26 000 jetons
 * de contexte — le harnais de Claude Code lui-même — même avec `allowedTools: []`.
 * Ce n'est pas gratuit : c'est prélevé sur les limites de l'abonnement.
 * D'où le branchement recommandé sur l'ARBITRE seulement (un appel par scan,
 * `CLAUDE.md` §2), et non sur les nodes de détection (un appel par route).
 *
 * LE PIÈGE QUE CE FICHIER DOIT ABSOLUMENT ÉVITER
 *
 * L'ordre de résolution des identifiants met `ANTHROPIC_API_KEY` AVANT la
 * session Claude Code. Quelqu'un qui a exporté une clé pour un autre projet
 * croirait consommer son abonnement alors qu'il paie à l'appel — silencieusement.
 * Le champ `apiKeySource` du message `system/init` dit qui a gagné : on le lit,
 * et on le REMONTE. Une facturation surprise ne doit jamais ressembler à un
 * succès.
 * ============================================================================
 */

import {
  LlmError,
  withRetry,
  type EffortLevel,
  type RetryOptions,
  type JsonSchema,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from './types.ts';

/** Valeur d'`apiKeySource` quand aucune clé API n'est en jeu — donc abonnement. */
export const SUBSCRIPTION_KEY_SOURCE = 'none';

/**
 * Forme minimale du SDK dont on dépend.
 *
 * Déclarée ici plutôt qu'importée : `@anthropic-ai/claude-agent-sdk` est une
 * dépendance OPTIONNELLE (même traitement que `bullmq`), résolue à l'exécution.
 * Le dépôt doit rester installable et testable sans elle.
 */
export interface AgentSdkMessage {
  type: string;
  subtype?: string;
  apiKeySource?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
}

export type AgentSdkQuery = (args: {
  prompt: string;
  options: {
    systemPrompt: string;
    allowedTools: string[];
    maxTurns: number;
    model?: string;
    /** Vérifié dans les types du SDK 0.3.235 : `effort?: EffortLevel` sur les options. */
    effort?: EffortLevel;
  };
}) => AsyncIterable<AgentSdkMessage>;

export interface ClaudeSubscriptionOptions {
  model?: string;
  /** Profondeur de raisonnement. Absent = défaut de la session Claude Code. */
  effort?: EffortLevel;
  /** Injectable pour les tests : aucun appel réseau dans la suite hors ligne. */
  query?: AgentSdkQuery;
  /** Reçoit l'avertissement quand la facturation n'est pas celle attendue. */
  onWarning?: (message: string) => void;
  /**
   * Réglage de la reprise sur erreur transitoire.
   *
   * Exposé pour les TESTS : sans lui, vérifier qu'une panne est bien signalée
   * demanderait d'attendre les vraies temporisations. La valeur de production
   * est le défaut de `withRetry` — il n'y a rien à régler pour l'utilisateur.
   */
  retry?: RetryOptions;
}

/** Le SDK choisit le modèle de la session Claude Code quand on ne force rien. */
export const DEFAULT_SUBSCRIPTION_MODEL = 'default';

/** Charge le SDK à l'exécution, avec un message utile s'il n'est pas installé. */
async function loadQuery(): Promise<AgentSdkQuery> {
  try {
    // Le specifier est construit à l'exécution : un littéral ferait résoudre le
    // module par TypeScript à la compilation, ce qui rétablirait la dépendance
    // obligatoire qu'on cherche justement à éviter (même traitement que
    // `bullmq` dans `orchestration/queue.ts`).
    const moduleName = ['@anthropic-ai', 'claude-agent-sdk'].join('/');
    const mod = (await import(moduleName)) as unknown as { query: AgentSdkQuery };
    return mod.query;
  } catch {
    throw new LlmError(
      'claude-subscription',
      'unavailable',
      "Le paquet @anthropic-ai/claude-agent-sdk n'est pas installé. " +
        'Installe-le (npm i @anthropic-ai/claude-agent-sdk) et connecte Claude Code (commande `claude`).',
      false
    );
  }
}

/**
 * Extrait un objet JSON d'une réponse en texte libre.
 *
 * Le SDK rend du texte, pas du JSON structuré : il n'expose pas l'équivalent
 * d'`output_config.format`. On demande donc du JSON strict dans la consigne, et
 * on tolère ici les deux écarts observés en pratique — un bloc ``` autour, et
 * une phrase avant ou après. Au-delà, on échoue franchement plutôt que de
 * deviner.
 */
export function extractJson(raw: string): unknown {
  const withoutFence = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const candidates = [withoutFence.trim()];

  const first = withoutFence.indexOf('{');
  const last = withoutFence.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(withoutFence.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // On essaie le candidat suivant.
    }
  }
  throw new LlmError(
    'claude-subscription',
    'bad_output',
    `Réponse non parsable en JSON : ${raw.slice(0, 200)}`,
    false
  );
}

/** Consigne de format. Le SDK n'ayant pas de sortie structurée, elle porte tout. */
export function schemaInstruction(schema: JsonSchema): string {
  return [
    'Réponds UNIQUEMENT par un objet JSON valide, sans texte autour et sans bloc de code.',
    `Le JSON doit avoir exactement ces clés : ${Object.keys(schema.properties).join(', ')}.`,
    `Clés obligatoires : ${schema.required.join(', ')}.`,
  ].join('\n');
}

export class ClaudeSubscriptionClient implements LlmClient {
  // Champs déclarés puis assignés : les « parameter properties » TS ne passent
  // pas le strip-only mode de Node (limitation notée en Phase 2, ROADMAP.md).
  readonly provider = 'claude-subscription';
  readonly model: string;
  private readonly effort?: EffortLevel;
  private readonly injectedQuery?: AgentSdkQuery;
  private readonly onWarning?: (message: string) => void;
  private readonly retry?: RetryOptions;

  constructor(options: ClaudeSubscriptionOptions = {}) {
    this.model = options.model ?? DEFAULT_SUBSCRIPTION_MODEL;
    this.effort = options.effort;
    this.injectedQuery = options.query;
    this.onWarning = options.onWarning;
    this.retry = options.retry;
  }

  async complete<T = unknown>(request: LlmRequest): Promise<LlmResponse<T>> {
    // Même règle que les autres fournisseurs : une erreur transitoire ne doit
    // pas coûter la route. Les erreurs de session (`auth`) ne sont jamais
    // réessayées — `withRetry` s'en charge sur la foi de `retryable`.
    return withRetry(() => this.completeOnce<T>(request), this.retry);
  }

  private async completeOnce<T = unknown>(request: LlmRequest): Promise<LlmResponse<T>> {
    const query = this.injectedQuery ?? (await loadQuery());
    const started = Date.now();

    let init: AgentSdkMessage | undefined;
    let result: AgentSdkMessage | undefined;

    try {
      const stream = query({
        prompt: `${request.user}\n\n${schemaInstruction(request.schema)}`,
        options: {
          systemPrompt: request.system,
          // Aucun outil : on veut un verdict, pas un agent qui lit le disque.
          allowedTools: [],
          maxTurns: 1,
          ...(this.model === DEFAULT_SUBSCRIPTION_MODEL ? {} : { model: this.model }),
          ...(this.effort ? { effort: this.effort } : {}),
        },
      });

      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') init = message;
        if (message.type === 'result') result = message;
      }
    } catch (error) {
      throw new LlmError(
        this.provider,
        'unavailable',
        `Claude Code injoignable : ${(error as Error).message}`,
        true
      );
    }

    // --- La facturation est-elle bien celle qu'on croit ? -------------------
    //
    // `apiKeySource` différent de "none" veut dire qu'une clé API a pris la
    // main sur la session Claude Code : la personne paie à l'appel en croyant
    // consommer son abonnement. On le DIT.
    if (init && init.apiKeySource !== undefined && init.apiKeySource !== SUBSCRIPTION_KEY_SOURCE) {
      this.onWarning?.(
        `Attention : cet appel n'a PAS été facturé sur ton abonnement mais via « ${init.apiKeySource} ». ` +
          'Une clé API prend le pas sur ta session Claude Code. Retire-la de ton environnement ' +
          "(par exemple ANTHROPIC_API_KEY) si tu veux consommer ton abonnement."
      );
    }

    if (!result) {
      throw new LlmError(
        this.provider,
        'unavailable',
        "Claude Code n'a rendu aucun résultat pour cette requête.",
        true
      );
    }

    if (result.is_error === true) {
      // Une limite d'abonnement atteinte est transitoire : elle se recharge.
      const text = result.result ?? '';
      const rateLimited = /limit|quota|rate/i.test(text);
      throw new LlmError(
        this.provider,
        rateLimited ? 'rate_limit' : 'unknown',
        `Claude Code a échoué : ${text.slice(0, 300)}`,
        rateLimited
      );
    }

    const raw = result.result ?? '';
    const parsed = extractJson(raw) as T;

    return {
      parsed,
      raw,
      provider: this.provider,
      model: init?.model ?? this.model,
      usage: {
        input_tokens:
          (result.usage?.input_tokens ?? 0) +
          (result.usage?.cache_creation_input_tokens ?? 0) +
          (result.usage?.cache_read_input_tokens ?? 0),
        output_tokens: result.usage?.output_tokens ?? 0,
        thinking_tokens: result.usage?.output_tokens_details?.thinking_tokens,
        // `total_cost_usd` du SDK est l'ÉQUIVALENT au tarif API, pas une somme
        // débitée : sur un abonnement, rien n'est facturé à l'appel. Le
        // remonter comme un coût réel afficherait une dépense qui n'a pas eu
        // lieu — on renvoie donc 0 et on expose l'équivalent à part.
        cost_usd: 0,
        upstream_provider: `abonnement Claude (équivalent API : ${(result.total_cost_usd ?? 0).toFixed(4)} $)`,
        resolved_model: init?.model,
      },
      latency_ms: Date.now() - started,
    };
  }
}
