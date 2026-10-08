/**
 * Serving the interface's files, from the API itself.
 *
 * ============================================================================
 * WHY NOT AN NGINX ALONGSIDE
 *
 * In development, Vite serves the interface and relays `/api` to this server.
 * In a container, somebody has to serve the built files.
 *
 * Adding an nginx would have meant: a second image, a second configuration,
 * and above all TWO ORIGINS — therefore an access lock protecting half the
 * application. The project already settled that question when VulnPipe was
 * merged in: "one application, one origin, one lock". Serving its own files
 * costs forty lines and honours that rule.
 *
 * ============================================================================
 * TWO DEFENCES THAT DO NOT SHOW UP ON REVIEW
 *
 *  1. THE PATH NEVER LEAVES THE DIRECTORY. `GET /../../etc/passwd` is a
 *     request the first passing bot will try within an hour of a tunnel being
 *     opened. We resolve the absolute path and check it stays under the root —
 *     looking for ".." in the URL is not enough, the encodings are many.
 *
 *  2. `index.html` IS NEVER CACHED. Caching it would serve the old version
 *     indefinitely after a deployment — the classic failure, and the one
 *     nobody understands because "it works in a private window". A year of
 *     `immutable` is given to the files whose NAME carries a content hash, and
 *     to no others: see `isFingerprinted`, which is where this rule used to be
 *     written as "everything that is not `index.html`" and was wrong about
 *     every file Vite COPIES rather than builds.
 *
 * ============================================================================
 * THE BILL NOBODY WENT LOOKING FOR
 *
 * `respond.ts` compresses any JSON answer over 4 kB, and ten lines away this
 * function handed out a 474 kB JavaScript bundle in the clear. Measured on a
 * real socket against this repository's own build, counting bytes as they
 * travelled: a cold load of the console moved **629,637 bytes**, and moves
 * **175,581** now — 3.6 times the bytes, on the one deployment mode CLAUDE.md
 * calls normal, where nothing sits in front of this process to do it instead.
 * Nothing fails, which is why it survived: it is a bill, not a failure.
 *
 * COMPRESSED ON A STREAM, NOT WITH `gzipSync`, and that is measured too.
 * `gzipSync` on the bundle is 12.4 ms of CPU and **15.3 ms of blocked event
 * loop**; the same work through `createGzip()` runs on libuv's threadpool and
 * leaves a **2.1 ms** lag behind. This is the thread that also answers the
 * ingestion webhook, so where the CPU lands matters more than how much of it
 * there is.
 *
 * AND NO MEMO, deliberately, where `respond.ts` has one. That memo answers a
 * different question: the snapshot is ONE object answered many times a second,
 * so the waste there was the repetition. Here a built asset carries a
 * fingerprint and a year of `immutable`, so a browser fetches it once per
 * deployment, and the `public/` copies answer a revalidation with no body at
 * all — there is no repetition to save either way, and a cache keyed on a file
 * would buy nothing while adding an invalidation somebody has to get right.
 *
 * (That sentence used to read "every asset carries a fingerprint", which was
 * the claim `isFingerprinted` below exists to correct. It was repeated in this
 * module's defence 2, in its test's comment and in CLAUDE.md, and all four
 * copies were wrong about the same files.)
 * ============================================================================
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { GZIP_MIN_BYTES } from './respond.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The types worth compressing.
 *
 * A LIST OF WHAT TO COMPRESS, NOT OF WHAT TO SKIP. A woff2, a png and a webp
 * are compressed containers already: gzipping one spends CPU on every request
 * and returns a handful of bytes, sometimes fewer than none. Written as a
 * closed list because the failure modes are not symmetric — a text type
 * missing from it costs bandwidth nobody will notice, a binary type wrongly
 * included costs CPU on every request, and a new extension arrives here in
 * `TYPES` first where the question is asked out loud.
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.map']);

/**
 * The directory Vite writes its BUILD output to (`build.assetsDir`).
 *
 * It is the half of the fingerprint rule a name cannot supply: `public/` is
 * copied to the ROOT of `dist/`, so a file sitting here was produced by the
 * build. Changing `assetsDir` costs a cache and not a correctness bug — the
 * hashed files would simply stop earning the long one, which is a bill rather
 * than a browser holding a stale file for a year.
 */
