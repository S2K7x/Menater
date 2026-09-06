/**
 * 03-AI-Decision, jouée en ENTIER par le vrai moteur.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EXISTE
 *
 * `transforms.test.ts` appelle `finalizeDecision(alerte, source, vars)` en lui
 * PASSANT l'alerte à la main : sous cet angle la fonction est correcte, et
 * l'était déjà. `pipeline.test.ts` relit le graphe : sous cet angle le câblage
 * est cohérent, et l'était aussi. Les deux passaient au vert pendant que 03
 * échouait sur CHACUNE de ses exécutions réelles.
 *
 * Ce qui manquait est entre les deux : ni `validateDecision` ni
 * `fallbackDecision` ne reportent l'alerte dans leur sortie, donc le nœud
 * `finalize` — qui les a tous deux pour amont — ne la recevait jamais et
 * mourait sur `enrichment_meta` de `undefined`. 03 ne pouvait aboutir sur
 * AUCUN chemin, et ni 04-Action-Routing ni 05-Audit-Log n'étaient atteints :
 * une alerte décidée sans trace, exactement ce que le pipeline existe pour
 * empêcher.
 *
 * Le test joue donc le vrai graphe, avec les vrais nœuds et le vrai
 * catalogue de transformations, sur les TROIS chemins qui mènent à
 * `finalize`.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { Engine } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import { pureHandlers } from './nodes/pure.ts';
import { ioHandlers } from './nodes/io.ts';
import { controlHandlers } from './nodes/control.ts';
import { buildRegistry } from './transforms/registry.ts';
import { DECISION, INGESTION } from './workflows/pipeline.ts';
import { normalizeAuditRow } from './transforms/audit.ts';

const NOW = new Date('2026-08-26T10:00:00Z');

/** Une alerte enrichie conforme à la garde d'entrée de 03. */
const enrichedAlert = () => ({
  alert_id: 'A-42',
  severity: 'high',
  source_ip: '185.220.101.5',
  dest_ip: '10.0.0.7',
  rule_name: 'brute_force_ssh',
  timestamp: '2026-08-26T09:59:00Z',
  raw_log: 'sshd: 50 failed passwords',
  enrichment: { shodan: { ports: [22] }, abuseipdb: { score: 92 }, vt: null },
  enrichment_meta: {
    sources_ok: ['shodan', 'abuseipdb'],
    sources_unavailable: ['vt'],
    sources_skipped: [],
    degraded: true,
  },
});

/**
 * `llm` est le seul nœud d'appel externe de 03 : `reply` décide de ce que le
 * modèle rend, et c'est lui qui choisit le chemin emprunté.
 */
function assemble(reply: () => Promise<Response>) {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['pipeline.shadowMode', true],
    ['llm.model', 'anthropic/claude-sonnet-4.5'],
    ['approval.timeoutMinutes', 30],
    ['isolation.ttlMinutes', 60],
    ['shadow.exitThreshold', 50],
  ]);

  const deps = {
    transforms: buildRegistry({
      now: () => NOW,
      resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
    }),
    vars: () => vars,
    now: () => NOW,
    secret: (name: string) => (name === 'openrouter.apiKey' ? 'sk-test' : undefined),
    fetch: (async () => reply()) as never,
    // 03 se termine par un `subflow` vers 04 : on l'observe sans le jouer.
    runSubflow: async (workflowId: string) => ({ run_id: `sub-${workflowId}`, status: 'done' }),
  };

  const engine = new Engine({
    store,
    handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
    now: () => NOW,
  });
  engine.register(DECISION);
  return { engine, store };
}

