/**
 * Références de valeurs et conditions — ce qui remplace le langage d'expression.
 *
 * ============================================================================
 * CE QUE LES WORKFLOWS n8n FAISAIENT RÉELLEMENT
 *
 * Les 168 `={{ … }}` faisaient peur sur le papier. En les comptant, la réalité
 * est bien plus étroite :
 *
 *   - 15 × `$now.toISO()`, 15 × `$execution.id`, 3 × `$execution.resumeUrl` :
 *     du CONTEXTE, pas du calcul ;
 *   - le reste : des lectures de champ (`$json.payload_ok`) et quelques
 *     constantes (`true`, `500`, `null`) ;
 *   - et surtout : **les 22 conditions des `if`/`switch` testent toutes un
 *     booléen déjà calculé** par un nœud `code` en amont.
 *
 * Autrement dit, personne n'avait besoin d'un langage de programmation dans
 * ses paramètres. Quatre formes de référence suffisent, et elles se rendent
 * toutes dans un formulaire.
 *
 * ============================================================================
 * DEUX DÉFENSES QUI NE SE VOIENT PAS À LA RELECTURE
 *
 *  1. LES CHEMINS NE TRAVERSENT PAS LE PROTOTYPE. `__proto__`, `constructor`
 *     et `prototype` sont refusés. Sans ça, une définition de workflow — qui
 *     est de la donnée, éditable depuis l'interface — pourrait polluer le
 *     prototype d'Object et changer le comportement de tout le processus.
 *
 *  2. UNE RÉFÉRENCE QUI NE RÉSOUT PAS VAUT `undefined`, ET SE VOIT.
 *     Elle ne vaut pas `null`, pas `''`, pas `0`. « Ne jamais combler un trou
 *     par une valeur par défaut » s'applique ici aussi : un seuil dont la
 *     variable a été supprimée doit faire échouer le nœud, pas le faire
 *     silencieusement comparer à zéro.
 * ============================================================================
 */

/** Segments interdits dans un chemin. Voir la défense 1. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export class PathError extends Error {}

/**
 * Découpe et valide un chemin pointé : `decision.confidence`, `items.0.name`.
 *
 * La validation se fait à la PUBLICATION du workflow autant qu'à la lecture :
 * un chemin fautif doit être refusé quand quelqu'un l'écrit, pas trois
 * semaines plus tard au milieu d'une alerte critique.
 */
export function parsePath(path: string): string[] {
  if (path === '') return [];
  const segments = path.split('.');
  for (const segment of segments) {
    if (segment === '') throw new PathError(`Chemin « ${path} » : segment vide.`);
    if (FORBIDDEN.has(segment)) {
      throw new PathError(
        `Path \u201c${path}\u201d: \u201c${segment}\u201d is forbidden. A workflow ` +
          `definition is editable data; letting it reach the ` +
          `prototype changerait le comportement de tout le processus.`,
      );
    }
  }
  return segments;
}

