/**
 * A conditional test is a CLAIM ABOUT AN ENVIRONMENT. This file checks the
 * claim is met.
 *
 * ============================================================================
 * WHAT WAS WRONG
 *
 * `server/engine/store-contract.test.ts` exists for one reason, and says so in
 * its own header: `RunStore` has two implementations, nothing naturally keeps
 * them in step, and a divergence would show up only in production, on the
 * resume of an interrupted run — the worst possible moment. So it runs the
 * SAME 33 assertions against `MemoryRunStore` and against `PgRunStore`.
 *
 * Its Postgres half is gated on `MENATER_TEST_PG`, and that variable had never
 * been set ANYWHERE: not on a developer's machine, and not in
 * `.github/workflows/ci.yml`. So the file written to stop the two stores
 * diverging had never once compared them, and every green check on this
 * repository vouched for a comparison that does not happen.
 *
 * The first time it ran — 2026-11-15, by hand, against a real PostgreSQL 16 —
 * it was RED on unmodified `main` and reported exactly the drift it exists to
 * catch: `MemoryRunStore.resolveWait` threw `jeton d'attente inconnu` where
 * `PgRunStore` throws `unknown wait token`, and `routes/approvals.ts` puts that
 * message on screen, so an operator was answered in French or in English
 * depending on which store was mounted.
 *
 * `CLAUDE.md`'s own traps table ends that row with a sentence that is a
 * specification for a test nobody had written: *"the lesson is not delete the
 * gate: it is that a conditional test is a claim about an environment, and
 * nothing was checking that claim was ever met."* **Nothing was.** This is it.
 *
 * ============================================================================
 * TWO DETECTORS, BECAUSE NEITHER ONE IS ENOUGH
 *
 * A gate can be written two ways, and they fail differently:
 *
 *   `describe.skip(…)` in an `else`   vitest PRINTS `skipped`, which is at
 *                                     least visible in the run's output
 *   `if (process.env.X) { describe(…) }`  with no `else`, the tests simply are
 *                                     not there — no `skipped` line, nothing
 *
 * So one rule looks for the skip CONSTRUCTS vitest reports, and the other for
 * an environment variable a test file READS without ever assigning it, which
 * is what a gate looks like whichever shape it takes. Measured over the 152
 * test files of both halves: each rule finds exactly one file, the same one.
 * A rule that found nothing would be a broken ruler, so a floor is asserted on
 * the corpus as well.
 *
 * The variables `vitest.config.ts` sets are not gates — they are the locks
 * that stop the suite reading a developer's real configuration — and the
 * exemption is READ OUT of those files rather than listed here, so it cannot
 * drift from them.
 *
 * ============================================================================
 * WHAT THIS CANNOT CLAIM
 *
 * It reads `ci.yml` as TEXT with its comments removed, scoped to the job block
 * that runs the suite in question. It does not parse YAML (this half has one
 * production dependency and it is `pg`), so it proves the variable is NAMED in
 * the right job — not that the job's database answers.
 *
 * What proves THAT is the gated half itself, and it needs no help from here:
 * measured, `MENATER_TEST_PG` pointing at a closed port gives
 * **33 failed | 33 passed**, not a skip. So a service container that is
 * removed, or that does not come up, turns CI red — first on the schema step,
 * then on these 33 assertions. The one failure mode this file exists for is
 * the opposite one: the variable quietly going away, which is silent
 * everywhere else because a skip is not a failure.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** `dashboard/`, then the repository root above it. */
const CONSOLE = resolve(import.meta.dirname, '..');
const REPO = resolve(CONSOLE, '..');

const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

/**
 * Comments go, and that is load-bearing rather than hygiene: this file's own
 * prose names `describe.skip` and `MENATER_TEST_PG`, and so does the header of
 * the file it is about. A sweep over raw text would be satisfied by the
 * explanation of the defect instead of by the defect.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * The two halves' suites, each with the vitest config whose `env` block is the
 * set of variables that are NOT gates, and the `ci.yml` job that runs it.
 */
