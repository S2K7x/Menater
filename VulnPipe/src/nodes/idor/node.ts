/**
 * Node de détection IDOR — gabarit pour les nodes suivants (XSS, SQLi, …).
 *
 * Enchaînement : MCP get_context -> scanner déterministe -> LLM -> garde-fous.
 * Seuls `prompt.ts` et `scanner.ts` sont spécifiques à IDOR ; le client MCP et
 * le client LLM sont génériques dans `../shared/` (exigence de PHASE_3).
 */

import { DEFAULT_LOCALE, type Locale } from '../../i18n/locale.ts';
import type { ContextBundle } from '../../mcp-server/resolver.ts';
import type { ContextProvider, RouteRef } from '../shared/mcp-client.ts';
import { McpAccessError } from '../shared/mcp-client.ts';
import { LlmError, type LlmClient } from '../shared/llm/types.ts';
import { buildIdorPrompt, idorSystemPrompt, IDOR_OUTPUT_SCHEMA } from './prompt.ts';
import { verdictCacheKey, type VerdictCache } from '../shared/verdict-cache.ts';
import { scanForIdor, type ScannerReport } from './scanner.ts';

export type DoubtReason = 'missing_context' | 'ambiguous_logic' | null;

export interface IdorFinding {
  vulnerability: string;
  line: number;
  proof_snippet: string;
}

/** Sortie brute attendue du LLM (`reason` en sentinelle "none"). */
interface RawVerdict {
  analysis: {
    resource_identifier: string;
    user_context: string;
    step_by_step_reasoning: string;
  };
  findings: IdorFinding[];
  confidence_score: number;
  reason: 'none' | 'missing_context' | 'ambiguous_logic';
  plain_language_summary: string;
}

export interface IdorVerdict {
  vulnerability: 'IDOR';
  route: string;
  http_method: string;
  handler: string;
  file: string;
  confidence_score: number;
  reason: DoubtReason;
  plain_language_summary: string;
  technical_detail: {
    analysis: RawVerdict['analysis'] | null;
    findings: IdorFinding[];
    scanner: ScannerReport;
    /** Profondeur de contexte finalement utilisée. */
    depth_used: number;
    /** true si le node a redemandé du contexte plus profond. */
    retried: boolean;
    /**
     * true si le verdict vient du cache : même question, déjà posée, déjà
     * payée. Distinct de `llm === null`, qui veut dire « tranché sans modèle
     * du tout ». Les deux sont gratuits, mais pas pour la même raison, et
     * l'utilisateur doit pouvoir faire la différence.
     */
    from_cache: boolean;
    /** Ajustements déterministes appliqués après coup au verdict du LLM. */
    adjustments: string[];
    llm: {
      provider: string;
      model: string;
      /** Nombre d'appels facturés pour cette route (0 = tranché sans LLM). */
      calls: number;
      input_tokens: number;
      output_tokens: number;
      thinking_tokens: number;
      latency_ms: number;
    } | null;
  };
}

export interface IdorNodeOptions {
  contextProvider: ContextProvider;
  llm: LlmClient;
  /** Profondeur initiale demandée au MCP. */
  initialDepth?: number;
  /** Plafond de profondeur pour le retry (spec : « inférieure à 3 »). */
  maxDepth?: number;
  /** Active les exemples de calibration dans le prompt. */
  includeFewShot?: boolean;
  /** Laisser le scanner déterministe court-circuiter le LLM quand il conclut seul. */
  allowDeterministicShortCircuit?: boolean;
  /** Langue des résumés, côté scanner comme côté modèle. */
  locale?: Locale;
  /**
   * Cache de verdicts, partagé entre les scans.
   *
   * Absent = aucun cache. C'est le serveur qui en possède un ; les scripts et
   * les tests n'en fournissent pas, pour ne jamais mesurer une calibration à
   * travers un état caché — même règle que le cache d'arbitrage.
   */
  verdictCache?: VerdictCache;
}

export const DEFAULT_INITIAL_DEPTH = 2;
export const DEFAULT_MAX_DEPTH = 3;

/**
 * Un contexte plus profond peut-il apporter quelque chose ?
 *
 * CORRECTION DE LA SPEC. Le prompt de phase dit : si `reason === "missing_context"`
 * et profondeur < 3, rappeler `get_context(route, depth+1)`. Appliqué tel quel,
 * ce retry est souvent une dépense pure : si le contexte manque parce qu'une
 * classe est absente de l'index (guard introuvable, ORM externe), descendre
 * d'un niveau ne la fera pas apparaître — on repaie un appel LLM pour obtenir
 * exactement le même contexte.
 *
 * On ne retente donc que si un appel DÉJÀ RÉSOLU a des appels sortants non
 * encore développés : là, un niveau de plus révèle réellement du code neuf.
 */
