/**
 * The lockfile must describe THIS package.
 *
 * ============================================================================
 * THE FAILURE THESE PREVENT FROM COMING BACK
 *
 * `VulnPipe/package-lock.json` carried the CONSOLE's devDependency list in its
 * root block: `@testing-library/react`, `react`, `react-dom`, `vite`, `jsdom`,
 * `concurrently`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`,
 * `@testing-library/user-event` — ten packages this half declares nowhere.
 * Someone had run an npm command in the wrong directory, and nothing said so:
 * `npm ci` reconciles against `package.json` and installs the real set, so the
 * suite, the typecheck and CI were all green over it.
 *
 * What it cost is the thing a lockfile exists to be. The lockfile is the claim
 * under test — CI runs `npm ci`, never `npm install`, precisely so that the
 * next machine gets the tree this one had. A root block describing another
 * package makes that claim about the wrong package, and it froze the
 * transitive tree around a resolution nobody could refresh: `npm update` on
 * this half pruned 595 lines before it changed a single version, so the one
 * command that closes a published advisory looked like a rewrite nobody would
 * dare review. Three production advisories sat behind that.
 *
 * The rule is checked on BOTH halves from here rather than on this one alone.
 * This repository's traps table has paid four times for the mirror of a rule
 * not being the rule — `readCapped` careful about everything the inbound cap
 * was not, `redirect: 'manual'` on one call site out of eight, the n8n sweep
 * that walked one catalogue of two. The console's lockfile is clean today and
 * these assertions pass before and after: that is the point of claiming it.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The two package roots of this repository, relative to `VulnPipe/src/`. */
const HALVES = [
  { half: 'VulnPipe', root: '../' },
  { half: 'dashboard', root: '../../dashboard/' },
] as const;