const BUILD_DIR = 'assets';

/**
 * A `-` followed by a content hash, before the extension.
 *
 * The other half, and it is what catches `public/assets/logo.png` — a file the
 * build did not make, sitting where the build writes. The hash class excludes
 * `-` on purpose: with it, the LAST hyphen of `apple-touch-icon.png` would
 * start a nine-character match and a hand-written file would pass for a built
 * one.
 */
const FINGERPRINT = /-[A-Za-z0-9_]{6,}\.[^.]+$/;

/**
 * Does this file's NAME prove its content cannot change?
 *
 * ============================================================================
 * THE PROPERTY, NOT THE ONE FILE SOMEBODY REMEMBERED
 *
 * The header above justifies a year of `immutable` with "Vite puts a
 * fingerprint in every asset's name". That is true of what Vite BUILDS and
 * false of what it COPIES: everything in `public/` is handed to `dist/`
 * verbatim, so `favicon.svg` keeps its name across every deployment — and the
 * rule, written as "everything that is not `index.html`", promised every
 * browser that it never changes.
 *
 * It is not hypothetical here. `public/favicon.svg` is the mark shown between
 * the first paint and React mounting, and `theme/favicon.ts` has a test that
 * forces the two to stay in step: the repository contains the reason that file
 * will change, and the server guaranteed the change could not arrive. The
 * failure this module's own header describes for `index.html` — "serve the old
 * version indefinitely after a deployment, the one nobody understands because
 * it works in a private window" — committed against the file next to it.
 *
 * So the long cache is keyed on the property that makes it safe. Both halves
 * are required and neither is redundant: a hashed name at the root is a
 * `public/` file that merely looks built, an unhashed name under the build
 * directory is a `public/assets/` file that merely sits where built files do.
 * ============================================================================
 */
function isFingerprinted(root: string, file: string): boolean {
  const rel = relative(root, file);
  if (!rel.startsWith(BUILD_DIR + sep)) return false;
  return FINGERPRINT.test(basename(rel));
}

export interface StaticOptions {
  /** Directory of built files. Absent = nothing to serve (development mode). */
  root: string | null;
}

/** Le dossier existe-t-il et contient-il une interface ? */
export function hasBuiltUi(root: string | null): boolean {
  return root !== null && existsSync(join(root, 'index.html'));
}