/** Une réponse de modèle conforme au schéma exigé par le nœud `llm`. */
const modelReply = (decision: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** Les étapes en échec, pour dire LAQUELLE a cassé plutôt que « ça échoue ». */
const failures = async (store: MemoryRunStore, runId: string) =>
  (await store.stepsOf(runId))
    .filter((s) => s.status === 'failed')
    .map((s) => `${s.nodeId}: ${s.error}`);

describe('03-AI-Decision, chaîne complète', () => {
  it('aboutit quand le modèle répond correctement', async () => {
    const { engine, store } = assemble(async () =>
      modelReply({
        verdict: 'true_positive',
        confidence: 0.93,
        reasoning: 'Force brute confirmée par la réputation de la source.',
        recommended_action: 'escalate',
        data_lineage: ['abuseipdb'],
      }));

    const run = await engine.start('03-ai-decision', enrichedAlert(), 'A-42');

    expect(await failures(store, run.id)).toEqual([]);
    expect(run.status).toBe('done');

    const finalize = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'finalize');
    expect(finalize?.status).toBe('ok');

    const out = finalize?.output as Record<string, any>;
    // L'ALERTE EST TOUJOURS LÀ. C'est elle qui manquait : sans elle, 04 ne
    // saurait pas quel hôte est concerné par la décision qu'il applique.
    expect(out.alert_id).toBe('A-42');
    expect(out.decision.verdict).toBe('true_positive');
    // Enrichissement dégradé (`vt` absent) → confiance plafonnée. Cette
    // barrière ne peut s'appliquer QUE si `enrichment_meta` est arrivé.
    expect(out.decision.confidence).toBe(0.85);
    // Le défaut fail-safe : rien ne s'exécute en shadow mode.
    expect(out.shadow_mode).toBe(true);
    expect(out.execution_allowed).toBe(false);
  });

  it('aboutit par le repli quand le modèle est injoignable', async () => {
    const { engine, store } = assemble(async () => {
      throw new Error('ECONNREFUSED');
    });

    const run = await engine.start('03-ai-decision', enrichedAlert(), 'A-42');

    const finalize = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'finalize');
    expect(finalize?.status).toBe('ok');
    expect(run.status).toBe('done');

    const out = finalize?.output as Record<string, any>;
    expect(out.alert_id).toBe('A-42');
    // On ne perd JAMAIS une alerte : un modèle muet la remonte à un humain.
    expect(out.decision.verdict).toBe('needs_human');
    expect(out.decision.confidence).toBe(0);
    expect(out.decision.recommended_action).toBe('escalate');
    expect(out.decision.decision_source).toBe('fallback_api_unavailable');
    expect(out.decision.is_fallback).toBe(true);
  });

  it('aboutit par le repli quand le modèle ne respecte pas le schéma', async () => {
    // Conforme au contrat du nœud `llm` (les clés exigées sont là), mais
    // refusé par les garde-fous : `auto_close` sur un `true_positive`.
    const { engine, store } = assemble(async () =>
      modelReply({
        verdict: 'pas_un_verdict',
        confidence: 5,
        reasoning: 'x',
        recommended_action: 'rm -rf',
        data_lineage: [],
      }));

    const run = await engine.start('03-ai-decision', enrichedAlert(), 'A-42');

    const finalize = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'finalize');
    expect(finalize?.status).toBe('ok');
    expect(run.status).toBe('done');

    const out = finalize?.output as Record<string, any>;
    expect(out.alert_id).toBe('A-42');
    expect(out.decision.verdict).toBe('needs_human');
    // Une action hors catalogue ne survit jamais à la dernière barrière.
    expect(['escalate', 'ticket']).toContain(out.decision.recommended_action);
  });
});

/**
 * N1 safety — no target, no isolation.
 *
 * Observables became optional so that alerts from real sources stop being
 * rejected. That freedom reaches the one action with a physical effect: an
 * alert may now legitimately carry neither a destination address nor a host.
 * Proposing to quarantine a machine we cannot name would put "isolate
 * undefined" in front of a human for approval.
 */
