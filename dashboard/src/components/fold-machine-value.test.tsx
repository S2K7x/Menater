/**
 * @vitest-environment jsdom
 */
/**
 * A fold title that SHOUTED a filesystem path, on the screen that tells an
 * operator which file to paste into.
 *
 * ============================================================================
 * TWO DEFECTS ON ONE LINE, AND THEY HAVE THE SAME CAUSE
 *
 * Settings → Ingestion → Sources builds the Wazuh setup block from what the
 * console already knows, so that nobody retypes a path out of a README. The
 * configuration fold is titled `Paste into ${configFile}` — and
 * `.soc-fold > summary` carries `text-transform: uppercase`, because a fold
 * title is a heading and headings in this product take the display register.
 *
 * 1. THE VALUE IS REWRITTEN. What renders is
 *    `PASTE INTO /VAR/OSSEC/ETC/OSSEC.CONF`. On the machine this sentence is
 *    an instruction for, that is not the file: paths are case-sensitive
 *    everywhere Wazuh runs. CLAUDE.md already carries this trap once — *« a
 *    heading that is a VALUE, shouted back in display capitals »*, for the
 *    systems view's repository URL — and the rule it states is that a NAME
 *    may take the display register and a VALUE keeps its spelling. This is
 *    the second instance, and `DESIGN.md`'s typeface table says what the
 *    value should look like instead: mono means *« this string came from the
 *    machine, and it is exact »*.
 *
 * 2. THE PAGE SCROLLS SIDEWAYS. `/VAR/OSSEC/ETC/OSSEC.CONF` is a
 *    twenty-five-character token with nowhere to break, inside a `display:
 *    flex` summary that does not wrap — so the summary's min-content is the
 *    SUM of chevron, title and hint. Measured in Chromium 1243 on this
 *    repository's own build: **312.8 px of min-content in 270 px of room**,
 *    `document.documentElement.scrollWidth` **338** at a 320 px viewport.
 *    WCAG 2.2 § 1.4.10 (Reflow, level AA), and the LAST horizontal overflow
 *    in this console — 1 of 183 views swept at 320 / 375 / 1280 px.
 *
 * Both are the same fact: a machine value was put in a heading without being
 * marked as one. Marking it fixes both, and `ROADMAP` § 7's standing entry on
 * this fold is answered by the mark rather than by the primitive.
 *
 * ============================================================================
 * WHY NOT THE PRIMITIVE — MEASURED, NOT ARGUED
 *
 * § 7 proposed `flex-wrap: wrap` on `.soc-fold > summary`, reasoning from the
 * `.soc-lang-wide` fix. Driven over all 183 views it takes the overflow to
 * zero and **changes 18 of them**, and two of the changes are regressions on
 * screens that had no defect:
 *
 *   - the chevron is a flex ITEM, so once the line wraps it is orphaned on a
 *     line of its own, above the title it points at (Settings → Ingestion at
 *     375 px, screenshotted before deciding);
 *   - the tunnel fold goes 64 → 107.5 px there, for a title that fitted.
 *
 * `overflow-wrap: anywhere` on the summary is worse in a quieter way: it
 * changes the min-content of every item, so the flex shrink distribution
 * moves and the Code tab's « 3 CONNECTING THE DOTS » breaks as
 * `CONNECTI / NG` — 75.3 → 92.2 px — on a fold that fitted. The hint breaks
 * too (« 10 / line / s »), because the property inherits.
 *
 * The honest reading is that the primitive is NOT broken: a fold title and a
 * fold hint are prose, and prose wraps at its spaces. What cannot wrap is a
 * machine value, and this stylesheet already says so for every other one it
 * prints — `.soc-health-item code`, `.soc-hash`, `.soc-kv dd`,
 * `.soc-intel-value`. The mirror of a rule is not the rule, one element over.
 *
 * ============================================================================
 * WHY THE TESTS READ `styles.css`
 *
 * jsdom applies no cascade and computes no layout, so `text-transform` and
 * `scrollWidth` are both unreadable here. Three files already read the
 * stylesheet for exactly that reason (`readability.test.tsx`,
 * `mark.test.tsx`, `narrow-viewport.test.tsx`), and each claim below comes in
 * a PAIR, the way that last one establishes: the stylesheet carries the rule,
 * AND the component puts the value inside the element the rule names. A rule
 * nothing wears is the orphan this project has already paid for twice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { SourcesPanel } from './SettingsSetup.tsx';
import { api } from '../lib/api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const css = (): string => readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');

/** The path the console prints, in the shape `normalize.ts` ships it. */
const CONFIG_FILE = '/var/ossec/etc/ossec.conf';

