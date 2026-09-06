/**
 * Estimation AVANT scan : combien de calcul, combien de temps, combien ça coûte.
 *
 * ============================================================================
 * POURQUOI CE MODULE EXISTE
 *
 * `CLAUDE.md` §1 promet « abordable financièrement ». Une promesse de prix
 * qu'on ne peut vérifier qu'APRÈS avoir payé n'en est pas une. Jusqu'ici,
 * lancer un scan était un chèque en blanc : aucun moyen de savoir si on
 * s'engageait pour trois secondes gratuites ou vingt minutes facturées.
 *
 * COMMENT L'ESTIMATION EST OBTENUE — et pourquoi elle n'est pas une devinette
 *
 * On ne multiplie pas « nombre de fichiers × une constante inventée ». On
 * rejoue la pipeline réelle jusqu'au point EXACT où elle deviendrait payante,
 * et pas un pas plus loin :
 *
 *   1. indexation                 -> identique au vrai scan (gratuit)
 *   2. résolution du contexte     -> identique au vrai scan (gratuit)
 *   3. scanner déterministe       -> identique au vrai scan (gratuit)
 *   4. construction du prompt     -> identique au vrai scan (gratuit)
 *   5. APPEL AU MODÈLE            -> NON EXÉCUTÉ. On mesure sa taille, c'est tout.
 *
 * Deux conséquences importantes :
 *   - Le nombre d'appels facturés est CONNU, pas supposé : le scanner
 *     déterministe tranche seul une partie des routes, et on sait lesquelles
 *     avant de payer quoi que ce soit.
 *   - Le volume de tokens est mesuré sur le prompt réellement construit.
 *
 * Ce qui reste incertain est déclaré comme tel dans `assumptions` :
 *   - la part de findings envoyée à l'arbitre dépend des verdicts, donc du
 *     modèle : on l'encadre par une fourchette (CLAUDE.md §2 : 10-15 %) ;
 *   - la longueur des réponses du modèle ;
 *   - le prix, tant qu'il n'est pas renseigné (voir `pricing.ts`).
 * ============================================================================
 */

import { buildRepoIndex, type RepoIndex } from '../mcp-server/repo-index.ts';
import { createServer } from '../mcp-server/server.ts';
import { connectInProcess, type ContextProvider, type ListedRoute } from '../nodes/shared/mcp-client.ts';
import { buildIdorPrompt, IDOR_SYSTEM_PROMPT } from '../nodes/idor/prompt.ts';
import { scanForIdor } from '../nodes/idor/scanner.ts';
import { DEFAULT_INITIAL_DEPTH } from '../nodes/idor/node.ts';
import { latencyFor, priceFor, type ModelPrice } from './pricing.ts';
import { DEFAULT_DETECTION_CONCURRENCY } from './pool.ts';
import type { ResolvedTarget } from './scan-target.ts';
import type { ScanMode } from './pipeline.ts';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';

/**
 * Nombre de routes réellement sondées pour mesurer la taille des prompts.
 *
 * Sonder les 400 routes d'un gros dépôt pour ESTIMER prendrait presque aussi
 * longtemps que le scan lui-même : l'estimation doit rester quasi instantanée,
 * sinon personne ne l'attend et elle ne sert à rien. Au-delà de cette limite,
 * on extrapole depuis la moyenne mesurée, et on le dit.
 */
export const SAMPLE_LIMIT = 12;

/**
 * ~4 caractères par token.
 *
 * Approximation universellement utilisée pour du texte latin et du code. Elle
 * suffit ici : on cherche un ordre de grandeur pour décider de lancer ou non,
 * pas une facture. Le vrai décompte vient du fournisseur, après coup, dans
 * `usage-tracker.ts`.
 */
export const CHARS_PER_TOKEN = 4;

/** Part des signalements envoyée à l'arbitre (CLAUDE.md §2 : « 10-15 % »). */
const ARBITRATION_SHARE = { low: 0.1, high: 0.15 };

/** Tokens de sortie typiques d'un verdict de node, raisonnement compris. */
const OUTPUT_TOKENS_PER_DETECTION = 700;
const OUTPUT_TOKENS_PER_ARBITRATION = 900;

export interface EstimateRange {
  low: number;
  high: number;
}

export interface CostEstimate {
  /** `null` quand le prix du modèle n'est pas connu — jamais remplacé par 0. */
  usd: EstimateRange | null;
  /** true si le scan est gratuit par construction (modèle local, palier free). */
  free: boolean;
  /** Ce qui empêche de chiffrer, s'il y a lieu. */
  unknown_reason: string | null;
  detection_price: ModelPrice | null;
  arbitration_price: ModelPrice | null;
}

