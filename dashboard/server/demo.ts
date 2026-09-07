/**
 * The sample set.
 *
 * ============================================================================
 * WHY DEMONSTRATION DATA IN A SECURITY TOOL
 *
 * On a fresh install there is no database schema applied and no API key set.
 * Without a sample set the console would open on an empty page, and nobody
 * could judge the interface before wiring everything up — exactly the wrong
 * way round.
 *
 * TWO GUARDS so it deceives nobody:
 *  1. the mode is shown permanently in the header (the "DEMO" banner);
 *  2. as soon as the engine has runs of its own, the real data replaces this
 *     and the mode becomes "LIVE". The two are never mixed.
 *
 * The cases below deliberately cover the hard outcomes: a fallback verdict,
 * degraded enrichment, an expired approval, a lost audit row. A demonstration
 * that shows only the nominal path proves nothing.
 * ============================================================================
 */

import type { AlertCase } from '../src/lib/types.ts';
import { messages, type Locale } from './i18n.ts';
import { tagAttack } from './engine/attack.ts';

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

function build(partial: Omit<AlertCase, 'attack' | 'dwell_ms' | 'extensions' | 'repository'>): AlertCase {
  const stages = partial.stages;
  const last = stages[stages.length - 1];
  return {
    ...partial,
    // Left null here rather than filled in: the sample set must not claim a
    // repository nobody declared. `snapshot.ts` resolves it against the real
    // inventory afterwards, so a sample host an operator DID list still
    // matches — the demonstration then shows the operator's own estate.
    repository: null,
    // The sample set carries no vendor fields: inventing some would put
    // invented data on a screen whose whole job is to show what was really
    // observed.
    extensions: null,
    attack: tagAttack(partial.rule_name, partial.raw_log),
    dwell_ms: last
      ? new Date(last.started_at).getTime() + (last.duration_ms ?? 0) - new Date(partial.received_at).getTime()
      : null,
  };
}

const okShodan = {
  status: 'ok' as const, source: 'shodan', org: 'Tor Exit Node', isp: 'Foundation for Applied Privacy',
  country: 'AT', open_ports: [22, 443, 9001], tags: ['tor'], last_update: at(2880),
};
const okAbuse = {
  status: 'ok' as const, source: 'abuseipdb', abuse_confidence_score: 92, total_reports: 418,
  distinct_reporters: 141, country_code: 'AT', usage_type: 'Data Center/Web Hosting/Transit',
  is_tor: true, last_reported_at: at(120),
};

/**
 * Le jeu d'exemple est RECONSTRUIT a chaque appel, dans la langue demandee.
 *
 * Une constante figee aurait ete plus economique, mais elle aurait fige aussi
 * la langue : quelqu'un qui ouvre la console en anglais tombe d'abord sur ces
 * cas, et une demonstration a moitie francaise ne demontre rien. Le cout est
 * une poignee d'objets construits toutes les quinze secondes au pire — le
 * cache du snapshot absorbe le reste.
 */
