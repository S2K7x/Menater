/**
 * Resolver — transforme un `local_call_graph` (noms d'appels) en contexte de
 * code réel, en traversant les fichiers.
 *
 * C'est la brique qui répond au trou laissé ouvert par la Phase 1 : l'indexeur
 * sait que `getOrder` appelle `OrderService.findById`, mais pas ce que
 * `findById` fait. Sans le corps de `findById`, aucun verdict IDOR n'est
 * possible — on ne peut pas savoir si la requête filtre par `userId`.
 *
 * Écarts assumés par rapport à PHASE_2_MCP_SERVER.md — voir ROADMAP.md :
 *  1. Résolution des GUARDS en plus des appels (le guard décide du verdict).
 *  2. Protection contre les cycles (la spec décrit une récursion sans garde).
 *  3. Budget d'octets (promesse "low-cost" de CLAUDE.md §1).
 *  4. `reason` mappé sur missing_context / ambiguous_logic (CLAUDE.md §3).
 *  5. `plain_language_summary` (CLAUDE.md §4, non négociable).
 */

import type { CallGraphEntry, ClassDefinition, Endpoint, MethodDefinition } from '../indexer/indexer.ts';
import { findEndpoint, type IndexedEndpoint, type RepoIndex } from './repo-index.ts';

/** Vocabulaire imposé par la spec de la Phase 2. */
export type ResolutionStatus = 'resolved' | 'ambiguous' | 'not_found';

/**
 * Nature du doute — CLAUDE.md §3. Le node de détection s'en sert pour choisir
 * entre « redemander du contexte au MCP » et « escalader vers Claude ».
 */
export type DoubtReason = 'missing_context' | 'ambiguous_logic' | null;

export interface Candidate {
  class_name: string;
  file: string;
  method: string;
  code_snapshot: string;
  start_line: number;
  end_line: number;
}

export interface ResolvedCall {
  call: string;
  injected_type: string | null;
  receiver: string | null;
  line: number;
  resolution_status: ResolutionStatus;
  reason: DoubtReason;
  candidates: Candidate[];
  /** Appels sortants du corps résolu — peuplé tant que depth le permet. */
  resolved_calls: ResolvedCall[];
  /**
   * true si le corps a déjà été développé ailleurs dans cette réponse (cycle
   * ou appel répété). Les candidats sont fournis, la récursion est coupée.
   */
  already_expanded: boolean;
}

export interface ResolvedGuard {
  guard: string;
  resolution_status: ResolutionStatus;
  reason: DoubtReason;
  candidates: Candidate[];
  resolved_calls: ResolvedCall[];
}

export interface ContextBudget {
  bytes_used: number;
  bytes_limit: number;
  /** true si du code a été coupé : le verdict doit en tenir compte. */
  truncated: boolean;
}

export interface ContextBundle {
  endpoint: Endpoint;
  controller: string;
  depth: number;
  /** Corps des guards d'autorisation — absent de la spec, décisif pour l'IDOR. */
  resolved_guards: ResolvedGuard[];
  resolved_calls: ResolvedCall[];
  budget: ContextBudget;
  /** Nature globale du doute résiduel, ou null si tout est résolu. */
  reason: DoubtReason;
  /** CLAUDE.md §4 — jamais de JSON brut vers l'utilisateur. */
  plain_language_summary: string;
}

/** Budget par défaut, en octets de code source renvoyé. */
export const DEFAULT_BYTE_BUDGET = 24_000;
export const DEFAULT_DEPTH = 2;
/** Garde-fou dur : au-delà, la récursion coûte plus qu'elle n'apporte. */
export const MAX_DEPTH = 5;

interface ResolutionState {
  index: RepoIndex;
  budget: ContextBudget;
  /**
   * Chemin de récursion COURANT (`Classe::méthode`), pas un historique global.
   *
   * La distinction est subtile et un jeu de tests l'a attrapée : avec un set
   * global, le guard `OwnershipGuard.canActivate` résout `OrderService.findById`
   * en premier, marque le symbole comme vu, et la branche principale
   * (`getOrder -> findById`) se retrouve amputée de sa descente — on perdait
   * la requête base non filtrée, donc le signal IDOR lui-même.
   *
   * Un cycle, c'est un symbole présent dans le chemin en cours. Deux branches
   * qui touchent le même symbole, ce n'est pas un cycle.
   */
  path: Set<string>;
  /**
   * Snapshots déjà facturés au budget. Deux branches qui montrent le même
   * corps ne le paient qu'une fois : le coût réel côté LLM, c'est le volume
   * de code distinct.
   */
  charged: Set<string>;
}

