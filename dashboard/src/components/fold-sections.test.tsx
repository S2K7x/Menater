/**
 * @vitest-environment jsdom
 */
/**
 * Three sections of this console were a FOLD, so three sections had no
 * heading at all.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * C0.44 promoted the Guide's seventeen section titles, C0.45 the scan
 * report's findings and C0.46 the five sections of Settings → Code analysis.
 * Each of those was written as a fix to a SCREEN, so the search that finds
 * the next instance is not « who calls `Fold` » — most folds hold an
 * EXPLANATION and are right to carry no heading (`CLARITY.md` § 3). It is a
 * structural predicate, and it is exact: **a `Fold` that is the immediate
 * child of a `section.soc-panel` IS that panel**, so its summary is the
 * panel's title and the section carries no heading.
 *
 * `ROADMAP` § 7 recorded that predicate and said it returned exactly two —
 * the Health tab's engine workflow list and the Lookup tab's source
 * catalogue. Re-run, it returns **three**: the Rules tab's test bench is one
 * too, and it had been read and filed among the folds that correctly carry no
 * heading. On that screen it is the only section heading there is.
 *
 * Measured in Chromium 157 on the three screens mounted with data, heading
 * nodes read out of CDP `Accessibility.getFullAXTree` and WALKED from the
 * root — the flat `nodes` array is not in document order (`CLARITY.md` § 7):
 *
 *     RULES    BEFORE  h1
 *              AFTER   h1 h2
 *     HEALTH   BEFORE  h1 h2 h2 h3 h3 h3 h2
 *              AFTER   h1 h2 h2 h3 h3 h3 h2 h2
 *     LOOKUP   BEFORE  h1 h2 h3 h2
 *              AFTER   h1 h2 h3 h2 h2
 *
 * One heading for 659 px and five sections on Rules, and the one the whole
 * screen is for — « try it on an alert », the bench somebody opens when they
 * DOUBT a rule — reachable only by scrolling. On the screen where a team
 * writes the rules deciding what stops reaching a human.
 *
 * Over 6 themes x 3 widths (320, 375, 1280) x the 3 screens, the before/after
 * difference is **108 differences in 54 cells, and every one of them is a
 * heading that was ADDED**: nothing deleted, nothing replaced, so no computed
 * type, no bounding box, no panel height and no document width moved. Panel
 * totals are identical to the hundredth of a pixel.
 *
 * Four things these tests are shaped around.
 *
 * ONE — the claim is the PREDICATE, not the three files that satisfy it
 * tonight. A test naming `HealthPanel`, `IntelPanel` and `RulesPage` goes
 * stale in silence the day a fourth fold becomes a panel, which is exactly
 * how this third one survived three passes. It is a subtraction over
 * `src/components/`, asserted in BOTH directions, so a `FoldSectionTitle` put
 * on a fold that is NOT a section fails too — the cost of the other direction
 * is measured and in `CLARITY.md` § 8: `Explain`'s circled "i" is a
 * `<details>` as well, so « a summary is a heading » makes every popover
 * trigger on the screen a heading and buys noise with the same keystroke.
 *
 * TWO — the heading goes AMONG the summary's spans, never around them.
 * Probed in Chromium 157 on three candidate markups, open AND closed:
 *
 *     spans only (today)                  -> no heading, either state
 *     heading among the spans             -> heading(2) "SOURCES", BOTH states
 *     heading wrapping the whole summary  -> heading(2) "SOURCES1 of 5"
 *
 * The wrapping form is the shape the HTML content model actually prefers — a
 * `<summary>` takes phrasing content *or* one heading element — and it names
 * the section after its hint as well. And the first line is why this works at
 * all: `CLARITY.md` § 8 records that a closed fold's CONTENT is absent from
 * the accessibility tree, and the obvious reading of that says the fix cannot
 * work. The summary is the disclosure CONTROL, not the content.
 *
 * THREE — the level is relative to the page title, not absolute. « Every
 * section is below level 1 » would pass over a section left at level 1, and
 * on Rules an `h3` would pass a « no skip » reading because there is nothing
 * between it and the `h1` to skip. What is asserted is that the heading sits
 * exactly ONE level under the title of the screen it is on.
 *
 * FOUR — jsdom applies no cascade, so the rule that gives the summary's own
 * register back is read out of `styles.css` as text, the way
 * `heading-outline.test.tsx` and `narrow-viewport.test.tsx` already do.
 * Comments are stripped from everything read that way: the paragraphs above
 * quote both the class and the selector, and a test that reads its own prose
 * goes green on its own explanation.
 * ============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { PageHead } from './Guidance.tsx';
import { CaseView } from './CaseView.tsx';
import { HealthPanel } from './HealthPanel.tsx';
import { IntelPanel } from './IntelPanel.tsx';
import { RulesPage } from './RulesPage.tsx';
import { api } from '../lib/api.ts';
import type { AlertCase, HealthReport } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const HERE = import.meta.dirname;

/**
 * Source with its comments stripped — and with the empty braces a stripped
 * JSX comment leaves behind. A test must not read its own prose, and this
 * file's header quotes both the class and the selector it hunts.
 */
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\{\s*\}/g, ' ');

