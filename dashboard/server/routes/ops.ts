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
  getAuditPool, getEngine } from '../runtime.ts';
import { chainOutcome, verifyAuditChain } from '../audit-chain.ts';
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

    /**
     * S1.3 — replays the audit chain's hash computation, row by row.
     *
     * ======================================================================
     * IT ANSWERS 200 IN ITS OWN ENVELOPE, EVEN WHEN IT COULD NOT LOOK
     *
     * The same decision `/api/simulate` records above, and for the same
     * measured reason: `lib/api.ts` replaces the body of any 502/503/504 with
     * « the console server is not answering », so a 503 for « no database
     * configured » would throw away the one sentence naming the fix and send
     * the operator to restart a server that had just answered them. A status
     * code is not the place to say there is no chain to verify.
     *
     * ======================================================================
     * THE VERDICT IS A WORD, NOT `ok`
     *
     * Four states, and a boolean can hold two of them. `empty` is the one that
     * would be lost — and it is the one that matters, because `broken === 0`
     * is also true of a table nobody has written a decision to. `partial` is
     * the second: a bounded walk that found nothing has not verified the
     * chain, it has verified its tail.
     *
     * Read-only, and deliberately not part of the connectivity diagnostic: the
     * walk recomputes a SHA-256 per row, and the diagnostic is the thing an
     * operator presses first and often.
     *
     * IT TAKES NO BODY, and reads none — `POST /api/auth/logout` is the same
     * shape. `soc_audit_verify_chain()` does take a `p_from`, and it is NOT
     * offered: a range an operator cannot judge is a control that invites the
     * one mistake that manufactures a false red (an anchor id nobody holds
     * seeds the walk with zeros, and the first row is then reported as a
     * broken link). The window's anchor is derived; verifying a whole chain
     * past the window is the `psql` command the partial answer prints.
     */
    if (req.method === 'POST' && path === '/api/audit/verify') {
      const pool = getAuditPool();
      if (!pool) {
        return json(res, 200, {
          outcome: 'unavailable', verification: null, response: am.chainNoDatabase });
      }
      try {
        const v = await verifyAuditChain(pool);
        const outcome = chainOutcome(v);
        // One sentence per outcome, and the mapping is exhaustive rather than
        // a chain of fallbacks: a sentence must not be reachable from a state
        // it does not describe.
        const said: Record<typeof outcome, string> = {
          empty: am.chainEmpty,
          intact: am.chainIntact(v.checked),
          partial: am.chainPartial(v.checked, v.total),
          broken: am.chainBroken(v.broken, v.checked, v.complete),
        };
        return json(res, 200, { outcome, verification: v, response: said[outcome] });
      } catch (err) {
        // DESCRIBED ONCE, AND NOT HERE. `verifyAuditChain` names the fault at
        // its single choke point — `pg` fails `ECONNREFUSED` with an EMPTY
        // message, so the cause has to be recovered from `.code` — and this
        // adds only the CONSEQUENCE. Describing it a second time would print
        // one cause under two prefixes, which is the mistake the approval
        // sweep made and a test caught.
        return json(res, 200, {
          outcome: 'unavailable',
          verification: null,
          response: am.chainUnreadable((err as Error).message) });
      }
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
        // 200, IN THIS ROUTE'S OWN ENVELOPE — `{ ok: false, response }`, which
        // the Health tab prints where the answer goes. It used to be a 503, and
        // `lib/api.ts` replaces the body of a 503 with "start the console
        // server": the one sentence naming what to fix — no database, so no
        // engine, so nowhere for the alert to go — never reached the screen,
        // and the operator was sent to restart a server that had just answered.
        // The catch below already answers 200 for an engine that THROWS, so
        // this was the odd branch out of its own file.
        return json(res, 200, {
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