/** Cherche les définitions d'une méthode sur une classe nommée. */
function lookupMethod(
  index: RepoIndex,
  className: string,
  methodName: string
): Array<{ definition: ClassDefinition; method: MethodDefinition }> {
  const definitions = index.classes.get(className) ?? [];
  const found: Array<{ definition: ClassDefinition; method: MethodDefinition }> = [];
  for (const definition of definitions) {
    for (const method of definition.methods) {
      if (method.name === methodName) found.push({ definition, method });
    }
  }
  return found;
}

/**
 * Ajoute un snapshot au budget. Renvoie le texte, tronqué si le budget est
 * dépassé — on ne renvoie jamais silencieusement du code coupé sans le dire.
 */
function spend(state: ResolutionState, symbolKey: string, snapshot: string): string {
  // Déjà facturé sur une autre branche : on le remontre sans le repayer.
  if (state.charged.has(symbolKey)) return snapshot;
  state.charged.add(symbolKey);

  const remaining = state.budget.bytes_limit - state.budget.bytes_used;
  if (remaining <= 0) {
    state.budget.truncated = true;
    return '/* … code omis : budget de contexte atteint … */';
  }
  if (snapshot.length > remaining) {
    state.budget.bytes_used = state.budget.bytes_limit;
    state.budget.truncated = true;
    return snapshot.slice(0, remaining) + '\n/* … tronqué : budget de contexte atteint … */';
  }
  state.budget.bytes_used += snapshot.length;
  return snapshot;
}

function toCandidate(
  state: ResolutionState,
  definition: ClassDefinition,
  method: MethodDefinition
): Candidate {
  return {
    class_name: definition.name,
    file: definition.file,
    method: method.name,
    code_snapshot: spend(state, `${definition.file}::${definition.name}::${method.name}`, method.code_snapshot),
    start_line: method.start_line,
    end_line: method.end_line,
  };
}

/**
 * Résout un appel unique.
 *
 * `containingClass` sert aux appels `this.doThing()` : la cible est une méthode
 * de la classe appelante elle-même, pas d'un service injecté.
 */
function resolveCall(
  state: ResolutionState,
  entry: CallGraphEntry,
  containingClass: string | null,
  remainingDepth: number
): ResolvedCall {
  const base = {
    call: entry.call,
    injected_type: entry.injected_type,
    receiver: entry.receiver,
    line: entry.line,
  };

  // Quelle classe est censée porter cette méthode ?
  const targetClass =
    entry.resolution === 'constructor_injection'
      ? entry.injected_type
      : entry.resolution === 'local_method'
        ? containingClass
        : null;

  if (!targetClass) {
    // `this.db.orders.findOne()`, `helper()` : la cible est hors du graphe
    // typé qu'on sait construire. C'est un manque de contexte, pas une
    // ambiguïté de jugement.
    return {
      ...base,
      resolution_status: 'not_found',
      reason: 'missing_context',
      candidates: [],
      resolved_calls: [],
      already_expanded: false,
    };
  }

  const found = lookupMethod(state.index, targetClass, entry.call);

  if (found.length === 0) {
    return {
      ...base,
      resolution_status: 'not_found',
      reason: 'missing_context',
      candidates: [],
      resolved_calls: [],
      already_expanded: false,
    };
  }

  // Plusieurs définitions pour le même (classe, méthode) : deux classes
  // homonymes dans le repo. On expose les candidats, on ne devine pas.
  if (found.length > 1) {
    return {
      ...base,
      resolution_status: 'ambiguous',
      reason: 'ambiguous_logic',
      candidates: found.map(({ definition, method }) => toCandidate(state, definition, method)),
      resolved_calls: [],
      already_expanded: false,
    };
  }

  const { definition, method } = found[0]!;
  const symbolKey = `${definition.name}::${method.name}`;

  // Cycle : le symbole est déjà dans le chemin de récursion courant.
  // Sans ça, `A.f -> B.g -> A.f` boucle jusqu'au stack overflow.
  // On garde le code (il reste utile au verdict), on coupe la descente.
  if (state.path.has(symbolKey)) {
    return {
      ...base,
      resolution_status: 'resolved',
      reason: null,
      candidates: [toCandidate(state, definition, method)],
      resolved_calls: [],
      already_expanded: true,
    };
  }

  const candidate = toCandidate(state, definition, method);

  state.path.add(symbolKey);
  const nested =
    remainingDepth > 1 && !state.budget.truncated
      ? method.call_graph.map((child) => resolveCall(state, child, definition.name, remainingDepth - 1))
      : [];
  state.path.delete(symbolKey); // on sort de cette branche

  return {
    ...base,
    resolution_status: 'resolved',
    reason: null,
    candidates: [candidate],
    resolved_calls: nested,
    already_expanded: false,
  };
}

