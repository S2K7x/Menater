/**
 * Chargement du fichier `.env`.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EXISTE
 *
 * Jusqu'ici, aucun point d'entrée ne lisait `.env`. Les en-têtes de
 * `server.ts`, `e2e-demo.ts` et des probes documentaient tous la même
 * incantation :
 *
 *     set -a; source .env; set +a
 *
 * Conséquence observée : `npm run dev` démarrait avec « [--] gemini —
 * GEMINI_API_KEY absente du fichier .env » ALORS QUE la clé était bien dans
 * `.env`. Le message était même trompeur : il accusait le fichier, alors que
 * le fichier n'avait jamais été ouvert. Pire, le résultat dépendait de
 * l'historique du terminal — une clé exportée à la main lors d'une session
 * précédente faisait apparaître un fournisseur comme disponible, une autre
 * non, sans qu'aucun état du dépôt n'ait changé.
 *
 * Le chargement se fait donc en code, au démarrage, une bonne fois.
 *
 * PRIORITÉ : l'environnement réel gagne toujours sur `.env`. Une variable déjà
 * définie dans le shell (ou en CI, ou par Docker) n'est jamais écrasée : sinon
 * un `.env` oublié sur un poste écraserait silencieusement les secrets
 * d'un déploiement.
 *
 * Pas de dépendance `dotenv` : le format tient en trente lignes, et une
 * dépendance de plus pour ça n'est pas justifiable dans un MVP.
 * ============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LoadedEnv {
  /** Chemins réellement lus, dans l'ordre. */
  files: string[];
  /** Noms des variables effectivement injectées (jamais leurs valeurs). */
  applied: string[];
  /** Variables présentes dans le fichier mais déjà définies dans le shell. */
  skipped: string[];
}

/**
 * Analyse le contenu d'un `.env`.
 *
 * Gère : commentaires (`#` en début de ligne), lignes vides, préfixe `export`,
 * guillemets simples ou doubles, séquences `\n` dans les guillemets doubles.
 *
 * NE gère PAS les commentaires en fin de ligne sur une valeur non quotée :
 * une clé d'API peut légitimement contenir un `#`, et tronquer une clé à un
 * caractère près produirait une erreur d'authentification incompréhensible.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Alias de noms de variables rencontrés dans la nature.
 *
 * `OPEN_ROUTER_API_KEY` traînait déjà en `??=` dans deux points d'entrée
 * différents ; le normaliser ici évite qu'un troisième point d'entrée oublie
 * de le faire.
 */
const ALIASES: Array<[canonical: string, alias: string]> = [
  ['OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY'],
  ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
];

export function applyAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [canonical, alias] of ALIASES) {
    if (!env[canonical] && env[alias]) env[canonical] = env[alias];
  }
}

/**
 * Charge `.env.local` puis `.env` dans `process.env`.
 *
 * L'ordre compte : la première valeur rencontrée l'emporte (règle « le
 * déjà-défini gagne »). `.env.local` est donc lu EN PREMIER pour primer sur
 * `.env` — c'est la convention habituelle, où `.env` est le réglage partagé
 * et `.env.local` la surcharge personnelle non versionnée.
 *
 * Idempotent : appelable depuis plusieurs points d'entrée sans effet de bord.
 */
export function loadEnv(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; files?: string[] } = {}
): LoadedEnv {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const names = options.files ?? ['.env.local', '.env'];

  const loaded: LoadedEnv = { files: [], applied: [], skipped: [] };

  for (const name of names) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    loaded.files.push(path);

    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, 'utf8')))) {
      // L'environnement réel gagne : on ne remplace jamais une variable
      // déjà posée par le shell, la CI ou Docker.
      if (env[key] !== undefined && env[key] !== '') {
        if (!loaded.applied.includes(key)) loaded.skipped.push(key);
        continue;
      }
      env[key] = value;
      loaded.applied.push(key);
    }
  }

  applyAliases(env);
  return loaded;
}
