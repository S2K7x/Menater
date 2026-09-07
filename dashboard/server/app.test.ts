/**
 * Characterization tests for the console's request surface.
 *
 * ============================================================================
 * WHY THEY EXIST
 *
 * Thirty route branches decide authentication, settings, tuning rules and
 * alert ingestion, and until now not one of them was exercised: the server was
 * built at module top level, so importing the module opened a port. These
 * tests pin the behaviour that is there TODAY, so that splitting the router
 * into per-domain modules is a move that can be checked rather than trusted.
 *
 * They deliberately assert contracts, not implementation:
 *   - an unknown `/api/` route answers 404 JSON, never the SPA's HTML;
 *   - a GET on a POST-only route does the same — that exact confusion once
 *     made the client fail on `Unexpected token '<'`;
 *   - the access lock answers 401 with the flag the login screen reads.
 *
 * NOTHING HERE TOUCHES THE REAL `config.json`: `MENATER_CONFIG` is pointed at
 * a scratch path BEFORE the module is imported, because `CONFIG_PATH` is
 * resolved once, at load.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-app-test-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above is set: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('./app.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Captured {
  status: number;
  headers: Record<string, any>;
  body: string;
}

/** Minimal `req`/`res` pair: enough for the handler, no socket involved. */
async function call(
  method: string,
  url: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Captured> {
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
  const captured: Captured = { status: 0, headers: {}, body: '' };

  const req: any = {
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
    // `readBody` iterates the request; an empty body yields nothing.
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload;
    },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number, headers: Record<string, any>) {
      captured.status = status;
      captured.headers = headers ?? {};
      res.headersSent = true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    setHeader() {},
  };

  await handleRequest(req, res);
  return captured;
}

const parsed = (r: Captured) => JSON.parse(r.body);

describe('unknown routes answer JSON, never HTML', () => {
  it('answers 404 JSON on an unknown /api/ path', async () => {
    // The static fallback once rendered `index.html` for any unmatched route,
    // `/api/` included: the client received 200 and HTML, and failed on
    // `Unexpected token '<'` instead of reading a 404.
    const r = await call('GET', '/api/definitely-not-a-route');
    expect(r.status).toBe(404);
    expect(String(r.headers['Content-Type'])).toMatch(/application\/json/);
    expect(parsed(r).error).toBeTruthy();
  });

  it('answers 404 JSON on a GET aimed at a POST-only route', async () => {
    // Same trap seen from the other side: the route exists, the verb does not.
    const r = await call('GET', '/api/replay');
    expect(r.status).toBe(404);
    expect(String(r.headers['Content-Type'])).toMatch(/application\/json/);
  });
});

describe('auth status', () => {
  it('reports the lock state without ever revealing the password', async () => {
    const r = await call('GET', '/api/auth/status');
    expect(r.status).toBe(200);
    const body = parsed(r);
    expect(body).toHaveProperty('enabled');
    expect(body).toHaveProperty('password_set');
    expect(body).toHaveProperty('authenticated');
    // `password_set` is a boolean, never the hash and never the value.
    expect(typeof body.password_set).toBe('boolean');
    expect(JSON.stringify(body)).not.toMatch(/hash/i);
  });
});

describe('the sample scenarios are readable without any external service', () => {
  it('lists the injectable scenarios', async () => {
    const r = await call('GET', '/api/simulate/scenarios');
    expect(r.status).toBe(200);
    const body = parsed(r);
    const list = Array.isArray(body) ? body : (body.scenarios ?? []);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });
});

describe('responses never carry a cacheable header for API data', () => {
  it('marks JSON answers no-store', async () => {
    // A triage queue served from a browser cache is a queue that lies.
    const r = await call('GET', '/api/auth/status');
    expect(String(r.headers['Cache-Control'])).toMatch(/no-store/);
  });
});

describe('rules', () => {
  it('names the database instead of answering 500 with an internal message', async () => {
    // An unreachable database used to fall to the catch-all, which answers 500
    // with pg's own message — and on `ECONNREFUSED` that message is the EMPTY
    // STRING. The Rules tab therefore showed a failure with no cause, on the
    // screen where an unreadable rule set is indistinguishable from an empty
    // one: no rule fires, and nothing says why.
    const r = await call('GET', '/api/rules');
    expect([200, 503]).toContain(r.status);
    if (r.status === 503) {
      const err = parsed(r).error;
      expect(err).toBeTruthy();
      expect(String(err).trim()).not.toBe('');
    }
  });
});

