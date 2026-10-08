/**
 * Tests du service de fichiers.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Ce module va servir des fichiers depuis un serveur qu'on s'apprête à exposer
 * sur Internet par un tunnel. `GET /../../etc/passwd` est une requête que le
 * premier robot venu essaiera dans l'heure — et la traversée de chemin ne lève
 * jamais d'erreur : elle sert le fichier.
 * ============================================================================
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasBuiltUi, serveStatic } from './static.ts';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'menater-ui-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>console');
  writeFileSync(join(root, 'assets', 'index-a1b2c3.js'), 'console.log(1)');
  // WHAT VITE COPIES VERBATIM. `public/` lands at the root of `dist/` under
  // the name it was written with, so these three carry no content hash — and
  // each one defeats a different half of the rule below.
  writeFileSync(join(root, 'favicon.svg'), '<svg>slate</svg>');
  // Fingerprint-SHAPED and at the root: `-manifest` is eight legal characters.
  writeFileSync(join(root, 'site-manifest.json'), '{"name":"menater"}');
  // Under the build's own directory and NOT hashed: `public/assets/logo.png`.
  writeFileSync(join(root, 'assets', 'logo.png'), 'PNG');
  // Hyphenated, under the build's directory, and still not built. `-touch-icon`
  // is ten characters a hash is allowed to use APART from the hyphen, so this
  // is the file that says whether the hash class excludes one.
  writeFileSync(join(root, 'assets', 'apple-touch-icon.png'), 'PNG');
  // A `public/` copy big enough to be worth compressing, so the conditional
  // answer below has an encoding and a `Vary` to get right.
  writeFileSync(join(root, 'og-card.svg'), `<svg>${'card '.repeat(1200)}</svg>`);
  // Un fichier VOISIN de la racine : la cible classique d'une traversée.
  outside = join(root, '..', `secret-${Date.now()}.txt`);
  writeFileSync(outside, 'MOT DE PASSE');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

/** Réponse simulée : on n'a besoin que des en-têtes et du corps. */
function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '', ended: false };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      state.headers = headers;
      return res;
    },
    end(chunk?: string) {
      if (chunk) state.body += chunk;
      state.ended = true;
    },
    on() {},
    once() {},
    emit() {},
  };
  return { res, state };
}

const get = (pathname: string, method = 'HEAD') => {
  const { res, state } = fakeRes();
  const handled = serveStatic({ method } as never, res as never, pathname, { root });
  return { handled, state };
};

describe('traversée de chemin', () => {
  it.each([
    '/../secret.txt',
    '/../../etc/passwd',
    '/assets/../../etc/passwd',
    // Encodés : vérifier l'absence de « .. » dans l'URL brute ne suffirait pas.
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
  ])('ne sort JAMAIS du dossier — %s', (attack) => {
    const { handled, state } = get(attack);
    expect(handled).toBe(true);
    // Toute tentative retombe sur l'interface, jamais sur le fichier visé.
    expect(state.headers['Content-Type']).toMatch(/text\/html/);
  });

  it('refuse un encodage invalide au lieu de le deviner', () => {
    const { state } = get('/%E0%A4%A');
    expect(state.status).toBe(400);
  });
});

