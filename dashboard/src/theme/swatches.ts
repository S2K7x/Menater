/**
 * A three-colour extract of each theme's palette.
 *
 * ============================================================================
 * THE ONE PLACE A COLOUR IS WRITTEN OUT IN THE APPLICATION, AND WHY
 *
 * Two callers need a theme's colours WITHOUT that theme being applied, so
 * neither can read the CSS tokens — those only ever describe the current one:
 *
 *   - `ThemePicker` previews the five themes you have not chosen;
 *   - `favicon.ts` paints the browser tab, the one surface CSS cannot reach.
 *
 * These values are an extract of `themes.css`, and `themes.test.ts` checks
 * they have not drifted from it — an out-of-date preview lies without ever
 * raising an error.
 *
 * It lives in its own module rather than inside `ThemePicker` so that the
 * favicon builder can read it without importing a React component, which
 * would have put `context -> favicon -> ThemePicker -> context` in a cycle.
 */

import type { ThemeId } from './context.tsx';

export const THEME_SWATCHES: Record<ThemeId, { bg: string; accent: string; fg: string }> = {
  grayed: { bg: '#232830', accent: '#c3f53c', fg: '#f2f4f7' },
  punk: { bg: '#3b3d2a', accent: '#c31f1b', fg: '#f5e7bd' },
  blued: { bg: '#1f31c4', accent: '#c8f24b', fg: '#ffffff' },
  attck: { bg: '#7a1c08', accent: '#ffdd1c', fg: '#fff3e4' },
  acme: { bg: '#f4f1ea', accent: '#e01e0b', fg: '#16150f' },
  dark: { bg: '#16181c', accent: '#1269f5', fg: '#f0f2f5' },
};
