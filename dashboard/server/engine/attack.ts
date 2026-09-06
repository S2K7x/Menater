/**
 * MITRE ATT&CK tagging, from the rule name and the raw log.
 *
 * ============================================================================
 * DELIBERATELY SIMPLE, AND DELIBERATELY READABLE
 *
 * SOAR products that display ATT&CK techniques without saying where they came
 * from give a false impression of rigour. Here the mapping is a table anyone
 * can read and correct, and the interface says the tag is INFERRED from the
 * rule name rather than asserted by the detection.
 *
 * It moved out of the n8n client when that client was deleted: the tagging was
 * never about n8n, it is about a case, and it had been living in the file that
 * happened to build cases at the time.
 * ============================================================================
 */

import type { AttackTag } from '../../src/lib/types.ts';

const ATTACK_RULES: { match: RegExp; tag: AttackTag }[] = [
  { match: /brute.?force|failed (ssh|login|auth)|password spray/i,
    tag: { id: 'T1110', technique: 'Brute Force', tactic: 'Credential Access' } },
  { match: /ssh|remote (login|desktop)|rdp/i,
    tag: { id: 'T1021', technique: 'Remote Services', tactic: 'Lateral Movement' } },
  { match: /exfiltrat|data transfer|upload/i,
    tag: { id: 'T1041', technique: 'Exfiltration Over C2 Channel', tactic: 'Exfiltration' } },
  { match: /malware|trojan|ransom|payload|dropper/i,
    tag: { id: 'T1204', technique: 'User Execution', tactic: 'Execution' } },
  { match: /powershell|cmd\.exe|script/i,
    tag: { id: 'T1059', technique: 'Command and Scripting Interpreter', tactic: 'Execution' } },
  { match: /privilege|sudo|escalat/i,
    tag: { id: 'T1068', technique: 'Exploitation for Privilege Escalation', tactic: 'Privilege Escalation' } },
  { match: /scan|port sweep|recon|enumerat/i,
    tag: { id: 'T1046', technique: 'Network Service Discovery', tactic: 'Discovery' } },
  { match: /persist|cron|systemd|registry run/i,
    tag: { id: 'T1053', technique: 'Scheduled Task/Job', tactic: 'Persistence' } },
  { match: /c2|command and control|beacon|tor/i,
    tag: { id: 'T1071', technique: 'Application Layer Protocol', tactic: 'Command and Control' } },
];

/** At most three tags: a case labelled with nine techniques has said nothing. */
export function tagAttack(ruleName: string, rawLog: string): AttackTag[] {
  const haystack = `${ruleName} ${rawLog}`;
  const out: AttackTag[] = [];
  for (const { match, tag } of ATTACK_RULES) {
    if (match.test(haystack) && !out.some((t) => t.id === tag.id)) out.push(tag);
  }
  return out.slice(0, 3);
}