describe('isolate_host_temporary needs a host', () => {
  const decision = {
    verdict: 'true_positive',
    confidence: 0.95,
    reasoning: 'Confirmed hands-on-keyboard activity.',
    recommended_action: 'isolate_host_temporary',
    data_lineage: ['abuseipdb'],
  };

  const runWith = async (observables: Record<string, unknown>) => {
    const { engine, store } = assemble(async () => modelReply(decision));
    const run = await engine.start(
      '03-ai-decision',
      { ...enrichedAlert(), ...observables },
      'A-42',
    );
    const finalize = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'finalize');
    return finalize?.output as Record<string, any>;
  };

  it('downgrades to escalate when neither dest_ip nor host is present', async () => {
    const out = await runWith({ dest_ip: null, host: null });

    expect(out.decision.recommended_action).toBe('escalate');
    // The downgrade is stated, not silent: the operator sees why.
    expect(out.decision.guardrails_applied.join(' ')).toMatch(/no host to isolate/);
  });

  it('keeps the isolation when a host is named, even without dest_ip', async () => {
    // A Wazuh detection names the affected machine as its agent, not as a
    // destination. That is a target, and refusing it would be over-correction.
    const out = await runWith({ dest_ip: null, host: 'web-prod-01' });

    expect(out.decision.recommended_action).toBe('isolate_host_temporary');
  });

  it('keeps the isolation when dest_ip is present', async () => {
    const out = await runWith({ dest_ip: '10.0.0.7', host: null });

    expect(out.decision.recommended_action).toBe('isolate_host_temporary');
  });
});

/**
 * 01-Ingestion with tuning rules, played by the real engine.
 *
 * The wiring is what these cover, not the matcher — `tuning.test.ts` already
 * proves that in isolation. What can only break here is the graph: a junction
 * that reads one upstream instead of two, a closed alert that still costs an
 * enrichment, or a rules table outage that loses the alert entirely.
 */
