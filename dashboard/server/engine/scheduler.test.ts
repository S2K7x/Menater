/**
 * Tests for the scheduler that makes an approval deadline mean something.
 *
 * ============================================================================
 * WHAT THEY PROTECT
 *
 * The escalation code was right and unreachable: `sweepExpiredWaits` had no
 * caller outside the tests, so the thirty minutes promised to a human in the
 * approval request elapsed and nothing happened. A test that drives the sweep
 * by hand — which is what the engine's own tests do — passes over exactly that
 * defect, because calling it is the part that was missing.
 *
 * So these drive the SCHEDULER, on an injected clock and an injected period,
 * and they claim the two boundaries that matter to a process: it never rejects
 * out of a timer (an uncaught rejection from `setInterval` terminates Node 22),
 * and it never runs two sweeps at once.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { Engine, type NodeHandler } from './engine.ts';
import { WaitScheduler } from './scheduler.ts';
import { MemoryRunStore } from './store.ts';
import type { NodeDef, NodeType, WorkflowDef } from './types.ts';

const node = (id: string, type: NodeType): NodeDef =>
  ({ id, type, label: id, params: {}, position: { x: 0, y: 0 } });
const edge = (from: string, to: string, fromPort = 'main') => ({ from, fromPort, to });
const pass: NodeHandler = async (ctx) => ({ output: ctx.input });

/**
 * The shape of `04-Action-Routing` around its wait: the `timeout` port leads to
 * an escalation and NEVER to the action. That is the property being scheduled.
 */
const approvalFlow = (): WorkflowDef => ({
  id: 'wf',
  name: 'approval',
  version: 1,
  nodes: [
    node('t', 'trigger.webhook'),
    node('attente', 'wait'),
    node('execute', 'http'),
    node('escalate-timeout', 'notify'),
  ],
  edges: [
    edge('t', 'attente'),
    edge('attente', 'execute', 'main'),
    edge('attente', 'escalate-timeout', 'timeout'),
  ],
});

function pipeline() {
  let clock = new Date('2026-09-24T10:00:00Z');
  let tokens = 0;
  let runs = 0;
  const store = new MemoryRunStore();
  const executed = vi.fn(async () => ({ output: {} }));
  const escalated = vi.fn(async () => ({ output: {} }));
  const engine = new Engine({
    store,
    handlers: {
      'trigger.webhook': pass,
      wait: async () => ({
        output: null,
        suspend: { token: `tok-${++tokens}`, deadlineMs: 30 * 60_000 },
      }),
      http: executed,
      notify: escalated,
    },
    now: () => clock,
    newId: () => `run-${++runs}`,
  });
  engine.register(approvalFlow());
  return {
    engine, store, executed, escalated,
    at: (iso: string) => { clock = new Date(iso); },
  };
}

