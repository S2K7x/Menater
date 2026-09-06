/**
 * The MENATER mark.
 *
 * ============================================================================
 * WHAT IT DRAWS, AND WHY THAT
 *
 * Five ticks, and the middle one is a stub rather than a full bar. It is the
 * product's first principle drawn literally: A MISSING VALUE KEEPS ITS PLACE
 * INSTEAD OF BEING OMITTED. Absence sits at the centre, so the mark stays
 * symmetric — the gap is the composition, not a defect in it.
 *
 * Angular rather than circular on purpose: circular logo shapes activate
 * softness, angular ones durability. Symmetric on purpose too: asymmetry
 * raises perceived excitement, and it only pays for brands whose personality
 * is excitement. This one's is competence.
 *
 * ============================================================================
 * ONE GEOMETRY, TWO CONSUMERS
 *
 * `MARK_BARS` is the only place the shape exists. This component renders it,
 * and `theme/favicon.ts` builds the browser-tab icon from the same array.
 * Writing the rectangles twice would produce a mark that drifts from its own
 * favicon — silently, because neither copy fails when they disagree. Same
 * reasoning as `THEME_SWATCHES`, and a test compares them.
 *
 * ============================================================================
 * IT CARRIES NO COLOUR
 *
 * `fill="currentColor"`: the CSS decides. `.soc-logo-sign` sets
 * `color: var(--accent)`, so the mark follows all six themes with no second
 * asset to maintain and no hardcoded value to go stale. A hex written here
 * would be immediately wrong — it would follow none of the themes.
 */

/** The mark's geometry, on a 32 x 32 grid. The single source. */
export const MARK_BARS: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = [
  { x: 0, y: 5, w: 4, h: 22 },
  { x: 7, y: 5, w: 4, h: 22 },
  // The middle tick: present, and visibly short. Not absent.
  { x: 14, y: 21, w: 4, h: 6 },
  { x: 21, y: 5, w: 4, h: 22 },
  { x: 28, y: 5, w: 4, h: 22 },
];

export const MARK_VIEWBOX = '0 0 32 32';

export function Mark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="soc-mark"
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      fill="currentColor"
      focusable="false"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {MARK_BARS.map((b) => (
        <rect key={`${b.x}-${b.y}`} x={b.x} y={b.y} width={b.w} height={b.h} />
      ))}
    </svg>
  );
}
