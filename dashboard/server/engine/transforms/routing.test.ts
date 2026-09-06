/**
 * Tests du portage 04 → 06.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * 04 est le seul workflow qui TOUCHE au monde réel. Tout ce qui suit vérifie
 * qu'il ne le fait pas sans qu'un humain l'ait dit — et que les trois issues
 * d'une approbation restent trois issues distinctes.
 *
 * 05 porte les deux taux du shadow mode, qui ne doivent jamais se confondre.
 * 06 est le dernier filet : s'il casse, l'incident est muet.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  actionCatalog, approvalTriggers, buildApprovalRequest, buildAuditRecord,
  enforceCatalog, guardRoutingPayload, interpretApproval, shadowBaseline, shadowOutcome,
  type DecidedAlert,
} from './routing.ts';
import { exposeAuditAndMetrics, normalizeAuditRow } from './audit.ts';
import { assessError, normalizeErrorEvent, notificationOutcome } from './errors.ts';
import { ACTIONS } from './domain.ts';

const NOW = () => new Date('2026-08-24T10:00:00.000Z');

const decided = (over: Record<string, unknown> = {}): DecidedAlert =>
  ({
    alert_id: 'A-1', source_ip: '203.0.113.7', dest_ip: '10.0.0.4',
    // N1 observables: present here, but every one of them may be null.
    user: null, host: null, process: null, file_path: null, url: null,
    source: 'generic', extensions: {},
    rule_name: 'Multiple failed SSH logins', severity: 'high',
    timestamp: '2026-08-24T09:58:00Z', raw_log: 'sshd: failed', ingested_at: '2026-08-24T09:59:00Z',
    source_workflow: '03-AI-Decision', shadow_mode: true,
    enrichment: {
      shodan: { status: 'ok', source: 'shodan' },
      abuseipdb: { status: 'unavailable', source: 'abuseipdb', reason: 'timeout' },
      vt: { status: 'skipped', source: 'virustotal', reason: 'pas de hash' },
    },
    enrichment_meta: {
      enriched_at: '2026-08-24T09:59:30Z', file_hash: null, file_hash_type: null,
      source_ip_is_private: false, sources_ok: ['shodan'], sources_skipped: ['vt'],
      sources_unavailable: ['abuseipdb'], degraded: true,
    },
    decision: {
      verdict: 'true_positive', confidence: 0.9,
      reasoning: 'Brute force confirmé, abuseipdb unavailable.',
      recommended_action: 'isolate_host_temporary', data_lineage: ['enrichment.shodan.open_ports'],
      raw_confidence: 0.95, decision_source: 'model', model: 'm', attempts: 1, usage: null,
      is_fallback: false, guardrails_applied: [], validator_violations: null,
    },
    ...over,
  }) as DecidedAlert;

const VARS = {
  ttlMinutes: 60,
  isolationEndpoint: 'https://edr.test/isolate',
  approvalChannel: '#soc-approvals',
  escalationChannel: '#soc-escalation',
  timeoutMinutes: 30,
};

// =============================================================================
describe('04 — garde d’entrée', () => {
  it('accepte un payload complet', () => {
    expect(guardRoutingPayload(decided()).payload_ok).toBe(true);
  });

  it('EXIGE que shadow_mode soit un booléen', () => {
    // LE TEST QUI COMPTE. La chaîne « false » est VRAIE en JavaScript :
    // l'accepter ferait basculer en exécution réelle un pipeline censé être
    // en observation.
    const r = guardRoutingPayload(decided({ shadow_mode: 'false' }));
    expect(r.payload_ok).toBe(false);
    expect(r.missing_fields).toContain('shadow_mode');
  });

  it('refuse une action hors catalogue', () => {
    const r = guardRoutingPayload(
      decided({ decision: { ...decided().decision, recommended_action: 'wipe_disk' } }),
    );
    expect(r.missing_fields).toContain('decision.recommended_action');
  });

  it('ne lève jamais, même sur un objet vide', () => {
    expect(() => guardRoutingPayload({})).not.toThrow();
    expect(guardRoutingPayload({}).alert).toBeNull();
  });
});

describe('04 — shadow mode', () => {
  it('ne fait RIEN et dit ce qu’il aurait fait', () => {
    const out = shadowOutcome(decided(), shadowBaseline([], 50));
    expect(out.executed).toBe(false);
    expect(out.action_taken).toBe('none');
    expect(out.would_have_done).toBe('isolate_host_temporary');
    // Aucune approbation demandée : on ne dérange personne pour une action
    // qui n'aura pas lieu.
    expect(out.approval).toBeNull();
  });

  it('compte depuis l’AUDIT, pas depuis la mémoire du processus', () => {
    // Sous n8n, ces compteurs vivaient dans `$getWorkflowStaticData` et
    // repartaient de zéro à chaque redémarrage : le seuil de 50 alertes ne
    // voulait alors plus rien dire.
    const rows = [
      { verdict: 'true_positive', recommended_action: 'ticket', n: 30, is_fallback: false, degraded: false },
      { verdict: 'false_positive', recommended_action: 'auto_close', n: 25, is_fallback: false, degraded: true },
    ];
    const b = shadowBaseline(rows, 50);
    expect(b.count).toBe(55);
    expect(b.by_verdict).toEqual({ true_positive: 30, false_positive: 25 });
    expect(b.degraded).toBe(25);
    expect(b.ready_to_exit_shadow).toBe(true);
  });

  it('ne déclare pas le seuil atteint sous le seuil', () => {
    expect(shadowBaseline([{ n: 49 }], 50).ready_to_exit_shadow).toBe(false);
  });
});

describe('04 — demande d’approbation', () => {
  it('dit POURQUOI l’approbation est demandée', () => {
    // Un approbateur qui ne sait pas pourquoi finit par cliquer par réflexe.
    const t = approvalTriggers(decided().decision);
    expect(t.join(' ')).toMatch(/isolate_host_temporary/);
  });

  it('n’invente jamais « aucune raison »', () => {
    const t = approvalTriggers({
      ...decided().decision, recommended_action: 'ticket', confidence: 0.99,
      verdict: 'true_positive', is_fallback: false,
    });
    expect(t).toEqual(['default routing rule']);
  });

  it('chaque action du catalogue a intent, blast radius ET rollback', () => {
    // Une action dont on ne sait pas écrire le plan d'annulation n'a rien à
    // faire dans un catalogue d'actions réversibles.
    const catalog = actionCatalog(decided(), VARS);
    for (const action of ACTIONS) {
      expect(catalog[action].intent, action).toBeTruthy();
      expect(catalog[action].blast_radius, action).toBeTruthy();
      expect(catalog[action].rollback_plan, action).toBeTruthy();
    }
  });

  it('porte le lien de reprise, le TTL et le canal d’escalade', () => {
    const req = buildApprovalRequest(decided(), VARS, 'https://console.test/r/run-1/jeton', NOW);
    expect(req.resume_url).toBe('https://console.test/r/run-1/jeton');
    expect(req.ttl_minutes).toBe(60);
    expect(JSON.stringify(req.slack.blocks)).toContain('#soc-escalation');
  });

  it('affiche le statut RÉEL de chaque source, y compris indisponible', () => {
    const req = buildApprovalRequest(decided(), VARS, 'u', NOW);
    const text = JSON.stringify(req.slack.blocks);
    expect(text).toMatch(/abuseipdb.*unavailable/);
    expect(text).toMatch(/vt.*skipped/);
  });

  it('rabat une action indescriptible sur ticket plutôt que de demander à l’aveugle', () => {
    const req = buildApprovalRequest(
      decided({ decision: { ...decided().decision, recommended_action: 'inconnue' } }),
      VARS, 'u', NOW,
    );
    expect(req.proposed_action).toBe('ticket');
  });
});

describe('04 — issue de l’approbation : trois cas distincts', () => {
  const request = () => buildApprovalRequest(decided(), VARS, 'u', NOW);

  it('approuve sur « approve », et enregistre qui', () => {
    const r = interpretApproval(request(), { decision: 'approve', approver: 'shai', reason: 'confirmé' }, 30, NOW);
    expect(r.outcome).toBe('approved');
    expect(r.approval.approver?.slack_username).toBe('shai');
    expect(r.approval.human_reasoning).toBe('confirmé');
  });

  it('marque l’identité comme DÉCLARATIVE, jamais authentifiée', () => {
    // Le jeton prouve qu'on détient le lien, pas qu'on est untel. Le dire
    // explicitement vaut mieux que de laisser croire à une authentification.
    const r = interpretApproval(request(), { decision: 'approve', approver: 'x' }, 30, NOW);
    expect(r.approval.approver?.identity_source).toBe('self_declared');
    expect(r.approval.approver?.signature_verified).toBe(false);
  });

  it('LE SILENCE N’EST PAS UN ACCORD : rien reçu vaut expiration', () => {
    const r = interpretApproval(request(), null, 30, NOW);
    expect(r.outcome).toBe('timeout_escalated');
    expect(r.approval.approver).toBeNull();
  });

  it('n’approuve jamais par défaut d’interprétation', () => {
    // Toute réponse qui n'est pas exactement « approve » ne peut pas exécuter.
    for (const payload of [{}, { decision: 'oui' }, { decision: 'APPROVE' }, { decision: '' }]) {
      expect(interpretApproval(request(), payload, 30, NOW).outcome).not.toBe('approved');
    }
  });
});

describe('04 — défense en profondeur sur le catalogue', () => {
  it('laisse passer une action du catalogue', () => {
    const r = enforceCatalog({ proposed_action: 'ticket' });
    expect(r.action_blocked).toBe(false);
  });

  it('rabat sur ticket une action hors catalogue, MÊME approuvée', () => {
    // Le garde-fou de 03 aurait déjà dû l'écarter. Entre 03 et ici il y a un
    // appel réseau, trente minutes d'attente et une reprise possible.
    const r = enforceCatalog({ proposed_action: 'wipe_disk' });
    expect(r.action_blocked).toBe(true);
    expect(r.proposed_action).toBe('ticket');
    expect(r.block_reason).toMatch(/outside the reversible catalogue/);
  });
});

describe('04 — audit unique quelle que soit la branche', () => {
  it('conserve l’alerte et ajoute l’issue', () => {
    const row = buildAuditRecord(decided(), { routing_outcome: 'approved', executed: true, action_taken: 'isolate_host_temporary' }, NOW);
    expect(row).toMatchObject({
      alert_id: 'A-1', source_workflow: '04-Action-Routing',
      routing_outcome: 'approved', executed: true,
    });
  });

  it('n’invente pas une exécution absente', () => {
    const row = buildAuditRecord(decided(), {}, NOW);
    expect(row.executed).toBe(false);
    expect(row.routing_outcome).toBe('unknown');
  });
});

// =============================================================================
describe('05 — ligne d’audit', () => {
  it('déduit la provenance de la présence du routage', () => {
    expect(normalizeAuditRow(decided(), 'run-1', NOW).row.source_workflow).toBe('03-AI-Decision');
    const routed = { ...decided(), routing_outcome: 'approved', source_workflow: undefined };
    expect(normalizeAuditRow(routed, 'run-1', NOW).row.source_workflow).toBe('04-Action-Routing');
  });

  it('CORRIGE l’incohérence shadow+executed, et le SIGNALE', () => {
    // La contrainte CHECK de la base rejetterait la ligne, donc la trace
    // serait perdue. On corrige — mais une correction silencieuse masquerait
    // un vrai défaut du routage.
    const r = normalizeAuditRow({ ...decided(), shadow_mode: true, executed: true }, 'run-1', NOW);
    expect(r.row.executed).toBe(false);
    expect(r.problems.join(' ')).toMatch(/inconsistent/);
  });

  it('shadow_mode non booléen retombe sur true', () => {
    expect(normalizeAuditRow({ ...decided(), shadow_mode: 'peut-être' }, 'r', NOW).row.shadow_mode).toBe(true);
  });

  it('un rejet humain est un désaccord explicite', () => {
    // C'est la seule définition d'override observable sans vérité terrain,
    // et c'est elle qui alimente `human_disagreement_rate`.
    const rejected = { ...decided(), approval: { outcome: 'rejected', approver: { slack_username: 'shai' } } };
    expect(normalizeAuditRow(rejected, 'r', NOW).row.human_override).toBe(true);

    const approved = { ...decided(), approval: { outcome: 'approved', approver: { slack_username: 'shai' } } };
    expect(normalizeAuditRow(approved, 'r', NOW).row.human_override).toBe(false);
  });

  it('calcule la latence bout-en-bout depuis l’ingestion', () => {
    const r = normalizeAuditRow(decided(), 'r', NOW);
    expect(r.row.latency_ms).toBe(60_000);
  });

  it('laisse la latence à null plutôt que de mettre zéro', () => {
    // Zéro serait lu comme « instantané ». `null` se lit comme « inconnu ».
    expect(normalizeAuditRow({ ...decided(), ingested_at: null }, 'r', NOW).row.latency_ms).toBeNull();
  });

  it('ne lève jamais : une ligne sans alert_id est signalée, pas rejetée', () => {
    const r = normalizeAuditRow({}, 'run-1', NOW);
    expect(r.row_ok).toBe(false);
    expect(r.problems).toContain('alert_id');
  });
});

describe('05 — mesures', () => {
  it('dit « indisponible » plutôt que de renvoyer des zéros', () => {
    // « 0 % de désaccord humain » et « on ne sait pas » mènent à des
    // décisions OPPOSÉES sur la sortie du shadow mode.
    const out = exposeAuditAndMetrics({ id: 1 }, null);
    expect((out.metrics as Record<string, unknown>).available).toBe(false);
    expect(JSON.stringify(out.metrics)).not.toMatch(/human_disagreement_rate_pct/);
  });

  it('expose les DEUX taux séparément quand ils existent', () => {
    const out = exposeAuditAndMetrics(
      { id: 1, integrity_hash: 'abc' },
      { alerts_total: 100, ai_false_positive_verdict_rate: 42, human_disagreement_rate: 7 },
    );
    const m = out.metrics as Record<string, unknown>;
    expect(m.ai_false_positive_verdict_rate_pct).toBe(42);
    expect(m.human_disagreement_rate_pct).toBe(7);
  });

  it('porte le moyen de vérifier la chaîne d’intégrité', () => {
    const audit = exposeAuditAndMetrics({ id: 1 }, null).audit as Record<string, unknown>;
    expect(audit.chain_verify_hint).toMatch(/soc_audit_verify_chain/);
  });
});

// =============================================================================
describe('06 — normalisation d’un incident', () => {
  it('classe par table de correspondance', () => {
    expect(normalizeErrorEvent({ error_code: 'SCHEMA_VALIDATION_FAILED' }, NOW).severity).toBe('low');
    expect(normalizeErrorEvent({ error_code: 'AUDIT_WRITE_FAILED' }, NOW).severity).toBe('high');
  });

  it('une écriture interrompue est toujours high', () => {
    // C'est précisément le cas où un humain doit trancher.
    expect(normalizeErrorEvent({ error_code: 'STEP_INDETERMINATE' }, NOW).severity).toBe('high');
  });

  it('une sévérité déclarée l’emporte sur la table', () => {
    const ev = normalizeErrorEvent({ error_code: 'SCHEMA_VALIDATION_FAILED', severity: 'high' }, NOW);
    expect(ev.severity).toBe('high');
    expect(ev.severity_source).toBe('declared');
  });

  it('un code inconnu vaut medium, pas low', () => {
    // Une erreur qu'on ne sait pas classer mérite d'être regardée.
    const ev = normalizeErrorEvent({ error_code: 'JAMAIS_VU' }, NOW);
    expect(ev.severity).toBe('medium');
    expect(ev.severity_source).toBe('default');
  });

  it('borne le message sans le perdre', () => {
    const ev = normalizeErrorEvent({ error_message: 'x'.repeat(9000) }, NOW);
    expect(ev.error_message.length).toBe(4000);
  });

  it('ne lève jamais, même sur une entrée vide', () => {
    expect(() => normalizeErrorEvent(null, NOW)).not.toThrow();
  });
});

describe('06 — rafales et suppression', () => {
  const vars = { windowMinutes: 60, threshold: 5, suppressMinutes: 30 };
  const ev = () => normalizeErrorEvent({ error_code: 'LLM_API_UNAVAILABLE' }, NOW);

  it('sous le seuil, la route suit la sévérité', () => {
    const a = assessError(ev(), { error_id: 1, errors_in_window: 2, minutes_since_systemic: null }, vars);
    expect(a.route).toBe('high');
  });

  it('au-dessus du seuil, l’alerte systémique REMPLACE l’individuelle', () => {
    const a = assessError(ev(), { error_id: 1, errors_in_window: 9, minutes_since_systemic: null }, vars);
    expect(a.route).toBe('systemic');
  });

  it('une systémique déjà signalée récemment est supprimée', () => {
    // Vingt messages identiques dans un canal, c'est un canal que plus
    // personne ne lit.
    const a = assessError(ev(), { error_id: 1, errors_in_window: 9, minutes_since_systemic: 4 }, vars);
    expect(a.route).toBe('suppressed');
  });

  it('la suppression expire', () => {
    const a = assessError(ev(), { error_id: 1, errors_in_window: 9, minutes_since_systemic: 31 }, vars);
    expect(a.route).toBe('systemic');
  });

  it('BASE MUETTE : on alerte quand même, et on le dit', () => {
    // Ne pas pouvoir journaliser n'est jamais une raison de ne pas alerter :
    // c'est une raison d'alerter plus fort, puisqu'on ne peut plus compter.
    const a = assessError(ev(), null, vars);
    expect(a.db.logged).toBe(false);
    expect(a.escalated_because_db_down).toBe(true);
    expect(a.route).toBe('high');
  });
});

describe('06 — le dernier maillon ne lève jamais', () => {
  const vars = { windowMinutes: 60, threshold: 5, suppressMinutes: 30 };
  const assess = (severity: string, db: Record<string, unknown> | null = { error_id: 1, errors_in_window: 1 }) =>
    assessError(normalizeErrorEvent({ error_code: 'X', severity }, NOW), db, vars);

  it('ne notifie pas une sévérité low', () => {
    const out = notificationOutcome(assess('low'), null, () => {}, NOW);
    expect((out.notification as Record<string, unknown>).status).toBe('skipped');
  });

  it('reconnaît un envoi Slack réussi', () => {
    const out = notificationOutcome(assess('high'), { ok: true, ts: '1.2', channel: '#c' }, () => {}, NOW);
    expect((out.notification as Record<string, unknown>).status).toBe('sent');
  });

  it('un HTTP 200 avec ok:false est un ÉCHEC', () => {
    const out = notificationOutcome(assess('high'), { ok: false, error: 'channel_not_found' }, () => {}, NOW);
    expect((out.notification as Record<string, unknown>).status).toBe('failed_abandoned');
  });

  it('écrit sur la console quand tout le reste est muet', () => {
    // Le dernier endroit où la trace survit quand la base ET Slack sont morts.
    const lines: string[] = [];
    notificationOutcome(assess('high', null), null, (l) => lines.push(l), NOW);
    expect(lines.join('\n')).toMatch(/NOTIFICATION ABANDONED/);
    expect(lines.join('\n')).toMatch(/DATABASE UNAVAILABLE/);
  });

  it('ne lève jamais, quelle que soit la réponse Slack', () => {
    for (const response of [null, {}, { ok: false }, { garbage: true }]) {
      expect(() => notificationOutcome(assess('high'), response, () => {}, NOW)).not.toThrow();
    }
  });
});
