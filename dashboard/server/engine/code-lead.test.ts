/**
 * J0.2 — the alerts that are worth reading the code for.
 *
 * Two things are pinned here, and the second one is about the OTHER half of
 * the product.
 *
 * 1. The table gained T1190 for this feature, and a rule added to a list that
 *    is then cut to three entries is a rule that can be silently outvoted.
 *    `tagAttack` had no test file at all, so the cap was unasserted.
 * 2. The offer names what the analysis looks for. That sentence is a claim
 *    about `VulnPipe/src/nodes/`, one package away, and nothing in the console
 *    imports that directory — the exact shape of "a name that outlives the
 *    thing it named". So the claim is checked against the directory.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tagAttack } from './attack.ts';
import { codeLead } from './code-lead.ts';
import { consoleDictionary } from '../../src/i18n/console.ts';

const lead = (ruleName: string, rawLog = '') => codeLead(tagAttack(ruleName, rawLog));

describe('an alert that says the way in was the application itself', () => {
  it('reads the lead off the technique, and names it', () => {
    const l = lead('Web attack: SQL injection attempt on /api/orders');
    expect(l).toEqual({ technique_id: 'T1190', technique: 'Exploit Public-Facing Application' });
  });

  it.each([
    ['ModSecurity: XSS attack detected', 'payload=<script>alert(1)</script>'],
    ['IDS alert — path traversal on the download endpoint', ''],
    ['Log4j exploitation attempt', 'jndi:ldap://'],
    ['Web shell dropped in /var/www/html', ''],
  ])('recognises %s', (ruleName, rawLog) => {
    expect(lead(ruleName, rawLog)?.technique_id).toBe('T1190');
  });

  /*
   * THE CAP IS THE POINT OF THIS ONE. `tagAttack` keeps the first three
   * matches, and this rule name also hits `/script/i` (T1059), `/scan/i`
   * (T1046) and `/upload/i` (T1041) — four rules for one alert. Written
   * anywhere below them in the table, T1190 would be dropped by the slice and
   * the offer would never appear on the alert it was built for.
   */
  it('survives an alert that matches four rules at once', () => {
    const tags = tagAttack(
      'Automated scan: cross-site scripting and file upload probing',
      'suspicious script in the request body',
    );
    expect(tags).toHaveLength(3);
    expect(tags[0].id).toBe('T1190');
    expect(lead('Automated scan: cross-site scripting and file upload probing',
      'suspicious script in the request body')?.technique_id).toBe('T1190');
  });
});

describe('an alert that says nothing about the code gets no lead', () => {
  it.each([
    ['Multiple failed SSH logins followed by successful auth'],
    ['Outbound beacon to a known C2 domain'],
    ['New cron entry added by a non-root user'],
    ['Ransomware payload quarantined'],
  ])('%s', (ruleName) => {
    expect(lead(ruleName)).toBeNull();
  });

  /*
   * A PROMOTED SCAN FINDING IS NAMED AFTER THE FLAW, NOT AFTER AN ATTACK.
   * `findingToAlert` composes `<vulnerability> in <METHOD> <route>`, so
   * matching flaw names here would tag every finding this console promoted
   * with "somebody exploited a public-facing application" — an attack nobody
   * observed, asserted on the card, about a case whose repository line already
   * says it came from a scan.
   */
  it('does not claim an exploitation on a promoted scan finding', () => {
    expect(lead('IDOR in GET /orders/:id')).toBeNull();
    expect(lead('SSRF in POST /api/fetch')).toBeNull();
  });
});

/*
 * ============================================================================
 * THE OFFER'S SCOPE IS A CLAIM ABOUT THE OTHER HALF OF THE PRODUCT
 *
 * "The analysis looks for broken access control" is true because
 * `VulnPipe/src/nodes/` holds exactly one detector. Nothing imports that
 * directory from here — the console API has one production dependency and the
 * analyser is a separate service — so the sentence and the thing it describes
 * can drift apart in total silence, which is how a stale name survives on a
 * screen whose whole job is to say what is true right now.
 *
 * A scan that comes back with nothing is read as "the code is fine". If a
 * second detector ships and this sentence does not move, the console keeps
 * understating what it just paid for; if the IDOR node is ever renamed or
 * removed, it overstates it. Both directions fail here.
 * ============================================================================
 */
describe('the offer says what the analysis can actually look for', () => {
  const NODES = fileURLToPath(new URL('../../../VulnPipe/src/nodes', import.meta.url));

  it('names every detector VulnPipe ships, and no more', () => {
    const detectors = readdirSync(NODES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'shared')
      .map((e) => e.name)
      .sort();

    expect(
      detectors,
      'VulnPipe\'s detector set changed. caseView.repository.leadScope in '
      + 'src/i18n/console.ts tells an operator what the analysis looks for '
      + 'BEFORE they pay for it — move that sentence with it.',
    ).toEqual(['idor']);

    expect(consoleDictionary('en').caseView.repository.leadScope.toLowerCase())
      .toContain('access control');
  });
});
