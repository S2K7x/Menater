/**
 * Point d'entrée du service VulnPipe.
 *
 *   npm run serve          # API seule
 *   npm run dev            # API + interface web
 *
 * Le fichier `.env` est chargé automatiquement (voir `src/config/env.ts`) :
 * aucune incantation `source .env` n'est nécessaire.
 *
 * Variables : PORT (défaut 4319), REDIS_URL (bascule sur BullMQ),
 *             VULNPIPE_LLM_PROVIDER / VULNPIPE_MASTER_PROVIDER.
 */

// Import à effet de bord, EN PREMIER : les imports ES sont hissés, donc un
// `loadEnv()` écrit ici s'exécuterait après l'évaluation des modules ci-dessous.
import { dotenv } from '../config/load-env.ts';

import { createQueue } from './queue.ts';
import { createVulnPipeServer } from './webhook.ts';
import { describeProviders } from '../nodes/shared/llm/factory.ts';
import type { ScanRequest } from './pipeline.ts';
import { portSource, resolvePort } from '../config/port.ts';

// Voir `config/port.ts` : `process.env.PORT` seul faisait démarrer le service
// sur le port d'un autre programme, sans que rien ne le dise.
const PORT = resolvePort();

const queue = await createQueue<ScanRequest & { run_id: string; estimate_id?: string }>('vulnpipe-scan');
const app = createVulnPipeServer({ queue });

app.server.listen(PORT, () => {
  // La PROVENANCE du port est affichée, pas seulement sa valeur : c'est elle
  // qui répond à « pourquoi n'est-il pas sur 4319 ? ».
  console.log(`VulnPipe — service d'analyse sur http://localhost:${PORT} (port : ${portSource()})`);
  console.log(`File : ${process.env.REDIS_URL ? 'BullMQ (Redis)' : 'en mémoire'}`);

  // On dit d'où viennent les clés : sans ça, un « clé absente » alors que la
  // clé est dans `.env` est indébogable.
  if (dotenv.files.length > 0) {
    console.log(
      `Config : ${dotenv.files.join(', ')} — ${dotenv.applied.length} variable(s) chargée(s)` +
        (dotenv.skipped.length > 0
          ? `, ${dotenv.skipped.length} déjà définie(s) par le shell (le shell gagne)`
          : '')
    );
  } else {
    console.log('Config : aucun fichier .env trouvé (copie .env.example en .env).');
  }

  console.log('\nFournisseurs :');
  for (const entry of describeProviders(process.env as never)) {
    console.log(`  ${entry.available ? '[ok]  ' : '[--]  '}${entry.id}${entry.why ? ` — ${entry.why}` : ''}`);
  }
  console.log(
    `\nDétecteurs : ${app.settings.nodeProvider} | Arbitre : ${app.settings.masterProvider}`
  );

  // Ce que les caches ont repris du disque. Dit à voix haute, parce qu'un
  // cache qu'on croit chargé et qui ne l'est pas (fichier d'une autre
  // version, volume non monté) transforme un scan censé être gratuit en scan
  // facturé, sans que rien ne l'explique.
  const caches = app.describeCaches();
  if (!caches.persisted) {
    console.log('Caches : en mémoire seule (VULNPIPE_CACHE_PERSIST=false) — vidés au redémarrage.');
  } else {
    const reprises = caches.restored
      .map((entry) =>
        entry.why ? `${entry.kind} : ${entry.why}` : `${entry.kind} : ${entry.kept} repris`
      )
      .join(' | ');
    console.log(`Caches : ${reprises}`);
  }

  // Un scan que le redémarrage a coupé doit être NOMMÉ. Sans ça, quelqu'un
  // attend un rapport qui n'arrivera jamais, et rien ne le lui dit.
  if (app.interruptedRuns.length > 0) {
    console.log(
      `Runs interrompus par un arrêt précédent : ${app.interruptedRuns.length} — ` +
        `${app.interruptedRuns.slice(0, 3).join(', ')}${app.interruptedRuns.length > 3 ? '...' : ''}. ` +
        `Ils sont marqués comme tels, pas comme « en cours ». Relance-les pour obtenir un rapport.`
    );
  }
  console.log("Interface web : npm run web  (puis http://localhost:5173)\n");
});

const shutdown = async (): Promise<void> => {
  console.log('\nArrêt du service...');
  // AVANT de fermer quoi que ce soit : c'est la dernière écriture des caches,
  // et le dernier scan est justement celui qu'on vient de payer.
  app.shutdown();
  await queue.close();
  app.server.close(() => process.exit(0));
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
