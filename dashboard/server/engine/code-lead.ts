/**
 * J0.2 — an alert that points at the application's own code.
 *
 * ============================================================================
 * WHAT THIS CLOSES
 *
 * J0.3 taught the console which code runs on which machine, and J0.1 let a
 * flaw enter the queue. Neither of them says WHEN the code is worth looking
 * at. So the incident card offered "Analyse this code" on every case the
 * inventory matched — the same offer on a brute force against SSH as on an
 * exploited endpoint — and an offer made everywhere is an offer that carries
 * no information.
 *
 * This is the other half of that: the alerts where the flaw that made the
 * incident possible may be IN the code, and where the analysis is therefore
 * worth its money while the incident is open.
 *
 * ============================================================================
 * IT DECIDES NOTHING AND STARTS NOTHING
 *
 * The rule J0.3 and J0.1 both live by: it RESOLVES, it never acts. A lead
 * qualifies an offer a human still has to press; no scan is estimated, no
 * repository is cloned, no money is spent by an alert arriving. A console that
 * launched an analysis because a detection fired would be spending on a target
 * read out of a settings file — § 8's invented default, with a bill.
 *
 * ============================================================================
 * THE TECHNIQUE IS THE WHOLE INPUT, AND THAT IS ON PURPOSE
 *
 * `tagAttack` already infers techniques from the rule name and the raw log,
 * and the card already prints them under a note saying they are inferred. So
 * a lead read off those tags is checkable by the operator against something
 * already on their screen.
 *
 * Matching the rule name a second time here would be a second inference, worded
 * differently, arriving at a conclusion the visible tags might not support —
 * two rulers disagreeing about the same alert, on the screen that decides
 * whether somebody goes and reads code during an incident.
 * ============================================================================
 */

import type { AttackTag, CodeLead } from '../../src/lib/types.ts';

/**
 * The techniques whose exploitation happens in the application's own source.
 *
 * ONE ENTRY, AND IT IS THE HONEST SIZE. Of the ten techniques `attack.ts`
 * infers, T1190 is the only one that means "the way in was the code": the rest
 * are about credentials (T1110), hosts (T1021, T1053), attacker tooling
 * (T1059, T1204) or traffic (T1041, T1071). Padding this set with techniques
 * that merely CO-OCCUR with a web attack would put the offer back on cards
 * where it says nothing, which is the defect this file exists to remove.
 *
 * A Set rather than a list of `if`s so that adding one is adding one string.
 */
const APPLICATION_TECHNIQUES = new Set(['T1190']);

/**
 * The first inferred technique that points at the application, or `null`.
 *
 * FIRST, NOT ALL. The card shows one sentence; two techniques pointing at the
 * code do not make the code twice as worth reading, and listing them would put
 * the tag list on the card a second time, three lines above the real one.
 */
export function codeLead(attack: AttackTag[]): CodeLead | null {
  const tag = attack.find((t) => APPLICATION_TECHNIQUES.has(t.id));
  return tag ? { technique_id: tag.id, technique: tag.technique } : null;
}
