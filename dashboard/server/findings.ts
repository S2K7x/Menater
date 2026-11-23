/**
 * J0.1 — a scan finding enters the triage queue.
 *
 * ============================================================================
 * WHAT THIS CLOSES
 *
 * Until now a code flaw was a report you read and closed. The triage circuit —
 * enrichment, a decision under guardrails, a human approval, an audit row in
 * the hash chain — existed one tab away and nothing could reach it from here.
 * That is the half of J0 the roadmap calls the reason the two products live in
 * the same application; without it the merge is visual.
 *
 * This file is the mapping, and nothing else. It decides what an alert made of
 * a finding LOOKS LIKE. It does not decide to send one: a human presses a
 * button on a finding they chose, `routes/findings.ts` hands the result to
 * `injectAlert`, and the alert enters `01-Ingestion` at the same line a Wazuh
 * alert does — one pipeline, one set of guardrails, one audit chain. That is
 * the rule N already applies to a polled alert, applied to this door too.
 *
 * ============================================================================
 * EVERY FIELD A REPOSITORY OR A MODEL WROTE LANDS IN A FENCED ONE
 *
 * A finding is composed of text nobody here controls: the route and the file
 * path come out of a scanned repository, the summaries and the reasoning are a
 * model's prose about that repository. Both are attacker-influenceable in the
 * ordinary case — you scan code you did not write.
 *
 * `UNTRUSTED_ALERT_FIELDS` in `assistant/sanitize.ts` fences `raw_log`,
 * `rule_name`, `file_path`, `url`, `user`, `process` and `extensions`. So the
 * mapping below is constrained, not merely convenient: everything that came
 * from the repository or the model goes into one of those names, and nothing
 * else. `alert_id` is the field that proves the rule — it is NOT fenced, so it
 * is DERIVED (a hash) rather than composed from the finding's own strings.
 * A test asserts no finding-supplied text survives into it.
 *
 * ============================================================================
 * THE ALERT CARRIES NO HOST, AND THAT IS THE POINT
 *
 * `isolate_host_temporary` refuses to run when it has no host to name
 * (`isolationTarget()` in `domain.ts`). A static-analysis finding says a route
 * is exploitable; it says nothing about a machine being compromised, and
 * proposing to cut a server off the network because a scanner read its source
 * would be the invented default of § 8 in the place it costs most.
 *
 * So `host` stays `null` — not as a precaution bolted on here, but because we
 * genuinely do not know one, and absent stays absent. The contract's own
 * safety property then does the work, with no second rule to keep in step.
 * The same goes for both addresses, the user and the process.
 * ============================================================================
 */

import { createHash } from 'node:crypto';

import { SEVERITIES, type Severity } from './engine/transforms/domain.ts';
import {
  clip, FIELD_MAX, findingIdentityKey, type FindingIdentity,
} from '../src/lib/finding-identity.ts';
import type { CaseRepository } from '../src/lib/types.ts';

/** The scale VulnPipe's aggregator works on (`aggregator/severity-rules.ts`). */
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Five levels to four.
 *
 * THIS IS A POLICY, NOT A FACT — the same note `wazuhSeverity` carries, for the
 * same reason. Four of the five names are shared and map across unchanged;
 * `info` is the only one the console's scale has no room for, and it becomes
 * `low` rather than being dropped, because dropping it would replace a finding
 * somebody deliberately promoted with nothing.
 *
 * Nothing is scaled DOWN. A `critical` finding becomes a `critical` alert: a
 * remotely exploitable injection is the shape of thing this queue exists for,
 * and deciding here that code flaws matter less than log events would be a
 * judgment made in a mapping table, invisible to the operator who set the
 * severity thresholds.
 *
 * Returns `null` for a value that is not on the scale — the alert is then
 * rejected for an unreadable identity field, which is honest, rather than
 * silently triaged as `low`.
 */
export function alertSeverity(reported: unknown): Severity | null {
  if (typeof reported !== 'string') return null;
  const v = reported.trim().toLowerCase();
  if (v === 'info') return 'low';
  return SEVERITIES.includes(v as Severity) ? (v as Severity) : null;
}

