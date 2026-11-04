/**
 * A pooled database connection that dies, and the process that died with it.
 *
 * ============================================================================
 * WHAT THIS PROTECTS
 *
 * `pg`'s `Pool` is an `EventEmitter`, and it emits `'error'` when a connection
 * it was HOLDING IDLE loses the server at the other end — a database restart,
 * a failover, an administrator's `pg_terminate_backend`, a middlebox reaping
 * an idle socket. `createPool` attached no listener, and an `EventEmitter`
 * that emits `'error'` with no listener THROWS.
 *
 * That throw is an uncaught EXCEPTION, not a rejection, so `api.ts`'s
 * `process.on('unhandledRejection')` — written under the comment « a promise
 * rejected outside the handler must not bring the server down: the console
 * would stay unreachable until someone restarted it by hand » — never saw it.
 * Measured against the real console process on real PostgreSQL 16.15: a
 * healthy `GET /api/snapshot` answered 200, one backend sat idle in the pool,
 * `pg_terminate_backend` on it, and two seconds later the process was gone,
 * the port closed, and the log held 301 lines of a dumped internal `Client`
 * object naming nothing an operator can act on.
 *
 * The pool itself needs no repair: with the event merely LISTENED to it drops
 * the dead client (`idleCount` and `totalCount` both fall to 0) and the next
 * query opens a new connection. So the missing listener contributed nothing
 * but the death — which is why the fix reports and returns, and why the test
 * below that matters most is the one asserting the pool STILL ANSWERS.
 *
 * ============================================================================
 * NO DATABASE, AND STILL REAL SOCKETS
 *
 * The suite must stay green on a machine with no Postgres, and a double cannot
 * vouch for an event `pg` decides to emit. So these tests stand up a fake that
 * speaks the three wire messages needed to get `pg` connected and idle —
 * AuthenticationOk, ReadyForQuery, CommandComplete — over a real TCP socket,
 * and then kill that socket.
 *
 * The shape it produces was checked against the real thing rather than
 * assumed. Probed on PostgreSQL 16.15 with `pg` 8.23.0, the event the pool
 * emits is:
 *
 *   pg_terminate_backend          DatabaseError  code 57P01
 *                                 "terminating connection due to administrator command"
 *   pg_ctl stop -m immediate      Error          code undefined
 *                                 "Connection terminated unexpectedly"
 *   pg_ctl restart -m fast        DatabaseError  code 57P01
 *                                 "terminating connection due to administrator command"
 *
 * and the fake's socket death — RST or FIN alike — produces the middle one,
 * byte for byte. Note what those three say about the fix: every message is
 * NON-EMPTY, so `describePgError` would be a guard for a state this path
 * cannot reach. It exists because `pg` reports a refused CONNECT as an
 * `AggregateError` whose `.message` is the empty string; an idle client is one
 * that already connected, so that shape cannot arrive here.
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Server, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PgRunStore, createPool } from './pg-store.ts';

/** One wire message: a type byte, its length, its payload. */
function message(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([head, payload]);
}

const AUTH_OK = message('R', (() => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(0, 0); // 0 = AuthenticationOk
  return b;
})());
const READY_FOR_QUERY = message('Z', Buffer.from('I', 'latin1'));
const COMMAND_COMPLETE = message('C', Buffer.from('SELECT 0\0', 'latin1'));

const open: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/**
 * A listener `pg` can connect to, answer one query through, and go idle on.
 *
 * `live()` hands back the socket of the connection currently held, which is
 * what a test kills to reproduce a database that went away underneath an idle
 * client.
 */
