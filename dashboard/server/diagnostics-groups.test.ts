/**
 * The diagnostic's section titles, and the four that nothing could ever print.
 *
 * ============================================================================
 * WHAT WAS WRONG
 *
 * `Health -> Test connectivity` groups its checks under section titles, and
 * those titles live in the server catalogue as `groups`. It declared NINE:
 * `access`, `workflows`, `contract`, `chain`, `credentials`, `executions`,
 * `database`, `config`, `ingestion`.
 *
 * `diagnostics.ts` references FIVE. The other four — Access, Workflows,
 * Chaining, Configuration — are the n8n-era report, and `diagnostics.ts` says
 * so in its own header: "It used to be a report about an n8n instance: is the
 * API reachable, are the six workflows published, has anybody renamed a node
 * the console reads, is a credential attached. Every one of those questions
 * disappeared with n8n." The code was rewritten; the four titles stayed,
 * typed, translated, and unreachable.
 *
 * Nothing failed, which is why they lasted. A section title nobody can emit
 * costs no screen and no byte on the wire — it costs the next reader, who
 * finds nine groups declared and documents nine groups. `dashboard/README.md`
 * did exactly that, and listed "About thirty checks" across all nine: the real
 * diagnostic is 14 checks in 5 groups with no database configured (measured by
 * driving `runDiagnostics`), 15 with one.
 *
 * ============================================================================
 * WHY THE EXISTING SWEEP COULD NOT SEE THEM
 *
 * `src/components/n8n-removed.test.ts` already refuses a catalogue key nothing
 * mentions. Its own comment states the limit it has: it searches the bare leaf
 * NAME across product source, so "the rule under-reports on names that collide
 * with ordinary words". `access`, `workflows`, `chain` and `config` are four of
 * the most ordinary words in a server, and every one of them appears somewhere
 * for an unrelated reason. They passed that sweep for its whole life.
 *
 * What makes them checkable is that this sub-catalogue has a declaration on
 * the OTHER side: exactly one module reads `m.groups`, and it names each one
 * it uses. So the rule here is not "is this word written anywhere" but "are
 * the two lists the same list".
 *
 * ============================================================================
 * ONE EQUALITY, AND WHY IT IS NOT TWO ASSERTIONS
 *
 * Declared and referenced are compared as SETS, in one assertion. That is both
 * directions at once: a label nothing can emit fails it, and a group read some
 * way the catalogue does not declare fails it too. Splitting it in two would
 * put a second line where one does the work — and this repository has paid for
 * "two guards where one suffices is a line no test can fail on" before.
 *
 * COMMENTS ARE STRIPPED, and that is load-bearing rather than tidiness: the
 * realistic regression is somebody deleting a group's last use and leaving a
 * comment that explains why it used to be there. The equality would then pass
 * over a dead label again, which is the `n8n-removed.test.ts` lesson —
 * "a string only a comment mourns is a string no operator will ever read".
 *
 * THE FLOOR IS NOT INDEPENDENTLY KILLABLE, and it is kept anyway. Two empty
 * sets are equal, so a reader that stopped matching — `g` renamed, the import
 * reshaped — would agree with a catalogue that had lost its groups. No single
 * mutation produces both halves of that at once, so no mutation fails on the
 * floor alone; it is written here with that said out loud, rather than left to
 * read as a line a test stands behind.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { messages } from './i18n.ts';

/** Strip comments: a group a comment mourns is a group no screen prints. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The one module that turns a group label into a section on screen.
 *
 * Named rather than swept, because `m.groups` has exactly one consumer and a
 * walk over `server/` would make this rule depend on nothing in particular.
 * The other direction of the equality is what notices if that stops being
 * true: a second reader using a group this one does not would fail it.
 */
const DIAGNOSTICS = join(process.cwd(), 'server', 'diagnostics.ts');

const referencedGroups = (): string[] => {
  const source = code(readFileSync(DIAGNOSTICS, 'utf8'));
  return [...new Set([...source.matchAll(/\bg\.([a-zA-Z]+)\b/g)].map((m) => m[1]))].sort();
};

const declaredGroups = (): string[] => Object.keys(messages('en').groups).sort();

describe('every diagnostic section title is one the diagnostic can print', () => {
  it('declares exactly the groups diagnostics.ts emits', () => {
    expect(declaredGroups()).toEqual(referencedGroups());
  });

  it('read something on both sides', () => {
    // See the header: the equality above is vacuously true of two empty sets.
    expect(declaredGroups().length).toBeGreaterThanOrEqual(5);
    expect(referencedGroups().length).toBeGreaterThanOrEqual(5);
  });
});
