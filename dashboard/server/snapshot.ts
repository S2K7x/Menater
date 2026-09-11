/**
 * The console's view of the pipeline, and the cache in front of it.
 *
 * ============================================================================
 * WHERE THIS READS FROM, AND WHERE IT USED TO
 *
 * It reads `soc_run` and `soc_run_step` — the built-in engine's own journal.
 * It used to walk an n8n instance's execution list, which meant the console
 * could not show the work of the engine shipped inside it: the engine wrote
 * every run and nothing read them back.
 *
 * ============================================================================
 * WHY THIS IS ONE FILE
 *
 * Rebuilding the triage queue is the most expensive thing the console does.
 * Everything here exists to make that cost bearable without ever showing a
 * queue that lies — the short TTL, the shared in-flight rebuild, the staleness
 * ceiling and the cache key are a single decision split across four constants,
 * and separating them would let one drift from the others.
 *
 * The metrics are computed here too, from the same cases, because they must
 * describe exactly the window the operator is looking at.
 * ============================================================================
 */

import { buildCases } from './engine/cases.ts';
import { getEngineStore } from './runtime.ts';
import { demoCases } from './demo.ts';
import { messages, type Locale } from './i18n.ts';
import { connectionString, getConfig } from './config.ts';
import { resolveRepository } from './inventory.ts';
import { PIPELINE_WORKFLOWS } from './engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './engine/workflows/routing.ts';
import type {
  AlertCase, ConsoleSnapshot, HealthReport, Metrics, TraceReport,
} from '../src/lib/types.ts';

/**
 * The six workflows, as the console lists them.
 *
 * ALWAYS ACTIVE, and that is not a stub: they are compiled into this process.
 * There is no "publish" step to get wrong any more, which removes a whole
 * class of failure the console used to have to detect and report.
 */
const workflowList = () =>
  [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS].map((w) => ({
    id: w.id, name: w.name, active: true,
  }));

/**
 * Short-lived cache. 15 s is short enough for a pending approval to appear
 * quickly, long enough that ten open tabs do not hammer the database.
 */
const TTL_MS = 15_000;
let cache: { at: number; key: string; snapshot: ConsoleSnapshot } | null = null;

/**
 * Past this age a snapshot is no longer served even as a stopgap: better to
 * wait than to show a triage queue that is two minutes old.
 */
const STALE_MAX_MS = 90_000;

/**
 * The rebuild in progress, shared.
 *
 * WITHOUT THIS, EVERY TAB STARTS ITS OWN. Ten tabs open on the console — the
 * normal state at a triage desk — used to trigger ten full walks of the run
 * journal in parallel, each one slowing the other nine down.
 */
let inFlight: { key: string; promise: Promise<ConsoleSnapshot> } | null = null;
/**
 * Switching database must invalidate the cache, not reuse it.
 *
 * THE LANGUAGE IS PART OF THE KEY. The snapshot carries sentences written on
 * the server side (chain notes, blocking findings): without it, switching
 * locale left a half-translated screen for fifteen seconds — and by the time
 * you worked out why, the cache had expired.
 */
const cacheKey = (locale: Locale) => {
  const d = getConfig().database;
  return `${d.host}:${d.port}/${d.database}`
    + `|${getConfig().console.forceDemo}|${getConfig().console.executionWindow}|${locale}`;
};

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function computeMetrics(cases: AlertCase[]): Metrics {
  const byVerdict: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const confidences: number[] = [];
  const dwells: number[] = [];
  let tokens = 0;
  let fallbacks = 0;
  let degraded = 0;
  let decided = 0;
  let reviewed = 0;
  let rejected = 0;

  for (const c of cases) {
    bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
    if (c.decision) {
      decided += 1;
      byVerdict[c.decision.verdict] = (byVerdict[c.decision.verdict] ?? 0) + 1;
      if (typeof c.decision.confidence === 'number') confidences.push(c.decision.confidence);
      if (c.decision.is_fallback) fallbacks += 1;
      const u = c.decision.usage;
      if (u) tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    if (c.enrichment_meta?.degraded) degraded += 1;
    if (typeof c.dwell_ms === 'number') dwells.push(c.dwell_ms);
    // The disagreement rate counts only cases ACTUALLY put to a human who
    // answered. A timeout is not a disagreement, it is an absence.
    if (c.approval?.outcome === 'approved' || c.approval?.outcome === 'rejected') {
      reviewed += 1;
      if (c.approval.outcome === 'rejected') rejected += 1;
    }
  }

  const shadow = cases.filter((c) => c.shadow_mode).length;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);

  return {
    // English, like every other user-facing string. It was French and
    // unaccented — invisible on the Metrics tab, and then read aloud by every
    // MCP client the moment the catalogue was exported.
    window_label: 'recent executions',
    alerts_total: cases.length,
    alerts_shadow: shadow,
    alerts_live: cases.length - shadow,
    actions_executed: cases.filter((c) => c.executed).length,
    awaiting_approval: cases.filter((c) => c.state === 'awaiting_approval').length,
    failed: cases.filter((c) => c.state === 'failed').length,
    by_verdict: byVerdict,
    by_severity: bySeverity,
    avg_confidence: confidences.length
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
      : null,
    avg_dwell_ms: dwells.length ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : null,
    p95_dwell_ms: percentile(dwells, 95),
    tokens_total: tokens,
    fallback_rate_pct: pct(fallbacks, decided),
    degraded_rate_pct: pct(degraded, cases.length),
    human_disagreement_rate_pct: pct(rejected, reviewed),
    shadow_baseline: { decisions: shadow, threshold: 50, reached: shadow >= 50 },
  };
}

