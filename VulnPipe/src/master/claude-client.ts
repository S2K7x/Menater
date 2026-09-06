/**
 * Master Claude — arbitre final sur le payload de l'Agrégateur.
 *
 * ============================================================================
 * CORRECTION MAJEURE DE LA SPEC : CLAUDE DOIT VOIR LE CODE
 *
 * PHASE_5 décrit l'appel comme « l'API Claude avec le payload de findings
 * produit par l'Agrégateur », et justifie l'étape par « Claude peut avoir plus
 * de contexte ou un meilleur raisonnement que le modèle local ».
 *
 * Or le payload de l'Agrégateur ne contient AUCUN code : scores, sévérité,
 * résumés en langage humain, statistiques. Un arbitre qui ne reçoit que le
 * résumé du modèle local ne peut pas arbitrer — il ne peut que reformuler.
 * Il lui est structurellement impossible d'infirmer un verdict faux, puisque
 * la seule chose qu'il voit du code, c'est ce que le node en a dit.
 *
 * Pire, ça casse le test que la spec demande elle-même : « si Claude rejette
 * un verdict du node local ». Sur quelle base rejetterait-il ?
 *
 * Ce client prend donc un `ContextProvider` (serveur MCP de la Phase 2) et
 * récupère, pour chaque finding, le code réellement exécuté par la route :
 * handler, corps des guards, corps des méthodes appelées. Claude voit
 * exactement ce que le node local a vu, et peut le contredire.
 *
 * Le provider reste optionnel — sans lui, l'arbitrage fonctionne toujours,
 * mais chaque verdict est marqué `evidence: "summary_only"` pour que personne
 * ne prenne une reformulation pour une vérification.
 * ============================================================================
 */

import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';
import { arbitrationCacheKey, type ArbitrationCache } from './arbitration-cache.ts';
import type { AggregatedFinding } from '../aggregator/aggregator.ts';
import type { ContextProvider } from '../nodes/shared/mcp-client.ts';
import { AnthropicClient } from '../nodes/shared/llm/anthropic.ts';
import { LlmError, type JsonSchema, type LlmClient } from '../nodes/shared/llm/types.ts';

/**
 * Verdict de l'arbitre.
 *
 * AJOUT PAR RAPPORT À LA SPEC, qui n'offre que `"confirmed" | "rejected"`.
 * Un binaire force l'arbitre à choisir sur des cas justement ambigus : soit il
 * fabrique une confiance qu'il n'a pas, soit il écarte une vraie vulnérabilité.
 * `needs_human_review` laisse le finding visible en le marquant comme non
 * tranché — c'est le comportement sûr quand l'arbitre lui-même doute.
 */
export type ClaudeVerdict = 'confirmed' | 'rejected' | 'needs_human_review';

export interface ArbitratedFinding {
  finding_id: string;
  claude_verdict: ClaudeVerdict;
  claude_reasoning: string;
  technical_summary: string;
  plain_language_summary: string;
  suggested_fix_direction: string;
  owasp_category: string;
  /** Sur quoi l'arbitrage s'est appuyé. */
  evidence: 'code' | 'summary_only';
}

export interface ArbitrationOutcome {
  arbitrated: ArbitratedFinding[];
  /**
   * Findings qui n'ont PAS pu être arbitrés (panne API, réponse incomplète).
   * Ils ne disparaissent jamais : le report-builder les republie avec le
   * verdict local et une mention explicite.
   */
  unarbitrated: Array<{ finding_id: string; why: string }>;
  usage: { input_tokens: number; output_tokens: number; calls: number; latency_ms: number };
  provider: string;
  model: string;
  /**
   * Verdicts resservis depuis le cache, donc non repayés.
   *
   * Exposé plutôt que silencieux : l'utilisateur doit pouvoir comprendre
   * pourquoi un scan a coûté moins que le précédent, sinon la baisse ressemble
   * à une analyse au rabais.
   */
  cache_hits: number;
}

