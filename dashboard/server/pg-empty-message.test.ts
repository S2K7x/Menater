/**
 * An error whose message is the EMPTY STRING, on the three paths that carry it
 * to a human.
 *
 * ============================================================================
 * THE DEFECT THESE REFUSE, AND WHY IT SURVIVED TWO TESTS WRITTEN AGAINST IT
 *
 * `pg` reports a refused connection as an `AggregateError` whose `.message` is
 * the empty string — but ONLY when the host it was given resolves to more than
 * one address. With one address it rejects with a plain `Error` carrying
 * `connect ECONNREFUSED 127.0.0.1:5432`, which is why this is easy to miss:
 * every fixture in this repository names a literal address.
 *
 * Measured through `pg` 8.23.0 on Node 22.23.4, port 1 closed, with two A
 * records for one name in `/etc/hosts`:
 *
 *   host                   constructor      .message                            .code
 *   twohomed               AggregateError   ""                                  ECONNREFUSED
 *   127.0.0.1              Error            "connect ECONNREFUSED 127.0.0.1:1"  ECONNREFUSED
 *
 * `describePgError` exists for exactly the first row, and `errorText` exists so
 * that nothing reaches the journal with nothing in it. Three paths went around
 * them:
 *
 *   1. `diagnostics.ts` — Health → Test connectivity, the DATABASE check, i.e.
 *      the one screen whose entire job is to name what is wrong. It read the
 *      message raw, under a comment asserting `describePgError` had already
 *      run. Driven against the real `runDiagnostics` with host `twohomed`:
 *      `{ status: "fail", detail: "" }`.
 *   2. `runtime.ts` — the `query` dependency the engine's `postgres` node is
 *      built on (dedup, and the audit write). `ruleDb`, eighteen lines further
 *      down the SAME FILE, wraps the rule store's queries in
 *      `describePgError`; this one wrapped nothing.
 *   3. `engine.ts` — the node-failure catch, which is what writes
 *      `soc_run_step.error`, `soc_run.error` and the error branch's output. It
 *      read `(err as Error).message` raw, while `errorText` — declared 319
 *      lines above it in the same file, under « A sentence for an error, never
 *      an empty one » — was called at one of its two sites in that file.
 *
 * `io.ts`'s own header states the cost: « the engine records
 * `(err as Error).message` as the step error, and the console prints that
 * string in the two places somebody reads while an incident is open: the
 * technical incident on the card, and the run's note in the Tracking tab ».
 *
 * ============================================================================
 * THE VEHICLE: A REAL ERROR, AND NO PREMISE BORROWED FROM THE MACHINE
 *
 * These tests must not depend on how the machine running them resolves
 * anything — `persistent-cache.test.ts` paid for borrowing a refusal from the
 * environment, and `diagnostics.test.ts`'s existing database case is green
 * today precisely because its fixture host happens to carry one address.
 *
 * So the error is produced by Node's OWN connect machinery, with a custom
 * `lookup` handed to `net.connect`: two loopback addresses, a port this file
 * closed itself. No DNS entry, no `/etc/hosts`, no network. Probed on Node
 * 22.23.4 — constructor `AggregateError`, `.message` `""`, `.code`
 * `ECONNREFUSED`, one described child per address — which is the same object
 * `pg` handed up in the table above, because it is the same code path.
 * ============================================================================
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import net, { createServer } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The error, shared by the three cases.
 *
 * `vi.hoisted` because the `createPool` double below is hoisted above the
 * imports, and it has to be able to see the box it rejects with.
 */
const box = vi.hoisted(() => ({ err: null as unknown }));

vi.mock('./engine/pg-store.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./engine/pg-store.ts')>();
  // ONLY the pool factory is replaced. `describePgError`, `pgCause` and
  // `PgRunStore` are the real ones: they are what is under test.
  return {
    ...real,
    createPool: () => ({
      query: () => Promise.reject(box.err),
      end: () => Promise.resolve(),
      on: () => {},
    }),
  };
});

