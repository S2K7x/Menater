/**
 * The alert entry point: the three guards, and what they refuse.
 *
 * ============================================================================
 * WHY THESE, AND NOT "IT ACCEPTS AN ALERT"
 *
 * This is the most sensitive door in the product — an alert is what leads to a
 * model call, an approval request, and potentially the isolation of a machine.
 * So the tests claim the REFUSALS, which are the part that has to hold when
 * somebody is trying:
 *
 *   1. Closed by default. An ingestion endpoint is not opened by accident.
 *   2. An empty secret CLOSES the door rather than opening it to everyone.
 *      That is the inverse of the usual behaviour, and the inverse is the
 *      point: "no authentication configured" reads as "none required".
 *   3. A wrong secret is refused without saying WHY it was refused.
 *
 * This file used to be three times longer, and most of it described the
 * `shadow` mode relaying to an n8n instance. That mode is gone with n8n, and
 * with it the sharpest edge it had: on an install with no n8n, `shadow`
 * answered 502 for every alert the engine had handled perfectly well.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import { handleAlert, readAlertId, type WebhookDeps } from './webhook.ts';

/**
 * A stub engine.
 *
 * `responseOf` returns `null` by default: no `respond` node reached, so the
 * handler falls back to naming the run. The tests that care about the
 * pipeline's own verdict pass one explicitly.
 */
const engine = (
  start = vi.fn(async () => ({ id: 'run-1', status: 'done' })),
  responseOf: () => Promise<{ status: number; body: unknown } | null> = async () => null,
) => ({ start, responseOf } as unknown as WebhookDeps['engine']);

const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
  mode: 'on',
  secret: 'sekret',
  engine: engine(),
  ...over,
});

const auth = { 'x-soc-token': 'sekret' };
const alert = { alert_id: 'ALT-1', rule_name: 'Failed SSH logins', severity: 'high' };

describe('guard 1 — closed by default', () => {
  it('refuses everything while the mode is off, and says where to open it', async () => {
    const r = await handleAlert(deps({ mode: 'off' }), auth, alert);
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('webhook_disabled');
    // The remedy, not just the refusal: an endpoint nobody can work out how to
    // open is an endpoint nobody opens.
    expect(String(r.body.detail)).toMatch(/Settings/);
  });

  it('does not start the pipeline when it is closed', async () => {
    const start = vi.fn();
    await handleAlert(deps({ mode: 'off', engine: engine(start as never) }), auth, alert);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('guard 2 — an empty secret CLOSES the door', () => {
  it('refuses even a request carrying a token', async () => {
    const r = await handleAlert(deps({ secret: '' }), auth, alert);
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('webhook_secret_missing');
  });

  it('refuses a request carrying no token either — it is closed, not permissive', async () => {
    // The inverse of the usual behaviour, and the reason it is written down:
    // "no authentication configured" must never resolve to "no authentication
    // required" on a door that leads to isolating a machine.
    const r = await handleAlert(deps({ secret: '' }), {}, alert);
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('webhook_secret_missing');
  });
});

describe('guard 3 — the secret', () => {
  it('refuses a wrong secret', async () => {
    const r = await handleAlert(deps(), { 'x-soc-token': 'wrong' }, alert);
    expect(r.status).toBe(401);
  });

  it('refuses a missing secret the same way, with no detail', async () => {
    const r = await handleAlert(deps(), {}, alert);
    expect(r.status).toBe(401);
    // Saying "invalid" rather than "missing" tells an attacker something about
    // how this installation is configured.
    expect(r.body.detail).toBeUndefined();
    expect(r.body.reason).toBe('unauthorized');
  });

  it('accepts a header that arrived as an array, which some proxies do', async () => {
    const r = await handleAlert(deps(), { 'x-soc-token': ['sekret'] }, alert);
    expect(r.status).toBe(202);
  });
});

describe('what it does once every guard has passed', () => {
  it('starts 01-ingestion and answers 202 with the run id', async () => {
    const start = vi.fn(async (_wf: string, _input: unknown, _id: string | null) =>
      ({ id: 'run-42', status: 'running' }));
    const r = await handleAlert(deps({ engine: engine(start as never) }), auth, alert, 'wazuh');

    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'accepted', alert_id: 'ALT-1', run_id: 'run-42' });
    // WHICH NORMALIZER RAN. Someone integrating a new source needs to see it
    // hit the mapping they meant, not merely that we said 202.
    expect(r.body.source).toBe('wazuh');
    expect(start.mock.calls[0][0]).toBe('01-ingestion');
    expect(start.mock.calls[0][1]).toMatchObject({ alert_id: 'ALT-1', source: 'wazuh' });
  });

  it('RETURNS THE PIPELINE\u2019S OWN VERDICT, not a blanket 202', async () => {
    // The defect this pins: `01-Ingestion` refuses an invalid alert with a 400
    // that names the missing fields, and the entry point answered 202
    // "accepted" regardless. The sender then has no reason to fix anything and
    // the alert exists nowhere \u2014 a failure showing green at the only place
    // anybody was watching.
    const refuse = async () => ({
      status: 400,
      body: { status: 'rejected', errors: ['missing_required_fields: alert_id, rule_name'] },
    });
    const r = await handleAlert(
      deps({ engine: engine(undefined, refuse) }), auth, { severity: 'high' },
    );
    expect(r.status).toBe(400);
    expect(r.body.status).toBe('rejected');
    expect(JSON.stringify(r.body.errors)).toMatch(/missing_required_fields/);
    // And it still names the run, so the refusal is inspectable.
    expect(r.body.run_id).toBe('run-1');
  });

  it('passes a duplicate through as the 200 the pipeline chose', async () => {
    const dup = async () => ({ status: 200, body: { status: 'duplicate_ignored' } });
    const r = await handleAlert(deps({ engine: engine(undefined, dup) }), auth, alert);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('duplicate_ignored');
  });

  it('falls back to naming the run when no respond node was reached', async () => {
    // The graph ended some other way. The run exists and is inspectable, so we
    // say accepted and name it rather than inventing a status.
    const r = await handleAlert(deps(), auth, alert);
    expect(r.status).toBe(202);
    expect(r.body.run_id).toBe('run-1');
  });

  it('reports a missing engine as a 503 naming the cause', async () => {
    const r = await handleAlert(deps({ engine: null }), auth, alert);
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('engine_unavailable');
    // "No database" is a state to report, not an error to hide behind a 500.
    expect(String(r.body.detail)).toMatch(/database/);
  });

  it('does not swallow an engine failure', async () => {
    const start = vi.fn(async () => { throw new Error('Database (INSERT): refused'); });
    const r = await handleAlert(deps({ engine: engine(start as never) }), auth, alert);
    expect(r.status).toBe(500);
    expect(String(r.body.detail)).toMatch(/refused/);
  });
});

describe('readAlertId', () => {
  it('reads the identifier when there is one', () => {
    expect(readAlertId({ alert_id: '  ALT-9 ' })).toBe('ALT-9');
  });

  it('invents nothing when there is not', () => {
    // A missing identity is a rejection downstream, which is honest. Making
    // one up here would produce a case nobody can correlate to anything.
    for (const body of [null, 'x', {}, { alert_id: '' }, { alert_id: 7 }]) {
      expect(readAlertId(body)).toBeNull();
    }
  });
});
