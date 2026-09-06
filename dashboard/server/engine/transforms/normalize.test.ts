/**
 * N3 — a real Wazuh alert, end to end through the mapping.
 *
 * The fixture is a genuine Wazuh 4.x alert (rule 5710, SSH invalid user).
 * Before N1/N3 the console answered it with
 * `missing_required_fields: alert_id, source_ip, dest_ip, rule_name, severity,
 * raw_log` — six of seven fields — and the alert was lost.
 */

import { describe, expect, it } from 'vitest';

import { validateAlertSchema } from './ingestion.ts';
import { GENERIC, WAZUH, mappingFor, normalize, wazuhSeverity } from './normalize.ts';

const NOW = () => new Date('2026-08-26T09:14:03Z');

const wazuhAlert = () => ({
  timestamp: '2026-08-26T09:14:02.123+0000',
  rule: {
    level: 5,
    description: 'sshd: Attempt to login using a non-existent user',
    id: '5710',
    mitre: { id: ['T1110'], tactic: ['Credential Access'] },
    groups: ['syslog', 'sshd', 'authentication_failed'],
  },
  agent: { id: '003', name: 'web-prod-01', ip: '10.0.0.7' },
  manager: { name: 'wazuh-manager' },
  id: '1756199642.884231',
  full_log: 'Aug 26 09:14:02 web-prod-01 sshd[24800]: Invalid user admin from 185.220.101.5 port 52344',
  decoder: { parent: 'sshd', name: 'sshd' },
  data: { srcip: '185.220.101.5', srcport: '52344', srcuser: 'admin' },
  location: '/var/log/auth.log',
});

describe('Wazuh alert, normalized then validated', () => {
  it('is accepted — the case that used to lose six fields out of seven', () => {
    const r = validateAlertSchema(normalize(WAZUH, wazuhAlert()), NOW, 'wazuh');

    expect(r.errors).toEqual([]);
    expect(r.validation_ok).toBe(true);
  });

  it('maps identity from the nested Wazuh shape', () => {
    const p = validateAlertSchema(normalize(WAZUH, wazuhAlert()), NOW, 'wazuh').payload!;

    expect(p.alert_id).toBe('1756199642.884231');
    expect(p.rule_name).toBe('sshd: Attempt to login using a non-existent user');
    expect(p.raw_log).toMatch(/Invalid user admin/);
    expect(p.source).toBe('wazuh');
    // `+0000` parses, and is normalized to a single canonical form.
    expect(p.timestamp).toBe('2026-08-26T09:14:02.123Z');
  });

  it('maps the observables it has, and leaves absent the one it has not', () => {
    const p = validateAlertSchema(normalize(WAZUH, wazuhAlert()), NOW, 'wazuh').payload!;

    expect(p.source_ip).toBe('185.220.101.5');
    expect(p.user).toBe('admin');
    expect(p.host).toBe('web-prod-01');
    // THE FIELD THAT USED TO REJECT EVERY WAZUH ALERT. An SSH login attempt
    // has no destination address, and saying so is the correct answer.
    expect(p.dest_ip).toBeNull();
  });

  it('converts rule.level to our scale', () => {
    const p = validateAlertSchema(normalize(WAZUH, wazuhAlert()), NOW, 'wazuh').payload!;
    expect(p.severity).toBe('medium'); // level 5

    expect(wazuhSeverity(0)).toBe('low');
    expect(wazuhSeverity(3)).toBe('low');
    expect(wazuhSeverity(4)).toBe('medium');
    expect(wazuhSeverity(8)).toBe('high');
    expect(wazuhSeverity(12)).toBe('critical');
    expect(wazuhSeverity(15)).toBe('critical');
  });

  it('keeps the Wazuh context that has no canonical column', () => {
    const p = validateAlertSchema(normalize(WAZUH, wazuhAlert()), NOW, 'wazuh').payload!;

    // Vendor-specific, and none of it discarded.
    expect(p.extensions).toMatchObject({
      location: '/var/log/auth.log',
      decoder: { parent: 'sshd', name: 'sshd' },
      manager: { name: 'wazuh-manager' },
    });
  });

  it('rejects — by name — a Wazuh payload with no rule level', () => {
    // A source that carries no severity is NOT silently triaged as `low`.
    const { rule, ...noRule } = wazuhAlert();
    const r = validateAlertSchema(normalize(WAZUH, noRule), NOW, 'wazuh');

    expect(r.validation_ok).toBe(false);
    expect(r.missing_fields).toContain('severity');
    expect(r.missing_fields).toContain('rule_name');
  });

  it('never throws on a payload of the wrong shape entirely', () => {
    const r = validateAlertSchema(normalize(WAZUH, { nothing: 'useful' }), NOW, 'wazuh');
    expect(r.validation_ok).toBe(false);
    expect(r.payload).toBeNull();
  });
});

describe('the mapping registry', () => {
  it('resolves a known source, case-insensitively', () => {
    expect(mappingFor('wazuh')).toBe(WAZUH);
    expect(mappingFor('WAZUH')).toBe(WAZUH);
    expect(mappingFor('generic')).toBe(GENERIC);
  });

  it('returns null for an unknown source rather than guessing a format', () => {
    expect(mappingFor('splunk')).toBeNull();
  });

  it('leaves a canonical payload untouched', () => {
    const canonical = {
      alert_id: 'A-1', rule_name: 'r', severity: 'high',
      timestamp: '2026-08-26T09:00:00Z', raw_log: 'x', source_ip: '1.2.3.4',
    };
    const r = validateAlertSchema(normalize(GENERIC, canonical), NOW, 'generic');

    expect(r.validation_ok).toBe(true);
    expect(r.payload?.alert_id).toBe('A-1');
    expect(r.payload?.severity).toBe('high');
  });
});
