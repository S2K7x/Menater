/**
 * Probe Ollama — Phase 3, étape 1. Même discipline qu'aux phases 1 et 2 :
 * on observe la forme réelle des réponses avant de construire quoi que ce soit.
 *
 * Lancer : node scripts/probe-ollama.mjs
 */
const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

const tags = await (await fetch(`${HOST}/api/tags`)).json();
const model = tags.models[0].name;
console.log('=== MODÈLES INSTALLÉS ===');
for (const m of tags.models) {
  console.log(` ${m.name} | ${m.details.parameter_size} | ${m.details.quantization_level}`);
  console.log(`   capabilities: ${JSON.stringify(m.capabilities)}`);
  console.log(`   context_length: ${m.details.context_length}`);
}

const PROMPT =
  'Analyse ce code et réponds en JSON: async findById(id){ return this.db.orders.findOne({id}); }\n' +
  'Réponds STRICTEMENT en JSON: {"confidence_score": 0.0, "reason": null}';

async function chat(label, body) {
  const started = Date.now();
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, ...body }),
  });
  const json = await response.json();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n=== ${label} (${elapsed}s) ===`);
  if (json.error) {
    console.log('ERREUR:', json.error);
    return json;
  }
  console.log('clés de la réponse :', Object.keys(json));
  console.log('clés de message    :', Object.keys(json.message));
  console.log('thinking présent ? :', json.message.thinking ? `OUI (${json.message.thinking.length} car.)` : 'non');
  console.log('content brut       :', JSON.stringify(json.message.content).slice(0, 300));
  console.log('done_reason        :', json.done_reason);
  console.log('eval_count         :', json.eval_count, '| prompt_eval_count:', json.prompt_eval_count);
  return json;
}

// 1. Appel nu : le modèle "thinking" va-t-il polluer la sortie ?
await chat('SANS format, SANS think:false', { messages: [{ role: 'user', content: PROMPT }] });

// 2. format: 'json' — mode JSON historique d'Ollama
await chat("format: 'json'", { messages: [{ role: 'user', content: PROMPT }], format: 'json' });

// 3. think: false — désactivation du raisonnement sur les modèles thinking
await chat('think: false + format json', {
  messages: [{ role: 'user', content: PROMPT }],
  format: 'json',
  think: false,
});

// 4. Structured outputs : format = JSON Schema complet
const schema = {
  type: 'object',
  properties: {
    confidence_score: { type: 'number' },
    reason: { type: ['string', 'null'], enum: ['missing_context', 'ambiguous_logic', null] },
  },
  required: ['confidence_score', 'reason'],
};
await chat('format: <JSON Schema> + think:false', {
  messages: [{ role: 'user', content: PROMPT }],
  format: schema,
  think: false,
  options: { temperature: 0 },
});

// 5. Déterminisme : temperature 0 + seed fixe donnent-ils deux fois la même sortie ?
console.log('\n=== DÉTERMINISME (temperature 0, seed 42, 2 appels) ===');
const runs = [];
for (let i = 0; i < 2; i++) {
  const r = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: PROMPT }],
      format: schema,
      think: false,
      options: { temperature: 0, seed: 42 },
    }),
  });
  runs.push((await r.json()).message.content);
}
console.log('run 1 :', runs[0]);
console.log('run 2 :', runs[1]);
console.log('identiques ?', runs[0] === runs[1]);