const SHEET = code(readFileSync(join(HERE, '..', 'styles.css'), 'utf8'));

/* ==========================================================================
 * 1. The predicate, over the source, in both directions
 *
 * `ROADMAP` § 7 states it as « a `Fold` that is the immediate child of a
 * `section.soc-panel` ». Applied to the RENDERED tree that is too wide, and
 * the two folds it over-catches are the ones it would be worst to promote:
 * the incident card's raw log and execution chain are immediate children of a
 * `section.soc-panel` — measured, `DIV.soc-case-head, DETAILS.soc-fold,
 * DETAILS.soc-fold` — and that panel is ALREADY named, by the case title the
 * card renders above them. They are evidence inside a named section, not
 * sections.
 *
 * What makes a fold its panel's title is being the panel's ONLY content. That
 * is the predicate here, and it is read both ways: from the source, so a
 * fourth one is caught the day it is written, and from the rendered tree on
 * the three screens, because the source form cannot see a panel whose single
 * child arrives through a conditional.
 * ========================================================================== */

/** Every production component under `src/components/`, comments stripped. */
const COMPONENTS = readdirSync(HERE)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => [f, code(readFileSync(join(HERE, f), 'utf8'))] as const);

/** The content of a `<section>` opened at `from`, up to its own closing tag. */
function sectionBody(src: string, from: number): string | null {
  let depth = 1;
  const tag = /<section\b|<\/section>/g;
  tag.lastIndex = from;
  for (let m = tag.exec(src); m; m = tag.exec(src)) {
    depth += m[0] === '</section>' ? -1 : 1;
    if (depth === 0) return src.slice(from, m.index);
  }
  return null;
}

/**
 * The opening tag of a `<Fold` at the start of `src`.
 *
 * Not a regex: `title={<FoldSectionTitle>…</FoldSectionTitle>}` contains the
 * `>` a regex would stop at, which is what made the first version of this
 * sweep report the fix as missing on two of the three files it had just been
 * applied to. The tag ends at the first `>` seen at brace depth zero.
 */
function foldTag(src: string): string {
  let depth = 0;
  for (let i = 5; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return src.slice(0, i + 1);
  }
  return src;
}

/** Every `section.soc-panel` whose whole content is one `Fold`. */
function sectionFolds(src: string): string[] {
  const out: string[] = [];
  const open = /<section className=(?:'soc-panel'|"soc-panel"|\{'soc-panel'\})\s*>/g;
  for (const m of src.matchAll(open)) {
    const body = sectionBody(src, m.index + m[0].length)?.trim();
    if (!body || !body.startsWith('<Fold') || !body.endsWith('</Fold>')) continue;
    out.push(foldTag(body));
  }
  return out;
}

