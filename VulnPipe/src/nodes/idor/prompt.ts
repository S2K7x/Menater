/**
 * Template de prompt du node IDOR.
 *
 * La structure imposée par PHASE_3_DETECTION_NODE_IDOR.md est conservée mot
 * pour mot (« ne pas la simplifier, chaque partie a un rôle précis dans la
 * calibration du score ») : rôle, CONTEXTE, DIRECTIVES en Chain-of-Thought,
 * GRILLE DE CALIBRATION, FORMAT DE SORTIE.
 *
 * TROIS AJOUTS, chacun motivé — voir ROADMAP.md pour le détail :
 *
 *  1. SECTION [CONTRÔLE D'ACCÈS DÉCLARÉ]. Le template d'origine n'a que
 *     [ROUTE ET HANDLER] et [CALL GRAPH RÉSOLU]. Or `@UseGuards(OwnershipGuard)`
 *     n'est pas un appel : il n'apparaît dans aucun call graph. Sans cette
 *     section, tout le travail de résolution des guards de la Phase 2 est
 *     jeté, et le modèle ne peut pas distinguer une route protégée d'une
 *     route qui ne l'est pas — les deux lui paraissent identiques.
 *
 *  2. RÈGLE DE COUPLAGE score/reason. Mesuré sur gemini-3.5-flash : le modèle
 *     a renvoyé `confidence_score: 0.9` avec `reason: "missing_context"`.
 *     C'est contradictoire — 0.9 est la zone « vulnérabilité quasi certaine »,
 *     `missing_context` la zone grise. La grille l'implique sans le dire ;
 *     on l'écrit, et `node.ts` le vérifie en plus côté déterministe.
 *
 *  3. DEUX EXEMPLES FEW-SHOT. La spec les présente comme un « filet de
 *     sécurité » à ajouter si le modèle dérive, en renvoyant à CLAUDE.md.
 *     Ils n'y figurent nulle part : la référence est fausse. Ils sont donc
 *     rédigés ici, et activables via `includeFewShot` pour pouvoir mesurer
 *     leur effet réel plutôt que de les supposer utiles.
 */

import { DEFAULT_LOCALE, type Locale } from '../../i18n/locale.ts';
import { messages } from '../../i18n/messages.ts';
import type { JsonSchema } from '../shared/llm/types.ts';
import type { ContextBundle, ResolvedCall, ResolvedGuard } from '../../mcp-server/resolver.ts';

/**
 * Rôle de l'agent. Première ligne du préfixe invariant.
 *
 * Conservé exporté sous son nom d'origine : il sert de repère de lisibilité et
 * reste le début exact du prompt système construit par `idorSystemPrompt`.
 */
export const IDOR_SYSTEM_PROMPT = `Vous êtes un agent de sécurité statique (SAST) spécialisé dans la
détection des failles IDOR (Insecure Direct Object Reference).`;

/**
 * Schéma de sortie.
 *
 * `reason` utilise le sentinelle "none" au lieu de `null` : le `null` dans un
 * `enum` n'est pas portable entre fournisseurs (Gemini suit un sous-ensemble
 * OpenAPI, Ollama compile le schéma en grammaire). `node.ts` retraduit
 * "none" -> null pour respecter le contrat de CLAUDE.md §3.
 */
export const IDOR_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    analysis: {
      type: 'object',
      properties: {
        resource_identifier: {
          type: 'string',
          description: "Variable portant l'identifiant de la ressource demandée.",
        },
        user_context: {
          type: 'string',
          description: "Où est récupérée l'identité de l'utilisateur qui fait la requête.",
        },
        step_by_step_reasoning: {
          type: 'string',
          description: 'Raisonnement suivi, étape par étape, AVANT de donner un score.',
        },
      },
      required: ['resource_identifier', 'user_context', 'step_by_step_reasoning'],
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vulnerability: { type: 'string' },
          line: { type: 'integer' },
          proof_snippet: { type: 'string' },
        },
        required: ['vulnerability', 'line', 'proof_snippet'],
      },
    },
    confidence_score: { type: 'number', description: 'Entre 0.0 et 1.0.' },
    reason: { type: 'string', enum: ['none', 'missing_context', 'ambiguous_logic'] },
    plain_language_summary: {
      type: 'string',
      description:
        "Explication en français simple, pour un non-développeur : le risque concret et ce qu'un attaquant pourrait faire.",
    },
  },
  required: ['analysis', 'findings', 'confidence_score', 'reason', 'plain_language_summary'],
};

