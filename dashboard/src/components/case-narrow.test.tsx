/**
 * @vitest-environment jsdom
 */
/**
 * The incident card scrolled sideways on a phone, and it was the last screen
 * that did.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * `narrow-viewport.test.tsx` closed three of these for the Ingestion, Health
 * and MCP screens. The sweep behind it walked the TABS, and an open case is a
 * state you have to click into — so the one screen a responder actually reads
 * on a phone, at three in the morning, was the one it never measured. It was
 * recorded in `ROADMAP.md` § 7 as a single number, 401 px. Driven case by case
 * it is worse than that number: at 320 px — the width WCAG 2.2 § 1.4.10
 * (Reflow, level AA) names, and what a 375 px phone reaches at 125 % zoom —
 * **six of the seven sample cases overflowed**, and five of seven at 375 px.
 *
 * Measured in Chromium 1194 on this repository's own build, served by the
 * console itself, reading `document.documentElement.scrollWidth` once per case
 * with the transitions killed first (`CLARITY.md` § 7: a sampled cross-fade is
 * a bug in the ruler, not a finding):
 *
 *     viewport   BEFORE (7 cases)                 AFTER
 *     320 px     401 335 401 386 320 386 386      320 ×7
 *     375 px     401 375 401 386 375 386 386      375 ×7
 *     1280 px    clean                            clean, byte-identical
 *
 * ============================================================================
 * 1. THE ONE-COLUMN OVERRIDE CHOSE HOW MANY TRACKS, NOT HOW NARROW ONE MAY BE
 *
 * `1fr` is `minmax(auto, 1fr)`, so the track floors at the card's min-content:
 * measured at 320 px, the grid box was **296 px** and its single track
 * **389.047 px**. That is the `.soc-health-grid` trap of the file above,
 * verbatim — and this time the rule was already written **in the declaration
 * it overrides**: `.soc-case-layout`'s desktop value is
 * `minmax(0, 1.6fr) minmax(300px, 1fr)`, whose first track is protected, and
 * the one-column override threw that protection away.
 *
 * **And the stylesheet carried TWO copies of that override**, byte-identical,
 * at lines 512 and 1123 — so the later one won and a fix applied to the first
 * would have been a fix that looks applied and is not. Measured: patching only
 * the first copy and rebuilding gave `401 335 401 386 320 386 386` at 320 px
 * and a track of 389.047 px, i.e. **not one pixel of change**. The duplicate
 * is gone, and the claim below is written over EVERY declaration of this
 * property on this selector rather than over the one somebody edited.
 *
 * ============================================================================
 * 2. A DOTTED FIELD PATH IS A MACHINE VALUE, AND IT HAD NOWHERE TO BREAK
 *
 * `.soc-lineage` is the decision's data lineage — the fields the model says it
 * leaned on, and `CaseView.tsx`'s own header calls it *« ce qui permet de
 * contester un verdict au lieu de le subir »*. Its entries are dotted paths:
 * `enrichment.abuseipdb.abuse_confidence_score`, forty-three characters of
 * mono with no break opportunity, **min-content 314.1 px**. It is on five of
 * the seven sample cases, and it is what is left over once the track is freed.
 *
 * The rest of this stylesheet already lets every other machine value break —
 * `.soc-kv dd`, `.soc-hash`, `.soc-intel-value`, `.soc-health-item code`. The
 * mirror of a rule is not the rule, one block over.
 *
 * **The spelling is not interchangeable**, and this is the second element in
 * this repository to pay for it. Measured at 320 px, the same intent written
 * three ways:
 *
 *     overflow-wrap: anywhere      320 px  ✓
 *     word-break: break-all        320 px  ✓
 *     overflow-wrap: break-word    386 px  ✗  — unchanged, byte for byte
 *
 * Only the first two take part in min-content sizing, which is the thing that
 * floors a grid track. `break-word` wraps the visible line and leaves the
 * minimum where it was: a fix that looks applied and is not.
 *
 * ============================================================================
 * 3. A PILL BUILT FOR A WORD, HOLDING A SENTENCE
 *
 * `.soc-pill` sets `white-space: nowrap`, which is right for what pills were
 * built for — `CRITICAL`, `HIGH`, `ok`, `unavailable`: one word, and a
 * severity that wrapped mid-word in a forty-row table would be unreadable.
 *
 * The approval head puts something else in one. It names the action a human is
 * being asked to authorise, read out of the closed action catalogue, and those
 * labels are PHRASES: `cut the host off the network (temporarily)` is
 * forty-one characters, **min-content 329 px**, and `white-space: nowrap`
 * makes a sentence as unbreakable as a hash. On the screen where a human
 * approves a containment action.
 *
 * So the modifier names the CONTENT and not the call site, and it is written
 * with both classes. `.soc-pill` is (0,1,0) and a bare `.soc-pill-phrase` is
 * (0,1,0) too, so it would win only by sitting further down the file —
 * `.soc-pill.soc-pill-phrase` is (0,2,0) and wins by SPECIFICITY, which the
 * next edit to this sheet cannot silently change. That is the
 * `.soc-field.soc-check-field > span` lesson, which this project has now paid
 * four times.
 *
 * **The plausible wrong fix is `.soc-pill { white-space: normal }`**, and it is
 * refused by a test that passes before and after. Measured at 320 px it leaves
 * **six of seven cases overflowing** (386 335 386 386 320 386 386) — it is not
 * even the bigger half of the remedy — and it buys that nothing by letting
 * every severity in the queue wrap.
 *
 * ============================================================================
 * WHY THESE TESTS READ `styles.css`
 *
 * jsdom applies no cascade and computes no layout: `scrollWidth` is 0 there
 * for everything, so the suite cannot measure a reflow. Four files here
 * already read the stylesheet for that reason, and the numbers above come from
 * the browser instead.
 *
 * A rule that exists is not a rule that reaches anything, so each of the three
 * comes in a PAIR: the stylesheet carries it, AND the component puts the value
 * inside the element it names. The second half of each pair passes before and
 * after — it is what stops the rule being quietly orphaned by a markup change,
 * which is precisely what the duplicate override in § 1 had become.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { I18nProvider } from '../i18n/context.tsx';
import { CaseView } from './CaseView.tsx';
import { consoleDictionary } from '../i18n/console.ts';
import type { AlertCase, Approval, Decision } from '../lib/types.ts';

afterEach(cleanup);

/** The one locale the catalogue still carries. */
const cat = consoleDictionary('en');

