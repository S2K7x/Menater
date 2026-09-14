/**
 * J0.1 — the door from a scan report into the triage queue.
 *
 * ============================================================================
 * WHY THIS IS A CONSOLE ROUTE AND NOT `/api/ingest/vulnpipe`
 *
 * The data plane (`/api/ingest/:source`) authenticates with a shared secret and
 * is meant for an appliance with no session. The browser cannot use it: the
 * secret never comes back out of the server, on purpose. So a button inside the
 * console has to be on the control-plane side of the wall, behind the human
 * lock — which is where `requiresAuth` puts anything not on its short list.
 *
 * It therefore skips the shared secret and the webhook mode, and that is the
 * same judgment `POST /api/simulate` already records: those guard the door that
 * faces the NETWORK, and refusing an authenticated human the use of their own
 * console because the external door is shut would be a checkpoint on the wrong
 * side of the wall.
 *
 * What it does NOT skip is the pipeline. `injectAlert` starts `01-Ingestion`
 * and reads back what the pipeline decided, so a finding whose alert is
 * malformed is refused by the same validator, named by the same sentence, and
 * deduplicated by the same table as every other alert.
 *
 * ============================================================================
 * NOTHING HERE DECIDES TO SEND
 *
 * A human read a finding and pressed a button on it. That is the whole trigger,
 * and it is the rule J0.3 already holds to: it resolves, it never acts. An
 * alert raised because a scan finished would be a model call — and, downstream,
 * an approval request — spent on a target read out of a report nobody had
 * looked at yet.
 * ============================================================================
 */

import { json, readBody } from '../respond.ts';
import { invalidate } from '../snapshot.ts';
import { getEngine } from '../runtime.ts';
import { injectAlert } from '../injection.ts';
import { findingToAlert } from '../findings.ts';
import type { Ctx } from './context.ts';

export async function findingsRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, am } = c;

  if (req.method === 'POST' && path === '/api/findings/promote') {
    const body = await readBody(req).catch(() => null);
    const mapped = findingToAlert(body ?? {}, new Date());

    // EVERYTHING THE OPERATOR CAN SEE LEAVES AS A 200, and the failure is in
    // the payload. `lib/api.ts` replaces the body of a 502/503/504 with a
    // generic "the API is not responding" and reads a 400's explanation from
    // `error` alone — so a 503 here would answer "no database configured:
    // Settings → Database" with "the API is not responding", and a 400 naming
    // the field at fault would arrive as "no explanation (400)". The status
    // the caller needs travels INSIDE, the way `/api/simulate` sends it.
    //
    // Naming the field is the lesson `normalizeRuleInput` was written for: a
    // caller must learn that THEY sent something wrong, and which part.
    if (!mapped.ok) {
      return json(res, 200, {
        ok: false, status: 400, errors: mapped.errors,
        response: am.promoteInvalid(mapped.errors) });
    }

    const engine = getEngine();
    if (!engine) {
      return json(res, 200, {
        ok: false, status: 0, alert_id: mapped.alert_id, response: am.promoteNoEngine });
    }

    const what = String(mapped.alert.rule_name);
    try {
      // THE ANSWER IS THE PIPELINE'S, NOT A BLANKET 202 — the defect
      // `injection.ts` exists to close, and the reason this route uses it
      // rather than starting a run itself. A finding promoted twice is
      // answered `duplicate`, and the operator is told so.
      const r = await injectAlert(engine, { ...mapped.alert, source: 'vulnpipe' }, mapped.alert_id);
      // A new case in the queue changes what every other screen must show.
      invalidate();
      return json(res, 200, {
        ok: r.ok,
        status: r.status,
        alert_id: mapped.alert_id,
        run_id: r.run_id,
        pipeline: 'console',
        response: r.ok
          ? am.promoteStarted(what, r.run_status)
          : am.promoteRefused(what, r.status, r.detail),
      });
    } catch (err) {
      // A failure here is the ENGINE's, before the pipeline answered anything.
      //
      // IT STILL NAMES THE FINDING. The first version of this branch returned
      // the bare error, and against an unreachable database it answered
      // "Database (INSERT): connect ECONNREFUSED 127.0.0.1:5432" — true, and
      // about nothing in particular. Someone with three reports open has just
      // pressed a button on one of them and cannot tell which one this is, nor
      // whether it got through. Found by running it, not by reading it.
      return json(res, 200, {
        ok: false,
        status: 0,
        alert_id: mapped.alert_id,
        response: am.promoteFailed(what, (err as Error).message),
      });
    }
  }

  return false;
}
