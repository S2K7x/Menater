/**
 * Tuning rules — how a team teaches its own SOC what is normal here.
 *
 * ============================================================================
 * THE SAFETY BOUNDARY, FIRST, BECAUSE EVERYTHING ELSE DEPENDS ON IT
 *
 * A tuning rule can only ever make the pipeline MORE cautious, or close an
 * alert as benign with a full audit record. It can NEVER cause an action.
 * There is no rule action that isolates a host, and there cannot be one: the
 * action catalogue is closed, and a text field an operator types into is the
 * last place from which a machine should be cut off the network.
 *
 * The four actions:
 *
 *   allow     — known-good. The alert is CLOSED with a reason and an audit
 *               row, never dropped: a suppressed alert nobody can find
 *               afterwards is indistinguishable from one never received.
 *   suppress  — the same, but time-bounded. Requires an expiry. For a signal
 *               that is real and merely repetitive.
 *   severity  — raises or lowers severity. 03 still decides, under the same
 *               guardrails; this cannot create an action either way.
 *   escalate  — forces the alert to a human. Strictly more cautious.
 *
 * ============================================================================
 * WHY EVERY RULE CARRIES AN OWNER, A REASON AND AN EXPIRY
 *
 * An exception with no owner and no end date is not a tuning decision, it is
 * security debt: nobody remembers why the pipeline stopped looking at
 * something, so nobody dares remove it, so it stays forever. Those fields are
 * required by the type, not by a convention someone can skip.
 *
 * ============================================================================
 * WHY A RULE IS A CONJUNCTION AND NOT A FIELD
 *
 * "Ignore this IP" and "ignore this user" are the exclusions that get abused:
 * attackers use legitimate tools and privileged identities, so a blanket allow
 * on either is a hole shaped exactly like a real intrusion. A rule is a LIST
 * of conditions, all of which must hold — the scanner's address AND the rule
 * it triggers. The templates are written that way on purpose, and
 * `validateRule` refuses the single-identity case outright.
 * ============================================================================
 */

import { SEVERITIES, type Severity } from './domain.ts';

export const RULE_ACTIONS = ['allow', 'suppress', 'severity', 'escalate'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const OPERATORS = [
  'equals', 'not_equals', 'contains', 'starts_with', 'ends_with',
  'regex', 'cidr', 'in_list', 'exists', 'not_exists',
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  /**
   * A canonical alert field, or `extensions.<path>` for a vendor field the
   * mapping had no column for. Dotted paths are READ, never evaluated.
   */
  field: string;
  op: Operator;
  /** Compared as OR: any value matching satisfies the condition. */
  values: string[];
}

export interface TuningRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Lower runs first. Ties break on id, so ordering is never ambiguous. */
  priority: number;
  /** ALL must hold. See the header: the single-field rule is the dangerous one. */
  conditions: Condition[];
  action: RuleAction;
  /** Target severity, for `action: 'severity'`. */
  severity: Severity | null;
  // --- Governance. Not optional, and not decorative. ---
  owner: string;
  reason: string;
  /** ISO date. Required for `suppress`. */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuleOutcome {
  /** The rule that matched, or `null` when none did. */
  rule: TuningRule | null;
  action: RuleAction | null;
  /** Severity after the rule; unchanged when no rule touched it. */
  severity: Severity;
  /** Written to the audit row, in the operator's own words. */
  note: string | null;
  /** Rules skipped because they had expired, so the UI can say so. */
  expired: string[];
}

// --- Field access ---------------------------------------------------------------

/** Forbidden segments — a rule is data and must not reach the prototype. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function readField(alert: unknown, path: string): unknown {
  let current: unknown = alert;
  for (const segment of path.split('.')) {
    if (segment === '' || FORBIDDEN.has(segment)) return undefined;
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current as object, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// --- CIDR ------------------------------------------------------------------------

/** IPv4 or IPv6 to a BigInt, or `null` when it is not an address at all. */
export function ipToBigInt(raw: string): { value: bigint; bits: number } | null {
  const ip = raw.trim();

  if (ip.includes(':')) {
    // IPv6, including the `::` run-length form.
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const split = (part: string) => (part === '' ? [] : part.split(':'));

    let groups: string[];
    if (halves.length === 2) {
      const left = split(halves[0]!);
      const right = split(halves[1]!);
      const fill = 8 - left.length - right.length;
      if (fill < 0) return null;
      groups = [...left, ...Array<string>(fill).fill('0'), ...right];
    } else {
      groups = split(halves[0]!);
    }
    if (groups.length !== 8) return null;

    let value = 0n;
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      value = (value << 16n) | BigInt(parseInt(g, 16));
    }
    return { value, bits: 128 };
  }

  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return { value, bits: 32 };
}

