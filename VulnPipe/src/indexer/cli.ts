/**
 * CLI de l'indexeur — sortie JSON sur stdout.
 *
 *   node --experimental-strip-types src/indexer/cli.ts <fichier.controller.ts>
 *
 * C'est ce JSON que le serveur MCP de la Phase 2 consommera.
 */
import { indexFile } from './indexer.ts';

const [, , target] = process.argv;

if (!target) {
  console.error('usage: cli.ts <fichier.controller.ts>');
  process.exit(1);
}

console.log(JSON.stringify(indexFile(target), null, 2));
