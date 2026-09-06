/**
 * Chaîne complète : Indexeur -> MCP -> node IDOR -> Agrégateur -> Master -> Rapport.
 *
 * Lancer :
 *   npm run report
 *
 * Le master est Claude par défaut (CLAUDE.md §2). Faute de ANTHROPIC_API_KEY,
 * ce script bascule sur Gemini et le DIT — un arbitrage rendu par un autre
 * modèle que celui annoncé ne doit pas passer inaperçu.
 *
 *   VULNPIPE_MASTER_PROVIDER=anthropic|gemini|...   (défaut : anthropic)
 *   VULNPIPE_MASTER_MODEL=...
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

// `.env` est chargé ici plutôt qu'attendu du shell : un script qu'il faut
// précéder d'un `source .env` finit toujours par être lancé sans.
// Import à effet de bord, placé en premier : les imports ES étant hissés,
// un appel de fonction ici s'exécuterait après les modules importés en dessous.
import '../src/config/load-env.ts';

import { buildRepoIndex } from '../src/mcp-server/repo-index.ts';
import { createServer } from '../src/mcp-server/server.ts';
import { connectInProcess } from '../src/nodes/shared/mcp-client.ts';
import { createLlmClient } from '../src/nodes/shared/llm/factory.ts';
import { analyzeRouteForIdor } from '../src/nodes/idor/node.ts';
import { aggregate, fromNodeVerdict, type NodeFinding } from '../src/aggregator/aggregator.ts';
import { arbitrate } from '../src/master/claude-client.ts';
import { buildReport } from '../src/master/report-builder.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPOS = [
  join(here, '..', 'src', 'nodes', 'idor', '__fixtures__', 'repo'),
  join(here, '..', 'src', 'mcp-server', '__fixtures__', 'repo'),
];

// --- Choix des moteurs ------------------------------------------------------
const nodeLlm = createLlmClient({
  ...process.env,
  VULNPIPE_LLM_PROVIDER: process.env.VULNPIPE_LLM_PROVIDER ?? 'gemini',
  VULNPIPE_LLM_MODEL: process.env.VULNPIPE_LLM_MODEL ?? 'gemini-2.5-flash-lite',
});

let masterProvider = process.env.VULNPIPE_MASTER_PROVIDER ?? 'anthropic';
if (masterProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.log(
    "[!] ANTHROPIC_API_KEY absente — le master bascule sur Gemini pour cette démonstration.\n" +
      "    CLAUDE.md prévoit Claude comme arbitre : ce rapport n'est donc pas représentatif\n" +
      '    de la qualité d’arbitrage attendue en production.\n'
  );
  masterProvider = 'gemini';
}
const masterLlm = createLlmClient({
  ...process.env,
  VULNPIPE_LLM_PROVIDER: masterProvider,
  VULNPIPE_LLM_MODEL: process.env.VULNPIPE_MASTER_MODEL ?? 'gemini-2.5-flash',
});

console.log(`Nodes  : ${nodeLlm.provider}/${nodeLlm.model}`);
console.log(`Master : ${masterLlm.provider}/${masterLlm.model}\n`);

// --- 1 à 3 : index, MCP, détection -----------------------------------------
const findings: NodeFinding[] = [];
let routesAnalyzed = 0;
let routesFailed = 0;
let nodeCalls = 0;
const providers = [];

for (const repo of REPOS) {
  const provider = await connectInProcess(createServer(buildRepoIndex(repo)));
  providers.push(provider);
  for (const route of await provider.listRoutes()) {
    routesAnalyzed += 1;
    try {
      const verdict = await analyzeRouteForIdor(
        { route: route.route, httpMethod: route.http_method },
        { contextProvider: provider, llm: nodeLlm }
      );
      nodeCalls += verdict.technical_detail.llm?.calls ?? 0;
      findings.push(fromNodeVerdict(verdict, 'idor-node', route.guards));
    } catch (error) {
      routesFailed += 1;
      console.log(`  ÉCHEC ${route.http_method} ${route.route} : ${(error as Error).message}`);
    }
  }
}

// --- 4 : agrégation ---------------------------------------------------------
const aggregation = aggregate(findings, { routesAnalyzed });
const candidates = [...aggregation.claude_payload, ...aggregation.direct_alerts];
console.log(`${routesAnalyzed} routes analysées -> ${candidates.length} signalement(s) vers le master.\n`);

// --- 5 : arbitrage (avec le code, via MCP) ---------------------------------
const outcome = await arbitrate(candidates, {
  llm: masterLlm,
  contextProvider: providers[0], // les fixtures partagent l'espace de routes
});

const report = buildReport(aggregation, outcome, { routesAnalyzed, routesFailed });

// --- Affichage --------------------------------------------------------------
console.log('═'.repeat(74));
console.log('RAPPORT DE SÉCURITÉ');
console.log('═'.repeat(74));
console.log(`\n${report.scan_summary.plain_language_intro}\n`);
console.log(
  `  ${report.scan_summary.total_findings} point(s) retenu(s) · ${report.scan_summary.critical} à corriger vite · ${report.scan_summary.warning} à surveiller`
);
console.log(
  `  ${report.scan_summary.dismissed_by_arbiter} écarté(s) par l'arbitre · ${report.scan_summary.not_arbitrated} non arbitré(s)`
);

for (const item of report.findings) {
  console.log('\n' + '─'.repeat(74));
  console.log(
    `[${item.report_level.toUpperCase()}] ${item.vulnerability} — ${item.http_method} ${item.route}`
  );
  console.log(`  verdict de l'arbitre : ${item.claude_verdict} (preuve : ${item.evidence})`);
  console.log(`  pourquoi             : ${item.claude_reasoning}`);
  console.log(`  pour le développeur  : ${item.technical_summary}`);
  console.log(`  ${item.owasp_category}`);
  console.log(`\n  POUR TOI :\n  ${item.plain_language_summary}`);
  console.log(`\n  À FAIRE :\n  ${item.suggested_fix_direction}`);
}

if (report.dismissed.length > 0) {
  console.log('\n' + '═'.repeat(74));
  console.log("ÉCARTÉS PAR L'ARBITRE (conservés pour calibrer les détecteurs)");
  for (const item of report.dismissed) {
    console.log(`  ${item.vulnerability} ${item.http_method} ${item.route} (score local ${item.local_confidence_score})`);
    console.log(`    -> ${item.claude_reasoning}`);
  }
}

console.log('\n' + '═'.repeat(74));
console.log(
  `Coût : ${nodeCalls} appel(s) détecteur + ${report.arbiter.calls} appel(s) arbitre ` +
    `(${report.arbiter.input_tokens} tokens entrée / ${report.arbiter.output_tokens} sortie)`
);

const outPath = join(here, '..', 'rapport-demo.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`Rapport JSON complet (format consommable par l'UI Phase 6) : ${outPath}`);

for (const provider of providers) await provider.close();
