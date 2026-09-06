/**
 * Probe API tree-sitter — Phase 1, étape 1 (obligatoire, cf. PHASE_1_INDEXER.md).
 *
 * But : ne JAMAIS supposer la forme des objets retournés par Query.matches().
 * Ce script imprime la structure réelle telle que renvoyée par les versions
 * installées localement. La sortie est recopiée en tête de src/indexer/indexer.ts.
 *
 * Lancer :  node scripts/probe-treesitter.cjs
 */
const Parser = require('tree-sitter');
const TypeScript = require('tree-sitter-typescript');

const parserPkg = require('tree-sitter/package.json');
const grammarPkg = require('tree-sitter-typescript/package.json');

const SOURCE = `
@Controller('orders')
export class OrderController {
  constructor(
    private orderService: OrderService,
    private logger: LoggerService,
  ) {}

  @UseGuards(OwnershipGuard)
  @Get('/:id')
  async getOrder(@Param('id') id: string, @Req() req: Request) {
    this.logger.log('Fetching order');
    return this.orderService.findById(id);
  }
}
`;

const parser = new Parser();
parser.setLanguage(TypeScript.typescript);
const tree = parser.parse(SOURCE);

console.log('=== VERSIONS ===');
console.log('node                    :', process.version);
console.log('tree-sitter             :', parserPkg.version);
console.log('tree-sitter-typescript  :', grammarPkg.version);

console.log('\n=== Parser.Query disponible ? ===');
console.log('typeof Parser.Query     :', typeof Parser.Query);
console.log('typeof require("tree-sitter").Query :', typeof require('tree-sitter').Query);

const Query = Parser.Query;
const query = new Query(
  TypeScript.typescript,
  `
  (class_declaration
    name: (type_identifier) @class.name
    body: (class_body) @class.body)
  `
);

console.log('\n=== méthodes de l instance Query ===');
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(query)));

const matches = query.matches(tree.rootNode);
console.log('\n=== typeof matches ===', Array.isArray(matches) ? 'Array' : typeof matches, 'len=', matches.length);

console.log('\n=== console.dir(matches[0], { depth: null }) — clés seulement ===');
const m0 = matches[0];
console.log('clés du match          :', Object.keys(m0));
console.log('m0.pattern             :', m0.pattern);
console.log('typeof m0.captures     :', Array.isArray(m0.captures) ? 'Array' : typeof m0.captures);
console.log('clés d une capture     :', Object.keys(m0.captures[0]));
console.log('capture.name           :', JSON.stringify(m0.captures.map((c) => c.name)));
console.log('typeof capture.node    :', typeof m0.captures[0].node);
console.log('capture.node.type      :', m0.captures[0].node.type);
console.log('capture.node.text      :', JSON.stringify(m0.captures[0].node.text));
console.log(
  'capture.node.startPosition :',
  JSON.stringify(m0.captures[0].node.startPosition)
);

console.log('\n=== méthodes utiles sur un SyntaxNode ===');
const proto = Object.getPrototypeOf(m0.captures[0].node);
console.log(Object.getOwnPropertyNames(proto).sort().join(', '));

console.log('\n=== query.captures() (vue à plat) ===');
const caps = query.captures(tree.rootNode);
console.log('typeof', Array.isArray(caps) ? 'Array' : typeof caps, 'len=', caps.length);
console.log('clés    :', Object.keys(caps[0]));

console.log('\n=== accès aux décorateurs : childForFieldName / children ===');
const cls = matches[0].captures.find((c) => c.name === 'class.name').node.parent;
console.log('class node type        :', cls.type);
console.log('enfants du class_body  :', cls.childForFieldName('body').children.map((c) => c.type));
