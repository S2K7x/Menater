/**
 * What the engine's outbound nodes say when the call does not go through.
 *
 * ============================================================================
 * WHAT THESE CLAIM
 *
 * The engine records `(err as Error).message` as the step error, and the
 * console prints that string twice over: as the technical incident on the
 * card, and as the run's note in the Tracking tab. So whatever these three
 * nodes throw IS what an operator reads while an incident is open.
 *
 * Two ways of saying nothing were live, and the second is the worse of them:
 *
 *   NO CAUSE     Node's `fetch` rejects every transport failure with the same
 *                `TypeError: "fetch failed"`. A hostname with a typo in it, a
 *                chat service behind a firewall and an expired certificate all
 *                reached the card as those two words.
 *   A WRONG ONE  `llm` never looked at the status. The 401 of a refused key
 *                and the 402 of an exhausted account left `choices` undefined,
 *                and both were reported as "the model answered with no
 *                content" — which sends somebody to look at the model rather
 *                than at their key.
 *
 * These tests therefore assert two things about every failure: that the
 * sentence names the cause, and that it is NOT the sentence the defect
 * produced. The second half is what stops the first from being satisfied by a
 * new piece of vagueness.
 *
 * The transports are simulated. Nothing here reaches the network, and no
 * model key is needed — see `http.test.ts` for the measured shapes of Node
 * 22's own rejections, which the helpers below reproduce.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import { Engine } from '../engine.ts';
import { MemoryRunStore } from '../store.ts';
import type { NodeContext } from '../engine.ts';
import type { NodeDef, NodeType, WorkflowDef } from '../types.ts';
import { TransformRegistry, pureHandlers } from './pure.ts';
import { ioHandlers, type IoDeps } from './io.ts';
import { controlHandlers } from './control.ts';

const FIXED_NOW = new Date('2026-09-10T10:00:00.000Z');

/** The shape Node's `fetch` really rejects with: a useless message, a real cause. */
function fetchFailure(code: string, message: string): TypeError {
  const cause = new Error(message) as Error & { code?: string };
  cause.code = code;
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = cause;
  return err;
}

/** A transport that reaches nobody, whatever it is asked for. */
function unreachable(code = 'ECONNREFUSED', message = 'connect ECONNREFUSED 10.0.0.9:443') {
  return vi.fn(async () => {
    throw fetchFailure(code, message);
  }) as unknown as typeof globalThis.fetch;
}

function deps(over: Partial<IoDeps> = {}): IoDeps {
  return {
    transforms: new TransformRegistry(),
    vars: () => new Map(),
    now: () => FIXED_NOW,
    secret: () => undefined,
    ...over,
  };
}

function ctx(type: NodeType, params: Record<string, unknown>): NodeContext {
  const node: NodeDef = { id: 'n1', type, label: 'whatever', params, position: { x: 0, y: 0 } };
  return {
    runId: 'run-1',
    workflow: { id: 'wf', name: 'test', version: 1, nodes: [node], edges: [] },
    node,
    input: {},
    outputs: new Map(),
    alertId: 'A-1',
  };
}

/** Every sentence these nodes produce is read by a person. None may be this one. */
function expectNamesTheCause(message: string) {
  expect(message).not.toBe('fetch failed');
  expect(message).not.toMatch(/fetch failed/);
  expect(message).toMatch(/nothing is listening/i);
  expect(message).toContain('ECONNREFUSED');
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the call was expected to fail and did not');
}

describe('http — a ticket endpoint that answers nobody', () => {
  it('names the cause instead of throwing "fetch failed"', async () => {
    const h = ioHandlers(deps({ fetch: unreachable() }));
    const said = await messageOf(
      h.http(ctx('http', { url: { kind: 'const', value: 'https://tickets.corp.test/api/v2?k=1' } })),
    );
    expectNamesTheCause(said);
  });

  it('quotes the HOST and never the path or the query', async () => {
    // A configured endpoint can carry a token in its path. The host is enough
    // to tell one destination from another, and it cannot leak one.
    const h = ioHandlers(deps({ fetch: unreachable() }));
    const said = await messageOf(
      h.http(ctx('http', { url: { kind: 'const', value: 'https://tickets.corp.test/hook/s3cr3t?k=1' } })),
    );
    expect(said).toContain('tickets.corp.test');
    expect(said).not.toContain('s3cr3t');
    expect(said).not.toContain('/hook');
  });
});