const SOURCES = {
  sources: [
    {
      source: 'wazuh',
      label: 'Wazuh',
      endpoint: 'http://localhost:4400/api/ingest/wazuh',
      setup: {
        install: ['scp integrations/wazuh/custom-menater root@HOST:/var/ossec/'],
        configFile: CONFIG_FILE,
        config: '<integration>\n  <name>custom-menater</name>\n</integration>',
        verify: 'tail -f /var/ossec/logs/integrations.log',
      },
      fields: { alert_id: 'id' },
    },
  ],
};

const mount = async (): Promise<HTMLElement> => {
  vi.spyOn(api, 'ingestSources').mockResolvedValue(SOURCES as never);
  const { container } = render(<SourcesPanel />);
  await waitFor(() => expect(container.querySelector('.soc-fold')).toBeTruthy());
  return container;
};

/* ==========================================================================
 * 1. The value keeps its spelling
 * ========================================================================== */

describe('the path a fold title names', () => {
  it('is marked as a value rather than left to the title register', async () => {
    // The coupling half. A class the markup does not wear is a rule that
    // costs bytes and fixes nothing — which is what the 760 px one-column
    // override had become on the diagnostic card.
    const container = await mount();
    const value = container.querySelector('.soc-fold-value');
    expect(value, 'the configuration fold prints its path with no mark on it').toBeTruthy();
    expect(value!.textContent).toBe(CONFIG_FILE);
    expect(value!.closest('summary')).toBeTruthy();
  });

  it('shares ONE flex item with the sentence that introduces it', async () => {
    // `.soc-fold > summary` is `display: flex`, so two sibling nodes in it
    // are two COLUMNS, not a sentence. Measured in Chromium at 320 px with
    // the value as a direct child: « PASTE / INTO » stacked in a column of
    // its own beside the path. The wrapper is what keeps the summary's
    // content inline, and it is invisible in a diff — hence this claim.
    const container = await mount();
    const value = container.querySelector('.soc-fold-value')!;
    const label = value.parentElement!;
    expect(label.className).toContain('soc-fold-title');
    expect(label.parentElement!.tagName).toBe('SUMMARY');
    expect(label.textContent).toBe(`Paste into ${CONFIG_FILE}`);
  });

  it('keeps the case the source sent, where the title around it does not', async () => {
    // `text-transform` INHERITS, so the span needs a declaration of its own.
    // Note what this is NOT: the `.soc-field span` family of traps, where a
    // bare modifier (0,1,0) loses to a rule naming the element (0,1,1). There
    // is no competing rule ON THIS SPAN — specificity decides between rules
    // that match, and inheritance only reaches an element no rule matched. A
    // bare class is therefore enough here, and naming the element would be a
    // guard against a state that cannot occur.
    const block = /\.soc-fold-value\s*\{([^}]*)\}/.exec(css());
    expect(block, '.soc-fold-value has no rule at all').toBeTruthy();
    expect(block![1]).toMatch(/text-transform:\s*none/);
  });

  it('still leaves the heading around it in the display register', async () => {
    // THE BOUNDARY, and it passes before and after on purpose. The plausible
    // wrong fix is to drop `text-transform: uppercase` from every fold
    // summary: it removes the symptom on this one screen and takes the
    // heading register off the twenty folds in this product, which is a
    // design decision nobody asked for.
    const block = /\.soc-fold > summary\s*\{([^}]*)\}/.exec(css());
    expect(block, '.soc-fold > summary has no rule at all').toBeTruthy();
    expect(block![1]).toMatch(/text-transform:\s*uppercase/);
  });
});

