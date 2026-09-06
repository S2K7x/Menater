/**
 * Scanner déterministe IDOR — pas de LLM.
 *
 * POURQUOI CE FICHIER EXISTE ALORS QUE PHASE_3 NE LE LISTE PAS
 *
 * `CLAUDE.md` §2 décrit chaque node comme « scanner déterministe
 * (pattern/Semgrep) + LLM local (verdict + confidence_score) ». Les livrables
 * de PHASE_3 ne listent que `prompt.ts` et `node.ts` : le scanner déterministe
 * a disparu entre l'architecture et le prompt de phase.
 *
 * Ce n'est pas cosmétique. Sans lui, CHAQUE route déclenche un appel LLM,
 * y compris les routes trivialement saines — ce qui contredit frontalement la
 * promesse n°1 (low-cost). Le scanner fait deux choses :
 *
 *  1. Il coupe court quand le verdict est déterministe (aucun identifiant de
 *     ressource dans la route => pas de surface IDOR). Aucun token dépensé.
 *  2. Il fournit au LLM des faits déjà établis (lignes des requêtes base,
 *     présence d'un filtre utilisateur) plutôt que de lui demander de les
 *     redécouvrir — et sert de garde-fou pour vérifier ses affirmations.
 */

import { DEFAULT_LOCALE, type Locale } from '../../i18n/locale.ts';
import { messages } from '../../i18n/messages.ts';
import type { ContextBundle, ResolvedCall } from '../../mcp-server/resolver.ts';

/** Segments de route qui désignent une ressource adressable : /orders/:id */
const RESOURCE_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Noms de champs qui portent une identité utilisateur dans une requête. */
const USER_SCOPE_FIELDS = [
  'userid',
  'user_id',
  'ownerid',
  'owner_id',
  'accountid',
  'account_id',
  'tenantid',
  'tenant_id',
  'organizationid',
  'organization_id',
  'customerid',
  'customer_id',
];

/**
 * Verbes qui, en PRÉFIXE d'un nom de méthode, désignent un accès aux données :
 * le point où une lecture non filtrée devient une fuite.
 *
 * Bug corrigé (voir NIGHTLY_LOG.md) : une liste de noms exacts (`findone`,
 * `findbyid`...) rate silencieusement toute convention ORM composée —
 * `findOneBy` (TypeORM), `findByIdAndUpdate` (Mongoose), `updateOne`... Un nom
 * non reconnu n'est pas comptabilisé comme non filtré ; si une AUTRE requête
 * de la même méthode est filtrée, le verdict décisif "sain" tombe quand même,
 * à coût nul, alors que la requête non reconnue n'a jamais été examinée.
 * Même famille de faux négatif silencieux que le bug corrigé la nuit du
 * 2026-08-18, côté nom de méthode plutôt que côté fenêtre de recherche.
 *
 * Un préfixe capture la famille du verbe sans énumérer chaque variante. Un
 * faux positif ici (un nom qui commence par "get" mais n'est pas une requête)
 * ne fait au pire que renvoyer une route vers le LLM au lieu de la trancher
 * gratuitement — jamais vers un verdict "sain" à tort. C'est la direction
 * sûre pour ce garde-fou.
 */
const DATA_ACCESS_PREFIXES = [
  'find',
  'get',
  'query',
  'select',
  'fetch',
  'load',
  'update',
  'delete',
  'remove',
  'destroy',
  'save',
];

export interface ScannerFinding {
  kind: 'unscoped_data_access' | 'scoped_data_access' | 'no_resource_identifier';
  detail: string;
  line: number | null;
  file: string | null;
}

export interface ScannerReport {
  /** Paramètres de route désignant une ressource (`:id`, `:orderId`...). */
  resource_params: string[];
  /** true si la route ne cible aucune ressource identifiée : pas de surface IDOR. */
  has_no_attack_surface: boolean;
  /** true si un guard est déclaré ET son code résolu. */
  has_resolved_guard: boolean;
  /** true si un guard est déclaré mais son code introuvable. */
  has_unresolved_guard: boolean;
  /** true si au moins une requête base ne porte aucun champ d'identité. */
  has_unscoped_data_access: boolean;
  /** true si au moins une requête base croise explicitement l'utilisateur. */
  has_user_scoped_data_access: boolean;
  findings: ScannerFinding[];
  /**
   * Verdict déterministe quand il ne fait aucun doute, sinon null.
   * `null` = il faut demander son avis au LLM.
   */
  decisive_score: number | null;
  plain_language_summary: string;
}