export function couldDeepenHelp(bundle: ContextBundle): boolean {
  const hasUnexpandedFrontier = (calls: ContextBundle['resolved_calls']): boolean =>
    calls.some(
      (call) =>
        (call.resolution_status === 'resolved' &&
          call.resolved_calls.length === 0 &&
          !call.already_expanded) ||
        hasUnexpandedFrontier(call.resolved_calls)
    );

  return (
    hasUnexpandedFrontier(bundle.resolved_calls) ||
    bundle.resolved_guards.some((guard) => guard.resolution_status === 'resolved' && guard.resolved_calls.length === 0)
  );
}

/** Traduit la sentinelle "none" vers le `null` du contrat CLAUDE.md §3. */
function normalizeReason(raw: RawVerdict['reason']): DoubtReason {
  return raw === 'none' ? null : raw;
}

/**
 * Garde-fous déterministes appliqués APRÈS le LLM.
 *
 * Un modèle peut renvoyer un JSON structurellement valide mais incohérent —
 * mesuré : `confidence_score: 0.9` avec `reason: "missing_context"`. Le
 * schéma ne peut pas attraper ça, seule une règle le peut. On corrige et on
 * trace chaque correction dans `adjustments` : un ajustement silencieux
 * rendrait la calibration du modèle impossible à mesurer.
 */
function applyGuardrails(
  verdict: RawVerdict,
  scanner: ScannerReport,
  bundle: ContextBundle
): { score: number; reason: DoubtReason; adjustments: string[] } {
  const adjustments: string[] = [];

  let score = verdict.confidence_score;
  let reason = normalizeReason(verdict.reason);

  // 1. Score hors plage — observé sur un modèle local (100.0 au lieu de 1.0).
  if (!Number.isFinite(score)) {
    adjustments.push(`Score non numérique (${verdict.confidence_score}) : ramené en zone grise à 0.5.`);
    score = 0.5;
  } else if (score > 1 || score < 0) {
    const clamped = Math.min(Math.max(score > 1 && score <= 100 ? score / 100 : score, 0), 1);
    adjustments.push(`Score hors plage (${verdict.confidence_score}) : normalisé à ${clamped}.`);
    score = clamped;
  }

  // 2. Couplage score/reason (CLAUDE.md §3). Un doute sur du contexte manquant
  // ne peut pas coexister avec une certitude : la zone grise prime.
  if (reason !== null && score >= 0.8) {
    adjustments.push(
      `Score ${score} incompatible avec reason="${reason}" : ramené à 0.7 (zone grise), le doute prime sur la certitude.`
    );
    score = 0.7;
  }
  if (reason !== null && score <= 0.3) {
    adjustments.push(
      `Score ${score} incompatible avec reason="${reason}" : remonté à 0.4 (zone grise), un doute ne peut pas conclure « sain ».`
    );
    score = 0.4;
  }
  if (reason === null && score > 0.3 && score < 0.8) {
    // Zone grise sans nature de doute : on la déduit du contexte plutôt que
    // de laisser l'Agrégateur (Phase 4) sans information de routage.
    reason = bundle.reason ?? 'ambiguous_logic';
    adjustments.push(`Score ${score} en zone grise sans reason : déduit à "${reason}" depuis le contexte.`);
  }

  // 3. Le scanner a la main sur un point factuel : si aucune requête n'est
  // non filtrée ET qu'un guard est résolu, un score très haut est suspect.
  if (score >= 0.8 && !scanner.has_unscoped_data_access && scanner.has_resolved_guard) {
    adjustments.push(
      "Le scanner déterministe n'a trouvé aucune requête non filtrée et un contrôle d'accès résolu : score ramené en zone grise pour arbitrage."
    );
    score = 0.6;
    reason = 'ambiguous_logic';
  }

  return { score: Number(score.toFixed(2)), reason, adjustments };
}

function verdictFromScanner(
  bundle: ContextBundle,
  scanner: ScannerReport,
  depth: number
): IdorVerdict {
  return {
    vulnerability: 'IDOR',
    route: bundle.endpoint.route,
    http_method: bundle.endpoint.http_method.toUpperCase(),
    handler: bundle.endpoint.handler,
    file: bundle.endpoint.source.file,
    confidence_score: scanner.decisive_score!,
    reason: null,
    plain_language_summary: scanner.plain_language_summary,
    technical_detail: {
      analysis: null,
      findings: [],
      scanner,
      depth_used: depth,
      retried: false,
      from_cache: false,
      adjustments: ['Verdict rendu sans appel LLM : le scanner déterministe a conclu seul.'],
      llm: null,
    },
  };
}