/**
 * Résout le corps d'un guard depuis son nom de décorateur.
 *
 * `@UseGuards(OwnershipGuard)` n'est pas un appel : il n'apparaît jamais dans
 * `local_call_graph`. Un resolver qui suit la spec à la lettre ne va donc
 * jamais lire `ownership.guard.ts` — et le node IDOR de la Phase 3 devient
 * incapable de distinguer une route protégée d'une route qui ne l'est pas.
 */
function resolveGuard(state: ResolutionState, guardName: string, remainingDepth: number): ResolvedGuard {
  const definitions = state.index.classes.get(guardName) ?? [];

  if (definitions.length === 0) {
    return {
      guard: guardName,
      resolution_status: 'not_found',
      reason: 'missing_context',
      candidates: [],
      resolved_calls: [],
    };
  }

  if (definitions.length > 1) {
    return {
      guard: guardName,
      resolution_status: 'ambiguous',
      reason: 'ambiguous_logic',
      candidates: definitions.flatMap((definition) =>
        definition.methods.map((method) => toCandidate(state, definition, method))
      ),
      resolved_calls: [],
    };
  }

  const definition = definitions[0]!;
  // La logique d'autorisation vit dans canActivate (NestJS) ; à défaut on
  // renvoie toutes les méthodes plutôt que rien.
  const decisionMethods = definition.methods.filter((m) => m.name === 'canActivate');
  const methods = decisionMethods.length > 0 ? decisionMethods : definition.methods;

  const candidates = methods.map((method) => toCandidate(state, definition, method));

  const nested =
    remainingDepth > 1 && !state.budget.truncated
      ? methods.flatMap((method) =>
          method.call_graph.map((child) => resolveCall(state, child, definition.name, remainingDepth - 1))
        )
      : [];

  return {
    guard: guardName,
    resolution_status: 'resolved',
    reason: null,
    candidates,
    resolved_calls: nested,
  };
}

/** Extrait les noms de classes guard depuis `@UseGuards(A, B)`. */
export function guardClassNames(endpoint: Endpoint): string[] {
  const names: string[] = [];
  for (const decorator of endpoint.framework_metadata.decorators) {
    const match = /^@(?:UseGuards|Roles|Auth|RequirePermissions)\(([^)]*)\)/.exec(decorator);
    if (!match) continue;
    for (const raw of match[1]!.split(',')) {
      const name = raw.trim().replace(/^new\s+/, '').replace(/\(.*$/, '');
      // On ne garde que les identifiants de classe (majuscule initiale) :
      // `@Roles('admin')` porte une string, pas une classe à résoudre.
      if (name && /^[A-Z]/.test(name)) names.push(name);
    }
  }
  return [...new Set(names)];
}

/** Parcourt l'arbre résolu pour agréger le doute résiduel. */
function collectReasons(calls: ResolvedCall[]): DoubtReason[] {
  return calls.flatMap((call) => [call.reason, ...collectReasons(call.resolved_calls)]);
}

