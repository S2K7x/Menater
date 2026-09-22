/**
 * N2/N3 — source normalization.
 *
 * ============================================================================
 * WHY THIS FILE IS DATA AND NOT CODE
 *
 * Adding a log source must not mean writing a parser. Every mapping here is a
 * table: a canonical field on the left, a path into the vendor payload on the
 * right. That is what makes "compatible with a maximum of sources" a matter of
 * appending rows rather than shipping a release.
 *
 * The reference implementations agree on this shape. The Wazuh→OCSF pipeline
 * that inspired it keeps 567 source-name variants pointing at 29 canonical
 * targets, hot-reloaded from a config file; Tenzir and Vector do the same with
 * a mapping language. None of them hand-writes a parser per vendor.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY MISSING
 *
 * NO DEPENDENCY. No YAML parser, no OCSF SDK. The API has exactly one
 * production dependency (`pg`) and this file does not add a second: an alias
 * table is data, and TypeScript already holds data.
 *
 * NO DEFAULTS. A field the source did not send stays absent — `normalize` may
 * rename and rescale, never invent. The one exception is `source`, which comes
 * from the ROUTE that received the alert, and is therefore a fact about our
 * own plumbing rather than a guess about the payload.
 *
 * NO DISCARDING. Whatever has no canonical home travels on in `extensions`.
 * The raw material of an audited decision is the last thing that may be lossy.
 * ============================================================================
 */

import { readPath } from '../values.ts';
import { SEVERITIES, type Severity } from './domain.ts';

/**
 * One source's mapping.
 *
 * `fields` maps a canonical name to the vendor paths that may hold it, tried
 * in order — the first one that carries a value wins. A list rather than a
 * single path because rulesets disagree: an SSH alert names the user
 * `data.srcuser`, a sudo alert `data.dstuser`, and both are "the user".
 */
export interface SourceMapping {
  source: string;
  /** Human-readable, shown in Réglages so the mapping is inspectable. */
  label: string;
  fields: Record<string, readonly string[]>;
  /**
   * Converts the vendor's own severity scale to ours.
   *
   * Returns `null` when the source carried nothing to convert — the alert is
   * then rejected for a missing identity field, which is honest, rather than
   * silently triaged as `low`.
   */
  severity: (body: Record<string, unknown>) => Severity | null;
  /** Vendor keys consumed by `fields`, so `extensions` is the remainder. */
  consumed: readonly string[];
  /**
   * How to point this source at the console, ready to paste.
   *
   * Generated rather than documented, for the same reason `composeSnippet`
   * is: the URL and the path are things the console already knows, and an
   * operator retyping them from a README is an operator debugging a typo.
   * `null` for sources that need no setup on their side.
   */
  setup: ((baseUrl: string) => SourceSetup) | null;
}

export interface SourceSetup {
  /** Shell commands, in order, run on the source's own host. */
  install: string[];
  /** Configuration to paste, and the file it belongs in. */
  configFile: string;
  config: string;
  /** Where to look when nothing arrives. */
  verify: string;
}

