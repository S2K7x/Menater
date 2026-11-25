/**
 * The suite must not be able to reach a database an operator owns.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `vitest.config.ts` already points three sinks at paths that do not exist —
 * `config.json`, the credential store, the poller's cursors — and the comment
 * on the third states the rule for all of them: the suite both READS and
 * WRITES them, so a run would otherwise re-point a developer's real
 * installation at whatever a test made up. The VulnPipe cache paid for that
 * lesson, and got TWO locks for it.
 *
 * THE DATABASE IS THE FOURTH SINK, IT IS THE ONE THE SUITE REALLY WRITES, AND
 * IT HAD NO LOCK. `MENATER_CONFIG` pointing nowhere makes `getConfig()` return
 * its DEFAULTS — and the defaults are `localhost:5432`, database `menater`,
 * user `n8n_soc`, empty password, which is exactly what `docker compose up`
 * publishes. So on the machine of anybody running the documented installation,
 * `npm test` dialled their console's own journal and wrote to it.
 *
 * Measured on a real PostgreSQL 16 standing at those coordinates with the
 * schema `docker/init-db.sh` applies: one `npm test` wrote **11 runs, 89 run
 * steps, 2 deduplication rows and 2 audit rows**, and two tests failed — one
 * of them differently depending on which files had run before it, because they
 * were sharing a database. Three of those four tables can be cleaned up by
 * hand. `soc_audit_log` cannot: it is append-only, `TRUNCATE` is refused by
 * `soc_audit_immutable()` and `DELETE` by the `REVOKE` in `sql/10-engine.sql`,
 * so a test run left permanent rows in the hash chain that is this product's
 * only tamper-evidence. And `soc_ingested_alerts` has NO EXPIRY, so an alert
 * id a test invented decided for ever that a real alert of that id was a
 * duplicate.
 *
 * WHY THE LOCK IS THE DATABASE NAME AND DELIBERATELY NOT THE HOST. The
 * database block is the one setting the environment OWNS: `applyEnvOverrides`
 * makes those six variables win over the file, on a cold read AND on a save.
 * So a host set for the whole suite does not merely redirect the default — it
 * overrides the coordinates a test CHOSE, and five tests choose `127.0.0.1:1`
 * on purpose to provoke a refusal whose cause `describePgError` has to
 * recover. Measured: with the host locked, those five fail and the suite loses
 * the ability to test a connection failure at all. The NAME takes nothing
 * away, because no test asserts on it — the one test that needs a real
 * database takes its coordinates from a variable of its own, which is the
 * boundary claimed at the bottom of this file.
 *
 * EVERY CLAIM HERE IS ABOUT THE CONFIG FILE OR THE RESOLVED CONFIGURATION, and
 * none of them reads the ambient process. That is not a style choice: a test
 * file that reads an environment variable the suite does not set IS the shape
 * `ci-environment.test.ts` reports as a gate, and this file is not gated on
 * anything — it asserts. Reading the lock where it is DECLARED also makes the
 * claim the right one: the lock is a property of the configuration, not of
 * whatever happens to be exported in the shell.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `dashboard/`, then the repository root above it. */