/**
 * The alert id, derived — never composed from what the finding sent.
 *
 * TWO PROPERTIES, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 * 1. `soc_ingested_alerts` is keyed on `alert_id` with no expiry, so two
 *    promotions carrying one id are one case and the second is answered
 *    `duplicate, skipped`. Within a report that is exactly the protection
 *    wanted: pressing the button twice on one finding must not open two cases.
 *
 * 2. The SCAN RUN IS THEREFORE PART OF THE IDENTITY. Keyed on the flaw alone,
 *    a finding fixed in January and regressed in June could never be triaged
 *    again — the dedup store would answer `duplicate` about a case closed six
 *    months earlier, for ever, under a green check. That is a permanent silent
 *    hole of exactly the family this project keeps finding, and a queue is a
 *    journal of events, not a picture of current state: "a human promoted this
 *    finding out of scan X" happened, and it can happen again next scan.
 *    Whether the same unfixed flaw is worth promoting twice is the operator's
 *    call, and they make it by pressing the button a second time.
 *
 * THE FLAW'S HALF OF THE KEY IS NOT BUILT HERE. `findingIdentityKey` owns the
 * four fields, their separator and their normalisation, because the report
 * screen builds the same key to find the case a promotion opened (J0.5) — and
 * two spellings of one identity would disagree silently, which is the shape
 * `humanBytes` was moved into one module to stop. The line number stays out of
 * it for the reason that module gives.
 *
 * The result is `vulnpipe-` plus hex. No repository text and no model text
 * survives into it, which is what lets an unfenced field carry it safely.
 * `findings.test.ts` pins the exact digest of a known finding: a change to the
 * key would otherwise re-key every install's dedup table in silence, and
 * every flaw ever promoted would become promotable again.
 */
export function findingAlertId(scanRunId: string, finding: FindingIdentity): string {
  const digest = createHash('sha256')
    .update(`${scanRunId}\u0000${findingIdentityKey(finding)}`)
    .digest('hex');
  return `vulnpipe-${digest.slice(0, 20)}`;
}

/**
 * A stored string, taken verbatim.
 *
 * `findingToAlert` hashes the exact bytes it then stores, so the digest is a
 * claim about what is IN the bag — and reading the bag back through the
 * writer's own `str()` would make this comparison depend on that function
 * being idempotent for ever. Today it is: `clip` cuts to exactly the limit
 * before appending its marker, so clipping twice gives the same 2,011
 * characters as clipping once (measured). That is a property nothing asserts
 * and nobody would think to preserve, and if it ever stopped holding the
 * back-reference would disappear silently from every finding whose fields were
 * long enough to be cut. Hashing what was stored costs nothing and does not
 * care.
 */
