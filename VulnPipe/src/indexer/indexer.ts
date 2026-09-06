/**
 * VulnPipe — Indexeur Tree-sitter (Phase 1)
 * ============================================================================
 *
 * SORTIE RÉELLE DES PROBES — NE PAS SUPPOSER, C'EST VÉRIFIÉ.
 * Reproductible via `node scripts/probe-treesitter.cjs` et
 * `node scripts/probe-shapes.cjs`. Toute session future qui touche à ce
 * fichier doit relancer ces deux scripts si les versions changent.
 *
 * --- Versions sur lesquelles ce code a été construit -----------------------
 *   node                   : v26.5.0
 *   tree-sitter            : 0.21.1   (binding NATIF, pas web-tree-sitter/WASM)
 *   tree-sitter-typescript : 0.23.2
 *
 * --- Forme réelle de Query.matches() --------------------------------------
 *   typeof Parser.Query        : function        (exporté sur le module `tree-sitter`)
 *   query.matches(node)        : Array           (pas un itérateur, pas un générateur)
 *   Object.keys(matches[0])    : [ 'pattern', 'captures' ]
 *   matches[0].pattern         : 0               (index numérique du pattern)
 *   typeof matches[0].captures : Array
 *   Object.keys(captures[0])   : [ 'name', 'node' ]
 *   captures[0].name           : "class.name"    (SANS le "@" initial)
 *   captures[0].node.type      : "type_identifier"
 *   captures[0].node.text      : "OrderController"
 *   captures[0].node.startPosition : { row: 2, column: 13 }   (row 0-indexé)
 *   query.captures(node)       : Array de { name, node }  (vue à plat)
 *
 * --- Pièges structurels confirmés par le probe #2 -------------------------
 *
 * 1) LES DÉCORATEURS DE MÉTHODE NE SONT PAS DANS LE method_definition.
 *    Ce sont des frères PRÉCÉDENTS dans le class_body. Dump réel :
 *      [0] {                  field=undefined
 *      [1] method_definition  field=undefined   "constructor("
 *      [2] decorator          field=decorator   "@UseGuards(OwnershipGuard)"
 *      [3] decorator          field=decorator   "@Get('/:id')"
 *      [4] method_definition  field=undefined   "async getOrder(...)"
 *      [5] decorator          field=decorator   "@Get('/public/:id')"
 *      [6] method_definition  field=undefined   "async getPublicOrder(...)"
 *      [7] }                  field=undefined
 *    => on remonte les frères vers l'arrière depuis le method_definition.
 *
 * 2) Le décorateur de CLASSE (@Controller) est porté par l'export_statement :
 *      (export_statement decorator: (decorator ...) declaration: (class_declaration ...))
 *
 * 3) Paramètre injecté NestJS — forme réelle :
 *      required_parameter
 *        child[0] accessibility_modifier             "private"
 *        child[1] identifier        field=pattern    "orderService"
 *        child[2] type_annotation   field=type       ": OrderService"
 *
 * 4) `this.orderService.findById(id)` — forme réelle :
 *      call_expression
 *        function: member_expression
 *          object:   member_expression { object: (this), property: "orderService" }
 *          property: property_identifier "findById"
 *
 * 5) Un décorateur est toujours `decorator > call_expression` quand il a des
 *    arguments : `@Get('/:id')` -> fn="Get", args.namedChildren=[["string","'/:id'"]].
 *    `@Injectable` sans parenthèses donne `decorator > identifier`.
 *
 * 6) La valeur d'un littéral string se lit via son enfant `string_fragment`
 *    ("'/:id'" -> "/:id"). Le `.text` brut contient les quotes.
 *
 * 7) Les décorateurs de PARAMÈTRE (@Param, @Req) sont bien dans le sous-arbre
 *    du method_definition — il ne faut donc PAS les compter comme décorateurs
 *    de route. On ne collecte que les frères du class_body (piège n°1), ce qui
 *    les exclut naturellement.
 * ============================================================================
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  CLASS_QUERY,
  METHOD_QUERY,
  INJECTED_PARAM_QUERY,
  MEMBER_CALL_QUERY,
  FREE_CALL_QUERY,
} from './queries.ts';

// tree-sitter et sa grammaire sont des addons natifs CommonJS : pas d'import ESM.
const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const TypeScript = require('tree-sitter-typescript');

const { Query } = Parser;

// ---------------------------------------------------------------------------
// Types du contrat de sortie
// ---------------------------------------------------------------------------

/** Comment le lien appel -> type a été établi. Consommé par les nodes de détection. */
export type CallResolution =
  | 'constructor_injection' // this.orderService.findById() avec orderService: OrderService
  | 'local_method' // this.doSomething() — méthode du contrôleur lui-même
  | 'unresolved'; // this.foo.bar() sans foo dans le constructeur, ou appel libre

