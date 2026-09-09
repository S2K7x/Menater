/**
 * End-to-end diagnostic of the pipeline.
 *
 * ============================================================================
 * WHAT IT CHECKS NOW, AND WHAT IT USED TO
 *
 * It used to be a report about an n8n instance: is the API reachable, are the
 * six workflows published, has anybody renamed a node the console reads, is a
 * credential attached. Every one of those questions disappeared with n8n —
 * the workflows are compiled into this process, so there is no publish step to
 * get wrong and no editor in which to rename anything.
 *
 * What replaced them are the questions that actually decide whether an alert
 * gets triaged on this installation:
 *
 *   1. Can the engine reach its database, and is the schema applied? Without
 *      it every alert dies on `ECONNREFUSED`, visible nowhere.
 *   2. Is there a model key? Without it EVERY alert takes the fail-safe
 *      verdict — the pipeline runs, nothing is triaged, and no screen says the
 *      cause is one missing key.
 *   3. Is the entry point open, and does it actually answer?
 *   4. Do the node ids the console reads still exist in the workflows?
 *
 * Point 4 is the same coupling the old diagnostic guarded, moved inside: the
 * console reads named node outputs (`finalize`, `assemble`, `expose`) to build
 * a case. Renaming one used to make the console blind WITHOUT SAYING SO, which
 * is the worst failure mode a security tool has. The difference is that both
 * halves now live in this repository, so the check is exact rather than a
 * string comparison against somebody's editor.
 *
 * ============================================================================
 * WHAT THE DIAGNOSTIC ALLOWS ITSELF
 *
 * Every check is a READ, except one: the ingestion probe, which deliberately
 * sends an INVALID payload. It proves the endpoint is open and that schema
 * validation works, without creating an alert — a payload with no `alert_id`
 * is rejected before deduplication and never enters the queue. It is the only
 * way to test the real path without polluting the work queue.
 * ============================================================================
 */

import { describeFetchError, fetchWithDeadline } from './http.ts';
import { messages, type Locale } from './i18n.ts';
import { getConfig } from './config.ts';
import { getEngineStore } from './runtime.ts';
import { createPool } from './engine/pg-store.ts';
import { NODE_CONTRACT, WORKFLOW_LABELS } from './engine/cases.ts';
import { PIPELINE_WORKFLOWS } from './engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './engine/workflows/routing.ts';
import { describeCredentials } from './credentials.ts';
import { PORT } from './env.ts';

// The types live in src/lib/types.ts: one contract, shared by the server and
// the interface. Duplicating them would let the two drift.
import type { Check, Diagnostics } from '../src/lib/types.ts';
export type { Check, Diagnostics };

/** The tables the pipeline writes. A missing one is a schema never applied. */
const REQUIRED_TABLES = [
  'soc_run', 'soc_run_step', 'soc_audit_log', 'soc_ingested_alerts', 'soc_tuning_rule',
];