/** Analyse une route et rend un verdict IDOR. */
export async function analyzeRouteForIdor(
  ref: RouteRef,
  options: IdorNodeOptions
): Promise<IdorVerdict> {
  const initialDepth = options.initialDepth ?? DEFAULT_INITIAL_DEPTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const shortCircuit = options.allowDeterministicShortCircuit ?? true;
  const locale = options.locale ?? DEFAULT_LOCALE;

  let bundle: ContextBundle;
  try {
    bundle = await options.contextProvider.getContext(ref, initialDepth);
  } catch (error) {
    if (error instanceof McpAccessError) throw error;
    throw new McpAccessError(
      `Impossible d'obtenir le contexte de ${ref.route} : ${(error as Error).message}`,
      "Le code de cette route n'a pas pu être récupéré, elle n'a donc pas été analysée. Ne la considère pas comme sûre.",
    );
  }

  const scanner = scanForIdor(bundle, locale);

  // Économie de tokens : rien à arbitrer, on ne paie pas d'appel LLM.
  if (shortCircuit && scanner.decisive_score !== null) {
    return verdictFromScanner(bundle, scanner, initialDepth);
  }

  let depthUsed = initialDepth;
  let retried = false;
  let llmCalls = 0;
  let fromCache = false;
  let totals = { input: 0, output: 0, thinking: 0, latency: 0 };

  const system = idorSystemPrompt({ includeFewShot: options.includeFewShot, locale });

  const ask = async (context: ContextBundle): Promise<RawVerdict> => {
    const user = buildIdorPrompt(context);

    // La clé porte le prompt MOT POUR MOT — donc le code montré au modèle.
    // Corriger la route change la clé : le cache est incapable de resservir
    // un verdict périmé sur du code modifié. Voir `shared/verdict-cache.ts`.
    const key = options.verdictCache
      ? verdictCacheKey({
          provider: options.llm.provider,
          model: options.llm.model,
          system,
          user,
          // La forme attendue en sortie fait partie de la question : un
          // schéma retouché ne doit pas resservir un verdict d'hier auquel
          // manquerait un champ. Sans persistance ce n'était pas un risque —
          // un redémarrage vidait le cache.
          schema: IDOR_OUTPUT_SCHEMA,
        })
      : null;

    if (key !== null) {
      const hit = options.verdictCache!.get<RawVerdict>(key);
      if (hit !== undefined) {
        fromCache = true;
        return hit;
      }
    }

    const response = await options.llm.complete<RawVerdict>({
      system,
      user,
      schema: IDOR_OUTPUT_SCHEMA,
      temperature: 0,
    });
    llmCalls += 1;
    totals = {
      input: totals.input + response.usage.input_tokens,
      output: totals.output + response.usage.output_tokens,
      thinking: totals.thinking + (response.usage.thinking_tokens ?? 0),
      latency: totals.latency + response.latency_ms,
    };

    // On ne mémorise QUE ce qui vient d'être réellement rendu. Un verdict
    // resservi n'est pas réécrit : `BoundedLru` l'a déjà remis en queue.
    if (key !== null) options.verdictCache!.set(key, response.parsed);

    return response.parsed;
  };

  let verdict: RawVerdict;
  try {
    verdict = await ask(bundle);
  } catch (error) {
    if (error instanceof LlmError) {
      throw new LlmError(
        error.provider,
        error.kind,
        `Analyse IDOR de ${ref.route} impossible : ${error.message}`,
        error.retryable
      );
    }
    throw error;
  }

  // Retry sur manque de contexte — une seule fois, et seulement s'il peut servir.
  if (
    normalizeReason(verdict.reason) === 'missing_context' &&
    depthUsed < maxDepth &&
    couldDeepenHelp(bundle)
  ) {
    const deeper = await options.contextProvider.getContext(ref, depthUsed + 1);
    const deeperScanner = scanForIdor(deeper, locale);
    bundle = deeper;
    depthUsed += 1;
    retried = true;
    verdict = await ask(deeper);
    Object.assign(scanner, deeperScanner);
  }

  const guarded = applyGuardrails(verdict, scanner, bundle);

  return {
    vulnerability: 'IDOR',
    route: bundle.endpoint.route,
    http_method: bundle.endpoint.http_method.toUpperCase(),
    handler: bundle.endpoint.handler,
    file: bundle.endpoint.source.file,
    confidence_score: guarded.score,
    reason: guarded.reason,
    plain_language_summary: verdict.plain_language_summary,
    technical_detail: {
      analysis: verdict.analysis,
      findings: verdict.findings ?? [],
      scanner,
      depth_used: depthUsed,
      retried,
      from_cache: fromCache,
      adjustments: guarded.adjustments,
      // `calls: 0` quand tout est venu du cache : rien n'a été facturé, et
      // un compteur qui dirait le contraire ferait mentir la note de frais.
      llm: {
        provider: options.llm.provider,
        model: options.llm.model,
        calls: llmCalls,
        input_tokens: totals.input,
        output_tokens: totals.output,
        thinking_tokens: totals.thinking,
        latency_ms: totals.latency,
      },
    },
  };
}