/**
 * Sert un fichier, ou `index.html` pour toute route inconnue.
 *
 * Returns `false` when there is nothing to serve: the caller then renders its
 * JSON 404, which is the right behaviour in development.
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: StaticOptions,
): boolean {
  const { root } = options;
  if (!hasBuiltUi(root)) return false;

  // JAMAIS L'INTERFACE SOUS `/api/`.
  //
  // Le repli de fin de fonction rend `index.html` pour toute route inconnue —
  // c'est ce qu'on veut pour `/reglages`, jamais pour un appel d'API. Sans
  // cette garde, un `GET /api/diagnostics` (la route existe, mais en POST)
  // received 200 and HTML: the client failed on "Unexpected token '<'"
  // instead of reading a 404 saying the route does not exist. In development
  // the 404 fell out correctly by accident, for want of a `dist/` to serve, so
  // the defect existed ONLY in the normal deployment mode, in a container.
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;

  const base = resolve(root!);
  // Decode BEFORE resolving: `%2e%2e%2f` is a `../` in disguise.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Un encodage invalide n'est pas un chemin : on ne devine pas.
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return true;
  }

  const candidate = resolve(join(base, decoded));
  // THE CHECK THAT COUNTS: the resolved path must stay under the root.
  // Comparing the URL string against ".." would let encoded variants through.
  const inside = candidate === base || candidate.startsWith(base + sep);

  const file =
    inside && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      // Unknown route: render the interface. This is a single-page
      // application — `/settings` is not a file, it is a screen.
      : join(base, 'index.html');

  const ext = extname(file);
  const isEntry = file.endsWith('index.html');
  const stat = statSync(file);

  // THREE POLICIES, BECAUSE THERE ARE THREE KINDS OF FILE HERE.
  //
  // The entry point is never kept. A built asset cannot change under its own
  // name, so it is kept for a year and never asked about. Everything else is
  // a `public/` copy: it CAN change under its own name, so it is kept and
  // asked about — which is affordable only because of the validator below.
  const cache = isEntry
    ? 'no-store'
    : isFingerprinted(base, file)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

  // Whether the answer depends on `Accept-Encoding` at all — computed once,
  // because it decides both the encoding and the `Vary` below.
  //
  // The floor is the JSON routes' own, imported rather than restated: this
  // console names a size in several places, and two spellings of one number is
  // how the two start disagreeing. `index.html` is under it and stays in the
  // clear, which is the honest answer for a file dominated by round-trip time.
  const varies = COMPRESSIBLE.has(ext) && stat.size >= GZIP_MIN_BYTES;
  const compress = varies
    && /\bgzip\b/.test(String(req.headers?.['accept-encoding'] ?? ''));

  const headers: Record<string, string> = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    // Decided above, from the fingerprint. See `isFingerprinted`.
    'Cache-Control': cache,
    // The console is never meant to be framed by another site.
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
  // Announced on exactly the answers that DO depend on the request header.
  // Without it, any cache between here and the browser may hand the gzipped
  // variant to the next client — one that asked for bytes it can read — and
  // the assets carry a year of `immutable`, so that mistake would be a long
  // one. A file nobody would compress does not vary, and says nothing.
  if (compress) headers['Content-Encoding'] = 'gzip';
  if (varies) headers.Vary = 'Accept-Encoding';

  // THE VALIDATOR, ON THE ONE POLICY THAT REVALIDATES.
  //
  // `no-cache` means "keep it, then ask first", and asking is only worth it if
  // an unchanged file answers without a body — otherwise the whole file travels
  // on every navigation, which trades a year-long staleness for a permanent
  // bill. It is deliberately NOT sent with the other two: `no-store` says do
  // not keep it, so a 304 there would hand back the previous deployment's
  // shell, and a fingerprinted name IS the validator, so asking about one buys
  // a round trip about a file that cannot have changed.
  if (cache === 'no-cache') {
    // `Last-Modified` carries whole seconds. Comparing a millisecond mtime
    // against it would report every file as modified, on every request.
    const modified = Math.floor(stat.mtimeMs / 1000) * 1000;
    headers['Last-Modified'] = new Date(modified).toUTCString();
    // A header we could not read is not a claim that the file is unchanged, and
    // ONE check says so: `Date.parse` answers `NaN`, and every comparison
    // against `NaN` is false. An explicit `Number.isFinite` beside it was a
    // second guard where the first already sufficed — a line no test can fail
    // on, which is how this repository words it. The behaviour is pinned by a
    // test instead.
    const since = Date.parse(String(req.headers?.['if-modified-since'] ?? ''));
    if (modified <= since) {
      // No body, so nothing describes one: the encoding header would be a lie
      // and `Content-Type` has nothing to type. `Vary` stays, because it is
      // what a cache keys this entry on.
      const { 'Content-Type': _type, 'Content-Encoding': _enc, ...rest } = headers;
      res.writeHead(304, rest);
      res.end();
      return true;
    }
  }
  res.writeHead(200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // `pipeline` rather than `pipe`, because `pipe` FORWARDS NO ERROR: a read
  // that fails after the head is written emits an unhandled `error`, which
  // takes the process down. Latent while the chain was one stream long; adding
  // a second stream to it is what made it this change's to state. `pipeline`
  // closes every stream in the chain on failure, and its callback has nothing
  // to say — the socket it would have spoken to is the one that went away.
  const source = createReadStream(file);
  if (compress) pipeline(source, createGzip(), res, () => {});
  else pipeline(source, res, () => {});
  return true;
}