const FEW_SHOT = `
### EXEMPLES DE CALIBRATION

Exemple A — route saine (score attendu : 0.1)
Code : \`return this.db.orders.findOne({ id, userId: req.user.id });\`
Analyse : la requête croise explicitement l'identifiant de la ressource (id) ET
l'identifiant de l'utilisateur connecté (userId). Un attaquant qui change le
numéro dans l'URL ne recevra rien, car la commande ne lui appartient pas.
-> confidence_score: 0.1, reason: "none"

Exemple B — zone grise (score attendu : 0.5)
Code : \`@UseGuards(OwnershipGuard)\` présent, mais le corps de OwnershipGuard
n'est pas fourni dans le contexte.
Analyse : une protection est déclarée, mais rien ne permet de vérifier ce
qu'elle contrôle réellement. Le doute porte sur du code absent, pas sur le
jugement métier.
-> confidence_score: 0.5, reason: "missing_context"
`;

function formatGuards(guards: ResolvedGuard[]): string {
  if (guards.length === 0) {
    return "Aucun contrôle d'accès déclaré sur cette route (ni décorateur de garde, ni au niveau du contrôleur).";
  }
  return guards
    .map((guard) => {
      if (guard.resolution_status !== 'resolved') {
        return `- ${guard.guard} : DÉCLARÉ MAIS CODE INTROUVABLE (${guard.resolution_status}). Impossible de vérifier ce qu'il contrôle.`;
      }
      const bodies = guard.candidates
        .map((c) => `  // ${c.file}:${c.start_line}\n${c.code_snapshot}`)
        .join('\n');
      return `- ${guard.guard} : code résolu\n${bodies}`;
    })
    .join('\n');
}

function formatCalls(calls: ResolvedCall[], depth = 1): string {
  const lines: string[] = [];
  for (const call of calls) {
    const indent = '  '.repeat(depth - 1);
    if (call.resolution_status === 'resolved') {
      for (const candidate of call.candidates) {
        lines.push(
          `${indent}// niveau ${depth} — ${candidate.class_name}.${candidate.method} (${candidate.file}:${candidate.start_line})`
        );
        lines.push(`${indent}${candidate.code_snapshot}`);
      }
    } else if (call.resolution_status === 'ambiguous') {
      lines.push(
        `${indent}// niveau ${depth} — ${call.call} : PLUSIEURS IMPLÉMENTATIONS POSSIBLES, laquelle s'exécute est indéterminé`
      );
      for (const candidate of call.candidates) {
        lines.push(`${indent}// candidat ${candidate.file}\n${indent}${candidate.code_snapshot}`);
      }
    } else {
      lines.push(
        `${indent}// niveau ${depth} — ${call.receiver ?? '?'}.${call.call}() : CODE NON DISPONIBLE (appel externe, bibliothèque, ou accès direct à la base).`
      );
    }
    if (call.resolved_calls.length > 0) {
      lines.push(formatCalls(call.resolved_calls, depth + 1));
    }
  }
  return lines.join('\n');
}

export interface BuildPromptOptions {
  includeFewShot?: boolean;
  /**
   * Langue des champs destinés à un humain.
   *
   * Traduire l'interface sans traduire ce que produit le modèle donnerait un
   * écran anglais dont chaque alerte serait rédigée en français : le pire des
   * deux mondes. La consigne part donc avec le prompt.
   */
  locale?: Locale;
}

/**
 * Consignes d'analyse — TOUT ce qui ne dépend pas de la route examinée.
 *
 * ===========================================================================
 * POURQUOI CE TEXTE A CHANGÉ DE CÔTÉ
 *
 * Directives, grille de calibration, règle de couplage, exemples et format de
 * sortie vivaient dans le message UTILISATEUR, APRÈS le code de la route. Le
 * prompt système, lui, tenait en deux lignes.
 *
 * Conséquence, sur tous les fournisseurs : le plus long préfixe commun à deux
 * requêtes d'un même scan faisait cent trente caractères. Or un cache de
 * prompt — automatique chez OpenAI et Gemini, explicite chez Anthropic — ne
 * sait réutiliser qu'un PRÉFIXE, et abandonne au premier octet qui diffère.
 * Le code de la route changeant à chaque appel et arrivant en tête, il n'y
 * avait rien à réutiliser : les mêmes trois mille caractères de consignes
 * étaient facturés plein tarif quarante fois de suite.
 *
 * C'est la version symétrique du piège déjà documenté côté console (« a
 * per-request nonce in a cached prefix ») : là-bas un octet volatile posé au
 * milieu invalidait tout ce qui suivait ; ici la partie invariante était
 * simplement rangée du mauvais côté. Rien n'échoue dans les deux cas — c'est
 * une facture.
 *
 * Invariant d'abord et sans argument variable, volatile ensuite.
 *
 * CE QUE ÇA RAPPORTE AUJOURD'HUI, MESURÉ : RIEN ENCORE. Le préfixe ainsi
 * reconstitué pèse 1 836 caractères sans les exemples, 2 629 avec — soit
 * ~460 et ~660 tokens. Les caches de prompt ne s'amorcent qu'au-delà de
 * ~1 024 tokens ; en dessous, marquer le bloc reviendrait à payer la prime
 * d'écriture pour un bloc qui ne sera jamais relu, et `cacheableSystem`
 * (`nodes/shared/llm/types.ts`) refuse donc de le marquer. Écrit ici plutôt
 * que supposé : une optimisation qu'on croit active alors qu'elle dort est
 * pire qu'une optimisation absente.
 *
 * Ce qui est acquis, c'est la FORME. Le jour où un détecteur porte une grille
 * plus longue, ou qu'on active les exemples sur plusieurs détecteurs, le
 * préfixe franchit le seuil et le cache s'amorce sans retoucher une ligne. À
 * l'inverse, laisser le code en tête garantissait qu'il ne s'amorcerait
 * jamais, quelle que soit la longueur des consignes.
 *
 * `locale` en fait partie : elle est constante pour un scan entier, donc elle
 * ne casse pas le préfixe. `includeFewShot` aussi.
 * ===========================================================================
 */