describe('cache', () => {
  it('ne met JAMAIS le point d’entrée en cache', () => {
    // Sinon un déploiement sert indéfiniment l'ancienne version — la panne
    // qu'on ne comprend pas parce que « ça marche en navigation privée ».
    expect(get('/').state.headers['Cache-Control']).toBe('no-store');
    expect(get('/index.html').state.headers['Cache-Control']).toBe('no-store');
  });

  it('met les ressources empreintées en cache pour un an', () => {
    // Possible parce que Vite met une empreinte dans le nom : le contenu de
    // `index-a1b2c3.js` ne changera jamais.
    const { state } = get('/assets/index-a1b2c3.js');
    expect(state.headers['Cache-Control']).toMatch(/max-age=31536000/);
    expect(state.headers['Content-Type']).toMatch(/javascript/);
  });

  /* ------------------------------------------------------------------------
   * A YEAR OF `immutable` IS EARNED BY THE FINGERPRINT, NOT BY NOT BEING THE
   * ENTRY POINT.
   *
   * The header above justifies the long cache with "Vite puts a fingerprint in
   * every asset's name". That is true of what Vite BUILDS and false of what it
   * COPIES: `public/` is handed to `dist/` verbatim, so `favicon.svg` keeps its
   * name across every deployment — and the rule, written as "everything except
   * `index.html`", promised a browser it would never change.
   *
   * Three files, three ways of being wrong, so neither half of the rule can be
   * dropped without a test naming it.
   * --------------------------------------------------------------------- */
  it.each([
    // No hash at all, at the root. What `public/` actually holds today.
    '/favicon.svg',
    // Fingerprint-SHAPED at the root: only the directory tells it apart.
    '/site-manifest.json',
    // Under the build's directory and unhashed: only the name tells it apart.
    '/assets/logo.png',
    // Same, hyphenated: only a hash class that excludes `-` tells it apart.
    '/assets/apple-touch-icon.png',
  ])('never promises a file the build did not fingerprint is immutable — %s', (path) => {
    const { state } = get(path);
    expect(state.headers['Cache-Control']).not.toMatch(/immutable|max-age=31536000/);
  });

  it('asks before reusing a file the build did not fingerprint', () => {
    // `no-cache` is "store it, then ask": a changed favicon reaches a browser
    // on its next navigation instead of in a year. The validator is what makes
    // the asking free — see the 304 block on a real socket below.
    const { state } = get('/favicon.svg');
    expect(state.headers['Cache-Control']).toBe('no-cache');
    expect(state.headers['Last-Modified']).toEqual(expect.any(String));
  });

  it('sends no validator with the entry point', () => {
    // `no-store` means do not keep it, so there is nothing to revalidate — and
    // a 304 here would serve the previous deployment's shell.
    expect(get('/').state.headers['Last-Modified']).toBeUndefined();
  });

  it('sends no validator with a fingerprinted asset', () => {
    // Its name is the validator. Asking about a file that cannot change is a
    // round trip bought for nothing.
    expect(get('/assets/index-a1b2c3.js').state.headers['Last-Modified']).toBeUndefined();
  });
});

describe('application à une seule page', () => {
  it('rend l’interface pour une route inconnue', () => {
    // `/reglages` n'est pas un fichier, c'est un écran.
    expect(get('/reglages').state.headers['Content-Type']).toMatch(/text\/html/);
  });

  it('sert un vrai fichier quand il existe', () => {
    expect(get('/assets/index-a1b2c3.js').state.headers['Content-Type']).toMatch(/javascript/);
  });
});