/**
 * Is `ip` inside `cidr`?
 *
 * A bare address counts as a /32 or /128, so `10.0.0.7` and `10.0.0.0/24` are
 * both valid values for this operator — an operator should not have to know
 * which of the two forms the field wants.
 */
export function inCidr(ip: string, cidr: string): boolean {
  const [net, prefixRaw] = cidr.trim().split('/');
  const a = ipToBigInt(ip);
  const b = ipToBigInt(net ?? '');
  if (!a || !b || a.bits !== b.bits) return false;

  const prefix = prefixRaw === undefined ? a.bits : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return false;

  const shift = BigInt(a.bits - prefix);
  return (a.value >> shift) === (b.value >> shift);
}

// --- Matching --------------------------------------------------------------------

/**
 * Bounds on a user-supplied pattern.
 *
 * A regular expression typed into a form and run on every alert is a denial of
 * service waiting to happen — catastrophic backtracking needs no malice, only
 * a nested quantifier. JavaScript cannot interrupt a running regex, so the
 * only defence available here is to keep both the pattern and the subject
 * small enough that even a pathological pattern terminates.
 */
export const MAX_PATTERN = 200;
export const MAX_SUBJECT = 2000;

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function matchesCondition(alert: unknown, condition: Condition): boolean {
  const raw = readField(alert, condition.field);

  if (condition.op === 'exists') return raw !== undefined && raw !== null && raw !== '';
  if (condition.op === 'not_exists') return raw === undefined || raw === null || raw === '';

  const subject = textOf(raw);
  // ABSENT NEVER MATCHES, apart from `not_exists` above. An alert that does not
  // carry the field is not evidence about it: reading a missing `source_ip` as
  // "not in the allowlist, therefore suspicious", or as "empty, therefore
  // equal to empty", are both ways of inventing data.
  if (subject === null) return false;

  const hay = subject.slice(0, MAX_SUBJECT);
  const lower = hay.toLowerCase();
  const values = (condition.values ?? []).filter((v) => v.trim() !== '');

  switch (condition.op) {
    case 'equals':
    case 'in_list':
      return values.some((v) => lower === v.trim().toLowerCase());
    case 'not_equals':
      return values.every((v) => lower !== v.trim().toLowerCase());
    case 'contains':
      return values.some((v) => lower.includes(v.trim().toLowerCase()));
    case 'starts_with':
      return values.some((v) => lower.startsWith(v.trim().toLowerCase()));
    case 'ends_with':
      return values.some((v) => lower.endsWith(v.trim().toLowerCase()));
    case 'cidr':
      return values.some((v) => inCidr(hay, v));
    case 'regex':
      return values.some((v) => {
        if (v.length > MAX_PATTERN) return false;
        try {
          return new RegExp(v, 'i').test(hay);
        } catch {
          // An invalid pattern matches NOTHING. Treating it as "always true"
          // would silently allow everything the rule names.
          return false;
        }
      });
    default:
      return false;
  }
}

/** A rule matches when every one of its conditions does. */
export function matchesRule(alert: unknown, rule: TuningRule): boolean {
  // A rule with no conditions would match EVERYTHING. That is never what
  // anyone means, and as an `allow` it would silence the whole pipeline.
  if (!rule.conditions || rule.conditions.length === 0) return false;
  return rule.conditions.every((cond) => matchesCondition(alert, cond));
}

export const isExpired = (rule: TuningRule, now: Date): boolean =>
  rule.expires_at !== null && Date.parse(rule.expires_at) <= now.getTime();

/**
 * Applies the rule set to one alert.
 *
 * ORDERED, FIRST MATCH WINS. Platforms differ here — some evaluate every rule
 * as a set — but a SOC operator has to be able to answer "why was this alert
 * closed?" with ONE rule name. A set-based engine answers with a combination,
 * and that answer changes when an unrelated rule is added later.
 */
