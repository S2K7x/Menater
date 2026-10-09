/**
 * WHICH STYLESHEET SITS ON WHICH SIDE OF THE LAZY BOUNDARY.
 *
 * ============================================================================
 * THE RULE WAS APPLIED TO THE JAVASCRIPT AND NOT TO THE SHEET BESIDE IT
 *
 * `App.tsx` reaches the Code tab through `React.lazy`, with a comment saying
 * why: the analysis half weighs more than the rest of the console put
 * together. `main.tsx` then imported BOTH stylesheets, so half of that weight
 * was deferred and the other half was not — and the half that was not is the
 * render-blocking one. Measured in Chromium against this repository's own
 * build, over a real socket: the one `<link rel="stylesheet">` in `<head>`
 * carried 16,419 bytes on the wire, 27,083 of its 91,278 decoded bytes being
 * rules for a tab most operators never open. Nothing fails; it is a bill, and
 * one paid before the alert queue can paint.
 *
 * ============================================================================
 * THE ONE PART OF THAT SHEET THE CONSOLE DOES RENDER
 *
 * `Diagrams.tsx` is the single file under `src/vulnpipe/` that console code
 * imports: the Guide tab draws its architecture figure, its confidence bands
 * and its cost funnel. Deferring those rules with the rest would leave three
 * unstyled SVGs on a screen nobody would think to connect to another tab — so
 * they live in `vulnpipe/diagrams.css`, imported by the component itself.
 *
 * ============================================================================
 * ONE PREDICATE, USED IN BOTH DIRECTIONS
 *
 * A selector is ABOUT THE DIAGRAMS when every class in it is one
 * `Diagrams.tsx` can put on an element — read out of the component, never
 * listed here, so a figure that gains a class is covered the day it is written
 * rather than the day somebody remembers to extend a list. That single
 * predicate then says both things that have to stay true: the deferred sheet
 * holds none of those selectors, and the eager sheet holds nothing else. A
 * one-directional check would pass over the sheet quietly refilling with the
 * section's rules, which is the same bill rebuilt on the other side.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;
const read = (...p: string[]) => readFileSync(join(dir, ...p), 'utf8');

const diagramsSource = read('components', 'Diagrams.tsx');
const sectionSheet = read('styles.css');
const diagramSheet = read('diagrams.css');
const consoleSheet = read('..', 'styles.css');

/**
 * Every class `Diagrams.tsx` can put on an element.
 *
 * A class built by interpolation — `` `vp-dgm-${tone}` `` — cannot be resolved
 * from the source, so it is kept as a PREFIX and matched that way. Reading the
 * component is what makes this a derivation rather than a second list to keep
 * in step; `vp-dgm-edge-muted` is proof the two would diverge, since it is
 * rendered and deliberately styled by nothing.
 */
function diagramClasses(): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  const attrs = diagramsSource.matchAll(
    /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{[^}]*?'([^']*)'[^}]*?\})/g,
  );
  for (const m of attrs) {
    for (const piece of (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/)) {
      const token = piece.trim();
      if (!token.startsWith('vp-')) continue;
      const cut = token.indexOf('${');
      if (cut >= 0) prefixes.add(token.slice(0, cut));
      else if (/^[a-z0-9-]+$/.test(token)) exact.add(token);
    }
  }
  return { exact, prefixes: [...prefixes] };
}

const { exact, prefixes } = diagramClasses();
const isDiagramClass = (c: string) =>
  exact.has(c) || prefixes.some((p) => p !== '' && c.startsWith(p));

/** Every `selector { … }` head of a sheet, comments stripped. */
function selectorsOf(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((m) => m[1].trim())
    .filter((s) => s !== '');
}

/**
 * A selector belongs to the diagrams when EVERY class in it is one the figures
 * render. The "every" is what keeps `.vp-card.vp-tone-green` in the section's
 * sheet: `vp-tone-` is a diagram prefix, `vp-card` is not a diagram class, and
 * that rule dresses a confidence card inside the Code tab.
 */
const aboutDiagrams = (selector: string): boolean => {
  const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  return classes.length > 0 && classes.every(isDiagramClass);
};

describe('the classes are read from the component, not listed', () => {
  it('finds the three families and both interpolated prefixes', () => {
    // If this ever comes back empty the two tests below pass vacuously, which
    // is the shape of a guard that has quietly stopped guarding anything.
    expect(exact.size).toBeGreaterThan(10);
    expect(prefixes.sort()).toEqual(['vp-dgm-', 'vp-tone-']);
    expect([...exact]).toContain('vp-diagram');
    expect([...exact]).toContain('vp-funnel-bar');
    expect([...exact]).toContain('vp-dgm-zoneband');
  });
});

