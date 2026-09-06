/**
 * Starter tuning rules.
 *
 * ============================================================================
 * EVERY TEMPLATE IS A CONJUNCTION, AND THAT IS THE POINT
 *
 * The tempting template is "ignore the vulnerability scanner's IP". It is also
 * the one that hands an attacker a free pass: take that address, and the SOC
 * stops looking. So each template below names the address AND the activity it
 * is expected to produce. The scanner is allowed to trip the port-scan rule;
 * it is not allowed to exfiltrate data unnoticed.
 *
 * They ship DISABLED and with a placeholder owner. A starter pack that starts
 * silencing alerts the moment it is installed is a starter pack that has
 * decided something on the operator's behalf.
 * ============================================================================
 */

import type { Condition, RuleAction, TuningRule } from './tuning.ts';
import type { Severity } from './domain.ts';

export interface RuleTemplate {
  id: string;
  /** Short, in the operator's language, not ours. */
  title: string;
  /** What it does and — as importantly — what it deliberately still catches. */
  description: string;
  category: 'scanner' | 'maintenance' | 'identity' | 'file' | 'noise' | 'environment';
  action: RuleAction;
  severity: Severity | null;
  conditions: Condition[];
  /** Which values the operator MUST replace before this means anything. */
  placeholders: string[];
  /** Suggested lifetime in days, or `null` for a standing rule. */
  expiresInDays: number | null;
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'vuln-scanner',
    title: 'Authorised vulnerability scanner',
    description:
      'Closes port-scan and probe alerts coming from your scanner, and ONLY those. '
      + 'The same address triggering anything else still reaches you — which is the '
      + 'point: a compromised scanner is a scanner with credentials everywhere.',
    category: 'scanner',
    action: 'allow',
    severity: null,
    conditions: [
      { field: 'source_ip', op: 'cidr', values: ['10.0.0.0/24'] },
      { field: 'rule_name', op: 'contains', values: ['scan', 'port', 'probe', 'nmap'] },
    ],
    placeholders: ['source_ip'],
    expiresInDays: null,
  },
  {
    id: 'backup-window',
    title: 'Backup agent, large transfers',
    description:
      'Large outbound transfers from the backup server, to the backup destination. '
      + 'Both ends are named: the same volume to anywhere else is still an alert.',
    category: 'maintenance',
    action: 'allow',
    severity: null,
    conditions: [
      { field: 'host', op: 'equals', values: ['backup-01'] },
      { field: 'dest_ip', op: 'cidr', values: ['10.20.0.0/24'] },
      { field: 'rule_name', op: 'contains', values: ['data transfer', 'exfil', 'large upload'] },
    ],
    placeholders: ['host', 'dest_ip'],
    expiresInDays: null,
  },
  {
    id: 'deploy-account',
    title: 'Deployment service account',
    description:
      'Your CI account writing to the paths it deploys to. Scoped to the account AND '
      + 'the path: the same account touching anything else is exactly what you want to hear about.',
    category: 'identity',
    action: 'allow',
    severity: null,
    conditions: [
      { field: 'user', op: 'equals', values: ['svc-deploy'] },
      { field: 'file_path', op: 'starts_with', values: ['/opt/app/'] },
    ],
    placeholders: ['user', 'file_path'],
    expiresInDays: null,
  },
  {
    id: 'known-software',
    title: 'Known software, by hash',
    description:
      'File-integrity alerts for binaries you deploy on purpose. Keyed on the hash in '
      + 'the log line, so a modified file with a different hash is not covered.',
    category: 'file',
    action: 'allow',
    severity: null,
    conditions: [
      { field: 'raw_log', op: 'contains', values: ['PUT THE SHA-256 HERE'] },
      { field: 'rule_name', op: 'contains', values: ['integrity', 'syscheck', 'file modified'] },
    ],
    placeholders: ['raw_log'],
    expiresInDays: null,
  },
  {
    id: 'maintenance-window',
    title: 'Maintenance window, temporary',
    description:
      'Silences a host while you work on it. EXPIRES on its own — that is the whole '
      + 'difference from an allow, and the reason to prefer it whenever the reason is temporary.',
    category: 'maintenance',
    action: 'suppress',
    severity: null,
    conditions: [
      { field: 'host', op: 'equals', values: ['server-under-maintenance'] },
    ],
    placeholders: ['host'],
    expiresInDays: 2,
  },
  {
    id: 'noisy-rule',
    title: 'One noisy detection, downgraded',
    description:
      'Keeps a chatty rule visible but out of the way: it drops to low instead of '
      + 'disappearing. Prefer this to an allow when the signal is real but rarely urgent.',
    category: 'noise',
    action: 'severity',
    severity: 'low',
    conditions: [
      { field: 'rule_name', op: 'contains', values: ['PUT THE RULE NAME HERE'] },
    ],
    placeholders: ['rule_name'],
    expiresInDays: null,
  },
  {
    id: 'dev-environment',
    title: 'Development environment, downgraded',
    description:
      'Lowers severity for a non-production range rather than muting it. Development '
      + 'boxes get compromised too, and they are usually the way in.',
    category: 'environment',
    action: 'severity',
    severity: 'low',
    conditions: [
      { field: 'host', op: 'starts_with', values: ['dev-', 'test-'] },
    ],
    placeholders: ['host'],
    expiresInDays: null,
  },
  {
    id: 'crown-jewels',
    title: 'Critical assets always reach a human',
    description:
      'The opposite of an exception: anything touching these hosts goes to a person, '
      + 'whatever the model concludes. Costs review time on purpose.',
    category: 'environment',
    action: 'escalate',
    severity: null,
    conditions: [
      { field: 'host', op: 'in_list', values: ['db-prod-01', 'dc-01'] },
    ],
    placeholders: ['host'],
    expiresInDays: null,
  },
] as const;

/** Builds a draft rule from a template. Disabled, and dated from `now`. */
export function ruleFromTemplate(
  template: RuleTemplate,
  now: () => Date = () => new Date(),
): Omit<TuningRule, 'id'> {
  const at = now();
  const expires = template.expiresInDays === null
    ? null
    : new Date(at.getTime() + template.expiresInDays * 86_400_000).toISOString();

  return {
    name: template.title,
    // DISABLED. A starter pack that silences alerts on install has decided
    // something on the operator's behalf.
    enabled: false,
    priority: 100,
    conditions: template.conditions.map((c) => ({ ...c, values: [...c.values] })),
    action: template.action,
    severity: template.severity,
    owner: '',
    reason: template.description,
    expires_at: expires,
    created_at: at.toISOString(),
    updated_at: at.toISOString(),
  };
}
