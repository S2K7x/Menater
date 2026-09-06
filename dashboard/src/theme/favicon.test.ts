/**
 * @vitest-environment jsdom
 */
/**
 * Tests of the browser-tab icon.
 *
 * ============================================================================
 * WHAT THEY PROTECT — THE ONE SURFACE CSS CANNOT REACH
 *
 * Everything drawn inside the page follows the theme for free, because it
 * reads the tokens. The tab does not: it is a separate resource, painted once,
 * and a static file would leave an acid-green icon over a cream console.
 *
 * Three ways that goes wrong without failing:
 *
 *   - the generated icon stops following the theme, and nobody notices because
 *     the page itself still recolours correctly;
 *   - `public/favicon.svg` drifts from the generated one, and the mismatch is
 *     visible only in the fraction of a second before React mounts;
 *   - the icon's geometry is edited without the component's, so the mark and
 *     its own favicon become two different drawings.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { MARK_BARS } from '../components/Mark.tsx';
import { THEMES, applyTheme, type ThemeId } from './context.tsx';
import { THEME_SWATCHES } from './swatches.ts';
import { applyFavicon, faviconDataUri, faviconSvg } from './favicon.ts';

const root = join(import.meta.dirname, '..', '..');

beforeEach(() => {
  document.head.querySelectorAll('link[rel="icon"]').forEach((n) => n.remove());
});

const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]');

describe('the tab icon', () => {
  it('is painted in the palette of the theme it is asked for', () => {
    for (const theme of THEMES) {
      const svg = faviconSvg(theme);
      expect(svg).toContain(THEME_SWATCHES[theme].accent);
      expect(svg).toContain(THEME_SWATCHES[theme].bg);
    }
  });

  it('differs for every one of the six themes', () => {
    const drawn = THEMES.map((t) => faviconSvg(t));
    expect(new Set(drawn).size).toBe(THEMES.length);
  });

  it('draws the same geometry as the component', () => {
    const svg = faviconSvg('grayed');
    for (const b of MARK_BARS) {
      expect(svg).toContain(`x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"`);
    }
  });

  it('installs a link when the document has none', () => {
    expect(icon()).toBeNull();
    applyFavicon('grayed');
    expect(icon()?.href).toBe(faviconDataUri('grayed'));
    expect(icon()?.type).toBe('image/svg+xml');
  });

  it('repaints the existing link rather than stacking new ones', () => {
    applyFavicon('grayed');
    applyFavicon('acme');
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(icon()?.href).toBe(faviconDataUri('acme'));
  });

  /**
   * The path a real theme change takes: the picker calls `setTheme`, which
   * calls `applyTheme`. If the icon ever stops being repainted there, this is
   * the test that says so.
   */
  it('follows a theme change made in Settings', () => {
    const seen = new Map<ThemeId, string>();
    for (const theme of THEMES) {
      applyTheme(theme);
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
      const href = icon()?.href;
      expect(href).toBeTruthy();
      expect(decodeURIComponent(href!)).toContain(THEME_SWATCHES[theme].accent);
      seen.set(theme, href!);
    }
    expect(new Set(seen.values()).size).toBe(THEMES.length);
  });

  /**
   * `public/favicon.svg` is what the browser shows before React mounts. It is
   * a copy, so it needs a test — the same reason `THEME_SWATCHES` has one.
   */
  it('matches the static file shipped for the first paint', () => {
    const onDisk = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8').trim();
    expect(onDisk).toBe(faviconSvg('grayed'));
  });

  it('is a data URI a browser will accept', () => {
    expect(faviconDataUri('grayed')).toMatch(/^data:image\/svg\+xml,%3Csvg/);
  });
});
