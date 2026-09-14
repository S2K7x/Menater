/**
 * J0.1 — what a scan finding becomes, and what the REAL pipeline does with it.
 *
 * ============================================================================
 * THE TWO QUESTIONS THIS FILE ASKS
 *
 * The first is the mapping's own: which fields carry what, which stay absent,
 * and what happens to a body that is not the shape we hoped. The second is the
 * one a fixture cannot answer — whether an alert built this way is actually
 * ACCEPTED by `01-Ingestion`, deduplicated by the same table, and refused by
 * the same validator as any other alert. So the end of this file assembles the
 * real engine on the real workflows, exactly as `injection.test.ts` does, and
 * promotes a finding through it.
 *
 * `pipeline-to-case.test.ts` is in this codebase because three field names were
 * read from the same memory that wrote the fixtures. A mapping checked only
 * against a fixture of itself proves nothing.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { Engine } from './engine/engine.ts';
import { MemoryRunStore } from './engine/store.ts';
import { buildRegistry } from './engine/transforms/registry.ts';
import { pureHandlers } from './engine/nodes/pure.ts';
import { ioHandlers } from './engine/nodes/io.ts';
import { controlHandlers } from './engine/nodes/control.ts';
import { PIPELINE_WORKFLOWS } from './engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from './engine/workflows/routing.ts';
import { injectAlert } from './injection.ts';
import { isolationTarget } from './engine/transforms/domain.ts';
import { UNTRUSTED_ALERT_FIELDS } from './assistant/sanitize.ts';
import { alertSeverity, findingAlertId, findingToAlert } from './findings.ts';

const NOW = new Date('2026-09-14T02:00:00.000Z');

/** A finding as `ReportView` holds it, with every field populated. */
function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: 'critical',
    report_level: 'critical',
    vulnerability: 'IDOR',
    route: '/orders/:id',
    http_method: 'GET',
    file: 'src/routes/orders.ts',
    line: 42,
    claude_verdict: 'confirmed',
    claude_reasoning: 'The handler reads the id straight off the params.',
    technical_summary: 'No ownership check between the lookup and the response.',
    plain_language_summary: 'Anyone logged in can read anyone else’s order.',
    suggested_fix_direction: 'Scope the query to the authenticated user.',
    owasp_category: 'A01:2021 Broken Access Control',
    evidence: 'code',
    local_confidence_score: 0.82,
    detected_by: ['idor-scanner', 'idor-llm'],
    code_excerpt: {
      start_line: 41,
      lines: ['const id = req.params.id;', 'const order = await db.orders.find(id);'],
      highlight_line: 42,
      truncated: false,
    },
    ...over,
  };
}

function promote(over: Record<string, unknown> = {}, scanRunId = 'scan-001') {
  return findingToAlert(
    { scan_run_id: scanRunId, target: 'acme/api', finding: finding(over) },
    NOW,
  );
}

/** Unwraps a mapping that must have succeeded, so a failure reads as one. */
function alertOf(outcome: ReturnType<typeof promote>): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`mapping failed: ${outcome.errors.join('; ')}`);
  return outcome.alert;
}