function stored(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * ============================================================================
 * THE WAY BACK: THE CASE NAMES THE CODE IT CAME FROM
 * ============================================================================
 *
 * J0.1 shipped with a hole it named itself: the promoted alert carries the
 * scanned target in `extensions`, but `snapshot.ts` resolves `repository` from
 * the service inventory BY HOSTNAME — and this alert deliberately has none. So
 * the incident card, which for an ordinary alert says which code runs on the
 * machine, said nothing at all about the case whose whole origin is a piece of
 * code. This function is the missing read.
 *
 * IT LIVES BESIDE THE WRITER ON PURPOSE. `cases.ts` reads named fields inside
 * named nodes, and three of those names were wrong for their whole life
 * because the reader and the fixtures were written from the same memory as
 * each other rather than from the code that produces the value. `extensions.
 * vulnpipe` is written twenty lines below; reading it back anywhere else would
 * be the same bet all over again. The test runs a promotion through the REAL
 * workflows and hands the result to the REAL `buildCases`.
 *
 * ----------------------------------------------------------------------------
 * WHY THE ALERT ID IS RECOMPUTED, AND WHAT THAT IS WORTH
 *
 * `extensions` is an open bag: the contract keeps every unmapped vendor field
 * there, whole, so ANY source can put a `vulnpipe` key in it. Left unchecked,
 * a log source — a SIEM enriching its alerts with scanner output, most
 * plausibly, by accident rather than by malice — would decide what the card
 * calls "the code this case is about" and what the Code tab's launcher is
 * pre-filled with. Sending somebody to read the wrong code while an incident
 * is open is the exact failure J0.3 refuses exact matching in order to avoid.
 *
 * So the bag has to prove it came out of `findingToAlert`: the alert id is
 * DERIVED from the scan run and the four identity fields, and all five of
 * those travel in the bag, so the digest can be recomputed and compared. An
 * accidental `vulnpipe` key does not survive it.
 *
 * BE CLEAR ABOUT WHAT IT IS NOT. There is no secret in that digest — anyone
 * who reads this file can compute one — so it is a CONSISTENCY check, not an
 * authentication: it proves the bag and the id tell the same story, not that
 * we wrote either. And `target` is outside the digest (it is not part of the
 * flaw's identity, and putting it in would make one flaw two cases when the
 * same repository is typed two ways), so a bag that keeps a real identity and
 * swaps the target still passes. What bounds the cost of all of it is the rule
 * J0.3 already lives by: this RESOLVES, it never acts. The jump fills a form
 * in; a human still presses Launch.
 */

export function scanRepository(
  kase: { alert_id: string; extensions: Record<string, unknown> | null },
): CaseRepository | null {
  const bag = kase.extensions?.vulnpipe;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return null;
  const v = bag as Record<string, unknown>;

  const scanRunId = stored(v.scan_run_id);
  const target = stored(v.target);
  const vulnerability = stored(v.vulnerability);
  const httpMethod = stored(v.http_method);
  const route = stored(v.route);
  const file = stored(v.file);
  if (!scanRunId || !target || !vulnerability || !httpMethod || !route || !file) return null;

  const expected = findingAlertId(scanRunId, {
    vulnerability, http_method: httpMethod, route, file,
  });
  if (expected !== kase.alert_id) return null;

  return {
    // THE GATE KNOWS NO NAMES. A scan reports a target; it never reports what
    // a team calls that code, so this function has nothing to put here.
    //
    // What this comment used to say is that the INVENTORY could not name it
    // either — *« it is keyed on machines, which this alert has none of »* —
    // and that is true of the inventory's INDEX and false of its DATA: every
    // entry stores a repository, so the table reads the other way round with
    // no observable at all. `declaredService` is that reading and
    // `repositoryOf` in `snapshot.ts` — the one funnel every case passes
    // through, live or sample — is where it is asked, because *which code*
    // and *what it is called* are two facts with two origins and this one is
    // the integrity gate. Repeating the target here would still be one fact
    // dressed as two, which is why the funnel answers and not this.
    service: null,
    repository: target,
    matched_on: 'scan_target',
    matched_value: scanRunId,
  };
}

/** What the browser may send. Every field is re-checked; none is trusted. */
export interface PromoteBody {
  scan_run_id?: unknown;
  target?: unknown;
  finding?: unknown;
}

export type PromoteOutcome =
  | { ok: true; alert: Record<string, unknown>; alert_id: string }
  | { ok: false; errors: string[] };

/** Longest assembled `raw_log`. */
const RAW_LOG_MAX = 12_000;
/** Longest code excerpt rendered into the evidence block. */
const EXCERPT_MAX_LINES = 40;

/** A non-empty string, or `null`. Never a coerced number or object. */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : clip(v, FIELD_MAX);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The evidence block, rendered as the alert's `raw_log`.
 *
 * `raw_log` is what the decision is made ON — for a log source it is the line,
 * and for a finding it is everything the scan concluded and the code it
 * concluded it from. Assembling it here rather than shipping the finding's
 * fields one per extension key is deliberate: the model reads `raw_log`, and a
 * flaw explained across nine keys it has to reassemble is a flaw explained
 * worse. The structured copy still travels, whole, in `extensions`.
 */
function evidenceBlock(f: Record<string, unknown>, where: string): string {
  const lines: string[] = [`VulnPipe finding — ${where}`];

  const verdict = str(f.claude_verdict);
  const evidence = str(f.evidence);
  if (verdict) {
    lines.push(`Arbiter verdict: ${verdict}${evidence ? ` (arbitrated on: ${evidence})` : ''}`);
  }
  const confidence = num(f.local_confidence_score);
  if (confidence !== null) lines.push(`Local confidence: ${confidence}`);
  const detectedBy = Array.isArray(f.detected_by)
    ? f.detected_by.filter((d): d is string => typeof d === 'string')
    : [];
  if (detectedBy.length > 0) lines.push(`Detected by: ${detectedBy.join(', ')}`);
  const owasp = str(f.owasp_category);
  if (owasp) lines.push(`OWASP category: ${owasp}`);

  const sections: Array<[string, string | null]> = [
    ['What it is', str(f.plain_language_summary)],
    ['Technical summary', str(f.technical_summary)],
    ['Why the arbiter said so', str(f.claude_reasoning)],
    ['Direction for a fix', str(f.suggested_fix_direction)],
  ];
  for (const [label, body] of sections) {
    // Absent stays absent. An empty heading would read as "nothing to say
    // about this", which is a claim the scan never made.
    if (body) lines.push('', `${label}: ${body}`);
  }

  const excerpt = f.code_excerpt;
  if (excerpt && typeof excerpt === 'object') {
    const e = excerpt as Record<string, unknown>;
    const rows = Array.isArray(e.lines)
      ? e.lines.filter((l): l is string => typeof l === 'string').slice(0, EXCERPT_MAX_LINES)
      : [];
    const start = num(e.start_line);
    const highlight = num(e.highlight_line);
    if (rows.length > 0) {
      lines.push('', 'Code:');
      rows.forEach((row, i) => {
        const no = start === null ? null : start + i;
        const mark = no !== null && no === highlight ? '>' : ' ';
        lines.push(`${mark} ${no ?? '?'} | ${row}`);
      });
      if (e.truncated === true) lines.push('  … (excerpt truncated by the scanner)');
    }
  }

  return clip(lines.join('\n'), RAW_LOG_MAX);
}

/**
 * A finding to the canonical alert shape, or the list of what is wrong with it.
 *
 * TYPES ARE CHECKED, NOT ONLY MEANING. `normalizeRuleInput` is in this codebase
 * because an API that trusted the shape of its body answered six different 500s
 * carrying an internal message: the caller learned something broke, never that
 * THEY had sent something wrong. This body comes from our own browser today and
 * from whatever posts to the route tomorrow.
 *
 * It returns a payload for `01-Ingestion` to validate — it does not pre-empt
 * that validation. `validateAlertSchema` is the one place an alert is judged,
 * and a second, kinder judgment here would be a second thing to keep in step.
 */
export function findingToAlert(body: PromoteBody, now: Date): PromoteOutcome {
  const errors: string[] = [];

  const scanRunId = str(body.scan_run_id);
  if (!scanRunId) errors.push('scan_run_id: a non-empty string is required');

  const raw = body.finding;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [...errors, 'finding: an object is required'] };
  }
  const f = raw as Record<string, unknown>;

  const vulnerability = str(f.vulnerability);
  const httpMethod = str(f.http_method);
  const route = str(f.route);
  const file = str(f.file);
  for (const [name, value] of [
    ['vulnerability', vulnerability], ['http_method', httpMethod],
    ['route', route], ['file', file],
  ] as const) {
    if (!value) errors.push(`finding.${name}: a non-empty string is required`);
  }

  const severity = alertSeverity(f.severity);
  if (severity === null) {
    errors.push(
      `finding.severity: expected one of ${FINDING_SEVERITIES.join('|')}, `
      + `got ${JSON.stringify(f.severity)}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const identity: FindingIdentity = {
    vulnerability: vulnerability!, http_method: httpMethod!, route: route!, file: file!,
  };
  const line = num(f.line);
  const where = `${vulnerability} in ${httpMethod} ${route}`;
  const alertId = findingAlertId(scanRunId!, identity);

  return {
    ok: true,
    alert_id: alertId,
    alert: {
      alert_id: alertId,
      // Repository and model text, in a FENCED field. `rule_name` is what the
      // queue shows as the headline, so it is the finding's own words rather
      // than a generic "code vulnerability" — the operator has to recognise
      // which flaw this is without opening the card.
      rule_name: clip(where, FIELD_MAX),
      severity,
      // The finding carries no time of its own: a flaw has no moment, only the
      // scan that found it and the decision to triage it. This is the second,
      // and saying so is more honest than back-dating it to the scan.
      timestamp: now.toISOString(),
      raw_log: evidenceBlock(f, where),

      // OBSERVABLES. `file_path` is the only one a finding actually carries.
      // Nothing else is invented — see this file's header on `host`, and note
      // that `route` is NOT a `url`: a Lookup jump on `/orders/:id` would ask
      // a threat-intel provider about a path on our own service.
      file_path: line === null ? file : `${file}:${line}`,

      // Everything the scan concluded, whole, in the field the contract keeps
      // for exactly that — and one the fence covers.
      extensions: {
        vulnpipe: {
          scan_run_id: scanRunId,
          target: str(body.target),
          vulnerability, http_method: httpMethod, route, file, line,
          severity_reported: str(f.severity),
          report_level: str(f.report_level),
          owasp_category: str(f.owasp_category),
          claude_verdict: str(f.claude_verdict),
          claude_reasoning: str(f.claude_reasoning),
          technical_summary: str(f.technical_summary),
          plain_language_summary: str(f.plain_language_summary),
          suggested_fix_direction: str(f.suggested_fix_direction),
          evidence: str(f.evidence),
          local_confidence_score: num(f.local_confidence_score),
          detected_by: Array.isArray(f.detected_by)
            ? f.detected_by.filter((d): d is string => typeof d === 'string')
            : [],
        },
      },
    },
  };
}