export interface CallGraphEntry {
  /** Nom de la méthode appelée. */
  call: string;
  /** Classe du type injecté, ou null si non résolu (cf. CLAUDE.md §3). */
  injected_type: string | null;
  /** Nom de la propriété receveuse (`orderService` dans `this.orderService.x()`). */
  receiver: string | null;
  resolution: CallResolution;
  /** Ligne 1-indexée dans le fichier source. */
  line: number;
}

export interface Endpoint {
  route: string;
  http_method: string;
  handler: string;
  framework_metadata: {
    /** Décorateurs de la méthode, texte source exact, dans l'ordre d'écriture. */
    decorators: string[];
    /** Sous-ensemble des décorateurs considérés comme guards d'autorisation. */
    guards: string[];
    /** true si aucun guard n'est présent au niveau route NI au niveau contrôleur. */
    is_unguarded: boolean;
  };
  local_call_graph: CallGraphEntry[];
  code_snapshot: string;
  source: { file: string; start_line: number; end_line: number };
}

/**
 * Symbol table indexée par `(classe_du_type_injecté, méthode)` — décision
 * d'archi CLAUDE.md §3 : la clé n'est PAS le nom de méthode seul, pour éviter
 * les collisions entre deux `findById` de services différents.
 */
export interface SymbolTableEntry {
  key: string; // "OrderService::findById"
  injected_type: string;
  method: string;
  /** Handlers de ce fichier qui appellent ce symbole. */
  called_from: string[];
}

export interface ControllerIndex {
  controller: string;
  /** Préfixe issu de @Controller('orders'), normalisé en "/orders". */
  base_path: string;
  /** Décorateurs portés par la classe elle-même. */
  controller_decorators: string[];
  /** Propriété -> classe injectée, extrait du constructeur. */
  injection_map: Record<string, string>;
  endpoints: Endpoint[];
  symbol_table: SymbolTableEntry[];
  /** Zones où l'indexeur sait qu'il est incomplet — lu par les nodes de détection. */
  index_warnings: string[];
}

/**
 * Une méthode de n'importe quelle classe (service, repository, guard...).
 * C'est ce que le serveur MCP (Phase 2) renvoie comme `code_snapshot` résolu.
 */
export interface MethodDefinition {
  name: string;
  /** Texte source exact de la méthode. */
  code_snapshot: string;
  start_line: number;
  end_line: number;
  is_async: boolean;
  /** Appels sortants — permet la résolution récursive à depth > 1. */
  call_graph: CallGraphEntry[];
}

/**
 * Définition d'une classe quelconque.
 *
 * AJOUT PAR RAPPORT À LA SPEC PHASE 2 : la spec dit « résoudre via la symbol
 * table construite en Phase 1 », mais la Phase 1 n'indexait que les classes
 * décorées @Controller. La symbol table ne contient que des SITES D'APPEL
 * (`OrderService::findById` est appelé ici), jamais la DÉFINITION de
 * `OrderService`. Sans cet index des classes, le resolver de la Phase 2 n'a
 * tout simplement rien à résoudre.
 */
export interface ClassDefinition {
  name: string;
  file: string;
  is_controller: boolean;
  decorators: string[];
  /** Propriété -> classe injectée, pour résoudre les appels sortants. */
  injection_map: Record<string, string>;
  methods: MethodDefinition[];
  start_line: number;
  end_line: number;
}

export interface FileIndex {
  file: string;
  controllers: ControllerIndex[];
  /** TOUTES les classes du fichier, contrôleurs inclus. Consommé par le MCP. */
  classes: ClassDefinition[];
  index_warnings: string[];
}

// ---------------------------------------------------------------------------
// Constantes framework
// ---------------------------------------------------------------------------

const HTTP_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All']);

/**
 * Décorateurs traités comme des guards d'autorisation. Volontairement
 * conservateur : un faux négatif ici remonte au node IDOR qui tranchera,
 * un faux positif masquerait une vraie vuln.
 */
const GUARD_DECORATORS = new Set(['UseGuards', 'Roles', 'RequirePermissions', 'Auth', 'UseInterceptors']);

// ---------------------------------------------------------------------------
// Helpers tree-sitter (tous adossés aux formes vérifiées par les probes)
// ---------------------------------------------------------------------------