/** First path that carries a non-empty value, else `null`. */
function pick(body: Record<string, unknown>, paths: readonly string[]): unknown {
  for (const path of paths) {
    const v = readPath(body, path);
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

/**
 * Wazuh rule level (0–15) to our four-step scale.
 *
 * THESE THRESHOLDS ARE A POLICY, NOT A FACT. "Level 8 is high" is a judgment
 * every SOC makes differently, which is why N6 moves them into `soc_variable`
 * where they are versioned, dated and editable. Until then this is the
 * documented default, and it is documented in ROADMAP § 2 bis rather than
 * buried here.
 *
 * Level 0 means Wazuh chose not to alert at all. We do not second-guess that:
 * the integrator's own `<level>` filter is where those get dropped.
 */
export function wazuhSeverity(level: number): Severity {
  if (level >= 12) return 'critical';
  if (level >= 8) return 'high';
  if (level >= 4) return 'medium';
  return 'low';
}

/**
 * Wazuh — `alerts.json`, delivered by the integrator module.
 *
 * The shape is stable across 4.x: `rule`, `agent`, `data`, `full_log`. Wazuh
 * predefines thirteen dynamic fields under `data.` and rulesets add their own;
 * the predefined ones are mapped and everything else rides in `extensions`.
 */
export const WAZUH: SourceMapping = {
  source: 'wazuh',
  label: 'Wazuh (agent, syscheck, rootcheck)',
  fields: {
    alert_id: ['id'],
    rule_name: ['rule.description'],
    timestamp: ['timestamp'],
    // `previous_output` is what a grouped alert carries instead of a single
    // line — losing it would leave the model with nothing to read.
    raw_log: ['full_log', 'previous_output'],

    source_ip: ['data.srcip'],
    // Usually absent, and that is the whole point of N1: this single field
    // used to reject every Wazuh alert that reached the console.
    dest_ip: ['data.dstip'],
    user: ['data.srcuser', 'data.dstuser', 'data.user'],
    host: ['agent.name'],
    process: ['data.process', 'predecoder.program_name'],
    file_path: ['syscheck.path'],
    url: ['data.url'],
  },
  severity: (body) => {
    const level = readPath(body, 'rule.level');
    if (level === undefined || level === null) return null;
    const n = Number(level);
    return Number.isFinite(n) ? wazuhSeverity(n) : null;
  },
  consumed: [
    'id', 'rule', 'timestamp', 'full_log', 'previous_output',
    'data', 'agent', 'syscheck', 'predecoder',
  ],
  setup: (baseUrl) => ({
    install: [
      '# On the Wazuh manager. The script is in integrations/wazuh/ in this repository.',
      'scp integrations/wazuh/custom-menater root@WAZUH-MANAGER:/var/ossec/integrations/',
      'chmod 750 /var/ossec/integrations/custom-menater',
      '# Wazuh 4.2 and older: the group is `ossec`, not `wazuh`.',
      'chown root:wazuh /var/ossec/integrations/custom-menater',
      'systemctl restart wazuh-manager',
    ],
    configFile: '/var/ossec/etc/ossec.conf',
    config: [
      '<integration>',
      '  <name>custom-menater</name>',
      `  <hook_url>${baseUrl}/api/ingest/wazuh</hook_url>`,
      '  <api_key>THE SHARED SECRET ABOVE</api_key>',
      '  <!-- The volume dial. Wazuh generates a great deal below level 7,',
      '       and every forwarded alert costs a model call. Lower it once you',
      '       have seen what arrives. -->',
      '  <level>7</level>',
      '  <alert_format>json</alert_format>',
      '</integration>',
    ].join('\n'),
    verify: 'tail -f /var/ossec/logs/integrations.log — silence means success, '
      + 'the script only logs problems.',
  }),
};

/**
 * Generic — the shape the console has always accepted.
 *
 * Kept as a mapping of its own rather than as a special case in the router, so
 * that "no normalization" is one row in the same table as every other source
 * instead of a branch in the code.
 */
export const GENERIC: SourceMapping = {
  source: 'generic',
  label: 'Generic (MENATER canonical fields)',
  fields: {
    alert_id: ['alert_id'],
    rule_name: ['rule_name'],
    timestamp: ['timestamp'],
    raw_log: ['raw_log'],
    source_ip: ['source_ip'],
    dest_ip: ['dest_ip'],
    user: ['user'],
    host: ['host'],
    process: ['process'],
    file_path: ['file_path'],
    url: ['url'],
  },
  severity: (body) => {
    const raw = String(body.severity ?? '').toLowerCase();
    return SEVERITIES.includes(raw as Severity) ? (raw as Severity) : null;
  },
  consumed: [],
  // Nothing to install: whoever posts already speaks our shape.
  setup: (baseUrl) => ({
    install: [],
    configFile: '',
    config: [
      `POST ${baseUrl}/api/ingest/generic`,
      'X-SOC-Token: THE SHARED SECRET ABOVE',
      'Content-Type: application/json',
      '',
      JSON.stringify({
        alert_id: 'your-unique-id',
        rule_name: 'Multiple failed SSH logins',
        severity: 'high',
        timestamp: '2026-08-26T09:14:02Z',
        raw_log: 'the original log line',
        source_ip: '185.220.101.5',
      }, null, 2),
    ].join('\n'),
    verify: 'A 202 with a `run_id` means the alert entered the pipeline.',
  }),
};

export const MAPPINGS: readonly SourceMapping[] = [GENERIC, WAZUH];

/** The mapping for a source name, or `null` — we never guess a format. */
export function mappingFor(source: string): SourceMapping | null {
  return MAPPINGS.find((m) => m.source === source.toLowerCase()) ?? null;
}

/**
 * The deepest nesting a payload may carry.
 *
 * NOT A MEASURED MAXIMUM, A POLICY NUMBER, and the difference is the whole
 * reason it is this low. `JSON.stringify` is recursive in V8 while `JSON.parse`
 * is not, so the parser hands this function structures the serialiser cannot
 * survive: measured on Node 22.22.2, parse is still fine at 200 000 levels and
 * stringify gives up at 4 165. That 4 165 is not a constant either — it is a
 * property of the stack left at the moment of the call, and the same probe
 * under `--stack-size=2000` answers 8 500. A floor set just under whatever V8
 * happened to allow would therefore move with the machine.
 *
 * 64 is chosen against real data instead: the nine alerts the Health tab
 * injects are 2 levels deep, a Wazuh alert carrying MITRE arrays and agent
 * metadata is 5, and the deepest JSON this repository ships is 5. So it is an
 * order of magnitude above anything a source legitimately sends, and two below
 * the lowest point V8 has been seen to fail at.
 */
export const MAX_PAYLOAD_DEPTH = 64;

/**
 * A payload refused for its NESTING.
 *
 * Its own class, and for the reason `BodyTooLarge` is one: this is a refusal
 * WE made, about something the sender can act on, and conflated with an
 * ordinary unreadable body it became a verdict about identity fields nobody
 * had looked at. Told apart, it becomes a named 400 quoting the cap.
 *
 * No parameter property (`constructor(readonly limit: number)`): the service
 * runs under `node --experimental-strip-types`, which refuses that syntax at
 * startup while `tsc` and vitest accept it.
 */
export class PayloadTooDeep extends Error {
  /** The cap that was enforced, so the answer can name it rather than guess. */
  limit: number;

  constructor(limit: number) {
    super(`payload nested more than ${limit} levels deep`);
    this.limit = limit;
  }
}

/**
 * Whether a value is nested past `limit`. The body itself counts as level 1.
 *
 * IT REFUSES BEFORE IT DESCENDS, and that — not the explicit stack — is the
 * property that matters. The obvious way to write this is to measure the
 * depth and then compare it, which walks the whole structure first and
 * overflows on exactly the payload it exists to refuse: the defect rebuilt
 * inside its own repair, a shape this project has paid for before. Checked on
 * the way down instead, the walk stops at `limit + 1` levels, so refusing a
 * 200 000-deep body costs sixty-five steps rather than a traversal of it —
 * which is also what bounds the work an attacker can buy with one request.
 *
 * The stack is explicit for belt and braces: with the comparison in the right
 * place a recursive form is bounded too (measured — it holds `limit` frames
 * and no more), but then the guard's safety depends on where a future edit
 * leaves that one line. Iterating makes the frame depth independent of the
 * payload whatever happens to the comparison.
 */
function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > limit) return true;
    if (node === null || typeof node !== 'object') continue;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Applies a mapping.
 *
 * Throws `PayloadTooDeep`, and nothing else: a payload it cannot READ still
 * produces missing identity fields, which `validateAlertSchema` turns into a
 * named rejection. One it cannot SERIALISE is a different fact and has to be
 * one — reporting it as missing fields would tell a sender its alert lacked
 * what it had in fact sent.
 *
 * THE FLOOR IS ON THE WHOLE PAYLOAD, not on the fields this table maps.
 * `extensions` keeps every unmapped vendor key, whole, so a guard on the
 * mapped fields alone would let the nesting through under any other name — and
 * the run journal, the model prompt and the assistant's fence all serialise
 * what arrives. One door, checked once, before anything is copied.
 */
export function normalize(
  mapping: SourceMapping,
  input: unknown,
): Record<string, unknown> {
  const body = (input ?? {}) as Record<string, unknown>;
  if (exceedsDepth(body, MAX_PAYLOAD_DEPTH)) throw new PayloadTooDeep(MAX_PAYLOAD_DEPTH);
  const out: Record<string, unknown> = {};

  for (const [canonical, paths] of Object.entries(mapping.fields)) {
    const v = pick(body, paths);
    // Absent stays ABSENT — the key is not written at all, so the validator
    // sees the same thing it would see from a sender that never sent it.
    if (v !== null) out[canonical] = typeof v === 'object' ? JSON.stringify(v) : v;
  }

  const sev = mapping.severity(body);
  if (sev !== null) out.severity = sev;

  // The remainder, whole. `consumed` names the vendor keys the table already
  // read; everything else is vendor-specific context we have no column for and
  // no right to drop.
  const consumed = new Set<string>(mapping.consumed);
  const extensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!consumed.has(k)) extensions[k] = v;
  if (Object.keys(extensions).length > 0) out.extensions = extensions;

  return out;
}
