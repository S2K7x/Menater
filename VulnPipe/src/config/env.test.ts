/**
 * Le bug qui a motivé `src/config/env.ts` : le serveur annonçait
 * « GEMINI_API_KEY absente du fichier .env » alors que la clé y était — parce
 * que personne n'ouvrait jamais ce fichier.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyAliases, loadEnv, parseEnvFile } from './env.ts';

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vulnpipe-env-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('lit les formes usuelles : commentaires, export, guillemets', () => {
    const parsed = parseEnvFile(
      [
        '# un commentaire',
        '',
        'SIMPLE=valeur',
        'export EXPORTE=autre',
        'DOUBLE="avec espaces"',
        "SIMPLE_QUOTE='brut'",
        'MULTI="ligne1\\nligne2"',
        'PAS_UNE_LIGNE',
      ].join('\n')
    );

    expect(parsed).toEqual({
      SIMPLE: 'valeur',
      EXPORTE: 'autre',
      DOUBLE: 'avec espaces',
      SIMPLE_QUOTE: 'brut',
      MULTI: 'ligne1\nligne2',
    });
  });

  it("ne tronque pas une valeur contenant un dièse", () => {
    // Une clé d'API peut contenir un `#`. La couper produirait une erreur
    // d'authentification incompréhensible, très loin de sa cause.
    expect(parseEnvFile('CLE=abc#def').CLE).toBe('abc#def');
  });
});

describe('loadEnv', () => {
  it('injecte les variables du fichier .env', () => {
    const dir = fixture({ '.env': 'GEMINI_API_KEY=depuis-le-fichier\n' });
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnv({ cwd: dir, env });

    expect(env.GEMINI_API_KEY).toBe('depuis-le-fichier');
    expect(result.applied).toContain('GEMINI_API_KEY');
    expect(result.files).toHaveLength(1);
  });

  it("n'écrase jamais une variable déjà définie par le shell", () => {
    // Sinon un `.env` oublié sur un poste remplacerait silencieusement les
    // secrets d'un déploiement.
    const dir = fixture({ '.env': 'GEMINI_API_KEY=du-fichier\n' });
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'du-shell' };

    const result = loadEnv({ cwd: dir, env });

    expect(env.GEMINI_API_KEY).toBe('du-shell');
    expect(result.skipped).toContain('GEMINI_API_KEY');
  });

  it('ne panique pas quand aucun fichier .env n\'existe', () => {
    const dir = fixture({});
    expect(loadEnv({ cwd: dir, env: {} }).files).toEqual([]);
  });

  it('normalise OPEN_ROUTER_API_KEY vers le nom canonique', () => {
    // Les deux orthographes circulent ; le reste du code n'en connaît qu'une.
    const env: NodeJS.ProcessEnv = { OPEN_ROUTER_API_KEY: 'sk-test' };
    applyAliases(env);
    expect(env.OPENROUTER_API_KEY).toBe('sk-test');
  });

  it('.env.local prime sur .env', () => {
    // Convention habituelle : `.env` est le réglage partagé, `.env.local` la
    // surcharge personnelle. La surcharge doit gagner, sinon elle ne sert à rien.
    const dir = fixture({ '.env': 'PORT=1111\n', '.env.local': 'PORT=2222\n' });
    const env: NodeJS.ProcessEnv = {};
    loadEnv({ cwd: dir, env });
    expect(env.PORT).toBe('2222');
  });
});