export function evaluateRules(
  alert: unknown,
  rules: TuningRule[],
  now: () => Date = () => new Date(),
): RuleOutcome {
  const at = now();
  const severity = (readField(alert, 'severity') as Severity) ?? 'medium';
  const expired: string[] = [];

  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (isExpired(rule, at)) {
      // NAMED, not silently skipped. An expired exception that stops working
      // without saying so looks exactly like one that never worked.
      expired.push(rule.name);
      continue;
    }
    if (!matchesRule(alert, rule)) continue;

    const note = `"${rule.name}" — ${rule.reason} (${rule.owner})`;
    if (rule.action === 'severity') {
      const target = rule.severity && SEVERITIES.includes(rule.severity) ? rule.severity : severity;
      return { rule, action: 'severity', severity: target, note, expired };
    }
    return { rule, action: rule.action, severity, note, expired };
  }

  return { rule: null, action: null, severity, note: null, expired };
}

// --- Validation ------------------------------------------------------------------

export interface RuleProblem {
  field: string;
  detail: string;
}

/** Bounds. A rule is stored, listed and evaluated on every alert. */
export const MAX_NAME = 200;
export const MAX_TEXT = 2000;
export const MAX_CONDITIONS = 25;
export const MAX_VALUES = 200;

const text = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).trim().slice(0, max);

/**
 * Turns an arbitrary JSON body into a rule of the right SHAPE, or says why not.
 *
 * ============================================================================
 * WHY THIS EXISTS SEPARATELY FROM `validateRule`
 *
 * `validateRule` answers "is this rule a good idea" — it assumes the fields are
 * the types they claim to be. Nothing did the assuming, so a body with
 * `conditions: "nope"` reached `conditions.entries()` and crashed, and one with
 * `priority: "high"` sailed past validation into Postgres, which answered
 * `invalid input syntax for type integer`. Both surfaced as a 500 carrying an
 * internal error message: the caller learned that something broke, never that
 * THEY had sent something wrong.
 *
 * So this runs FIRST, and everything downstream — validation and SQL alike —
 * receives a value it can trust.
 *
 * Defaults here are fail-safe in the same direction as everywhere else:
 * `enabled` defaults to FALSE. A rule that arrives without saying whether it is
 * on must not turn itself on.
 * ============================================================================
 */
export function normalizeRuleInput(
  input: unknown,
): { rule: Omit<TuningRule, 'id' | 'created_at' | 'updated_at'>; problems: RuleProblem[] } {
  const body = (input ?? {}) as Record<string, unknown>;
  const problems: RuleProblem[] = [];

  // --- priority ---
  let priority = 100;
  if (body.priority !== undefined && body.priority !== null && body.priority !== '') {
    const n = Number(body.priority);
    if (!Number.isFinite(n)) {
      problems.push({ field: 'priority', detail: 'Priority must be a number.' });
    } else {
      priority = Math.min(10_000, Math.max(0, Math.trunc(n)));
    }
  }

  // --- expiry ---
  let expires: string | null = null;
  const rawExpiry = body.expires_at;
  if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
    const ms = Date.parse(String(rawExpiry));
    if (Number.isNaN(ms)) {
      problems.push({ field: 'expires_at', detail: `"${String(rawExpiry).slice(0, 60)}" is not a date.` });
    } else {
      expires = new Date(ms).toISOString();
    }
  }

  // --- conditions ---
  const conditions: Condition[] = [];
  const rawConditions = body.conditions;
  if (rawConditions !== undefined && !Array.isArray(rawConditions)) {
    problems.push({ field: 'conditions', detail: 'Conditions must be a list.' });
  } else if (Array.isArray(rawConditions)) {
    if (rawConditions.length > MAX_CONDITIONS) {
      problems.push({ field: 'conditions', detail: `At most ${MAX_CONDITIONS} conditions.` });
    }
    for (const [i, raw] of rawConditions.slice(0, MAX_CONDITIONS).entries()) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        problems.push({ field: `conditions.${i}`, detail: 'A condition must be an object.' });
        continue;
      }
      const c = raw as Record<string, unknown>;
      const values = Array.isArray(c.values)
        ? c.values.slice(0, MAX_VALUES).map((v) => text(v, MAX_TEXT))
        : c.values === undefined || c.values === null
          ? []
          // A single value where a list was expected is a shape mistake, not a
          // reason to refuse: accept it as a one-element list and move on.
          : [text(c.values, MAX_TEXT)];
      conditions.push({ field: text(c.field, MAX_NAME), op: c.op as Operator, values });
    }
  }

  const action = body.action as RuleAction;
  const severity = SEVERITIES.includes(body.severity as Severity) ? (body.severity as Severity) : null;

  return {
    rule: {
      name: text(body.name, MAX_NAME),
      // FAIL-SAFE. A rule that does not say whether it is on is off.
      enabled: body.enabled === true,
      priority,
      conditions,
      action,
      severity,
      owner: text(body.owner, MAX_NAME),
      reason: text(body.reason, MAX_TEXT),
      expires_at: expires,
    },
    problems,
  };
}