export interface ScanEstimate {
  target: {
    kind: ResolvedTarget['kind'];
    label: string;
    files_indexed: number;
    routes_found: number;
  };
  mode: ScanMode;
  /** Routes retenues par le mode et le périmètre choisis. */
  routes_selected: number;
  /** Routes tranchées sans modèle : gratuites et instantanées. */
  routes_free: number;
  /** Routes nécessitant un appel au modèle : c'est là que part le budget. */
  routes_billed: number;
  llm_calls: { detection: number; arbitration: EstimateRange; total: EstimateRange };
  tokens: { input: number; output: EstimateRange; total: EstimateRange };
  duration_s: EstimateRange;
  cost: CostEstimate;
  /** true si les prompts ont été extrapolés depuis un échantillon. */
  sampled: boolean;
  sample_size: number;
  assumptions: string[];
  warnings: string[];
  plain_language_summary: string;
}

export interface EstimateInput {
  target: ResolvedTarget;
  mode: ScanMode;
  routes: ListedRoute[];
  index: RepoIndex;
  provider: ContextProvider;
  detection: { provider: string; model?: string };
  arbitration: { provider: string; model?: string };
  env?: NodeJS.ProcessEnv;
  /** Langue du devis. */
  locale?: Locale;
  /**
   * Nombre d'adresses examinées en même temps pendant le scan.
   *
   * SANS CE CHAMP LE DEVIS MENTIRAIT DE TOUT LE FACTEUR. La durée était la
   * somme des latences, ce qui n'était juste que tant que les routes partaient
   * une par une. Depuis qu'elles partent par lots (`pool.ts`), un devis
   * annonçant quatre-vingts secondes pour un scan qui en prend vingt n'est pas
   * prudent : il est faux, et il pousse à renoncer à un scan abordable.
   */
  detectionConcurrency?: number;
}

/**
 * Mesure les prompts d'un échantillon de routes.
 *
 * Renvoie aussi la proportion de routes que le scanner tranche seul : c'est
 * la donnée qui fait la différence entre « 40 appels payants » et « 12 ».
 */
async function probeRoutes(
  routes: ListedRoute[],
  provider: ContextProvider
): Promise<{ promptChars: number[]; decidedByScanner: number; probed: number; failures: number }> {
  const sample = routes.slice(0, SAMPLE_LIMIT);
  const promptChars: number[] = [];
  let decidedByScanner = 0;
  let failures = 0;

  for (const route of sample) {
    try {
      const bundle = await provider.getContext(
        { route: route.route, httpMethod: route.http_method },
        DEFAULT_INITIAL_DEPTH
      );
      const scanner = scanForIdor(bundle);
      if (scanner.decisive_score !== null) {
        decidedByScanner += 1;
        continue;
      }
      promptChars.push(IDOR_SYSTEM_PROMPT.length + buildIdorPrompt(bundle).length);
    } catch {
      // Une route dont le contexte est illisible sera de toute façon un échec
      // au scan : on la compte comme telle plutôt que de fausser la moyenne.
      failures += 1;
    }
  }

  return { promptChars, decidedByScanner, probed: sample.length, failures };
}