/**
 * The Lookup routes, at the request surface.
 *
 * The unit tests in `intel/intel.test.ts` cover what the providers do with an
 * answer. These cover the two things only the route layer can get wrong: what
 * shape reaches the browser, and what the browser is refused.
 */
describe('manual lookup', () => {
  // Its own budget per test: the throttle is module state, and a test that
  // spent it would fail whichever of its neighbours happened to run first.
  beforeEach(async () => (await import('./routes/intel.ts')).resetIntelThrottle());

  it('publishes the provider catalogue without any key in it', async () => {
    const r = await call('GET', '/api/intel/providers');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.providers.length).toBeGreaterThan(0);
    // The state is `configured: true/false`, never a value.
    expect(r.body).not.toMatch(/apiKey"\s*:\s*"[^"]+/);
    for (const p of body.providers) {
      expect(Object.keys(p).sort()).toEqual(
        ['configured', 'env', 'id', 'kinds', 'label', 'purpose', 'signup', 'ttl_hours'],
      );
    }
  });

  it('answers 200 with a reason for a value it cannot classify', async () => {
    const r = await call('POST', '/api/intel/lookup', { body: { value: 'not an observable' } });
    // 200 ON PURPOSE. "That is not an IP address" answers the question that was
    // asked; a 400 would make `lib/api.ts` throw a banner instead of showing it.
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.observable.kind).toBe('unknown');
    expect(body.verdict).toBe('unknown');
    expect(body.sources).toEqual([]);
  });

  it('never calls a provider for a private address', async () => {
    const r = await call('POST', '/api/intel/lookup', { body: { value: '10.0.0.1' } });
    const body = JSON.parse(r.body);
    expect(body.sources.every((s: any) => s.status === 'skipped')).toBe(true);
    expect(body.answered).toBe(0);
  });

  it('refuses a range prefix that is not exactly five hex characters', async () => {
    // A route that accepted more would be a route that can be talked into
    // forwarding a whole password hash.
    for (const bad of ['ABCDEF', 'AB', 'ZZZZZ', '../etc']) {
      const r = await call('GET', `/api/intel/pwned-range/${bad}`);
      expect(r.status, bad).toBe(404);
    }
  });

  it('does not serve the lookup routes on the wrong method', async () => {
    expect((await call('GET', '/api/intel/lookup')).status).toBe(404);
    expect((await call('POST', '/api/intel/providers')).status).toBe(404);
  });
});

/* ==========================================================================
 * J0.3 — the service inventory, through the settings route
 *
 * `saveConfig` writes whatever shape reaches it, so the check has to be on
 * the way IN. Two answers matter here and they are different failures: a
 * malformed list must come back named rather than as a 500, and a list sent
 * in the wrong wrapper must be REFUSED rather than merged into nothing —
 * `merge` would spread a bare array over the stored section and change
 * nothing, which is a save that reports success and applies none of it.
 * ========================================================================== */

describe('service inventory', () => {
  const entry = {
    service: 'orders-api',
    identifiers: ['web-01'],
    repository: '/srv/src/orders-api',
  };

  it('stores a well-formed list and gives it back', async () => {
    const r = await call('PUT', '/api/settings', { body: { inventory: { entries: [entry] } } });
    expect(r.status).toBe(200);
    expect(parsed(r).settings.inventory.entries).toEqual([entry]);
  });

  it('refuses a duplicate identifier, and the reply says which one', async () => {
    const r = await call('PUT', '/api/settings', {
      body: {
        inventory: {
          entries: [entry, { ...entry, service: 'billing-api', repository: '/srv/billing' }],
        },
      },
    });
    expect(r.status).toBe(400);
    expect(parsed(r).error).toContain('web-01');
    expect(parsed(r).problems[0].field).toBe('inventory.1.identifiers');
  });

  it('refuses a list sent without its wrapper instead of ignoring it', async () => {
    const r = await call('PUT', '/api/settings', { body: { inventory: [entry] } });
    expect(r.status).toBe(400);
    expect(parsed(r).error).toContain('entries');
  });

  it('leaves the stored list alone when a save does not mention it', async () => {
    await call('PUT', '/api/settings', { body: { inventory: { entries: [entry] } } });
    const r = await call('PUT', '/api/settings', { body: { console: { refreshSeconds: 30 } } });
    expect(parsed(r).settings.inventory.entries).toEqual([entry]);
  });
});
