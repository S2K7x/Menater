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