export const MASTER_SYSTEM_PROMPT = `Vous êtes l'arbitre final d'une chaîne d'analyse de sécurité applicative.

Des détecteurs automatiques ont signalé des vulnérabilités potentielles. Pour
chacune, vous recevez le verdict du détecteur ET le code réellement exécuté par
la route concernée. Votre travail :

1. TRANCHER. Confirmez le signalement, rejetez-le, ou marquez-le comme
   nécessitant une revue humaine si le code fourni ne permet pas de conclure.
   Rejeter est légitime et attendu : les détecteurs se trompent. Mais ne
   rejetez QUE si le code montre que la protection existe bel et bien.
   Dans le doute, préférez "needs_human_review" à "rejected" — écarter à tort
   une vraie vulnérabilité coûte plus cher que de faire vérifier une fausse.

2. Pour chaque signalement, rédiger DEUX textes distincts :
   - technical_summary : pour un développeur. Ligne concernée, mécanisme,
     catégorie OWASP. Dense et précis.
   - plain_language_summary : pour quelqu'un qui n'a JAMAIS écrit de code.
     Décrivez le risque concret et le scénario d'attaque en termes du monde
     réel ("quelqu'un qui change le numéro dans la barre d'adresse peut lire
     les factures d'un autre client"). Aucun terme technique : pas de "IDOR",
     pas de "endpoint", pas de "requête SQL", pas de "sanitization".

3. suggested_fix_direction : UNE PHRASE donnant la direction de la correction,
   en langage courant. Exemple : "il faut vérifier que la commande appartient
   bien à la personne connectée avant de la renvoyer".

CONTRAINTE ABSOLUE : n'écrivez JAMAIS de patch, de diff, de bloc de code, ni
d'extrait prêt à copier-coller. Ni dans suggested_fix_direction, ni ailleurs.
Le but est d'expliquer et d'orienter, pas de fournir un correctif applicable
en aveugle. Décrivez l'intention de la correction, jamais son implémentation.`;

const ARBITRATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding_id: { type: 'string' },
          claude_verdict: {
            type: 'string',
            enum: ['confirmed', 'rejected', 'needs_human_review'],
          },
          claude_reasoning: {
            type: 'string',
            description: "Pourquoi ce verdict, en s'appuyant sur le code fourni.",
          },
          technical_summary: { type: 'string', description: 'Pour un développeur.' },
          plain_language_summary: {
            type: 'string',
            description: "Pour quelqu'un qui n'a jamais codé. Aucun terme technique.",
          },
          suggested_fix_direction: {
            type: 'string',
            description: 'Une phrase. Jamais de code.',
          },
          owasp_category: { type: 'string', description: 'Ex. "A01:2021 – Broken Access Control".' },
        },
        required: [
          'finding_id',
          'claude_verdict',
          'claude_reasoning',
          'technical_summary',
          'plain_language_summary',
          'suggested_fix_direction',
          'owasp_category',
        ],
      },
    },
  },
  required: ['verdicts'],
};

/** Identifiant stable d'un finding, réutilisé pour recoller les verdicts. */
export function findingId(finding: AggregatedFinding): string {
  return `${finding.vulnerability}:${finding.http_method}:${finding.route}`;
}

/** Rend le code d'une route sous une forme lisible par le modèle. */
async function collectEvidence(
  finding: AggregatedFinding,
  provider: ContextProvider | undefined
): Promise<{ text: string; evidence: 'code' | 'summary_only' }> {
  if (!provider) {
    return { text: '(code non disponible — arbitrage sur le résumé seul)', evidence: 'summary_only' };
  }

  try {
    const bundle = await provider.getContext(
      { route: finding.route, httpMethod: finding.http_method },
      2
    );

    const guards =
      bundle.resolved_guards.length === 0
        ? "Aucun contrôle d'accès déclaré sur cette route."
        : bundle.resolved_guards
            .map((guard) =>
              guard.resolution_status === 'resolved'
                ? `${guard.guard} :\n${guard.candidates.map((c) => c.code_snapshot).join('\n')}`
                : `${guard.guard} : DÉCLARÉ MAIS CODE INTROUVABLE — impossible de vérifier ce qu'il contrôle.`
            )
            .join('\n');

    const flatten = (calls: typeof bundle.resolved_calls): string[] =>
      calls.flatMap((call) => [
        ...call.candidates.map(
          (c) => `// ${c.class_name}.${c.method} (${c.file}:${c.start_line})\n${c.code_snapshot}`
        ),
        ...(call.candidates.length === 0
          ? [`// ${call.receiver ?? '?'}.${call.call}() — code non disponible`]
          : []),
        ...flatten(call.resolved_calls),
      ]);

    return {
      evidence: 'code',
      text: `HANDLER (${bundle.endpoint.source.file}:${bundle.endpoint.source.start_line})
${bundle.endpoint.code_snapshot}

CONTRÔLE D'ACCÈS
${guards}

CODE APPELÉ
${flatten(bundle.resolved_calls).join('\n\n') || '(aucun appel)'}`,
    };
  } catch (error) {
    return {
      text: `(code non récupérable : ${(error as Error).message})`,
      evidence: 'summary_only',
    };
  }
}

