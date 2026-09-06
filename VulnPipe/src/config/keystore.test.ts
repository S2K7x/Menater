/**
 * Tests du magasin de clés de moteur.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Ce module écrit dans `process.env` du service. Trois choses doivent tenir,
 * et aucune ne se voit à la relecture :
 *
 *   - la LISTE EST FERMÉE. `PATH` est lu par le fournisseur
 *     `claude-subscription` pour trouver un exécutable : un endpoint qui
 *     accepterait un nom de variable quelconque permettrait de le détourner ;
 *   - une clé posée par le shell ou Docker n'est JAMAIS écrasée en silence ;
 *   - un champ laissé vide CONSERVE. Un champ de mot de passe revient toujours
 *     vide à l'écran ; l'interpréter comme « efface » supprimerait la clé de
 *     quiconque enregistre les réglages sans y toucher.
 * ============================================================================
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyKeyStore,
  describeKeys,
  isManagedKey,
  KeyStoreError,
  resetKeyStoreState,
  setKeys,
  snapshotRealEnv,
} from './keystore.ts';

let dir: string;
let env: NodeJS.ProcessEnv;

const statusOf = (name: string) => describeKeys(env).find((k) => k.name === name)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vulnpipe-keys-'));
  process.env.VULNPIPE_KEYSTORE = join(dir, 'keys.json');
  resetKeyStoreState();
  env = {};
});

afterEach(() => {
  delete process.env.VULNPIPE_KEYSTORE;
  rmSync(dir, { recursive: true, force: true });
});

describe('liste fermée', () => {
  it('n’accepte que les variables de moteur', () => {
    expect(isManagedKey('OPENROUTER_API_KEY')).toBe(true);
    expect(isManagedKey('PATH')).toBe(false);
    expect(isManagedKey('NODE_OPTIONS')).toBe(false);
  });

  it('refuse d’écrire une variable hors liste', () => {
    expect(() => setKeys({ PATH: '/tmp/evil' }, env)).toThrow(KeyStoreError);
    expect(env.PATH).toBeUndefined();
  });
});

describe('écriture', () => {
  it('pose la clé dans process.env immédiatement — pas au prochain démarrage', () => {
    setKeys({ OPENROUTER_API_KEY: 'sk-or-123' }, env);
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-123');
  });

  it('persiste la clé sur disque, en 0600', () => {
    setKeys({ GEMINI_API_KEY: 'g-1' }, env);
    const path = process.env.VULNPIPE_KEYSTORE!;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ GEMINI_API_KEY: 'g-1' });
    // Le mode n'est verifiable que sur un systeme de fichiers POSIX.
    if (process.platform !== 'win32') {
      const { statSync } = require('node:fs');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('rogne les espaces autour d’une clé collée depuis un presse-papier', () => {
    setKeys({ GEMINI_API_KEY: '  g-2\n' }, env);
    expect(env.GEMINI_API_KEY).toBe('g-2');
  });

  it('CONSERVE la valeur quand le champ est laissé vide', () => {
    setKeys({ GEMINI_API_KEY: 'g-1' }, env);
    setKeys({ GEMINI_API_KEY: '' }, env);
    expect(env.GEMINI_API_KEY).toBe('g-1');
  });

  it('efface sur null, et seulement sur null', () => {
    setKeys({ GEMINI_API_KEY: 'g-1' }, env);
    setKeys({ GEMINI_API_KEY: null }, env);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(statusOf('GEMINI_API_KEY').set).toBe(false);
  });
});

describe('l’environnement réel gagne', () => {
  it('refuse d’écraser une clé posée par le shell, avec la raison', () => {
    env.ANTHROPIC_API_KEY = 'from-docker';
    resetKeyStoreState();
    describeKeys(env); // fige la photo de l'environnement reel

    expect(() => setKeys({ ANTHROPIC_API_KEY: 'from-ui' }, env)).toThrow(KeyStoreError);
    expect(env.ANTHROPIC_API_KEY).toBe('from-docker');
    expect(statusOf('ANTHROPIC_API_KEY')).toMatchObject({ source: 'environment', locked: true });
  });

  it('ne réapplique pas le magasin par-dessus l’environnement au démarrage', () => {
    setKeys({ OPENAI_API_KEY: 'stored' }, env);

    const boot: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'from-shell' };
    resetKeyStoreState();
    applyKeyStore(boot);
    expect(boot.OPENAI_API_KEY).toBe('from-shell');
  });

  it('applique le magasin quand l’environnement est muet', () => {
    setKeys({ OPENAI_API_KEY: 'stored' }, env);

    const boot: NodeJS.ProcessEnv = {};
    resetKeyStoreState();
    applyKeyStore(boot);
    expect(boot.OPENAI_API_KEY).toBe('stored');
    expect(describeKeys(boot).find((k) => k.name === 'OPENAI_API_KEY')).toMatchObject({
      set: true,
      source: 'store',
      locked: false,
    });
  });
});

describe('rien ne ressort', () => {
  it('ne renvoie jamais la valeur d’une clé', () => {
    setKeys({ OPENROUTER_API_KEY: 'sk-or-secret' }, env);
    expect(JSON.stringify(describeKeys(env))).not.toContain('sk-or-secret');
  });

  it('distingue absente, venue du .env, et venue du magasin', () => {
    // L'ORDRE EST CELUI DU DEMARRAGE REEL : la photo de l'environnement se
    // prend AVANT que `loadEnv()` ne verse le `.env`. C'est elle seule qui
    // permet ensuite de dire « celle-ci vient du shell, celle-la du fichier ».
    snapshotRealEnv(env);
    env.GEMINI_API_KEY = 'from-dotenv'; // posee par loadEnv, pas par le shell
    setKeys({ OPENROUTER_API_KEY: 'k' }, env);

    expect(statusOf('GEMINI_API_KEY')).toMatchObject({ set: true, source: 'dotenv' });
    expect(statusOf('OPENROUTER_API_KEY')).toMatchObject({ set: true, source: 'store' });
    expect(statusOf('OPENAI_API_KEY')).toMatchObject({ set: false, source: 'none' });
  });
});

describe('magasin illisible', () => {
  it('ne fait pas tomber le démarrage', () => {
    const path = process.env.VULNPIPE_KEYSTORE!;
    require('node:fs').mkdirSync(dir, { recursive: true });
    require('node:fs').writeFileSync(path, '{ pas du json');
    expect(existsSync(path)).toBe(true);
    expect(() => applyKeyStore({})).not.toThrow();
  });
});