const SUITES = [
  { dir: 'dashboard/server', config: 'dashboard/vitest.config.ts', job: 'console' },
  { dir: 'dashboard/src', config: 'dashboard/vitest.config.ts', job: 'console' },
  { dir: 'VulnPipe/src', config: 'VulnPipe/vitest.config.ts', job: 'vulnpipe' },
] as const;

/**
 * EVERY environment-gated half of this repository's suites, one entry per test
 * file, with the job that must provide the environment.
 *
 * Asserted in BOTH directions: a gate added anywhere without an entry fails,
 * and an entry whose file no longer gates fails and asks to be deleted rather
 * than passing over nothing.
 */
const GATED: Record<string, { variable: string; job: string; why: string }> = {
  'dashboard/server/engine/store-contract.test.ts': {
    variable: 'MENATER_TEST_PG',
    job: 'console',
    why:
      'The RunStore contract, run against BOTH implementations. The Postgres '
      + 'half needs a database; without one the two stores are never compared, '
      + 'which is the whole reason the file exists.',
  },
};

/** Every test file of a suite, repository-relative. */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.test\.tsx?$/.test(name)) out.push(relative(REPO, full));
    }
  };
  walk(join(REPO, dir));
  return out.sort();
}

/** The variables a vitest config sets for its whole suite. Not gates. */
function configuredEnv(config: string): Set<string> {
  const block = stripComments(read(config)).match(/env:\s*\{([\s\S]*?)\n\s*\},/);
  expect(block, `${config}: no env block — this reader has gone stale`).toBeTruthy();
  return new Set([...block![1].matchAll(/([A-Z][A-Z0-9_]*)\s*:/g)].map((m) => m[1]));
}

/**
 * The variables a file reads and never writes. Assigning one is the suite
 * pointing a module at a fixture; reading one it never set is a gate.
 */
function readOnlyEnv(file: string, configured: Set<string>): string[] {
  const source = stripComments(read(file));
  const reads = new Set([
    ...[...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
    ...[...source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)].map((m) => m[1]),
  ]);
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*=/g)) reads.delete(m[1]);
  for (const m of source.matchAll(/delete\s+process\.env\.([A-Z][A-Z0-9_]*)/g)) reads.delete(m[1]);
  for (const name of configured) reads.delete(name);
  return [...reads].sort();
}

/** The skip and conditional constructs vitest reports, if any. */
function skipConstructs(file: string): string[] {
  const source = stripComments(read(file));
  return [...source.matchAll(/\b(?:describe|it|test)\s*\.\s*(?:skip|todo|skipIf|runIf)\b/g)]
    .map((m) => m[0])
    .sort();
}

/**
 * One job's block of `ci.yml`, WITH ITS COMMENTS REMOVED. Scoped to the job,
 * because a variable named in the OTHER one provides nothing to this suite —
 * and the whole defect was a variable named nowhere.
 *
 * ==========================================================================
 * THE COMMENT STRIP IS THE HALF A MUTATION HAD TO FIND.
 *
 * The first version of this reader searched the job's raw text, and the
 * mutation that DELETES the `MENATER_TEST_PG` line from the `npm test` step
 * left it GREEN — because the paragraph above that job explains, at length,
 * that the suite is gated on `MENATER_TEST_PG`. The prose vouched for the
 * wiring it describes. That is the `n8n-removed.test.ts` lesson — *a test
 * whose own prose vouches for the strings it hunts* — committed inside the
 * test written to close this very family, and only mutation said so.
 *
 * It is a TEXT strip and not a YAML parse: this half has one production
 * dependency and it is `pg`. Whole comment lines go, and so does a trailing
 * comment introduced by two or more spaces, which is the form this file uses
 * (`node-version: '24'          # dashboard/Dockerfile`). A `#` inside a
 * quoted value would be eaten by that second rule; there is none, and a
 * `yaml` dependency to rule it out would cost more than it buys.
 * ==========================================================================
 */
