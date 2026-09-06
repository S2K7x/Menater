/**
 * Bout en bout réel : webhook -> file -> pipeline -> rapport -> UI.
 *
 * Démarre le serveur, poste un webhook sur la fixture qui contient la faille
 * IDOR volontaire, suit le flux d'événements en direct, puis écrit une page
 * HTML autonome (`demo/rapport.html`) montrant le rendu réel des composants.
 *
 * Lancer :
 *   npm run e2e
 *
 * Ce qu'on doit observer :
 *   1. la timeline s'affiche dans l'ordre, en français courant ;
 *   2. le rapport contient le finding IDOR sur /orders/:id avec son résumé
 *      en langage simple ;
 *   3. dans la page HTML, le détail technique est replié — un clic l'ouvre.
 *
 * Par défaut : OpenRouter en modèles gratuits (`openrouter/free`).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

// `.env` est chargé ici plutôt qu'attendu du shell : un script qu'il faut
// précéder d'un `source .env` finit toujours par être lancé sans.
// Import à effet de bord, placé en premier : les imports ES étant hissés,
// un appel de fonction ici s'exécuterait après les modules importés en dessous.
import '../src/config/load-env.ts';

import { InMemoryQueue } from '../src/orchestration/queue.ts';
import { createVulnPipeServer } from '../src/orchestration/webhook.ts';
import type { ScanRequest } from '../src/orchestration/pipeline.ts';
/**
 * Libellés des étapes, pour ce script SEUL.
 *
 * Ils venaient de `web/src/lib/step_translations.ts`, qui a suivi l'interface
 * dans la console MENATER. Les rapatrier ici plutôt que d'importer depuis un
 * autre dépôt : ce script produit une démonstration en ligne de commande, il
 * n'a pas à dépendre de la mise en page d'une application web — et le champ
 * `icon` qu'il affichait imprimait un nom d'icône dans un terminal, ce qui
 * n'apprenait rien à personne.
 */
const STEP_TRANSLATIONS: Record<string, { label: string }> = {
  received: { label: 'Request received' },
  indexing: { label: 'Reading your code' },
  context_server: { label: 'Mapping the links' },
  detection: { label: 'Hunting for holes' },
  aggregation: { label: 'Sorting the findings' },
  master_review: { label: 'Second opinion' },
  report: { label: 'Your report' },
};

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(here, '..', 'src', 'nodes', 'idor', '__fixtures__', 'repo');

// OpenRouter accepte les deux noms de variable.

const provider = process.env.VULNPIPE_LLM_PROVIDER ?? 'openrouter';
const model = process.env.VULNPIPE_LLM_MODEL ?? 'openrouter/free';

const queue = new InMemoryQueue<ScanRequest & { run_id: string }>('scan');
const app = createVulnPipeServer({
  queue,
  settings: {
    nodeProvider: provider as never,
    nodeModel: model,
    masterProvider: provider as never,
    masterModel: model,
  },
});

const PORT = Number(process.env.PORT ?? 4319);
await new Promise<void>((resolve) => app.server.listen(PORT, resolve));
console.log(`Serveur VulnPipe sur http://localhost:${PORT}`);
console.log(`Moteur : ${provider} / ${model}\n`);

// --- 1. Fournisseurs disponibles -------------------------------------------
const providers = await (await fetch(`http://localhost:${PORT}/providers`)).json();
console.log('Fournisseurs détectés :');
for (const entry of providers.available as Array<{ id: string; available: boolean; why: string | null }>) {
  console.log(`  ${entry.available ? '[ok]  ' : '[--]  '}${entry.id}${entry.why ? ` — ${entry.why}` : ''}`);
}