export interface MasterOptions {
  /** Par défaut : Anthropic (CLAUDE.md §2 — le master, c'est Claude). */
  llm?: LlmClient;
  /** Serveur MCP, pour donner le code à l'arbitre. Fortement recommandé. */
  contextProvider?: ContextProvider;
  /** Langue du rapport rédigé par l'arbitre. */
  locale?: Locale;
  /**
   * Cache de verdicts. Absent = aucun cache (comportement d'origine).
   *
   * Il n'est JAMAIS activé par défaut ici : un cache implicite dans une
   * fonction d'arbitrage rendrait les tests et les mesures de calibration
   * dépendants d'un état caché. C'est l'appelant qui décide.
   */
  cache?: ArbitrationCache;
}

/**
 * Soumet les findings à l'arbitre.
 *
 * Un SEUL appel pour tout le lot : le contexte système est partagé, ce qui
 * coûte nettement moins qu'un appel par finding. Le risque d'un appel unique
 * (une réponse incomplète perd tout) est neutralisé par le recollage sur
 * `finding_id` : tout finding sans verdict ressort dans `unarbitrated`, jamais
 * dans le vide.
 */
export async function arbitrate(
  findings: AggregatedFinding[],
  options: MasterOptions = {}
): Promise<ArbitrationOutcome> {
  const llm = options.llm ?? new AnthropicClient();

  if (findings.length === 0) {
    return {
      arbitrated: [],
      unarbitrated: [],
      usage: { input_tokens: 0, output_tokens: 0, calls: 0, latency_ms: 0 },
      provider: llm.provider,
      model: llm.model,
      cache_hits: 0,
    };
  }

  const evidences = await Promise.all(
    findings.map((finding) => collectEvidence(finding, options.contextProvider))
  );

  // --- Ce qui est déjà connu ne repart pas à l'arbitre --------------------
  //
  // La clé porte le CODE montré (voir `arbitration-cache.ts`) : corriger la
  // route change la clé, donc le verdict est réellement recalculé. Un cache
  // indexé sur le seul identifiant de route resservirait « confirmé » sur du
  // code désormais sain.
  const locale = options.locale ?? DEFAULT_LOCALE;
  const cached: ArbitratedFinding[] = [];
  const pending: AggregatedFinding[] = [];
  const pendingEvidence: typeof evidences = [];
  const keyOf = new Map<AggregatedFinding, string>();

  findings.forEach((finding, i) => {
    const key = options.cache
      ? arbitrationCacheKey({
          finding,
          evidence: evidences[i]!.text,
          provider: llm.provider,
          model: llm.model,
          locale,
        })
      : null;
    const hit = key === null ? undefined : options.cache!.get(key);
    if (hit) {
      cached.push(hit);
      return;
    }
    if (key !== null) keyOf.set(finding, key);
    pending.push(finding);
    pendingEvidence.push(evidences[i]!);
  });

  // Tout était déjà arbitré : aucun appel, donc aucun coût. Ce n'est pas une
  // panne — les verdicts sont bien là.
  if (pending.length === 0) {
    return {
      arbitrated: cached,
      unarbitrated: [],
      usage: { input_tokens: 0, output_tokens: 0, calls: 0, latency_ms: 0 },
      provider: llm.provider,
      model: llm.model,
      cache_hits: cached.length,
    };
  }

  const blocks = pending.map((finding, i) => {
    const id = findingId(finding);
    return `--- SIGNALEMENT ${id} ---
Vulnérabilité suspectée : ${finding.vulnerability}
Route                   : ${finding.http_method} ${finding.route} (${finding.file})
Sévérité estimée        : ${finding.severity}
Score du détecteur      : ${finding.confidence_score}${
      finding.reason ? ` (doute : ${finding.reason})` : ''
    }
Détecté par             : ${finding.detected_by.join(', ')}${
      finding.corroborated ? ' — plusieurs détecteurs concordent' : ''
    }
Ce que le détecteur en dit : ${finding.plain_language_summary}

CODE RÉELLEMENT EXÉCUTÉ PAR CETTE ROUTE :
${pendingEvidence[i]!.text}`;
  });

  const user = `Voici ${pending.length} signalement(s) à arbitrer. Rends un verdict pour CHACUN,
en réutilisant exactement le finding_id fourni.

${blocks.join('\n\n')}`;

  let parsed: { verdicts: Omit<ArbitratedFinding, 'evidence'>[] };
  let usage = { input_tokens: 0, output_tokens: 0, calls: 0, latency_ms: 0 };

  try {
    const response = await llm.complete<{ verdicts: Omit<ArbitratedFinding, 'evidence'>[] }>({
      system: `${MASTER_SYSTEM_PROMPT}\n\n${messages(locale).prompt.answerLanguage}`,
      user,
      schema: ARBITRATION_SCHEMA,
      temperature: 0,
      maxOutputTokens: 8_000,
    });
    parsed = response.parsed;
    usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      calls: 1,
      latency_ms: response.latency_ms,
    };
  } catch (error) {
    // L'arbitre est tombé. AUCUN finding ne doit disparaître pour autant :
    // un rapport de sécurité amputé par une panne réseau est pire qu'un
    // rapport qui dit « je n'ai pas pu vérifier ces points ».
    const why =
      error instanceof LlmError
        ? `arbitrage indisponible (${error.kind}) : ${error.message}`
        : `arbitrage indisponible : ${(error as Error).message}`;
    // Les verdicts déjà en cache restent ACQUIS : une panne sur le reste ne
    // doit pas effacer ce qu'on savait déjà.
    return {
      arbitrated: cached,
      unarbitrated: pending.map((finding) => ({ finding_id: findingId(finding), why })),
      usage,
      provider: llm.provider,
      model: llm.model,
      cache_hits: cached.length,
    };
  }

  // Recollage par identifiant : ce qui manque est signalé, pas perdu.
  const byId = new Map((parsed.verdicts ?? []).map((v) => [v.finding_id, v]));
  const arbitrated: ArbitratedFinding[] = [...cached];
  const unarbitrated: ArbitrationOutcome['unarbitrated'] = [];

  pending.forEach((finding, i) => {
    const id = findingId(finding);
    const verdict = byId.get(id);
    if (!verdict) {
      unarbitrated.push({
        finding_id: id,
        why: "l'arbitre n'a pas rendu de verdict pour ce signalement",
      });
      return;
    }
    const complete: ArbitratedFinding = {
      ...verdict,
      finding_id: id,
      evidence: pendingEvidence[i]!.evidence,
    };
    arbitrated.push(complete);

    // On ne mémorise QUE les verdicts effectivement rendus SUR DU CODE.
    //
    // Deux exclusions, pour la même raison de fond — ne jamais figer une
    // réponse qui ne reflète pas l'état réel du code :
    //   - un finding non arbitré (panne, réponse incomplète) doit être
    //     redemandé au scan suivant ;
    //   - un verdict rendu sans le code (serveur de contexte injoignable)
    //     s'appuie sur un texte de preuve CONSTANT. Sa clé ne bougerait donc
    //     pas quand le code change, et le cache resservirait ce verdict
    //     aveugle sur du code corrigé — exactement ce que ce cache doit être
    //     incapable de faire.
    const key = keyOf.get(finding);
    if (key !== undefined && complete.evidence === 'code') options.cache?.set(key, complete);
  });

  return {
    arbitrated,
    unarbitrated,
    usage,
    provider: llm.provider,
    model: llm.model,
    cache_hits: cached.length,
  };
}
