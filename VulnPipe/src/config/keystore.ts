/**
 * Magasin des clés de moteur, modifiables depuis les Réglages de la console.
 *
 * ============================================================================
 * LE PROBLÈME QU'IL RÉSOUT
 *
 * Les clés ne se posaient que dans `.env`, donc : ouvrir un terminal, trouver
 * le dossier, éditer un fichier, redémarrer le service. Pendant ce temps la
 * page Réglages affichait « clé absente » à côté d'un moteur — elle nommait le
 * trou sans permettre de le combler. Une console qui diagnostique et ne
 * répare pas fait faire l'aller-retour à chaque fois.
 *
 * ============================================================================
 * TROIS DÉCISIONS QUI NE SE DEVINENT PAS
 *
 *  1. UNE CLÉ POSÉE ICI PREND EFFET TOUT DE SUITE, sans redémarrage. Tout
 *     VulnPipe lit `process.env` AU MOMENT DE L'APPEL (`describeProviders`,
 *     `createLlmClient`) : écrire dans `process.env` suffit. C'est ce qui
 *     permet au sélecteur de moteur de passer de « clé absente » à
 *     « disponible » dans la seconde qui suit la saisie.
 *
 *  2. L'ENVIRONNEMENT RÉEL GAGNE, ET ON LE DIT. Une variable posée par le
 *     shell, Docker ou la CI est une décision de déploiement : un fichier sur
 *     le disque n'a pas à l'écraser en silence. Quand c'est le cas, la clé
 *     saisie est REFUSÉE avec la raison, pas acceptée puis ignorée — accepter
 *     une valeur qui ne servira jamais est la pire des deux réponses.
 *     Précédence : environnement réel > ce magasin > `.env`.
 *
 *  3. UNE VALEUR NE RESSORT JAMAIS. `describeKeys()` renvoie « posée » ou
 *     « absente » et d'où elle vient, jamais la clé. Même discipline que
 *     `publicView()` côté console.
 * ============================================================================
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Les variables que la console a le droit d'écrire.
 *
 * LISTE FERMÉE, VOLONTAIREMENT. Accepter un nom quelconque ferait de cet
 * endpoint un moyen d'injecter n'importe quelle variable d'environnement dans
 * le processus — `PATH` compris, alors que `claude-subscription` lance un
 * exécutable trouvé via `PATH`. Ce qui n'est pas dans cette liste est refusé.
 */
export const MANAGED_KEYS = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'VULNPIPE_LLM_BASE_URL',
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

export const isManagedKey = (name: string): name is ManagedKey =>
  (MANAGED_KEYS as readonly string[]).includes(name);

/** D'où vient la valeur actuellement en vigueur. */
export type KeySource = 'environment' | 'store' | 'dotenv' | 'none';

export interface KeyStatus {
  name: ManagedKey;
  set: boolean;
  source: KeySource;
  /**
   * `true` quand la valeur vient du shell/Docker : la console doit alors
   * afficher le champ en lecture seule plutôt que de laisser saisir une clé
   * qui serait refusée.
   */
  locked: boolean;
}

function storePath(): string {
  return process.env.VULNPIPE_KEYSTORE ?? join(process.cwd(), '.vulnpipe', 'keys.json');
}

/**
 * Noms vus dans l'environnement AVANT tout chargement de fichier.
 *
 * Figé au premier appel : une fois qu'on a écrit dans `process.env`, on ne
 * peut plus distinguer ce qui venait du shell de ce qu'on y a mis soi-même.
 */
let realEnvKeys: Set<string> | null = null;

export function snapshotRealEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (realEnvKeys) return;
  realEnvKeys = new Set(MANAGED_KEYS.filter((k) => env[k] !== undefined && env[k] !== ''));
}

/** Vraie provenance externe, indépendante de ce que le magasin a injecté. */
export const fromRealEnvironment = (name: ManagedKey): boolean => Boolean(realEnvKeys?.has(name));

/** Ce que le magasin a effectivement posé dans `process.env`. */
const applied = new Set<ManagedKey>();

