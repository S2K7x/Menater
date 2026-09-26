/**
 * @vitest-environment jsdom
 */
/**
 * The console scrolled sideways on a phone, at three places.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * `CLARITY.md` § 9 asks of every screen change: *« does it hold at 390 px with
 * no horizontal overflow? »* WCAG 2.2 § 1.4.10 (Reflow, level AA) asks the
 * same question at **320 CSS px** — the width the criterion names, and the one
 * a 375 px phone reaches at 125 % zoom. Three places failed it, and all three
 * were found the way `CLARITY.md` § 7 prescribes: the real application, driven
 * in a real browser, at a real viewport, rather than read.
 *
 * Measured in Chromium on this repository's own build, reading
 * `document.documentElement.scrollWidth` on every tab and every sub-tab, with
 * the transitions killed first (§ 7 again — a sampled cross-fade is a bug in
 * the ruler, not a finding):
 *
 *     viewport          BEFORE                            AFTER
 *     320 px            Ingestion 330, Health 529,         every tab: 320
 *                       Settings → MCP 546
 *     375 px            Health 529, Settings → MCP 546     every tab: 375
 *     390 px            clean                              clean
 *     1280 px           clean                              clean, byte-identical
 *
 * The desktop half of the same sweep is byte-identical before and after, panel
 * heights included: nothing here changes what anyone sees on a laptop.
 *
 * ============================================================================
 * 1. A GRID ITEM IS NEVER NARROWER THAN ITS LONGEST UNBREAKABLE WORD
 *
 * The diagnostic card prints the engine's address —
 * `postgresql://n8n_soc:********@localhost:5432/menater`, fifty-one characters
 * with nowhere to break. A grid item has `min-width: auto`, so that token
 * becomes the item's automatic minimum size, and the track is floored by it:
 * the single column measured **503.6 px** inside a 325 px grid.
 *
 * `styles.css` already carried a responsive override written for exactly this
 * case — `@media (max-width: 760px) { .soc-health-grid { grid-template-columns:
 * 1fr } }` — and it cannot work, which is the part worth remembering. It
 * chooses how many tracks there are, not how narrow one is allowed to become.
 * Measured, each remedy applied alone at 375 px:
 *
 *     .soc-health-item { min-width: 0 }                  512 px  (track 325, string still out)
 *     minmax(min(260px, 100%), 1fr)                      512 px  (same)
 *     .soc-health-item code { overflow-wrap: anywhere }  375 px  ✓
 *
 * So the track was never the whole story: the value has to be allowed to
 * break. Which the rest of this stylesheet already does for every other
 * machine value it shows — `.soc-hash`, `.soc-kv dd`, `.soc-intel-value`.
 * **The mirror of a rule is not the rule**, one card over.
 *
 * ============================================================================
 * 2. A NO-WRAP FLEX LINE IS AS WIDE AS THE SUM OF ITS BUTTONS
 *
 * `.soc-lang.soc-lang-wide` is the console's segmented picker, and it is
 * SHARED: a rule's action and its severity, the MCP client, the ingestion
 * mode, the setup wizard's source, the fast lane — six call sites. It is an
 * `inline-flex` that never wrapped, so its minimum width is the sum of its
 * buttons: Settings → MCP's four client names made the group 521 px wide and
 * took the page with them, and the Ingestion tab's fast lane did the same
 * thing at 320 px.
 *
 * Wrapping costs nothing while there is room and it fixes all six at once —
 * where shortening the one label that happened to overflow fixes only the
 * screen somebody was looking at. Two of the six had already failed.
 *
 * ============================================================================
 * 3. AND THE THIRD IS THE FIRST AGAIN, IN PROSE
 *
 * Under Claude Desktop's configuration block sits the sentence naming the file
 * to paste into, on both platforms. `%APPDATA%\Claude\claude_desktop_config
 * .json` is a forty-three-character word in the middle of it: the paragraph's
 * min-content came to 302 px where it had 270, so the page scrolled at 320 px
 * and not at 375. A width that passes is not a width that has margin.
 *
 * ============================================================================
 * WHY THE TESTS READ `styles.css`
 *
 * jsdom applies no cascade and computes no layout: `scrollWidth` is 0 there
 * for everything, so the suite cannot measure this. Two files here already
 * read the stylesheet for that reason (`readability.test.tsx`,
 * `mark.test.tsx`), and the numbers above come from the browser instead.
 *
 * A rule that exists is not a rule that reaches anything, so each of the three
 * comes in a pair: the stylesheet carries it, AND the component puts the value
 * inside the element it names. The second half of each pair passes before and
 * after — it is what stops the rule being quietly orphaned by a markup change,
 * which is exactly what the 760 px override had become.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { HealthPanel } from './HealthPanel.tsx';
import { McpPanel } from './McpPanel.tsx';
import type { HealthReport } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const css = (): string => readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');

/** The address the diagnostic prints, in the shape the server sends it. */
const ENGINE_URL = 'postgresql://n8n_soc:********@localhost:5432/menater';

