/**
 * Probe Gemini — Phase 3. Même discipline qu'aux phases précédentes : on
 * observe la forme réelle des requêtes/réponses avant de coder quoi que ce soit.
 *
 * Lancer : node scripts/probe-gemini.mjs
 * La clé n'est jamais affichée.
 */
const { loadEnv } = await import('../src/config/env.ts');
loadEnv();

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('GEMINI_API_KEY absente : ajoute-la dans .env à la racine du projet.');
  process.exit(1);
}
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = process.env.PROBE_MODEL ?? 'gemini-3.5-flash';

const SCHEMA = {
  type: 'object',
  properties: {
    confidence_score: { type: 'number' },
    reason: { type: 'string', enum: ['none', 'missing_context', 'ambiguous_logic'] },
    plain_language_summary: { type: 'string' },
  },
  required: ['confidence_score', 'reason', 'plain_language_summary'],
};

const USER = `Analyse cette route pour une faille IDOR :
@Get('/:id')
async getOrder(@Param('id') id: string) { return this.orderService.findById(id); }
// OrderService.findById : return this.db.orders.findOne({ id });
Donne confidence_score entre 0 et 1, reason, et plain_language_summary en francais simple.`;

async function call(label, body) {
  const started = Date.now();
  const response = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n=== ${label} (${elapsed}s, HTTP ${response.status}) ===`);
  if (json.error) {
    console.log('ERREUR:', json.error.code, json.error.status, '|', json.error.message.slice(0, 300));
    return json;
  }
  console.log('cles racine        :', Object.keys(json));
  const cand = json.candidates?.[0];
  console.log('cles candidate     :', cand ? Object.keys(cand) : '(aucun candidat)');
  console.log('finishReason       :', cand?.finishReason);
  console.log('cles de content    :', cand?.content ? Object.keys(cand.content) : '-');
  console.log('nb de parts        :', cand?.content?.parts?.length);
  console.log('cles d une part    :', cand?.content?.parts?.[0] ? Object.keys(cand.content.parts[0]) : '-');
  console.log('usageMetadata      :', JSON.stringify(json.usageMetadata));
  const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  console.log('texte (200 car.)   :', JSON.stringify(text).slice(0, 240));
  try {
    const parsed = JSON.parse(text);
    console.log('JSON.parse direct  : OK ->', JSON.stringify(parsed).slice(0, 200));
  } catch (e) {
    console.log('JSON.parse direct  : ECHEC ->', e.message);
  }
  return json;
}

console.log('=== MODELE ===', MODEL);

// 1. Appel nu : le texte est-il du JSON exploitable sans contrainte ?
await call('SANS responseSchema', {
  contents: [{ role: 'user', parts: [{ text: USER }] }],
});

// 2. responseMimeType JSON + responseSchema (sortie structurée)
await call('AVEC responseSchema', {
  systemInstruction: { parts: [{ text: 'Tu es un agent SAST. Reponds en JSON strict.' }] },
  contents: [{ role: 'user', parts: [{ text: USER }] }],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: SCHEMA,
    temperature: 0,
  },
});

// 3. thinkingLevel bas — les modeles Gemini 3 raisonnent par defaut ;
//    est-ce que ca se voit dans usageMetadata (thoughtsTokenCount) ?
await call('thinkingLevel: low', {
  contents: [{ role: 'user', parts: [{ text: USER }] }],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: SCHEMA,
    temperature: 0,
    thinkingConfig: { thinkingLevel: 'low' },
  },
});

// 4. Determinisme : temperature 0, deux appels identiques
console.log('\n=== DETERMINISME (temperature 0, 2 appels) ===');
const runs = [];
for (let i = 0; i < 2; i++) {
  const r = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: USER }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
    }),
  });
  const j = await r.json();
  runs.push(j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? 'ERREUR');
}
console.log('run 1 :', runs[0]?.slice(0, 130));
console.log('run 2 :', runs[1]?.slice(0, 130));
console.log('identiques ?', runs[0] === runs[1]);

// 5. Erreur d'authentification : forme du retour (pour le mapping d'erreurs)
console.log('\n=== CLE INVALIDE (forme de l erreur) ===');
const bad = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-goog-api-key': 'cle-invalide' },
  body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
});
const badJson = await bad.json();
console.log('HTTP', bad.status, '| error.status:', badJson.error?.status, '| code:', badJson.error?.code);