function withoutYamlComments(yaml: string): string {
  return yaml.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]{2,}#.*$/gm, '');
}

function ciJob(job: string): string {
  const ci = withoutYamlComments(read('.github/workflows/ci.yml'));
  const start = ci.search(new RegExp(`^  ${job}:$`, 'm'));
  expect(start, `no job named "${job}" in ci.yml`).toBeGreaterThanOrEqual(0);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}\w[\w-]*:$/m);
  const block = rest.slice(0, next < 0 ? undefined : next);
  // A strip that removed everything would make the claim below vacuous.
  expect(block.trim().length, `the "${job}" job is empty once comments go`)
    .toBeGreaterThan(80);
  return block;
}

const corpus = SUITES.flatMap((s) =>
  testFiles(s.dir).map((file) => ({ file, suite: s })),
);

describe('the suite reads nothing from an environment CI does not provide', () => {
  it('finds every gated test file, and no other', () => {
    const gatedByConstruct = corpus
      .filter(({ file }) => skipConstructs(file).length > 0)
      .map(({ file }) => file);
    const gatedByRead = corpus
      .filter(({ file, suite }) => readOnlyEnv(file, configuredEnv(suite.config)).length > 0)
      .map(({ file }) => file);

    // BOTH detectors, because a gate written as a bare `if` prints no
    // `skipped` line and a `describe.skip('wip')` names no variable.
    expect(gatedByConstruct.sort()).toEqual(Object.keys(GATED).sort());
    expect(gatedByRead.sort()).toEqual(Object.keys(GATED).sort());
  });

  it('read enough files for that to mean something', () => {
    // A ruler that finds nothing agrees with everything. 152 at the time of
    // writing; the floor is what stops a broken walk passing.
    expect(corpus.length).toBeGreaterThanOrEqual(120);
    expect(Object.keys(GATED).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(GATED))(
    '%s really gates on the variable the table names',
    (file, entry) => {
      const suite = SUITES.find((s) => file.startsWith(s.dir));
      expect(suite, `${file} is in no suite this file knows about`).toBeTruthy();
      // The table cannot name a variable the file ignores: that would be an
      // entry vouching for a gate somebody has already removed.
      expect(readOnlyEnv(file, configuredEnv(suite!.config))).toContain(entry.variable);
      expect(entry.why.length, `${file}: an exemption with no written reason`)
        .toBeGreaterThan(40);
    },
  );

  it('does not let a comment vouch for the wiring it describes', () => {
    // The claim about the RULER, because the strip cannot be killed on its
    // own: with the wiring in place the variable is found either way, so the
    // mutation that deletes the strip is green until it is paired with the
    // one that deletes the wiring. Claimed here on a literal instead — and in
    // both directions, or a strip that removed everything would pass.
    const sample = [
      '  console:',
      '    # the suite is gated on MENATER_TEST_PG, wired further down',
      '    steps:',
      '      - run: npm test          # and not here either: MENATER_TEST_PG',
      '  vulnpipe:',
    ].join('\n');
    expect(withoutYamlComments(sample)).not.toContain('MENATER_TEST_PG');
    expect(withoutYamlComments(sample)).toContain('npm test');
  });

  it.each(Object.entries(GATED))(
    'CI gives %s the environment it is gated on',
    (file, entry) => {
      // THE CLAIM THAT WAS MISSING. Without it `MENATER_TEST_PG` was named in
      // one place — the test that skips without it — and CI stayed green over
      // 33 assertions that never ran.
      expect(
        ciJob(entry.job),
        `${file} is gated on ${entry.variable}, and the "${entry.job}" job of `
        + 'ci.yml does not provide it: those tests do not run anywhere',
      ).toContain(entry.variable);
    },
  );
});