describe('notify — the three transports, all unreachable', () => {
  const params = {
    channel: { kind: 'const', value: '#soc-approvals' },
    text: { kind: 'const', value: 'Approval required' },
  };

  it('slack-bot names Slack and the cause', async () => {
    const h = ioHandlers(deps({ fetch: unreachable(), secret: () => 'xoxb-test' }));
    const said = await messageOf(h.notify(ctx('notify', params)));
    expectNamesTheCause(said);
    expect(said).toContain('Slack');
  });

  it('slack-webhook names Slack and the cause, never the secret URL', async () => {
    const h = ioHandlers(
      deps({
        fetch: unreachable(),
        vars: () => new Map([['notify.transport', 'slack-webhook']]),
        secret: () => 'https://hooks.slack.test/services/T/B/s3cr3t',
      }),
    );
    const said = await messageOf(h.notify(ctx('notify', params)));
    expectNamesTheCause(said);
    expect(said).toContain('Slack');
    // A webhook URL IS the credential. It must not travel into a step error,
    // which is written to the run journal and printed on the card.
    expect(said).not.toContain('s3cr3t');
  });

  it('discord-webhook names Discord and the cause, never the secret URL', async () => {
    const h = ioHandlers(
      deps({
        fetch: unreachable(),
        vars: () => new Map([['notify.transport', 'discord-webhook']]),
        secret: () => 'https://discord.test/api/webhooks/1/s3cr3t',
      }),
    );
    const said = await messageOf(h.notify(ctx('notify', params)));
    expectNamesTheCause(said);
    expect(said).toContain('Discord');
    expect(said).not.toContain('s3cr3t');
  });
});

describe('llm — the node the whole triage hangs on', () => {
  const node = () =>
    ctx('llm', {
      model: { kind: 'const', value: 'm' },
      prompt: { kind: 'const', value: 'p' },
      requiredKeys: ['verdict'],
    });

  it('names the cause when the provider is unreachable', async () => {
    const h = ioHandlers(deps({ fetch: unreachable(), secret: () => 'sk-test' }));
    const said = await messageOf(h.llm(node()));
    expectNamesTheCause(said);
  });

  it('says the request was REFUSED, not that the model answered nothing', async () => {
    // A wrong key is the single most likely misconfiguration on a fresh
    // install, and it left `choices` undefined — so the operator was told the
    // model had answered with no content. It had not been asked.
    const refusal = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), {
          status: 401,
        }),
    ) as unknown as typeof globalThis.fetch;

    const h = ioHandlers(deps({ fetch: refusal, secret: () => 'sk-wrong' }));
    const said = await messageOf(h.llm(node()));

    expect(said).not.toMatch(/answered with no content/i);
    expect(said).toMatch(/refused/i);
    expect(said).toContain('401');
  });

  it('still names a refusal that carries no body at all', async () => {
    const refusal = vi.fn(
      async () => new Response('', { status: 429 }),
    ) as unknown as typeof globalThis.fetch;
    const h = ioHandlers(deps({ fetch: refusal, secret: () => 'sk-test' }));
    const said = await messageOf(h.llm(node()));
    expect(said).toContain('429');
    expect(said).not.toMatch(/answered with no content/i);
  });

  it('leaves a 200 that really is empty saying exactly that', async () => {
    // The old sentence was not wrong in general — only in the case it was
    // reached by. It stays for the case it describes.
    const empty = vi.fn(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const h = ioHandlers(deps({ fetch: empty, secret: () => 'sk-test' }));
    expect(await messageOf(h.llm(node()))).toMatch(/answered with no content/i);
  });
});

describe('the sentence reaches the run journal, which is what the console prints', () => {
  /** Two nodes: receive, then post. The smallest graph that makes a real call. */
  function notifyWorkflow(): WorkflowDef {
    return {
      id: '04-action-routing',
      name: 'Action & Routing',
      version: 1,
      nodes: [
        { id: 'in', type: 'trigger.subflow', label: 'From 03', params: {}, position: { x: 0, y: 0 } },
        {
          id: 'ask',
          type: 'notify',
          label: 'Approval request',
          params: {
            channel: { kind: 'const', value: '#soc-approvals' },
            text: { kind: 'const', value: 'Approval required' },
          },
          position: { x: 1, y: 0 },
        },
      ],
      edges: [{ from: 'in', fromPort: 'main', to: 'ask' }],
    };
  }

  it('records the cause on the failed step and on the run, not "fetch failed"', async () => {
    const store = new MemoryRunStore();
    const d = {
      transforms: new TransformRegistry(),
      vars: () => new Map<string, unknown>(),
      now: () => FIXED_NOW,
      secret: (name: string) => (name === 'slack.botToken' ? 'xoxb-test' : undefined),
      fetch: unreachable(),
      newToken: () => 'fixed-token',
    };
    const engine = new Engine({
      store,
      handlers: { ...pureHandlers(d), ...ioHandlers(d), ...controlHandlers(d) },
      now: () => FIXED_NOW,
      newId: () => 'run-1',
    });
    engine.register(notifyWorkflow());

    const run = await engine.start('04-action-routing', { action: 'escalate' }, 'A-1');

    expect(run.status).toBe('failed');
    expectNamesTheCause(String(run.error));

    const failed = (await store.stepsOf(run.id)).find((s) => s.status === 'failed');
    expect(failed?.nodeId).toBe('ask');
    expectNamesTheCause(String(failed?.error));
  });
});
