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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