function buildSummary(
  endpoint: Endpoint,
  guards: ResolvedGuard[],
  calls: ResolvedCall[],
  budget: ContextBudget
): string {
  const sentences: string[] = [];

  sentences.push(
    `Pour la route ${endpoint.http_method.toUpperCase()} ${endpoint.route} (fonction « ${endpoint.handler} »), j'ai rassemblé le code que cette route exécute réellement.`
  );

  const resolvedGuards = guards.filter((g) => g.resolution_status === 'resolved');
  if (guards.length === 0) {
    sentences.push(
      "Cette route n'a aucun contrôle d'accès déclaré : n'importe quel appelant peut l'atteindre, il n'y a pas de vérification en amont du code."
    );
  } else if (resolvedGuards.length === guards.length) {
    sentences.push(
      `Elle est protégée par ${guards.map((g) => `« ${g.guard} »`).join(' et ')}, et j'ai récupéré le code de cette protection pour pouvoir vérifier ce qu'elle contrôle vraiment.`
    );
  } else {
    const missing = guards.filter((g) => g.resolution_status !== 'resolved').map((g) => g.guard);
    sentences.push(
      `Elle déclare une protection (${missing.map((g) => `« ${g} »`).join(', ')}) dont je n'ai pas retrouvé le code : impossible de confirmer qu'elle protège réellement quelque chose.`
    );
  }

  const flat = [...calls, ...calls.flatMap((c) => c.resolved_calls)];
  const resolvedCount = flat.filter((c) => c.resolution_status === 'resolved').length;
  const notFound = flat.filter((c) => c.resolution_status === 'not_found');
  const ambiguous = flat.filter((c) => c.resolution_status === 'ambiguous');

  sentences.push(
    `Sur ${flat.length} appel(s) de fonction repérés, j'ai retrouvé le code source de ${resolvedCount} d'entre eux.`
  );

  if (ambiguous.length > 0) {
    sentences.push(
      `${ambiguous.length} appel(s) correspondent à plusieurs fonctions portant le même nom dans le projet : je ne devine pas laquelle est utilisée, les deux versions sont fournies.`
    );
  }
  if (notFound.length > 0) {
    const names = [...new Set(notFound.map((c) => c.call))].slice(0, 3);
    sentences.push(
      `${notFound.length} appel(s) pointent vers du code que je n'ai pas pu lire (${names.join(', ')}) — typiquement une bibliothèque externe ou un accès direct à la base de données.`
    );
  }
  if (budget.truncated) {
    sentences.push(
      "Le volume de code dépassait la limite fixée pour maîtriser le coût d'analyse : une partie a été coupée, l'analyse porte donc sur un extrait."
    );
  }

  return sentences.join(' ');
}

export interface ResolveOptions {
  route: string;
  httpMethod?: string;
  depth?: number;
  byteBudget?: number;
}

export class ContextResolutionError extends Error {
  // Champ déclaré + assigné explicitement : les "parameter properties"
  // TypeScript (`constructor(readonly x: string)`) ne passent PAS le
  // strip-only mode de Node — elles exigent une vraie transpilation. Vitest
  // les acceptait, le CLI plantait au démarrage.
  readonly plainLanguageSummary: string;

  constructor(message: string, plainLanguageSummary: string) {
    super(message);
    this.name = 'ContextResolutionError';
    this.plainLanguageSummary = plainLanguageSummary;
  }
}

/** Point d'entrée : produit le bundle de contexte pour une route. */
export function resolveContext(index: RepoIndex, options: ResolveOptions): ContextBundle {
  const depth = Math.min(Math.max(options.depth ?? DEFAULT_DEPTH, 1), MAX_DEPTH);
  const { match, collisions } = findEndpoint(index, options.route, options.httpMethod);

  if (!match) {
    if (collisions.length > 1) {
      const verbs = collisions.map((c) => c.endpoint.http_method.toUpperCase()).join(', ');
      throw new ContextResolutionError(
        `Route "${options.route}" ambiguë : ${collisions.length} endpoints (${verbs}). Précise http_method.`,
        `La route ${options.route} existe pour plusieurs méthodes HTTP (${verbs}). Chacune fait un travail différent et doit être analysée séparément : précise laquelle tu veux examiner.`
      );
    }
    const available = index.endpoints
      .map((e) => `${e.endpoint.http_method.toUpperCase()} ${e.endpoint.route}`)
      .slice(0, 10);
    throw new ContextResolutionError(
      `Route "${options.route}" introuvable. Routes connues : ${available.join(', ') || '(aucune)'}`,
      `Je ne trouve aucune route « ${options.route} » dans le code indexé. Vérifie l'orthographe, ou lance d'abord l'indexation du projet.`
    );
  }

  const state: ResolutionState = {
    index,
    budget: {
      bytes_used: 0,
      bytes_limit: options.byteBudget ?? DEFAULT_BYTE_BUDGET,
      truncated: false,
    },
    path: new Set(),
    charged: new Set(),
  };

  const { endpoint, controller } = match as IndexedEndpoint;

  const resolvedGuards = guardClassNames(endpoint).map((name) => resolveGuard(state, name, depth));
  const resolvedCalls = endpoint.local_call_graph.map((entry) =>
    resolveCall(state, entry, controller.controller, depth)
  );

  const reasons = [...collectReasons(resolvedCalls), ...resolvedGuards.map((g) => g.reason)];
  const reason: DoubtReason = reasons.includes('ambiguous_logic')
    ? 'ambiguous_logic'
    : reasons.includes('missing_context')
      ? 'missing_context'
      : null;

  return {
    endpoint,
    controller: controller.controller,
    depth,
    resolved_guards: resolvedGuards,
    resolved_calls: resolvedCalls,
    budget: state.budget,
    reason,
    plain_language_summary: buildSummary(endpoint, resolvedGuards, resolvedCalls, state.budget),
  };
}
