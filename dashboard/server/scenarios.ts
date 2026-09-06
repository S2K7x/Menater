/**
 * Test alerts, one per behaviour worth seeing.
 *
 * ============================================================================
 * WHY MORE THAN ONE
 *
 * The injector sent a single hard-coded alert: high severity, both addresses
 * present, a plausible brute-force line. It proved the chain was connected and
 * nothing else. Everything the pipeline does DIFFERENTLY — capping confidence
 * on a degraded enrichment, refusing to isolate a host it cannot name, taking
 * the fallback verdict, rejecting a malformed payload — was unreachable from
 * the console, so the only way to see any of it was to wait for a real alert
 * shaped that way.
 *
 * Each scenario below exists because it takes a DIFFERENT path. They are not
 * variations of tone; `no-target` is here because it is the one that proves an
 * isolation cannot be proposed without a host, and `malformed` is here because
 * a rejection is a behaviour too.
 * ============================================================================
 */

export interface Scenario {
  id: string;
  /** Short label, shown on the button. */
  title: string;
  /** What this one is for — the path it takes, not the story it tells. */
  purpose: string;
  /** `null` where the scenario is deliberately not a valid alert. */
  build: (stamp: string, seq: number) => Record<string, unknown>;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'brute-force',
    title: 'Brute force, then success',
    purpose:
      'The ordinary high-severity case: both addresses present, a public source, '
      + 'a hash-free log. The path everything else is compared against.',
    build: (stamp, seq) => ({
      alert_id: `QA-BF-${seq}`,
      rule_name: 'Multiple failed SSH logins followed by successful auth',
      severity: 'high',
      timestamp: stamp,
      source_ip: '185.220.101.47',
      dest_ip: '10.12.4.31',
      user: 'root',
      host: 'web-01',
      raw_log: `${stamp} web01 sshd: Accepted password for root after 47 failures`,
    }),
  },
  {
    id: 'critical-exfil',
    title: 'Data exfiltration (critical)',
    purpose:
      'Critical severity with a named destination — the only shape from which '
      + '`isolate_host_temporary` can even be proposed. Watch it still require approval.',
    build: (stamp, seq) => ({
      alert_id: `QA-EX-${seq}`,
      rule_name: 'Large outbound transfer to unknown host',
      severity: 'critical',
      timestamp: stamp,
      source_ip: '10.12.7.88',
      dest_ip: '45.147.230.12',
      host: 'db-prod-01',
      raw_log: `${stamp} db-prod-01 netflow: 4.2 GB egress to 45.147.230.12:443 in 6 min`,
    }),
  },
  {
    id: 'no-target',
    title: 'No destination (Wazuh-shaped)',
    purpose:
      'The shape most real detections have: no `dest_ip` at all. Proves the alert is '
      + 'accepted rather than rejected, and that no isolation can be proposed without a host.',
    build: (stamp, seq) => ({
      alert_id: `QA-NT-${seq}`,
      rule_name: 'sshd: Attempt to login using a non-existent user',
      severity: 'medium',
      timestamp: stamp,
      source_ip: '185.220.101.5',
      user: 'admin',
      raw_log: `${stamp} web-prod-01 sshd[24800]: Invalid user admin from 185.220.101.5`,
    }),
  },
  {
    id: 'file-hash',
    title: 'File integrity, with a hash',
    purpose:
      'Carries a SHA-256 in the log line, which is what makes the VirusTotal branch '
      + 'applicable at all. Without a hash that source is skipped, not failed.',
    build: (stamp, seq) => ({
      alert_id: `QA-FH-${seq}`,
      rule_name: 'Integrity checksum changed on a system binary',
      severity: 'high',
      timestamp: stamp,
      host: 'app-03',
      file_path: '/usr/bin/curl',
      raw_log:
        `${stamp} app-03 syscheck: /usr/bin/curl changed, sha256 `
        + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }),
  },
  {
    id: 'internal-scan',
    title: 'Internal port scan',
    purpose:
      'A private source address: the reputation sources have nothing to say about it. '
      + 'Also the shape a "known scanner" tuning rule is written against.',
    build: (stamp, seq) => ({
      alert_id: `QA-SC-${seq}`,
      rule_name: 'nmap port scan detected',
      severity: 'medium',
      timestamp: stamp,
      source_ip: '10.0.0.9',
      dest_ip: '10.12.4.31',
      host: 'scanner-01',
      raw_log: `${stamp} fw: 1024 SYN from 10.0.0.9 across 10.12.4.0/24`,
    }),
  },
  {
    id: 'low-noise',
    title: 'Low severity, benign',
    purpose:
      'The kind that should close quietly. Useful for seeing what the queue looks like '
      + 'when nothing needs you, and for testing a severity-downgrade rule.',
    build: (stamp, seq) => ({
      alert_id: `QA-LN-${seq}`,
      rule_name: 'Single failed login',
      severity: 'low',
      timestamp: stamp,
      source_ip: '10.12.3.77',
      dest_ip: '10.12.3.77',
      user: 'jdoe',
      host: 'dev-laptop-12',
      raw_log: `${stamp} dev-laptop-12 sshd: Failed password for jdoe (1 attempt)`,
    }),
  },
  {
    id: 'bare-identity',
    title: 'Identity only, no observables',
    purpose:
      'The minimum an alert can carry and still be processed. Every optional field is '
      + 'absent, and must be SHOWN absent rather than filled in.',
    build: (stamp, seq) => ({
      alert_id: `QA-BI-${seq}`,
      rule_name: 'Unclassified detector output',
      severity: 'medium',
      timestamp: stamp,
      raw_log: `${stamp} detector: anomaly score 0.81, no entities extracted`,
    }),
  },
  {
    id: 'malformed',
    title: 'Malformed (rejected on purpose)',
    purpose:
      'Not a valid alert: the severity is not one of the four. A rejection is a '
      + 'behaviour too, and this is how you see what the sender is told.',
    build: (stamp, seq) => ({
      alert_id: `QA-MF-${seq}`,
      rule_name: 'Broken sender',
      severity: 'catastrophic',
      timestamp: stamp,
      raw_log: `${stamp} sender: severity field not from the catalogue`,
    }),
  },
  {
    id: 'burst',
    title: 'Same alert twice (deduplication)',
    purpose:
      'Reuses a FIXED id, so a second injection is a duplicate. Shows the dedup path '
      + 'answering 200 instead of starting a second chain.',
    build: (stamp) => ({
      alert_id: 'QA-DUP-FIXED',
      rule_name: 'Repeated detector output',
      severity: 'medium',
      timestamp: stamp,
      source_ip: '203.0.113.44',
      host: 'web-02',
      raw_log: `${stamp} detector: repeated signal, deliberately the same alert_id`,
    }),
  },
] as const;

export const scenarioById = (id: string): Scenario | null =>
  SCENARIOS.find((s) => s.id === id) ?? null;

/** Used when the caller asks for no scenario in particular. */
export const DEFAULT_SCENARIO = 'brute-force';
