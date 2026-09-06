/**
 * Banc d'essai du node IDOR sur un vrai modèle.
 *
 * PHASE_3 exige d'exécuter les 3 cas contre un vrai LLM et de documenter les
 * scores. C'est le rôle de ce script — pas celui de la suite de tests, qui
 * doit rester rapide, hors-ligne et déterministe (voir shared/llm/fake.ts).
 *
 * Lancer :
 *   npm run bench
 *
 * Variables : VULNPIPE_LLM_PROVIDER (défaut gemini), VULNPIPE_LLM_MODEL,
 *             BENCH_FEWSHOT=1 pour activer les exemples de calibration.
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

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(here, '..', 'src', 'nodes', 'idor', '__fixtures__', 'repo');

interface Expectation {
  label: string;
  route: string;
  httpMethod: string;
  expect: (score: number, reason: string | null) => boolean;
  expectation: string;
}

const CASES: Expectation[] = [
  {
    label: 'CAS 1 — vulnérable évident',
    route: '/orders/:id',
    httpMethod: 'GET',
    expect: (score) => score >= 0.8,
    expectation: 'confidence_score >= 0.8',
  },
  {
    label: 'CAS 2 — sain',
    route: '/invoices/:id',
    httpMethod: 'GET',
    expect: (score) => score <= 0.3,
    expectation: 'confidence_score <= 0.3',
  },
  {
    label: 'CAS 3 — zone grise (guard non résolu)',
    route: '/reports/:id',
    httpMethod: 'GET',
    expect: (score, reason) => score >= 0.4 && score <= 0.7 && reason === 'missing_context',
    expectation: '0.4 <= confidence_score <= 0.7 ET reason = "missing_context"',
  },
  {
    label: 'CAS 4 — sans surface d\'attaque',
    route: '/health',
    httpMethod: 'GET',
    expect: (score) => score <= 0.3,
    expectation: 'confidence_score <= 0.3, tranché sans LLM',
  },
];

const index = buildRepoIndex(FIXTURE_REPO);
const provider = await connectInProcess(createServer(index));
const llm = createLlmClient();

console.log(`Fournisseur : ${llm.provider} | Modèle : ${llm.model}`);
console.log(`Few-shot    : ${process.env.BENCH_FEWSHOT === '1' ? 'ACTIVÉ' : 'désactivé'}`);
console.log(`Routes indexées : ${index.endpoints.length}\n`);

let passed = 0;
let totalInput = 0;
let totalOutput = 0;
let totalThinking = 0;
let totalCalls = 0;

for (const testCase of CASES) {
  const verdict = await analyzeRouteForIdor(
    { route: testCase.route, httpMethod: testCase.httpMethod },
    { contextProvider: provider, llm, includeFewShot: process.env.BENCH_FEWSHOT === '1' }
  );

  const ok = testCase.expect(verdict.confidence_score, verdict.reason);
  if (ok) passed += 1;

  const llmInfo = verdict.technical_detail.llm;
  totalInput += llmInfo?.input_tokens ?? 0;
  totalOutput += llmInfo?.output_tokens ?? 0;
  totalThinking += llmInfo?.thinking_tokens ?? 0;
  totalCalls += llmInfo?.calls ?? 0;

  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${testCase.label}`);
  console.log(`   attendu  : ${testCase.expectation}`);
  console.log(`   obtenu   : score=${verdict.confidence_score} reason=${verdict.reason ?? 'null'}`);
  console.log(
    `   appels LLM : ${llmInfo?.calls ?? 0}${llmInfo ? ` (in ${llmInfo.input_tokens} / out ${llmInfo.output_tokens} / pensée ${llmInfo.thinking_tokens}, ${llmInfo.latency_ms}ms)` : ' — tranché par le scanner déterministe'}`
  );
  if (verdict.technical_detail.retried) console.log('   retry    : oui (contexte approfondi)');
  for (const adjustment of verdict.technical_detail.adjustments) {
    console.log(`   ajusté   : ${adjustment}`);
  }
  console.log(`   résumé   : ${verdict.plain_language_summary}\n`);
}

console.log('─'.repeat(70));
console.log(`Résultat : ${passed}/${CASES.length} cas dans la plage attendue`);
console.log(
  `Coût total : ${totalCalls} appel(s) LLM | ${totalInput} tokens entrée | ${totalOutput} sortie | ${totalThinking} raisonnement`
);
console.log(
  `Routes tranchées sans LLM : ${CASES.length - totalCalls > 0 ? CASES.length - totalCalls : 0} (économie directe)`
);

await provider.close();
process.exit(passed === CASES.length ? 0 : 1);
