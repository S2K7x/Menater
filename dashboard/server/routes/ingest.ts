/**
 * Alert intake. One entry point per source.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import { invalidate } from '../snapshot.ts';
import { getEngine } from '../runtime.ts';
import { handleAlert } from '../webhook.ts';
import { MAPPINGS, mappingFor, normalize } from '../engine/transforms/normalize.ts';
import {
  getConfig, saveConfig } from '../config.ts';
import { laneFor, normalizePolicyInput, onExpectedTransport } from '../ingest/policy.ts';
import { allCursors } from '../ingest/cursors.ts';
import { getPoller, syncPoller } from '../ingest/runtime.ts';
import type { Severity } from '../engine/transforms/domain.ts';
import type { Ctx } from './context.ts';

export async function ingestRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path } = c;

    // ------------------------------------------------------------------
    // N5 — THE CONTROL PLANE, under `/api/ingestion/`.
    //
    // A DIFFERENT NAMESPACE FROM `/api/ingest/:source`, and that is the whole
    // reason it exists: the data plane authenticates with a shared secret and
    // is reachable by an appliance with no session, the control plane is the
    // console and sits behind the human lock. One path shape per audience
    // means `requiresAuth` can decide with a regex instead of a list of
    // exceptions that someone will forget to extend — which is exactly how
    // `/api/ingest/:source` came to answer 401 to every Wazuh agent.
    // ------------------------------------------------------------------
    if (req.method === 'GET' && path === '/api/ingestion/policy') {
      const policy = getConfig().ingestion;
      return json(res, 200, {
        policy,
        // The lane each severity takes, RESOLVED HERE rather than recomputed
        // in the browser. A second implementation of the routing rule is a
        // second thing that can disagree with the one that runs.
        lanes: Object.fromEntries(
          (['critical', 'high', 'medium', 'low'] as Severity[])
            .map((sev) => [sev, laneFor(sev, policy)]),
        ),
        state: {
          running: getPoller().running(),
          cursors: allCursors(),
          last: getPoller().lastOutcomes(),
        },
      });
    }

    if (req.method === 'PUT' && path === '/api/ingestion/policy') {
      const { policy, error } = normalizePolicyInput(
        await readBody(req).catch(() => null),
        getConfig().ingestion,
      );
      // 400 AND THE SENTENCE. `normalizeRuleInput` is in this codebase because
      // an API that trusts the shape of its body answers 500s carrying an
      // internal message: the caller learns something broke, never that THEY
      // sent something wrong.
      if (error) return json(res, 400, { error });
      saveConfig({ ingestion: policy });
      // Effective without a restart, the same rule as a credential: a poller
      // you have to restart the console to enable is a poller people leave off.
      syncPoller();
      return json(res, 200, { policy: getConfig().ingestion });
    }

    /**
     * Poll every enabled source once, now.
     *
     * The "does this work" button. It runs the REAL poll — same cursor, same
     * credentials, same normalizer — because a test that checked something
     * easier would be worse than no test at all. Same reasoning as the MCP
     * page's probe.
     *
     * `force` skips the failure backoff. The backoff exists to stop a TIMER
     * hammering a dead endpoint; a person pressing a button is the opposite of
     * a timer, and a diagnostic control that answers "not yet, wait 8 minutes"
     * is a diagnostic control nobody uses twice.
     */
    if (req.method === 'POST' && path === '/api/ingestion/poll') {
      const outcomes = await getPoller().tick({ force: true });
      return json(res, 200, { outcomes, cursors: allCursors() });
    }

    // N4 — one entry point per source, and the legacy path as `generic`.
    //
    // The SOURCE COMES FROM THE ROUTE, never from the payload: a sender does
    // not get to declare which normalizer runs on it. An unknown source is
    // refused by name rather than guessed at — mis-detecting a format would
    // silently produce a half-mapped alert, which is worse than no alert.
    const ingestMatch = /^\/api\/ingest\/([a-z0-9-]+)$/.exec(path);
    if (req.method === 'POST' && (ingestMatch || path === '/api/webhook/soc/alert')) {
      const sourceName = ingestMatch ? ingestMatch[1] : 'generic';
      const mapping = mappingFor(sourceName);
      if (!mapping) {
        return json(res, 404, {
          status: 'error',
          reason: 'unknown_source',
          detail: `No mapping for source "${sourceName}". Known sources: `
            + `${MAPPINGS.map((m) => m.source).join(', ')}.` });
      }
      const conf = getConfig();
      const normalized = normalize(mapping, await readBody(req).catch(() => null));
      const result = await handleAlert(
        {
          mode: conf.webhook.mode,
          secret: conf.webhook.secret,
          engine: getEngine(),
        },
        req.headers as Record<string, string | string[] | undefined>,
        // Normalized BEFORE anything else sees it: the engine and the dedup key
        // both work on the canonical shape, so a source's quirks stop here.
        normalized,
        sourceName,
      );
      // An alert received changes what the console must show.
      invalidate();

      // N5 — WHICH LANE THIS ALERT SHOULD HAVE TAKEN, said in the reply.
      //
      // IT IS NEVER A REFUSAL. Under `hybrid` a `low` alert is supposed to
      // arrive by pull, and it just arrived by push — we accept it and say so.
      // Dropping a detection because of a routing preference would be the same
      // mistake as rejecting an alert for a missing field, in a harsher form:
      // it replaces the alert with nothing. The sentence is what lets someone
      // re-point that source at the pull transport, on purpose, later.
      const policy = getConfig().ingestion;
      const severity = (normalized as { severity?: Severity } | null)?.severity ?? null;
      const onLane = onExpectedTransport(severity, 'push', policy);
      return json(res, result.status, {
        ...result.body,
        delivery: {
          policy: policy.delivery,
          arrived_by: 'push',
          lane: laneFor(severity, policy),
          on_expected_transport: onLane,
          note: onLane ? null
            : `this console's policy expects ${severity ?? 'unrated'} alerts to be collected by `
              + 'polling. The alert was accepted; nothing was dropped.',
        },
      });
    }


  return false;
}
