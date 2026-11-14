/**
 * @vitest-environment jsdom
 */
/**
 * Settings → Code analysis: five sections, and a heading for none of them.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * This screen is six blocks. The first one holds the engine picker and names
 * itself (`ProviderSwitcher` renders an `h3`). The other five are `Fold`s, and
 * a `Fold`'s title is whatever the call site passes into its `<summary>` — so
 * *How findings are routed*, *What is already known*, *How scans start*,
 * *What you see* and *Status* were plain text. Those five are what somebody
 * comes to this screen to find.
 *
 * Measured in Chromium 1243 — a throwaway preview page under `dashboard/`,
 * deleted in the same session, transitions killed before any sample, and the
 * AX outline WALKED from the root because `CLARITY.md` § 7 records that
 * `Accessibility.getFullAXTree`'s flat node list is not in document order:
 *
 *     BEFORE, folds shut (four of the five are, on arrival)
 *       h1 SETTINGS / h2 CODE ANALYSIS / h3 WHICH AI ENGINE?
 *       — three headings for a 1,890 px settings screen
 *
 *     BEFORE, every fold open
 *       h1 SETTINGS
 *       h2 CODE ANALYSIS
 *       h3 WHICH AI ENGINE?
 *       h4 ANALYSIS SPEED          <- belongs to « How findings are routed »
 *       h4 CONFIDENCE THRESHOLDS   <- belongs to « How findings are routed »
 *       h4 ENGINE ACCESS           <- belongs to « Status »
 *       h4 SET A KEY               <- belongs to « Status »
 *       h4 RESET                   <- belongs to « Status »
 *
 * The second reading is the one that matters, and it is worse than a missing
 * heading: the outline is WRONG. With no level 3 of their own, the five
 * sub-blocks attach to the last heading that exists — the engine picker — so
 * the document says the confidence thresholds and the reset button are parts
 * of the engine selector. A reader walking the headings is told something
 * untrue, which a missing heading at least does not do.
 *
 *     BEFORE, the analysis service not answering — the state a fresh install
 *     is in, and the one in which the Status fold OPENS ITSELF because this
 *     product refuses to file a failure behind a silent fold:
 *       h1 SETTINGS / h2 CODE ANALYSIS / h4 ENGINE ACCESS / h4 RESET
 *
 * There the level is genuinely SKIPPED, 2 to 4 — `providers` is null, so the
 * engine picker renders no `h3` at all — and `ENGINE ACCESS`, the block that
 * names which engine key is missing, is the thing the operator came to fix.
 *
 *     AFTER, every fold open
 *       h1 SETTINGS / h2 CODE ANALYSIS / h3 WHICH AI ENGINE?
 *       h3 HOW FINDINGS ARE ROUTED / h4 ANALYSIS SPEED / h4 CONFIDENCE THRESHOLDS
 *       h3 WHAT IS ALREADY KNOWN
 *       h3 HOW SCANS START
 *       h3 WHAT YOU SEE
 *       h3 STATUS / h4 ENGINE ACCESS / h4 SET A KEY / h4 RESET
 *
 * This is C0.44 (the Guide's seventeen section titles) and C0.45 (the scan
 * report's five findings) on a third screen, and the shape of the miss is the
 * transferable part: both of those were fixed as fixes to a SCREEN, so the
 * grep that finds the next one is not « who calls `Fold` » — most folds hold
 * an explanation and are right to carry no heading — but *which folds are
 * sections*. `CLAUDE.md`: the mirror of a rule is not the rule.
 *
 * ============================================================================
 * THE HEADING GOES AMONG THE SPANS, AND THE PARENT IS NAMED
 *
 * Two things this fix had to get right, and both are already paid for.
 *
 * ONE — the heading is INSIDE the `<summary>`, never wrapping it. `Fold`
 * renders a chevron span, the title, then the hint span; wrapping the whole
 * summary names the section « How findings are routed Applied on the server »,
 * after its scope label instead of after itself. C0.44 measured that on the
 * Guide (« 01 The Alerts tab 9 points ») and `CLARITY.md` § 8 carries it.
 *
 * TWO — a fold title is a NAME, so it keeps the display register it already
 * had, and the rule that gives it back names its parent. Measured on the
 * mounted screen, the summary's own type:
 *
 *     Archivo Black 13.76px / weight 400 / line-height 22.016px
 *     letter-spacing 0.8256px / uppercase
 *
 * `.vp-embed h3` would impose weight 900, line-height 1.05 and a 12px bottom
 * margin inside a flex row, and `.vp-settings-block h3` a 6px one. Both are
 * (0,1,1), so a bare `h3.vp-settings-fold-title` TIES with them and wins only
 * by sitting further down the sheet — the trap `CLARITY.md` § 8 says has cost
 * this project five times. `.vp-embed h3.vp-settings-fold-title` is (0,2,1)
 * and wins by specificity, which the next edit to the sheet cannot change.
 *
 * jsdom applies no cascade, so the rule is read out of the sheet as text, the
 * way `report-outline.test.tsx` and `narrow-viewport.test.tsx` already do —
 * with comments stripped, because the paragraph above quotes the selector it
 * hunts and a test that reads its own prose goes green on its own explanation.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { render } from '../test-utils.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { api, ApiError, type CacheState, type KeyStatus, type ScanSettingsResponse } from '../lib/api.ts';
import type { ProviderAvailability, ProviderSettings } from './ProviderSwitcher.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HERE = import.meta.dirname;

/** Source with its comments stripped. A test must not read its own prose. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const VP_SHEET = code(readFileSync(join(HERE, '..', 'styles.css'), 'utf8'));
const CONSOLE_SETTINGS = code(
  readFileSync(join(HERE, '..', '..', 'components', 'SettingsPage.tsx'), 'utf8'),
);

const CACHE: CacheState = {
  persisted: true,
  restored: [{ kind: 'detection', kept: 12, dropped: 0, why: null }],
  detection: { entries: 12, hits: 7, misses: 3, expired: 0 },
  arbitration: { entries: 4, hits: 2, misses: 1, expired: 0 },
};

const SCAN: ScanSettingsResponse = {
  settings: { bypassClaudeForHighConfidence: false, detectionConcurrency: 4 },
  thresholds: { reject_below: 0.4, direct_alert_above: 0.7 },
  limits: { concurrency: { min: 1, max: 16 } },
  cache: CACHE,
};

const PROVIDERS: { settings: ProviderSettings; available: ProviderAvailability[] } = {
  settings: { nodeProvider: 'anthropic', masterProvider: 'anthropic' },
  available: [
    { id: 'anthropic', available: true, why: null },
    { id: 'gemini', available: false, why: 'GEMINI_API_KEY is not set.' },
  ],
};

const KEYS: KeyStatus[] = [
  { name: 'ANTHROPIC_API_KEY', set: true, source: 'store', locked: false },
  { name: 'GEMINI_API_KEY', set: false, source: 'none', locked: false },
];

/**
 * The screen as the console mounts it: `SettingsPage.tsx` wraps the section in
 * a `.soc-panel` whose own title is an `h2`. The host is reproduced here
 * because the claim about the fold titles' LEVEL is relative to it — and the
 * level it is relative to is PINNED from that file below, so this fixture
 * cannot quietly stop describing the product.
 */
