/**
 * Contrat commun à tous les fournisseurs de LLM.
 *
 * `CLAUDE.md` §1 pose le low-cost comme promesse non négociable, mais ne dit
 * pas QUEL moteur : un utilisateur peut vouloir du 100 % local (Ollama), un
 * autre payer une API rapide. Les nodes de détection ne doivent donc jamais
 * connaître le fournisseur — ils reçoivent un `LlmClient` et rien d'autre.
 *
 * PHASE_3 impose `src/nodes/shared/` pour tout ce qui est générique : c'est ici.
 */

/**
 * Sous-ensemble de JSON Schema commun à tous les fournisseurs.
 *
 * Volontairement minimal : chaque fournisseur a son dialecte (Gemini utilise
 * un sous-ensemble OpenAPI, Ollama passe le schéma à une grammaire GBNF,
 * OpenAI exige `additionalProperties: false`). On ne garde que ce qui est
 * supporté partout, et chaque adaptateur traduit.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Profondeur de raisonnement demandée au modèle.
 *
 * C'est le levier coût/qualité le plus direct sur les modèles Claude : plus
 * l'effort est élevé, plus le modèle réfléchit avant de répondre — donc plus il
 * consomme de jetons de raisonnement, qui sont facturés comme des jetons de
 * sortie même si l'utilisateur ne les voit jamais.
 *
 * On l'expose comme un RÉGLAGE (porté par le client), pas comme un paramètre de
 * requête : c'est un arbitrage que la personne pose une fois pour toutes, pas
 * une décision que chaque node devrait prendre.
 *
 * Ignoré sans erreur par les fournisseurs qui ne le connaissent pas.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface LlmRequest {
  system: string;
  user: string;
  /** Schéma de sortie. Sans lui, les modèles répondent en prose — vérifié. */
  schema: JsonSchema;
  /** 0 = déterministe. Ignoré par les fournisseurs qui le refusent (voir anthropic.ts). */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * Part de `input_tokens` relue depuis le cache du fournisseur, quand il
   * l'expose. Facturée ~10 % du tarif d'entrée.
   *
   * Comptée à part et jamais soustraite de `input_tokens` : le fournisseur les
   * annonce comme des jetons d'entrée, et un total qui ne correspondrait pas à
   * la facture serait pire qu'un total incomplet.
   */
  cached_input_tokens?: number;
  /**
   * Tokens de raisonnement interne, quand le fournisseur les expose.
   *
   * À surveiller de près : sur gemini-3.5-flash, un verdict de 104 tokens de
   * sortie en a consommé 634 de raisonnement — 6× le coût visible. C'est le
   * poste de dépense qui décide si la promesse low-cost tient.
   */
  thinking_tokens?: number;
  /**
   * Coût réel en dollars, quand le fournisseur le renvoie.
   * OpenRouter l'expose dans `usage.cost` — c'est la seule source fiable :
   * un calcul maison à partir d'une grille tarifaire est faux dès qu'un prix
   * change ou qu'un routeur bascule vers un autre modèle en cours de route.
   */
  cost_usd?: number;
  /**
   * Fournisseur réellement sollicité derrière un routeur.
   * `openrouter/free` peut servir la requête depuis n'importe quel modèle
   * gratuit : sans ce champ, un rapport ne sait pas qui l'a produit.
   */
  upstream_provider?: string;
  /** Modèle réellement utilisé, s'il diffère de celui demandé (routeurs). */
  resolved_model?: string;
}

export interface LlmResponse<T = unknown> {
  /** JSON déjà parsé et conforme au schéma demandé. */
  parsed: T;
  /** Texte brut renvoyé — conservé pour diagnostic quand le parse échoue. */
  raw: string;
  provider: string;
  model: string;
  usage: LlmUsage;
  latency_ms: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete<T = unknown>(request: LlmRequest): Promise<LlmResponse<T>>;
}

/** Erreur normalisée : les nodes ne doivent pas connaître les codes de chaque API. */
export class LlmError extends Error {
  readonly provider: string;
  readonly kind: LlmErrorKind;
  /** true si un nouvel essai a une chance d'aboutir. */
  readonly retryable: boolean;