const css = (): string => readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');

/** The longest entry the demo set carries, and the one measured at 314.1 px. */
const LINEAGE_PATH = 'enrichment.abuseipdb.abuse_confidence_score';

const decision = (): Decision =>
  ({
    verdict: 'true_positive',
    confidence: 0.85,
    raw_confidence: 0.91,
    reasoning: 'The source address is reported by AbuseIPDB with a high confidence score.',
    recommended_action: 'isolate_host_temporary',
    data_lineage: [LINEAGE_PATH, 'enrichment.shodan.tags'],
    guardrails_applied: [],
    is_fallback: false,
    decision_source: 'model',
    model: 'anthropic/claude-sonnet-4.5',
    attempts: 1,
    usage: { input_tokens: 2210, output_tokens: 188 },
  }) as unknown as Decision;

/** Awaiting an answer: the state that renders the action pill. */
const pending = (): Approval =>
  ({
    requested_action: 'isolate_host_temporary',
    intent: 'Cut srv-bastion-01 off the network for 60 minutes.',
    blast_radius: 'One host. Network access only; the machine keeps running.',
    rollback_plan: 'Automatic revert after the TTL, or manual re-enable.',
    approval_triggers: ['A containment action is irreversible without a human.'],
    triggers: ['A containment action is irreversible without a human.'],
    outcome: 'pending',
    approver: null,
    human_reasoning: null,
    timeout_minutes: 30,
    execution_id: 'run-04-7f3c',
  }) as unknown as Approval;

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-2026-0823-0412',
    received_at: '2026-08-23T11:54:07.000Z',
    state: 'awaiting_approval',
    severity: 'high',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    source_ip: '185.220.101.47',
    dest_ip: '10.12.4.31',
    host: 'srv-bastion-01',
    raw_log: 'Aug 23 11:54:07 web01 sshd[2211]: Accepted password for root',
    shadow_mode: false,
    executed: false,
    routing_outcome: null,
    enrichment: null,
    enrichment_meta: null,
    decision: decision(),
    approval: pending(),
    audit: null,
    stages: [],
    errors: [],
    attack: [],
    dwell_ms: null,
    ...over,
  }) as unknown as AlertCase;

const mount = (over: Partial<AlertCase> = {}) =>
  render(
    <I18nProvider>
      <CaseView alertCase={kase(over)} onRefresh={() => {}} />
    </I18nProvider>,
  );

/** Every `grid-template-columns` this stylesheet declares for the card's grid. */
function cardTracks(sheet: string): string[] {
  const out: string[] = [];
  const blocks = sheet.matchAll(/\.soc-case-layout\s*\{([^}]*)\}/g);
  for (const b of blocks) {
    const decl = /grid-template-columns\s*:\s*([^;}]+)/.exec(b[1]);
    if (decl) out.push(decl[1].trim());
  }
  return out;
}

/* ==========================================================================
 * 1. The grid track
 * ========================================================================== */