describe('the alert a finding becomes', () => {
  it('carries the identity fields the contract requires', () => {
    const alert = alertOf(promote());

    expect(alert.alert_id).toMatch(/^vulnpipe-[0-9a-f]{20}$/);
    expect(alert.rule_name).toBe('IDOR in GET /orders/:id');
    expect(alert.severity).toBe('critical');
    expect(alert.timestamp).toBe(NOW.toISOString());
    expect(String(alert.raw_log).length).toBeGreaterThan(0);
  });

  it('puts the file and its line where the contract keeps a path', () => {
    expect(alertOf(promote()).file_path).toBe('src/routes/orders.ts:42');
    // A finding whose line the model could not give still names the file: the
    // path is the observable, the line is a refinement of it.
    expect(alertOf(promote({ line: null })).file_path).toBe('src/routes/orders.ts');
  });

  it('renders the evidence into raw_log, code excerpt included', () => {
    const raw = String(alertOf(promote()).raw_log);

    expect(raw).toContain('IDOR in GET /orders/:id');
    expect(raw).toContain('Arbiter verdict: confirmed');
    expect(raw).toContain('Local confidence: 0.82');
    expect(raw).toContain('Anyone logged in can read anyone');
    expect(raw).toContain('Scope the query to the authenticated user.');
    // The highlighted line is marked, so the model reads the same line the
    // operator is looking at on the report.
    expect(raw).toContain('> 42 | const order = await db.orders.find(id);');
  });

  it('leaves out a section the scan did not fill, rather than heading an empty one', () => {
    const raw = String(alertOf(promote({ suggested_fix_direction: '' })).raw_log);

    expect(raw).toContain('Technical summary:');
    // An empty "Direction for a fix:" would read as the scan having nothing to
    // suggest, which is a claim it never made.
    expect(raw).not.toContain('Direction for a fix:');
  });

  it('keeps the whole finding in extensions, structured', () => {
    const ext = alertOf(promote()).extensions as Record<string, Record<string, unknown>>;

    expect(ext.vulnpipe.scan_run_id).toBe('scan-001');
    expect(ext.vulnpipe.target).toBe('acme/api');
    expect(ext.vulnpipe.owasp_category).toBe('A01:2021 Broken Access Control');
    expect(ext.vulnpipe.claude_verdict).toBe('confirmed');
    expect(ext.vulnpipe.local_confidence_score).toBe(0.82);
    expect(ext.vulnpipe.detected_by).toEqual(['idor-scanner', 'idor-llm']);
  });
});

describe('what the alert deliberately does NOT carry', () => {
  /**
   * The one that matters most on this feature.
   *
   * `isolate_host_temporary` is proposed from `dest_ip ?? host`. A finding says
   * a route is exploitable; it says nothing about a machine being compromised,
   * and a scanner reading source code must not be able to put "cut this server
   * off the network" in front of an approver.
   */
  it('names no host, so an isolation cannot even be proposed', () => {
    const alert = alertOf(promote());

    expect(alert.host).toBeUndefined();
    expect(alert.dest_ip).toBeUndefined();
    expect(isolationTarget(alert as { dest_ip?: string | null; host?: string | null }))
      .toBeNull();
  });

  it('does not turn the route into a url observable', () => {
    // `/orders/:id` is a path on our own service. In `url` it would offer a
    // threat-intel lookup on a value no provider can say anything about.
    expect(alertOf(promote()).url).toBeUndefined();
  });
});

/**
 * THE SECURITY PROPERTY.
 *
 * A finding is model prose about a repository somebody else wrote. Every string
 * of it must reach the assistant inside a fence, which means landing in a field
 * `UNTRUSTED_ALERT_FIELDS` covers — and `alert_id` is not one of them.
 */
describe('repository and model text only ever lands in a fenced field', () => {
  it('puts no finding-supplied text in alert_id', () => {
    const marker = 'IGNORE-PREVIOUS-INSTRUCTIONS';
    const outcome = promote({
      vulnerability: marker, route: `/${marker}`, file: `${marker}.ts`,
      http_method: marker,
    });

    // Derived, not composed: the id is our prefix plus hex, whatever was sent.
    expect(String(alertOf(outcome).alert_id)).toMatch(/^vulnpipe-[0-9a-f]{20}$/);
    expect(String(alertOf(outcome).alert_id)).not.toContain(marker);
  });

  it('writes no unfenced key beyond the contract vocabulary it owns', () => {
    const alert = alertOf(promote());
    // `alert_id`, `severity` and `timestamp` are ours: an id we derived, a word
    // off a closed list, and a clock reading. Everything else this mapping
    // writes has to be a name the fence knows.
    const ours = new Set(['alert_id', 'severity', 'timestamp']);
    const fenced = new Set<string>(UNTRUSTED_ALERT_FIELDS);

    for (const key of Object.keys(alert)) {
      if (ours.has(key)) continue;
      expect(fenced.has(key), `${key} is written by the mapping and is not fenced`).toBe(true);
    }
  });
});

