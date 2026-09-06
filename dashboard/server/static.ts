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
 *  2. `index.html` IS NEVER CACHED, the other files are, for a year. That is
 *     possible because Vite puts a fingerprint in every asset's name:
 *     `index-a1b2c3.js` never changes content. Caching `index.html` would
 *     serve the old version indefinitely after a deployment — the classic
 *     failure, and the one nobody understands because "it works in a private
 *     window".
 * ============================================================================
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

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

  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    // See the header: the fingerprint in the name makes a long cache safe,
    // except for the entry point, which always keeps the same name.
    'Cache-Control': isEntry ? 'no-store' : 'public, max-age=31536000, immutable',
    // The console is never meant to be framed by another site.
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
