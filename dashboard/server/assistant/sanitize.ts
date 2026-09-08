/**
 * Fencing untrusted text before a model reads it.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL
 *
 * A security log is a record of an adversarial interaction. The URI, the user
 * agent, the attempted username, the process command line and the vendor rule
 * name were all chosen by someone else BEFORE the defender stored them. Handing
 * that text to a model as if it were part of our own prompt is how an attacker
 * writes instructions the assistant then follows — measured at an 87% success
 * rate against LLM-augmented SOCs when log content reaches the context
 * unmarked (arXiv 2605.24421, "Poisoning the Watchtower").
 *
 * The console's answer is layered, and this file is only the second layer:
 *
 *   1. THE ASSISTANT CAN DO NOTHING. Its tool catalogue is read-only and
 *      closed (`tools.ts`). An instruction that lands has nothing to press.
 *   2. UNTRUSTED TEXT IS LABELLED AS DATA, here. It travels inside a fence
 *      carrying a per-request nonce, and the system prompt declares that
 *      whatever sits inside a fence is evidence to describe, never a request.
 *   3. IT IS BOUNDED. Truncated, control characters stripped, so a 40 kB
 *      `raw_log` cannot push the actual question out of the context window —
 *      the cheapest injection there is.
 *
 * WHAT THIS IS NOT
 *
 * It is not a filter, and it deliberately removes no words. A pattern-based
 * scrubber that deletes "ignore previous instructions" hands the operator an
 * ALTERED log plus a false sense of safety, and it catches none of the
 * obfuscated payloads. Rewriting evidence is the same mistake as filling a gap
 * with a default: the analyst has to see what was actually logged.
 * ============================================================================
 */

import { randomBytes } from 'node:crypto';

/**
 * Beyond this, a single field is evidence nobody reads inside a chat answer,
 * and it is context budget taken from the conversation. The truncation SAYS
 * SO — a silently cut log would have the assistant reason about half a line
 * while sounding just as certain.
 */
const MAX_FIELD_CHARS = 2_000;

/**
 * Opening and closing markers, carrying a nonce generated per request.
 *
 * A fixed marker is one an attacker can write into a log themselves, closing
 * our fence early and continuing outside it. The nonce did not exist when the
 * log was written, so the fence cannot be forged.
 */
export interface Fence {
  nonce: string;
  open: (label: string) => string;
  close: string;
}

export function newFence(): Fence {
  const nonce = randomBytes(9).toString('base64url');
  return {
    nonce,
    open: (label: string) => `<untrusted:${nonce} field="${label}">`,
    close: `</untrusted:${nonce}>`,
  };
}

/**
 * Control characters, minus the three that carry meaning in a log.
 *
 * Tab, newline and carriage return stay: a log stripped of its line breaks is
 * unreadable, and unreadable evidence is evidence an analyst cannot check the
 * answer against. The rest go, because a `\r`-less escape sequence or a
 * bidirectional override is the classic way to make a line RENDER as though it
 * came from the system rather than from the log.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function scrub(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const clean = text.replace(CONTROL_CHARS, '');
  if (clean.length <= MAX_FIELD_CHARS) return clean;
  const dropped = clean.length - MAX_FIELD_CHARS;
  return `${clean.slice(0, MAX_FIELD_CHARS)}\n[truncated: ${dropped} more characters]`;
}

/**
 * One untrusted value, fenced and named.
 *
 * `null` stays `null` and is NOT turned into an empty fence: an absent
 * observable has to read as absent, never as "present and empty". That is the
 * rule the ingestion contract already enforces on `source_ip` and `host`, and
 * it matters more here — a model shown `""` will describe a blank value as if
 * the field had been observed.
 */