/**
 * Blocking findings, drawn from acceptance testing. They stay on screen in the
 * Health tab: a known defect you stop seeing is a defect that comes back in
 * production.
 */
function blockingFindings(cases: AlertCase[], locale: Locale, trace?: TraceReport): string[] {
  const h = messages(locale).health;
  const out: string[] = [];
  if (cases.some((c) => c.audit && !c.audit.committed)) out.push(h.findingNoAudit);
  if (cases.some((c) => c.errors.some((e) => e.error_code === 'LLM_API_UNAVAILABLE'))) {
    out.push(h.findingModelUnavailable);
  }
  if (cases.some((c) => c.errors.some((e) => e.requires_replay))) out.push(h.findingReplay);
  // A broken chain or an orphan run raises no error anywhere: a step that ends
  // in success having passed nothing looks green everywhere else. That is
  // exactly why it has to surface here, ranked alongside a lost audit row —
  // without this line the anomaly exists only for whoever thinks to open the
  // Tracking tab.
  if (trace?.counts.broken) out.push(h.findingBrokenChains(trace.counts.broken));
  if (trace?.counts.stalled) out.push(h.findingStalledChains(trace.counts.stalled));
  if (trace?.counts.orphans) out.push(h.findingOrphanRuns(trace.counts.orphans));
  return out;
}

/**
 * Empty traceability, for demonstration mode. The sample set comes from no
 * execution at all: inventing chains and orphans would give someone a failure
 * to read that does not exist.
 */
function emptyTrace(limit: number): TraceReport {
  return {
    generated_at: new Date().toISOString(),
    window: { limit, inspected: 0, attached: 0, oldest_at: null, newest_at: null, truncated: false },
    stall_after_ms: 5 * 60_000,
    chains: [],
    orphans: [],
    executions: [],
    counts: {
      broken: 0, stalled: 0, failed: 0, awaiting: 0,
      running: 0, complete: 0, orphans: 0, attention: 0,
    },
  };
}

async function buildSnapshot(locale: Locale): Promise<ConsoleSnapshot> {
  const checkedAt = new Date().toISOString();
  const conf = getConfig();
  const h = messages(locale).health;

  if (conf.console.forceDemo) return demoSnapshot(checkedAt, h.forcedDemo, locale);

  // NO ENGINE MEANS NO DATABASE, and that is a state to REPORT rather than an
  // error to throw. The console stays entirely usable; the sample set makes the
  // screens legible, and the health block says why they are not real.
  const store = getEngineStore();
  if (!store) return demoSnapshot(checkedAt, h.noDatabase, locale);

  try {
    const runs = await store.recentRuns({ limit: conf.console.executionWindow });

    // The engine is mounted and has run nothing yet: the demonstration beats an
    // empty page, which reads as a failure on a screen whose whole job is to
    // show failures.
    if (runs.length === 0) {
      const snap = demoSnapshot(checkedAt, h.noRecentRuns, locale);
      snap.health.workflows = workflowList();
      snap.health.engine.reachable = true;
      return snap;
    }

    // ONE query for every step of every run, not one per run. The queue reads a
    // hundred runs per refresh, and a round trip each is the "Promise.all over
    // the whole window" trap moved into the database.
    const steps = await store.stepsOfMany(runs.map((r) => r.id));
    const { cases, trace } = buildCases(runs, steps, {
      limit: conf.console.executionWindow,
      locale,
    });

    // The audit chain's health, DEDUCED from what the runs recorded rather than
    // asserted: a case whose audit row was never committed is the one thing
    // that makes a decision untraceable.
    const lost = cases.filter((c) => c.audit && !c.audit.committed).length;

    const health: HealthReport = {
      mode: 'live',
      engine: {
        reachable: true,
        url: connectionString(),
        detail: h.casesRebuilt(cases.length),
      },
      workflows: workflowList(),
      audit_db: {
        healthy: lost === 0,
        detail: lost === 0 ? h.auditOk : h.auditLostRows(lost),
      },
      blocking_findings: blockingFindings(cases, locale, trace),
      checked_at: checkedAt,
    };
    return { cases, metrics: computeMetrics(cases), health, trace };
  } catch (err) {
    // A database that does not answer must not empty the console. It falls back
    // to the sample set AND says the cause — `describePgError` has already
    // turned pg's empty message into a named one by this point.
    return demoSnapshot(checkedAt, h.unreachable((err as Error).message), locale);
  }
}

