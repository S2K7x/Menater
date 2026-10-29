/**
 * `PUT /api/settings` and the ingestion policy: the door that was written around.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `saveConfig` clamps `console`, `database.port`, the four `pipeline` numbers
 * and `assistant.maxSteps`, and it runs `sanitizeInventory` under a comment
 * stating the rule this file claims: *« This is the second lock: `saveConfig`
 * is exported, and a caller that skipped the route must not be able to write a
 * shape the resolver cannot read. »* The `ingestion` section got none of it,
 * four lines away in the same function — so `normalizePolicyInput`, the
 * Ingestion tab's own door, was bypassed entirely by `PUT /api/settings`.
 *
 * ROADMAP § 7 carried that as read off `merge`/`saveConfig`/the route and
 * explicitly NOT driven. Driven here against the real handler, on a config
 * holding one configured pull source, it is worse than the entry says — the
 * written shape BRICKS the door that would have refused it:
 *
 *   1. the configured source table          : [{"source":"wazuh", … }]
 *   2. PUT /api/settings {pull:{interval:1}} : 200
 *   3. the source table now                 : undefined
 *   4. PUT /api/ingestion/policy            : 500 {"error":"Cannot read
 *                                             properties of undefined
 *                                             (reading 'map')"}
 *   5. GET /api/ingestion/policy            : 200 (the screen still renders)
 *
 * Step 3 is `merge` being one level deep: a patch carrying `ingestion.pull`
 * replaces the whole `pull` object, so a source table somebody configured is
 * deleted by a save that mentions an interval — silently, reported as a save.
 * Step 4 is `normalizePolicyInput` reading `current.pull.sources.map` off a
 * policy that no longer has one, so the Ingestion tab's save button answers
 * **500 for ever** and the operator cannot repair from the console what the
 * console just did. Step 5 is the screen rendering the damage it cannot fix.
 *
 * And the shapes that are merely accepted are not harmless either. Measured on
 * `laneFor` with the real policy functions:
 *
 *   fastLane: []           → critical=paced high=paced medium=paced low=paced
 *   fastLane: 'critical'   → critical=fast  high=paced  (String.includes)
 *   fastLane: 'low'        → critical=paced low=fast    (the policy inverted)
 *   delivery: 'firehose'   → lanes as hybrid, and `onExpectedTransport`
 *                            returns true for everything, so the
 *                            "arrived off its lane" observation is off
 *
 * An empty fast lane under `hybrid` is the one configuration `policy.ts` says
 * it exists to prevent, in its own words: *« it would send `critical` down the
 * paced lane … and it would look like a valid choice on the way in. »*
 *
 * Two of them are latent until the next restart, which is the worst shape of
 * all — the save answers 200, the running console is fine, and the container
 * that restarts tomorrow does not come back. Measured one process per shape:
 *
 *   pull: null           → api.ts:107 syncPoller() THREW TypeError:
 *                          Cannot read properties of null (reading 'enabled')
 *   fastLane: 'critical' → api.ts:119 THREW TypeError:
 *                          ing.fastLane.join is not a function
 *
 * Neither has a catch above it. The escape hatch in every one of these cases
 * is hand-editing `config.json`, which is what the *« lock that locked the
 * operator out »* row says is not an escape hatch.
 *
 * WHAT MUST NOT CHANGE, claimed here on purpose by three tests that pass
 * BEFORE and after: a settings save mentioning no `ingestion` leaves the
 * policy byte-identical, a healthy stored policy is read back unchanged, and a
 * valid ingestion patch still applies. The second lock coerces what cannot be
 * read; it must not rewrite what can.
 * ============================================================================
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-ing-lock-'));
const CONFIG = join(SCRATCH, 'config.json');
process.env.MENATER_CONFIG = CONFIG;

// Imported AFTER the path above: `CONFIG_PATH` is resolved at module load.
const { handleRequest } = await import('./app.ts');
const { getConfig, saveConfig } = await import('./config.ts');
const { defaultPolicy, laneFor, normalizePolicyInput } = await import('./ingest/policy.ts');

/** A console whose operator has configured one polled source. */
const HEALTHY = {
  delivery: 'hybrid' as const,
  fastLane: ['critical', 'high'] as const,
  pull: {
    enabled: true,
    intervalSeconds: 60,
    batchSize: 100,
    overlapSeconds: 30,
    sources: [{
      source: 'wazuh', enabled: true, url: 'https://siem.corp/alerts',
      cursorParam: 'since', authHeader: 'Authorization',
      authCredential: '', itemsPath: 'data',
    }],
  },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Captured { status: number; body: string }

/** Drives the real handler, exactly as a socket delivers the request. */
async function call(method: string, url: string, payload?: unknown): Promise<Captured> {
  const raw = payload === undefined ? null : JSON.stringify(payload);
  const captured: Captured = { status: 0, body: '' };
  const req: any = {
    method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (raw !== null) yield Buffer.from(raw, 'utf8');
    },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

const stored = () => JSON.parse(readFileSync(CONFIG, 'utf8')).ingestion;

beforeEach(() => {
  const c = getConfig();
  c.auth.enabled = false;
  // The cached object is what the route reads, so the premise is installed
  // there rather than only on disk.
  (c as any).ingestion = clone(HEALTHY);
});

describe('PUT /api/settings cannot write a policy the policy door refuses', () => {
  it('refuses an empty fast lane, so a critical alert keeps the push lane', async () => {
    const r = await call('PUT', '/api/settings', { ingestion: { fastLane: [] } });

    expect(r.status).toBe(400);
    expect(getConfig().ingestion.fastLane).toEqual(['critical', 'high']);
    // The consequence, not just the shape: this is the one configuration
    // `policy.ts` says it exists to prevent.
    expect(laneFor('critical', getConfig().ingestion)).toBe('fast');
  });

  it('refuses a delivery mode that is not one of the three', async () => {
    const r = await call('PUT', '/api/settings', { ingestion: { delivery: 'firehose' } });

    expect(r.status).toBe(400);
    expect(getConfig().ingestion.delivery).toBe('hybrid');
  });

  it('refuses a fast lane that is not a list', async () => {
    const r = await call('PUT', '/api/settings', { ingestion: { fastLane: 'critical' } });

    expect(r.status).toBe(400);
    expect(Array.isArray(getConfig().ingestion.fastLane)).toBe(true);
  });

  it('refuses a pull block that is not an object', async () => {
    const r = await call('PUT', '/api/settings', { ingestion: { pull: 'nope' } });

    expect(r.status).toBe(400);
    expect(getConfig().ingestion.pull.sources).toHaveLength(1);
  });

  it('refuses a source address that is not http(s) — a file:// cursor reads this host', async () => {
    const r = await call('PUT', '/api/settings', {
      ingestion: { pull: { sources: [{ source: 'x', url: 'file:///etc/passwd' }] } },
    });

    expect(r.status).toBe(400);
    expect(getConfig().ingestion.pull.sources[0].url).toBe('https://siem.corp/alerts');
  });

  it('applies the policy door\'s own 15 s interval floor', async () => {
    const r = await call('PUT', '/api/settings', { ingestion: { pull: { intervalSeconds: 1 } } });

    expect(r.status).toBe(200);
    expect(getConfig().ingestion.pull.intervalSeconds).toBe(15);
    expect(stored().pull.intervalSeconds).toBe(15);
  });

  it('keeps the configured sources when the patch mentions one pull field', async () => {
    // `merge` is one level deep: this is the save that used to delete the
    // source table and report success.
    const r = await call('PUT', '/api/settings', { ingestion: { pull: { intervalSeconds: 120 } } });

    expect(r.status).toBe(200);
    expect(getConfig().ingestion.pull.sources).toHaveLength(1);
    expect(getConfig().ingestion.pull.sources[0].source).toBe('wazuh');
    expect(stored().pull.sources).toHaveLength(1);
    // And the rest of `pull` survives with it.
    expect(stored().pull.enabled).toBe(true);
    expect(stored().pull.batchSize).toBe(100);
    expect(stored().pull.overlapSeconds).toBe(30);
  });

  it('leaves the Ingestion tab\'s own door able to answer', async () => {
    // The brick: once the stored policy had no `sources`, every later
    // PUT /api/ingestion/policy was a 500 carrying V8's own message.
    expect((await call('PUT', '/api/settings', { ingestion: { pull: { intervalSeconds: 120 } } })).status)
      .toBe(200);

    const r = await call('PUT', '/api/ingestion/policy', { delivery: 'pull' });

    expect(r.status).toBe(200);
    expect(getConfig().ingestion.delivery).toBe('pull');
  });

  it('gives the reason the policy door gives, in one spelling', async () => {
    const viaPolicy = await call('PUT', '/api/ingestion/policy', { delivery: 'firehose' });
    const viaSettings = await call('PUT', '/api/settings', { ingestion: { delivery: 'firehose' } });

    const reason = JSON.parse(viaPolicy.body).error as string;
    expect(reason).toContain('delivery must be one of');
    // The settings door adds the consequence — nothing was saved — and
    // carries the reason verbatim rather than wording it a second time.
    expect(JSON.parse(viaSettings.body).error).toContain(reason);
  });
});

describe('the second lock: a stored policy the resolver cannot read', () => {
  let coldDir: string;

  /**
   * A COLD read of a hand-written `config.json`, which is what a restart is.
   *
   * `vi.resetModules()` and not a cache-busting query on one specifier: the
   * probe that measured this first busted `config.ts` alone, and
   * `runtime.ts`'s own `import { getConfig } from '../config.ts'` kept
   * resolving to the registry's cached instance — so every shape after the
   * first was measured against the FIRST shape's configuration. Resetting the
   * registry is what makes `runtime.ts` see the configuration under test.
   */
  async function boot(ingestion: unknown) {
    const file = join(coldDir, 'config.json');
    writeFileSync(file, JSON.stringify({ ingestion }, null, 2));
    vi.resetModules();
    vi.stubEnv('MENATER_CONFIG', file);
    const config = await import('./config.ts');
    const runtime = await import('./ingest/runtime.ts');
    return { config, runtime };
  }

  beforeEach(() => { coldDir = mkdtempSync(join(tmpdir(), 'menater-ing-cold-')); });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(coldDir, { recursive: true, force: true });
  });

  it('does not let a null pull block throw at boot', async () => {
    const { config, runtime } = await boot({
      delivery: 'hybrid', fastLane: ['critical'], pull: null,
    });

    expect(config.getConfig().ingestion.pull).toBeTypeOf('object');
    expect(config.getConfig().ingestion.pull).not.toBeNull();
    // `syncPoller()` is `api.ts`'s boot call and has no catch above it.
    expect(() => runtime.syncPoller()).not.toThrow();
  });

  it('does not let a string fast lane throw on the startup log line', async () => {
    const { config } = await boot({
      delivery: 'hybrid', fastLane: 'critical',
      pull: { enabled: false, intervalSeconds: 60, batchSize: 100, overlapSeconds: 30, sources: [] },
    });

    const ing = config.getConfig().ingestion;
    expect(Array.isArray(ing.fastLane)).toBe(true);
    // api.ts:119 composes exactly this.
    expect(() => ing.fastLane.join(', ')).not.toThrow();
  });

  it('falls back to the recommended default, and says so', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { config } = await boot({
      delivery: 'firehose', fastLane: ['critical', 'high'],
      pull: { enabled: false, intervalSeconds: 60, batchSize: 100, overlapSeconds: 30, sources: [] },
    });

    expect(config.getConfig().ingestion).toEqual(defaultPolicy());
    // A policy reset in silence is the "setting that looks applied and is not"
    // this console refuses everywhere else.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(' ')).toContain('delivery must be one of');
  });

  it('coerces an unusable policy handed straight to the exported saveConfig', async () => {
    // THE CALLER THAT SKIPPED THE ROUTE, which is the state the
    // `sanitizeInventory` comment names and the reason both locks exist.
    // `inventory.test.ts` claims the same thing about its own half ("drops an
    // unusable entry on the way in rather than storing it"), and without this
    // the `saveConfig` lock is a line no test can fail on.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const next = saveConfig({ ingestion: { pull: null } });

    expect(next.ingestion.pull).toBeTypeOf('object');
    expect(next.ingestion.pull).not.toBeNull();
    expect(Array.isArray(next.ingestion.pull.sources)).toBe(true);
    expect(stored().pull).not.toBeNull();
    spy.mockRestore();
  });

  it('reads a healthy stored policy back unchanged', async () => {
    const { config } = await boot(clone(HEALTHY));

    expect(config.getConfig().ingestion).toEqual(HEALTHY);
  });
});