export function fenced(fence: Fence, label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${fence.open(label)}\n${scrub(value)}\n${fence.close}`;
}

/**
 * Fences every field named in `labels`, returning a new object.
 *
 * Fields not named are left untouched — they are OURS: identifiers, verdicts,
 * timestamps, confidences, booleans the pipeline itself produced. Fencing them
 * too would drown the signal: if everything is marked untrusted, nothing is.
 */
export function fenceFields<T extends Record<string, unknown>>(
  fence: Fence,
  value: T,
  labels: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const label of labels) {
    if (!(label in out)) continue;
    out[label] = fenced(fence, label, out[label]);
  }
  return out;
}

/**
 * The fields of an alert written, wholly or partly, by whoever caused it.
 *
 * `rule_name` being on this list surprises people: it is the DETECTION's name,
 * so it comes from a vendor rule set — a file an operator edits, an
 * integration imports, and an attacker who reached the SIEM can rename.
 *
 * `reasoning` is on it for a different reason: it is the triage model's own
 * prose, produced from the raw log. Text derived from untrusted text is
 * untrusted text.
 */
export const UNTRUSTED_ALERT_FIELDS = [
  'raw_log',
  'rule_name',
  'process',
  'file_path',
  'url',
  'user',
  'extensions',
  'reasoning',
] as const;

/**
 * The only two fields of an enrichment source the CONSOLE writes.
 *
 * `status` is one of four words we chose (`ok` / `skipped` / `unavailable` /
 * `absent`) and `source` comes from the closed table in `MAPPERS`. Everything
 * else in the bag was written by a third party, about a value an attacker
 * chose.
 */
const OUR_SOURCE_FIELDS = new Set(['status', 'source']);

/**
 * Beyond this, a provider is nesting deeper than any field we map, and the
 * value is fenced whole rather than walked. Recursing without a floor over
 * JSON somebody else composed is the denial of service that comes free with
 * every parser.
 */
const MAX_ENRICHMENT_DEPTH = 4;

function fenceValue(fence: Fence, label: string, value: unknown, depth: number): unknown {
  // Numbers and booleans carry no instruction, and fencing them would cost the
  // model the ability to reason about a score as a score. `if everything is
  // marked untrusted, nothing is` — the rule `fenceFields` states above.
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') return fenced(fence, label, value);
  if (depth >= MAX_ENRICHMENT_DEPTH) return fenced(fence, label, value);
  if (Array.isArray(value)) return value.map((v) => fenceValue(fence, label, v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = fenceValue(fence, `${label}.${k}`, v, depth + 1);
    }
    return out;
  }
  return fenced(fence, label, value);
}

/**
 * Fences what the three enrichment sources brought back.
 *
 * ============================================================================
 * WHY THIS IS NOT A LIST OF FIELD NAMES
 *
 * `UNTRUSTED_ALERT_FIELDS` above can be a list because an alert has a contract:
 * `domain.ts` names its fields. An enrichment source has none — `EnrichmentSource`
 * is `{ status, source, [key: string]: unknown }`, an open bag whose contents
 * are whatever `MAPPERS` picked out of that provider's JSON. A list of names
 * here would go stale the day a mapper gains a field or a fourth source is
 * added, and it would go stale SILENTLY: the new field would simply travel in
 * the clear. This repository has already paid for a list of exact names once,
 * in `isDataAccess()`.
 *
 * So the rule is inverted. Everything is fenced EXCEPT the two fields whose
 * vocabulary is ours and closed, and the numbers and booleans, which cannot
 * carry an instruction.
 *
 * WHAT THIS TEXT ACTUALLY IS
 *
 * It reads like reference data and it is not. Shodan's `hostnames` is the
 * reverse DNS of the address that attacked us — a PTR record its owner sets.
 * `org` and `isp` come from WHOIS on the same address. VirusTotal's
 * `meaningful_name` is the file name whoever submitted the sample chose, and
 * `popular_threat_label` is derived from engine detection names for it. A
 * `reason` on a failed lookup is `clip(e.message)` — the provider's own error
 * prose, forwarded.
 *
 * None of it is a log, so none of it was covered by the fence; all of it is
 * text an attacker can influence and get read back to a model, which is the
 * exact channel this file exists to close.
 * ============================================================================
 */
export function fenceEnrichment(fence: Fence, enrichment: unknown): unknown {
  if (!enrichment || typeof enrichment !== 'object') return enrichment;
  const out: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(enrichment as Record<string, unknown>)) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      out[name] = fenceValue(fence, `enrichment.${name}`, source, 1);
      continue;
    }
    const bag: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      bag[k] = OUR_SOURCE_FIELDS.has(k) ? v : fenceValue(fence, `enrichment.${name}.${k}`, v, 1);
    }
    out[name] = bag;
  }
  return out;
}