async function fakePostgres(): Promise<{ port: number; live: () => Socket | null }> {
  let current: Socket | null = null;
  const server = createServer((socket) => {
    current = socket;
    let started = false;
    socket.on('data', (buf: Buffer) => {
      // The first thing a client sends is the StartupMessage, which carries no
      // type byte. Everything after it does.
      if (!started) {
        started = true;
        socket.write(Buffer.concat([AUTH_OK, READY_FOR_QUERY]));
        return;
      }
      if (buf[0] === 0x51) socket.write(Buffer.concat([COMMAND_COMPLETE, READY_FOR_QUERY])); // 'Q'
      else if (buf[0] === 0x58) socket.end();                                                // 'X'
    });
    // The fake is not the subject: a socket error here must not become a
    // second, unrelated failure.
    socket.on('error', () => {});
  });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, live: () => current };
}

function poolAt(port: number) {
  return createPool({
    host: '127.0.0.1', port, database: 'd', user: 'u', password: '', ssl: false,
  });
}

/** Long enough for the socket's death to travel through `pg` to the pool. */
const SETTLE_MS = 250;
const settle = () => new Promise<void>((r) => { setTimeout(r, SETTLE_MS); });

describe('a pooled connection the database took away', () => {
  it('is listened for at all — the pool is an EventEmitter and an unheard error throws', async () => {
    const { port } = await fakePostgres();
    const pool = poolAt(port);
    try {
      // The defect, in one number. Node's `EventEmitter` throws on an `error`
      // it has no listener for, and this pool is reached from the ingestion
      // webhook's own process.
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      await pool.end().catch(() => {});
    }
  });

  it('is REPORTED, with the cause the driver gave, instead of taking the process down', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port, live } = await fakePostgres();
    const pool = poolAt(port);
    try {
      await pool.query('select 1');
      expect(pool.idleCount).toBe(1);

      live()?.destroy();
      await settle();

      const said = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      // The cause, as `pg` worded it — the same string real PostgreSQL
      // produces when its process is killed outright. See the header.
      expect(said).toContain('Connection terminated unexpectedly');
    } finally {
      await pool.end().catch(() => {});
    }
  });

  it('says the connection will be reopened, so the line does not read as an outage', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port, live } = await fakePostgres();
    const pool = poolAt(port);
    try {
      await pool.query('select 1');
      live()?.destroy();
      await settle();

      const said = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      // A dropped connection the pool reopens by itself is not a database
      // that is down, and the two call for different reactions. Reporting the
      // cause and leaving the consequence out sends an operator to look at a
      // database that is answering.
      expect(said).toMatch(/reopen/i);
      expect(said).toContain('[menater]');
    } finally {
      await pool.end().catch(() => {});
    }
  });

  it('keeps answering: the next query opens a new connection', async () => {
    // THE CONTROL THAT REFUSES THE PLAUSIBLE WRONG FIX.
    //
    // node-postgres' own documentation suggests `process.exit(-1)` in this
    // handler. That rebuilds the defect inside its repair — the console still
    // dies on a database restart, just with a tidier line first — and this
    // console is the process that answers the ingestion webhook, so the cost
    // is every pushed alert arriving at a closed port.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port, live } = await fakePostgres();
    const pool = poolAt(port);
    try {
      await pool.query('select 1');
      live()?.destroy();
      await settle();

      // The pool dropped the dead client on its own.
      expect(pool.totalCount).toBe(0);
      // And it reconnects, which is what makes "report and return" correct.
      await expect(pool.query('select 1')).resolves.toMatchObject({ rows: [] });
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

describe('the process itself', () => {
  /**
   * THE ONE CLAIM NO IN-PROCESS TEST CAN MAKE.
   *
   * The defect is that the process ENDS, and a test living in that process
   * cannot assert its own survival: with no listener the `EventEmitter` throws
   * from inside a socket callback, which vitest reports as an unhandled error
   * while every assertion in this file still passes. Measured — the mutation
   * that restores the defect leaves `Tests 8 passed` next to `Errors 3`, so a
   * harness reading the assertion count calls it survived.
   *
   * It is worse for the plausible wrong fix. node-postgres' own documentation
   * puts `process.exit(-1)` in this handler; in a vitest worker that killed
   * nothing an assertion could see. So the claim is driven in a CHILD process
   * and read off its exit code, which is the only thing that distinguishes the
   * three outcomes. Probed on Node 22.23.4:
   *
   *   the listener reports and returns   exit 0,   "STILL-ALIVE" on stdout
   *   no listener at all (the defect)    exit 1
   *   process.exit(-1) in the handler    exit 255
   *
   * The event is emitted directly rather than through a socket, and that is
   * the right division: the tests above already prove, over real sockets, that
   * `pg` emits exactly this event with exactly this message when an idle
   * connection dies. What this one has to prove is what happens NEXT, and that
   * is a property of the emitter contract, not of the wire.
   */
  it('survives the event and keeps running, where the defect and the exit both end it', () => {
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', `
        const { createPool } = await import(${JSON.stringify(join(import.meta.dirname, 'pg-store.ts'))});
        const pool = createPool({ host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: '', ssl: false });
        pool.emit('error', new Error('Connection terminated unexpectedly'));
        setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0); }, 60);
      `],
      { encoding: 'utf8', timeout: 20_000 },
    );

    // 1 is the throw an unheard `error` event becomes; 255 is `process.exit(-1)`.
    expect(child.status, `stderr: ${child.stderr}`).toBe(0);
    expect(child.stdout).toContain('STILL-ALIVE');
    // And it SAID so, in a real process rather than through a spy.
    expect(child.stderr).toContain('a pooled database connection was dropped');
  });
});

describe('what the handler must NOT say', () => {
  // Both pass before AND after. They are what stops the fix being widened
  // into "log something whenever the pool is unhappy".

  it('an orderly shutdown reports nothing', async () => {
    // Measured: a normal `pool.end()` emits no `error` event at all. If it
    // did, every `docker compose down` and every database re-point in
    // Settings — `runtime.ts` ends the old pool — would print a failure.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port } = await fakePostgres();
    const pool = poolAt(port);
    await pool.query('select 1');
    await pool.end();
    await settle();

    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toBe('');
  });

  it('a failed QUERY still travels on its own promise, named by the store', async () => {
    // The boundary: this handler is about a connection nobody was using.
    // A query that fails rejects, and `PgRunStore.q()` is the single choke
    // point that names it — the two paths must not be collapsed, or a caller
    // that is waiting for an answer gets a log line instead.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new PgRunStore(poolAt(1));
    await expect(store.getRun('r1')).rejects.toThrow(/Database \(SELECT\)/);
    await settle();

    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toBe('');
  });
});

describe('every pool in this server is built by the one function that listens', () => {
  /**
   * Comments and imports stripped before the search.
   *
   * The rule is a SUBTRACTION — « nothing constructs a `pg.Pool` by itself » —
   * and not a list of the two call sites that exist tonight, because a list is
   * the exact-match set that has already cost this project every ingestion
   * endpoint once. The listener lives in `createPool` for the same reason
   * `describePgError` lives in `q()`: one choke point, so a pool nobody
   * remembered to wire cannot exist.
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

  const SERVER = join(import.meta.dirname, '..');
  const OWNER = join(import.meta.dirname, 'pg-store.ts');

  it('constructs a pg.Pool in pg-store.ts and nowhere else', () => {
    const offenders: string[] = [];
    for (const path of serverFiles(SERVER)) {
      if (path === OWNER) continue;
      const body = code(path);
      for (const m of body.matchAll(/new\s+Pool\s*\(/g)) {
        const line = body.slice(0, m.index).split('\n').length;
        offenders.push(`${path.replace(SERVER, 'server')}:${line}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('and pg-store.ts still constructs one, so the rule is not passing over nothing', () => {
    // The other direction. Without it the sweep above goes quietly green the
    // day somebody moves the pool somewhere it cannot see — which is how a
    // vacuous claim survives, and this repository has shipped one.
    expect(code(OWNER)).toMatch(/new\s+Pool\s*\(/);
  });
});