function demoSnapshot(checkedAt: string, detail: string, locale: Locale): ConsoleSnapshot {
  const cases = demoCases(locale);
  return {
    cases,
    metrics: computeMetrics(cases),
    trace: emptyTrace(getConfig().console.executionWindow),
    health: {
      mode: 'demo',
      engine: { reachable: false, url: connectionString(), detail },
      workflows: workflowList(),
      audit_db: { healthy: false, detail: messages(locale).health.auditUnknownInDemo },
      blocking_findings: blockingFindings(cases, locale),
      checked_at: checkedAt,
    },
  };
}

/**
 * Throws away the snapshot AND the rebuild in progress.
 *
 * FORGETTING `inFlight` IS ENOUGH TO UNDO THE INVALIDATION: a walk that
 * started before the write finishes after it, and reinstalls in the cache the
 * state from BEFORE the approval just sent.
 *
 * DROPPING THE REFERENCE IS NOT THE SAME AS STOPPING THE WALK, and that is the
 * half this function cannot do on its own: the disowned rebuild is still
 * running, still holds its own `.then`, and used to write its result into the
 * cache anyway when it landed. `rebuild()` is where that is refused — see the
 * comment there.
 */
export function invalidate(): void {
  cache = null;
  inFlight = null;
}

/**
 * J0.3 — the service inventory, applied to every case.
 *
 * DONE HERE AND NOWHERE ELSE. `buildCases` reads the engine's journal and has
 * no business reading `config.json`; the demonstration set is built without a
 * repository for the same reason. This is the one funnel every case passes
 * through, live or sample, so one call covers both — and one call is what
 * keeps the console from showing a repository on the queue and none on the
 * card.
 *
 * The inventory is read from the CACHED config, so a save costs nothing; and
 * `saveConfig` already calls `invalidate()`, which is what makes an edited
 * inventory visible on the next refresh instead of up to fifteen seconds
 * later.
 */
function withRepositories(snap: ConsoleSnapshot): ConsoleSnapshot {
  const entries = getConfig().inventory.entries;
  if (entries.length === 0) return snap;
  snap.cases = snap.cases.map((c) => ({ ...c, repository: resolveRepository(c, entries) }));
  return snap;
}

/**
 * Rebuilds, sharing the work with concurrent callers.
 *
 * ============================================================================
 * ONLY THE REBUILD THAT IS STILL THE CURRENT ONE MAY PUBLISH
 *
 * `invalidate()` drops the references; it cannot stop a walk already under way.
 * So a rebuild that asked the database BEFORE an approval was written finishes
 * AFTER it — and it used to install what it read into the cache regardless,
 * stamped `Date.now()`. Fresh timestamp, pre-write data: the console went on
 * showing the alert as awaiting approval for up to `TTL_MS` after the operator
 * was told the approval had been sent, and nothing said so. A failure that
 * shows green, in the one place the queue is assembled.
 *
 * The identity check is the same one `.finally` already made for `inFlight` —
 * it was simply not made for `cache`, which is the half that is read.
 *
 * The caller still RECEIVES this snapshot, and that is deliberate: they asked
 * before the write and a real read answered them. What is refused is
 * PUBLISHING it to everyone else for the next fifteen seconds.
 * ============================================================================
 */
function rebuild(locale: Locale, key: string): Promise<ConsoleSnapshot> {
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const promise = buildSnapshot(locale)
    .then(withRepositories)
    .then((snap) => {
      if (inFlight?.promise === promise) cache = { at: Date.now(), key, snapshot: snap };
      return snap;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}

/**
 * Snapshot, with background revalidation.
 *
 * THREE AGES, THREE BEHAVIOURS. Fresh (< 15 s): served as is. Stale but recent
 * (< 90 s): SERVED IMMEDIATELY, with a rebuild starting behind it for the next
 * caller — that is the periodic refresh, which no longer has to make anyone
 * wait. Too old, or absent: we wait.
 *
 * `force` always waits: the "Refresh" button and the injection follow-up ask
 * for the REAL state, not the last one known.
 */
export async function snapshot(locale: Locale, force = false): Promise<ConsoleSnapshot> {
  const key = cacheKey(locale);
  if (force || !cache || cache.key !== key) return rebuild(locale, key);

  const age = Date.now() - cache.at;
  if (age < TTL_MS) return cache.snapshot;
  if (age < STALE_MAX_MS) {
    // Detached revalidation: any error is already absorbed by buildSnapshot
    // (it falls back to demonstration mode), but an unhandled rejection would
    // bring the process down.
    void rebuild(locale, key).catch(() => {});
    return cache.snapshot;
  }
  return rebuild(locale, key);
}
