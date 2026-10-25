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
    // `<= 10.7.3`: GHSA-rxp7-6hxx-x8q5 (Address6 matches a zone identifier in
    // quadratic time ahead of its length limit, so one long string stalls the
    // process), on top of the four this row was opened for at `<= 10.7.0` —
    // GHSA-rpw4-54j3-4h4q and GHSA-2vr4-cq9g-pvrc (SSRF and trust-boundary
    // bypass, fe80::/64 for fe80::/10 and the NAT64 range), GHSA-j6r3-76f7-8jcv
    // (cross-family subnet comparison admits an address outside an allowlist),
    // GHSA-h3mg-xc3c-68pw (unbounded parse diagnostic).
    //
    // THIS ROW IS THE LIMITATION ABOVE COMING TRUE, and it is worth the line.
    // The 10.7.1 floor held perfectly — the tree never slid back — and the
    // package was vulnerable again anyway, at 10.7.3, because the next
    // advisory was published ABOVE the boundary. A floor stops a regression;
    // nothing offline notices a new finding, which is why the § 7 decision
    // about running `npm audit` on a schedule is still open.
    //
    // Arrives through @modelcontextprotocol/sdk -> express-rate-limit.
    // NOT reachable here, measured rather than reasoned: 0 loads on all five
    // entry points this package imports, against 29 on `server/auth/router.js`
    // — the control — which it does not import.
    floor: '10.7.4',
  },
  {
    half: 'dashboard',
    root: '../../dashboard/',
    path: 'node_modules/undici',
    // `>= 8.0.0 < 8.12.2`: GHSA-xjj6-f33q-929c (unhandled error on excessive
    // content-encodings, high), GHSA-4qv8-2p9j-2685 (unbounded memory in the
    // EventSource parser) and GHSA-f72v-6w45-q472 (subresource-integrity
    // bypass through a non-lowercase algorithm token) — published above the
    // 8.10.2 floor this row was opened at, the same way `ip-address` was.
    // Arrives through jsdom, i.e. the vitest environment, and
    // `dashboard/Dockerfile` installs the runtime image with `--omit=dev`, so
    // it never ships.
    floor: '8.12.2',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/@modelcontextprotocol/sdk',
    // GHSA-6qxp-vccf-f47h, `>=1.12.0 <1.31.0`, high: an OAuth client could
    // send its credentials to an authorization server the MCP server chose.
    // This half's PRODUCTION tree, and a direct dependency.
    //
    // NOT reachable here, measured rather than reasoned: the OAuth module is
    // `dist/esm/client/auth.js`, and it loads 0 times on all five entry points
    // this package imports (`server/mcp.js`, `server/stdio.js`,
    // `client/index.js`, `client/stdio.js`, `inMemory.js`). The controls are
    // what make that zero worth reading — `client/auth.js` and `client/sse.js`,
    // which this package does NOT import, load it once each. VulnPipe speaks
    // stdio and reaches no authorization server.
    floor: '1.31.0',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/proxy-addr',
    // GHSA-jqcg-44mw-7w3h, `>=1.1.0 <2.0.8`, critical: IP spoofing through an
    // IPv4-mapped IPv6 trust subnet. This half's PRODUCTION tree, through
    // @modelcontextprotocol/sdk -> express.
    //
    // NOT reachable here, same instrument and same controls: 0 loads on the
    // five entry points this package imports, 1 CJS load on `server/express.js`
    // — which it does not import. Nothing here mounts an HTTP transport, so
    // there is no proxy header to trust in the first place.
    floor: '2.0.8',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/source-map-js',
    // GHSA-68fv-2mgg-jv7q, `>=1.0.0 <1.2.2`, high: event-loop denial of
    // service through indexed source-map section offsets. Arrives through
    // postcss, i.e. vite, i.e. the test environment. `VulnPipe/Dockerfile`
    // installs the runtime image with `--omit=dev`, so it never ships.
    floor: '1.2.2',
  },
  {
    half: 'dashboard',
    root: '../../dashboard/',
    path: 'node_modules/source-map-js',
    // The same advisory on the other half, through postcss and css-tree.
    // `dashboard/Dockerfile` also installs with `--omit=dev`.
    floor: '1.2.2',
  },
  {
    half: 'dashboard',
    root: '../../dashboard/',
    path: 'node_modules/shell-quote',
    // GHSA-pqg4-j6r4-53mv, `>=1.8.4 <1.11.0`, critical: `quote()` command
    // injection through a line terminator in a token after a `{ comment }`
    // token. Arrives through `concurrently`, which `npm run dev` uses to run
    // the three processes; dev-only, so it never ships.
    //
    // THE ROW TO READ BEFORE TOUCHING THIS ONE. `concurrently` depends on
    // `shell-quote` at an EXACT version, not a range — so the command that
    // names the package the advisory names cannot close it. Measured on the
    // vulnerable lockfile: `npm update shell-quote --package-lock-only` leaves
    // 1.9.0 at 1.9.0 and `npm audit` still reports it, with no error and no
    // output saying why. What moves it is `npm update concurrently`, because
    // 10.0.6 pins 1.12.0. The floor belongs on `shell-quote` all the same —
    // it is the package the boundary is about, and a future `concurrently`
    // could pin back into the range — but the fix is on the DEPENDENT.
    floor: '1.11.0',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/zod',
    // GHSA-mrhx-c7xc-m3w5, `< 4.6.6`, high: `$ZodArray` accumulates one issue
    // per failing element with no cap. A DIRECT dependency of this half's
    // PRODUCTION tree, and the only advisory in this list the product's own
    // source imports by name.
    //
    // READ THE TRAPS TABLE ROW BEFORE TRUSTING THE ADVISORY'S OWN WORDS. Its
    // description says the attack is « a large array to an application using
    // an array schema WITHOUT a length constraint »; measured on both versions
    // with a 1,000,000-element array of numbers, that is backwards. The
    // unconstrained schema is NOT fixed — 1,000,000 issues and ~450 MB of heap
    // on 4.6.7, where 4.4.3 took ~690 MB — and what the patch adds is a
    // short-circuit on an UPPER-BOUND length check: `.max(100)` goes from
    // 1,000,001 issues / 4,730 ms / +695 MB to 1 issue / 1 ms / +0 MB. So the
    // title (« constrained collections ») is the accurate half, and upgrading
    // buys nothing for a bare `z.array`.
    //
    // NOT reachable here, measured through the real server over
    // InMemoryTransport — the transport the detection nodes use: this package
    // declares no `z.array` at all, so a 1,000,000-element array sent where
    // `get_context` expects a string is refused in 3 ms with the heap
    // unmoved (one issue, not a million), and the same array under an
    // undeclared key is stripped by the tool's own `z.object`. The SDK's only
    // upper-bound-constrained array is `CompleteResultSchema.completion.values`
    // (`.max(100)`), parsed by a client that calls `completion/complete`;
    // `McpContextProvider` calls `callTool` and nothing else.
    floor: '4.6.6',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/body-parser',
    // GHSA-27r3-jxmh-p828, `>= 2.0.0 < 2.4.0`, high: denial of service through
    // trailing bytes after a compressed request body. This half's PRODUCTION
    // tree, through @modelcontextprotocol/sdk -> express.
    //
    // NOT reachable here, same instrument and same controls as the two rows
    // above: 0 loads on all five entry points this package imports, 22 on
    // `server/express.js`, which it does not import. Nothing here mounts an
    // HTTP transport, so no request body reaches a parser.
    floor: '2.4.0',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/fast-uri',
    // GHSA-w74x-v6f9-j3xg (URI scheme spoofing through a percent-encoded
    // scheme), GHSA-wjr9-j795-jxcr (host confusion through unchecked WHATWG
    // canonicalisation), GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp —
    // `>= 3.0.0 < 3.1.9`. This half's PRODUCTION tree.
    //
    // This one IS loaded, unlike every other transitive row here: 8 loads on
    // `server/mcp.js` and on `client/index.js`, through `ajv`, which the SDK
    // uses to validate tool schemas. What it resolves URIs for is the `$id` /
    // `$ref` of those schemas — which this package writes itself, from the two
    // raw shapes in `mcp-server/server.ts` — so there is no caller-supplied
    // URI to spoof. Loaded is not the same question as reachable, and both
    // answers belong in the row.
    floor: '3.1.9',
  },
  {
    half: 'VulnPipe',
    root: '../',
    path: 'node_modules/hono',
    // GHSA-5r4p-p66f-jhc7, `>= 4.12.4 < 4.13.11`: `serveStatic` decodes the
    // request path twice, so middleware on a static path can be bypassed.
    // This half's PRODUCTION tree, through the SDK's HTTP transport.
    //
    // NOT reachable here: 0 loads on all five entry points this package
    // imports, 1 on `server/streamableHttp.js` — the control — which it does
    // not import. This package speaks stdio and serves no static file.
    floor: '4.13.11',
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
 * The versions `mcp-server/server.ts` says it was probed against.
 *
 * ============================================================================
 * WHY THIS IS A TEST AND NOT A COMMENT
 *
 * That file opens with « SDK API ACTUALLY OBSERVED » and four claims about how
 * the SDK behaves, each one dated by naming the versions they were measured
 * on. That banner is the reason nobody re-probes: it reads as settled fact.
 *
 * It named 1.30.0 while the lockfile resolved something else, and one of its
 * four claims had stopped being true — the SDK now accepts a built
 * `z.object({...})` as `inputSchema`, where it used to refuse one. Nothing
 * failed, because a comment cannot fail. This repository's traps table calls
 * that « a stale name is the cheapest thing to carry and the most expensive
 * thing to believe », and the answer it reaches every time is the same: a
 * declaration that is also the query is checked in both directions.
 *
 * So each version the banner states is read out of the file and compared to
 * the resolution. A lockfile refresh that leaves the banner behind fails HERE,
 * which is the moment somebody is already looking at dependencies — rather
 * than in six months, against a measurement nobody can date.
 *
 * BOTH names in that banner are claimed, not only the one that was wrong.
 * The guard was written for `@modelcontextprotocol/sdk` and the line under it
 * — `zod : 4.4.3` — was left unchecked, so the advisory refresh that moved zod
 * two minors would have dated four claims with a version that had gone. The
 * mirror of a rule is not the rule, one LINE over this time; and zod is not
 * incidental to what the banner asserts, because the fourth claim is about how
 * an argument-validation failure comes back (`MCP error -32602`, handler
 * never called), which is zod's refusal travelling through the SDK.
 * ============================================================================
 */
const BANNER_VERSIONS = ['@modelcontextprotocol/sdk', 'zod'] as const;

describe.each(BANNER_VERSIONS)(
  'the MCP server banner names the %s version it was probed against',
  (pkg) => {
    const source = readFileSync(
      fileURLToPath(new URL('./mcp-server/server.ts', import.meta.url)),
      'utf8',
    );
    const lock = readJson('../', 'package-lock.json');
    const resolved = (lock.packages as Record<string, { version?: string } | undefined>)[
      `node_modules/${pkg}`
    ]?.version;
    // The banner aligns its two names with spaces, so the separator is
    // `\s*:\s*` and not `: `.
    const stated = new RegExp(`${pkg.replace('/', '\\/')}\\s*:\\s*(\\d+\\.\\d+\\.\\d+)`).exec(
      source,
    )?.[1];

    it('is a package the lockfile resolves', () => {
      // A banner naming something that has left the tree would make the
      // comparison below pass over two absent values.
      expect(resolved, `${pkg} is not in this lockfile`).toBeDefined();
    });

    it('states a version at all', () => {
      // Without this the comparison would pass over an absent claim — the
      // shape this project refuses everywhere.
      expect(stated, `the banner states no ${pkg} version`).toBeDefined();
    });

    it('states the version the lockfile resolves', () => {
      expect(
        stated,
        `server.ts says it was probed against ${pkg} ${stated}, the lockfile resolves ` +
          `${resolved}: re-run the probe and update the banner, or the four claims under it ` +
          'are undated',
      ).toBe(resolved);
    });
  },
);

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