describe('the approval deadline', () => {
  it('escalates once the scheduler has ticked, and not before', async () => {
    const { engine, store, executed, escalated, at } = pipeline();
    const scheduler = new WaitScheduler({ engine: () => engine });

    await engine.start('wf', {});
    expect((await store.getRun('run-1'))?.status).toBe('waiting');

    // Twenty-nine minutes: the question is still open, and a sweep must leave
    // it alone. Escalating early would answer for a human who still has time.
    at('2026-09-24T10:29:00Z');
    expect(await scheduler.tick()).toEqual([]);
    expect((await store.getRun('run-1'))?.status).toBe('waiting');

    // Thirty-one. THIS is the line that did not exist: without a scheduler the
    // run stayed `waiting` for ever and nobody was told.
    at('2026-09-24T10:31:00Z');
    expect(await scheduler.tick()).toEqual(['run-1']);

    expect((await store.getRun('run-1'))?.status).toBe('done');
    expect(escalated).toHaveBeenCalledTimes(1);
    // SILENCE IS NEVER CONSENT. The action is not executed by expiry.
    expect(executed).not.toHaveBeenCalled();
  });

  it('fires from the timer, not only when a test calls tick()', async () => {
    const { engine, store, escalated, at } = pipeline();
    const scheduler = new WaitScheduler({ engine: () => engine });
    await engine.start('wf', {});
    at('2026-09-24T10:31:00Z');

    vi.useFakeTimers();
    try {
      scheduler.start(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }

    expect(escalated).toHaveBeenCalledTimes(1);
    expect((await store.getRun('run-1'))?.status).toBe('done');
  });
});

describe('what the timer may never do', () => {
  it('never rejects: an unreachable database is reported, not thrown', async () => {
    const reportError = vi.fn();
    const scheduler = new WaitScheduler({
      engine: () => ({
        sweepExpiredWaits: async () => { throw new Error('ECONNREFUSED'); },
      }) as unknown as Engine,
      reportError,
    });

    // `setInterval(() => void this.tick())` with an uncaught rejection inside
    // terminates a Node 22 process. The sweep runs on a security console; it
    // may fail, it may not take the console with it.
    await expect(scheduler.tick()).resolves.toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('says a failure once, and says when it stops', async () => {
    const report = vi.fn();
    const reportError = vi.fn();
    let broken = true;
    const scheduler = new WaitScheduler({
      engine: () => ({
        sweepExpiredWaits: async () => {
          if (broken) throw new Error('the database is refusing');
          return { resumed: [], failed: [] };
        },
      }) as unknown as Engine,
      report,
      reportError,
    });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    // A line a minute repeating one sentence is the permanent alarm this
    // console refuses everywhere else.
    expect(reportError).toHaveBeenCalledTimes(1);

    broken = false;
    await scheduler.tick();
    // And the recovery is said, because the silence that follows a failure
    // otherwise reads exactly like the silence before it.
    expect(report).toHaveBeenCalledWith(expect.stringContaining('answering again'));
  });

  it('names the run and the cause of an expiry it could not settle', async () => {
    const reportError = vi.fn();
    const scheduler = new WaitScheduler({
      engine: () => ({
        sweepExpiredWaits: async () => ({
          resumed: ['run-8'],
          failed: [{ runId: 'run-9', error: 'Database (UPDATE): deadlock detected' }],
        }),
      }) as unknown as Engine,
      reportError,
    });

    // A run swept and a run that failed in the same pass: the failure is not
    // hidden by the success beside it, and it names WHICH run.
    expect(await scheduler.tick()).toEqual(['run-8']);
    const line = reportError.mock.calls[0]?.[0] as string;
    expect(line).toContain('run-9');
    expect(line).toContain('deadlock detected');
  });

  it('never reports a failure with no cause in it', async () => {
    // `pg` rejects an `ECONNREFUSED` with an EMPTY message — that one is
    // recovered at `PgRunStore.q()`, the single choke point every query of
    // that store passes through. A `RunStore` is an interface, so the last
    // guard is here: a line saying « approval sweep failed — » and nothing
    // else is a failure with no cause, which is the state this console exists
    // to refuse.
    const reportError = vi.fn();
    const scheduler = new WaitScheduler({
      engine: () => ({
        sweepExpiredWaits: async () => { throw Object.assign(new Error(''), { code: 'X' }); },
      }) as unknown as Engine,
      reportError,
    });

    await scheduler.tick();
    const line = reportError.mock.calls[0]?.[0] as string;
    expect(line.replace('approval sweep failed \u2014', '').trim()).not.toBe('');
  });

  it('does not let two sweeps run at once', async () => {
    let entered = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new WaitScheduler({
      engine: () => ({
        sweepExpiredWaits: async () => {
          entered += 1;
          await gate;
          return { resumed: [], failed: [] };
        },
      }) as unknown as Engine,
    });

    const first = scheduler.tick();
    // A sweep drives runs to completion; two of them over the same run would
    // replay its steps. A sweep slower than its period sweeps less often —
    // that is the honest consequence, and it is what the poller does too.
    expect(await scheduler.tick()).toEqual([]);
    expect(entered).toBe(1);

    release();
    await first;
    await scheduler.tick();
    expect(entered).toBe(2);
  });

  it('is a no-op with no database, and picks the engine up when there is one', async () => {
    const { engine, escalated, at } = pipeline();
    let mounted: Engine | null = null;
    const reportError = vi.fn();
    const scheduler = new WaitScheduler({ engine: () => mounted, reportError });

    // No database configured is a normal state, not a failure to announce.
    expect(await scheduler.tick()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();

    // The engine is read on EVERY tick, so a database configured from the
    // Settings tab starts honouring deadlines without a restart.
    await engine.start('wf', {});
    at('2026-09-24T10:31:00Z');
    mounted = engine;
    expect(await scheduler.tick()).toEqual(['run-1']);
    expect(escalated).toHaveBeenCalledTimes(1);
  });

  it('start() twice leaves ONE timer, and stop() removes it', () => {
    const scheduler = new WaitScheduler({ engine: () => null });
    vi.useFakeTimers();
    try {
      scheduler.start(60_000);
      const count = vi.getTimerCount();
      scheduler.start(60_000);
      // Two timers would mean two sweeps per period over the same runs.
      expect(vi.getTimerCount()).toBe(count);
      expect(scheduler.running()).toBe(true);
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(scheduler.running()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unrefs its timer, so a console asked to stop stops', () => {
    // Asserted on the call, not on process lifetime: `unref` is what makes the
    // difference, and a test that tried to observe an exit would be a test
    // that waits. Fake timers do not model `unref`, so the real function is
    // stubbed for the length of this check.
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      { unref } as unknown as ReturnType<typeof setInterval>,
    );
    try {
      new WaitScheduler({ engine: () => null }).start(60_000);
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The line that was missing.
 *
 * ============================================================================
 * WHY THIS ONE READS THE SOURCE
 *
 * Everything above proves the scheduler works. None of it proves anything
 * STARTS it — which is the entire defect: the sweep was correct, tested and
 * unreachable for its whole life, because no caller existed outside the tests.
 * Deleting the boot line would leave every test in this file green over a
 * console that silently stops honouring its approval deadlines again.
 *
 * `server/api.ts` cannot be imported by a test: importing it opens a port,
 * which is the reason `app.ts` exists as a separate module. So this reads it,
 * the way `n8n-removed.test.ts` reads the catalogues, and with the same
 * precaution — COMMENTS ARE STRIPPED FIRST, or the paragraph above the call
 * would go on vouching for a call somebody had removed.
 *
 * It claims what a source read honestly can: that the process starts the
 * scheduler and stops it on the way out. It cannot claim the sweep runs in
 * production; the tests above are what claim that.
 * ============================================================================
 */
describe('the boot wiring', () => {
  const source = readFileSync(new URL('../api.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('starts the scheduler when the process starts', () => {
    expect(source).toMatch(/getWaitScheduler\([^)]*\)\s*\.start\(/);
  });

  it('stops it on SIGTERM, beside the poller', () => {
    // A timer left running through a shutdown can drive a run the process is
    // about to abandon mid-step — and `stopPoller` is already there for the
    // same reason.
    expect(source).toContain('stopWaitScheduler()');
  });
});
