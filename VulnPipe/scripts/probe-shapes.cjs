/**
 * Probe #2 — formes précises des noeuds dont l'indexeur a besoin.
 * Lancer : node scripts/probe-shapes.cjs
 */
const Parser = require('tree-sitter');
const TypeScript = require('tree-sitter-typescript');

const SOURCE = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'src', 'indexer', '__fixtures__', 'order.controller.ts'),
  'utf8'
);

const parser = new Parser();
parser.setLanguage(TypeScript.typescript);
const tree = parser.parse(SOURCE);

function walk(node, fn, depth = 0) {
  fn(node, depth);
  for (const child of node.children) walk(child, fn, depth + 1);
}

console.log('=== 1. class_body : ordre des enfants (decorator vs method_definition) ===');
walk(tree.rootNode, (n) => {
  if (n.type === 'class_body') {
    n.children.forEach((c, i) => {
      console.log(
        `  [${i}] ${c.type.padEnd(20)} field=${String(n.fieldNameForChild(i))} text="${c.text.split('\n')[0].slice(0, 48)}"`
      );
    });
  }
});

console.log('\n=== 2. constructor : forme des paramètres injectés ===');
walk(tree.rootNode, (n) => {
  if (n.type === 'method_definition' && n.childForFieldName('name')?.text === 'constructor') {
    const params = n.childForFieldName('parameters');
    console.log('  parameters.type :', params.type);
    params.namedChildren.forEach((p) => {
      console.log(`  - param.type=${p.type}  text="${p.text}"`);
      p.children.forEach((c, i) => {
        console.log(`      child[${i}] type=${c.type} field=${p.fieldNameForChild(i)} text="${c.text}"`);
      });
    });
  }
});

console.log('\n=== 3. appels this.xxx.yyy() : forme du call_expression ===');
walk(tree.rootNode, (n) => {
  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    console.log(`  call text="${n.text.slice(0, 50)}"  function.type=${fn.type}`);
    if (fn.type === 'member_expression') {
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      console.log(`    object.type=${obj.type} object.text="${obj.text}"`);
      console.log(`    property.type=${prop.type} property.text="${prop.text}"`);
      if (obj.type === 'member_expression') {
        console.log(
          `      obj.object.type=${obj.childForFieldName('object').type} text="${obj.childForFieldName('object').text}"`
        );
        console.log(`      obj.property.text="${obj.childForFieldName('property').text}"`);
      }
    }
  }
});

console.log('\n=== 4. décorateur : extraire nom + argument string ===');
walk(tree.rootNode, (n) => {
  if (n.type === 'decorator') {
    const inner = n.namedChildren[0];
    console.log(`  decorator text="${n.text}" innerType=${inner.type}`);
    if (inner.type === 'call_expression') {
      console.log(`    fn="${inner.childForFieldName('function').text}"`);
      const args = inner.childForFieldName('arguments');
      console.log(
        `    args.namedChildren=${JSON.stringify(args.namedChildren.map((a) => [a.type, a.text]))}`
      );
    }
  }
});

console.log('\n=== 5. string : comment récupérer la valeur sans quotes ===');
walk(tree.rootNode, (n) => {
  if (n.type === 'string') {
    console.log(
      `  string.text=${JSON.stringify(n.text)} namedChildren=${JSON.stringify(n.namedChildren.map((c) => [c.type, c.text]))}`
    );
  }
});