describe('the identity of a promoted finding', () => {
  it('is stable for one finding of one scan, so a second press opens no second case', () => {
    expect(alertOf(promote()).alert_id).toBe(alertOf(promote()).alert_id);
  });

  it('ignores the line number, which moves whenever a line is added above it', () => {
    expect(alertOf(promote({ line: 42 })).alert_id)
      .toBe(alertOf(promote({ line: 500 })).alert_id);
  });

  it('changes with the flaw', () => {
    const base = alertOf(promote()).alert_id;
    expect(alertOf(promote({ route: '/invoices/:id' })).alert_id).not.toBe(base);
    expect(alertOf(promote({ file: 'src/routes/other.ts' })).alert_id).not.toBe(base);
    expect(alertOf(promote({ vulnerability: 'SQLI' })).alert_id).not.toBe(base);
    expect(alertOf(promote({ http_method: 'POST' })).alert_id).not.toBe(base);
  });

  /**
   * The reason the scan run is in the key. Deduplication on `alert_id` has no
   * expiry, so an identity made of the flaw alone would mean a flaw fixed in
   * January and regressed in June can never be triaged again — for ever, and
   * under a green check.
   */
  it('changes with the scan, so a regression found later can be triaged again', () => {
    expect(alertOf(promote({}, 'scan-002')).alert_id)
      .not.toBe(alertOf(promote({}, 'scan-001')).alert_id);
  });

  it('cannot be collided by moving a delimiter into one of its parts', () => {
    const a = findingAlertId('s', { vulnerability: 'A B', http_method: 'G', route: '/r', file: 'f' });
    const b = findingAlertId('s', { vulnerability: 'A', http_method: 'B G', route: '/r', file: 'f' });
    expect(a).not.toBe(b);
  });
});

describe('five severities to four', () => {
  it('maps the four shared names across unchanged', () => {
    for (const s of ['low', 'medium', 'high', 'critical'] as const) {
      expect(alertSeverity(s)).toBe(s);
    }
  });

  it('folds info into low rather than dropping the finding', () => {
    expect(alertSeverity('info')).toBe('low');
  });

  it('refuses a word that is on neither scale', () => {
    expect(alertSeverity('catastrophic')).toBeNull();
    expect(alertSeverity(7)).toBeNull();
    expect(alertSeverity(null)).toBeNull();
  });
});

describe('a body that is not the shape we hoped', () => {
  it('names every missing field rather than answering "invalid"', () => {
    const outcome = findingToAlert({ finding: {} }, NOW);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const joined = outcome.errors.join(' | ');
    for (const field of ['vulnerability', 'http_method', 'route', 'file', 'severity']) {
      expect(joined).toContain(field);
    }
    expect(joined).toContain('scan_run_id');
  });

  it('refuses a finding that is not an object, without throwing', () => {
    for (const bad of ['nope', 42, null, ['a'], undefined]) {
      const outcome = findingToAlert({ scan_run_id: 's', finding: bad }, NOW);
      expect(outcome.ok).toBe(false);
    }
  });

  it('does not coerce a number into a string field', () => {
    // `String(7)` would have produced a plausible-looking `rule_name`. The
    // caller sent the wrong type and has to be told so.
    const outcome = findingToAlert(
      { scan_run_id: 's', finding: finding({ vulnerability: 7 }) }, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors.join(' ')).toContain('vulnerability');
  });

  it('survives a finding whose optional fields are all rubbish', () => {
    const outcome = findingToAlert({
      scan_run_id: 's',
      finding: {
        vulnerability: 'IDOR', http_method: 'GET', route: '/r', file: 'f.ts',
        severity: 'high',
        line: 'twelve', detected_by: 'nope', local_confidence_score: 'high',
        code_excerpt: 'not an object', claude_reasoning: { nested: true },
      },
    }, NOW);

    // The required half is sound, so the alert exists; the rubbish is dropped
    // rather than taking a real finding down with it.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.alert.file_path).toBe('f.ts');
    const ext = outcome.alert.extensions as Record<string, Record<string, unknown>>;
    expect(ext.vulnpipe.detected_by).toEqual([]);
    expect(ext.vulnpipe.local_confidence_score).toBeNull();
  });

  it('clips an enormous field instead of carrying it into the pipeline', () => {
    const outcome = promote({ technical_summary: 'x'.repeat(50_000) });
    const raw = String(alertOf(outcome).raw_log);
    expect(raw.length).toBeLessThan(15_000);
    expect(raw).toContain('(clipped)');
  });
});