type TSNode = any; // le binding natif n'expose pas de typings

function runQuery(source: string, root: TSNode): Array<{ pattern: number; captures: Array<{ name: string; node: TSNode }> }> {
  return new Query(TypeScript.typescript, source).matches(root);
}

/** Récupère le premier noeud capturé sous un nom donné dans un match. */
function capture(match: { captures: Array<{ name: string; node: TSNode }> }, name: string): TSNode | null {
  return match.captures.find((c) => c.name === name)?.node ?? null;
}

/** Valeur d'un littéral string sans les quotes, via son `string_fragment` (piège n°6). */
function stringValue(node: TSNode | null): string | null {
  if (!node) return null;
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  const fragment = node.namedChildren.find((c: TSNode) => c.type === 'string_fragment');
  return fragment ? fragment.text : '';
}

/** Nom d'un décorateur : `@Get('/:id')` -> "Get", `@Injectable` -> "Injectable". */
function decoratorName(decoratorNode: TSNode): string | null {
  const inner = decoratorNode.namedChildren[0];
  if (!inner) return null;
  if (inner.type === 'call_expression') return inner.childForFieldName('function')?.text ?? null;
  return inner.text ?? null;
}

/** Arguments nommés d'un décorateur, ou [] s'il n'est pas appelé. */
function decoratorArgs(decoratorNode: TSNode): TSNode[] {
  const inner = decoratorNode.namedChildren[0];
  if (!inner || inner.type !== 'call_expression') return [];
  return inner.childForFieldName('arguments')?.namedChildren ?? [];
}

/**
 * Décorateurs attachés à un noeud, lus sur ses frères PRÉCÉDENTS (piège n°1).
 * On s'arrête au premier frère qui n'est pas un décorateur. Retourné dans
 * l'ordre d'écriture du code.
 */
function precedingDecorators(node: TSNode): TSNode[] {
  const decorators: TSNode[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === 'decorator') {
    decorators.unshift(sibling);
    sibling = sibling.previousNamedSibling;
  }
  return decorators;
}

/** Décorateurs de classe : frères précédents, ou portés par l'export_statement (piège n°2). */
function classDecorators(classNode: TSNode): TSNode[] {
  const direct = precedingDecorators(classNode);
  if (direct.length > 0) return direct;
  const parent = classNode.parent;
  if (parent && parent.type === 'export_statement') {
    return parent.children.filter((c: TSNode) => c.type === 'decorator');
  }
  return [];
}