const CONSOLE = resolve(import.meta.dirname, '..');
const REPO = resolve(CONSOLE, '..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

/**
 * COMMENTS GO FIRST, and that is load-bearing rather than tidiness: the env
 * block in `vitest.config.ts` is explained by a paragraph that NAMES the
 * variable this file refuses, so a search over the raw text would be satisfied
 * by the prose describing the decision instead of by the decision. That is the
 * `n8n-removed.test.ts` lesson, and `ci-environment.test.ts` paid for it once
 * already in a mutation.
 */
function withoutComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The variables `vitest.config.ts` sets for the whole suite, and their values. */
function configuredEnv(): Record<string, string> {
  const source = withoutComments(read('dashboard/vitest.config.ts'));
  const block = /env:\s*\{([\s\S]*?)\n\s*\},/.exec(source);
  expect(block, 'vitest.config.ts: no env block — this reader has gone stale').not.toBeNull();
  const out: Record<string, string> = {};
  for (const m of block![1].matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
  // A reader that parsed nothing would make every claim below vacuous, which
  // is how a guard passes over the hole it was written for.
  expect(Object.keys(out).length, 'parsed no variable out of the env block').toBeGreaterThan(0);
  return out;
}

/**
 * Read on first use and not at module load, so that a reader which has gone
 * stale fails as the CLAIM it belongs to rather than as a collection error:
 * a file that throws on import reports no test at all, and a mutation harness
 * then sees a different total instead of a named failure.
 */
let parsed: Record<string, string> | null = null;
const configured = (): Record<string, string> => (parsed ??= configuredEnv());
const locked = (): string | undefined => configured().MENATER_DB_NAME;

/**
 * `config.ts`'s own default, read by booting it COLD with the lock cleared,
 * rather than by copying the literal here. That is what makes the comparison
 * below a real one: a change to the default is followed, where a guard holding
 * a hardcoded `menater` would go on passing the day somebody renamed it.
 */
async function defaultDatabaseName(): Promise<string> {
  vi.resetModules();
  vi.stubEnv('MENATER_DB_NAME', undefined);
  vi.stubEnv('MENATER_CONFIG', '/nonexistent/menater-suite-isolation.json');
  const { getConfig } = await import('./config.ts');
  const name = getConfig().database.database;
  vi.unstubAllEnvs();
  vi.resetModules();
  return name;
}

describe('the database this suite is pointed at', () => {
  it('is named by the suite, so no test inherits the shipped default', () => {
    expect(
      locked(),
      'vitest.config.ts must set MENATER_DB_NAME in its env block. Without it '
      + '`getConfig()` returns the shipped defaults — localhost:5432/menater as '
      + 'n8n_soc — and the suite writes into the run journal and the append-only '
      + 'audit chain of whatever console is running on this machine.',
    ).toBeTruthy();
  });

  it('is not the name this product itself defaults to', async () => {
    const shipped = await defaultDatabaseName();
    // The floor: a boot that answered nothing would make the comparison vacuous.
    expect(shipped.length).toBeGreaterThan(0);
    expect(locked()).not.toBe(shipped);
  });

  it('is not the name a `docker compose up` creates', () => {
    // The deployed stack is handed `MENATER_DB_NAME: ${POSTGRES_DB:-…}`, so the
    // name it uses is that compose default. Read, not assumed — and the match
    // is asserted, because a regex that found nothing would agree with any
    // lock at all.
    const compose = read('docker-compose.yml');
    const deployed = /MENATER_DB_NAME:\s*\$\{POSTGRES_DB:-([A-Za-z0-9_-]+)\}/.exec(compose);
    expect(deployed, 'docker-compose.yml no longer names the database the console reads').not.toBeNull();
    expect(locked()).not.toBe(deployed![1]);
  });

  it('is the name the engine would actually dial', async () => {
    // A variable being DECLARED is not the same fact as the configuration the
    // engine reads resolving to it: `applyEnvOverrides` is what carries one to
    // the other. This is the end of that path, and it is the claim that fails
    // if the lock is spelled correctly and applied to nothing.
    vi.resetModules();
    const { getConfig } = await import('./config.ts');
    expect(getConfig().database.database).toBe(locked());
  });

  /**
   * THE BOUNDARY, and it passes before and after this lock on purpose.
   *
   * `store-contract.test.ts` is the one file that wants a REAL database — it
   * runs the same assertions against both `RunStore` implementations, and CI
   * provides one. It must take its coordinates from its own variable and never
   * from the console's configuration, or the lock above would silently switch
   * those assertions off: green, and comparing nothing. That is the defect
   * `ci-environment.test.ts` exists for, and this is the half of it that the
   * lock could newly cause.
   */
  it('does not reach the one test that wants a real database', () => {
    const contract = withoutComments(read('dashboard/server/engine/store-contract.test.ts'));
    expect(contract).toContain('MENATER_TEST_PG');
    expect(contract).not.toMatch(/from '\.\.\/config\.ts'/);
  });

  /**
   * THE COMMENT STRIP, CLAIMED ON A LITERAL — because no mutation of the real
   * file can kill it, and that was measured rather than assumed: with the
   * strip removed, a lock commented out is still caught, by "the engine would
   * actually dial it" one claim up. So the strip is not what stops a false
   * GREEN; it is what stops a false RED. A paragraph in that env block
   * explaining which variables must NOT be set is prose a value-reader would
   * otherwise report as a variable that IS set, and this console's whole risk
   * grammar rests on a red being worth believing.
   *
   * Claimed here the way `ci-environment.test.ts` answers the same problem:
   * two guards where one suffices is a line no test can fail on, so the first
   * one is made load-bearing instead of being deleted.
   */
  it('reads the block and not the paragraph explaining it', () => {
    const sample = [
      '    env: {',
      '      /* Lock the NAME. Never MENATER_DB_HOST: \'anything\' — it would',
      '         override the coordinates a test chose. */',
      "      // MENATER_DB_PORT: '1',",
      "      MENATER_DB_NAME: 'kept',",
      '    },',
    ].join('\n');
    const block = /env:\s*\{([\s\S]*?)\n\s*\},/.exec(withoutComments(sample));
    expect(block).not.toBeNull();
    const names = [...block![1].matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual(['MENATER_DB_NAME']);
  });

  /**
   * THE LOCK'S OWN SHAPE, claimed because the plausible "strengthening" is to
   * move it to the host — and that is measurably worse. See the header.
   */
  it('leaves the host and the port alone, which are the fields tests choose', () => {
    expect(
      Object.keys(configured()).sort(),
      'A host or port set for the whole suite overrides the coordinates a test '
      + 'saved, because the environment wins over the file by design. The five '
      + 'tests that provoke a connection refusal at 127.0.0.1:1 lose their '
      + 'subject. Lock the database NAME, not the address.',
    ).not.toContain('MENATER_DB_HOST');
    expect(Object.keys(configured())).not.toContain('MENATER_DB_PORT');
  });
});