function mount(props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return render(
    <section className="soc-panel">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">Engines</span>
          <h2>Code analysis</h2>
        </div>
      </div>
      <SettingsPage
        providers={PROVIDERS}
        onProviderChange={async () => {}}
        keys={KEYS}
        onKeysApplied={() => {}}
        busy={false}
        {...props}
      />
    </section>,
  );
}

/** Every heading the screen rendered, in document order, with its level. */
const outline = (root: HTMLElement): Array<{ lvl: number; text: string }> =>
  [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    lvl: Number(h.tagName[1]),
    text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));

/** The section folds, i.e. `Fold` — never `Explain`'s circled "i". */
const sectionFolds = (root: HTMLElement): HTMLDetailsElement[] =>
  [...root.querySelectorAll<HTMLDetailsElement>('details.soc-fold')];

beforeEach(() => {
  vi.spyOn(api, 'getScanSettings').mockResolvedValue(SCAN);
});

/** Mounts, lets the pending settings read land, and hands back the root. */
async function settled(props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  const { container } = mount(props);
  // One empty act scope drains React's pending work rather than polling:
  // `waitFor` would make the positive claims pass eventually and leave the
  // negative ones vacuous. Same device as `intel-panel.test.tsx`.
  const { act } = await import('@testing-library/react');
  await act(async () => {});
  return container;
}

/* ==========================================================================
 * The five sections name themselves
 * ========================================================================== */

