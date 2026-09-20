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
