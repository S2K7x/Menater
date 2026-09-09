/**
 * Diagnostics and test-alert injection.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import { invalidate } from '../snapshot.ts';
import { injectAlert } from '../injection.ts';
import {
  getEngine } from '../runtime.ts';
import { runDiagnostics } from '../diagnostics.ts';
import { DEFAULT_SCENARIO, SCENARIOS, scenarioById } from '../scenarios.ts';
import type { Ctx } from './context.ts';

export async function opsRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, locale, am } = c;

    /**
     * Connectivity diagnostic. Read-only, except the webhook probe, which
     * sends a deliberately invalid payload: it proves the chain answers
     * without creating an alert in the queue.
     */
    if (req.method === 'POST' && path === '/api/diagnostics') {
      const body = await readBody(req);
      // The probe dials THIS console, at the address the operator reached it
      // on — the same rule as the ingestion snippets. A hard-coded localhost
      // would test a loopback that says nothing about the address a source
      // actually uses.
      const host = String(req.headers.host ?? '');
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
      const diag = await runDiagnostics({
        probeWebhook: body.probeWebhook !== false,
        locale,
        baseUrl: host ? `${proto}://${host}` : undefined,
      });
      // The diagnostic has just re-read the instance: the console's cache is
      // stale, so it is dropped for the next screen to show what was found.
      invalidate();
      return json(res, 200, diag);
    }

    /** Injects a test alert into the ingestion webhook. */
    /** The catalogue, so the console does not hard-code the list. */
    if (req.method === 'GET' && path === '/api/simulate/scenarios') {
      return json(res, 200, {
        scenarios: SCENARIOS.map((sc) => ({ id: sc.id, title: sc.title, purpose: sc.purpose })) });
    }

    /**
     * Injects a test alert INTO THE CONSOLE'S OWN PIPELINE.
     *
     * It used to POST to n8n's webhook. On an installation with no n8n — the
     * normal one now — the button could therefore never work: it tested a
     * machine that does not exist while the engine that would really handle
     * the alert was never called.
     *
     * It also deliberately skips the shared secret and the webhook mode. Those
     * guard the door that faces the network; this is an authenticated human
     * pressing a button in their own console, and refusing to let them test
     * their pipeline because the external door is shut would be a checkpoint
     * on the wrong side of the wall. The response says which pipeline ran.
     */
    if (req.method === 'POST' && path === '/api/simulate') {
      const body = await readBody(req);
      const stamp = new Date().toISOString();
      const seq = Date.now().toString(36).slice(-5);

      const scenario = scenarioById(String(body.scenario ?? DEFAULT_SCENARIO))
        ?? scenarioById(DEFAULT_SCENARIO)!;

      // An explicit field in the body still wins: the scenario is a starting
      // point, not a cage.
      const str = (v: unknown, fallback: unknown) =>
        typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 4000) : fallback;
      const built = scenario.build(stamp, seq as unknown as number);
      const alert: Record<string, unknown> = { ...built };
      for (const key of ['alert_id', 'rule_name', 'severity', 'source_ip', 'dest_ip', 'host', 'user', 'raw_log']) {
        const override = str(body[key], undefined);
        if (override !== undefined) alert[key] = override;
      }

      const engine = getEngine();
      if (!engine) {
        return json(res, 503, {
          ok: false,
          status: 0,
          alert_id: String(alert.alert_id),
          scenario: scenario.id,
          response: am.simulateNoEngine });
      }

      try {
        // THE ANSWER IS THE PIPELINE'S, NOT A BLANKET 202. `01-Ingestion`
        // decides between 400 (invalid schema), 200 (duplicate), 500 (dedup
        // unavailable) and 202 — and the `malformed` scenario exists precisely
        // to be refused. Reporting every started run as injected turned that
        // scenario into a green banner followed, forty-five seconds later, by
        // "no trace of that alert". See `injection.ts`.
        const r = await injectAlert(engine, { ...alert, source: 'simulator' },
          String(alert.alert_id));
        invalidate();
        return json(res, 200, {
          ok: r.ok,
          status: r.status,
          alert_id: String(alert.alert_id),
          scenario: scenario.id,
          run_id: r.run_id,
          pipeline: 'console',
          response: r.ok
            ? am.simulateStarted(scenario.title, r.run_status)
            : am.simulateRefused(scenario.title, r.status, r.detail) });
      } catch (err) {
        // A failure here is the ENGINE's, and saying so beats a bare status:
        // the whole point of the button is to find out what is broken.
        return json(res, 200, {
          ok: false,
          status: 0,
          alert_id: String(alert.alert_id),
          scenario: scenario.id,
          response: (err as Error).message });
      }
    }
  return false;
}