export function demoCases(locale: Locale): AlertCase[] {
  const msg = messages(locale);
  const sg = msg.stages;
  const dm = msg.demo;
  return [
  build({
    alert_id: 'ALT-2026-0823-0412',
    received_at: at(6),
    state: 'awaiting_approval',
    severity: 'high',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    source_ip: '185.220.101.47',
    dest_ip: '10.12.4.31',
    host: 'srv-bastion-01',
    raw_log:
      'Aug 23 11:54:07 web01 sshd[2211]: Accepted password for root from 185.220.101.47 port 51234 ssh2 after 47 failures',
    shadow_mode: false,
    executed: false,
    routing_outcome: null,
    action_taken: null,
    enrichment: { shodan: okShodan, abuseipdb: okAbuse, vt: { status: 'unavailable', source: 'virustotal', http_status: 429, reason: 'rate limited' } },
    enrichment_meta: {
      enriched_at: at(6), file_hash: null, file_hash_type: null, source_ip_is_private: false,
      sources_ok: ['shodan', 'abuseipdb'], sources_skipped: [], sources_unavailable: ['vt'], degraded: true,
    },
    decision: {
      verdict: 'true_positive', confidence: 0.85, raw_confidence: 0.91,
      reasoning:
        'The source is a Tor exit node with an AbuseIPDB score of 92 across 141 distinct reporters, and the rule describes a successful authentication after 47 failures. VirusTotal was unavailable, so no file-level corroboration was possible.',
      recommended_action: 'isolate_host_temporary',
      data_lineage: ['enrichment.abuseipdb.abuse_confidence_score', 'enrichment.abuseipdb.distinct_reporters', 'enrichment.shodan.tags'],
      decision_source: 'llm', model: 'openrouter/free', attempts: 1, is_fallback: false,
      guardrails_applied: [dm.cappedConfidence(0.85, 'vt')],
      usage: { input_tokens: 1840, output_tokens: 210 },
    },
    approval: {
      requested_action: 'isolate_host_temporary',
      intent: dm.isolateIntent('10.12.4.31', 60),
      blast_radius: dm.isolateBlast('10.12.4.31', 60),
      rollback_plan: dm.isolateRollback(60),
      triggers: [dm.triggerContainment('isolate_host_temporary'), dm.triggerConfidence(0.85)],
      outcome: 'pending', approver: null, human_reasoning: null, timeout_minutes: 30,
      requested_at: at(6), execution_id: 'demo-waiting',
    },
    audit: null,
    stages: [
      { workflow: '01-Ingestion', execution_id: '101', status: 'success', started_at: at(7), duration_ms: 240, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '102', status: 'success', started_at: at(7), duration_ms: 8400, note: sg.sources('shodan, abuseipdb', true) },
      { workflow: '03-AI-Decision', execution_id: '103', status: 'success', started_at: at(6), duration_ms: 4100, note: sg.decision(sg.verdicts.true_positive!, 0.85, false) },
      { workflow: '04-Action-Routing', execution_id: '104', status: 'waiting', started_at: at(6), duration_ms: null, note: sg.awaitingApproval },
    ],
    errors: [],
  }),
  build({
    alert_id: 'ALT-2026-0823-0411',
    received_at: at(24),
    state: 'actioned',
    severity: 'critical',
    rule_name: 'Malware dropper written to disk and executed via PowerShell',
    source_ip: '45.147.230.12',
    dest_ip: '10.12.7.88',
    host: 'wks-finance-12',
    raw_log:
      'Aug 23 11:36:02 win-fs02 Sysmon: ProcessCreate powershell.exe -enc ... payload sha256 9f2b7c1e4a8d3f6b0c5e9a2d7f4b8e1c6a3d0f7b2e5c8a1d4f7b0e3c6a9d2f5b',
    shadow_mode: false,
    executed: true,
    routing_outcome: 'approved',
    action_taken: 'isolate_host_temporary',
    enrichment: {
      shodan: { status: 'ok', source: 'shodan', org: 'Bulletproof Hosting Ltd', open_ports: [80, 443, 8080], tags: ['c2'] },
      abuseipdb: { status: 'ok', source: 'abuseipdb', abuse_confidence_score: 100, total_reports: 2311, distinct_reporters: 604 },
      vt: { status: 'ok', source: 'virustotal', malicious: 41, suspicious: 3, harmless: 12, undetected: 8, popular_threat_label: 'trojan.emotet/heur' },
    },
    enrichment_meta: {
      enriched_at: at(24), file_hash: '9f2b7c1e4a8d3f6b0c5e9a2d7f4b8e1c6a3d0f7b2e5c8a1d4f7b0e3c6a9d2f5b',
      file_hash_type: 'sha256', source_ip_is_private: false,
      sources_ok: ['shodan', 'abuseipdb', 'vt'], sources_skipped: [], sources_unavailable: [], degraded: false,
    },
    decision: {
      verdict: 'true_positive', confidence: 0.96, raw_confidence: 0.96,
      reasoning:
        'VirusTotal reports 41 malicious detections for the dropped file with an Emotet threat label, and the source IP has a perfect AbuseIPDB score across 604 distinct reporters. All three enrichment sources returned data.',
      recommended_action: 'isolate_host_temporary',
      data_lineage: ['enrichment.vt.malicious', 'enrichment.vt.popular_threat_label', 'enrichment.abuseipdb.abuse_confidence_score'],
      decision_source: 'llm', model: 'openrouter/free', attempts: 1, is_fallback: false,
      guardrails_applied: [], usage: { input_tokens: 2210, output_tokens: 188 },
    },
    approval: {
      requested_action: 'isolate_host_temporary',
      intent: dm.isolateIntent('10.12.7.88', 60),
      blast_radius: dm.fileServerBlast(60, 40),
      rollback_plan: dm.shortRollback,
      triggers: [dm.triggerContainment('isolate_host_temporary')],
      outcome: 'approved',
      approver: { slack_username: '@shai', slack_user_id: null, responded_at: at(22), identity_source: 'self_declared', signature_verified: false },
      human_reasoning: dm.approvedReason,
      timeout_minutes: 30, requested_at: at(23), execution_id: 'demo-done',
    },
    audit: { committed: true, row_id: 1042, integrity_hash: 'b7c9e14a2f8d3b6e05c1a9f47d2e8b3c6a0f5d1e9c4b7a2f8e3d6c1b4a9f7e2d', prev_hash: 'a1f4c8e2b7d3059f6c1a8e4b2d7f3c9a5e0b6d1f8c3a7e2b9d4f6c0a5e1b8d3f', failure: null },
    stages: [
      { workflow: '01-Ingestion', execution_id: '95', status: 'success', started_at: at(25), duration_ms: 190, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '96', status: 'success', started_at: at(25), duration_ms: 6200, note: sg.sources('shodan, abuseipdb, vt', false) },
      { workflow: '03-AI-Decision', execution_id: '97', status: 'success', started_at: at(24), duration_ms: 3900, note: sg.decision(sg.verdicts.true_positive!, 0.96, false) },
      { workflow: '04-Action-Routing', execution_id: '98', status: 'success', started_at: at(23), duration_ms: 62_000, note: sg.outcomes.approved! },
      { workflow: '05-Audit-Log', execution_id: '99', status: 'success', started_at: at(22), duration_ms: 310, note: sg.auditSealed(1042) },
    ],
    errors: [],
  }),
  build({
    alert_id: 'ALT-2026-0823-0409',
    received_at: at(52),
    state: 'closed',
    severity: 'low',
    rule_name: 'Port scan detected from internal subnet',
    source_ip: '10.12.0.14',
    dest_ip: '10.12.4.0/24',
    host: 'wks-eng-07',
    raw_log: 'Aug 23 11:08:41 fw01 kernel: SCAN 10.12.0.14 -> 10.12.4.0/24 ports 1-1024 (vuln-scanner scheduled job)',
    shadow_mode: false,
    executed: true,
    routing_outcome: 'auto_closed',
    action_taken: 'auto_close',
    enrichment: {
      shodan: { status: 'unavailable', source: 'shodan', http_status: 404, reason: 'no information available for that IP' },
      abuseipdb: { status: 'ok', source: 'abuseipdb', abuse_confidence_score: 0, total_reports: 0, distinct_reporters: 0, is_whitelisted: true },
      vt: { status: 'skipped', source: 'virustotal', reason: 'no_file_hash_in_raw_log' },
    },
    enrichment_meta: {
      enriched_at: at(52), file_hash: null, file_hash_type: null, source_ip_is_private: true,
      sources_ok: ['abuseipdb'], sources_skipped: ['vt'], sources_unavailable: ['shodan'], degraded: true,
    },
    decision: {
      verdict: 'false_positive', confidence: 0.93, raw_confidence: 0.97,
      reasoning:
        'The source is an internal RFC1918 address whitelisted in AbuseIPDB with zero reports, and the log names a scheduled vulnerability scanner. Shodan was unavailable, which is expected for a private address and does not weaken this verdict.',
      recommended_action: 'auto_close',
      data_lineage: ['enrichment.abuseipdb.abuse_confidence_score', 'enrichment.abuseipdb.is_whitelisted'],
      decision_source: 'llm', model: 'openrouter/free', attempts: 1, is_fallback: false,
      guardrails_applied: [dm.cappedConfidence(0.93, 'shodan')],
      usage: { input_tokens: 1620, output_tokens: 174 },
    },
    approval: null,
    audit: { committed: true, row_id: 1039, integrity_hash: 'a1f4c8e2b7d3059f6c1a8e4b2d7f3c9a5e0b6d1f8c3a7e2b9d4f6c0a5e1b8d3f', prev_hash: 'de3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85', failure: null },
    stages: [
      { workflow: '01-Ingestion', execution_id: '88', status: 'success', started_at: at(53), duration_ms: 160, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '89', status: 'success', started_at: at(53), duration_ms: 9100, note: sg.sources('abuseipdb', true) },
      { workflow: '03-AI-Decision', execution_id: '90', status: 'success', started_at: at(52), duration_ms: 2800, note: sg.decision(sg.verdicts.false_positive!, 0.93, false) },
      { workflow: '04-Action-Routing', execution_id: '91', status: 'success', started_at: at(52), duration_ms: 140, note: sg.outcomes.auto_closed! },
      { workflow: '05-Audit-Log', execution_id: '92', status: 'success', started_at: at(52), duration_ms: 280, note: sg.auditSealed(1039) },
    ],
    errors: [],
  }),
  build({
    alert_id: 'ALT-2026-0823-0407',
    received_at: at(96),
    state: 'closed',
    severity: 'high',
    rule_name: 'Outbound data transfer to unrecognised host',
    source_ip: '10.12.9.5',
    dest_ip: '91.219.236.18',
    host: 'srv-files-02',
    raw_log: 'Aug 23 10:24:11 proxy01: CONNECT 91.219.236.18:443 bytes_out=2147483648 user=jdoe',
    shadow_mode: false,
    executed: false,
    routing_outcome: 'timeout_escalated',
    action_taken: 'none',
    enrichment: {
      shodan: { status: 'ok', source: 'shodan', org: 'Unknown Hosting', open_ports: [443], tags: [] },
      abuseipdb: { status: 'unavailable', source: 'abuseipdb', http_status: 401, reason: 'invalid API key' },
      vt: { status: 'skipped', source: 'virustotal', reason: 'no_file_hash_in_raw_log' },
    },
    enrichment_meta: {
      enriched_at: at(96), file_hash: null, file_hash_type: null, source_ip_is_private: false,
      sources_ok: ['shodan'], sources_skipped: ['vt'], sources_unavailable: ['abuseipdb'], degraded: true,
    },
    decision: {
      verdict: 'needs_human', confidence: 0.58, raw_confidence: 0.58,
      reasoning:
        'A 2 GB outbound transfer to an unrecognised host is consistent with exfiltration but also with a legitimate backup. AbuseIPDB was unavailable so the destination reputation is unknown, which is the evidence that would settle it.',
      recommended_action: 'escalate',
      data_lineage: ['enrichment.shodan.org'],
      decision_source: 'llm', model: 'openrouter/free', attempts: 2, is_fallback: false,
      guardrails_applied: [], usage: { input_tokens: 1980, output_tokens: 205 },
    },
    approval: {
      requested_action: 'escalate',
      intent: dm.escalateIntent,
      blast_radius: dm.escalateBlast,
      rollback_plan: dm.escalateRollback,
      triggers: [dm.triggerBelow(0.58, 0.85), dm.triggerNeedsHuman],
      outcome: 'timeout_escalated', approver: null,
      human_reasoning: null, timeout_minutes: 30, requested_at: at(96), execution_id: 'demo-timeout',
    },
    audit: { committed: true, row_id: 1035, integrity_hash: 'de3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85', prev_hash: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a', failure: null },
    stages: [
      { workflow: '01-Ingestion', execution_id: '80', status: 'success', started_at: at(97), duration_ms: 210, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '81', status: 'success', started_at: at(97), duration_ms: 24_300, note: sg.sources('shodan', true) },
      { workflow: '03-AI-Decision', execution_id: '82', status: 'success', started_at: at(96), duration_ms: 7400, note: sg.decision(sg.verdicts.needs_human!, 0.58, false) },
      { workflow: '04-Action-Routing', execution_id: '83', status: 'success', started_at: at(96), duration_ms: 1_800_000, note: sg.outcomes.timeout_escalated! },
      { workflow: '05-Audit-Log', execution_id: '84', status: 'success', started_at: at(66), duration_ms: 260, note: sg.auditSealed(1035) },
    ],
    errors: [],
  }),
  build({
    alert_id: 'ALT-2026-0823-0405',
    received_at: at(150),
    state: 'failed',
    severity: 'medium',
    rule_name: 'Suspicious sudo usage outside maintenance window',
    source_ip: '10.12.3.77',
    dest_ip: '10.12.3.77',
    host: 'srv-build-03',
    raw_log: 'Aug 23 09:30:55 app03 sudo: jdoe : TTY=pts/2 ; PWD=/root ; USER=root ; COMMAND=/bin/bash',
    shadow_mode: false,
    executed: false,
    routing_outcome: 'ticket_created',
    action_taken: 'ticket',
    enrichment: {
      shodan: { status: 'unavailable', source: 'shodan', http_status: 404, reason: 'no information available' },
      abuseipdb: { status: 'unavailable', source: 'abuseipdb', http_status: 422, reason: 'private address' },
      vt: { status: 'skipped', source: 'virustotal', reason: 'no_file_hash_in_raw_log' },
    },
    enrichment_meta: {
      enriched_at: at(150), file_hash: null, file_hash_type: null, source_ip_is_private: true,
      sources_ok: [], sources_skipped: ['vt'], sources_unavailable: ['shodan', 'abuseipdb'], degraded: true,
    },
    decision: {
      verdict: 'needs_human', confidence: 0, raw_confidence: 0,
      reasoning: dm.fallbackReasoning,
      recommended_action: 'escalate', data_lineage: [],
      decision_source: 'fallback_api_unavailable', model: null, attempts: 3, is_fallback: true,
      guardrails_applied: [dm.forcedNeedsHuman(0.7)],
      validator_violations: ['Aucune sortie du modele (output undefined).'], usage: null,
    },
    approval: null,
    audit: { committed: false, row_id: null, integrity_hash: null, prev_hash: null, failure: 'relation "soc_audit_log" does not exist' },
    stages: [
      { workflow: '01-Ingestion', execution_id: '70', status: 'success', started_at: at(151), duration_ms: 180, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '71', status: 'success', started_at: at(151), duration_ms: 30_100, note: sg.sources(sg.noneLabel, true) },
      { workflow: '03-AI-Decision', execution_id: '72', status: 'success', started_at: at(150), duration_ms: 15_400, note: sg.decision(sg.verdicts.needs_human!, 0, true) },
      { workflow: '04-Action-Routing', execution_id: '73', status: 'success', started_at: at(150), duration_ms: 900, note: sg.outcomes.ticket_created! },
      { workflow: '05-Audit-Log', execution_id: '74', status: 'error', started_at: at(150), duration_ms: 15_200, note: sg.auditLost('relation "soc_audit_log" does not exist') },
    ],
    errors: [
      { workflow: '03-AI-Decision', error_code: 'LLM_API_UNAVAILABLE', message: dm.modelUnavailable(2), severity: 'high', at: at(150), requires_replay: false },
      { workflow: '05-Audit-Log', error_code: 'AUDIT_WRITE_FAILED', message: dm.auditWriteFailed(3), severity: 'high', at: at(150), requires_replay: true },
    ],
  }),
  build({
    alert_id: 'ALT-2026-0823-0402',
    received_at: at(210),
    state: 'closed',
    severity: 'medium',
    rule_name: 'Brute force against VPN portal',
    source_ip: '203.0.113.44',
    dest_ip: '10.12.1.2',
    host: 'vpn-gw-01',
    raw_log: 'Aug 23 07:51:19 vpn01: 312 failed authentications from 203.0.113.44 in 90s',
    shadow_mode: true,
    executed: false,
    routing_outcome: 'shadow_logged',
    action_taken: 'none',
    enrichment: {
      shodan: { status: 'ok', source: 'shodan', org: 'Example Telecom', open_ports: [22, 80], tags: [] },
      abuseipdb: { status: 'ok', source: 'abuseipdb', abuse_confidence_score: 64, total_reports: 87, distinct_reporters: 31 },
      vt: { status: 'skipped', source: 'virustotal', reason: 'no_file_hash_in_raw_log' },
    },
    enrichment_meta: {
      enriched_at: at(210), file_hash: null, file_hash_type: null, source_ip_is_private: false,
      sources_ok: ['shodan', 'abuseipdb'], sources_skipped: ['vt'], sources_unavailable: [], degraded: false,
    },
    decision: {
      verdict: 'true_positive', confidence: 0.81, raw_confidence: 0.81,
      reasoning:
        '312 failed authentications in 90 seconds is a brute force attempt by any definition, and AbuseIPDB scores the source 64 across 31 distinct reporters. No successful authentication appears in the log, so this is an attempt rather than a compromise.',
      recommended_action: 'ticket', data_lineage: ['enrichment.abuseipdb.abuse_confidence_score', 'enrichment.abuseipdb.distinct_reporters'],
      decision_source: 'llm', model: 'openrouter/free', attempts: 1, is_fallback: false,
      guardrails_applied: [], usage: { input_tokens: 1710, output_tokens: 192 },
    },
    approval: null,
    audit: { committed: true, row_id: 1028, integrity_hash: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a', prev_hash: '6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b', failure: null },
    stages: [
      { workflow: '01-Ingestion', execution_id: '60', status: 'success', started_at: at(211), duration_ms: 175, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '61', status: 'success', started_at: at(211), duration_ms: 5100, note: sg.sources('shodan, abuseipdb', false) },
      { workflow: '03-AI-Decision', execution_id: '62', status: 'success', started_at: at(210), duration_ms: 3300, note: sg.decision(sg.verdicts.true_positive!, 0.81, false) },
      { workflow: '04-Action-Routing', execution_id: '63', status: 'success', started_at: at(210), duration_ms: 120, note: sg.outcomes.shadow_logged! },
      { workflow: '05-Audit-Log', execution_id: '64', status: 'success', started_at: at(210), duration_ms: 240, note: sg.auditSealed(1028) },
    ],
    errors: [],
  }),
  build({
    alert_id: 'ALT-2026-0823-0398',
    received_at: at(320),
    state: 'closed',
    severity: 'low',
    rule_name: 'Deprecated TLS version negotiated',
    source_ip: '198.51.100.7',
    dest_ip: '10.12.2.19',
    host: 'lb01',
    raw_log: 'Aug 23 06:02:33 lb01: TLSv1.0 handshake accepted from 198.51.100.7',
    shadow_mode: true,
    executed: false,
    routing_outcome: 'shadow_logged',
    action_taken: 'none',
    enrichment: {
      shodan: { status: 'ok', source: 'shodan', org: 'Example ISP', open_ports: [443], tags: [] },
      abuseipdb: { status: 'ok', source: 'abuseipdb', abuse_confidence_score: 2, total_reports: 1, distinct_reporters: 1 },
      vt: { status: 'skipped', source: 'virustotal', reason: 'no_file_hash_in_raw_log' },
    },
    enrichment_meta: {
      enriched_at: at(320), file_hash: null, file_hash_type: null, source_ip_is_private: false,
      sources_ok: ['shodan', 'abuseipdb'], sources_skipped: ['vt'], sources_unavailable: [], degraded: false,
    },
    decision: {
      verdict: 'false_positive', confidence: 0.88, raw_confidence: 0.88,
      reasoning:
        'A deprecated TLS handshake is a hardening finding, not an intrusion, and the source scores 2 on AbuseIPDB with a single report. This belongs in the configuration backlog rather than the incident queue.',
      recommended_action: 'auto_close', data_lineage: ['enrichment.abuseipdb.abuse_confidence_score'],
      decision_source: 'llm', model: 'openrouter/free', attempts: 1, is_fallback: false,
      guardrails_applied: [], usage: { input_tokens: 1540, output_tokens: 160 },
    },
    approval: null,
    audit: { committed: true, row_id: 1021, integrity_hash: '6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b', prev_hash: '0000000000000000000000000000000000000000000000000000000000000000', failure: null },
    stages: [
      { workflow: '01-Ingestion', execution_id: '50', status: 'success', started_at: at(321), duration_ms: 150, note: sg.received },
      { workflow: '02-Enrichment', execution_id: '51', status: 'success', started_at: at(321), duration_ms: 4700, note: sg.sources('shodan, abuseipdb', false) },
      { workflow: '03-AI-Decision', execution_id: '52', status: 'success', started_at: at(320), duration_ms: 2900, note: sg.decision(sg.verdicts.false_positive!, 0.88, false) },
      { workflow: '04-Action-Routing', execution_id: '53', status: 'success', started_at: at(320), duration_ms: 110, note: sg.outcomes.shadow_logged! },
      { workflow: '05-Audit-Log', execution_id: '54', status: 'success', started_at: at(320), duration_ms: 230, note: sg.auditSealed(1021) },
    ],
    errors: [],
  }),
];
}
