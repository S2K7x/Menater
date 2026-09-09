/**
 * The two writes a human can trigger: approve, replay.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import { invalidate, snapshot } from '../snapshot.ts';
import { injectAlert } from '../injection.ts';
import { getEngine } from '../runtime.ts';
import type { Ctx } from './context.ts';

export async function approvalsRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, locale, am } = c;

    /**
     * Answers the approval a run is waiting on.
     *
     * ======================================================================
     * IT USED TO POST A FORM TO n8n. NOW IT RESOLVES THE ENGINE'S OWN WAIT.
     *
     * The old route relayed to `/form-waiting/<id>` with French field names,
     * and returned n8n's answer verbatim. The engine has had `resumeWait` all
     * along — a token, a payload, and an idempotent resolve — so the relay was
     * a round trip through another product to reach a function in this one.
     *
     * THE APPROVER IS STILL SELF-DECLARED, and that has not changed with the
     * transport: the console's lock protects ACCESS, it identifies nobody. The
     * name travels with the decision and is recorded as declared, never as
     * verified — writing it into the audit chain as an identity would be the
     * worst kind of invented data.
     * ======================================================================
     */
    if (req.method === 'POST' && /^\/api\/approvals\/[^/]+\/resume$/.test(path)) {
      const token = path.split('/')[3];
      const body = await readBody(req);
      const approver = String(body.approver ?? '').trim();
      if (!approver) return json(res, 400, { error: am.approverRequired });

      const engine = getEngine();
      if (!engine) return json(res, 503, { ok: false, error: am.engineUnavailable });

      const approved = body.decision === 'approve';
      try {
        const run = await engine.resumeWait(token, {
          approved,
          human_reasoning: String(body.reason ?? '').trim() || null,
          approver: {
            slack_username: approver,
            slack_user_id: null,
            responded_at: new Date().toISOString(),
            // NAMED FOR WHAT IT IS. The console has one shared password; it
            // proves somebody could open the console, not who they are.
            identity_source: 'console_self_declared',
            signature_verified: false,
          },
        });
        invalidate();
        // An unknown or already-resolved token is not an error to shout about:
        // two operators pressing the same button is the normal race, and the
        // first answer stands. Saying so beats a 500 that suggests the
        // decision was lost.
        if (!run) return json(res, 404, { ok: false, detail: am.approvalUnknownToken });
        return json(res, 200, { ok: true, run_id: run.id, detail: am.approvalSent });
      } catch (err) {
        invalidate();
        // An approval that fails to land is serious: without it the run times
        // out and the alert is escalated. Say what happened, not "fetch failed".
        return json(res, 500, { ok: false, detail: am.approvalFailed((err as Error).message) });
      }
    }

    /**
     * Replaying an alert whose chain broke.
     *
     * ======================================================================
     * WHAT THIS ROUTE IS, AND WHAT IT IS NOT
     *
     * It RE-POSTS the original payload to the same webhook `/api/simulate`
     * uses. That is the only write it can perform, it is reversible, and it is
     * triggered by a human who has read the broken chain.
     *
     * It repairs nothing, modifies no workflow, touches no database. Nor does
     * it replay a RECONSTRUCTED alert: if the console does not hold the
     * payload as the webhook received it, it refuses. Replaying a guessed
     * alert would produce a case that resembles the original without being
     * one — exactly the gap-filled-with-a-default this project forbids.
     *
     * The identifier is DERIVED by default (`<origin>-r<n>`), because
     * re-posting the same one would be deduplicated and would replay nothing.
     * Re-posting identically stays possible on explicit request: that is how
     * deduplication itself gets tested.
     * ======================================================================
     */
    if (req.method === 'POST' && path === '/api/replay') {
      const body = await readBody(req);
      const sourceId = String(body.alert_id ?? '').trim();
      const snap = await snapshot(locale);
      const chain = snap.trace.chains.find((ch) => ch.alert_id === sourceId);
      if (!chain) return json(res, 404, { ok: false, error: am.replayUnknownCase(sourceId) });
      if (!chain.payload) return json(res, 409, { ok: false, error: am.replayNoPayload(sourceId) });

      const sameId = body.same_id === true;
      const stamp = new Date().toISOString();
      const alertId = sameId ? sourceId : `${sourceId}-r${Date.now().toString(36)}`;
      const alert = { alert_id: alertId, ...chain.payload, timestamp: stamp };

      try {
        // STRAIGHT INTO THE ENGINE, not back out through an HTTP round trip to
        // ourselves. The old route re-posted to n8n's webhook; posting to our
        // own would mean the replay needed the ingestion secret, so a console
        // with a closed entry point could not replay its own broken chain.
        const engine = getEngine();
        if (!engine) {
          return json(res, 503, { ok: false, error: am.engineUnavailable });
        }
        // AND THE PIPELINE'S ANSWER IS READ BACK. `same_id: true` is the
        // documented way to test deduplication, so the pipeline answering
        // "duplicate, skipped" is an expected outcome here — and it was being
        // reported as "Alert replayed", which is the opposite of what happened.
        const r = await injectAlert(engine, { ...alert, source: 'replay' }, alertId);
        invalidate();
        return json(res, 200, {
          ok: r.ok,
          status: r.status,
          alert_id: alertId,
          source_alert_id: sourceId,
          response: JSON.stringify({ run_id: r.run_id, status: r.run_status }),
          detail: r.ok ? am.replaySent(alertId) : am.replayRefused(r.status, r.detail) });
      } catch (err) {
        return json(res, 200, {
          ok: false,
          status: 0,
          alert_id: alertId,
          source_alert_id: sourceId,
          response: '',
          detail: am.replayUnreachable((err as Error).message) });
      }
    }

      return false;
}