/** Construit l'estimation complète. */
export async function estimateScan(input: EstimateInput): Promise<ScanEstimate> {
  const env = input.env ?? process.env;
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = messages(locale).estimate;
  const routes = input.routes;
  const warnings: string[] = [...input.target.warnings, ...input.index.warnings.slice(0, 3)];
  const assumptions: string[] = [];

  const probe = await probeRoutes(routes, input.provider);
  const sampled = routes.length > probe.probed;

  const freeShare = probe.probed > 0 ? probe.decidedByScanner / probe.probed : 0;
  const routesFree = Math.round(routes.length * freeShare);
  const routesBilled = Math.max(routes.length - routesFree, 0);

  const meanPromptChars =
    probe.promptChars.length > 0
      ? probe.promptChars.reduce((sum, n) => sum + n, 0) / probe.promptChars.length
      : 0;
  const inputTokensPerCall = Math.round(meanPromptChars / CHARS_PER_TOKEN);

  // --- Appels ---------------------------------------------------------------
  const detectionCalls = routesBilled;
  const arbitration: EstimateRange = {
    low: Math.round(detectionCalls * ARBITRATION_SHARE.low),
    high: Math.max(Math.round(detectionCalls * ARBITRATION_SHARE.high), detectionCalls > 0 ? 1 : 0),
  };

  // L'arbitre reçoit le contexte de la route ET le verdict du node : on compte
  // le prompt mesuré plus une marge pour le verdict transmis.
  const arbitrationInputTokens = Math.round(inputTokensPerCall * 1.3);

  const inputTokens =
    detectionCalls * inputTokensPerCall + arbitration.high * arbitrationInputTokens;
  const outputTokens: EstimateRange = {
    low: detectionCalls * OUTPUT_TOKENS_PER_DETECTION + arbitration.low * OUTPUT_TOKENS_PER_ARBITRATION,
    high:
      detectionCalls * OUTPUT_TOKENS_PER_DETECTION + arbitration.high * OUTPUT_TOKENS_PER_ARBITRATION,
  };

  // --- Durée ----------------------------------------------------------------
  const detectionLatency = latencyFor(input.detection.provider);
  const arbitrationLatency = latencyFor(input.arbitration.provider);
  // Les détections se recouvrent, l'arbitrage NON : c'est un appel unique pour
  // tout le lot (`master/claude-client.ts`). Diviser sa durée aussi ferait
  // disparaître du temps qui sera bel et bien attendu.
  const concurrency = Math.max(1, input.detectionConcurrency ?? DEFAULT_DETECTION_CONCURRENCY);
  // L'indexation et la résolution ne sont pas gratuites en temps : mesurées
  // à quelques millisecondes par fichier sur les dépôts de test.
  const indexingSeconds = Math.max(1, Math.round(input.index.files.length * 0.02));

  // `ceil` sur le nombre de vagues, pas une simple division : trois routes à
  // quatre de front, c'est UNE vague complète, pas trois quarts de vague.
  const detectionWaves = Math.ceil(detectionCalls / concurrency);

  const duration: EstimateRange = {
    low: Math.round(
      indexingSeconds +
        (detectionWaves * detectionLatency.ms + arbitration.low * arbitrationLatency.ms) / 1000
    ),
    high: Math.round(
      indexingSeconds +
        (detectionWaves * detectionLatency.ms * 1.5 + arbitration.high * arbitrationLatency.ms * 1.5) /
          1000
    ),
  };

  // --- Coût -----------------------------------------------------------------
  const detectionPrice = priceFor(input.detection.provider, input.detection.model, env);
  const arbitrationPrice = priceFor(input.arbitration.provider, input.arbitration.model, env);
  const cost = computeCost({
    detectionPrice,
    arbitrationPrice,
    detectionCalls,
    inputTokensPerCall,
    outputTokensPerDetection: OUTPUT_TOKENS_PER_DETECTION,
    arbitration,
    arbitrationInputTokens,
    detectionProvider: input.detection.provider,
    arbitrationProvider: input.arbitration.provider,
    locale,
  });

  // --- Hypothèses déclarées --------------------------------------------------
  if (sampled) assumptions.push(t.sampled(probe.probed, routes.length - probe.probed));
  assumptions.push(
    t.arbitrationShare(
      Math.round(ARBITRATION_SHARE.low * 100),
      Math.round(ARBITRATION_SHARE.high * 100)
    )
  );
  if (concurrency > 1 && detectionCalls > 1) {
    assumptions.push(t.parallelism(concurrency, detectionWaves));
  }
  assumptions.push(
    detectionLatency.measured
      ? t.latencyMeasured(detectionLatency.samples, Math.round(detectionLatency.ms / 100) / 10)
      : t.latencyEstimated(Math.round(detectionLatency.ms / 1000))
  );
  if (probe.failures > 0) warnings.push(t.probeFailures(probe.failures));

  return {
    target: {
      kind: input.target.kind,
      label: input.target.label,
      files_indexed: input.index.files.length,
      routes_found: input.index.endpoints.length,
    },
    mode: input.mode,
    routes_selected: routes.length,
    routes_free: routesFree,
    routes_billed: routesBilled,
    llm_calls: {
      detection: detectionCalls,
      arbitration,
      total: { low: detectionCalls + arbitration.low, high: detectionCalls + arbitration.high },
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: { low: inputTokens + outputTokens.low, high: inputTokens + outputTokens.high },
    },
    duration_s: duration,
    cost,
    sampled,
    sample_size: probe.probed,
    assumptions,
    warnings,
    plain_language_summary: summarize({
      routes: routes.length,
      routesFree,
      routesBilled,
      duration,
      cost,
      target: input.target,
      mode: input.mode,
      locale,
    }),
  };
}

