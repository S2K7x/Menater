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
  /*
   * FIRST BECAUSE IT IS THE ONE THAT CHANGES WHAT AN OPERATOR DOES NEXT, and
   * because `tagAttack` keeps the first three matches: an alert about a web
   * attack also says "script" and "scan" often enough that T1059 and T1046
   * would have pushed it out.
   *
   * The nine rules below it are all about hosts, credentials and attacker
   * tooling. None of them says "the way in was the application's own code",
   * which is exactly the alert J0.2 exists for — so J0.2 could not have been
   * built on the table as it stood.
   *
   * The vocabulary is EXPLOITATION, not flaw names. `IDOR` and `SSRF` are
   * deliberately absent: a promoted scan finding is named `<flaw> in <METHOD>
   * <route>` (`findingToAlert`), and tagging it "somebody exploited a
   * public-facing application" would assert an attack nobody observed. The
   * two names that are also flaw names — injection, traversal — earn their
   * place because that is how a detection rule words the ATTEMPT.
   *
   * `LFI` and `RFI` were dropped for the same reason in miniature: three
   * letters between word boundaries, matched against the RAW LOG as well as
   * the rule name, is a token a URL path or an unrelated acronym can supply —
   * and a false T1190 puts "go and read your code" on a card for nothing.
   * `path traversal` is how a detection rule words that attack anyway.
   */
  { match: /sql ?injection|\bsqli\b|\bxss\b|cross.?site script|(path|directory) traversal|command injection|insecure deserializ|web ?shell|log4j|shellshock|exploit(ation)? attempt|public.facing|web attack/i,
    tag: { id: 'T1190', technique: 'Exploit Public-Facing Application', tactic: 'Initial Access' } },
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
