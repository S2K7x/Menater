/**
 * Démarrage d'un service de la console, avec constat de l'existant.
 *
 * ============================================================================
 * LE PROBLÈME QUE CE FICHIER RÉSOUT
 *
 * `npm run dev` lance trois processus. Si l'un des deux services tournait déjà
 * — parce qu'on avait lancé `npm run serve` dans un autre terminal, ou qu'un
 * `npm run dev` précédent n'a pas été coupé — Node s'arrêtait sur une trace
 * brute :
 *
 *     Error: listen EADDRINUSE: address already in use :::4319
 *         at Server.setupListenHandle [as _listen2] (node:net:2167:16)
 *         ... huit lignes de pile ...
 *
 * Rien dans ce message ne dit que TOUT VA BIEN : le service tourne, il est
 * simplement déjà là. L'écran, lui, fonctionnait parfaitement. On perdait donc
 * du temps à débugger une situation normale.
 *
 * ============================================================================
 * CE QUE FAIT LE SCRIPT
 *
 * Il sonde le port avant de démarrer, et distingue TROIS situations, parce que
 * les confondre est précisément ce qui coûtait du temps :
 *
 *   1. RIEN N'ÉCOUTE           → on démarre normalement.
 *   2. LE MÊME SERVICE RÉPOND  → on ne démarre rien, on le dit, et on sort en
 *                                SUCCÈS. `npm run dev` continue avec les
 *                                autres processus, l'interface s'y attache.
 *   3. QUELQU'UN D'AUTRE       → on sort en ÉCHEC, en nommant le port et la
 *                                variable qui permet d'en changer. Démarrer
 *                                par-dessus est impossible ; le taire serait
 *                                pire.
 *
 * La sonde n'est pas un simple test TCP : un port ouvert ne prouve pas que
 * c'est le bon service. On interroge une route de santé et on vérifie la forme
 * de la réponse — sans quoi un autre serveur sur 4400 serait pris pour la
 * console, et l'interface parlerait à un inconnu.
 * ============================================================================
 */

import { spawn } from 'node:child_process';

interface Service {
  /** Préfixe des messages, aligné sur les noms de `concurrently`. */
  label: string;
  port: number;
  /** Route interrogée pour reconnaître le service. */
  probe: string;
  /** Champ attendu dans la réponse JSON : c'est lui qui signe le service. */
  signature: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Variable qui permet de changer de port, citée en cas de conflit. */
  portVar: string;
}

const SERVICES: Record<string, Service> = {
  soc: {
    label: 'console',
    port: Number(process.env.MENATER_API_PORT ?? process.env.SOC_API_PORT ?? 4400),
    probe: '/api/auth/status',
    signature: 'password_set',
    command: process.execPath,
    args: ['--env-file-if-exists=.env', '--experimental-strip-types', 'server/api.ts'],
    portVar: 'MENATER_API_PORT',
  },
  code: {
    label: 'analyse de code',
    port: Number(process.env.VULNPIPE_API_PORT ?? 4319),
    probe: '/providers',
    signature: 'available',
    command: 'npm',
    args: ['--prefix', '../VulnPipe', 'run', 'serve'],
    portVar: 'VULNPIPE_API_PORT',
  },
};

type Occupancy = 'free' | 'same-service' | 'foreign';

/**
 * Qui occupe le port ?
 *
 * Un délai court (1,5 s) : on interroge une machine locale, et l'attente est
 * payée à chaque démarrage. Au-delà, on considère que ce n'est pas notre
 * service — le pire cas est de démarrer et d'obtenir l'erreur d'origine, qui
 * reste plus claire qu'un `npm run dev` qui semble figé.
 */
async function probe(service: Service): Promise<Occupancy> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://localhost:${service.port}${service.probe}`, {
      signal: controller.signal,
    });
    const body = (await res.json()) as Record<string, unknown>;
    return service.signature in body ? 'same-service' : 'foreign';
  } catch (err) {
    // `ECONNREFUSED` = personne n'écoute, c'est le cas nominal. Tout le reste
    // (réponse illisible, délai dépassé, autre erreur) désigne un occupant qui
    // n'est pas nous.
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') return 'free';
    if ((err as Error).name === 'AbortError') return 'foreign';
    return 'foreign';
  } finally {
    clearTimeout(timer);
  }
}

const key = process.argv[2] ?? '';
const service = SERVICES[key];
if (!service) {
  console.error(`[start] service inconnu : « ${key} ». Attendu : ${Object.keys(SERVICES).join(', ')}.`);
  process.exit(1);
}

const state = await probe(service);

if (state === 'same-service') {
  console.log(
    `[${service.label}] déjà démarré sur le port ${service.port} — on s'y attache, rien à relancer.`,
  );
  process.exit(0);
}

if (state === 'foreign') {
  console.error(
    `[${service.label}] le port ${service.port} est occupé par autre chose.\n` +
      `  Arrêter ce programme, ou choisir un autre port :\n` +
      `      ${service.portVar}=<port> npm run dev\n` +
      `  Pour voir qui l'occupe :  lsof -nP -iTCP:${service.port} -sTCP:LISTEN`,
  );
  process.exit(1);
}

/**
 * Le port est IMPOSÉ à l'enfant, pas suggéré.
 *
 * On vient de sonder `service.port` ; démarrer un service qui écoute ailleurs
 * rendrait cette sonde mensongère. C'est arrivé : `PORT` — la variable la plus
 * générique qui soit, posée par les hébergeurs, les harnais de
 * prévisualisation et propagée par npm — faisait démarrer le service d'analyse
 * sur le port de l'interface web, pendant que la console relayait vers 4319.
 * Résultat : un 503 « démarrer le service » sur un service déjà démarré.
 *
 * `PORT` est donc retiré de l'environnement de l'enfant. Ce script est
 * l'autorité sur les ports ; lancer un service directement
 * (`npm run serve` dans son dossier) continue de l'honorer.
 */
const childEnv = { ...process.env, [service.portVar]: String(service.port) };
delete childEnv.PORT;

const child = spawn(service.command, service.args, {
  cwd: service.cwd,
  stdio: 'inherit',
  env: childEnv,
});

// Ctrl+C doit couper le service, pas laisser un orphelin qui bloquera le port
// au prochain démarrage — c'est exactement comme ça qu'on en arrive au conflit
// que ce script rattrape.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