// --- 2. Webhook -------------------------------------------------------------
console.log('\nEnvoi du webhook...');
const launch = await (
  await fetch(`http://localhost:${PORT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_path: FIXTURE_REPO, commit_sha: 'demo', mode: 'full_scan' }),
  })
).json();
console.log(`  ${launch.plain_language_summary} (${launch.run_id})\n`);

// --- 3. Flux d'événements en direct ----------------------------------------
console.log('TIMELINE (ce que voit l’utilisateur) :');
console.log('─'.repeat(74));

const stream = await fetch(`http://localhost:${PORT}${launch.events_url}`);
const reader = stream.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
let ended = false;

while (!ended) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    if (frame.startsWith('event: end')) {
      ended = true;
      continue;
    }
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const event = JSON.parse(line.slice(6));
    const translation = STEP_TRANSLATIONS[event.step as keyof typeof STEP_TRANSLATIONS];
    const symbol = { running: '...', done: '[ok]', failed: '[!]', skipped: '[-]' }[event.status as string] ?? '·';
    console.log(`  ${symbol} ${event.plain_language}`);
  }
}

// --- 4. Rapport + consommation ---------------------------------------------
const run = await (await fetch(`http://localhost:${PORT}/runs/${launch.run_id}`)).json();

console.log('\n' + '═'.repeat(74));
console.log('RAPPORT');
console.log('═'.repeat(74));
console.log(`\n${run.report?.scan_summary.plain_language_intro ?? '(aucun rapport)'}\n`);

for (const finding of run.report?.findings ?? []) {
  console.log(`  [${finding.report_level.toUpperCase()}] ${finding.http_method} ${finding.route}`);
  console.log(`     ${finding.plain_language_summary}`);
  console.log(`     À faire : ${finding.suggested_fix_direction}\n`);
}

console.log('CONSOMMATION');
console.log('─'.repeat(74));
console.log(`  ${run.usage?.plain_language_summary ?? '(non mesurée)'}`);
if (run.usage) {
  for (const [stage, totals] of Object.entries(run.usage.by_stage as Record<string, never>)) {
    const t = totals as { calls: number; input_tokens: number; output_tokens: number; cost_usd: number | null };
    console.log(
      `  ${stage.padEnd(14)} ${t.calls} appel(s) | ${t.input_tokens} entrée | ${t.output_tokens} sortie | coût ${t.cost_usd === null ? 'inconnu' : `${t.cost_usd} $`}`
    );
  }
}

// --- 5. Page de démonstration ----------------------------------------------
const demoDir = join(here, '..', 'demo');
mkdirSync(demoDir, { recursive: true });
const htmlPath = join(demoDir, 'rapport.html');
writeFileSync(htmlPath, renderDemoPage(run), 'utf8');
console.log(`\nPage de démonstration écrite : ${htmlPath}`);
console.log('   Ouvre-la pour voir le rendu : détail technique replié, un clic l’ouvre.');

app.server.close();
process.exit(run.report?.findings?.length ? 0 : 1);

/**
 * Page HTML autonome reprenant la structure exacte des composants React
 * (mêmes textes, même repli par défaut), sans étape de build.
 */
