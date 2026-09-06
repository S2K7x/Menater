/**
 * Probe du fournisseur OpenAI-compatible — À LANCER AVANT DE S'EN SERVIR.
 *
 * `src/nodes/shared/llm/openai-compatible.ts` est le seul adaptateur écrit
 * sans observation réelle : aucune clé OpenAI/OpenRouter n'était disponible
 * quand il a été écrit. `CLAUDE.md` §7 interdit de bâtir sur une API supposée.
 *
 * Lancer (au choix) :
 *   OPENAI_API_KEY=sk-...     PROBE_BASE_URL=https://api.openai.com/v1     PROBE_MODEL=gpt-5 node scripts/probe-openai-compatible.mjs
 *   OPENROUTER_API_KEY=sk-... PROBE_BASE_URL=https://openrouter.ai/api/v1  PROBE_MODEL=google/gemini-2.5-flash node scripts/probe-openai-compatible.mjs
 *
 * Puis recopier la sortie réelle dans l'en-tête de openai-compatible.ts et
 * retirer l'avertissement « NON VÉRIFIÉ ».
 */
const KEY = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
const BASE = process.env.PROBE_BASE_URL;
const MODEL = process.env.PROBE_MODEL;

if (!KEY || !BASE || !MODEL) {
  console.error('Manque OPENAI_API_KEY (ou OPENROUTER_API_KEY), PROBE_BASE_URL et PROBE_MODEL.');
  process.exit(1);
}

const SCHEMA = {
  type: 'object',
  properties: {
    confidence_score: { type: 'number' },
    reason: { type: 'string', enum: ['none', 'missing_context', 'ambiguous_logic'] },
  },
  required: ['confidence_score', 'reason'],
  additionalProperties: false,
};

async function call(label, responseFormat) {
  const started = Date.now();
  const response = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Tu es un agent SAST. Reponds en JSON strict.' },
        { role: 'user', content: 'Analyse: findOne({id}) sans filtre userId. Donne confidence_score et reason.' },
      ],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
  });
  const json = await response.json();
  console.log(`\n=== ${label} (${((Date.now() - started) / 1000).toFixed(1)}s, HTTP ${response.status}) ===`);
  if (json.error) {
    console.log('ERREUR:', JSON.stringify(json.error).slice(0, 300));
    return;
  }
  console.log('cles racine   :', Object.keys(json));
  console.log('cles choice[0]:', Object.keys(json.choices?.[0] ?? {}));
  console.log('finish_reason :', json.choices?.[0]?.finish_reason);
  console.log('usage         :', JSON.stringify(json.usage));
  const content = json.choices?.[0]?.message?.content ?? '';
  console.log('content       :', JSON.stringify(content).slice(0, 250));
  try {
    console.log('JSON.parse    : OK ->', JSON.stringify(JSON.parse(content)));
  } catch (e) {
    console.log('JSON.parse    : ECHEC ->', e.message);
  }
}

console.log('=== base:', BASE, '| modele:', MODEL, '===');
await call('sans response_format', null);
await call('response_format: json_object', { type: 'json_object' });
await call('response_format: json_schema (strict)', {
  type: 'json_schema',
  json_schema: { name: 'vulnpipe_verdict', strict: true, schema: SCHEMA },
});