export function idorSystemPrompt(options: BuildPromptOptions = {}): string {
  return `${IDOR_SYSTEM_PROMPT}

### DIRECTIVES D'ANALYSE (Chain-of-Thought obligatoire avant le score)
1. Identification de la source : quelle variable représente l'identifiant
   de la ressource demandée ?
2. Identification du contexte utilisateur : où est récupérée l'identité de
   l'utilisateur qui fait la requête ?
3. Analyse du flux de contrôle : le code croise-t-il explicitement
   l'identifiant de la ressource ET l'identifiant de l'utilisateur ?

### GRILLE DE CALIBRATION DU SCORE
- 0.0 à 0.3 (Sain) : la requête croise explicitement id + userId, ou la
  route est publique par design.
- 0.4 à 0.7 (Zone grise) : une fonction/décorateur d'autorisation est
  présent mais son code n'est pas fourni dans le contexte (→ reason:
  "missing_context"), OU la logique métier est ambiguë même avec tout le
  contexte disponible (→ reason: "ambiguous_logic").
- 0.8 à 1.0 (IDOR probable) : aucun croisement id/userId, aucune fonction
  d'autorisation détectée.

### RÈGLE DE COUPLAGE (obligatoire)
Le champ "reason" doit être cohérent avec le score :
- score <= 0.3  -> reason DOIT valoir "none"
- 0.4 <= score <= 0.7 -> reason DOIT valoir "missing_context" ou "ambiguous_logic"
- score >= 0.8  -> reason DOIT valoir "none"
Un score de 0.9 accompagné de "missing_context" est contradictoire : s'il te
manque du contexte, le score appartient à la zone grise.
${options.includeFewShot ? FEW_SHOT : ''}
### FORMAT DE SORTIE — JSON STRICT, rien avant ni après
Le champ "plain_language_summary" est obligatoire : ce qui peut arriver
concrètement à l'utilisateur et comment corriger. Jamais de jargon SAST
("taint analysis", "sink", "sanitization").
${messages(options.locale ?? DEFAULT_LOCALE).prompt.answerLanguage}`;
}

/**
 * Message utilisateur : le code de la route, et RIEN d'autre.
 *
 * C'est la seule partie qui change d'un appel à l'autre. Toute consigne
 * ajoutée ici serait payée à chaque route (voir `idorSystemPrompt`).
 *
 * `options` reste accepté pour ne pas casser les appelants existants, mais
 * n'influence plus ce message : les deux réglages qu'il portait
 * (`includeFewShot`, `locale`) sont passés du côté invariant.
 */
export function buildIdorPrompt(bundle: ContextBundle, _options: BuildPromptOptions = {}): string {
  const endpoint = bundle.endpoint;

  return `### CONTEXTE DU CODE À ANALYSER
[ROUTE ET HANDLER]
Route : ${endpoint.http_method.toUpperCase()} ${endpoint.route}
Fichier : ${endpoint.source.file} (lignes ${endpoint.source.start_line}-${endpoint.source.end_line})
${endpoint.code_snapshot}

[CONTRÔLE D'ACCÈS DÉCLARÉ]
${formatGuards(bundle.resolved_guards)}

[CALL GRAPH RÉSOLU - NIVEAU 1 À ${bundle.depth}]
${formatCalls(bundle.resolved_calls) || 'Aucun appel de fonction dans ce handler.'}`;
}