  constructor(provider: string, kind: LlmErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = 'LlmError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = retryable;
  }
}

export type LlmErrorKind =
  | 'auth' // clé absente ou invalide
  | 'rate_limit' // quota dépassé
  | 'unavailable' // serveur injoignable ou tombé (fréquent en local)
  | 'bad_output' // réponse non conforme au schéma
  | 'unknown';

/** Statuses whose whole meaning is "ask somewhere else". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The destination by HOST alone — never its path and never its query.
 *
 * A configured base URL can carry a token in either half, and this sentence is
 * printed in a scan report. `null` when the header is not a URL at all.
 */
function redirectHost(location: string, from: string): string | null {
  try {
    return new URL(location, from).host || null;
  } catch {
    return null;
  }
}

/**
 * `fetch`, and a reply is never allowed to choose where the next request goes.
 *
 * Every call this module makes is a POST carrying two things worth stealing:
 * the api key, in a header, and the analysed SOURCE CODE, in the body. Node
 * follows a redirect by default and the specification strips exactly one
 * header across an origin — measured on 22.22.2, two servers, one hop:
 * `authorization` ABSENT at the second host, `x-goog-api-key` DELIVERED, and
 * on a 307 or 308 the whole body replayed there. So `Authorization` was safe
 * by an accident of the specification and nothing else was.
 *
 * The rule is therefore the narrowest one that covers every caller here: a
 * redirect is never followed on a WRITE, and every call in this directory is
 * one. The console's `fetchWithDeadline` also allows a same-host hop, because
 * it has GET callers and a trailing-slash 301 is the commonest redirect there
 * is; this half has none, so that branch would be a guard written for a state
 * it can never see.
 *
 * A 3xx carrying no `Location` redirected nothing, and is handed back as the
 * answer it is rather than dressed up as a redirect that did not happen.
 */
export async function fetchNoRedirect(
  provider: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  // `manual` hands back the 3xx itself instead of undici deciding the next
  // address for us.
  const response = await fetch(url, { ...init, redirect: 'manual' });

  if (!REDIRECT_STATUSES.has(response.status)) return response;
  const location = response.headers.get('location');
  if (!location) return response;

  // Node keeps the socket checked out of the pool until the body is read or
  // cancelled, and nobody is going to read this one.
  await response.body?.cancel().catch(() => undefined);

  const host = redirectHost(location, url);
  throw new LlmError(
    provider,
    'unknown',
    `${provider}: the address answered HTTP ${response.status} and redirected this call `
      + `${host ? `to ${host}` : 'to an address that is not a valid URL'}. VulnPipe does not `
      + 'follow that: this request carries the analysed source code and the api key, so the '
      + 'destination would be chosen by whoever answered. Point the provider base URL at the '
      + 'final address.',
    // Asking the same endpoint again returns the same 3xx. A retry here spends
    // a paid call to learn what is already known.
    false
  );
}

/**
 * Réessaie un appel sur erreur transitoire (quota, serveur indisponible).
 *
 * Motivé par une observation : sur le palier gratuit Gemini (20 requêtes/min),
 * un scan de 7 routes fait échouer les dernières en `RESOURCE_EXHAUSTED`. Sans
 * reprise, la pipeline rend un rapport incomplet alors qu'il suffisait
 * d'attendre onze secondes — l'API donne d'ailleurs le délai à respecter.
 *
 * Les erreurs non transitoires (`auth`, `bad_output`) ne sont jamais réessayées :
 * insister sur une clé invalide ne fait que perdre du temps.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI DU JITTER, ET POURQUOI IL N'ÉTAIT PAS NÉCESSAIRE AVANT
 *
 * Tant que la détection analysait ses routes une par une, un seul appel
 * pouvait être en attente : le moment de la reprise n'avait aucune importance.
 * Depuis que les routes partent par lots (`orchestration/pool.ts`), quatre
 * appels franchissent le plafond de quota au même instant, reçoivent le même
 * délai suggéré, et repartiraient TOUS ENSEMBLE — pour se faire refuser en
 * bloc une deuxième fois. C'est le troupeau qui se reforme.
 *
 * `full jitter` : on tire au hasard dans [0, délai]. Le délai suggéré par
 * l'API reste un PLANCHER — il dit « pas avant », l'ignorer serait garantir un
 * second refus — et le hasard ne joue que sur ce qu'on ajoute au-dessus.
 * ---------------------------------------------------------------------------
 */
