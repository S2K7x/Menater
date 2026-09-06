/**
 * The browser-tab icon, built from the current theme.
 *
 * ============================================================================
 * WHY IT IS GENERATED AND NOT A FILE
 *
 * A static `.ico` would keep the slate palette on all six themes: someone who
 * picked Acme would get a cream console under an acid-green tab. The mark
 * inside the application follows the tokens for free, and the tab is the one
 * surface CSS cannot reach — so it is built here instead, as a data URI, from
 * the same geometry the component renders and the same swatches the picker
 * previews.
 *
 * `public/favicon.svg` still exists, and it is the SLATE one: it is what the
 * browser shows between the first paint and React mounting. A test keeps the
 * two in step, because a stale file would only be visible for the fraction of
 * a second nobody watches.
 *
 * ============================================================================
 * NO FOURTH COPY OF THE PALETTE
 *
 * The colours come from `THEME_SWATCHES`, which an existing test already
 * compares against `themes.css`. Reading them here adds a consumer, not a
 * copy — writing six accents out again is how the preview came to need a test
 * in the first place.
 */

import { MARK_BARS, MARK_VIEWBOX } from '../components/Mark.tsx';
import { THEME_SWATCHES } from './swatches.ts';
import type { ThemeId } from './context.tsx';

/**
 * The mark is drawn full-bleed on its 32-unit grid, which leaves no margin.
 * A tab icon needs one, so the bars are scaled to three quarters and centred:
 * 32 x 0.75 = 24 wide, so 4 units of air on each side.
 */
const INSET = 'translate(4 4) scale(0.75)';

export function faviconSvg(theme: ThemeId): string {
  const { bg, accent } = THEME_SWATCHES[theme];
  const bars = MARK_BARS.map(
    (b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`,
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}">` +
    `<rect width="32" height="32" rx="4" fill="${bg}"/>` +
    `<g transform="${INSET}" fill="${accent}">${bars}</g>` +
    `</svg>`
  );
}

export function faviconDataUri(theme: ThemeId): string {
  // `encodeURIComponent` rather than base64: the payload stays readable in
  // devtools, and it is shorter for markup this small.
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(theme))}`;
}

/**
 * Installs or updates the tab icon. Creates the `<link>` if the document has
 * none, so the function works whether or not `index.html` shipped one.
 */
export function applyFavicon(theme: ThemeId): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = faviconDataUri(theme);
}