describe("the Guide's figures do not depend on the deferred sheet", () => {
  it('no diagram selector is left in the Code tab stylesheet', () => {
    const stranded = selectorsOf(sectionSheet).filter(aboutDiagrams);
    expect(stranded).toEqual([]);
  });

  it('the diagram sheet holds nothing but diagram selectors', () => {
    const creep = selectorsOf(diagramSheet).filter((s) => !aboutDiagrams(s));
    expect(creep).toEqual([]);
  });

  it('the diagram sheet actually carries the figures', () => {
    expect(selectorsOf(diagramSheet).length).toBeGreaterThan(20);
  });
});

describe('the sheet the browser blocks on is the console sheet alone', () => {
  const mainEntry = read('..', 'main.tsx');

  it('main.tsx imports no stylesheet belonging to a lazily-loaded section', () => {
    const sheets = [...mainEntry.matchAll(/^import\s+'([^']+\.css)';$/gm)].map((m) => m[1]);
    expect(sheets).toEqual(['./styles.css']);
  });

  it('the section imports its own stylesheet, so the chunk carries it', () => {
    expect(read('VulnPipeSection.tsx')).toMatch(/^import '\.\/styles\.css';$/m);
  });

  it('the figures import theirs, so it follows whoever renders them', () => {
    expect(diagramsSource).toMatch(/^import '\.\.\/diagrams\.css';$/m);
  });
});

describe('the premises the split rests on', () => {
  /**
   * Both of these pass BEFORE the split as well, on purpose: they are not the
   * change, they are what makes it safe, and they are the two ways a later
   * edit could silently undo the saving without touching any file above.
   */
  it('the section is reached only through React.lazy', () => {
    const app = read('..', 'App.tsx');
    expect(app).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'\.\/vulnpipe\//m);
    expect(app).toMatch(/lazy\(\(\) =>\s*\n?\s*import\('\.\/vulnpipe\/VulnPipeSection\.tsx'\)/);
  });

  it('Diagrams.tsx is the only file outside the section that console code imports', () => {
    // Anything else pulling a `vulnpipe/` module into the eager graph would
    // want the deferred sheet on the first paint again.
    const app = read('..', 'App.tsx');
    const docs = read('..', 'components', 'DocsPanel.tsx');
    for (const [name, source] of [['App.tsx', app], ['DocsPanel.tsx', docs]] as const) {
      const eager = [...source.matchAll(/^import\s+(?:type\s+)?[^;]*from\s+'[^']*vulnpipe\/([^']+)';$/gm)]
        .map((m) => m[1])
        .filter((p) => !p.endsWith('VulnPipeSection.tsx'));
      expect(eager, name).toEqual(name === 'DocsPanel.tsx' ? ['components/Diagrams.tsx'] : []);
    }
  });
});

describe('a third sheet obeys the rule the second one already did', () => {
  /**
   * `vulnpipe/styles.css` carries no tokens and no document globals, because
   * two sheets each defining `:root`, `body` and `h1` is a trap this project
   * has already paid for. A third sheet inherits that rule rather than being
   * exempt from it.
   */
  it('the diagram sheet defines no token and no document global', () => {
    expect(diagramSheet).not.toMatch(/^\s*--[a-z0-9-]+\s*:/m);
    for (const selector of selectorsOf(diagramSheet)) {
      expect(selector, 'every selector is scoped by a class').toMatch(/\./);
      expect(selector).not.toMatch(/:root|^\s*(html|body)\b/);
    }
  });

  it('its colours are theme tokens, so the figures follow all six palettes', () => {
    // A hardcoded colour here would stay green on the five palettes that are
    // not `grayed` — the reason nothing in this product writes one.
    const declarations = diagramSheet.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(declarations).not.toMatch(/\brgba?\(/);
  });

  it('every sheet that could draw a focus ring is in the theme sweep', () => {
    // `themes.test.ts` refuses a ring written in `var(--accent)`, and it can
    // only refuse what it reads. A sheet added outside its list is a sweep
    // that under-reads, which is worse than none.
    expect(read('..', 'theme', 'themes.test.ts')).toContain('vulnpipe/diagrams.css');
  });
});

describe('the console sheet is not where these rules went instead', () => {
  it('holds no diagram selector of its own', () => {
    expect(selectorsOf(consoleSheet).filter(aboutDiagrams)).toEqual([]);
  });
});