export async function runDiagnostics(
  opts: { probeWebhook: boolean; locale: Locale; baseUrl?: string },
): Promise<Diagnostics> {
  const started = Date.now();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const m = messages(opts.locale);
  const g = m.groups;
  const dg = m.diag;
  const conf = getConfig();

  // --- 1. The engine and its store -----------------------------------------
  if (!conf.database.host || !conf.database.database) {
    add({
      id: 'db', group: g.database, label: dg.dbLabel, status: 'fail',
      detail: dg.dbNotConfigured, remedy: dg.dbRemedy,
    });
  } else {
    const pool = createPool(conf.database);
    try {
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [REQUIRED_TABLES] as never[],
      );
      const found = new Set(rows.map((r: { table_name: string }) => r.table_name));
      const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
      add({
        id: 'db', group: g.database, label: dg.dbLabel,
        status: 'ok', detail: dg.dbReachable(conf.database.host, conf.database.database),
      });
      add({
        id: 'schema', group: g.database, label: dg.schemaLabel,
        status: missing.length === 0 ? 'ok' : 'fail',
        detail: missing.length === 0
          ? dg.schemaOk(REQUIRED_TABLES.length)
          : dg.schemaMissing(missing.join(', ')),
        ...(missing.length ? { remedy: dg.schemaRemedy } : {}),
      });
    } catch (err) {
      // NAMED, not "the database failed". `describePgError` has already turned
      // pg's empty ECONNREFUSED message into a sentence by this point, and the
      // whole value of this check is that the cause reaches a screen.
      add({
        id: 'db', group: g.database, label: dg.dbLabel, status: 'fail',
        detail: (err as Error).message, remedy: dg.dbRemedy,
      });
    } finally {
      await pool.end().catch(() => {});
    }
  }

  // --- 2. The key without which nothing is ever triaged ---------------------
  const creds = describeCredentials();
  const model = creds.find((c) => c.env === 'OPENROUTER_APIKEY');
  add({
    id: 'model-key', group: g.credentials, label: dg.modelKeyLabel,
    status: model?.set ? 'ok' : 'fail',
    detail: model?.set ? dg.modelKeySet(model.source) : dg.modelKeyMissing,
    ...(model?.set ? {} : { remedy: dg.modelKeyRemedy }),
  });

  // Enrichment and Slack are WARNINGS, never failures: a pipeline with no
  // threat-intelligence key still triages, it just triages on less. Calling
  // that broken would teach an operator that red does not mean broken.
  for (const [env, label] of [
    ['SLACK_BOTTOKEN', dg.slackLabel],
    ['SHODAN_APIKEY', dg.shodanLabel],
    ['ABUSEIPDB_APIKEY', dg.abuseLabel],
    ['VIRUSTOTAL_APIKEY', dg.vtLabel],
  ] as const) {
    const c = creds.find((x) => x.env === env);
    add({
      id: `cred-${env}`, group: g.credentials, label,
      status: c?.set ? 'ok' : 'warn',
      detail: c?.set ? dg.credSet(c.source) : dg.credMissing,
    });
  }

  // --- 3. The node contract, checked against the running definitions --------
  //
  // The console builds a case from named node outputs. This is the check that
  // turns "somebody renamed a node" from a silent blindness into a sentence.
  const workflows = new Map(
    [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS].map((w) => [w.id, w]),
  );
  for (const [workflowId, nodeIds] of Object.entries(NODE_CONTRACT)) {
    const wf = workflows.get(workflowId);
    const label = WORKFLOW_LABELS[workflowId] ?? workflowId;
    if (!wf) {
      add({
        id: `contract-${workflowId}`, group: g.contract, label: dg.contractLabel(label),
        status: 'fail', detail: dg.contractNoWorkflow, remedy: dg.contractRemedy,
      });
      continue;
    }
    const present = new Set(wf.nodes.map((n) => n.id));
    const missing = nodeIds.filter((n) => !present.has(n));
    add({
      id: `contract-${workflowId}`, group: g.contract, label: dg.contractLabel(label),
      status: missing.length === 0 ? 'ok' : 'fail',
      detail: missing.length === 0
        ? dg.contractOk(nodeIds.length)
        : dg.contractMissing(missing.join(', ')),
      ...(missing.length ? { remedy: dg.contractRemedy } : {}),
    });
  }

  // --- 4. Has the engine actually run anything? ----------------------------
  const store = getEngineStore();
  if (!store) {
    add({
      id: 'runs', group: g.executions, label: dg.execLabel, status: 'skip',
      detail: dg.execNoStore,
    });
  } else {
    try {
      const runs = await store.recentRuns({ limit: 20 });
      add({
        id: 'runs', group: g.executions, label: dg.execLabel,
        status: runs.length > 0 ? 'ok' : 'warn',
        detail: runs.length > 0 ? dg.execSeen(runs.length) : dg.execNone,
      });
    } catch (err) {
      add({
        id: 'runs', group: g.executions, label: dg.execLabel, status: 'fail',
        detail: (err as Error).message,
      });
    }
  }

  // --- 5. The entry point, probed for real ---------------------------------
  if (!opts.probeWebhook) {
    add({
      id: 'webhook', group: g.ingestion, label: dg.webhookLabel, status: 'skip',
      detail: dg.webhookSkipped,
    });
  } else if (conf.webhook.mode === 'off') {
    add({
      id: 'webhook', group: g.ingestion, label: dg.webhookLabel, status: 'warn',
      detail: dg.webhookClosed, remedy: dg.webhookRemedy,
    });
  } else if (conf.webhook.secret === '') {
    // An empty secret CLOSES the door rather than opening it, and saying so
    // here beats letting it be found on a 503.
    add({
      id: 'webhook', group: g.ingestion, label: dg.webhookLabel, status: 'warn',
      detail: dg.webhookNoSecret, remedy: dg.webhookSecretRemedy,
    });
  } else {
    const base = opts.baseUrl ?? `http://localhost:${PORT}`;
    try {
      const res = await fetchWithDeadline(
        `${base}/api/ingest/generic`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-soc-token': conf.webhook.secret },
          // DELIBERATELY INVALID. It proves the endpoint is open and that schema
          // validation works, and it never enters the queue: a payload with no
          // `alert_id` is refused before deduplication.
          body: JSON.stringify({ diagnostic_probe: true }),
        },
        { timeoutMs: 15_000 },
      );
      const body = await res.json().catch(() => ({}));
      // 400 IS THE PASS. The probe is invalid on purpose, so a rejection means
      // the whole path — route, secret, normalizer, validator — works.
      add({
        id: 'webhook', group: g.ingestion, label: dg.webhookLabel,
        status: res.status === 400 ? 'ok' : res.status === 401 ? 'fail' : 'warn',
        detail: res.status === 400
          ? dg.webhookOk
          : dg.webhookUnexpected(res.status, String((body as { reason?: string }).reason ?? '')),
        ...(res.status === 401 ? { remedy: dg.webhookSecretRemedy } : {}),
      });
    } catch (err) {
      // The entry point was never reached. `(err as Error).message` is the
      // string "fetch failed" for a refused port, an unresolvable name, a
      // firewall and an expired certificate alike — one word for four different
      // fixes, on the screen whose whole job is to name what is wrong.
      add({
        id: 'webhook', group: g.ingestion, label: dg.webhookLabel, status: 'fail',
        detail: describeFetchError(err),
      });
    }
  }

  return finish(checks, started);
}

function finish(checks: Check[], started: number): Diagnostics {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status] += 1;
  return {
    ran_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    summary,
    verdict: summary.fail > 0 ? 'broken' : summary.warn > 0 ? 'degraded' : 'operational',
    checks,
  };
}