describe('a fold that IS its panel carries the section heading', () => {
  const hits = COMPONENTS.flatMap(([name, src]) =>
    sectionFolds(src).map((tag) => ({ name, tag })),
  );

  it('finds the section folds at all', () => {
    // The vacuity guard. A sweep that matches nothing proves nothing, and the
    // one above is exactly the kind that can silently stop matching:
    // `CLARITY.md` § 7 carries two rulers that read zero and were believed,
    // and the first version of this one read two of three. Three today —
    // Health, Lookup, Rules — where `ROADMAP` § 7 recorded two.
    expect(hits.map((h) => h.name).sort()).toEqual(
      ['HealthPanel.tsx', 'IntelPanel.tsx', 'RulesPage.tsx'],
    );
  });

  for (const { name, tag } of hits) {
    it(`${name} titles its section fold with a heading`, () => {
      expect(tag, `${name}: the section fold's title is not a FoldSectionTitle`)
        .toMatch(/title=\{<FoldSectionTitle>/);
    });
  }

  it('puts no section heading on a fold that is not a section', () => {
    // THE OTHER DIRECTION, and it is the one that stops this becoming noise.
    // Nine folds in this half correctly carry no heading: an install script,
    // a field mapping table, a raw log, an execution chain, two audit hashes,
    // the pull form's advanced fields. Passes BEFORE and after.
    const offenders: string[] = [];
    for (const [name, src] of COMPONENTS) {
      const allowed = new Set(sectionFolds(src));
      for (const m of src.matchAll(/<Fold\b/g)) {
        const tag = foldTag(src.slice(m.index));
        if (tag.includes('FoldSectionTitle') && !allowed.has(tag)) offenders.push(`${name}: ${tag.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ==========================================================================
 * 2. The three screens, mounted
 * ========================================================================== */

const HEALTH: HealthReport = {
  mode: 'live',
  engine: { reachable: true, url: 'postgres://localhost:5432/menater', detail: 'Engine mounted.' },
  workflows: [
    { id: '01-ingestion', name: '01-Ingestion', active: true },
    { id: '02-enrichment', name: '02-Enrichment', active: true },
  ],
  audit_db: { healthy: true, detail: 'No database error seen in recent runs' },
  blocking_findings: [],
  checked_at: '2026-11-21T04:00:00.000Z',
} as unknown as HealthReport;

/** The route's own shape, so the catalogue renders rather than staying null. */
function stubProviders() {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/api/intel/providers')) {
      return new Response(JSON.stringify({
        providers: [{
          id: 'internetdb', label: 'Shodan InternetDB', purpose: 'Open ports.',
          kinds: ['ipv4'], ttl_hours: 6, env: null, configured: true, signup: 'https://example.test',
        }],
        kinds: ['ipv4'],
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
}

/**
 * Each screen as `App.tsx` mounts it: the page head, then the panel. The head
 * is what makes the level claim relative rather than absolute, and on Rules it
 * is rendered by the component itself.
 */
const SCREENS: Array<[string, () => HTMLElement]> = [
  [
    'the Health tab',
    () =>
      render(
        <>
          <PageHead kicker="Diagnostic" title="Health" lede="Is the pipeline reachable." />
          <HealthPanel health={HEALTH} onRefresh={() => {}} />
        </>,
      ).container,
  ],
  [
    'the Lookup tab',
    () => {
      stubProviders();
      return render(
        <>
          <PageHead kicker="Threat intel" title="Lookup" lede="Ask about one value." />
          <IntelPanel />
        </>,
      ).container;
    },
  ],
  [
    'the Rules tab',
    () => {
      vi.spyOn(api, 'rules').mockResolvedValue({ rules: [] } as never);
      vi.spyOn(api, 'ruleTemplates').mockResolvedValue({ templates: [], drafts: [] } as never);
      return render(<RulesPage />).container;
    },
  ],
];

/** Mounts, lets the pending reads land, and hands back the container. */
async function mounted(mount: () => HTMLElement): Promise<HTMLElement> {
  const root = mount();
  // One empty `act` scope drains React's pending work rather than polling:
  // `waitFor` would make the positive claims pass eventually and leave the
  // negative ones vacuous. Same device as `intel-panel.test.tsx`.
  await act(async () => {});
  return root;
}

describe('every section fold names its section on the screen', () => {
  for (const [name, mount] of SCREENS) {
    it(`${name}: the heading is the summary's own child`, async () => {
      const root = await mounted(mount);
      const titles = [...root.querySelectorAll('h2.soc-fold-section')];
      expect(titles).toHaveLength(1);
      const title = titles[0]!;
      // Its own child, and that is what keeps it in the accessibility tree
      // while the fold is CLOSED — probed, see the header. A heading in the
      // fold's BODY would be invisible to a screen reader until somebody
      // opened it, which is the state this fix exists to leave behind.
      expect(title.parentElement?.tagName).toBe('SUMMARY');
      expect(title.closest('details.soc-fold')).toBeTruthy();
      // And the fold really is the panel: that is the predicate, checked on
      // the rendered tree rather than only on the source.
      const details = title.closest('details.soc-fold')!;
      expect(details.parentElement?.className).toContain('soc-panel');
      expect(details.parentElement?.tagName).toBe('SECTION');
    });

    it(`${name}: the heading sits one level under the page title`, async () => {
      const root = await mounted(mount);
      const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      const title = heads.find((h) => h.closest('.soc-page-head'));
      expect(title, `${name}: no page title`).toBeTruthy();
      const level = Number(title!.tagName[1]);
      const section = root.querySelector('h2.soc-fold-section')!;
      // Relative, not absolute: lesson THREE of the header. On Rules an `h3`
      // here would skip nothing, because there is nothing between it and the
      // `h1` — and it would still be the wrong level.
      expect(Number(section.tagName[1])).toBe(level + 1);
    });

    it(`${name}: the summary still reads as one line, heading and hint`, async () => {
      const root = await mounted(mount);
      const summary = root.querySelector('details.soc-fold > summary')!;
      // The promotion must not split the line into a heading and an orphan:
      // the hint stays a sibling of the heading inside the same summary, which
      // is what keeps « SOURCES · 1 of 5 reachable » one row. The chevron is
      // `aria-hidden`, so it is not in the name either way.
      const section = root.querySelector('h2.soc-fold-section')!;
      expect(section.parentElement).toBe(summary);
      expect(summary.querySelector('.soc-fold-hint')?.parentElement).toBe(summary);
    });
  }
});

describe('a fold that EXPLAINS is left alone', () => {
  const kase = (): AlertCase =>
    ({
      alert_id: 'ALT-2026-1121-0001',
      received_at: '2026-11-21T03:00:00.000Z',
      state: 'closed',
      severity: 'medium',
      rule_name: 'Multiple failed SSH logins',
      source_ip: '185.220.101.47',
      dest_ip: null,
      host: 'srv-bastion-01',
      raw_log: 'Nov 21 03:00:00 web01 sshd[2211]: Failed password for root',
      shadow_mode: true,
      executed: false,
      routing_outcome: null,
      enrichment: null,
      enrichment_meta: null,
      decision: null,
      approval: null,
      audit: null,
      stages: [],
      errors: [],
      attack: [],
      dwell_ms: null,
    }) as unknown as AlertCase;

  it('leaves the incident card\'s folds without a heading', () => {
    // Passes BEFORE and after, on purpose. The raw log, the chain, the
    // enrichment grid and the two hashes are EVIDENCE, not sections of the
    // card: `CLARITY.md` § 3's test is whether reading it again teaches you
    // anything. Promoting every fold summary is the plausible wrong fix.
    //
    // AND THIS IS THE CARD THAT MADE THE PREDICATE PRECISE. Two of these are
    // immediate children of a `section.soc-panel` — the wording `ROADMAP` § 7
    // uses — so the literal reading would have promoted them. The panel they
    // sit in is already named, by the case title in `.soc-case-head` above
    // them: it holds `DIV.soc-case-head, DETAILS.soc-fold, DETAILS.soc-fold`.
    // What makes a fold a section title is being the panel's ONLY content.
    const { container } = render(<CaseView alertCase={kase()} onRefresh={() => {}} />);
    const folds = [...container.querySelectorAll('details.soc-fold')];
    expect(folds.length).toBeGreaterThanOrEqual(2);
    const immediate = folds.filter((f) => f.parentElement?.matches('section.soc-panel'));
    // Non-vacuity for the sentence above: the over-wide reading really does
    // catch these, so leaving them alone is a claim and not a tautology.
    expect(immediate.length).toBeGreaterThanOrEqual(2);
    for (const f of immediate) expect(f.parentElement!.children.length).toBeGreaterThan(1);
    for (const f of folds) {
      expect(f.querySelector('summary h1,summary h2,summary h3,summary h4')).toBeNull();
    }
  });

  it('leaves every circled "i" out of the outline', async () => {
    // The measured cost of the other direction: `Explain` is a `<details>`
    // too, so a rule reading « a summary is a heading » would put one heading
    // per popover trigger on every screen. Health renders three.
    const root = await mounted(SCREENS[0]![1]);
    const infos = [...root.querySelectorAll('details.soc-info')];
    expect(infos.length).toBeGreaterThanOrEqual(2);
    for (const i of infos) expect(i.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
  });
});

describe('the predicate holds on the rendered tree, both ways', () => {
  /** Every fold on the screen, split by whether it IS its panel. */
  const split = (root: HTMLElement) => {
    const folds = [...root.querySelectorAll('details.soc-fold')];
    return {
      sections: folds.filter(
        (f) => f.parentElement?.matches('section.soc-panel') && f.parentElement.children.length === 1,
      ),
      inside: folds.filter(
        (f) => !(f.parentElement?.matches('section.soc-panel') && f.parentElement.children.length === 1),
      ),
    };
  };

  for (const [name, mount] of SCREENS) {
    it(`${name}: the folds that are their panel are exactly the ones with a heading`, async () => {
      const root = await mounted(mount);
      const { sections, inside } = split(root);
      // The source sweep cannot see a panel whose single child arrives through
      // a conditional; this one reads what the browser was given.
      expect(sections).toHaveLength(1);
      for (const f of sections) {
        expect(f.querySelector('summary > h2.soc-fold-section')).toBeTruthy();
      }
      for (const f of inside) {
        expect(f.querySelector('summary h1,summary h2,summary h3,summary h4')).toBeNull();
      }
    });
  }
});

/* ==========================================================================
 * 3. The stylesheet: a heading that must not LOOK like one
 * ========================================================================== */

describe('the section heading keeps the register the summary already set', () => {
  const rule = SHEET.match(/\.soc-fold > summary h2\.soc-fold-section \{([^}]*)\}/)?.[1] ?? '';

  it('names the element AND the parent it inherits from', () => {
    // NOT A STYLE PREFERENCE. `.soc-panel h2` is (0,1,1) and a bare
    // `.soc-fold-section` is (0,1,0), so the bare form loses outright — the
    // summary's 13.76px/400 would become 16px/900 with a 12px margin under
    // it, and the fold would grow 44px -> 52.8px. Measured. This selector is
    // (0,2,2), which the cascade decides rather than source order — the
    // `.soc-field.soc-check-field > span` lesson, paid for five times.
    expect(rule, 'no `.soc-fold > summary h2.soc-fold-section` rule').not.toBe('');
  });

  it('takes the font and the tracking from the summary, and drops the margin', () => {
    // Each measured by dropping it alone at 1280 px: `font: inherit` is the
    // shorthand, so it carries line-height too (22.016px, not the `h2` 20.8);
    // `letter-spacing` is not part of it (0.8256px, not 0.96); and
    // `h1, h2, h3` sets `margin: 0 0 12px`.
    expect(rule).toMatch(/font:\s*inherit/);
    expect(rule).toMatch(/letter-spacing:\s*inherit/);
    expect(rule).toMatch(/margin:\s*0/);
  });

  it('leaves the summary itself carrying the register', () => {
    // Passes BEFORE and after. The fold titles look the way they do because
    // the SUMMARY sets the display face, the capitals and the size — not
    // because a heading scale reached them. A change that moved that onto the
    // heading would satisfy every assertion above and alter three screens.
    const summary = SHEET.match(/\.soc-fold > summary \{([^}]*)\}/)?.[1] ?? '';
    expect(summary).toMatch(/font-family:\s*var\(--display\)/);
    expect(summary).toMatch(/text-transform:\s*uppercase/);
    expect(summary).toMatch(/font-size:\s*0\.86rem/);
    // The touch target, which the promotion must not shrink: the summary is a
    // real target, and the heading's own margin would have been inside it.
    expect(summary).toMatch(/min-height:\s*44px/);
  });

  it('is written next to the rules it modifies, not at the end of the sheet', () => {
    // `CLARITY.md` § 8: a stylesheet with `@media` blocks in the middle has
    // no "end", and a rule appended after them silently cancels the mobile
    // overrides. This one sits inside the fold block, between the hint and
    // the machine value.
    const hint = SHEET.indexOf('.soc-fold-hint {');
    const mine = SHEET.indexOf('.soc-fold > summary h2.soc-fold-section {');
    const body = SHEET.indexOf('.soc-fold-body {');
    expect(hint).toBeGreaterThan(0);
    expect(mine).toBeGreaterThan(hint);
    expect(mine).toBeLessThan(body);
  });
});
