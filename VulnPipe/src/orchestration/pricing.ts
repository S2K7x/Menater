/**
 * Grille tarifaire — pour ESTIMER un coût AVANT de lancer un scan.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EST PRESQUE VIDE, ET POURQUOI C'EST VOULU
 *
 * `usage-tracker.ts` pose la règle : on ne convertit jamais des tokens en
 * euros à partir d'un tarif codé en dur, parce qu'une grille périmée fait
 * afficher un chiffre inventé avec l'autorité d'une facture.
 *
 * L'estimation avant scan a pourtant besoin d'un prix. On ne contourne pas la
 * règle, on la respecte :
 *
 *   - Les seuls tarifs écrits en dur ici sont ceux qui valent ZÉRO par
 *     construction et non par grille commerciale : un modèle qui tourne sur ta
 *     machine (ollama, serveur custom) ne facture rien, et `openrouter/free`
 *     ne route que vers des modèles à tarif nul. Ces deux-là ne peuvent pas
 *     devenir faux avec le temps.
 *   - Tout le reste vient de TOI, via `.env`. Tant que tu n'as rien renseigné,
 *     l'estimation annonce le volume (tokens, appels, durée) et dit
 *     explicitement que le prix n'est pas connu — plutôt que d'inventer.
 *
 * Renseigner un prix (en dollars par million de tokens) :
 *
 *     VULNPIPE_PRICE_GEMINI="0.30/2.50"          # entrée/sortie
 *     VULNPIPE_PRICE_ANTHROPIC="3/15"
 *     VULNPIPE_PRICE_OPENAI="1.25/10"
 *     VULNPIPE_PRICE_OPENROUTER="0/0"
 *
 * Le tarif exact de ton modèle est sur la page de facturation de ton
 * fournisseur ; il change trop souvent pour vivre dans ce dépôt.
 * ============================================================================
 */

export interface ModelPrice {
  /** Dollars par million de tokens d'entrée. */
  input_per_mtok: number;
  /** Dollars par million de tokens de sortie (raisonnement compris). */
  output_per_mtok: number;
  /** D'où vient ce chiffre — affiché tel quel à l'utilisateur. */
  source: 'gratuit_par_construction' | 'renseigné_par_toi';
}

/** Tarifs qui ne peuvent pas devenir faux. */
const STRUCTURALLY_FREE: Record<string, ModelPrice> = {
  ollama: { input_per_mtok: 0, output_per_mtok: 0, source: 'gratuit_par_construction' },
  custom: { input_per_mtok: 0, output_per_mtok: 0, source: 'gratuit_par_construction' },
};

const ENV_PREFIX = 'VULNPIPE_PRICE_';

/**
 * Prix applicable à un couple (fournisseur, modèle), ou `null` si inconnu.
 *
 * `null` n'est pas un échec : c'est l'information « je ne sais pas », qui doit
 * remonter jusqu'à l'interface au lieu d'être remplacée par un zéro.
 */
export function priceFor(
  provider: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): ModelPrice | null {
  const declared = env[`${ENV_PREFIX}${provider.toUpperCase()}`];
  if (declared) {
    const parsed = parsePrice(declared);
    if (parsed) return parsed;
  }

  if (STRUCTURALLY_FREE[provider]) return STRUCTURALLY_FREE[provider]!;

  // `openrouter/free` ne route que vers des modèles à tarif nul : c'est une
  // garantie du routeur, pas une grille de prix.
  if (provider === 'openrouter' && (model ?? '').includes('free')) {
    return { input_per_mtok: 0, output_per_mtok: 0, source: 'gratuit_par_construction' };
  }

  return null;
}

/** Analyse `"0.30/2.50"` ou `"0.30"` (même prix entrée/sortie). */
export function parsePrice(value: string): ModelPrice | null {
  const parts = value.split('/').map((part) => Number(part.trim()));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return {
    input_per_mtok: parts[0]!,
    output_per_mtok: parts[1] ?? parts[0]!,
    source: 'renseigné_par_toi',
  };
}

/**
 * Latence de référence d'un appel, en millisecondes.
 *
 * Sert uniquement à estimer une DURÉE, jamais un prix. Les valeurs de départ
 * sont des ordres de grandeur ; `observeLatency` les remplace par du mesuré
 * dès le premier scan, si bien qu'une estimation devient de plus en plus
 * juste sur ta machine et avec ton modèle.
 */
const BASELINE_LATENCY_MS: Record<string, number> = {
  gemini: 4_000,
  anthropic: 9_000,
  openai: 6_000,
  openrouter: 8_000,
  // Un modèle local sur CPU/GPU grand public est nettement plus lent.
  ollama: 25_000,
  custom: 15_000,
};

const observed = new Map<string, { totalMs: number; calls: number }>();

/** Enregistre une latence réellement mesurée, pour affiner les estimations. */
export function observeLatency(provider: string, latencyMs: number): void {
  const entry = observed.get(provider) ?? { totalMs: 0, calls: 0 };
  entry.totalMs += latencyMs;
  entry.calls += 1;
  observed.set(provider, entry);
}

export interface LatencyEstimate {
  ms: number;
  /** true si la valeur vient de scans réels et non d'un ordre de grandeur. */
  measured: boolean;
  samples: number;
}

export function latencyFor(provider: string): LatencyEstimate {
  const entry = observed.get(provider);
  if (entry && entry.calls >= 3) {
    return { ms: Math.round(entry.totalMs / entry.calls), measured: true, samples: entry.calls };
  }
  return { ms: BASELINE_LATENCY_MS[provider] ?? 8_000, measured: false, samples: entry?.calls ?? 0 };
}

/** Remet les mesures à zéro (tests). */
export function resetObservedLatency(): void {
  observed.clear();
}