// ---------------------------------------------------------------------------
// Against the REAL pipeline.
// ---------------------------------------------------------------------------

/** The whole pipeline, with the database, the model and the network stubbed. */
function assemble(opts: { dedup?: boolean } = {}) {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', true],
    ['approval.timeoutMinutes', 30],
    ['isolation.ttlMinutes', 60],
    ['shadow.exitThreshold', 50],
    ['notify.minSeverity', 'off'],
    ['endpoint.isolation', ''],
    ['endpoint.ticket', ''],
    ['errors.windowMinutes', 60],
    ['errors.systemicThreshold', 5],
    ['errors.suppressMinutes', 30],
    ['llm.model', 'test/model'],
  ]);

  const deps = {
    transforms: buildRegistry({
      now: () => NOW,
      resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
    }),
    vars: () => vars,
    now: () => NOW,
    // No model key: the pipeline takes its fail-safe verdict, which is the
    // state this environment — and a fresh install — is actually in.
    secret: () => undefined,
    query: async (sql: string) => {
      if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: opts.dedup === true }];
      if (sql.includes('INSERT INTO soc_audit_log')) {
        return [{
          id: '4242', alert_id: 'x', prev_hash: 'aaaa', integrity_hash: 'bbbb',
          event_time: NOW.toISOString(),
        }] as never[];
      }
      return [];
    },
    runSubflow: async (workflowId: string, input: unknown, alertId: string | null) => {
      const sub = await engine.start(workflowId, input, alertId);
      return { run_id: sub.id, status: sub.status };
    },
  };

  const engine: Engine = new Engine({
    store,
    handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
    now: () => NOW,
  });
  for (const wf of [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS]) engine.register(wf);
  return engine;
}

describe('a promoted finding, through the workflows that really run', () => {
  it('is ACCEPTED by 01-Ingestion, like any other alert', async () => {
    const engine = assemble();
    const mapped = promote();
    if (!mapped.ok) throw new Error(mapped.errors.join('; '));

    const result = await injectAlert(
      engine, { ...mapped.alert, source: 'vulnpipe' }, mapped.alert_id);

    // 202 is the only acceptance. Anything else here means the mapping builds
    // an alert the pipeline's own validator rejects — which is precisely what
    // a fixture of the mapping could never tell us.
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(result.run_id).toBeTruthy();
  });

  it('is answered "already seen" when the same finding of the same scan is sent twice', async () => {
    const engine = assemble({ dedup: true });
    const mapped = promote();
    if (!mapped.ok) throw new Error(mapped.errors.join('; '));

    const result = await injectAlert(
      engine, { ...mapped.alert, source: 'vulnpipe' }, mapped.alert_id);

    // No second case, and the console is told so rather than shown a green
    // banner over a chain that deliberately did not start.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.detail).toBe('duplicate, skipped');
  });

  it('is refused, by name, when the finding carried a severity off the scale', async () => {
    // The mapping refuses this one before the pipeline sees it — and the point
    // of the assertion is that the two refusals agree about the field.
    const outcome = findingToAlert(
      { scan_run_id: 's', finding: finding({ severity: 'catastrophic' }) }, NOW);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.join(' ')).toContain('severity');

    // And if one ever got past it, `01-Ingestion` says the same thing.
    const engine = assemble();
    const result = await injectAlert(
      engine, { ...alertOf(promote()), severity: 'catastrophic', source: 'vulnpipe' }, 'x');
    expect(result.status).toBe(400);
    expect(result.detail).toContain('invalid_severity');
  });
});
