/**
 * @vitest-environment jsdom
 */
/**
 * A composite role promises a keyboard. Two of this product's three composite
 * widgets promised one and had none.
 *
 * ============================================================================
 * WHAT WAS MEASURED
 *
 * `section-tabs.test.tsx` was written because `role="tab"` announces a
 * contract — one stop in the tab order, the arrows choose inside it, a panel
 * is what the tab controls — and four call sites declared it while
 * implementing none of it. It fixed `SectionTabs`, which is the console's
 * sub-navigation, and it looked nowhere else. There are two other composite
 * widgets in this application, one per half, and both were in the same state.
 * Mounted and driven, before this change:
 *
 *   ThemePicker   role="radiogroup", 6 × role="radio"
 *                 tab stops: 6 of 6      ArrowRight/Down/Home/End: nothing
 *   ScanLauncher  role="tablist",    3 × role="tab"
 *                 tab stops: 3 of 3      ArrowRight/Left/Home/End: nothing
 *
 * Six stops before the first setting on the theme grid, three before the field
 * you came to the Code tab to fill — and in both cases a screen reader had
 * just told its user that an arrow key chooses here. A key you have been told
 * works, that does nothing, does not read as a missing feature. It reads as a
 * broken page.
 *
 * ============================================================================
 * WHY THE TWO WIDGETS ANSWER TO DIFFERENT KEYS
 *
 * The tab bar takes Left and Right only: it is horizontal, and `SectionTabs`
 * documents why Up, Down and the page keys stay with the browser. A radio
 * group takes all four, because a native `<input type="radio">` group does —
 * ignoring Up and Down under `role="radio"` would be a second, quieter lie.
 * `arrowTarget`'s axis argument is that difference, and it is asserted in both
 * directions here.
 *
 * ============================================================================
 * THE BOUNDARY, WHICH IS HALF THE POINT
 *
 * Six segmented pickers in this product wear `role="group"` and `aria-pressed`
 * buttons. `group` promises nothing beyond grouping, so every button there is
 * legitimately its own tab stop and no arrow key is owed. The last test claims
 * that side and passes BEFORE and after this change, on purpose: it is what
 * stops the next person "finishing the job" by making six honest pickers
 * swallow keys they never promised.
 * ============================================================================
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { arrowTarget } from './arrow-keys.ts';
import { McpPanel } from './McpPanel.tsx';
import { ThemePicker } from '../theme/ThemePicker.tsx';
import { THEMES } from '../theme/context.tsx';
import { ScanLauncher } from '../vulnpipe/components/ScanLauncher.tsx';

afterEach(cleanup);

/**
 * The members of a composite widget that are stops in the tab order.
 *
 * `tabIndex >= 0` is the whole question: a roving tabindex leaves exactly one,
 * and the browser default leaves every one of them.
 */
const stops = (items: HTMLElement[]): HTMLElement[] => items.filter((el) => el.tabIndex >= 0);

const radios = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="radio"]'),
];

const tabs = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="tab"]'),
];

const checked = (items: HTMLElement[]): number =>
  items.findIndex((el) => el.getAttribute('aria-checked') === 'true');

const selected = (items: HTMLElement[]): number =>
  items.findIndex((el) => el.getAttribute('aria-selected') === 'true');

/* ==========================================================================
 * 1. The theme grid — a radio group in the console half
 * ========================================================================== */

describe('the theme grid keeps the promise `role="radiogroup"` makes', () => {
  it('is ONE stop in the tab order, and it is the chosen theme', () => {
    const { container } = render(<ThemePicker />);
    const items = radios(container);
    expect(items.length).toBe(THEMES.length);
    expect(stops(items)).toHaveLength(1);
    expect(stops(items)[0]).toBe(items[checked(items)]);
  });

  it('ArrowRight chooses the next theme, applies it, and takes the focus with it', async () => {
    const { container } = render(<ThemePicker />);
    const items = radios(container);
    items[0].focus();

    await userEvent.keyboard('{ArrowRight}');

    // The VALUE, not the attribute: the theme is really applied, which is what
    // `data-theme` on <html> is.
    expect(document.documentElement.getAttribute('data-theme')).toBe(THEMES[1]);
    expect(checked(radios(container))).toBe(1);
    expect(document.activeElement).toBe(radios(container)[1]);
  });

  it('answers to Up and Down as well, because a radio group is not a tab bar', async () => {
    const { container } = render(<ThemePicker />);
    radios(container)[0].focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(checked(radios(container))).toBe(1);

    await userEvent.keyboard('{ArrowUp}');
    expect(checked(radios(container))).toBe(0);
  });

  it('wraps at both ends, and Home and End reach them directly', async () => {
    const { container } = render(<ThemePicker />);
    const last = THEMES.length - 1;
    radios(container)[0].focus();

    // A group that stops dead makes its last item the hardest to reach.
    await userEvent.keyboard('{ArrowLeft}');
    expect(checked(radios(container))).toBe(last);

    await userEvent.keyboard('{Home}');
    expect(checked(radios(container))).toBe(0);

    await userEvent.keyboard('{End}');
    expect(checked(radios(container))).toBe(last);
  });
});