const health = (): HealthReport => ({
  mode: 'demo',
  engine: {
    reachable: false,
    url: ENGINE_URL,
    detail: 'Pipeline unreachable: Database (SELECT): connect ECONNREFUSED 127.0.0.1:5432',
  },
  workflows: [],
  audit_db: { healthy: false, detail: 'Unknown on sample data' },
  blocking_findings: [],
  checked_at: '2026-09-26T00:00:00Z',
});

/* ==========================================================================
 * 1. The diagnostic card
 * ========================================================================== */

describe('the diagnostic card, at a phone width', () => {
  it('lets the address it prints break', () => {
    // The assertion is about BEHAVIOUR, not spelling, because the plausible
    // near-miss is a real one. Measured in Chromium at 375 px, the same rule
    // written three ways:
    //
    //     overflow-wrap: anywhere    375 px  ✓   track 325
    //     word-break: break-all      375 px  ✓   track 325
    //     overflow-wrap: break-word  529 px  ✗   track 503.6 — unchanged
    //
    // Only the first two take part in min-content sizing, and min-content is
    // precisely what floors the grid track. `break-word` wraps the visible
    // line and leaves the item's minimum where it was, so the page goes on
    // scrolling — a fix that looks applied and is not. Either of the two that
    // work is accepted; the one that does not is refused.
    const block = /\.soc-health-item code\s*\{([^}]*)\}/.exec(css());
    expect(block, '.soc-health-item code has no rule at all').toBeTruthy();
    expect(block![1]).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });

  it('prints that address where the rule reaches it', () => {
    // The half that stops the rule being orphaned. The 760 px one-column
    // override was written for this defect and never touched it; a rule aimed
    // at markup that has moved is the same thing one step later.
    const { container } = render(<HealthPanel health={health()} onRefresh={() => {}} />);
    const code = screen.getByText(ENGINE_URL);
    expect(code.tagName).toBe('CODE');
    expect(code.closest('.soc-health-item')).toBeTruthy();
    expect(container.querySelector('.soc-health-grid')).toBeTruthy();
  });

  it('does not let the sentence beside it break mid-word', () => {
    // THE BOUNDARY, and it passes before and after on purpose.
    //
    // `.soc-health-item { overflow-wrap: anywhere }` measures 375 px too, so
    // it is a plausible fix — and it would let « ECONNREFUSED » be cut in the
    // middle, and the diagnostic prose with it. A machine value is compared
    // character by character and may break anywhere; a sentence explaining
    // what is wrong is read, and is not a machine value. The rule is scoped to
    // the element that holds one.
    const sheet = css();
    const onTheCard = /\.soc-health-item\s*\{[^}]*overflow-wrap/;
    expect(sheet).not.toMatch(onTheCard);
  });
});

/* ==========================================================================
 * 2. The segmented picker, shared by six screens
 * ========================================================================== */

describe('the segmented picker, at a phone width', () => {
  it('wraps rather than widening the page', () => {
    expect(css()).toMatch(/\.soc-lang-wide\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('is what the MCP page offers its four clients in', async () => {
    // The coupling half again. Four buttons whose labels carry a file path
    // (« VS Code — .vscode/mcp.json ») are what made this group 521 px wide,
    // and `CLAUDE.md` keeps all four deliberately: « offering one and calling
    // the rest similar turns five minutes into an afternoon. » So the group
    // has to wrap; shortening the labels is not on the table.
    const { container } = render(
      <McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />,
    );
    await waitFor(() => expect(container.querySelector('.soc-lang-wide')).toBeTruthy());
    const group = container.querySelector('.soc-lang.soc-lang-wide') as HTMLElement;
    expect(group.querySelectorAll('button').length).toBeGreaterThanOrEqual(4);
  });
});

/* ==========================================================================
 * 3. The install page's file path
 * ========================================================================== */

describe('the path to paste into, at a phone width', () => {
  it('may break where the sentence around it may not', () => {
    const block = /\.soc-mcp-path\s*\{([^}]*)\}/.exec(css());
    expect(block, '.soc-mcp-path has no rule at all').toBeTruthy();
    expect(block![1]).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });

  it('is the paragraph the MCP page prints under Claude Desktop', () => {
    // Claude Desktop is the default client, so this paragraph is what the page
    // opens on. The coupling half: a class nothing wears is a rule that costs
    // bytes and fixes nothing.
    const { container } = render(
      <McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />,
    );
    const p = container.querySelector('.soc-mcp-path');
    expect(p).toBeTruthy();
    expect(p!.textContent).toContain('claude_desktop_config.json');
  });
});
