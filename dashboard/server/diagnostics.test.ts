/**
 * The screen whose only job is to say what is broken.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `runDiagnostics` is what "Health → Test connectivity" runs, and CLAUDE.md
 * calls it "the first reflex after any workflow change". It had no test at all:
 * every branch in it decides between `ok`, `warn` and `fail` on an installation
 * somebody is trying to get working, and not one of those decisions was pinned.
 *
 * The assertions below are all on FAILURE paths, because that is the side of
 * this function that matters. A diagnostic that is wrong when everything works
 * is a nuisance; a diagnostic that is wrong when something is broken is the
 * defect the Tracking tab exists to expose, rebuilt on the screen people open
 * to find out whether anything is broken.
 *
 * NOTHING HERE REACHES THE NETWORK OR A REAL DATABASE. `MENATER_CONFIG` is
 * pointed at a scratch file before the module loads; the database coordinates
 * are a closed port on the loopback interface, which fails immediately instead
 * of depending on whether the machine running the suite happens to have a
 * Postgres on 5432 — the same lesson `vitest.config.ts` records about reading
 * the developer's own `config.json`. The entry-point probe is aimed at a server
 * this file starts and stops itself.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import type { Check, Diagnostics } from '../src/lib/types.ts';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-diag-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is resolved once, at load.
const { runDiagnostics } = await import('./diagnostics.ts');
const { saveConfig } = await import('./config.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const checkOf = (d: Diagnostics, id: string): Check => {
  const c = d.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check "${id}" in the diagnostic`);
  return c;
};

/** An HTTP server on a free loopback port, answering one canned reply. */
async function servingOnce(status: number, body: unknown): Promise<{ base: string; close: () => void }> {
  const srv: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

/**
 * An address where nothing is listening — obtained by binding a port and
 * releasing it, rather than picking a number and hoping. Port 1 would not do:
 * `fetch` refuses it as a "bad port" before it ever opens a socket, which is a
 * different failure wearing the same coat.
 */
async function closedAddress(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(() => {
  // A database that cannot answer. It is a failure path in its own right, and
  // it keeps every case below independent of the machine running the suite.
  saveConfig({
    database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater', password: 'x' },
    webhook: { mode: 'on', secret: 'a-shared-secret' },
  });
});

describe('the entry-point probe', () => {
  it('reads a 400 as the PASS, because the probe is invalid on purpose', async () => {
    // Counter-intuitive enough to be worth pinning: the probe posts a payload
    // with no `alert_id`, so a refusal proves route, secret, normalizer and
    // validator all work. Someone "fixing" this to expect 200 would turn a
    // healthy install red.
    const srv = await servingOnce(400, { status: 'error', reason: 'invalid_schema' });
    try {
      const d = await runDiagnostics({ probeWebhook: true, locale: 'en', baseUrl: srv.base });
      expect(checkOf(d, 'webhook').status).toBe('ok');
    } finally {
      srv.close();
    }
  });

  it('calls a 401 a failure, and says how to fix the secret', async () => {
    const srv = await servingOnce(401, { status: 'error', reason: 'unauthorized' });
    try {
      const d = await runDiagnostics({ probeWebhook: true, locale: 'en', baseUrl: srv.base });
      const c = checkOf(d, 'webhook');
      expect(c.status).toBe('fail');
      expect(c.remedy).toBeTruthy();
    } finally {
      srv.close();
    }
  });

  /**
   * The one this file was written for.
   *
   * An entry point that refuses the connection used to be reported as the two
   * words "fetch failed" — `fetch` puts the real cause one level down, in
   * `err.cause`, and the catch read `(err as Error).message`. On the screen
   * whose whole purpose is to name what is wrong, that is a check that says
   * only "something". Same family as the `pg` empty-message trap in CLAUDE.md.
   */
  it('names WHY the entry point could not be reached', async () => {
    const base = await closedAddress();
    const d = await runDiagnostics({ probeWebhook: true, locale: 'en', baseUrl: base });
    const c = checkOf(d, 'webhook');

    expect(c.status).toBe('fail');
    expect(c.detail).not.toBe('fetch failed');
    expect(c.detail).toMatch(/nothing is listening/i);
    expect(c.detail).toContain('ECONNREFUSED');
  });

  it('is SKIPPED, not passed, when the caller did not ask for it', async () => {
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    expect(checkOf(d, 'webhook').status).toBe('skip');
  });

  it('warns rather than fails when the door is deliberately closed', async () => {
    // `mode: off` is a choice somebody made, not a breakage. Calling it a
    // failure teaches an operator that red does not mean broken — the same
    // reasoning the enrichment keys are warnings for.
    saveConfig({ webhook: { mode: 'off' } });
    try {
      const d = await runDiagnostics({ probeWebhook: true, locale: 'en' });
      const c = checkOf(d, 'webhook');
      expect(c.status).toBe('warn');
      expect(c.remedy).toBeTruthy();
    } finally {
      saveConfig({ webhook: { mode: 'on' } });
    }
  });
});

describe('the database it cannot reach', () => {
  it('reports the cause rather than "the database failed"', async () => {
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    const c = checkOf(d, 'db');
    expect(c.status).toBe('fail');
    // `describePgError` has already turned pg's empty ECONNREFUSED message
    // into a sentence by this point; the whole value of the check is that the
    // cause reaches a screen.
    expect(c.detail.trim()).not.toBe('');
    expect(c.detail).toMatch(/ECONNREFUSED|refused/i);
    expect(c.remedy).toBeTruthy();
  });

  it('does not claim the schema is fine when it could not look', async () => {
    // A `schema: ok` next to a database nobody could reach would be the exact
    // "green over a hole" this product refuses everywhere else.
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    expect(d.checks.find((c) => c.id === 'schema' && c.status === 'ok')).toBeUndefined();
  });
});

describe('the verdict', () => {
  it('is "broken" as soon as one check failed, whatever else passed', async () => {
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    expect(d.summary.fail).toBeGreaterThan(0);
    expect(d.verdict).toBe('broken');
  });

  it('counts every check it returned, so nothing is reported without being counted', async () => {
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    const counted = d.summary.ok + d.summary.warn + d.summary.fail + d.summary.skip;
    expect(counted).toBe(d.checks.length);
  });

  it('checks the node contract the console reads cases through', async () => {
    // The coupling CLAUDE.md warns about: the console builds a case from named
    // node outputs, so a renamed node makes it blind. These must be `ok` on a
    // healthy checkout — if they are not, the workflows and the reader have
    // drifted apart and no amount of configuration will fix it.
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    const contract = d.checks.filter((c) => c.id.startsWith('contract-'));
    expect(contract.length).toBeGreaterThan(0);
    expect(contract.every((c) => c.status === 'ok')).toBe(true);
  });
});