interface DataAccessSite {
  call: ResolvedCall;
  file: string | null;
  /**
   * Corps de la MÉTHODE QUI CONTIENT cet appel — pas le handler entier.
   *
   * La nuance est un garde-fou anti-faux-négatif. En cherchant le filtre
   * utilisateur dans tout le handler, un `req.user.id` présent pour une simple
   * ligne de log suffirait à faire passer une route vulnérable pour saine.
   * Le filtre doit être là où la requête est écrite : `findOne({ id, userId })`
   * est protégé, `logger.log(req.user.id)` suivi de `findOne({ id })` ne l'est pas.
   */
  enclosingCode: string;
  /** Première ligne (1-indexée, fichier source) de `enclosingCode`. */
  enclosingStartLine: number;
}

/** Parcourt l'arbre en gardant le corps englobant de chaque appel. */
function collectDataAccessSites(
  calls: ResolvedCall[],
  enclosingCode: string,
  enclosingStartLine: number
): DataAccessSite[] {
  const sites: DataAccessSite[] = [];
  for (const call of calls) {
    sites.push({
      call,
      file: call.candidates[0]?.file ?? null,
      enclosingCode,
      enclosingStartLine,
    });
    // Les appels sortants d'une méthode résolue sont englobés par SON corps.
    for (const candidate of call.candidates) {
      sites.push(...collectDataAccessSites(call.resolved_calls, candidate.code_snapshot, candidate.start_line));
    }
    if (call.candidates.length === 0 && call.resolved_calls.length > 0) {
      sites.push(...collectDataAccessSites(call.resolved_calls, enclosingCode, enclosingStartLine));
    }
  }
  return sites;
}

/**
 * Nombre de lignes APRÈS l'appel incluses dans la fenêtre de vérification du
 * filtre — assez pour couvrir un littéral d'objet multi-lignes
 * (`findOne({\n  id,\n  userId,\n})`), pas plus.
 */
const SCOPE_WINDOW_LINES = 4;

/**
 * Bug corrigé (voir NIGHTLY_LOG.md) : `mentionsUserScope` cherchait le champ
 * d'identité dans TOUT le corps de la méthode englobante, pas seulement près
 * de l'appel. Un paramètre `userId` reçu mais jamais branché sur le filtre
 * (oubli très courant) suffisait à faire classer `findOne({ id })` comme
 * protégé — un faux négatif qui court-circuite même le LLM, puisque c'est le
 * chemin de décision déterministe.
 *
 * La fenêtre ne regarde volontairement JAMAIS en arrière : un paramètre de
 * signature ou un log précédent l'appel ne doivent plus compter. Un
 * contrôle d'accès écrit en amont (`if (!owns) throw`) échappe donc à cette
 * détection et fait basculer la route en zone grise plutôt qu'en verdict
 * "sain" — direction sûre : dans le doute, on demande, on ne conclut jamais
 * à tort qu'une route est protégée.
 */
function extractCallWindow(enclosingCode: string, enclosingStartLine: number, callLine: number): string {
  const lines = enclosingCode.split('\n');
  const relativeIndex = callLine - enclosingStartLine;
  // Décalage incohérent (ne devrait pas arriver en usage réel) : repli
  // conservateur, jamais vers le texte complet qui a causé le bug.
  if (relativeIndex < 0 || relativeIndex >= lines.length) return '';
  return lines.slice(relativeIndex, relativeIndex + 1 + SCOPE_WINDOW_LINES).join('\n');
}

/**
 * Retire les commentaires avant toute analyse.
 *
 * Attrapé par un test : la fixture vulnérable portait le commentaire
 * `// aucun filtre userId -> IDOR`. Le mot « userId » y apparaissait, donc la
 * requête était classée « filtrée » — le commentaire qui DÉCRIT la faille la
 * masquait. Un `// TODO: ajouter le userId` dans du vrai code produirait
 * exactement le même faux négatif, et c'est une tournure très courante.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Normalise agressivement : `userId`, `user_id`, `req.user.id` doivent matcher. */
function mentionsUserScope(code: string): boolean {
  const normalized = stripComments(code).toLowerCase().replace(/[^a-z0-9]/g, '');
  return USER_SCOPE_FIELDS.some((field) => normalized.includes(field.replace(/_/g, '')));
}