describe('what must not change', () => {
  it('leaves the policy alone on a save that mentions no ingestion', async () => {
    const before = clone(getConfig().ingestion);

    const r = await call('PUT', '/api/settings', { console: { refreshSeconds: 30 } });

    expect(r.status).toBe(200);
    expect(getConfig().ingestion).toEqual(before);
    expect(stored()).toEqual(before);
  });

  it('still applies a valid ingestion patch', async () => {
    const r = await call('PUT', '/api/settings', {
      ingestion: {
        delivery: 'pull',
        pull: {
          enabled: true, intervalSeconds: 300, batchSize: 50, overlapSeconds: 10,
          sources: [{
            source: 'splunk', enabled: true, url: 'https://splunk.corp/services',
            cursorParam: 'from', authHeader: 'X-Key', authCredential: '', itemsPath: 'results',
          }],
        },
      },
    });

    expect(r.status).toBe(200);
    const saved = getConfig().ingestion;
    expect(saved.delivery).toBe('pull');
    expect(saved.pull.intervalSeconds).toBe(300);
    expect(saved.pull.sources.map((s) => s.source)).toEqual(['splunk']);
    expect(stored().pull.sources[0].url).toBe('https://splunk.corp/services');
  });

  it('normalizePolicyInput is identity on a healthy policy', async () => {
    // What makes the second lock safe to run on every cold read and every
    // save: it coerces what cannot be read and rewrites nothing that can.
    const { policy, error } = normalizePolicyInput(clone(HEALTHY), defaultPolicy());

    expect(error).toBeNull();
    expect(policy).toEqual(HEALTHY);
  });
});
