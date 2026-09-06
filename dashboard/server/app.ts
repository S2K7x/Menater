/**
 * MENATER's request surface.
 *
 * Dependency-free HTTP. The only outbound calls are the ones the pipeline
 * itself makes — threat-intelligence sources, the triage model, Slack — plus
 * the polled ingestion sources. The console reads the pipeline from the
 * engine's own run journal in Postgres, which is the single production
 * dependency this API has.
 *
 * ============================================================================
 * WHAT THIS SERVER REFUSES TO DO
 *
 * It writes NOTHING into the pipeline except on an explicit human action, and
 * the only three writes it can perform are reversible:
 *   - `POST /api/simulate` injects a test alert into the pipeline;
 *   - `POST /api/approvals/:token/resume` answers the approval a run is
 *     waiting on;
 *   - `POST /api/replay` re-runs the original payload of an alert whose chain
 *     broke — and refuses when that payload is not known, rather than
 *     replaying one reconstructed from memory.
 *
 * It also relays `/api/vulnpipe/*` to the code-analysis service (see
 * `vulnpipe.ts`): that relay decides nothing either — it keeps both pipelines
 * on a single origin and behind a single lock.
 *
 * There is no route that isolates a host, closes an alert in the database, or
 * modifies a workflow. The console observes and forwards; the pipeline decides.
 * ============================================================================
 */

import { json } from './respond.ts';
import { UI_ROOT } from './env.ts';
import type { Ctx, RouteGroup } from './routes/context.ts';
import { authRoutes } from './routes/auth.ts';
import { settingsRoutes } from './routes/settings.ts';
import { workflowsRoutes } from './routes/workflows.ts';
import { rulesRoutes } from './routes/rules.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { casesRoutes } from './routes/cases.ts';
import { approvalsRoutes } from './routes/approvals.ts';
import { opsRoutes } from './routes/ops.ts';
import { intelRoutes } from './routes/intel.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { mcpRoutes } from './assistant/mcp.ts';
import { RuleDbError } from './runtime.ts';
import { messages, normalizeLocale } from './i18n.ts';
import { isVulnPipePath, proxyToVulnPipe } from './vulnpipe.ts';
import { serveStatic } from './static.ts';
import { isValidSession, readCookie, requiresAuth } from './auth.ts';

/**
 * The console's route table.
 *
 * THE ORDER IS THE ONE THE SINGLE FUNCTION HAD, deliberately. The groups look
 * disjoint — `ingest` matches `/api/ingest/:source` only on POST, so it cannot
 * swallow the GET on `/api/ingest/sources` that `workflows` owns — but "looks
 * disjoint" is not "is disjoint", and two of these groups test PATTERNS rather
 * than exact paths. Preserving the original sequence costs nothing and removes
 * the question; reordering this list would need each pair proven separately.
 */
const ROUTE_GROUPS: RouteGroup[] = [
  authRoutes,
  settingsRoutes,
  workflowsRoutes,
  rulesRoutes,
  ingestRoutes,
  casesRoutes,
  approvalsRoutes,
  opsRoutes,
  // Its three paths all start `/api/intel/`, which no earlier group tests for,
  // and it tests for nothing of theirs.
  intelRoutes,
  // Last, and it costs nothing: its two paths are exact and unique, so no
  // earlier group can swallow them and it can swallow none of theirs.
  assistantRoutes,
  // The MCP endpoint. Its own path, its own authentication, and it answers 404
  // until someone turns it on — so an earlier group cannot reach it and it
  // reaches nothing of theirs.
  mcpRoutes,
];

/**
 * The whole request surface, as a plain function.
 *
 * Separated from the process entry point so it can be CALLED without a socket.
 * `api.ts` used to build the server at module top level, which meant importing
 * it started listening — and that is why thirty routes deciding auth,
 * settings, rules and alert ingestion had no test at all.
 */
export async function handleRequest(req: any, res: any): Promise<unknown> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const token = readCookie(req.headers.cookie);
  const ip = String(req.socket.remoteAddress ?? 'unknown');
  // Language asked for by the client. The server writes sentences of its own
  // (diagnostic, chain notes, sample set): without it, half the screen would
  // stay in the developer's language.
  const locale = normalizeLocale(url.searchParams.get('locale'));
  const am = messages(locale).api;

  try {
    // --- Access lock --------------------------------------------------------
    if (requiresAuth(path) && !isValidSession(token)) {
      return json(res, 401, { error: am.authRequired, auth_required: true });
    }

    // --- VulnPipe ----------------------------------------------------------
    // Relayed BEFORE the console's own routes, and AFTER the access lock: the
    // analysis engine sits behind the same password as everything else.
    if (isVulnPipePath(path)) {
      return proxyToVulnPipe(req, res, url);
    }

    // --- Route groups -------------------------------------------------------
    // Tried IN THIS ORDER, and the order is part of the behaviour: some paths
    // are only told apart by which pattern is tested first. A group answers
    // `true` when it has dealt with the request.
    const ctx: Ctx = { req, res, url, path, locale, am, token, ip };
    for (const group of ROUTE_GROUPS) {
      if (await group(ctx)) return true;
    }

    // Nothing answered. In a container the built interface is served from
    // here — one origin, therefore one access lock. In development Vite serves
    // it and there is no `dist/`, so the JSON 404 below is returned instead,
    // which is the right answer to a malformed API call.
    //
    // `serveStatic` refuses API paths by itself: reaching this line with
    // `/api/...` means no route matched, and the JSON 404 is then correct.
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, path, { root: UI_ROOT })) return;
    }
    return json(res, 404, { error: am.unknownRoute });
  } catch (err) {
    // A database that does not answer is a 503 NAMING the database, not a 500
    // carrying pg's message — which on `ECONNREFUSED` is the empty string.
    if (err instanceof RuleDbError) {
      return json(res, 503, { error: err.message });
    }
    // Last net: no exception may leave the client without an answer. A tab
    // spinning forever is worse than an error on screen.
    console.error('[menater] uncaught error on', path, '—', err);
    if (!res.headersSent) return json(res, 500, { error: (err as Error).message });
    return res.end();
  }
}