const { runDiagnostics } = await import('./diagnostics.ts');
const { queryDep } = await import('./runtime.ts');
const { Engine } = await import('./engine/engine.ts');
const { MemoryRunStore } = await import('./engine/store.ts');
const { pgCause } = await import('./engine/pg-store.ts');

/** A port nothing is listening on — bound and released, never guessed. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** A genuine multi-address connect failure. See the header. */
async function multiAddressConnectError(): Promise<unknown> {
  const port = await closedPort();
  const lookup = (
    _host: string,
    opts: { all?: boolean },
    cb: (e: Error | null, a: unknown, f?: number) => void,
  ) => (opts?.all
    ? cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }])
    : cb(null, '127.0.0.1', 4));

  return new Promise((resolve, reject) => {
    const s = net.connect({ host: 'menater-two-addresses.invalid', port, lookup } as never);
    s.on('error', resolve);
    s.on('connect', () => {
      s.destroy();
      reject(new Error(`the port ${port} this test chose is not closed`));
    });
  });
}

beforeAll(async () => {
  box.err = await multiAddressConnectError();
});

describe('the premise', () => {
  // Without this the three cases below could be green over an error that
  // carries a message, i.e. over nothing at all.
  it('is a real AggregateError whose message is EMPTY', () => {
    expect(box.err).toBeInstanceOf(AggregateError);
    expect((box.err as Error).message).toBe('');
    expect((box.err as { code?: string }).code).toBe('ECONNREFUSED');
    // The cause is in the children, which is what `describePgError` goes for.
    expect((box.err as { errors: Error[] }).errors.length).toBe(2);
  });

  it('is read as nothing by the expression all three paths used', () => {
    expect((box.err as Error).message).toBe('');
    // And this is what each of them has to produce instead.
    expect(pgCause(box.err)).toMatch(/refused the connection/);
    expect(pgCause(box.err)).toContain('ECONNREFUSED');
  });
});

describe('Health → Test connectivity, the database check', () => {
  it('names the cause instead of answering fail with an empty detail', async () => {
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    const c = d.checks.find((x) => x.id === 'db');
    if (!c) throw new Error('no "db" check in the diagnostic');

    expect(c.status).toBe('fail');
    expect(c.detail.trim()).not.toBe('');
    expect(c.detail).toContain('ECONNREFUSED');
    expect(c.remedy).toBeTruthy();
  });

  it('does not repeat the label the check already carries', async () => {
    // The detail renders directly under `label`, which is « Database », and
    // the two sentences beside it (`dbNotConfigured`, `dbReachable`) do not
    // repeat it either. So this one takes the cause and not the prefixed form.
    const d = await runDiagnostics({ probeWebhook: false, locale: 'en' });
    const c = d.checks.find((x) => x.id === 'db');
    expect(c?.label).toBe('Database');
    expect(c?.detail.startsWith('Database')).toBe(false);
  });
});

describe('the engine’s SQL dependency', () => {
  it('names the database as the cause, like the rule store beside it', async () => {
    const pool = { query: () => Promise.reject(box.err) };
    const query = queryDep(pool as never);

    await expect(query('INSERT INTO soc_ingested_alerts (alert_id) VALUES ($1)', ['a-1']))
      .rejects.toThrow(/ECONNREFUSED/);
    const err = await query('INSERT INTO soc_ingested_alerts (alert_id) VALUES ($1)', ['a-1'])
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Database \(INSERT\): /);
    expect((err as Error).message).toMatch(/refused the connection/);
  });

  it('passes an answer through untouched when the query succeeds', async () => {
    // The boundary: this wrapper adds a sentence to a failure and nothing to a
    // success. Green before AND after the change, on purpose.
    const rows = [{ ok: 1 }];
    const query = queryDep({ query: () => Promise.resolve({ rows }) } as never);
    expect(await query('SELECT 1', [])).toBe(rows);
  });
});

