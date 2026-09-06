/**
 * Tunnel Cloudflare : rend le point d'entrée des alertes joignable de l'extérieur.
 *
 *     npm run tunnel
 *
 * ============================================================================
 * CE QUE CE SCRIPT REFUSE DE FAIRE
 *
 * Il ne démarre PAS le tunnel si le point d'entrée n'est pas protégé.
 *
 * Un tunnel expose la console sur Internet. Si `webhook.mode` vaut `off` ou si
 * aucun secret n'est configuré, l'endpoint refuse déjà de servir — mais le
 * tunnel resterait ouvert, et la prochaine personne qui activerait le mode
 * sans penser au secret ouvrirait une porte d'ingestion mondiale sans s'en
 * apercevoir.
 *
 * Mieux vaut refuser de démarrer, en disant quoi faire.
 *
 * ============================================================================
 * LE JETON NE PASSE PAS PAR LA LIGNE DE COMMANDE
 *
 * `cloudflared tunnel run --token <jeton>` mettrait le secret dans la table
 * des processus, visible par `ps` pour tout utilisateur de la machine, et dans
 * l'historique du shell. Il est passé par l'environnement du processus fils,
 * qui n'a aucune de ces deux propriétés.
 * ============================================================================
 */

import { spawn } from 'node:child_process';

import { getConfig } from '../server/config.ts';

const conf = getConfig();
const port = Number(process.env.MENATER_API_PORT ?? process.env.SOC_API_PORT ?? 4400);

const refusals: string[] = [];

if (!conf.tunnel.token) {
  refusals.push(
    'Aucun jeton de tunnel.\n'
      + '     Le coller dans Réglages → Ingestion, ou poser CLOUDFLARE_TUNNEL_TOKEN.',
  );
}
if (conf.webhook.mode === 'off') {
  refusals.push(
    "Le point d'entrée des alertes est fermé (`mode: off`).\n"
      + "     Ouvrir un tunnel vers une porte fermée n'a pas d'objet, et la porte\n"
      + "     pourrait être ouverte plus tard sans que personne ne repense au tunnel.",
  );
}
if (!conf.webhook.secret) {
  refusals.push(
    "Aucun secret partagé n'est configuré.\n"
      + "     UN TUNNEL EXPOSE CETTE CONSOLE SUR INTERNET. Sans secret, n'importe qui\n"
      + "     peut injecter une alerte — et une alerte mène à une demande d'isolation.",
  );
}

if (refusals.length > 0) {
  console.error('\n[tunnel] Démarrage refusé :\n');
  for (const r of refusals) console.error(`  •  ${r}\n`);
  process.exit(1);
}

console.log(`[tunnel] Cloudflare → http://localhost:${port}`);
console.log(`[tunnel] Point d'entrée : POST /api/webhook/soc/alert`);
console.log(`[tunnel] En-tête requis : X-SOC-Token`);
console.log(`[tunnel] Mode d'ingestion : ${conf.webhook.mode}\n`);

const child = spawn(
  'cloudflared',
  ['tunnel', '--no-autoupdate', 'run', '--url', `http://localhost:${port}`],
  {
    stdio: 'inherit',
    // Le jeton passe par l'ENVIRONNEMENT, jamais par la ligne de commande :
    // `ps` la montre à tous les utilisateurs de la machine.
    env: { ...process.env, TUNNEL_TOKEN: conf.tunnel.token },
  },
);

child.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT') {
    console.error(
      "\n[tunnel] `cloudflared` est introuvable.\n"
        + '     macOS   : brew install cloudflared\n'
        + '     Linux   : https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n',
    );
    process.exit(1);
  }
  throw err;
});

// Ctrl+C doit fermer le tunnel, pas laisser un orphelin qui continue d'exposer
// la console après qu'on a cru l'avoir arrêté.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