function readStore(): Partial<Record<ManagedKey, string>> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const out: Partial<Record<ManagedKey, string>> = {};
    for (const name of MANAGED_KEYS) {
      const v = raw?.[name];
      if (typeof v === 'string' && v !== '') out[name] = v;
    }
    return out;
  } catch {
    // Un magasin illisible ne doit pas empêcher le service de démarrer : on
    // repart de rien et on le dit dans les logs, comme la console le fait de
    // son `config.json`.
    console.error(`[vulnpipe] ${path} illisible — clés de moteur ignorées.`);
    return {};
  }
}

function writeStore(values: Partial<Record<ManagedKey, string>>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(values, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* système de fichiers sans permissions POSIX : on ne bloque pas pour autant */
  }
}

/**
 * Applique le magasin à `process.env`.
 *
 * À appeler au démarrage, APRÈS `loadEnv()` : le magasin prime sur `.env` (une
 * clé saisie dans l'interface est un geste plus récent et plus délibéré qu'un
 * `.env` partagé), mais jamais sur l'environnement réel.
 */
export function applyKeyStore(env: NodeJS.ProcessEnv = process.env): ManagedKey[] {
  snapshotRealEnv(env);
  const stored = readStore();
  const touched: ManagedKey[] = [];
  for (const name of MANAGED_KEYS) {
    const value = stored[name];
    if (value === undefined) continue;
    if (fromRealEnvironment(name)) continue;
    env[name] = value;
    applied.add(name);
    touched.push(name);
  }
  return touched;
}

export interface KeyUpdate {
  /** Nouvelle valeur. `null` efface, `undefined` ou `''` conserve l'existante. */
  [name: string]: string | null | undefined;
}

export class KeyStoreError extends Error {
  // Affectation explicite, PAS une propriete de parametre (`readonly key` dans
  // la signature) : le service tourne sous `node --experimental-strip-types`,
  // qui retire les types sans les compiler et rejette cette syntaxe. Les tests
  // ne l'attrapent pas — vitest, lui, transpile.
  readonly key: string;

  constructor(message: string, key: string) {
    super(message);
    this.key = key;
  }
}

/**
 * Écrit des clés et les applique immédiatement au processus.
 *
 * Règle du champ vide alignée sur la console : laisser vide CONSERVE. Un
 * champ de mot de passe revient toujours vide à l'écran — l'interpréter comme
 * « efface » supprimerait la clé de quiconque enregistre les réglages sans y
 * toucher.
 */
export function setKeys(patch: KeyUpdate, env: NodeJS.ProcessEnv = process.env): KeyStatus[] {
  snapshotRealEnv(env);
  const stored = readStore();

  for (const [name, value] of Object.entries(patch)) {
    if (!isManagedKey(name)) {
      throw new KeyStoreError(`unknown key: ${name}`, name);
    }
    if (value === undefined || value === '') continue;
    if (fromRealEnvironment(name)) {
      throw new KeyStoreError(`${name} is set by the environment`, name);
    }
    if (value === null) {
      delete stored[name];
      delete env[name];
      applied.delete(name);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') continue;
    stored[name] = trimmed;
    env[name] = trimmed;
    applied.add(name);
  }

  writeStore(stored);
  return describeKeys(env);
}

/** État de chaque clé, sans jamais sa valeur. */
export function describeKeys(env: NodeJS.ProcessEnv = process.env): KeyStatus[] {
  snapshotRealEnv(env);
  return MANAGED_KEYS.map((name) => {
    const present = env[name] !== undefined && env[name] !== '';
    const locked = fromRealEnvironment(name);
    const source: KeySource = !present
      ? 'none'
      : locked
        ? 'environment'
        : applied.has(name)
          ? 'store'
          : 'dotenv';
    return { name, set: present, source, locked };
  });
}

/** Remet le module à zéro. Réservé aux tests. */
export function resetKeyStoreState(): void {
  realEnvKeys = null;
  applied.clear();
}
