/**
 * WHICH SIDE OF THE LAZY BOUNDARY THE GUIDE'S PROSE SITS ON.
 *
 * ============================================================================
 * A HUNDRED POINTS OF EXPLANATION, PAID BEFORE THE ALERT QUEUE APPEARS
 *
 * The Guide is seventeen sections and a hundred-odd points — the largest body
 * of prose this product ships to a browser, and it is read by ONE screen. It
 * lived in `i18n/console.ts`, which `i18n/context.tsx` imports, which means
 * everything imports it: so the prose was in the chunk the browser must have
 * before anything can be rendered at all, whatever tab the operator opened.
 * Measured by sourcemap attribution over this repository's own build, it was
 * 34,907 of the eager chunk's 488,613 bytes; measured in Chromium over a real
 * socket, gzipped as `server/static.ts` serves it, the first load carried
 * 143,721 bytes of script where 129,709 would do.
 *
 * Nothing fails. It is a bill, and bills show up only if somebody looks.
 *
 * ============================================================================
 * TWO HALVES, AND NEITHER DOES ANYTHING ALONE
 *
 * That is why this file claims both, and why a mutation of either is red here:
 *
 *   1. THE PROSE LEAVES THE CATALOGUE EVERYTHING IMPORTS. Deferring the
 *      component while the sentences stay in `console.ts` saves nothing: the
 *      strings are in the catalogue object, not in the component that reads
 *      them.
 *   2. THE COMPONENT STOPS BEING NAMED BY A STATIC IMPORT. Moving the prose to
 *      a module of its own saves nothing either, while `App.tsx` pulls the one
 *      file that reads it into the eager graph.
 *
 * ============================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not read `dist/`. A test that asserts on a build is a test that
 * passes by being skipped on a machine that has not run one — the
 * `MENATER_TEST_PG` lesson, where a conditional half of a contract never ran
 * once in its life and was red the first time it did. The claims below are
 * about the SOURCE, which is where the property is decided; the byte counts
 * are in the pull request, measured once, by hand, in a browser.
 * ============================================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { consoleDictionary } from './console.ts';
import { guideCatalogue } from './guide.ts';

const root = process.cwd();
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

const appSource = read('src', 'App.tsx');
const docsSource = read('src', 'components', 'DocsPanel.tsx');

/** The project's history is allowed to quote what the code may not contain. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every string a catalogue can put on a screen. */
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'function') return [];
  if (node && typeof node === 'object') return Object.values(node).flatMap(strings);
  return [];
}

/**
 * Long enough to be an EXPLANATION rather than a label.
 *
 * The saving is made of prose, so the claim is about prose. A threshold
 * rather than an exact-match list because the two catalogues legitimately
 * share short words — both say "Documentation", and a rule that forbade that
 * would be a rule about vocabulary instead of about weight.
 */
const PROSE = 60;

const guideProse = strings(guideCatalogue('en')).filter((s) => s.length >= PROSE);
const consoleStrings = new Set(strings(consoleDictionary('en')));

describe("the Guide's prose is not in the chunk the first paint waits for", () => {
  it('has prose to move in the first place', () => {
    // The vacuity guard. Without it, emptying the Guide would make every
    // claim below pass — green over a feature that had gone away, which is
    // this product's defining defect pointed at its own test suite.
    const guide = guideCatalogue('en');
    expect(guide.sections.length).toBeGreaterThanOrEqual(15);
    expect(guide.sections.every((s) => s.points.length > 0)).toBe(true);
    expect(guideProse.length).toBeGreaterThan(50);
  });

  it('is absent from the catalogue that everything imports', () => {
    // `i18n/context.tsx` imports `console.ts`, so a sentence in there is in
    // the eager chunk no matter which screen reads it.
    const leftBehind = guideProse
      .filter((s) => consoleStrings.has(s))
      .map((s) => s.slice(0, 80));
    expect(leftBehind).toEqual([]);
  });
});