function isDataAccess(methodName: string): boolean {
  const lower = methodName.toLowerCase();
  return DATA_ACCESS_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Analyse déterministe d'un bundle de contexte. Ne fait aucun appel réseau. */
export function scanForIdor(
  bundle: ContextBundle,
  locale: Locale = DEFAULT_LOCALE
): ScannerReport {
  const endpoint = bundle.endpoint;

  const resourceParams = [...endpoint.route.matchAll(RESOURCE_PARAM)].map((m) => m[1]!);
  const findings: ScannerFinding[] = [];

  const guards = bundle.resolved_guards;
  const hasResolvedGuard = guards.some((g) => g.resolution_status === 'resolved');
  const hasUnresolvedGuard = guards.some((g) => g.resolution_status !== 'resolved');

  // Toutes les requêtes de persistance atteignables depuis ce handler.
  const sites = collectDataAccessSites(bundle.resolved_calls, endpoint.code_snapshot, endpoint.source.start_line);
  let unscoped = false;
  let scoped = false;

  for (const entry of sites) {
    if (!isDataAccess(entry.call.call)) continue;

    // Le filtre se juge sur les lignes qui ÉCRIVENT la requête, pas sur toute
    // la méthode englobante — sinon un `req.user.id` de log, ou un paramètre
    // reçu mais jamais utilisé, masquerait la vulnérabilité (voir NIGHTLY_LOG.md).
    const surroundings = extractCallWindow(entry.enclosingCode, entry.enclosingStartLine, entry.call.line);
    if (mentionsUserScope(surroundings)) {
      scoped = true;
      findings.push({
        kind: 'scoped_data_access',
        detail: `L'appel "${entry.call.call}" croise un identifiant d'utilisateur.`,
        line: entry.call.line,
        file: entry.file,
      });
    } else {
      unscoped = true;
      findings.push({
        kind: 'unscoped_data_access',
        detail: `L'appel "${entry.call.call}" lit ou modifie des données sans aucun filtre d'appartenance à l'utilisateur.`,
        line: entry.call.line,
        file: entry.file,
      });
    }
  }

  const hasNoAttackSurface = resourceParams.length === 0;
  if (hasNoAttackSurface) {
    findings.push({
      kind: 'no_resource_identifier',
      detail: `La route ${endpoint.route} ne contient aucun identifiant de ressource dans son chemin.`,
      line: endpoint.source.start_line,
      file: endpoint.source.file,
    });
  }

  // ---------------------------------------------------------------------
  // Verdict déterministe : uniquement quand il n'y a rien à arbitrer.
  // Dans le doute, on renvoie null et le LLM tranche. Un faux négatif ici
  // masquerait une vraie vulnérabilité — on reste très conservateur.
  // ---------------------------------------------------------------------
  let decisiveScore: number | null = null;

  if (hasNoAttackSurface && !unscoped) {
    // Pas d'identifiant dans l'URL : rien à faire varier pour un attaquant.
    decisiveScore = 0.05;
  } else if (scoped && !unscoped && !hasUnresolvedGuard) {
    // Toutes les requêtes atteignables croisent l'utilisateur, rien d'inconnu.
    decisiveScore = 0.1;
  }

  return {
    resource_params: resourceParams,
    has_no_attack_surface: hasNoAttackSurface,
    has_resolved_guard: hasResolvedGuard,
    has_unresolved_guard: hasUnresolvedGuard,
    has_unscoped_data_access: unscoped,
    has_user_scoped_data_access: scoped,
    findings,
    decisive_score: decisiveScore,
    plain_language_summary: buildScannerSummary({
      route: `${endpoint.http_method.toUpperCase()} ${endpoint.route}`,
      hasNoAttackSurface,
      scoped,
      unscoped,
      hasResolvedGuard,
      hasUnresolvedGuard,
      decisiveScore,
      locale,
    }),
  };
}

function buildScannerSummary(input: {
  route: string;
  hasNoAttackSurface: boolean;
  scoped: boolean;
  unscoped: boolean;
  hasResolvedGuard: boolean;
  hasUnresolvedGuard: boolean;
  decisiveScore: number | null;
  locale: Locale;
}): string {
  const t = messages(input.locale).scanner;
  if (input.decisiveScore !== null && input.hasNoAttackSurface) {
    return t.noAttackSurface(input.route);
  }
  if (input.decisiveScore !== null) return t.userScoped(input.route);
  if (input.unscoped && !input.hasResolvedGuard && !input.hasUnresolvedGuard) {
    return t.unscopedNoGuard(input.route);
  }
  return t.needsReview(input.route);
}
