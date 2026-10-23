/**
 * What the console's first paint is allowed to wait for.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 *
 * `index.html` asked `fonts.googleapis.com` for the display face with an
 * ordinary `<link rel="stylesheet">`, and a stylesheet in `<head>` is
 * RENDER-BLOCKING: the browser paints nothing until it has been fetched, and it
 * does not run the scripts that follow it either. So the first paint of a
 * console deployed on an isolated network — the normal deployment of this
 * product — was handed to a third party nobody can reach.
 *
 * Measured in Chromium 1194 against this repository's own `dist/`, served by
 * `server/static.ts`, five runs per condition:
 *
 *   - font host reachable (40 ms)      first contentful paint     100 ms
 *   - a proxy that answers in 3 s      first contentful paint   3,068 ms
 *   - host REFUSES (RST, fails fast)   first contentful paint      80 ms
 *   - host DROPS silently              NO PAINT in 20 s, `#root` empty
 *
 * The last line is the one that matters: a firewall that drops rather than
 * refuses — the ordinary shape of an egress rule — left the console blank and
 * UNSTARTED, React never having mounted, while every byte of the interface had
 * already arrived from our own origin.
 *
 * And the file contradicted itself. `display=swap` in that URL means "paint
 * with the fallback face and swap when the webfont lands", and the comment
 * above the link promises it "falls back to system faces when the network is
 * absent — a console on an isolated network must not lose its hierarchy
 * because a CDN is unreachable". Both describe a graceful degradation the
 * blocking `<link>` above them makes impossible. The blocking one won.
 *
 * ============================================================================
 * WHY A STRUCTURAL CLAIM AND NOT THE MEASUREMENT
 *
 * The numbers above need a layout engine, and the suite runs under jsdom,
 * where `scrollWidth` is 0 and nothing is painted. A test that read `dist/`
 * and drove a browser would pass by being skipped on a machine that has not
 * built one. So the bytes are measured by hand and quoted in the pull request;
 * what is pinned here is the property that produced them.
 *
 * IT IS WRITTEN AS A SUBTRACTION, not as a list naming Google. A second font
 * host, an icon CDN or an analytics stylesheet added tomorrow is the same
 * defect, and a rule naming the one offender we happened to have is a rule
 * that passes over the next one.
 *
 * AND IT COVERS BOTH DOORS. A rule that only reads `index.html` is blind to a
 * CSS `@import` of an absolute URL, which is render-blocking too and worse —
 * an `@import` is discovered only after the importing sheet has been parsed,
 * so it serialises two round trips instead of one. That is the "fix applied at
 * the front door and not at the two buttons behind it" row of CLAUDE.md, and
 * the second door is claimed here rather than discovered later.
 * ============================================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/**
 * Every stylesheet this interface ships, walked rather than listed.
 *
 * A sheet outside a hand-written list is a sweep that under-reads, which is
 * worse than no sweep — the lesson `themes.test.ts` records about its own list.
 */
const sheets = ((): Array<[string, string]> => {
  const found: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.css')) found.push([full.slice(root.length + 1), readFileSync(full, 'utf8')]);
    }
  };
  walk(join(root, 'src'));
  return found;
})();

/** Every `<link>` element of the shell, each as its own source text. */
const links = (): string[] => html.match(/<link[\s\S]*?>/g) ?? [];

const isStylesheet = (tag: string) => /\brel\s*=\s*"stylesheet"/.test(tag);

/**
 * An href this console does not serve.
 *
 * `//host/…` counts: it is protocol-relative and still a third party. A
 * root-relative or bare path is ours, answered by `server/static.ts` from the
 * same origin and the same lock, so it cannot be the subject of this rule.
 */
const isCrossOrigin = (tag: string) => {
  const href = /\bhref\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? '';
  return /^(https?:)?\/\//.test(href);
};

describe('nothing outside this origin can delay the console appearing', () => {
  it('declares every cross-origin stylesheet non-blocking', () => {
    // `media="print"` is what takes the link off the render-blocking path: the
    // browser still fetches it, at low priority, and does not wait for it to
    // paint a screen media. Anything else — no `media`, `all`, `screen` — is
    // the defect.
    const blocking = links()
      .filter(isStylesheet)
      .filter(isCrossOrigin)
      .filter((tag) => !/\bmedia\s*=\s*"print"/.test(tag))
      .map((tag) => tag.replace(/\s+/g, ' ').slice(0, 120));
    expect(blocking).toEqual([]);
  });

  it('promotes each of them to a screen medium once it has arrived', () => {
    // THE HALF THAT KEEPS THE FONTS. `media="print"` alone is a fix that looks
    // applied and is not: the sheet is fetched and never applies, so the
    // display face silently stops loading and the console renders in its
    // fallback stack for ever. The swap back is what makes the first claim a
    // deferral rather than a deletion, and a typo in it — `'print'`, a missing
    // handler — is indistinguishable by eye on a machine where the font is
    // already cached.
    const unpromoted = links()
      .filter(isStylesheet)
      .filter(isCrossOrigin)
      .filter((tag) => !/\bonload\s*=\s*"[^"]*this\.media\s*=\s*'all'/.test(tag))
      .map((tag) => tag.replace(/\s+/g, ' ').slice(0, 120));
    expect(unpromoted).toEqual([]);
  });

  it('imports no absolute URL from a stylesheet it ships', () => {
    // The second door. The walk has to find the sheets, or the rule below
    // passes over nothing.
    expect(sheets.length).toBeGreaterThan(2);

    const remote = sheets
      .filter(([, text]) => /@import\s+(url\()?\s*["']?(https?:)?\/\//.test(text))
      .map(([name]) => name);
    expect(remote).toEqual([]);
  });

  it('still asks for a display face, and for one that swaps', () => {
    // Passes BEFORE and AFTER the change, on purpose, and it is also what stops
    // the two rules above being vacuously true: they say nothing about a shell
    // that requests no webfont at all, and deleting the request would be a
    // different decision from deferring it.
    //
    // `swap` is the font-FILE half of the same promise — paint the text in the
    // fallback face immediately, swap when the webfont lands — and without it a
    // deferred stylesheet buys an invisible-text pause instead of a fast paint.
    //
    // BOTH FORMS COUNT, and that is deliberate rather than generous. Serving
    // the faces from this origin is the obvious next step here — it removes the
    // third party instead of deferring it — and it declares the same promise as
    // `font-display: swap` inside a sheet we ship. A rule that only knew the
    // CDN spelling would go red on the better fix, which is a test blocking the
    // repair it exists to protect.
    const remoteSwap = links().filter(isStylesheet).filter(isCrossOrigin)
      .filter((tag) => /display=swap/.test(tag));
    const localSwap = sheets
      .filter(([, text]) => /@font-face[\s\S]*?font-display\s*:\s*swap/.test(text));
    expect(remoteSwap.length + localSwap.length).toBeGreaterThan(0);

    // And nothing asks for a face WITHOUT the promise: a second family added
    // beside the first, blocking-deferred and with no `swap`, is the pause this
    // rule exists to refuse.
    const noSwap = links().filter(isStylesheet).filter(isCrossOrigin)
      .filter((tag) => !/display=swap/.test(tag))
      .map((tag) => tag.replace(/\s+/g, ' ').slice(0, 120));
    expect(noSwap).toEqual([]);
  });
});
