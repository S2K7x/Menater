/**
 * Tuning rules.
 *
 * The tests that matter here are the refusals. A matcher that matches is easy;
 * one that declines to match an absent field, declines to run an unbounded
 * pattern, and declines to accept a blanket allow is the difference between
 * tuning a SOC and putting a hole in it.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateRules, inCidr, ipToBigInt, matchesCondition, matchesRule,
  normalizeRuleInput, validateRule, type TuningRule,
} from './tuning.ts';
import { RULE_TEMPLATES, ruleFromTemplate } from './tuning-templates.ts';

const NOW = () => new Date('2026-08-26T12:00:00Z');

const alert = (over: Record<string, unknown> = {}) => ({
  alert_id: 'A-1',
  rule_name: 'sshd: port scan detected',
  severity: 'high',
  timestamp: '2026-08-26T11:59:00Z',
  raw_log: 'nmap scan from 10.0.0.9 sha256 abc123',
  source_ip: '10.0.0.9',
  dest_ip: null,
  user: null,
  host: 'web-prod-01',
  process: null,
  file_path: null,
  url: null,
  source: 'wazuh',
  extensions: { location: '/var/log/auth.log', rule: { level: 10 } },
  ...over,
});

const rule = (over: Partial<TuningRule> = {}): TuningRule => ({
  id: 'r1',
  name: 'Test rule',
  enabled: true,
  priority: 100,
  conditions: [{ field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] }],
  action: 'allow',
  severity: null,
  owner: 'shai',
  reason: 'because',
  expires_at: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  ...over,
});

describe('addresses and ranges', () => {
  it('parses IPv4 and IPv6, including the :: form', () => {
    expect(ipToBigInt('10.0.0.1')?.bits).toBe(32);
    expect(ipToBigInt('2001:db8::1')?.bits).toBe(128);
    expect(ipToBigInt('::1')?.bits).toBe(128);
    expect(ipToBigInt('not-an-ip')).toBeNull();
    expect(ipToBigInt('999.1.1.1')).toBeNull();
    expect(ipToBigInt('10.0.0')).toBeNull();
  });

  it('matches inside a range and not outside it', () => {
    expect(inCidr('10.0.0.9', '10.0.0.0/24')).toBe(true);
    expect(inCidr('10.0.1.9', '10.0.0.0/24')).toBe(false);
    expect(inCidr('10.0.1.9', '10.0.0.0/16')).toBe(true);
    expect(inCidr('2001:db8::5', '2001:db8::/32')).toBe(true);
    expect(inCidr('2001:dbf::5', '2001:db8::/32')).toBe(false);
  });

  it('accepts a bare address as a full-length prefix', () => {
    // An operator should not have to know whether the field wants /32.
    expect(inCidr('10.0.0.9', '10.0.0.9')).toBe(true);
    expect(inCidr('10.0.0.8', '10.0.0.9')).toBe(false);
  });

  it('never matches across address families, or on nonsense', () => {
    expect(inCidr('10.0.0.9', '2001:db8::/32')).toBe(false);
    expect(inCidr('10.0.0.9', '10.0.0.0/99')).toBe(false);
    expect(inCidr('', '10.0.0.0/24')).toBe(false);
  });
});

describe('a condition on a field the alert does not carry', () => {
  it('does NOT match — absence is not evidence', () => {
    // Since N1 most observables are optional. Reading a missing `dest_ip` as
    // "not in the allowlist, therefore suspicious" invents data, and so does
    // reading it as equal to the empty string.
    const a = alert({ dest_ip: null });
    expect(matchesCondition(a, { field: 'dest_ip', op: 'equals', values: [''] })).toBe(false);
    expect(matchesCondition(a, { field: 'dest_ip', op: 'cidr', values: ['0.0.0.0/0'] })).toBe(false);
    expect(matchesCondition(a, { field: 'dest_ip', op: 'not_equals', values: ['1.2.3.4'] })).toBe(false);
  });

  it('is what `exists` / `not_exists` are for', () => {
    const a = alert({ dest_ip: null });
    expect(matchesCondition(a, { field: 'dest_ip', op: 'not_exists', values: [] })).toBe(true);
    expect(matchesCondition(a, { field: 'source_ip', op: 'exists', values: [] })).toBe(true);
  });
});

describe('operators', () => {
  const a = alert();
  it('compares case-insensitively', () => {
    expect(matchesCondition(a, { field: 'host', op: 'equals', values: ['WEB-PROD-01'] })).toBe(true);
    expect(matchesCondition(a, { field: 'rule_name', op: 'contains', values: ['PORT SCAN'] })).toBe(true);
  });

  it('reads nested vendor fields through extensions', () => {
    expect(matchesCondition(a, { field: 'extensions.location', op: 'ends_with', values: ['auth.log'] })).toBe(true);
    expect(matchesCondition(a, { field: 'extensions.rule.level', op: 'equals', values: ['10'] })).toBe(true);
  });

  it('refuses to walk into the prototype', () => {
    // A rule is data typed into a form; it must not reach the prototype chain.
    expect(matchesCondition(a, { field: '__proto__.polluted', op: 'exists', values: [] })).toBe(false);
    expect(matchesCondition(a, { field: 'constructor.name', op: 'contains', values: ['Object'] })).toBe(false);
  });

  it('treats an unparseable regex as matching NOTHING', () => {
    // The alternative — "always true" — would silently allow everything the
    // rule names, which is the worst possible failure for an allow rule.
    expect(matchesCondition(a, { field: 'rule_name', op: 'regex', values: ['([unclosed'] })).toBe(false);
  });

  it('refuses an over-long pattern rather than running it', () => {
    const huge = `${'(a+)+'.repeat(60)}$`;
    expect(huge.length).toBeGreaterThan(200);
    expect(matchesCondition(a, { field: 'raw_log', op: 'regex', values: [huge] })).toBe(false);
  });
});

describe('a rule is a conjunction', () => {
  it('needs every condition to hold', () => {
    const r = rule({
      conditions: [
        { field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] },
        { field: 'rule_name', op: 'contains', values: ['port scan'] },
      ],
    });
    expect(matchesRule(alert(), r)).toBe(true);
    // Same scanner, different activity — still an alert. This is the whole
    // reason templates are written as conjunctions.
    expect(matchesRule(alert({ rule_name: 'data exfiltration detected' }), r)).toBe(false);
  });

  it('never matches when it has no conditions at all', () => {
    expect(matchesRule(alert(), rule({ conditions: [] }))).toBe(false);
  });
});

describe('evaluation', () => {
  it('is ordered, and the first match wins', () => {
    const outcome = evaluateRules(alert(), [
      rule({ id: 'b', name: 'second', priority: 20, action: 'escalate' }),
      rule({ id: 'a', name: 'first', priority: 10, action: 'allow' }),
    ], NOW);

    expect(outcome.rule?.name).toBe('first');
    expect(outcome.action).toBe('allow');
  });

  it('breaks ties on id, so ordering is never ambiguous', () => {
    const outcome = evaluateRules(alert(), [
      rule({ id: 'zz', name: 'z', priority: 10 }),
      rule({ id: 'aa', name: 'a', priority: 10 }),
    ], NOW);
    expect(outcome.rule?.name).toBe('a');
  });

  it('skips a disabled rule', () => {
    expect(evaluateRules(alert(), [rule({ enabled: false })], NOW).rule).toBeNull();
  });

  it('skips an expired rule AND names it', () => {
    // An exception that stops working without saying so looks exactly like one
    // that never worked.
    const outcome = evaluateRules(alert(), [
      rule({ name: 'lapsed', expires_at: '2026-08-01T00:00:00Z' }),
    ], NOW);

    expect(outcome.rule).toBeNull();
    expect(outcome.expired).toEqual(['lapsed']);
  });

  it('honours a rule that has not expired yet', () => {
    const outcome = evaluateRules(alert(), [
      rule({ name: 'live', expires_at: '2026-09-01T00:00:00Z' }),
    ], NOW);
    expect(outcome.rule?.name).toBe('live');
  });

  it('carries the reason and the owner into the note', () => {
    // The audit row has to answer "why was this closed?" without the console.
    const outcome = evaluateRules(alert(), [
      rule({ name: 'Scanner', reason: 'authorised weekly scan', owner: 'shai' }),
    ], NOW);
    expect(outcome.note).toContain('Scanner');
    expect(outcome.note).toContain('authorised weekly scan');
    expect(outcome.note).toContain('shai');
  });

  it('changes severity without touching anything else', () => {
    const outcome = evaluateRules(alert(), [
      rule({ action: 'severity', severity: 'low' }),
    ], NOW);
    expect(outcome.severity).toBe('low');
    expect(outcome.action).toBe('severity');
  });

  it('leaves severity alone when no rule matches', () => {
    const outcome = evaluateRules(alert(), [
      rule({ conditions: [{ field: 'host', op: 'equals', values: ['other'] }] }),
    ], NOW);
    expect(outcome.rule).toBeNull();
    expect(outcome.severity).toBe('high');
  });
});

describe('validation refuses the shapes that go wrong', () => {
  it('demands an owner and a reason', () => {
    const problems = validateRule({ ...rule(), owner: '', reason: '' });
    expect(problems.map((p) => p.field)).toEqual(expect.arrayContaining(['owner', 'reason']));
  });

  it('refuses a suppression with no end date', () => {
    // Temporary by definition; one with no end is an allow that has not
    // admitted what it is.
    const problems = validateRule({ ...rule(), action: 'suppress', expires_at: null });
    expect(problems.some((p) => p.field === 'expires_at')).toBe(true);
  });

  it('refuses a permanent allow on a single identity field', () => {
    // The classic hole: attackers use legitimate addresses and accounts.
    const problems = validateRule({
      ...rule(),
      action: 'allow',
      conditions: [{ field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] }],
    });
    expect(problems.some((p) => p.field === 'conditions')).toBe(true);
    expect(problems.find((p) => p.field === 'conditions')?.detail).toMatch(/legitimate addresses/);
  });

  it('accepts that same allow once a second condition scopes it', () => {
    const problems = validateRule({
      ...rule(),
      action: 'allow',
      conditions: [
        { field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] },
        { field: 'rule_name', op: 'contains', values: ['port scan'] },
      ],
    });
    expect(problems).toEqual([]);
  });

  it('refuses a rule with no condition', () => {
    const problems = validateRule({ ...rule(), conditions: [] });
    expect(problems.some((p) => p.field === 'conditions')).toBe(true);
  });

  it('refuses an invalid CIDR and an invalid regex', () => {
    expect(validateRule({
      ...rule(),
      conditions: [{ field: 'source_ip', op: 'cidr', values: ['not-a-range'] }],
    }).some((p) => p.detail.includes('not an address'))).toBe(true);

    expect(validateRule({
      ...rule(),
      action: 'escalate',
      conditions: [{ field: 'raw_log', op: 'regex', values: ['([unclosed'] }],
    }).some((p) => p.detail.includes('valid regular expression'))).toBe(true);
  });
});

describe('templates', () => {
  it('ship disabled, with no owner', () => {
    // A starter pack that silences alerts on install has decided something on
    // the operator's behalf.
    for (const t of RULE_TEMPLATES) {
      const r = ruleFromTemplate(t, NOW);
      expect(r.enabled).toBe(false);
      expect(r.owner).toBe('');
    }
  });

  it('never allows on a single identity condition', () => {
    // The same rule `validateRule` enforces — held by the shipped content too,
    // or the templates would be teaching the mistake.
    for (const t of RULE_TEMPLATES.filter((x) => x.action === 'allow')) {
      const identityOnly = t.conditions.length === 1
        && ['source_ip', 'dest_ip', 'user', 'host'].includes(t.conditions[0]!.field);
      expect(identityOnly, `template ${t.id}`).toBe(false);
    }
  });

  it('gives every suppression an expiry', () => {
    for (const t of RULE_TEMPLATES.filter((x) => x.action === 'suppress')) {
      expect(t.expiresInDays, `template ${t.id}`).not.toBeNull();
      expect(ruleFromTemplate(t, NOW).expires_at).not.toBeNull();
    }
  });

  it('produces rules that pass validation once an owner is filled in', () => {
    for (const t of RULE_TEMPLATES) {
      const problems = validateRule({ ...ruleFromTemplate(t, NOW), owner: 'shai' });
      expect(problems, `template ${t.id}: ${JSON.stringify(problems)}`).toEqual([]);
    }
  });
});

/**
 * Shape, before meaning.
 *
 * Every case below produced a 500 carrying an internal message: either a
 * TypeError from `validateRule` reaching `.entries()` on a string, or a
 * Postgres error like `invalid input syntax for type integer`. The caller
 * learned that something broke, never that THEY had sent something wrong.
 */