describe("the card's grid, at a phone width", () => {
  it('lets every one of its tracks shrink below the content min-content', () => {
    // Written over EVERY declaration, not over the one somebody edited. The
    // sheet held two byte-identical copies of the one-column override and the
    // later one won, so a fix aimed at the first measured zero: patching it
    // alone left 401 335 401 386 320 386 386 at 320 px and the track at
    // 389.047 px. A list that re-grows is covered the day it re-grows.
    const tracks = cardTracks(css());
    expect(tracks.length, '.soc-case-layout declares no grid-template-columns at all').toBeGreaterThan(0);
    for (const t of tracks) {
      expect(t, `a track of \`${t}\` floors at min-content: write minmax(0, …)`).toMatch(/^minmax\(\s*0\s*,/);
    }
  });

  it('is what the card renders its two columns in', () => {
    // The coupling half, and it passes before and after. A rule aimed at
    // markup that has moved is an orphan, which is what the duplicate was.
    const { container } = mount();
    expect(container.querySelector('.soc-case-layout')).toBeTruthy();
  });
});

/* ==========================================================================
 * 2. The data-lineage chip
 * ========================================================================== */

describe('the fields the model leaned on, at a phone width', () => {
  it('may break, in one of the two spellings that change min-content', () => {
    const block = /\.soc-lineage li\s*\{([^}]*)\}/.exec(css());
    expect(block, '.soc-lineage li has no rule at all').toBeTruthy();
    expect(block![1]).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });

  it('is not written in the spelling that leaves min-content where it was', () => {
    // THE SPELLING TRAP, measured: `overflow-wrap: break-word` on this element
    // gives 386 px at 320, unchanged. It wraps the visible line and takes no
    // part in min-content sizing, so the track goes on being floored — and it
    // reads, in a diff, exactly like the fix.
    const block = /\.soc-lineage li\s*\{([^}]*)\}/.exec(css());
    expect(block![1]).not.toMatch(/overflow-wrap:\s*break-word/);
  });

  it('is where the card prints the dotted paths', () => {
    const { container } = mount();
    const chip = screen.getByText(LINEAGE_PATH);
    expect(chip.tagName).toBe('LI');
    expect(chip.closest('.soc-lineage')).toBeTruthy();
    expect(container.querySelectorAll('.soc-lineage li').length).toBeGreaterThan(1);
  });
});

/* ==========================================================================
 * 3. The action pill
 * ========================================================================== */

describe('the action a human is asked to authorise, at a phone width', () => {
  it('wraps, and says so by naming both classes', () => {
    // `.soc-pill` is (0,1,0); a bare `.soc-pill-phrase` is (0,1,0) too and
    // would win only by source order. Specificity is the half the next edit
    // cannot silently change.
    expect(css()).toMatch(/\.soc-pill\.soc-pill-phrase\s*\{[^}]*white-space:\s*normal/);
  });

  it('does not make every pill in the console wrap', () => {
    // THE BOUNDARY, and it passes before and after on purpose. The plausible
    // wrong fix measures 386 px at 320 — six of seven cases still overflowing
    // — and buys that nothing by letting a severity wrap mid-word in a
    // forty-row table. `nowrap` on the base class is correct and stays.
    const base = /\.soc-pill\s*\{([^}]*)\}/.exec(css());
    expect(base, '.soc-pill has no rule at all').toBeTruthy();
    expect(base![1]).toMatch(/white-space:\s*nowrap/);
  });

  it('is the pill the approval head puts the catalogue label in', () => {
    // Scoped to the approval panel, because the card prints this same label
    // TWICE: here, and as plain text under « Proposed action » inside
    // `.soc-case-meta`. That second one is not a defect and needs no modifier
    // — it sits in a wrapping flex row and breaks between words on its own,
    // which is exactly what the pill's `nowrap` was preventing.
    const { container } = mount();
    const head = container.querySelector('.soc-approval .soc-panel-head')!;
    expect(head, 'the approval head is not where it was').toBeTruthy();
    const pill = within(head as HTMLElement).getByText(cat.queue.actions.isolate_host_temporary);
    expect(pill.className).toContain('soc-pill');
    expect(pill.className).toContain('soc-pill-phrase');
  });

  it('carries a label that is a phrase, which is why the rule exists', () => {
    // The premise. The pill's `nowrap` is only a defect because the closed
    // action catalogue's labels are sentences rather than the one-word states
    // pills were built for — the longest is forty-one characters.
    const longest = Math.max(...Object.values(cat.queue.actions).map((s) => s.length));
    expect(longest).toBeGreaterThan(30);
  });

  it('leaves the severity pill alone', () => {
    // The other half of the boundary, on the markup rather than the sheet: the
    // card's severity pill holds one word and must not pick the modifier up.
    const { container } = mount();
    const sev = container.querySelector('.soc-case-title .soc-pill');
    expect(sev).toBeTruthy();
    expect(sev!.className).not.toContain('soc-pill-phrase');
  });
});
