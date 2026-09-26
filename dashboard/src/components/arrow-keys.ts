/**
 * The arrow keys of a composite widget, in one place.
 *
 * ============================================================================
 * WHY THIS IS SHARED AND NOT WRITTEN THREE TIMES
 *
 * A composite role — `tablist`, `radiogroup` — is a PROMISE read out loud
 * before anybody has pressed anything: this group is one stop in the tab
 * order, and the arrows choose inside it. Keeping that promise is the same
 * eight lines every time, and this product has already paid once for a rule
 * that lived on one call site out of several. Two of its three composite
 * widgets declared the role and implemented none of it.
 *
 * It returns an INDEX and touches no DOM: the caller owns what selecting
 * means (a theme is applied, a tab is switched) and where the focus goes.
 *
 * ============================================================================
 * WHY THE VERTICAL ARROWS ARE AN ARGUMENT AND NOT A DEFAULT
 *
 * A horizontal tablist takes Left and Right and leaves Up, Down and the page
 * keys to the browser — `SectionTabs`' bar is sticky above content that
 * scrolls, and swallowing them would take a keyboard user's own scrolling
 * away. A radio group is the other answer: a native `<input type="radio">`
 * group moves on all four arrows, so a set of buttons wearing `role="radio"`
 * that ignored Up and Down would be a second, quieter lie.
 * ============================================================================
 */

/** Which arrows the group answers to. `both` adds Up and Down. */
export type ArrowAxis = 'horizontal' | 'both';

/**
 * The index the key asks for, or `null` for a key this group does not own.
 *
 * Wraps at both ends: a group that stops dead makes its last item the hardest
 * one to reach. The answer may be `from` itself (Home on the first item) —
 * the caller still owns the key, so it still calls `preventDefault`, and the
 * comparison against `from` is what stops a pointless re-selection.
 */
export function arrowTarget(
  key: string,
  from: number,
  count: number,
  axis: ArrowAxis
): number | null {
  if (count === 0) return null;
  const last = count - 1;
  const next = from === last ? 0 : from + 1;
  const previous = from === 0 ? last : from - 1;
  switch (key) {
    case 'ArrowRight':
      return next;
    case 'ArrowLeft':
      return previous;
    case 'ArrowDown':
      return axis === 'both' ? next : null;
    case 'ArrowUp':
      return axis === 'both' ? previous : null;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
