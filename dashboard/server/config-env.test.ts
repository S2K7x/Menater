/**
 * The database block, and the one setting in this console the environment owns.
 *
 * `applyEnvOverrides` exists for a reason written in its own header: a
 * `config.json` laid down at first start with the `localhost` default must not
 * mask a deployment decision for ever, or "the engine keeps looking for a
 * database inside its own container". The Settings screen says the same thing
 * to the operator — "In Docker these come from the environment, which wins
 * over what is saved here … it does not redirect a running stack."
 *
 * These tests claim that sentence. Three of them are about the half that was
 * NOT true: the override was applied by `getConfig()` on a cold read and by
 * nothing else, so a save re-pointed the live process at whatever had been
 * typed — `connectionString`, the engine and the scheduler with it — and a
 * restart silently put the environment back. A setting that looks applied and
 * is not, with the two states one container restart apart.
 *
 * The fourth and fifth claim the boundary, and they pass before and after on
 * purpose: a field the environment does NOT name is saved normally, and
 * `meta.from_env` must not name one either. A fix that locked the whole
 * database block would be a different defect wearing the same fix.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let file: string;

/** The coordinates a `config.json` holds before anybody sets a variable. */
const STORED = {
  database: {
    host: 'from-file.local',
    port: 5432,
    database: 'menater',
    user: 'menater',
    password: 'file-password',
    ssl: false,
    preset: 'local' as const,
  },
};

/**
 * A fresh load of `server/config.ts`, under the variables given.
 *
 * The module caches the resolved configuration in a module-level `cached`, and
 * reads `MENATER_CONFIG` at import time — so a test that wants a COLD read
 * (which is what a restart is) has to reset the registry and import again.
 */
async function boot(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('MENATER_CONFIG', file);
  return import('./config.ts');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'menater-config-env-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(STORED));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('the database coordinates the environment owns', () => {
  it('wins over the file on a cold read', async () => {
    const { getConfig } = await boot({ MENATER_DB_HOST: 'from-env.local' });
    expect(getConfig().database.host).toBe('from-env.local');
  });

  /**
   * THE DEFECT. The Settings page's own sentence promises this: the screen
   * "does not redirect a running stack". It did — `saveConfig` ended with
   * `cached = next`, the only place in the module that installs a
   * configuration without passing it through the override.
   */
  it('a save does not re-point the live process at what was typed', async () => {
    const { getConfig, saveConfig, connectionString } = await boot({
      MENATER_DB_HOST: 'from-env.local',
    });

    saveConfig({ database: { ...getConfig().database, host: 'typed-by-operator.local' } });

    expect(getConfig().database.host).toBe('from-env.local');
    expect(connectionString(true)).toContain('from-env.local');
    expect(connectionString(true)).not.toContain('typed-by-operator.local');
  });

  /**
   * The same claim read from the other end: whatever a save leaves behind, a
   * restart must agree with it. Two answers one container restart apart is the
   * shape an operator cannot debug, because both of them look like the
   * console's considered opinion.
   */
  it('leaves the process in the state a restart would produce', async () => {
    const first = await boot({ MENATER_DB_HOST: 'from-env.local' });
    first.saveConfig({ database: { ...first.getConfig().database, host: 'typed-by-operator.local' } });
    const afterSave = first.getConfig().database;

    const second = await boot({ MENATER_DB_HOST: 'from-env.local' });
    expect(second.getConfig().database).toEqual(afterSave);
  });

  /**
   * And the value that was refused must not be sitting in the file waiting for
   * the day somebody removes the variable. The environment wins at every
   * moment, not only while the process that read it is alive.
   */
  it('does not leave the refused value in the file', async () => {
    const { getConfig, saveConfig } = await boot({ MENATER_DB_HOST: 'from-env.local' });
    saveConfig({ database: { ...getConfig().database, host: 'typed-by-operator.local' } });

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.database.host).toBe('from-env.local');

    const { getConfig: afterRemoval } = await boot();
    expect(afterRemoval().database.host).toBe('from-env.local');
  });

  /** The boundary: a field nobody named is an ordinary setting. */
  it('saves a field the environment does not name', async () => {
    const { getConfig, saveConfig } = await boot({ MENATER_DB_HOST: 'from-env.local' });
    saveConfig({ database: { ...getConfig().database, user: 'typed-by-operator' } });

    expect(getConfig().database.user).toBe('typed-by-operator');
    expect(JSON.parse(readFileSync(file, 'utf8')).database.user).toBe('typed-by-operator');
  });
});

describe('what the screen is told about it', () => {
  /**
   * `meta.from_env` was written by the server and read by nothing, and it
   * covered TWO of the six fields `applyEnvOverrides` can move. Its own
   * comment states the rule it exists for — "a field that is already filled
   * must say where it came from, or someone rewrites it without understanding
   * why it keeps coming back" — so the half that was missing is the half that
   * says it.
   *
   * Both directions, out of one table: `DB_ENV` is what the override reads AND
   * what the screen is told, so a seventh variable cannot be added without the
   * screen learning its name.
   */
  it('names every field the environment can move, and the variable that moved it', async () => {
    const { publicView, DB_ENV } = await boot({
      MENATER_DB_HOST: 'h',
      MENATER_DB_PORT: '6543',
      MENATER_DB_NAME: 'n',
      MENATER_DB_USER: 'u',
      MENATER_DB_PASSWORD: 'p',
      MENATER_DB_SSL: 'true',
    });

    expect(publicView().meta.from_env.database).toEqual(DB_ENV);
  });

  it('every entry of that table really moves its field', async () => {
    const cold = await boot();
    const before = { ...cold.getConfig().database };

    const hot = await boot({
      MENATER_DB_HOST: 'h',
      MENATER_DB_PORT: '6543',
      MENATER_DB_NAME: 'n',
      MENATER_DB_USER: 'u',
      MENATER_DB_PASSWORD: 'p',
      MENATER_DB_SSL: 'true',
    });
    const after = hot.getConfig().database;

    const moved = Object.keys(hot.DB_ENV).filter(
      (f) => (after as any)[f] !== (before as any)[f],
    );
    expect(moved.sort()).toEqual(Object.keys(hot.DB_ENV).sort());
  });

  /** A field nobody set is absent, so the screen cannot lock it. */
  it('says nothing about a field no variable names', async () => {
    const { publicView } = await boot({ MENATER_DB_HOST: 'from-env.local' });
    expect(publicView().meta.from_env.database).toEqual({ host: 'MENATER_DB_HOST' });
  });
});