describe('en développement, il ne sert rien', () => {
  it('rend `false` sans dossier construit — l’appelant rend son 404 JSON', () => {
    const { res } = fakeRes();
    expect(serveStatic({ method: 'GET' } as never, res as never, '/x', { root: null })).toBe(false);
    expect(hasBuiltUi(null)).toBe(false);
  });

  it('rend `false` si le dossier existe mais sans interface', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vide-'));
    const { res } = fakeRes();
    expect(serveStatic({ method: 'GET' } as never, res as never, '/x', { root: empty })).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('en-têtes de sécurité', () => {
  it('interdit l’encadrement et la devinette de type', () => {
    const { state } = get('/');
    expect(state.headers['X-Frame-Options']).toBe('DENY');
    expect(state.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(state.headers['Referrer-Policy']).toBe('no-referrer');
  });
});

describe('le repli SPA n’attrape jamais /api/', () => {
  it('refuse un chemin d’API, pour laisser répondre le 404 JSON', () => {
    const { handled, state } = get('/api/route-inconnue');
    expect(handled).toBe(false);
    // Rien n'a été écrit : l'appelant garde la main pour rendre son JSON.
    expect(state.ended).toBe(false);
  });

  it('refuse aussi `/api` tout court', () => {
    expect(get('/api').handled).toBe(false);
  });

  it('refuse quel que soit le verbe', () => {
    expect(get('/api/snapshot', 'GET').handled).toBe(false);
  });

  it('sert toujours l’interface sur une route de navigation', () => {
    const { handled, state } = get('/reglages');
    expect(handled).toBe(true);
    expect(state.status).toBe(200);
  });

  // `/apiculture` commence par les mêmes lettres sans être une route d'API :
  // la garde doit tester le SEGMENT, pas le préfixe de chaîne.
  it('ne confond pas un chemin qui commence par les mêmes lettres', () => {
    expect(get('/apiculture').handled).toBe(true);
  });
});

/* ==========================================================================
 * COMPRESSION — ON A REAL SOCKET, DELIBERATELY
 *
 * The fake response above is enough to read a header back, and it cannot
 * vouch for a body: `pipe()` on an object that is not a real `Writable` moves
 * nothing, so a test driving it would agree with any implementation, working
 * or not. This block therefore starts an actual HTTP server and asks for the
 * files the way a browser does — the same reason `fetchWithDeadline`'s
 * redirect tests had to stop using an injected transport.
 *
 * What is claimed here is the whole contract, both directions: a client that
 * accepts gzip gets fewer bytes AND the same file back once decoded, a client
 * that does not gets the file untouched, and an answer that depends on the
 * request header says so with `Vary`.
 * ========================================================================== */

describe('compression of the interface files', () => {
  /** Big enough to be worth compressing, and repetitive like real JS is. */
  const BUNDLE = `console.log(${'"menater",'.repeat(4000)}1)`;
  let server: import('node:http').Server;
  let base: string;

  beforeEach(async () => {
    writeFileSync(join(root, 'assets', 'bundle-a1b2c3.js'), BUNDLE);
    // A binary asset whose bytes are already compressed. Written as random
    // bytes because a woff2 of repeated zeroes would compress, and the point
    // is exactly that this kind of file does not.
    writeFileSync(join(root, 'assets', 'font-a1b2c3.woff2'), randomBytes(50_000));
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      if (!serveStatic(req, res, new URL(req.url ?? '/', 'http://x').pathname, { root })) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Bytes as they travelled, before `fetch` decoded anything. */
  async function onTheWire(path: string, encoding: string) {
    const res = await fetch(`${base}${path}`, { headers: { 'accept-encoding': encoding } });
    const body = Buffer.from(await res.arrayBuffer());
    return {
      encoding: res.headers.get('content-encoding'),
      vary: res.headers.get('vary'),
      // `fetch` decompresses gzip transparently, so the decoded body is what
      // the browser would run — which is the half that must not change.
      decoded: body.toString('utf8'),
      bytes: body.length,
    };
  }

  it('sends the bundle compressed, and it decodes to the same file', async () => {
    const got = await onTheWire('/assets/bundle-a1b2c3.js', 'gzip, deflate, br');
    expect(got.encoding).toBe('gzip');
    expect(got.decoded).toBe(BUNDLE);
  });

  it('sends the file untouched to a client that cannot read gzip', async () => {
    const got = await onTheWire('/assets/bundle-a1b2c3.js', 'identity');
    expect(got.encoding).toBeNull();
    expect(got.decoded).toBe(BUNDLE);
  });

  it('says the answer depends on the request header', async () => {
    // Without `Vary`, any cache between here and the browser may hand the
    // gzipped variant to the next client, which asked for bytes it can read.
    const got = await onTheWire('/assets/bundle-a1b2c3.js', 'gzip');
    expect(got.vary).toBe('Accept-Encoding');
  });

  it('leaves an already-compressed asset alone', async () => {
    // A woff2 is a compressed container: gzipping it spends CPU on every
    // request and returns nothing. Claimed rather than assumed, because the
    // plausible implementation compresses everything it is allowed to.
    const got = await onTheWire('/assets/font-a1b2c3.woff2', 'gzip');
    expect(got.encoding).toBeNull();
    expect(got.bytes).toBe(50_000);
  });

  it('leaves a small file alone', async () => {
    // Below the threshold the gzip header can make the answer LARGER, and the
    // round trip is dominated by latency anyway. Same constant as the JSON
    // routes use, imported rather than restated.
    const got = await onTheWire('/index.html', 'gzip');
    expect(got.encoding).toBeNull();
    expect(got.decoded).toBe('<!doctype html>console');
  });
});

/* ==========================================================================
 * REVALIDATION — ON A REAL SOCKET, FOR THE SAME REASON THE BLOCK ABOVE IS
 *
 * The fake response cannot vouch for a status line the client acts on, nor for
 * a body that is absent on purpose. And what this claims is a sequence rather
 * than a header: ask, be told nothing changed, change the file, be given it.
 *
 * `no-cache` without a validator would be a bandwidth regression — the file
 * re-sent in full on every navigation — so the 304 is not decoration here, it
 * is the half that makes the policy affordable.
 * ========================================================================== */

describe('revalidating a file the build did not fingerprint', () => {
  let server: import('node:http').Server;
  let base: string;

  beforeEach(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      if (!serveStatic(req, res, new URL(req.url ?? '/', 'http://x').pathname, { root })) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const ask = (path: string, since?: string) =>
    fetch(`${base}${path}`, { headers: since ? { 'if-modified-since': since } : {} });

  it('answers 304 and no body when the file has not changed', async () => {
    const first = await ask('/favicon.svg');
    expect(first.status).toBe(200);
    const validator = first.headers.get('last-modified');
    expect(validator).toBeTruthy();
    expect(await first.text()).toBe('<svg>slate</svg>');

    const again = await ask('/favicon.svg', validator!);
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it('delivers the new bytes once the file changes', async () => {
    // THIS ONE PASSES BEFORE THE FIX TOO, and it is here on purpose: with no
    // validator the server always answered 200 with the current bytes. What it
    // claims is the 304 logic the fix ADDS — a comparison that answered "not
    // modified" to any conditional request would rebuild the staleness the fix
    // removes, one layer in. The defect itself cannot be asserted from here:
    // `immutable` is obeyed by the browser, so what a server test can claim is
    // that the policy is not `immutable` (above) and that revalidation is
    // honest (here).
    const first = await ask('/favicon.svg');
    const validator = first.headers.get('last-modified')!;

    writeFileSync(join(root, 'favicon.svg'), '<svg>acme</svg>');
    // `Last-Modified` carries whole seconds: a rewrite inside the same second
    // is indistinguishable from no rewrite, and the test must not depend on how
    // long it took to get here.
    const ahead = new Date(Date.now() + 2000);
    utimesSync(join(root, 'favicon.svg'), ahead, ahead);

    const after = await ask('/favicon.svg', validator);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('<svg>acme</svg>');
  });

  it('never answers 304 for the entry point', async () => {
    // `index.html` is `no-store`, so a conditional request can only come from a
    // client that kept it anyway — and answering 304 would hand it the shell of
    // the previous deployment, which is the failure the `no-store` exists for.
    const res = await ask('/index.html', new Date(Date.now() + 60_000).toUTCString());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<!doctype html>console');
  });

  it('never answers 304 for a fingerprinted asset', async () => {
    // Its name is its validator. A cache that asks anyway is asking about a
    // file that cannot have changed, and it gets the file.
    const res = await ask('/assets/index-a1b2c3.js', new Date(Date.now() + 60_000).toUTCString());
    expect(res.status).toBe(200);
    // Read it. `fetch` keeps the socket checked out of the pool until the body
    // is consumed, so `server.close()` then waits out the keep-alive — this
    // very assertion took 3.0 s instead of 3 ms before the read was added. The
    // trap is in CLAUDE.md pointing OUTWARD at the enrichment sources; it costs
    // the same inward, in a test.
    expect(await res.text()).toBe('console.log(1)');
  });

  it('describes no body on a 304, and still says what the entry varies on', async () => {
    // RFC 9110 § 15.4.5: a 304 carries the fields a cache needs to update its
    // stored entry, and not the ones describing a representation it is not
    // being sent. `Vary` is the first kind — it is what the cache keys this
    // entry on, and dropping it would let a later `identity` request be served
    // the gzipped copy. `Content-Type` and `Content-Encoding` are the second:
    // there is no body for them to describe.
    const first = await fetch(`${base}/og-card.svg`, { headers: { 'accept-encoding': 'gzip' } });
    expect(first.headers.get('content-encoding')).toBe('gzip');
    expect(first.headers.get('vary')).toBe('Accept-Encoding');
    const validator = first.headers.get('last-modified')!;
    await first.arrayBuffer();

    const again = await fetch(`${base}/og-card.svg`, {
      headers: { 'accept-encoding': 'gzip', 'if-modified-since': validator },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('vary')).toBe('Accept-Encoding');
    expect(again.headers.get('content-encoding')).toBeNull();
    expect(again.headers.get('content-type')).toBeNull();
  });

  it('ignores an unparseable `if-modified-since` instead of guessing', async () => {
    // A header we cannot read is not a claim that the file is unchanged.
    const res = await ask('/favicon.svg', 'yesterday-ish');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<svg>slate</svg>');
  });
});