/* ==========================================================================
 * 2. The value may break, so it cannot floor the page
 * ========================================================================== */

describe('the path a fold title names, at a phone width', () => {
  it('may break where the sentence around it may not', () => {
    // Measured in Chromium 1243 at 320 px, each spelling applied alone to
    // this span, reading `document.documentElement.scrollWidth`:
    //
    //     overflow-wrap: anywhere     320  ✓
    //     word-break: break-all       320  ✓
    //     overflow-wrap: break-word   338  ✗   unchanged
    //
    // Third element on which this project has measured that difference, after
    // `.soc-health-item code` and `.soc-lineage li`: only the first two take
    // part in min-content sizing, and min-content is what floors a flex line.
    // `break-word` wraps the visible line and leaves the minimum where it
    // was — a fix that reads exactly like the fix and is not one.
    const block = /\.soc-fold-value\s*\{([^}]*)\}/.exec(css());
    expect(block, '.soc-fold-value has no rule at all').toBeTruthy();
    expect(block![1]).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });

  it('does not let the fold TITLES of this product break mid-word', () => {
    // The other boundary, and it also passes before and after. Putting the
    // break on `.soc-fold > summary` fixes this screen and costs the Code
    // tab's « 3 CONNECTING THE DOTS », which measured `CONNECTI / NG` at
    // 320 px: `anywhere` moves the min-content of every item on the line, so
    // the flex shrink distribution moves with it. The break belongs to the
    // value, not to the heading that mentions it.
    const block = /\.soc-fold > summary\s*\{([^}]*)\}/.exec(css());
    expect(block![1]).not.toMatch(/overflow-wrap|word-break/);
    // And the hint is prose too: « 10 lines » must not become « 10 line/s ».
    const hint = /\.soc-fold-hint\s*\{([^}]*)\}/.exec(css());
    expect(hint, '.soc-fold-hint has no rule at all').toBeTruthy();
    expect(hint![1]).not.toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });
});

/* ==========================================================================
 * 3. What the fold still says
 * ========================================================================== */

describe('the configuration fold', () => {
  it('still says what to do with the file, and how much is inside', async () => {
    // Claim the VALUE, not the header (`CLARITY.md` § 7): the sentence and
    // the size are what the operator reads, and splitting the title into two
    // nodes must not lose either of them. `getByText` with a node matcher,
    // because the path is its own element now and the summary's text is
    // assembled from three children.
    const container = await mount();
    const summary = [...container.querySelectorAll('.soc-fold > summary')].find((s) =>
      s.textContent?.includes(CONFIG_FILE),
    );
    expect(summary, 'no fold summary names the configuration file').toBeTruthy();
    expect(summary!.textContent).toContain('Paste into');
    expect(summary!.querySelector('.soc-fold-hint')?.textContent).toBe('3 lines');
  });

  it('says « Request to send » when the source has no file to paste into', async () => {
    // The generic source carries `configFile: ''`. The value element must
    // then be absent rather than empty: an empty mark is a claim that there
    // is a path, printed as nothing.
    vi.spyOn(api, 'ingestSources').mockResolvedValue({
      sources: [{ ...SOURCES.sources[0], setup: { ...SOURCES.sources[0]!.setup, configFile: '' } }],
    } as never);
    const { container } = render(<SourcesPanel />);
    expect(await screen.findByText('Request to send')).toBeTruthy();
    expect(container.querySelector('.soc-fold-value')).toBeNull();
  });
});