function readJson(root: string, file: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(root + file, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/**
 * npm omits an empty `dependencies` / `devDependencies` rather than writing
 * `{}`, so an absent block and an empty one are the same claim.
 */
function block(source: Record<string, unknown>, key: string): Record<string, string> {
  return (source[key] as Record<string, string> | undefined) ?? {};
}

describe.each(HALVES)('$half — package-lock.json describes package.json', ({ root }) => {
  const pkg = readJson(root, 'package.json');
  const lock = readJson(root, 'package-lock.json');
  const rootBlock = (lock.packages as Record<string, Record<string, unknown>>)[''];

  it('names the same package', () => {
    // A wholesale copy from the other half changes these first.
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(rootBlock.name).toBe(pkg.name);
  });

  it('pins the declared dependencies, and only those', () => {
    // Compared as whole objects, not as name lists: a lock claiming a range
    // the manifest no longer asks for is the same defect, one field in.
    expect(block(rootBlock, 'dependencies')).toEqual(block(pkg, 'dependencies'));
  });

  it('pins the declared devDependencies, and only those', () => {
    // This is the assertion that was RED: ten entries belonging to the console.
    expect(block(rootBlock, 'devDependencies')).toEqual(block(pkg, 'devDependencies'));
  });
});

/**
 * A resolution moved to close a published advisory must not slide back.
 *
 * ============================================================================
 * WHY A FLOOR, AND WHY A HAND-WRITTEN ONE
 *
 * `npm audit` is the only thing in this repository that can see a published
 * advisory sitting in the tree, and nothing runs it: CI runs `npm ci`,
 * typecheck, the suite and the build, and all four are green over a vulnerable
 * transitive dependency. That is how fifteen advisories across the two halves
 * — four on `ip-address` in VulnPipe's PRODUCTION tree, eleven on `undici` in
 * the console's dev tree — sat here with every check passing.
 *
 * The obvious guard is to run `npm audit` from a test. It is the wrong one: it
 * needs the network, so it is the flaky kind this project has removed twice,
 * and a new upstream advisory would turn the suite red overnight with nobody
 * to act on it — a check that fails for something the diff did not do.
 *
 * So this asserts the one thing that IS offline and deterministic: the version
 * each refresh moved to, as a FLOOR taken from the advisory's own boundary
 * rather than a pin to whatever npm resolved on the day. A newer version keeps
 * passing; only a lockfile that resolves back INTO the vulnerable range fails.
 * What it cannot do is notice the NEXT advisory, and no offline test can.
 *
 * It also asserts the entry is still in the tree, so a row whose package has
 * gone fails and asks to be deleted instead of passing over nothing.
 * ============================================================================
 */
const ADVISORY_FLOORS = [
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/ip-address',
    // `<= 10.7.0`: GHSA-rpw4-54j3-4h4q and GHSA-2vr4-cq9g-pvrc (SSRF and
    // trust-boundary bypass, fe80::/64 for fe80::/10 and the NAT64 range),
    // GHSA-j6r3-76f7-8jcv (cross-family subnet comparison admits an address
    // outside an allowlist), GHSA-h3mg-xc3c-68pw (unbounded parse diagnostic).
    // Arrives through @modelcontextprotocol/sdk -> express-rate-limit.
    floor: '10.7.1',
  },
  {
    half: 'dashboard',
    root: '../../dashboard/',
    path: 'node_modules/undici',
    // `8.0.0 - 8.10.1`: eleven advisories, high. Arrives through jsdom, i.e.
    // the vitest environment, and `dashboard/Dockerfile` installs the runtime
    // image with `--omit=dev`, so it never ships.
    floor: '8.10.2',
  },
] as const;

/**
 * A release version as three numbers.
 *
 * Throws on anything else rather than comparing it: `10.8.0-rc.1` would sort
 * above a `10.7.1` floor while carrying no promise about the fix, and a range
 * is not a resolution at all.
 */
function release(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a plain release version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isAtLeast(version: string, floor: string): boolean {
  const a = release(version);
  const b = release(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe.each(ADVISORY_FLOORS)('$half — $path stays above its advisory floor', ({ root, path, floor }) => {
  const lock = readJson(root, 'package-lock.json');
  const entry = (lock.packages as Record<string, { version?: string } | undefined>)[path];

  it('is still in the tree', () => {
    // If it has gone, the floor above protects nothing: delete the row rather
    // than leave an assertion that passes over an absent package.
    expect(entry, `${path} is no longer in this lockfile — remove its floor`).toBeDefined();
  });

  it(`resolves at or above ${floor}`, () => {
    const version = String(entry?.version);
    expect(isAtLeast(version, floor), `${path} is ${version}, inside a published advisory`).toBe(
      true,
    );
  });
});

/**
 * The comparator, on both sides of a floor.
 *
 * The guard above cannot check its own ruler: every entry is comfortably above
 * its floor today, so a comparator that always answered `true` would be
 * indistinguishable from a working one — and this project has already paid for
 * a measurement that quietly measured something else. The case that matters is
 * `9.9.9` against `10.7.1`: a string comparison answers that '9' > '1' and
 * waves a vulnerable major straight through.
 */
describe('the advisory floor comparator', () => {
  it('reads the numbers, not the characters', () => {
    expect(isAtLeast('9.9.9', '10.7.1')).toBe(false);
    expect(isAtLeast('10.7.0', '10.7.1')).toBe(false);
    expect(isAtLeast('10.7.1', '10.7.1')).toBe(true);
    expect(isAtLeast('10.8.0', '10.7.1')).toBe(true);
    expect(isAtLeast('11.0.0', '10.7.1')).toBe(true);
  });

  it('refuses anything that is not a plain release', () => {
    // A prerelease sorts above the floor and promises nothing about the fix.
    expect(() => isAtLeast('10.8.0-rc.1', '10.7.1')).toThrow(/not a plain release/);
    expect(() => isAtLeast('^10.7.3', '10.7.1')).toThrow(/not a plain release/);
    expect(() => isAtLeast('undefined', '10.7.1')).toThrow(/not a plain release/);
  });
});