describe('every section of this screen is a heading', () => {
  it('renders the five folds at all', async () => {
    // The vacuity guard. A subtraction over an empty set proves nothing, and
    // the claim below is a subtraction on purpose: a SIXTH section is covered
    // the day somebody writes it, where a list of five titles would not be.
    const root = await settled();
    expect(sectionFolds(root).length).toBe(5);
  });

  it('gives every section fold a heading inside its summary', async () => {
    const root = await settled();
    const missing = sectionFolds(root)
      .filter((d) => !d.querySelector('summary > h1, summary > h2, summary > h3, summary > h4'))
      .map((d) => (d.querySelector('summary')?.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(missing, `sections with no heading: ${missing.join(' | ')}`).toEqual([]);
  });

  it('puts the heading AMONG the summary, never around it', async () => {
    // C0.44's lesson. Wrapping the summary names the section after the scope
    // label the hint carries — « How findings are routed Applied on the
    // server » — instead of after itself.
    const root = await settled();
    for (const fold of sectionFolds(root)) {
      const head = fold.querySelector('summary h1, summary h2, summary h3, summary h4');
      expect(head).not.toBeNull();
      expect(head!.querySelector('summary')).toBeNull();
      expect(head!.textContent).not.toMatch(/Applied on the server|Kept in this browser/i);
    }
  });

  it('names them at level 3: under the host, over the sub-blocks', async () => {
    const root = await settled();
    const titles = sectionFolds(root).map((d) =>
      d.querySelector('summary h1, summary h2, summary h3, summary h4')!,
    );
    for (const h of titles) expect(h.tagName).toBe('H3');
  });

  it('is relative to a host this test does not get to choose', async () => {
    // The level above is 3 because the console puts this section under an
    // `h2`. Pinned from the file that writes it, so the fixture cannot drift:
    // if the host is ever promoted, this fails and asks for the fold titles
    // to move with it rather than silently describing another product.
    const host = CONSOLE_SETTINGS.slice(CONSOLE_SETTINGS.indexOf('st.code.kicker'));
    expect(host).toMatch(/<h2>\{st\.code\.title\}<\/h2>/);
  });
});

/* ==========================================================================
 * The outline, in document order
 * ========================================================================== */

describe('the outline it hands a reader', () => {
  it('skips no level, over an outline deep enough for the claim to mean something', async () => {
    const root = await settled();
    for (const fold of sectionFolds(root)) fold.open = true;
    const { act } = await import('@testing-library/react');
    await act(async () => {});

    const heads = outline(root);
    // The floor. « No level is skipped » passes perfectly on a screen carrying
    // ONE heading — which is the state the Guide was in, and `CLARITY.md` § 7
    // records it as the way this exact claim goes green over the defect it
    // was written for. Nine: the host, the engine picker, five sections and
    // the five sub-blocks, less the two the fixture does not reach.
    expect(heads.length).toBeGreaterThanOrEqual(9);

    let prev = heads[0]!.lvl;
    for (const h of heads.slice(1)) {
      expect(h.lvl, `"${h.text}" (h${h.lvl}) after level ${prev}`).toBeLessThanOrEqual(prev + 1);
      prev = h.lvl;
    }
  });

  it('puts each sub-block under the section it belongs to', async () => {
    // The half a « no skipped level » claim cannot see. Before the fix the
    // outline was not merely missing a level, it was WRONG: with no heading of
    // their own the five sub-blocks attached to the engine picker, so the
    // document said the confidence thresholds were part of the engine
    // selector. What is asserted is the containment — the heading that
    // precedes a sub-block is its own section's.
    const root = await settled();
    for (const fold of sectionFolds(root)) fold.open = true;
    const { act } = await import('@testing-library/react');
    await act(async () => {});

    const subheads = [...root.querySelectorAll('h4')];
    expect(subheads.length).toBeGreaterThanOrEqual(3);
    for (const sub of subheads) {
      const fold = sub.closest('details.soc-fold');
      expect(fold, `"${sub.textContent}" is in no section fold`).not.toBeNull();
      const title = fold!.querySelector('summary h3');
      expect(title, `"${sub.textContent}" sits in a section with no heading`).not.toBeNull();
      expect(Number(title!.tagName[1])).toBe(Number(sub.tagName[1]) - 1);
    }
  });

  it('does not skip when the analysis service is not answering', async () => {
    // The sharpest state, and the one the product opens a fold for. With the
    // settings read refused, `providers` is null — so the engine picker
    // renders no `h3` — the cache fold is absent, and the Status fold opens
    // ITSELF. Measured before the fix: h1 h2 h4 h4, a skipped level on the
    // screen somebody was just sent to.
    vi.spyOn(api, 'getScanSettings').mockRejectedValue(
      new ApiError('ECONNREFUSED', 'The analysis service is not answering.'),
    );
    const root = await settled({ providers: null, keys: null, onKeysApplied: undefined });

    // The premise: the failure really did open the Status fold by itself.
    const open = sectionFolds(root).filter((d) => d.open);
    expect(open.length).toBe(1);

    const heads = outline(root);
    expect(heads.length).toBeGreaterThanOrEqual(5);
    let prev = heads[0]!.lvl;
    for (const h of heads.slice(1)) {
      expect(h.lvl, `"${h.text}" (h${h.lvl}) after level ${prev}`).toBeLessThanOrEqual(prev + 1);
      prev = h.lvl;
    }
  });
});

/* ==========================================================================
 * The boundaries — these pass BEFORE and after, on purpose
 * ========================================================================== */

describe('what this fix deliberately does not touch', () => {
  it('leaves the circled "i" alone', async () => {
    // `Explain` is a `<details>` too. A fix written as « a summary is a
    // heading » would make every popover trigger on this screen a heading,
    // which buys noise with the same keystroke. The discs are `.soc-info`;
    // only `.soc-fold` is a section.
    const root = await settled();
    const discs = [...root.querySelectorAll('details.soc-info')];
    expect(discs.length).toBeGreaterThan(0);
    for (const disc of discs) {
      expect(disc.querySelector('summary h1, summary h2, summary h3, summary h4')).toBeNull();
    }
  });

  it('leaves the sub-blocks at level 4, with their own quiet register', async () => {
    const root = await settled();
    for (const fold of sectionFolds(root)) fold.open = true;
    const { act } = await import('@testing-library/react');
    await act(async () => {});

    const subheads = [...root.querySelectorAll('.vp-settings-subhead')];
    expect(subheads.length).toBeGreaterThanOrEqual(3);
    for (const sub of subheads) expect(sub.tagName).toBe('H4');
  });

  it('keeps the engine picker naming itself, as it already did', async () => {
    const root = await settled();
    const picker = [...root.querySelectorAll('h3')].filter((h) => !h.closest('summary'));
    expect(picker.length).toBeGreaterThan(0);
  });

  it('keeps every section title readable as itself', async () => {
    // A regrouping, not a deletion: the five sentences are still on screen.
    await settled();
    for (const title of [
      'How findings are routed',
      'What is already known',
      'How scans start',
      'What you see',
      'Status',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });
});

/* ==========================================================================
 * The stylesheet: a name keeps the register it already had
 * ========================================================================== */

describe('the rule that gives the title its type back', () => {
  const RULE = /\.vp-embed\s+h3\.vp-settings-fold-title\s*\{([^}]*)\}/;

  it('names its parent rather than being written as a bare class', () => {
    // (0,2,1). `.vp-embed h3` and `.vp-settings-block h3` are both (0,1,1), so
    // a bare `h3.vp-settings-fold-title` ties with them and wins on source
    // order alone — the trap `CLARITY.md` § 8 records as having cost this
    // project five times.
    //
    // The claim is made over EVERY selector that mentions the class, not over
    // the one spelling this fix happened to write: a second, bare declaration
    // added later would tie again, and the first version of this assertion was
    // a near-miss regex that matched the correct form and could not tell the
    // two apart.
    const selectors = [...VP_SHEET.matchAll(/([^{}]*vp-settings-fold-title[^{}]*)\{/g)].map(
      (m) => m[1]!.trim(),
    );
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, `${selector} does not name a parent`).toMatch(/\.vp-embed\s/);
    }
    expect(VP_SHEET).toMatch(RULE);
  });

  it('takes the three properties the heading rules would have imposed', () => {
    // Measured on the mounted summary: Archivo Black 13.76px / weight 400 /
    // line-height 22.016px / letter-spacing 0.8256px / uppercase. `font` and
    // `letter-spacing` inherit it whole; `margin: 0` is the third, because
    // both heading rules put a bottom margin on a flex-row item.
    const body = VP_SHEET.match(RULE)![1]!;
    expect(body).toMatch(/font:\s*inherit/);
    expect(body).toMatch(/letter-spacing:\s*inherit/);
    expect(body).toMatch(/margin:\s*0/);
  });

  it('is written before the sheet runs out of media queries', () => {
    // `CLARITY.md` § 8: a rule appended at the END of a stylesheet lands after
    // the `@media` blocks, so it silently cancels the narrow overrides. This
    // one sits with the settings rules it modifies.
    const at = VP_SHEET.search(RULE);
    expect(at).toBeGreaterThan(0);
    expect(VP_SHEET.indexOf('@media', at)).toBeGreaterThan(at);
  });
});
