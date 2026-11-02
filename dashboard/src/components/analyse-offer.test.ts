/**
 * J0.2's qualification, on every screen that makes J0.3's offer.
 *
 * ============================================================================
 * WHY THIS IS A SUBTRACTION AND NOT A LIST OF TWO FILES
 *
 * *Analyse this code* is the one control that sends somebody out of an
 * incident and into a repository, and J0.2 exists because making it on every
 * case the inventory matched is an offer that carries no information — the
 * same button on a brute force against SSH as on an exploited endpoint. Two
 * sentences are what turn it into one: WHY this code in particular (the
 * inferred technique that said the way in was the application itself) and
 * WHAT the analysis can answer, because a report finding nothing reads as
 * *nothing wrong* unless its scope is on the screen beside it.
 *
 * The incident card was fixed. `SystemPanel`, written one commit later, made
 * the same offer once per block and carried neither sentence — *a fix applied
 * at the front door and not at the two buttons behind it*, which this
 * repository's traps table records four times already. A test naming the two
 * files that exist tonight would go stale silently on the third screen that
 * offers a scan, which is exactly how this one lasted.
 *
 * So the claim is over the SET: whatever renders the offer renders the
 * qualification. It fails in both directions — a screen that gains the offer
 * without the sentences, and a corpus in which nobody offers anything, which
 * would let the rule pass over having found nothing.
 *
 * Comments and imports are stripped first. This file's own prose names the
 * keys it hunts, and so does the prose in both components: a search over raw
 * text is satisfied by an explanation rather than by a rendered sentence.
 * ============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIR = new URL('.', import.meta.url).pathname;

/** The product's text, with every place a key can be merely DISCUSSED gone. */
function code(file: string): string {
  return readFileSync(join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import[\s\S]*?from\s+'[^']*';$/gm, '');
}

/** The button's own label key — `analyseHint` is the tooltip, not the offer. */
const OFFER = /repository\.analyse\b(?!Hint)/;
/** The technique sentence, worded per screen, read off one catalogue each. */
const WHY = /\.lead\(/;
/** The coverage of the answer. One definition, read by both screens. */
const SCOPE = /\.leadScope\b/;

const components = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));

describe('every screen that offers a scan says why, and what it can answer', () => {
  const offering = components.filter((f) => OFFER.test(code(f)));

  it('finds the screens that make the offer', () => {
    // The vacuity half. Without it, deleting the offer everywhere — or
    // renaming the catalogue key — turns the claim below into a loop over an
    // empty list, which passes.
    expect(offering.length).toBeGreaterThanOrEqual(2);
    expect(offering).toContain('CaseView.tsx');
    expect(offering).toContain('SystemPanel.tsx');
  });

  it('carries both sentences wherever it is made', () => {
    const missing = offering.filter((f) => {
      const src = code(f);
      return !WHY.test(src) || !SCOPE.test(src);
    });
    expect(missing).toEqual([]);
  });
});
