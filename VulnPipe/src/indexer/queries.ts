/**
 * Requêtes S-expression tree-sitter pour l'indexeur NestJS/TypeScript.
 *
 * Toutes les formes utilisées ici ont été vérifiées contre la sortie réelle de
 * `scripts/probe-treesitter.cjs` et `scripts/probe-shapes.cjs` (voir le
 * commentaire d'en-tête de `indexer.ts`). Ne pas modifier sans relancer les probes.
 */

/**
 * Classes déclarées dans le fichier.
 * Les décorateurs de classe (@Controller('orders')) ne sont PAS des enfants du
 * class_declaration : ce sont des champs `decorator:` de l'export_statement parent
 * (ou des frères directs si la classe n'est pas exportée). On les récupère donc
 * par navigation depuis @class.decl, pas par cette requête.
 */
export const CLASS_QUERY = `
(class_declaration
  name: (type_identifier) @class.name
  body: (class_body) @class.body) @class.decl
`;

/**
 * Méthodes d'une classe, constructeur inclus (on filtre sur le nom côté JS).
 * ATTENTION : les décorateurs de méthode (@Get, @UseGuards) ne sont pas dans le
 * sous-arbre du method_definition — ce sont des frères PRÉCÉDENTS dans le
 * class_body, portés par le champ `decorator:`. Cf. probe #2, section 1.
 */
export const METHOD_QUERY = `
(method_definition
  name: (property_identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.def
`;

/**
 * Paramètres du constructeur porteurs d'un modificateur d'accessibilité
 * (`private orderService: OrderService`) — c'est la forme d'injection de
 * dépendance NestJS. C'est ce qui alimente la symbol table.
 *
 * Forme réelle vérifiée :
 *   required_parameter
 *     ├─ accessibility_modifier  "private"
 *     ├─ pattern: (identifier)   "orderService"
 *     └─ type: (type_annotation) ": OrderService"
 */
export const INJECTED_PARAM_QUERY = `
(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @param.name
  type: (type_annotation (type_identifier) @param.type)) @param.decl
`;

/**
 * TOUT appel de la forme `<objet>.<méthode>(...)`, quelle que soit la
 * profondeur de la chaîne. La classification (injecté / local / non résolu)
 * se fait côté JS en inspectant le noeud `object`, PAS via des queries
 * spécialisées.
 *
 * Pourquoi générique : une query spécialisée
 *   `object: (member_expression object: (this) property: ...)`
 * ne matche QUE `this.x.y()` sur exactement deux niveaux. Elle rate
 * silencieusement `this.db.orders.findOne({ id })` — vérifié : 0 match — qui
 * est pourtant le signal IDOR le plus important à faire remonter (une requête
 * base sans filtre `userId`). Un appel raté ici = une vuln invisible pour tout
 * le reste de la pipeline.
 *
 * Forme réelle vérifiée :
 *   call_expression
 *     function: member_expression
 *       object:   <n'importe quelle expression>   ("this", "this.db.orders", ...)
 *       property: property_identifier             "findOne"
 */
export const MEMBER_CALL_QUERY = `
(call_expression
  function: (member_expression
    property: (property_identifier) @call.method)) @call.expr
`;

/**
 * Appels de fonction libre `helper(...)` (import ou fonction du module).
 * Non résolus en Phase 1 : la résolution cross-fichier est le rôle du serveur
 * MCP en Phase 2.
 */
export const FREE_CALL_QUERY = `
(call_expression
  function: (identifier) @call.method) @call.expr
`;