describe('01-Ingestion, tuning rules', () => {
  const RULE = {
    id: 'r1',
    name: 'Authorised scanner',
    enabled: true,
    priority: 10,
    conditions: [
      { field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] },
      { field: 'rule_name', op: 'contains', values: ['port scan'] },
    ],
    action: 'allow',
    severity: null,
    owner: 'shai',
    reason: 'weekly authorised scan',
    expires_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };

  const incoming = (over: Record<string, unknown> = {}) => ({
    alert_id: 'W-1',
    rule_name: 'nmap port scan detected',
    severity: 'high',
    timestamp: '2026-08-26T09:00:00Z',
    raw_log: 'nmap -sS from 10.0.0.9',
    source_ip: '10.0.0.9',
    ...over,
  });

  /** 01 needs the dedup query and the rules query; both are `postgres` nodes. */
  function assembleIngestion(rules: unknown[], opts: { rulesFail?: boolean } = {}) {
    const store = new MemoryRunStore();
    const vars = new Map<string, unknown>([['pipeline.shadowMode', true]]);
    const subflows: string[] = [];

    const deps = {
      transforms: buildRegistry({
        now: () => NOW, resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
      }),
      vars: () => vars,
      now: () => NOW,
      secret: () => undefined,
      query: async (sql: string) => {
        if (sql.includes('soc_ingested_alerts')) return [{ is_duplicate: false }];
        if (sql.includes('soc_tuning_rule')) {
          if (opts.rulesFail) throw new Error('rules table unreachable');
          return rules as never[];
        }
        return [];
      },
      runSubflow: async (workflowId: string) => {
        subflows.push(workflowId);
        return { run_id: `sub-${workflowId}`, status: 'done' };
      },
    };

    const engine = new Engine({
      store,
      handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
      now: () => NOW,
    });
    engine.register(INGESTION);
    return { engine, store, subflows };
  }

  it('closes a matching alert straight to the audit log, skipping enrichment', async () => {
    const { engine, store, subflows } = assembleIngestion([RULE]);

    const run = await engine.start('01-ingestion', incoming(), 'W-1');

    expect(run.status).toBe('done');
    // CLOSED, NOT DROPPED. It still gets an audit row; it simply never costs
    // three enrichment calls and a model call.
    expect(subflows).toEqual(['05-audit-log']);
    expect(subflows).not.toContain('02-enrichment');

    const tuning = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'tuning');
    const out = tuning?.output as Record<string, any>;
    expect(out.closed_by_rule).toBe(true);
    expect(out.tuning.matched_rule.name).toBe('Authorised scanner');
    // The audit row has to answer "why" without the console.
    expect(out.decision.decision_source).toBe('tuning_rule');
    expect(out.decision.recommended_action).toBe('auto_close');
  });

  it('hands 05 a row it can actually write', async () => {
    // THE BUG THIS PINS. 05 reads `alert_id` at the TOP level and answers
    // `row_ok: false` otherwise — which routes to `unusable`, writes nothing,
    // and still reports the run as `done`. Nesting the alert one level down
    // therefore produced a rule-closed alert with NO audit row: closed and
    // dropped, green everywhere. Asserting the subflow ran was not enough.
    const { engine, store } = assembleIngestion([RULE]);

    const run = await engine.start('01-ingestion', incoming(), 'W-7');

    const out = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'tuning')?.output as any;
    const audit = normalizeAuditRow(out.audit_payload, 'run-1', () => NOW);

    expect(audit.row_ok).toBe(true);
    // The id the SENDER gave, which is what the audit has to be searchable by.
    expect(audit.row.alert_id).toBe('W-1');
    expect(audit.row.recommended_action).toBe('auto_close');
    expect(audit.row.decision_source).toBe('tuning_rule');
    // A rule closing an alert executes nothing.
    expect(audit.row.executed).toBe(false);
  });

  it('lets the same address through when the activity differs', async () => {
    const { subflows } = assembleIngestion([RULE]);
    const { engine } = assembleIngestion([RULE]);

    await engine.start('01-ingestion', incoming({ rule_name: 'data exfiltration detected' }), 'W-2');

    expect(subflows).toEqual([]);
  });

  it('sends a non-matching alert down the normal path', async () => {
    const { engine, subflows } = assembleIngestion([RULE]);

    await engine.start('01-ingestion', incoming({ source_ip: '203.0.113.9' }), 'W-3');

    expect(subflows).toEqual(['02-enrichment']);
  });

  it('rewrites only the severity for a `severity` rule', async () => {
    const { engine, store, subflows } = assembleIngestion([
      { ...RULE, action: 'severity', severity: 'low' },
    ]);

    const run = await engine.start('01-ingestion', incoming(), 'W-4');

    // Softened, not silenced: it still goes to enrichment.
    expect(subflows).toEqual(['02-enrichment']);
    const tuning = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'tuning');
    const out = tuning?.output as Record<string, any>;
    expect(out.closed_by_rule).toBe(false);
    expect(out.alert.severity).toBe('low');
  });

  it('does NOT lose the alert when the rules table is unreachable', async () => {
    // Losing the rules must make the pipeline NOISIER, never more permissive.
    // The error branch is wired so the alert continues untuned.
    const { engine, subflows } = assembleIngestion([RULE], { rulesFail: true });

    const run = await engine.start('01-ingestion', incoming(), 'W-5');

    expect(run.status).toBe('done');
    expect(subflows).toEqual(['02-enrichment']);
  });

  it('ignores an expired rule, and says which one lapsed', async () => {
    const { engine, store, subflows } = assembleIngestion([
      { ...RULE, expires_at: '2026-08-01T00:00:00Z' },
    ]);

    const run = await engine.start('01-ingestion', incoming(), 'W-6');

    expect(subflows).toEqual(['02-enrichment']);
    const tuning = (await store.stepsOf(run.id)).find((s) => s.nodeId === 'tuning');
    expect((tuning?.output as any).tuning.expired_rules).toEqual(['Authorised scanner']);
  });
});
