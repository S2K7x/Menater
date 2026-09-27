/**
 * What the engine does with a failing step — and the policy it does NOT have.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `NodeDef` carried a `retry?: { attempts, backoffMs }` field. Five nodes
 * declared one, a comment in `nodes/io.ts` named it as the thing that waits out
 * a Discord 429, and `WorkflowPanel` PRINTED it on the step card — « Retries 2
 * times, 400 ms apart » — one line under `effectHelp`'s « NEVER replayed », on
 * the same card, about the same node. Nothing read the field. Measured before
 * removing it: a node declaring `attempts: 3` is called once and the journal
 * records `attempt: 1`.
 *
 * So an operator reading the Ingestion tab to understand an incident was told
 * the pipeline retries the deduplication insert and the audit append. It does
 * not. That is a setting that looks applied and is not, printed on the screen
 * whose job is to say what the pipeline does.
 *
 * Two halves of one claim, and the assertions divide that way:
 *
 *   1. no workflow declares a retry policy — because there is nobody to apply
 *      it. RED before the removal: five nodes declared one. The two assertions
 *      beside it exist so that this one cannot pass over an empty sweep — it
 *      names the six workflows and counts the external calls, the same reason
 *      the scan report names what it read before saying it found nothing.
 *   2. a failing node is called ONCE and takes its `error` port. This is the
 *      REASON for (1), and it passes before and after on purpose: it is what a
 *      future implementation of retry has to change deliberately, and the file
 *      it has to come back to.
 *
 * Note what is NOT asserted: that the engine should never retry. Whether it
 * should is ROADMAP § 7 — and the answer is not uniform, because `NODE_EFFECTS`
 * already says a `read` may be replayed and a `write` may not, while all five
 * declarations sat on `postgres`, i.e. `write`.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { Engine } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import { PIPELINE_WORKFLOWS } from './workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './workflows/routing.ts';
import type { NodeDef, WorkflowDef } from './types.ts';

const ALL = [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS];

describe('the definitions declare no policy the executor ignores', () => {
  it('sweeps all six workflows, named', () => {
    // A sweep over an empty list proves nothing — the same reason the scan
    // report names what it read before saying it found nothing.
    expect(ALL.map((w) => w.id)).toEqual([
      '01-ingestion', '02-enrichment', '03-ai-decision',
      '04-action-routing', '05-audit-log', '06-error-handler',
    ]);
  });

  it('no node declares a retry policy', () => {
    // The key is read off the object rather than off the type: deleting the
    // field from `NodeDef` would make a typed assertion pass by construction,
    // which is not the question. What must stay true is that no DEFINITION
    // carries a policy the executor does not read.
    const declaring: string[] = [];
    for (const wf of ALL) {
      for (const node of wf.nodes) {
        if ('retry' in (node as unknown as Record<string, unknown>)) {
          declaring.push(`${wf.id}/${node.id}`);
        }
      }
    }
    expect(declaring).toEqual([]);
  });

  it('counts the sixteen outbound calls — they are what is not retried', () => {
    // The count is what makes the test above mean something: if the external
    // calls ever left these graphs, "nobody declares a retry" would be true of
    // a pipeline that dials nothing. `subflow` and `wait` are excluded: they
    // are `write` in `NODE_EFFECTS` and they dial nobody.
    const external = ALL.flatMap((wf) => wf.nodes
      .filter((n) => n.type === 'http' || n.type === 'postgres'
        || n.type === 'notify' || n.type === 'llm')
      .map((n) => `${wf.id}/${n.id}`));
    expect(external.length).toBe(16);
    // And every one of them has a wired failure path — the rule that replaced
    // « every external-call node must have Retry On Fail enabled » in
    // CLAUDE.md § Rules. The per-workflow tests assert it graph by graph;
    // this asserts it across all six at once.
    for (const wf of ALL) {
      for (const n of wf.nodes) {
        if (!external.includes(`${wf.id}/${n.id}`)) continue;
        const wired = wf.edges.some((e) => e.from === n.id && e.fromPort === 'error');
        expect(wired, `${wf.id}/${n.id} has no error branch`).toBe(true);
      }
    }
  });
});

describe('what the engine really does with a failing step', () => {
  const node = (id: string, type: NodeDef['type']): NodeDef => ({
    id, type, label: id, params: {}, position: { x: 0, y: 0 },
  });

  function run(edges: { from: string; fromPort: string; to: string }[]) {
    let calls = 0;
    const wf: WorkflowDef = {
      id: 'wf', name: 'wf', version: 1,
      nodes: [node('t', 'trigger.webhook'), node('dial', 'http'), node('caught', 'transform')],
      edges,
    };
    const store = new MemoryRunStore();
    const engine = new Engine({
      store,
      handlers: {
        'trigger.webhook': async (ctx) => ({ output: ctx.input }),
        http: async () => { calls++; throw new Error('boom'); },
        transform: async (ctx) => ({ output: ctx.input }),
      },
      newId: () => 'run-1',
    });
    engine.register(wf);
    return { engine, store, calls: () => calls };
  }

  it('calls the node ONCE, with no wait and no second attempt', async () => {
    const { engine, store, calls } = run([
      { from: 't', fromPort: 'main', to: 'dial' },
      { from: 'dial', fromPort: 'error', to: 'caught' },
    ]);
    const record = await engine.start('wf', { a: 1 });

    expect(calls()).toBe(1);
    // The error branch absorbs the failure, so the run itself completes.
    expect(record.status).toBe('done');
    const step = (await store.stepsOf('run-1')).find((s) => s.nodeId === 'dial')!;
    expect(step.status).toBe('failed');
    expect(step.port).toBe('error');
    // `attempt` is 1 and stays 1. The column exists — `soc_run_step`'s primary
    // key is (run, node, attempt) — but nothing ever increments it.
    expect(step.attempt).toBe(1);
  });

  it('with no error branch wired, the failure stops the run rather than repeating it', async () => {
    const { engine, calls } = run([{ from: 't', fromPort: 'main', to: 'dial' }]);
    const record = await engine.start('wf', { a: 1 });

    expect(calls()).toBe(1);
    expect(record.status).toBe('failed');
    expect(record.error).toBe('boom');
  });
});