describe('the one screen that reads it is loaded on demand', () => {
  it('App.tsx names DocsPanel only through React.lazy', () => {
    expect(code(appSource)).not.toMatch(
      /^import\s+\{[^}]*\bDocsPanel\b[^}]*\}\s+from\s+'[^']*DocsPanel\.tsx';$/m,
    );
    expect(appSource).toMatch(
      /lazy\(\(\) =>\s*\n?\s*import\('\.\/components\/DocsPanel\.tsx'\)/,
    );
  });

  it('gives the deferred tab a net, as the other deferred tab has', () => {
    // `React.lazy` with no boundary unmounts the WHOLE application when a
    // chunk fails to arrive — a white screen while the alert queue is fine.
    // That trap is in `CLAUDE.md`; the Guide was eager when it was written,
    // so it had never needed the net until now.
    const docsTab = appSource.slice(appSource.indexOf("tab === 'docs'"));
    const block = docsTab.slice(0, docsTab.indexOf(') : null}'));
    expect(block).toContain('<SectionBoundary>');
    expect(block).toContain('<Suspense');
    expect(block).toContain('<DocsPanel');
  });
});

/**
 * Every production module — a test may import whatever it likes.
 *
 * Read as a list of PATHS rather than one blob, because the claim names the
 * file that is allowed to import the Guide and a blob cannot say which file a
 * line came from.
 */
const productionFiles = (() => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'server'));
  return files;
})();

describe('nothing else pulls the prose back onto the eager path', () => {
  it('is imported by DocsPanel.tsx and by no other production module', () => {
    // The plausible regression is kind rather than careless: providing the
    // Guide beside the other two catalogues in `i18n/context.tsx` would read
    // as consistency and would undo the whole saving in one line.
    const importers = productionFiles
      // Any specifier that resolves to the file, not just the ones spelled
      // with the directory in them. The first draft required `i18n/guide.ts`
      // and so could not see `'./guide.ts'` — which is exactly how the most
      // likely regression would be written, from a sibling module in the same
      // directory. Mutation M2 is what found it: adding the import to
      // `i18n/context.tsx` left this test green.
      .filter((f) => /from\s+'[^']*\/guide\.ts'/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(root.length + 1));
    expect(importers).toEqual([join('src', 'components', 'DocsPanel.tsx')]);
  });

  it('keeps the prose in a catalogue rather than in the component', () => {
    // The other plausible wrong fix: move the sentences into `DocsPanel.tsx`,
    // which also takes them off the eager path and throws away the rule
    // `CLAUDE.md` calls the thing that keeps user-facing strings out of
    // components. A typed catalogue cannot refuse a string that never asked
    // it anything.
    // `\n` is excluded from the class deliberately: a JavaScript string
    // literal cannot carry a raw newline, so a class that allows one matches
    // from a quote on one line to a quote thirty lines down and reports nine
    // offenders in a file that has none. The first draft did exactly that —
    // a ruler that measures something else, which this project has written
    // down twice (a contrast read during a theme cross-fade, a viewport
    // emulated at a width nobody asked for).
    // A run of natural language, rather than a hunt for string literals.
    //
    // The first two drafts hunted literals and both were WRONG RULERS. One
    // allowed `\n` inside the quote class, so it matched from a quote on one
    // line to a quote thirty lines down and reported nine offenders in a file
    // with none. The second fixed that and added a backtick branch, where a
    // template literal legitimately spans lines — two more false matches, this
    // time between two unrelated backticks. And both missed the form that
    // needs no quotes at all: prose written straight into JSX.
    //
    // So the rule is about the TEXT and not about its delimiter: letters,
    // spaces and sentence punctuation, sixty characters without a bracket, a
    // dot or a `$` to break them, which is what a sentence looks like and what
    // code does not. Probed in both directions before being trusted — it
    // catches the three quote forms and raw JSX text, and passes over this
    // file's own comments and over ordinary statements.
    const PROSE_RUN = /[A-Za-z][A-Za-z ,;:'\u2019()\u2014-]{59,}/g;
    const literals = (code(docsSource).match(PROSE_RUN) ?? []).map((s) => s.slice(0, 80));
    expect(literals).toEqual([]);
  });
});

describe('the sweeps follow the prose out of the file it left', () => {
  it('is in the catalogue sweep that refuses a name outliving its subject', () => {
    // `n8n-removed.test.ts` walks the catalogues BY NAME: whatever moves out
    // of one stops being swept on the day of the move, silently. Its own
    // header says a sweep that under-reads is worse than none — this is the
    // assertion that stops this move from being the next example.
    expect(read('src', 'components', 'n8n-removed.test.ts')).toContain("'guide.ts'");
  });
});
