/**
 * Mesure de bout en bout : Indexeur -> MCP -> node IDOR -> Agrégateur.
 *
 * PHASE_4 impose de vérifier empiriquement que la zone grise reste dans la
 * fourchette 10-15 % de CLAUDE.md. Un jeu de findings simulés ne peut pas
 * répondre à ça : il donnerait le pourcentage qu'on aurait choisi d'y mettre.
 * Ce script fait donc tourner la vraie pipeline sur les vraies fixtures.
 *
 * Lancer :
 *   npm run measure
 *
 * Modèle par défaut : gemini-2.5-flash-lite (le moins cher de la gamme).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const here = dirname(fileURLToPath(import.meta.url));
const REPOS = [
  join(here, '..', 'src', 'nodes', 'idor', '__fixtures__', 'repo'),
  join(here, '..', 'src', 'mcp-server', '__fixtures__', 'repo'),
];

process.env.VULNPIPE_LLM_MODEL ??= 'gemini-2.5-flash-lite';

const llm = createLlmClient();
console.log(`Fournisseur : ${llm.provider} | Modèle : ${llm.model}\n`);

const findings: NodeFinding[] = [];
let routesAnalyzed = 0;
let llmCalls = 0;
let inputTokens = 0;
let outputTokens = 0;
let thinkingTokens = 0;
const failures: string[] = [];

for (const repo of REPOS) {
  const index = buildRepoIndex(repo);
  const provider = await connectInProcess(createServer(index));
  const routes = await provider.listRoutes();

  for (const route of routes) {
    routesAnalyzed += 1;
    try {
      const verdict = await analyzeRouteForIdor(
        { route: route.route, httpMethod: route.http_method },
        { contextProvider: provider, llm }
      );

      const llmInfo = verdict.technical_detail.llm;
      llmCalls += llmInfo?.calls ?? 0;
      inputTokens += llmInfo?.input_tokens ?? 0;
      outputTokens += llmInfo?.output_tokens ?? 0;
      thinkingTokens += llmInfo?.thinking_tokens ?? 0;

      console.log(
        `  ${route.http_method.padEnd(6)} ${route.route.padEnd(24)} score=${String(verdict.confidence_score).padEnd(5)} reason=${verdict.reason ?? 'null'}${llmInfo ? '' : '   (sans LLM)'}`
      );

      findings.push(fromNodeVerdict(verdict, 'idor-node', route.guards));
    } catch (error) {
      // Une route non analysée n'est PAS une route saine. Sans ce compteur,
      // un scan où tous les appels LLM échouent affiche « 0 % vers Claude »
      // et un résumé rassurant — exactement ce qui s'est produit au premier
      // essai de ce script (5 routes sur 7 en échec, rapport « rien à
      // signaler »). Une panne ne doit jamais ressembler à un bon résultat.
      failures.push(`${route.http_method} ${route.route} : ${(error as Error).message}`);
      console.log(`  ${route.http_method} ${route.route} — ÉCHEC : ${(error as Error).message}`);
    }
  }

  await provider.close();
}

const result = aggregate(findings, { routesAnalyzed });

console.log('\n' + '─'.repeat(72));
console.log('AGRÉGATEUR — statistiques du run');
console.log('─'.repeat(72));
console.log(`  routes analysées            : ${routesAnalyzed}`);
console.log(`  signalements reçus          : ${result.stats.total_received}`);
console.log(`  écartés (hors production)   : ${result.stats.excluded_non_production}`);
console.log(`  doublons fusionnés          : ${result.stats.merged_duplicates}`);
console.log(`  rejetés (score < 0.4)       : ${result.stats.rejected_low_confidence}`);
console.log(`  envoyés à Claude            : ${result.stats.sent_to_claude}`);
console.log(`  alertes directes            : ${result.stats.direct_alerts}`);
console.log(`  % des findings vers Claude  : ${result.stats.percent_of_findings_to_claude}%`);
console.log(
  `  % des ROUTES vers Claude    : ${result.stats.percent_of_routes_to_claude}%   <- à comparer aux 10-15% de CLAUDE.md`
);

console.log('\nCoût LLM du scan complet :');
console.log(
  `  ${llmCalls} appel(s) pour ${routesAnalyzed} routes | ${inputTokens} tokens entrée | ${outputTokens} sortie | ${thinkingTokens} raisonnement`
);
console.log(`  routes tranchées sans LLM : ${routesAnalyzed - llmCalls}`);

console.log('\nGroupes triés par sévérité :');
for (const group of result.groups) {
  console.log(
    `  [${group.severity.toUpperCase().padEnd(8)}] ${group.http_method} ${group.route} — ${group.vulnerabilities.map((v) => `${v.vulnerability}@${v.confidence_score}`).join(', ')}`
  );
}

console.log('\nRésumé destiné à l’utilisateur :');
console.log(`  ${result.plain_language_summary}`);

if (failures.length > 0) {
  console.log('\n' + '!'.repeat(72));
  console.log(`SCAN INCOMPLET — ${failures.length} route(s) sur ${routesAnalyzed} n'ont PAS été analysées.`);
  console.log('Les pourcentages ci-dessus ne valent rien tant que ces échecs ne sont pas réglés :');
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log('!'.repeat(72));
  process.exit(1);
}