describe('the run journal', () => {
  // A trigger and the node that fails, with NO `error` port wired: the engine
  // then fails the run, which is the path that writes `soc_run.error`.
  const nodeDef = (id: string, type: string) => ({
    id, type, label: `freely editable label of ${id}`, params: {}, position: { x: 0, y: 0 },
  });
  const wf = {
    id: 'wf-empty-message',
    name: 'test',
    version: 1,
    nodes: [nodeDef('t', 'trigger.webhook'), nodeDef('n', 'postgres')],
    edges: [{ from: 't', fromPort: 'main', to: 'n' }],
  };
  const pass = async (ctx: { input: unknown }) => ({ output: ctx.input });

  it('never records a step failure with nothing in it', async () => {
    const store = new MemoryRunStore();
    const engine = new Engine({
      store,
      handlers: { 'trigger.webhook': pass, postgres: () => Promise.reject(box.err) } as never,
      newId: () => 'run-1',
    });
    engine.register(wf as never);

    const run = await engine.start('wf-empty-message', { hello: 1 });
    expect(run.status).toBe('failed');
    expect((run.error ?? '').trim()).not.toBe('');

    const failed = (await store.stepsOf(run.id)).find((x) => x.nodeId === 'n');
    expect(failed?.status).toBe('failed');
    expect((failed?.error ?? '').trim()).not.toBe('');
  });

  it('survives a handler that throws something that is not an Error', async () => {
    // `(err as Error).message` on `undefined` throws INSIDE the catch, which
    // escapes `drive()` and leaves the run `running` for ever. No shipped
    // handler does this; the engine is handed its handlers, and the helper the
    // file declares is what makes the journal's promise hold whatever arrives.
    const store = new MemoryRunStore();
    const engine = new Engine({
      store,
      handlers: { 'trigger.webhook': pass, postgres: () => Promise.reject(undefined) } as never,
      newId: () => 'run-1',
    });
    engine.register(wf as never);

    const run = await engine.start('wf-empty-message', {});
    expect(run.status).toBe('failed');
    expect((run.error ?? '').trim()).not.toBe('');
    const failed = (await store.stepsOf(run.id)).find((x) => x.nodeId === 'n');
    expect((failed?.error ?? '').trim()).not.toBe('');
  });
});

describe('the rule, written as a subtraction', () => {
  /**
   * A module that HOLDS A POOL names the cause of a query that fails.
   *
   * Not a list of the two that build one tonight: a list is the exact-match set
   * that has already cost this project every ingestion endpoint once. There are
   * exactly two — `diagnostics.ts` and `runtime.ts`, measured by this walk —
   * and both went around a function `audit-chain.ts` had been calling correctly
   * all along. That file is a pool CONSUMER (the route hands it `getAuditPool()`,
   * i.e. the engine's), and its own comment carried the measured reason: « `pg`
   * rejects `ECONNREFUSED` with an EMPTY message when the host resolves to
   * several addresses » — written down in the one place that did not need it.
   *
   * Comments and imports are stripped first: this file's own header names
   * every symbol the sweep hunts, and an import with nothing behind it is not
   * a description.
   */
  function code(path: string): string {
    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*import[\s\S]*?from\s+'[^']*';$/gm, '');
  }

  function serverFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...serverFiles(p));
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
    }
    return out;
  }

  const SERVER = join(import.meta.dirname);
  const OWNER = join(SERVER, 'engine', 'pg-store.ts');
  const DESCRIBES = /\b(pgCause|describePgError|describeQueryError)\s*\(/;

  const holders = () => serverFiles(SERVER)
    .filter((path) => path !== OWNER && /\bcreatePool\s*\(/.test(code(path)));

  it('every module that builds a pool describes what a query failure was', () => {
    const offenders = holders().filter((path) => !DESCRIBES.test(code(path)));
    expect(offenders.map((p) => p.replace(SERVER, 'server')), offenders.join('\n')).toEqual([]);
  });

  it('and there are pool holders, so the sweep is not passing over nothing', () => {
    // The other direction. Without it the claim above goes quietly green the
    // day a pool moves somewhere this walk cannot see — which is how a vacuous
    // claim survives, and this repository has shipped one. Two is what the walk
    // finds, not a round number: `audit-chain.ts` mentions `createPool` in a
    // comment only, which is why the sweep strips comments before looking.
    expect(holders().length).toBeGreaterThanOrEqual(2);
  });
});