function computeCost(args: {
  detectionPrice: ModelPrice | null;
  arbitrationPrice: ModelPrice | null;
  detectionCalls: number;
  inputTokensPerCall: number;
  outputTokensPerDetection: number;
  arbitration: EstimateRange;
  arbitrationInputTokens: number;
  detectionProvider: string;
  arbitrationProvider: string;
  locale: Locale;
}): CostEstimate {
  const needsArbitration = args.arbitration.high > 0;
  const missing: string[] = [];
  if (args.detectionCalls > 0 && !args.detectionPrice) missing.push(args.detectionProvider);
  if (needsArbitration && !args.arbitrationPrice) missing.push(args.arbitrationProvider);

  if (missing.length > 0) {
    return {
      usd: null,
      free: false,
      unknown_reason: messages(args.locale).estimate.priceMissing(
        [...new Set(missing)].join(' and '),
        `VULNPIPE_PRICE_${missing[0]!.toUpperCase()}`
      ),
      detection_price: args.detectionPrice,
      arbitration_price: args.arbitrationPrice,
    };
  }

  const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

  const detectionCost =
    args.detectionCalls > 0 && args.detectionPrice
      ? perMillion(args.detectionCalls * args.inputTokensPerCall, args.detectionPrice.input_per_mtok) +
        perMillion(
          args.detectionCalls * args.outputTokensPerDetection,
          args.detectionPrice.output_per_mtok
        )
      : 0;

  const arbitrationCostFor = (calls: number): number =>
    args.arbitrationPrice
      ? perMillion(calls * args.arbitrationInputTokens, args.arbitrationPrice.input_per_mtok) +
        perMillion(calls * OUTPUT_TOKENS_PER_ARBITRATION, args.arbitrationPrice.output_per_mtok)
      : 0;

  const low = detectionCost + arbitrationCostFor(args.arbitration.low);
  const high = detectionCost + arbitrationCostFor(args.arbitration.high);

  return {
    usd: { low: round4(low), high: round4(high) },
    free: high === 0,
    unknown_reason: null,
    detection_price: args.detectionPrice,
    arbitration_price: args.arbitrationPrice,
  };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Durée lisible : « 12 secondes », « 4 minutes », « 1 h 10 ». */
export function humanDuration(seconds: number, locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).estimate;
  if (seconds < 60) return t.seconds(Math.max(seconds, 1));
  if (seconds < 3600) return t.minutes(Math.round(seconds / 60));
  const hours = Math.floor(seconds / 3600);
  return t.hours(hours, Math.round((seconds % 3600) / 60));
}

function summarize(args: {
  routes: number;
  routesFree: number;
  routesBilled: number;
  duration: EstimateRange;
  cost: CostEstimate;
  target: ResolvedTarget;
  mode: ScanMode;
  locale: Locale;
}): string {
  const t = messages(args.locale).estimate;

  if (args.routes === 0) {
    return args.mode === 'incremental_scan' ? t.nothingToScan : t.noRoutesFound;
  }

  const parts: string[] = [t.willCheck(args.routes)];

  if (args.routesFree > 0) parts.push(t.freeRoutes(args.routesFree));
  if (args.routesBilled > 0) parts.push(t.billedRoutes(args.routesBilled));

  parts.push(
    t.duration(
      humanDuration(args.duration.low, args.locale),
      humanDuration(args.duration.high, args.locale)
    )
  );

  if (args.cost.free) {
    parts.push(t.isFree);
  } else if (args.cost.usd) {
    const { low, high } = args.cost.usd;
    parts.push(
      low === high
        ? t.costSingle(formatUsd(high, args.locale))
        : t.costRange(formatUsd(low, args.locale), formatUsd(high, args.locale))
    );
    if (high < 0.01) parts.push(t.lessThanACent);
  } else {
    parts.push(t.costUnknown);
  }

  return parts.join(' ');
}

export function formatUsd(value: number, locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).estimate;
  if (value === 0) return t.zero;
  if (value < 0.01) return t.cents((value * 100).toFixed(2));
  return t.dollars(value.toFixed(2));
}

/**
 * Prépare une cible pour estimation ET pour le scan qui suivra.
 *
 * On indexe UNE FOIS. Estimer puis scanner ne doit pas relire le dépôt deux
 * fois — et surtout, dans le cas d'un dépôt GitHub, ne doit pas le cloner deux
 * fois.
 */
export async function prepareTarget(target: ResolvedTarget): Promise<{
  index: RepoIndex;
  provider: ContextProvider;
  routes: ListedRoute[];
  close: () => Promise<void>;
}> {
  const index = buildRepoIndex(target.indexRoot);
  const provider = await connectInProcess(createServer(index));
  const all = await provider.listRoutes();

  // Périmètre demandé (fichier seul) : le reste du projet reste indexé pour la
  // résolution, mais n'est pas audité.
  const routes =
    target.focusFiles === null
      ? all
      : all.filter((route) => target.focusFiles!.some((file) => route.file === file));

  return {
    index,
    provider,
    routes,
    close: async () => {
      await provider.close();
    },
  };
}