/** Concatène base path et path de route en un chemin propre : ("orders", "/:id") -> "/orders/:id". */
function joinRoute(basePath: string, routePath: string): string {
  const segments = [...basePath.split('/'), ...routePath.split('/')].filter((s) => s.length > 0);
  return '/' + segments.join('/');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Construit la map `propriété -> classe injectée` depuis le constructeur.
 * C'est la brique qui permet de désambiguïser `this.orderService.findById(id)`
 * sans réimplémenter un TypeChecker (CLAUDE.md §3).
 */
function buildInjectionMap(classBody: TSNode, warnings: string[]): Record<string, string> {
  const map: Record<string, string> = {};

  const constructorDef = runQuery(METHOD_QUERY, classBody)
    .map((m) => ({ name: capture(m, 'method.name'), def: capture(m, 'method.def') }))
    .find((m) => m.name?.text === 'constructor');

  if (!constructorDef?.def) return map;

  const params = constructorDef.def.childForFieldName('parameters');
  if (!params) return map;

  for (const match of runQuery(INJECTED_PARAM_QUERY, params)) {
    const name = capture(match, 'param.name')?.text;
    const type = capture(match, 'param.type')?.text;
    if (name && type) map[name] = type;
  }

  // Paramètres injectés dont le type n'est pas un simple type_identifier
  // (générique, union, @Inject(TOKEN)...) : on ne les résout pas, on le dit.
  for (const param of params.namedChildren) {
    if (param.type !== 'required_parameter') continue;
    const paramName = param.childForFieldName('pattern')?.text;
    const hasModifier = param.children.some((c: TSNode) => c.type === 'accessibility_modifier');
    if (hasModifier && paramName && !(paramName in map)) {
      warnings.push(
        `Paramètre injecté "${paramName}" non résolu : son type n'est pas un identifiant de classe simple. Les appels sur cette propriété seront marqués resolution="unresolved".`
      );
    }
  }

  return map;
}

/** Call graph local d'un handler, dans l'ordre d'apparition dans le code. */
function buildLocalCallGraph(handlerBody: TSNode, injectionMap: Record<string, string>): CallGraphEntry[] {
  const entries: CallGraphEntry[] = [];

  // 1. <objet>.<méthode>() — une seule query générique, classification ici.
  // Couvre this.x.y(), this.y(), et les chaînes profondes this.db.orders.findOne().
  for (const match of runQuery(MEMBER_CALL_QUERY, handlerBody)) {
    const expr = capture(match, 'call.expr')!;
    const method = capture(match, 'call.method')!;
    const object = expr.childForFieldName('function').childForFieldName('object');

    let receiver: string | null;
    let injectedType: string | null = null;
    let resolution: CallResolution;

    if (object.type === 'this') {
      // this.doThing() — méthode du contrôleur lui-même.
      receiver = 'this';
      resolution = 'local_method';
    } else if (object.type === 'member_expression' && object.childForFieldName('object').type === 'this') {
      // this.orderService.findById() — le cas résoluble via le constructeur.
      receiver = object.childForFieldName('property').text;
      injectedType = injectionMap[receiver!] ?? null;
      resolution = injectedType ? 'constructor_injection' : 'unresolved';
    } else {
      // this.db.orders.findOne(), config.get(), etc. On garde le texte complet
      // du receveur : c'est lui qui porte le sens pour le node de détection
      // (une requête sur `this.db.orders` sans filtre userId = signal IDOR).
      receiver = object.text;
      resolution = 'unresolved';
    }

    entries.push({
      call: method.text,
      injected_type: injectedType,
      receiver,
      resolution,
      line: method.startPosition.row + 1,
    });
  }

  // 2. appels libres helper() — la résolution cross-fichier se fait en Phase 2 (MCP).
  for (const match of runQuery(FREE_CALL_QUERY, handlerBody)) {
    const method = capture(match, 'call.method')!;
    entries.push({
      call: method.text,
      injected_type: null,
      receiver: null,
      resolution: 'unresolved',
      line: method.startPosition.row + 1,
    });
  }

  // Ordre du code source : c'est ce que le LLM local doit voir pour raisonner
  // sur la séquence (guard appelé AVANT le fetch, par exemple).
  entries.sort((a, b) => a.line - b.line);
  return entries;
}

/** Indexe une classe. Retourne null si ce n'est pas un @Controller. */
function indexController(classNode: TSNode, filePath: string, source: string): ControllerIndex | null {
  const warnings: string[] = [];

  const className = classNode.childForFieldName('name')?.text ?? '<anonymous>';
  const classBody = classNode.childForFieldName('body');
  if (!classBody) return null;

  const classDecoratorNodes = classDecorators(classNode);
  const controllerDecorator = classDecoratorNodes.find((d) => decoratorName(d) === 'Controller');
  if (!controllerDecorator) return null; // pas un contrôleur HTTP, hors scope

  const basePath = stringValue(decoratorArgs(controllerDecorator)[0]) ?? '';
  const controllerGuards = classDecoratorNodes
    .map((d) => decoratorName(d))
    .filter((n): n is string => !!n && GUARD_DECORATORS.has(n));

  const injectionMap = buildInjectionMap(classBody, warnings);

  const endpoints: Endpoint[] = [];
  const symbolIndex = new Map<string, SymbolTableEntry>();

  for (const match of runQuery(METHOD_QUERY, classBody)) {
    const methodDef = capture(match, 'method.def')!;
    const methodName = capture(match, 'method.name')!.text;
    if (methodName === 'constructor') continue;

    const decoratorNodes = precedingDecorators(methodDef);
    const httpDecorator = decoratorNodes.find((d) => {
      const name = decoratorName(d);
      return !!name && HTTP_METHOD_DECORATORS.has(name);
    });
    if (!httpDecorator) continue; // méthode utilitaire, pas une route exposée

    const httpMethod = decoratorName(httpDecorator)!;
    const routePath = stringValue(decoratorArgs(httpDecorator)[0]) ?? '';

    const guards = decoratorNodes
      .map((d) => decoratorName(d))
      .filter((n): n is string => !!n && GUARD_DECORATORS.has(n));

    const body = methodDef.childForFieldName('body');
    const callGraph = body ? buildLocalCallGraph(body, injectionMap) : [];

    for (const entry of callGraph) {
      if (!entry.injected_type) continue;
      // Clé (classe, méthode) — CLAUDE.md §3, pas le nom de méthode seul.
      const key = `${entry.injected_type}::${entry.call}`;
      const existing = symbolIndex.get(key);
      if (existing) {
        if (!existing.called_from.includes(methodName)) existing.called_from.push(methodName);
      } else {
        symbolIndex.set(key, {
          key,
          injected_type: entry.injected_type,
          method: entry.call,
          called_from: [methodName],
        });
      }
    }

    if (callGraph.some((c) => c.resolution === 'unresolved')) {
      warnings.push(
        `Handler "${methodName}" contient au moins un appel non résolu : le node de détection devra le traiter en reason="missing_context".`
      );
    }

    endpoints.push({
      route: joinRoute(basePath, routePath),
      http_method: httpMethod,
      handler: methodName,
      framework_metadata: {
        decorators: decoratorNodes.map((d) => d.text),
        guards: [...controllerGuards, ...guards],
        is_unguarded: controllerGuards.length === 0 && guards.length === 0,
      },
      local_call_graph: callGraph,
      code_snapshot: source.slice(methodDef.startIndex, methodDef.endIndex),
      source: {
        file: filePath,
        start_line: methodDef.startPosition.row + 1,
        end_line: methodDef.endPosition.row + 1,
      },
    });
  }

  return {
    controller: className,
    base_path: joinRoute(basePath, ''),
    controller_decorators: classDecoratorNodes.map((d) => d.text),
    injection_map: injectionMap,
    endpoints,
    symbol_table: [...symbolIndex.values()],
    index_warnings: warnings,
  };
}

/**
 * Indexe la DÉFINITION d'une classe quelconque (service, repository, guard...).
 * Contrairement à `indexController`, ne filtre pas sur @Controller : c'est ce
 * qui permet au serveur MCP de retrouver le corps de `OrderService.findById`.
 */
function indexClass(classNode: TSNode, filePath: string, source: string): ClassDefinition | null {
  const className = classNode.childForFieldName('name')?.text;
  const classBody = classNode.childForFieldName('body');
  if (!className || !classBody) return null;

  const decoratorNodes = classDecorators(classNode);
  const injectionMap = buildInjectionMap(classBody, []);

  const methods: MethodDefinition[] = [];
  for (const match of runQuery(METHOD_QUERY, classBody)) {
    const methodDef = capture(match, 'method.def')!;
    const methodName = capture(match, 'method.name')!.text;
    const body = methodDef.childForFieldName('body');

    methods.push({
      name: methodName,
      code_snapshot: source.slice(methodDef.startIndex, methodDef.endIndex),
      start_line: methodDef.startPosition.row + 1,
      end_line: methodDef.endPosition.row + 1,
      is_async: methodDef.children.some((c: TSNode) => c.type === 'async'),
      call_graph: body ? buildLocalCallGraph(body, injectionMap) : [],
    });
  }

  return {
    name: className,
    file: filePath,
    is_controller: decoratorNodes.some((d) => decoratorName(d) === 'Controller'),
    decorators: decoratorNodes.map((d) => d.text),
    injection_map: injectionMap,
    methods,
    start_line: classNode.startPosition.row + 1,
    end_line: classNode.endPosition.row + 1,
  };
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/** Indexe du code TypeScript en mémoire. `filePath` sert uniquement de label. */
export function indexSource(source: string, filePath = '<memory>'): FileIndex {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const tree = parser.parse(source);

  const warnings: string[] = [];
  if (tree.rootNode.hasError) {
    warnings.push(
      `Le parse de ${filePath} contient des erreurs de syntaxe : l'index peut être partiel.`
    );
  }

  const controllers: ControllerIndex[] = [];
  const classes: ClassDefinition[] = [];
  for (const match of runQuery(CLASS_QUERY, tree.rootNode)) {
    const classNode = capture(match, 'class.decl');
    if (!classNode) continue;

    // Toute classe est indexée comme définition (cible du resolver MCP)...
    const definition = indexClass(classNode, filePath, source);
    if (definition) classes.push(definition);

    // ...et, si c'est un @Controller, également comme surface d'attaque HTTP.
    const indexed = indexController(classNode, filePath, source);
    if (indexed) controllers.push(indexed);
  }

  if (controllers.length === 0) {
    warnings.push(`Aucune classe décorée @Controller trouvée dans ${filePath}.`);
  }

  return { file: filePath, controllers, classes, index_warnings: warnings };
}

/** Indexe un fichier sur disque. */
export function indexFile(filePath: string): FileIndex {
  return indexSource(readFileSync(filePath, 'utf8'), filePath);
}