export interface RetryOptions {
  attempts?: number;
  onWait?: (ms: number, attempt: number) => void;
  /** Injectable pour rendre les tests déterministes. */
  random?: () => number;
  /**
   * L'attente elle-même, injectable.
   *
   * Un test qui vérifie le CALCUL du délai n'a aucune raison de le SUBIR :
   * il dormait plusieurs secondes pour vérifier une multiplication, ce qui le
   * rendait le premier à rougir dès que la machine était chargée — un test
   * intermittent qu'on finit par ignorer, donc un test qui ne sert plus.
   */
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error instanceof LlmError && error.retryable && error.kind !== 'bad_output';
      if (!isRetryable || attempt === attempts) break;

      // L'API indique souvent le délai à respecter : on le suit plutôt que
      // de deviner. Sinon, doublement classique.
      const hinted = /retry in ([\d.]+)\s*s/i.exec((error as Error).message)?.[1];
      const floorMs = hinted ? Math.ceil(Number(hinted) * 1000) + 500 : 0;
      const backoffMs = 2000 * 2 ** (attempt - 1);
      // Le plancher imposé par l'API est respecté ; le jitter s'ajoute par
      // dessus, il ne raccourcit jamais l'attente demandée.
      const waitMs = floorMs + Math.round(random() * (floorMs > 0 ? 1000 : backoffMs));
      options.onWait?.(waitMs, attempt);
      await (options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(waitMs);
    }
  }

  throw lastError;
}

/**
 * Parse la sortie d'un modèle en tolérant les écarts les plus courants.
 *
 * Même sous contrainte de schéma, certains modèles encadrent le JSON de
 * balises markdown. On nettoie plutôt que d'échouer, mais on ne devine jamais
 * le contenu : si rien ne parse, on lève une LlmError `bad_output` avec le
 * texte brut pour que le diagnostic reste possible.
 */
export function parseJsonOutput<T>(provider: string, raw: string): T {
  const attempts = [
    raw,
    raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''),
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // essai suivant
    }
  }

  throw new LlmError(
    provider,
    'bad_output',
    `Réponse non parsable en JSON. Texte brut : ${raw.slice(0, 300)}`,
    true
  );
}

/**
 * Longueur minimale, en caractères, à partir de laquelle marquer un préfixe
 * pour le cache du fournisseur.
 *
 * Les API refusent de mettre en cache un préfixe trop court (de l'ordre du
 * millier de tokens) ; ~4 caractères par token est l'approximation déjà
 * retenue par `orchestration/estimator.ts`. En dessous du seuil, marquer
 * reviendrait à payer la prime d'écriture pour un bloc qui ne sera jamais relu.
 *
 * Vit ICI et non dans `anthropic.ts` parce que deux adaptateurs s'en servent,
 * et que le second ne doit pas charger le SDK Anthropic pour lire une constante.
 */
export const CACHE_MIN_SYSTEM_CHARS = 4_000;

/**
 * Rend un prompt système sous forme de bloc marqué pour le cache, ou tel quel
 * s'il est trop court pour que ce soit utile.
 *
 * Le texte envoyé est identique dans les deux cas : le marquage ne change ni
 * ce que le modèle voit, ni le verdict rendu. C'est une facture, pas un
 * comportement — d'où l'absence de réglage pour l'éteindre.
 */
export function cacheableSystem(system: string): string | Array<Record<string, unknown>> {
  if (system.length < CACHE_MIN_SYSTEM_CHARS) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}