describe('normalizeRuleInput', () => {
  const base = {
    name: 'x', owner: 'o', reason: 'r', action: 'escalate',
    conditions: [{ field: 'host', op: 'equals', values: ['a'] }],
  };

  it('refuses conditions that are not a list, instead of crashing', () => {
    const { problems } = normalizeRuleInput({ ...base, conditions: 'nope' });
    expect(problems.some((p) => p.field === 'conditions')).toBe(true);
  });

  it('survives a null condition', () => {
    const { rule, problems } = normalizeRuleInput({ ...base, conditions: [null] });
    expect(problems.some((p) => p.field === 'conditions.0')).toBe(true);
    expect(() => validateRule(rule)).not.toThrow();
  });

  it('accepts a single value where a list was meant', () => {
    // A shape mistake, not a reason to refuse.
    const { rule } = normalizeRuleInput({
      ...base,
      conditions: [{ field: 'host', op: 'equals', values: 'a' }],
    });
    expect(rule.conditions[0]!.values).toEqual(['a']);
  });

  it('refuses a non-numeric priority rather than letting Postgres answer', () => {
    const { problems } = normalizeRuleInput({ ...base, priority: 'high' });
    expect(problems.some((p) => p.field === 'priority')).toBe(true);
  });

  it('refuses an unparseable expiry rather than letting Postgres answer', () => {
    const { problems } = normalizeRuleInput({ ...base, expires_at: 'not-a-date' });
    expect(problems.some((p) => p.field === 'expires_at')).toBe(true);
  });

  it('defaults `enabled` to FALSE', () => {
    // Fail-safe, in the same direction as everywhere else: a rule that does
    // not say whether it is on must not turn itself on.
    expect(normalizeRuleInput(base).rule.enabled).toBe(false);
    expect(normalizeRuleInput({ ...base, enabled: 'yes' }).rule.enabled).toBe(false);
    expect(normalizeRuleInput({ ...base, enabled: true }).rule.enabled).toBe(true);
  });

  it('bounds the text it will store', () => {
    const { rule } = normalizeRuleInput({ ...base, name: 'A'.repeat(10_000) });
    expect(rule.name.length).toBe(200);
  });

  it('bounds how many conditions and values a rule may carry', () => {
    const many = Array.from({ length: 60 }, () => ({ field: 'host', op: 'equals', values: ['a'] }));
    const { rule, problems } = normalizeRuleInput({ ...base, conditions: many });
    expect(rule.conditions.length).toBe(25);
    expect(problems.some((p) => p.field === 'conditions')).toBe(true);
  });

  it('normalizes a valid rule to something validation accepts', () => {
    const { rule, problems } = normalizeRuleInput({
      ...base, priority: '20', expires_at: '2026-12-01',
    });
    expect(problems).toEqual([]);
    expect(rule.priority).toBe(20);
    expect(rule.expires_at).toMatch(/^2026-12-01T/);
    expect(validateRule(rule)).toEqual([]);
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 'string', 42, [], [1, 2], { conditions: {} }]) {
      expect(() => normalizeRuleInput(junk), JSON.stringify(junk)).not.toThrow();
    }
  });
});