function renderDemoPage(run: Record<string, never>): string {
  const report = (run as never as { report: { scan_summary: Record<string, never>; findings: never[] } }).report;
  const usage = (run as never as { usage: { plain_language_summary: string } }).usage;
  const events = (run as never as { events: Array<Record<string, never>> }).events ?? [];

  const escape = (value: unknown): string =>
    String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  const timeline = events
    .map((event) => {
      const e = event as never as { step: string; status: string; plain_language: string };
      const translation = STEP_TRANSLATIONS[e.step as keyof typeof STEP_TRANSLATIONS];
      const symbol = { running: '...', done: '[ok]', failed: '[!]', skipped: '[-]' }[e.status] ?? '·';
      return `<li class="${e.status}"><span>${symbol}</span> <strong>${escape(translation?.label ?? e.step)}</strong><p>${escape(e.plain_language)}</p></li>`;
    })
    .join('\n');

  const findings = (report?.findings ?? [])
    .map((finding) => {
      const f = finding as never as Record<string, string>;
      return `<article class="finding ${escape(f.report_level)}">
  <header><span class="badge ${escape(f.report_level)}">${f.report_level === 'critical' ? 'À corriger vite' : 'À surveiller'}</span>
  <code>${escape(f.http_method)} ${escape(f.route)}</code></header>
  <p class="plain">${escape(f.plain_language_summary)}</p>
  <p class="fix"><strong>Ce qu'il faut faire :</strong> ${escape(f.suggested_fix_direction)}</p>
  <details><summary>Voir le détail technique</summary>
    <dl>
      <dt>Type de problème</dt><dd><abbr title="Un visiteur peut accéder aux données de quelqu'un d'autre en changeant un numéro dans l'adresse.">${escape(f.vulnerability)}</abbr> — un visiteur peut accéder aux données de quelqu'un d'autre en changeant un numéro dans l'adresse.</dd>
      <dt>Où</dt><dd>${escape(f.file)}${f.line ? ` (ligne ${escape(f.line)})` : ''}</dd>
      <dt>Analyse</dt><dd>${escape(f.technical_summary)}</dd>
      <dt>Pourquoi ce verdict</dt><dd>${escape(f.claude_reasoning)}</dd>
      <dt>Catégorie de référence</dt><dd>${escape(f.owasp_category)}</dd>
    </dl>
  </details>
</article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>VulnPipe — rapport</title>
<style>
  /* Fond ET couleur fixés ensemble : ne fixer que la couleur donnait du
     texte sombre sur fond sombre chez les utilisateurs en thème nuit —
     titres illisibles, constaté à l'écran. */
  :root { --bg: #ffffff; --fg: #1a1a1a; --muted: #444; --panel: #f4f7ff; --line: #e3e3e3; --fix-bg: #f6f9f6; --usage-bg: #fafafa; --link: #1c7ed6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16181d; --fg: #eceef2; --muted: #b6bcc7; --panel: #1e2530; --line: #333944; --fix-bg: #1c2620; --usage-bg: #1b1e24; --link: #6ea8fe; }
  }
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: var(--fg); background: var(--bg); }
  h1, h2 { color: var(--fg); }
  h1 { margin-bottom: .25rem; } .intro { font-size: 1.15rem; background: var(--panel); padding: 1rem; border-radius: 8px; }
  ol.timeline { list-style: none; padding: 0; } ol.timeline li { padding: .4rem 0; border-left: 3px solid var(--line); padding-left: .8rem; margin-bottom: .3rem; }
  ol.timeline li.failed { border-color: #d9480f; } ol.timeline li.done { border-color: #2f9e44; }
  ol.timeline p { margin: .1rem 0 0; color: var(--muted); }
  .finding { border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .finding.critical { border-left: 5px solid #d9480f; } .finding.warning { border-left: 5px solid #f08c00; }
  .badge { font-size: .8rem; padding: .15rem .5rem; border-radius: 999px; color: #fff; }
  .badge.critical { background: #d9480f; } .badge.warning { background: #f08c00; }
  .plain { font-size: 1.05rem; } .fix { background: var(--fix-bg); padding: .6rem; border-radius: 6px; }
  details { margin-top: .7rem; } summary { cursor: pointer; color: var(--link); }
  dl { display: grid; grid-template-columns: 12rem 1fr; gap: .3rem 1rem; } dt { font-weight: 600; color: var(--muted); }
  .usage { background: var(--usage-bg); border-radius: 8px; padding: 1rem; margin-top: 2rem; }
</style></head><body>
<h1>Résultat de l'analyse</h1>
<p class="intro">${escape(report?.scan_summary?.plain_language_intro)}</p>

<h2>Ce qui s'est passé</h2>
<ol class="timeline">${timeline}</ol>

<h2>Ce qu'on a trouvé</h2>
${findings || '<p>Rien à signaler sur ce scan.</p>'}

<section class="usage"><h2>Ce que ce scan a consommé</h2><p>${escape(usage?.plain_language_summary)}</p></section>
</body></html>`;
}