/** Lit un chemin dans une valeur. `undefined` si le chemin ne mène nulle part. */
export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of parsePath(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    // `Object.hasOwn` plutôt qu'un accès direct : `{}.toString` existe et
    // renverrait une fonction là où on attend une donnée.
    if (!Object.hasOwn(current as object, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * D'où une valeur de paramètre peut venir.
 *
 * `var` est celle qui compte pour l'utilisateur : c'est par elle qu'un seuil
 * devient modifiable depuis l'onglet Réglages au lieu d'être enterré dans un
 * `docker-compose` qu'il faut redémarrer.
 */
export type ValueRef =
  | { kind: 'const'; value: unknown }
  /** Un champ de l'entrée du nœud. */
  | { kind: 'input'; path: string }
  /** Un champ de la sortie d'un nœud amont, désigné par son IDENTIFIANT. */
  | { kind: 'node'; nodeId: string; path: string }
  /** Une variable de pipeline, éditable dans l'interface. */
  | { kind: 'var'; key: string }
  /** Une valeur fournie par le moteur. Remplace `$now`, `$execution.id`… */
  | { kind: 'ctx'; field: CtxField };

export type CtxField = 'now' | 'runId' | 'alertId' | 'resumeUrl' | 'workflowId';

export interface ResolveScope {
  input: unknown;
  outputs: ReadonlyMap<string, unknown>;
  vars: ReadonlyMap<string, unknown>;
  ctx: Partial<Record<CtxField, unknown>>;
}

export class ResolveError extends Error {}

/** Résout une référence. Lève si elle désigne quelque chose qui n'existe pas. */
export function resolve(ref: ValueRef, scope: ResolveScope): unknown {
  switch (ref.kind) {
    case 'const':
      return ref.value;
    case 'input':
      return readPath(scope.input, ref.path);
    case 'node': {
      if (!scope.outputs.has(ref.nodeId)) {
        // Un nœud aval qui lit un nœud jamais exécuté est un défaut de câblage,
        // pas une donnée absente. Le dire ainsi évite de chercher côté données.
        throw new ResolveError(
          `Node \u201c${ref.nodeId}\u201d produced no output: it did not run ` +
            `before this one.`,
        );
      }
      return readPath(scope.outputs.get(ref.nodeId), ref.path);
    }
    case 'var': {
      if (!scope.vars.has(ref.key)) {
        throw new ResolveError(
          `Variable \u201c${ref.key}\u201d does not exist. A default invented ` +
            `here would go unnoticed until the next alert.`,
        );
      }
      return scope.vars.get(ref.key);
    }
    case 'ctx': {
      if (!(ref.field in scope.ctx)) {
        throw new ResolveError(`Le contexte ne fournit pas « ${ref.field} » ici.`);
      }
      return scope.ctx[ref.field];
    }
  }
}

// --- Conditions ---------------------------------------------------------------

/**
 * Opérateurs disponibles.
 *
 * LISTE VOLONTAIREMENT COURTE. Les workflows existants n'utilisent qu'un test
 * booléen ; le reste est là pour ce que l'interface doit permettre de régler —
 * un seuil de confiance, une sévérité dans une liste. Pas de correspondance
 * par expression régulière : une expression fournie depuis l'interface est une
 * porte ouverte au déni de service par retour arrière catastrophique, pour un
 * besoin que personne n'a exprimé.
 */
export type Op =
  | 'isTrue' | 'isFalse'
  | 'exists' | 'missing'
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'notIn'
  | 'contains';

export interface Condition {
  left: ValueRef;
  op: Op;
  /** Absent pour les opérateurs unaires (`isTrue`, `exists`…). */
  right?: ValueRef;
}

export class ConditionError extends Error {}

/** Compare deux nombres, en refusant de deviner. */
function numeric(op: Op, left: unknown, right: unknown): boolean {
  if (typeof left !== 'number' || typeof right !== 'number') {
    // `'10' > 9` vaut `true` en JavaScript et `'9' > '10'` aussi : comparer des
    // chaînes comme des nombres produit des décisions fausses SANS erreur.
    throw new ConditionError(
      `\u201c${op}\u201d expects two numbers, got ${typeof left} and ${typeof right}.`,
    );
  }
  switch (op) {
    case 'gt': return left > right;
    case 'gte': return left >= right;
    case 'lt': return left < right;
    default: return left <= right;
  }
}

export function evaluate(condition: Condition, scope: ResolveScope): boolean {
  const left = resolve(condition.left, scope);

  switch (condition.op) {
    case 'isTrue': return left === true;
    case 'isFalse': return left === false;
    case 'exists': return left !== undefined && left !== null;
    case 'missing': return left === undefined || left === null;
    default: break;
  }

  if (!condition.right) {
    throw new ConditionError(`« ${condition.op} » attend une valeur de droite.`);
  }
  const right = resolve(condition.right, scope);

  switch (condition.op) {
    // Égalité STRICTE : `0 == ''` et `null == undefined` valent `true` en
    // JavaScript, et une console de triage ne peut pas se le permettre.
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return numeric(condition.op, left, right);
    case 'in':
    case 'notIn': {
      if (!Array.isArray(right)) {
        throw new ConditionError(`\u201c${condition.op}\u201d expects a list on the right.`);
      }
      const found = right.includes(left);
      return condition.op === 'in' ? found : !found;
    }
    case 'contains': {
      if (Array.isArray(left)) return left.includes(right);
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
      throw new ConditionError(
        `\u201ccontains\u201d expects a list or two strings, got ${typeof left}.`,
      );
    }
    default:
      throw new ConditionError(`Unknown operator: ${String(condition.op)}.`);
  }
}

/**
 * Vérifie une condition SANS l'exécuter, à la publication du workflow.
 *
 * Un opérateur binaire sans valeur de droite, un chemin qui traverse le
 * prototype : autant de choses qui doivent être refusées quand quelqu'un les
 * écrit dans le formulaire, pas découvertes au milieu d'une alerte.
 */
export function validateCondition(condition: Condition): void {
  const unary = ['isTrue', 'isFalse', 'exists', 'missing'];
  if (!unary.includes(condition.op) && !condition.right) {
    throw new ConditionError(`« ${condition.op} » attend une valeur de droite.`);
  }
  for (const ref of [condition.left, condition.right]) {
    if (ref && (ref.kind === 'input' || ref.kind === 'node')) parsePath(ref.path);
  }
}