/** Fields that identify WHO or WHAT, rather than what happened. */
const IDENTITY_FIELDS = ['source_ip', 'dest_ip', 'user', 'host'];

/**
 * Refuses a rule that would be a hole rather than a tuning.
 *
 * These are not style checks. Each corresponds to an exception shape that is
 * known to go wrong: a blanket allow on a single identity, an exception nobody
 * owns, a suppression with no end.
 */
export function validateRule(rule: Partial<TuningRule>): RuleProblem[] {
  const problems: RuleProblem[] = [];
  // Defensive even though `normalizeRuleInput` runs first: this function is
  // exported, and a caller that skipped normalization must get a verdict
  // rather than a crash.
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];

  if (!rule.name || rule.name.trim() === '') {
    problems.push({ field: 'name', detail: 'A rule needs a name: it is what the audit row will cite.' });
  }
  if (!rule.owner || rule.owner.trim() === '') {
    problems.push({ field: 'owner', detail: 'An exception with no owner is one nobody dares remove later.' });
  }
  if (!rule.reason || rule.reason.trim() === '') {
    problems.push({ field: 'reason', detail: 'Say why. In six months this is the only thing that will justify it.' });
  }
  if (conditions.length === 0) {
    problems.push({
      field: 'conditions',
      detail: 'A rule with no condition matches every alert. Name what makes this activity expected.',
    });
  }

  for (const [i, cond] of conditions.entries()) {
    if (cond === null || typeof cond !== 'object') {
      problems.push({ field: `conditions.${i}`, detail: 'A condition must be an object.' });
      continue;
    }
    if (!cond.field || cond.field.trim() === '') {
      problems.push({ field: `conditions.${i}.field`, detail: 'Which field?' });
    }
    if (!OPERATORS.includes(cond.op)) {
      problems.push({ field: `conditions.${i}.op`, detail: `Unknown operator "${cond.op}".` });
      continue;
    }
    const values = Array.isArray(cond.values) ? cond.values : [];
    const needsValues = cond.op !== 'exists' && cond.op !== 'not_exists';
    if (needsValues && values.filter((v) => typeof v === 'string' && v.trim() !== '').length === 0) {
      problems.push({ field: `conditions.${i}.values`, detail: 'This operator needs at least one value.' });
    }
    if (cond.op === 'regex') {
      for (const v of values) {
        if (v.length > MAX_PATTERN) {
          problems.push({
            field: `conditions.${i}.values`,
            detail: `A pattern over ${MAX_PATTERN} characters is refused: it runs on every alert.`,
          });
        } else {
          try {
            new RegExp(v);
          } catch {
            problems.push({ field: `conditions.${i}.values`, detail: `"${v}" is not a valid regular expression.` });
          }
        }
      }
    }
    if (cond.op === 'cidr') {
      for (const v of values.filter((x) => typeof x === 'string' && x.trim() !== '')) {
        if (!ipToBigInt(v.split('/')[0] ?? '')) {
          problems.push({ field: `conditions.${i}.values`, detail: `"${v}" is not an address or a CIDR range.` });
        }
      }
    }
  }

  if (rule.action && !RULE_ACTIONS.includes(rule.action)) {
    problems.push({ field: 'action', detail: `Unknown action "${rule.action}".` });
  }
  if (rule.action === 'suppress' && !rule.expires_at) {
    // Straight from the distinction that makes suppression safe: it is
    // temporary BY DEFINITION. One with no end is an `allow` that has not
    // admitted what it is.
    problems.push({
      field: 'expires_at',
      detail: 'A suppression is temporary by definition. Give it an end date, or use "allow".',
    });
  }
  if (rule.action === 'severity' && !SEVERITIES.includes(rule.severity as Severity)) {
    problems.push({ field: 'severity', detail: `Pick one of: ${SEVERITIES.join(', ')}.` });
  }

  // The classic hole: a permanent allow keyed on one identity.
  if (rule.action === 'allow' && conditions.length === 1 && IDENTITY_FIELDS.includes(conditions[0]!.field)) {
    problems.push({
      field: 'conditions',
      detail:
        `A permanent allow on "${conditions[0]!.field}" alone silences every alert about it, `
        + 'whatever happens next. Attackers use legitimate addresses and accounts. Add a second '
        + 'condition — the rule name, the activity — or use "suppress" with an end date.',
    });
  }

  return problems;
}