/* ==========================================================================
 * 2. The scan launcher — a tab bar in the code-analysis half
 * ========================================================================== */

describe('the launcher tab bar keeps the promise `role="tablist"` makes', () => {
  it('is ONE stop in the tab order, and it is the selected tab', () => {
    const { container } = render(<ScanLauncher onLaunch={() => {}} />);
    const items = tabs(container);
    expect(items.length).toBe(3);
    expect(stops(items)).toHaveLength(1);
    expect(stops(items)[0]).toBe(items[selected(items)]);
  });

  it('ArrowRight selects the next target, and the question below follows it', async () => {
    const { container } = render(<ScanLauncher onLaunch={() => {}} />);
    expect(screen.getByText(/Which folder do you want to check/i)).toBeTruthy();
    tabs(container)[0].focus();

    await userEvent.keyboard('{ArrowRight}');

    // What the tab CONTROLS is the field below it: claiming the value is what
    // separates a working tab bar from a moved attribute.
    expect(screen.getByText(/Which file do you want to check/i)).toBeTruthy();
    expect(selected(tabs(container))).toBe(1);
    expect(document.activeElement).toBe(tabs(container)[1]);
  });

  it('reaches the last target with End and wraps with ArrowLeft', async () => {
    const { container } = render(<ScanLauncher onLaunch={() => {}} />);
    tabs(container)[0].focus();

    await userEvent.keyboard('{End}');
    expect(selected(tabs(container))).toBe(2);
    expect(screen.getByText(/Which repository do you want to check/i)).toBeTruthy();

    await userEvent.keyboard('{ArrowRight}');
    expect(selected(tabs(container))).toBe(0);

    await userEvent.keyboard('{ArrowLeft}');
    expect(selected(tabs(container))).toBe(2);
  });

  it('leaves Up and Down to the browser, like the console tab bar', async () => {
    // Passes before AND after: the bar sits above a form that scrolls, and
    // swallowing the page's own keys is not part of what `role="tab"` promised.
    const { container } = render(<ScanLauncher onLaunch={() => {}} />);
    tabs(container)[0].focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(selected(tabs(container))).toBe(0);

    await userEvent.keyboard('{ArrowUp}');
    expect(selected(tabs(container))).toBe(0);
  });
});

/* ==========================================================================
 * 3. The axis, and the boundary
 * ========================================================================== */

describe('arrowTarget answers only for the keys the group owns', () => {
  it('leaves the vertical arrows alone on a horizontal group', () => {
    expect(arrowTarget('ArrowDown', 0, 3, 'horizontal')).toBeNull();
    expect(arrowTarget('ArrowUp', 0, 3, 'horizontal')).toBeNull();
    expect(arrowTarget('ArrowDown', 0, 3, 'both')).toBe(1);
    expect(arrowTarget('ArrowUp', 0, 3, 'both')).toBe(2);
  });

  it('ignores every other key, so nothing else is swallowed', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'PageDown', 'a']) {
      expect(arrowTarget(key, 1, 3, 'both')).toBeNull();
    }
  });
});

describe('a `role="group"` picker promises no arrow keys, and keeps none', () => {
  it('leaves all four MCP client buttons in the tab order', async () => {
    // The boundary. `group` is the honest role for a segmented picker: it
    // groups and it announces no keyboard, so Tab through them is correct and
    // there is nothing here to "finish".
    const { container } = render(
      <McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />
    );
    await waitFor(() => expect(container.querySelector('.soc-lang-wide')).toBeTruthy());
    const group = container.querySelector('.soc-lang.soc-lang-wide') as HTMLElement;

    expect(group.getAttribute('role')).toBe('group');
    const buttons = [...group.querySelectorAll<HTMLElement>('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    expect(stops(buttons)).toHaveLength(buttons.length);
  });
});
