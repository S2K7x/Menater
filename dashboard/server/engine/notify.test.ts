/**
 * Slack: the two transports, and the notification threshold.
 *
 * ============================================================================
 * WHAT THESE CLAIM
 *
 * The transports are not interchangeable plumbing — each has a way of lying
 * about success that the other does not:
 *
 *   - the bot API answers HTTP 200 with `ok: false` when it FAILED;
 *   - a webhook answers the literal text `ok`, which `res.json()` throws on.
 *
 * Either mistake turns a message nobody received into a success, and the
 * message in question is usually an approval request — so the run would wait
 * thirty minutes for an answer to a question that was never asked.
 *
 * The threshold's claim is different and it is a safety one: suppressing a
 * question must never produce silent waiting.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import { makeNotify } from './nodes/io.ts';
import { buildRegistry } from './transforms/registry.ts';
import { reachesNotification } from './transforms/routing.ts';
import { TransformRegistry } from './nodes/pure.ts';

const NOW = new Date('2026-09-04T10:00:00.000Z');

function ctxFor(node: Record<string, unknown>) {
  return {
    node: { id: 'post', type: 'notify', label: 'Post', params: node, position: { x: 0, y: 0 } },
    input: {},
    outputs: {},
    runId: 'run-1',
    alertId: 'ALT-1',
    // The node builds a resolution scope from the run's context; a stub that
    // omits it fails inside the scope builder rather than in the code under
    // test, which is a test defect, not a finding.
    workflow: { id: '04-action-routing', name: 'Action & Routing', version: 1 },
    attempt: 1,
  } as unknown as Parameters<ReturnType<typeof makeNotify>>[0];
}

const PARAMS = {
  channel: { kind: 'const', value: '#soc-approvals' },
  text: { kind: 'const', value: 'Approval required' },
};

function deps(over: {
  vars?: Record<string, unknown>;
  secrets?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}) {
  return {
    transforms: new TransformRegistry(),
    vars: () => new Map<string, unknown>(Object.entries(over.vars ?? {})),
    now: () => NOW,
    secret: (name: string) => over.secrets?.[name],
    fetch: over.fetch,
  };
}

describe('the incoming-webhook transport', () => {
  it('posts to the secret URL, with NO channel field', async () => {
    // Slack binds a webhook to one channel and IGNORES a `channel` in the
    // payload. Sending one would suggest the four channel settings still apply.
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const out = await makeNotify(deps({
      vars: { 'notify.transport': 'slack-webhook' },
      secrets: { 'slack.webhookUrl': 'https://hooks.slack.com/services/T/B/xxx' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS));

    expect(calls[0].url).toBe('https://hooks.slack.com/services/T/B/xxx');
    expect(calls[0].body).toEqual({ text: 'Approval required' });
    expect(calls[0].body).not.toHaveProperty('channel');
    // No message timestamp exists on a webhook: `null` says so rather than an
    // empty string that would read as an id.
    expect(out.output).toEqual({ ts: null, transport: 'slack-webhook' });
  });

  it('treats the literal text "ok" as success, not as unparseable JSON', async () => {
    // `res.json()` throws on `ok`. Reading a webhook like the bot API would
    // report every successful post as a failure.
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof globalThis.fetch;
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'slack-webhook' },
      secrets: { 'slack.webhookUrl': 'https://hooks.slack.com/x' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS))).resolves.toBeDefined();
  });

  it('reports a refusal with the plain-text reason Slack gives', async () => {
    const fetchImpl = (async () =>
      new Response('invalid_payload', { status: 400 })) as typeof globalThis.fetch;
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'slack-webhook' },
      secrets: { 'slack.webhookUrl': 'https://hooks.slack.com/x' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS))).rejects.toThrow(/invalid_payload/);
  });

  it('names the missing credential AND the way out', async () => {
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'slack-webhook' },
      fetch: (async () => new Response('ok')) as typeof globalThis.fetch,
    }))(ctxFor(PARAMS))).rejects.toThrow(/slack.webhookUrl.*notify.transport/s);
  });
});

describe('the Discord webhook transport', () => {
  it('speaks content and embeds, not text and blocks', async () => {
    // Discord's payload vocabulary is its own. Sending Slack's would be
    // refused with a 400 that names nothing useful.
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const out = await makeNotify(deps({
      vars: { 'notify.transport': 'discord-webhook' },
      secrets: { 'discord.webhookUrl': 'https://discord.com/api/webhooks/1/tok' },
      fetch: fetchImpl,
    }))(ctxFor({ ...PARAMS, embeds: { kind: 'const', value: [{ title: 'Approval required' }] } }));

    expect(sent.content).toBe('Approval required');
    expect(sent.embeds).toEqual([{ title: 'Approval required' }]);
    expect(sent).not.toHaveProperty('text');
    expect(sent).not.toHaveProperty('blocks');
    expect(sent).not.toHaveProperty('channel');
    expect(out.output).toEqual({ ts: null, transport: 'discord-webhook' });
  });

  it('treats 204 with an EMPTY body as success', async () => {
    // The third distinct success signal. `res.json()` throws on an empty body
    // and a truthiness check on it would call a delivered message a failure.
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'discord-webhook' },
      secrets: { 'discord.webhookUrl': 'https://discord.com/api/webhooks/1/tok' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS))).resolves.toBeDefined();
  });

  it('names a rate limit as a rate limit, not as an outage', async () => {
    // Discord allows about 5 requests per 2 seconds per webhook and answers 429
    // with `retry_after` in SECONDS. Telling a 429 from a 500 is what stops
    // somebody debugging a network that is fine.
    const fetchImpl = (async () => new Response(
      JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.75 }),
      { status: 429 },
    )) as typeof globalThis.fetch;
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'discord-webhook' },
      secrets: { 'discord.webhookUrl': 'https://discord.com/api/webhooks/1/tok' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS))).rejects.toThrow(/rate-limited.*429/);
  });

  it('reports a refusal with the body Discord sent', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ message: 'Invalid Webhook Token', code: 50027 }), { status: 401 },
    )) as typeof globalThis.fetch;
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'discord-webhook' },
      secrets: { 'discord.webhookUrl': 'https://discord.com/api/webhooks/1/tok' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS))).rejects.toThrow(/Invalid Webhook Token/);
  });

  it('clips an over-long message instead of losing it to a 400', async () => {
    // Discord caps `content` at 2000 characters. A truncated escalation still
    // tells somebody to come and look; a 400 loses the notification entirely.
    let sent: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    await makeNotify(deps({
      vars: { 'notify.transport': 'discord-webhook' },
      secrets: { 'discord.webhookUrl': 'https://discord.com/api/webhooks/1/tok' },
      fetch: fetchImpl,
    }))(ctxFor({ ...PARAMS, text: { kind: 'const', value: 'x'.repeat(5000) } }));

    expect(sent.content.length).toBeLessThanOrEqual(2000);
    expect(sent.content.endsWith('\u2026')).toBe(true);
  });

  it('names the missing credential AND the way out', async () => {
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'discord-webhook' },
      fetch: (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch,
    }))(ctxFor(PARAMS))).rejects.toThrow(/discord.webhookUrl.*notify.transport/s);
  });
});

describe('the bot-token transport', () => {
  it('still routes by channel', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, ts: '1.2' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const out = await makeNotify(deps({
      vars: { 'notify.transport': 'slack-bot' },
      secrets: { 'slack.botToken': 'xoxb-1' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS));

    expect(sent.channel).toBe('#soc-approvals');
    expect(out.output).toEqual({ ts: '1.2', transport: 'slack-bot' });
  });

  it('does not mistake HTTP 200 with ok:false for a success', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 })
    ) as typeof globalThis.fetch;
    await expect(makeNotify(deps({
      vars: { 'notify.transport': 'slack-bot' },
      secrets: { 'slack.botToken': 'xoxb-1' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS))).rejects.toThrow(/channel_not_found/);
  });

  it('is the default, so an install that sets nothing keeps working', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, ts: '9' }), { status: 200 })) as typeof globalThis.fetch;
    const out = await makeNotify(deps({
      vars: {},
      secrets: { 'slack.botToken': 'xoxb-1' },
      fetch: fetchImpl,
    }))(ctxFor(PARAMS));
    expect(out.output).toMatchObject({ transport: 'slack-bot' });
  });
});

describe('the severity threshold', () => {
  it('notifies at and above the threshold, and not below', () => {
    expect(reachesNotification('critical', 'high')).toBe(true);
    expect(reachesNotification('high', 'high')).toBe(true);
    expect(reachesNotification('medium', 'high')).toBe(false);
    expect(reachesNotification('low', 'high')).toBe(false);
  });

  it('sends nothing at all when set to off', () => {
    for (const sev of ['low', 'medium', 'high', 'critical']) {
      expect(reachesNotification(sev, 'off')).toBe(false);
    }
  });

  it('defaults to notifying about EVERYTHING when unset or unreadable', () => {
    // A knob nobody set must not quietly silence a console.
    expect(reachesNotification('low', undefined)).toBe(true);
    expect(reachesNotification('low', '')).toBe(true);
    expect(reachesNotification('low', 'nonsense')).toBe(true);
  });

  it('always notifies for an UNRATED alert', () => {
    // Severity did not survive normalization. Treating it as low enough to
    // silence would quietly drop something that might be a critical — the same
    // rule the ingestion lanes apply.
    expect(reachesNotification(null, 'critical')).toBe(true);
    expect(reachesNotification('weird', 'critical')).toBe(true);
  });
});

describe('a suppressed approval request', () => {
  const registry = buildRegistry({ now: () => NOW, resumeUrl: () => 'https://console/?run=1' });

  it('escalates instead of waiting, and says why', () => {
    // THE SAFETY RULE. Suppressing a question and then waiting thirty minutes
    // for its answer would be the worst of both: nobody asked, and the alert
    // sits blocked until it times out.
    const out = registry.get('approvalBelowThreshold')!(
      {
        not_notified_reason: 'severity "low" is below the Slack threshold (slack.minSeverity = high).',
        proposed_action: 'isolate_host_temporary',
      },
      new Map(),
      { runId: 'r1' },
    ) as Record<string, unknown>;

    expect(out.routing_outcome).toBe('not_notified');
    expect(out.executed).toBe(false);
    // No approval object at all: nothing is pending, so nothing waits.
    expect(out.approval).toBeNull();
    const details = out.action_details as Record<string, string>;
    expect(details.reason).toMatch(/below the Slack threshold/);
    expect(details.consequence).toMatch(/not left waiting/);
    // And what it WOULD have done is kept, so the card can say what was skipped.
    expect(out.would_have_done).toBe('isolate_host_temporary');
  });
});


describe('the case a suppressed alert produces', () => {
  it('shows no pending approval, because none was requested', async () => {
    // `request` runs before the threshold branch, so its output exists either
    // way. Read unconditionally it put a `pending` approval on a CLOSED case —
    // a decision that looks like it is still waiting for somebody.
    const { buildCases } = await import('./cases.ts');
    const { DEFAULT_LOCALE } = await import('../i18n.ts');

    const run = {
      id: 'r4', workflowId: '04-action-routing', workflowVersion: 1,
      status: 'done' as const, alertId: 'ALT-9', input: {},
      startedAt: '2026-09-04T10:00:00.000Z', endedAt: '2026-09-04T10:00:01.000Z', error: null,
    };
    const step = (nodeId: string, output: unknown) => ({
      runId: 'r4', nodeId, attempt: 1, status: 'ok' as const, output,
      port: 'main', error: null,
      startedAt: '2026-09-04T10:00:00.500Z', endedAt: '2026-09-04T10:00:00.900Z',
    });

    const { cases } = buildCases([run], new Map([['r4', [
      step('request', { requested_action: 'escalate', intent: 'x', notify: false }),
      step('below-threshold', { routing_outcome: 'not_notified' }),
    ]]]), { limit: 10, locale: DEFAULT_LOCALE, now: () => NOW });

    expect(cases[0].approval).toBeNull();
    expect(cases[0].routing_outcome).toBe('not_notified');
    expect(cases[0].executed).toBe(false);
    // And it is CLOSED, not awaiting: nothing is pending, so nothing waits.
    expect(cases[0].state).toBe('closed');
  });
});
