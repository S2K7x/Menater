/**
 * @vitest-environment jsdom
 */
/**
 * The console had three visual heading levels and no level 1.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * `CLARITY.md` § 2 and `DESIGN.md` § The scale both declare three levels — a
 * page title, a section inside the page, a block inside a section — and both
 * describe them as SIZES. The markup kept the sizes and never gave the outline
 * its top: `PageHead` rendered `<h2>`, every section rendered `<h2>`, and the
 * document carried no `<h1>` at all.
 *
 * Measured in Chromium 1194 on this repository's own build, reading the
 * heading nodes out of CDP `Accessibility.getFullAXTree` — what a screen
 * reader is handed, not what the source says — on all ten tabs and on an open
 * case:
 *
 *     tab          BEFORE                      AFTER
 *     HEALTH       h2 h2 h2 h2 h3 h3 h3 h2     h1 h2 h2 h2 h3 h3 h3 h2
 *     ALERTS       h2 h2 h2 h3 h3 h3           h1 h2 h2 h3 h3 h3
 *     every tab    h1 count: 0                 h1 count: 1
 *
 * On Health that leading `h2 h2 h2 h2` is the page title and three of its own
 * sections, as peers: a reader listing the headings of the screen could not
 * tell which one NAMES the screen. `CLAUDE.md` already carries the rule —
 * *« a heading level is a size AND an outline [...] promote by meaning, not by
 * how big you want the text »* — and it was applied to the OTHER half of the
 * product (`UsagePanel`, `LiveActivity`). The mirror of a rule is not the rule.
 *
 * Four things these tests are shaped around.
 *
 * ONE — the page head is rendered in FOUR places, not one. `PageHead` covers
 * seven tabs; `RulesPage`, `SettingsPage` and `DocsPanel` each hand-roll
 * `.soc-panel.soc-page-head` with a heading of their own. A test of the
 * primitive vouches for three screens it cannot see, so the page heads are
 * also swept from source — by looking for the CLASS rather than by listing the
 * files, so a fifth page head is covered the day it is written.
 *
 * TWO — the peer claim has to be made RELATIVE to the page title. Written as
 * « every section is below level 1 » it passes over the defect, because the
 * title and the sections were both `h2` and 2 is greater than 1. What was
 * wrong is that they were EQUAL.
 *
 * THREE — the claim is about the OUTLINE, never about the size. The sizes are
 * unchanged to the pixel on all six themes; what changed is which element
 * carries them. So the stylesheet assertions ask WHICH LEVEL each of the three
 * sizes is addressed at, and the one about the scale itself passes before and
 * after on purpose.
 *
 * FOUR — jsdom applies no cascade, so the rules that decide the sizes are read
 * out of `styles.css` as text, the way `readability.test.tsx` and
 * `narrow-viewport.test.tsx` already do. Comments are stripped from everything
 * read this way: the paragraph above quotes `.soc-page-head h2`, and a test
 * that reads its own prose goes green on its own explanation.
 * ============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { PageHead } from './Guidance.tsx';
import { CaseView } from './CaseView.tsx';
import { DocsPanel } from './DocsPanel.tsx';
import { HealthPanel } from './HealthPanel.tsx';
import { RulesPage } from './RulesPage.tsx';
import { api } from '../lib/api.ts';
import type { AlertCase, HealthReport } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HERE = import.meta.dirname;

/** Source with its comments stripped. A test must not read its own prose. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SHEET = code(readFileSync(join(HERE, '..', 'styles.css'), 'utf8'));
const APP = code(readFileSync(join(HERE, '..', 'App.tsx'), 'utf8'));

type Head = { lvl: number; text: string; inPageHead: boolean; inCaseTitle: boolean };

/** Every heading the screen rendered, in document order, with its level. */
const outline = (root: HTMLElement): Head[] =>
  [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    lvl: Number(h.tagName[1]),
    text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
    inPageHead: Boolean(h.closest('.soc-page-head')),
    inCaseTitle: Boolean(h.closest('.soc-case-title')),
  }));

const APPROVAL = {
  requested_action: 'isolate_host_temporary',
  intent: 'Isolate srv-bastion-01 while the session is investigated.',
  blast_radius: 'The host loses network access. Sessions are cut.',
  rollback_plan: 'Reverts by itself after the TTL, or by hand.',
  triggers: ['confidence 0.71 < 0.85', 'a containment action is proposed'],
  outcome: 'approved',
  approver: {
    slack_username: 'alice',
    slack_user_id: null,
    responded_at: '2026-08-23T12:01:00.000Z',
    identity_source: 'console_self_declared',
    signature_verified: false,
  },
  human_reasoning: 'Confirmed with the owner: this login was not theirs.',
  timeout_minutes: 45,
  requested_at: '2026-08-23T11:55:00.000Z',
};

/**
 * A case carrying EVERY heading the card can render. The first version of
 * this fixture left `errors`, `attack` and `approval` empty, and a mutation
 * caught it: a level skip among the headings it did not mount could not fail
 * any assertion. The measurement in Chromium saw `h2 h3 h3 h4 h4 h4 h4 h3`,
 * and this fixture is what reproduces it.
 */
const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-2026-0823-0412',
    received_at: '2026-08-23T11:54:07.000Z',
    state: 'awaiting_approval',
    severity: 'high',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    source_ip: '185.220.101.47',
    dest_ip: '10.12.4.31',
    host: 'srv-bastion-01',
    raw_log: 'Aug 23 11:54:07 web01 sshd[2211]: Accepted password for root',
    shadow_mode: false,
    executed: false,
    routing_outcome: null,
    enrichment: null,
    enrichment_meta: null,
    decision: null,
    approval: APPROVAL,
    audit: null,
    stages: [],
    errors: [
      {
        workflow: '05-audit-log',
        error_code: 'audit_write_failed',
        message: 'The audit write failed: the trace of this alert is lost.',
        severity: 'high',
        at: '2026-08-23T11:55:00.000Z',
        requires_replay: true,
      },
    ],
    attack: [{ id: 'T1110', technique: 'Brute Force', tactic: 'Credential Access' }],
    dwell_ms: null,
    ...over,
  }) as unknown as AlertCase;

/**
 * The Health tab as `App.tsx` mounts it: the page head, then the panel whose
 * four sections were its peers. It is the worst case in the measurement above,
 * and the only mount here that can show the defect at all — `RulesPage` and
 * `DocsPanel` carry no section heading, so on them the peer claim would say
 * nothing.
 */
const HEALTH: HealthReport = {
  mode: 'live',
  engine: { reachable: true, url: 'postgres://localhost:5432/menater', detail: 'Engine mounted.' },
  workflows: [],
  audit_db: { healthy: true, detail: 'No database error seen in recent runs' },
  blocking_findings: [],
  checked_at: '2026-10-05T00:00:00Z',
};

const healthTab = () =>
  render(
    <>
      <PageHead kicker="Diagnostic" title="Health" lede="Is the pipeline reachable." />
      <HealthPanel health={HEALTH} onRefresh={() => {}} />
    </>,
  ).container;

/** Every screen here that carries a page head, mounted with its data. */
const screensWithPageHead: Array<[string, () => HTMLElement]> = [
  ['the Health tab', healthTab],
  [
    'RulesPage',
    () => {
      vi.spyOn(api, 'rules').mockResolvedValue({ rules: [] } as never);
      vi.spyOn(api, 'ruleTemplates').mockResolvedValue({ templates: [] } as never);
      return render(<RulesPage />).container;
    },
  ],
  ['DocsPanel', () => render(<DocsPanel />).container],
];

/* ==========================================================================
 * The outline has a top, and it is the page title
 * ========================================================================== */

describe("the page title is the screen's level-1 heading", () => {
  for (const [name, mount] of screensWithPageHead) {
    it(`${name}: the heading in the page head is an h1`, async () => {
      const heads = await waitForHeads(mount);
      const inHead = heads.filter((h) => h.inPageHead);
      expect(inHead.length).toBeGreaterThan(0);
      for (const h of inHead) expect(h.lvl).toBe(1);
    });

    it(`${name}: exactly one level-1 heading`, async () => {
      const heads = await waitForHeads(mount);
      expect(heads.filter((h) => h.lvl === 1)).toHaveLength(1);
    });
  }

  it('the Health tab puts no section at the page title\'s level', async () => {
    const heads = await waitForHeads(healthTab);
    const title = heads.find((h) => h.inPageHead);
    expect(title).toBeTruthy();
    const sections = heads.filter((h) => !h.inPageHead);
    // Non-vacuity, and it is the whole point. Three sections render from this
    // fixture — the browser saw four, the fourth being the defects panel,
    // which needs a `blocking_findings` entry. Without a peer on screen this
    // claim says nothing, which is how it would pass over the very defect it
    // exists for.
    expect(sections.filter((s) => s.lvl === 2).length).toBeGreaterThanOrEqual(3);
    for (const s of sections) expect(s.lvl).toBeGreaterThan(title!.lvl);
  });
});

/** Mounts, lets the pending data land, and reads the outline. */
async function waitForHeads(mount: () => HTMLElement): Promise<Head[]> {
  const root = mount();
  // One empty act scope drains React's pending work, rather than polling:
  // `waitFor` would make a positive claim pass eventually and leave the
  // negative ones vacuous. Same device as `intel-panel.test.tsx`.
  const { act } = await import('@testing-library/react');
  await act(async () => {});
  return outline(root);
}

describe('every page head in the product is written that way', () => {
  // The CLASS, not a list of files: a fifth page head is covered the day it
  // is written, and this is the sweep that reaches `SettingsPage`, whose
  // mount would mean a second copy of a thirty-line settings fixture.
  const files = readdirSync(HERE)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => [f, code(readFileSync(join(HERE, f), 'utf8'))] as const)
    .filter(([, src]) => src.includes('soc-panel soc-page-head'));

  it('finds the page heads at all', () => {
    // The vacuity guard: a sweep that matches nothing proves nothing.
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  for (const [name, src] of files) {
    it(`${name} opens its page head with an h1`, () => {
      const head = src.slice(src.indexOf('soc-panel soc-page-head'));
      const firstHeading = head.match(/<h([1-6])[\s>]/);
      expect(firstHeading, `${name}: no heading after the page head`).toBeTruthy();
      expect(firstHeading![1]).toBe('1');
    });
  }
});

describe('the case card is the one screen left at level 2, and says why', () => {
  it('keeps its rule at h2, with no skipped level under it', () => {
    // `styles.css` has called this heading level 1 since it was written —
    // « quand un cas est ouvert, sa regle EST le titre de l'ecran [...] il
    // reprend donc le niveau 1 » — and expressed it as a font-size on an
    // `h2`. Promoting it is NOT a one-line change and it is deliberately not
    // in this pass: the four blocks beneath it are `h3` in four different
    // wrappers (`.soc-panel-head`, `.soc-titled`, `.soc-block`, a bare
    // `.soc-panel`), so an `h1` title would skip level 2 — measured in
    // Chromium: `h1 h3 h3 h4 h4 h4 h4 h3` — and promoting them with it
    // changes their size from 13.76px to 16px on the screen where a human
    // approves a containment action. ROADMAP § 7.
    //
    // What this test claims is the property that must hold either way: the
    // card's own outline does not skip a level.
    const { container } = render(<CaseView alertCase={kase()} onRefresh={() => {}} />);
    const heads = outline(container);
    expect(heads[0]!.inCaseTitle).toBe(true);
    expect(heads[0]!.lvl).toBe(2);
    let prev = heads[0]!.lvl;
    for (const h of heads.slice(1)) {
      expect(h.lvl, `${h.text} after level ${prev}`).toBeLessThanOrEqual(prev + 1);
      prev = h.lvl;
    }
  });

  it('is never on screen beside a page head', () => {
    // The premise that makes « one level-1 per screen » hold on the Alerts
    // tab, and it lives in `App.tsx` rather than in either component: the page
    // head is rendered only while no case is open. Passes before AND after —
    // it is not the fix, it is what keeps the fix true.
    expect(APP).toMatch(/selectedCase \? null : \(/);
  });
});

describe('the login screen names itself at level 1 too', () => {
  it('renders its title as an h1', () => {
    // `LoginScreen` is not exported, and exporting it for a test's
    // convenience is a production change. The claim is made over the source.
    const login = APP.slice(APP.indexOf('function LoginScreen'));
    expect(login).toMatch(/<h1>\{c\.login\.title\}<\/h1>/);
    expect(login).not.toMatch(/<h2>\{c\.login\.title\}<\/h2>/);
  });
});

/* ==========================================================================
 * The stylesheet: which LEVEL each of the three sizes is addressed at
 * ========================================================================== */

describe('the setup checklist is a section, and stays as quiet as it was', () => {
  it('declares level 2 and keeps the level-3 size', () => {
    // It is a sibling panel of the ten setting blocks, so it is a section —
    // and it was an `h3`, which under an `h1` page title is a skipped level
    // rather than a quiet one. Its size does NOT follow its level: the
    // heading carries a count under a kicker that already names the block.
    // « Promote by meaning, not by how big you want the text. »
    const setup = readFileSync(join(HERE, 'SettingsSetup.tsx'), 'utf8');
    expect(code(setup)).toMatch(/<h2 style=\{\{ margin: '2px 0 0' \}\}>\{t\.blocked/);
    const block = SHEET.match(/\.soc-setup \.soc-panel-head h2 \{([^}]*)\}/)?.[1] ?? '';
    // The ELEMENT is named: `.soc-panel h2` is (0,1,1) and a bare class loses
    // to it — the trap `CLARITY.md` § 8 has charged this project three times.
    expect(block).toMatch(/font-size:\s*0\.86rem/);
    // `line-height` too, and it is the one the measurement caught: as an `h3`
    // the heading took 1.05 from the base rule, and `.soc-panel h2` says 1.3.
    // Left to the cascade it grew 14.448px → 17.888px, on all six themes.
    expect(block).toMatch(/line-height:\s*1\.05/);
  });
});

describe('the three sizes are addressed at the three levels', () => {
  it('sizes the page title at h1', () => {
    expect(SHEET).toMatch(/\.soc-panel\.soc-page-head h1\s*\{/);
  });

  it('leaves no h2 rule inside the page head', () => {
    // The regression path, and it is silent: putting the title back at level 2
    // needs a selector here again, and the screen looks unchanged.
    expect(SHEET).not.toMatch(/\.soc-page-head h2/);
  });

  it('carries the tracking and the line height onto the h1 rule', () => {
    // The page title inherited both from `.soc-panel h2`, which an `h1` no
    // longer matches. Dropping them is a silent typographic change: the
    // tracking would go 2.016px → -0.336px and the line height 43.68px →
    // 35.28px at 1280 px.
    const page = SHEET.match(/\.soc-panel\.soc-page-head h1 \{([^}]*)\}/)?.[1] ?? '';
    expect(page).toMatch(/letter-spacing:\s*0\.06em/);
    expect(page).toMatch(/line-height:\s*1\.3/);
  });

  it('leaves the login title at the size it had', () => {
    // The pass moves the outline, not the scale. The sign-in title was an
    // `h2` inside `.soc-panel`, so it took the SECTION step (16px measured,
    // not the bare `h2` clamp); as an `h1` it no longer matches that rule, so
    // the step is written out for it. `h1 { font-size: clamp(1.8rem, 4vw,
    // 2.8rem) }` is what `DESIGN.md` files as « Login screen only » and
    // nothing has ever matched it — left alone deliberately: at 44.8px it is
    // larger than every other title in the product, and whether this screen
    // should shout is a design decision. ROADMAP § 7.
    const login = SHEET.match(/\.soc-login h1 \{([^}]*)\}/)?.[1] ?? '';
    expect(login).toMatch(/font-size:\s*1rem/);
    expect(login).toMatch(/letter-spacing:\s*0\.06em/);
    expect(login).toMatch(/line-height:\s*1\.3/);
  });

  it('still declares three distinct sizes', () => {
    // Passes before AND after, on purpose: the subject is the outline, and a
    // change that collapsed the scale while fixing the levels would be a
    // different and much worse change.
    const sizeOf = (re: RegExp): string => {
      const m = SHEET.match(re);
      expect(m, String(re)).toBeTruthy();
      return m![1]!.trim();
    };
    const page = sizeOf(/\.soc-panel\.soc-page-head h1 \{[^}]*font-size:([^;]+);/);
    const section = sizeOf(/\n\.soc-panel h2 \{[^}]*font-size:([^;]+);/);
    const block = sizeOf(/\nh3 \{ font-size:([^;]+);/);
    expect(new Set([page, section, block]).size).toBe(3);
  });
});

/* ==========================================================================
 * The Guide: seventeen sections, four groups, and one heading between them
 *
 * C0.36 gave the console its level 1 and left the longest screen in the
 * product with nothing under it. Measured in Chromium 153 on the mounted tab,
 * reading the heading nodes out of CDP `Accessibility.getFullAXTree`:
 *
 *     BEFORE   h1
 *     AFTER    h1 h2 h3 h3 h3 h2 h3 h3 h3 h3 h3 h3 h3 h3 h2 h3 h3 h3 h2 h3 h3 h3
 *
 * One heading for a hundred-odd points: the seventeen section titles were
 * `<span class="soc-doc-title">` and the four group labels
 * `<span class="soc-kicker">`, so somebody navigating by heading — the first
 * thing a screen-reader user does on a long document — was handed the whole
 * Guide as one undifferentiated block.
 *
 * Three things these tests are shaped around.
 *
 * ONE — the claim is the OUTLINE, never the size. Measured over 6 themes x 3
 * widths x 3 scenes (idle, a search that matches nothing, a search that
 * filters), the only difference between before and after is the TAG NAME:
 * 396 differences, 396 of them `_tag`, and zero in computed type, geometry,
 * panel height or horizontal overflow. That is what the two stylesheet
 * assertions below protect — promoting the elements WITHOUT them is a silent
 * typographic change (the title loses 15.04px for 13.76px, weight 400 for
 * 900, a 24.064px line box for 14.448px and gains a 12px bottom margin inside
 * a centred flex row; the accordion grows 1805.75px -> 1846.39px).
 *
 * TWO — a heading inside a `<summary>` is exposed, and a closed fold does not
 * hide it. That had to be PROBED rather than assumed, because `CLARITY.md`
 * § 8 records the opposite fact about a fold's CONTENT — a closed
 * `<details>`'s content is absent from the accessibility tree — and the
 * obvious reading of it is that this fix cannot work. It is not the same
 * place: the summary is the disclosure control, not the content. Probed in
 * Chromium 153 on five candidate markups, open and closed:
 *
 *     <summary><span>01</span><h3>T</h3><span>9 points</span></summary>
 *         -> heading level 3, name "T", open=false AND open=true
 *     the same summary with the heading wrapped round everything
 *         -> heading named "01 T 9 points", which is not the section's name
 *     today's markup, spans only
 *         -> no heading at all, either state
 *
 * and the `<summary>`'s own role (`DisclosureTriangle`) and accessible name
 * are unchanged by the promotion. The heading wrapping the whole summary is
 * the plausible wrong shape — it is the one the HTML content model actually
 * prefers — and it names the fold after its number and its point count.
 *
 * THREE — not every kicker is a heading, and the page head is the proof. Its
 * kicker sits above the `h1` that names the screen, so promoting it would put
 * a second heading on the one block that already has its own. The claim that
 * it stays a span passes BEFORE and AFTER, on purpose.
 * ========================================================================== */

/** The Guide's headings, in document order, each tagged with what it names. */
type GuideHead = { lvl: number; text: string; kind: 'title' | 'group' | 'glossary' | 'page' | 'other'; inSummary: boolean };

const guideOutline = (root: HTMLElement): GuideHead[] =>
  [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    lvl: Number(h.tagName[1]),
    text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
    kind: h.classList.contains('soc-doc-title')
      ? 'title'
      : h.classList.contains('soc-doc-group-label')
        ? 'group'
        : h.closest('.soc-doc-glossary')
          ? 'glossary'
          : h.closest('.soc-page-head')
            ? 'page'
            : 'other',
    inSummary: h.parentElement?.tagName === 'SUMMARY',
  }));

const searchGuide = async (text: string) => {
  const { userEvent } = await import('@testing-library/user-event');
  const field = screenQuery('Search the guide');
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
};

/** `screen` is not imported in this file; the field is found on the document. */
function screenQuery(label: string): HTMLElement {
  const field = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(field, `no field labelled ${label}`).toBeTruthy();
  return field!;
}

describe('the Guide has an outline, not one heading and a hundred labels', () => {
  it('names each of its four groups at level 2', () => {
    const heads = guideOutline(render(<DocsPanel />).container);
    const groups = heads.filter((h) => h.kind === 'group');
    // Non-vacuity: four groups render, and the claim says nothing without them.
    expect(groups).toHaveLength(4);
    for (const g of groups) expect(g.lvl).toBe(2);
  });

  it('names each of its seventeen sections at level 3, inside the fold it opens', () => {
    const heads = guideOutline(render(<DocsPanel />).container);
    const titles = heads.filter((h) => h.kind === 'title');
    expect(titles).toHaveLength(17);
    for (const t of titles) {
      expect(t.lvl).toBe(3);
      // The heading is the summary's own child: that is what keeps it in the
      // accessibility tree while the fold is CLOSED, and what keeps the
      // summary's accessible name the section's title. Probed — see the
      // header.
      expect(t.inSummary, `${t.text} is not inside its summary`).toBe(true);
    }
  });

  it('puts no section and no group at the page title\'s level', () => {
    const heads = guideOutline(render(<DocsPanel />).container);
    const title = heads.find((h) => h.kind === 'page');
    expect(title?.lvl).toBe(1);
    const rest = heads.filter((h) => h.kind !== 'page');
    // Lesson TWO of this file's header: the peer claim is made RELATIVE to the
    // title. « Every section is below level 1 » would have passed over the
    // whole C0.36 defect, because 2 is greater than 1.
    expect(rest.length).toBeGreaterThanOrEqual(21);
    for (const h of rest) expect(h.lvl).toBeGreaterThan(title!.lvl);
  });

  it('skips no level, in document order', () => {
    const heads = guideOutline(render(<DocsPanel />).container);
    // The non-vacuity guard, and it is not tidiness: on the unfixed screen
    // this claim passes PERFECTLY, because one heading cannot skip a level.
    // A « no skip » assertion over an outline with no outline in it is the
    // reassurance-over-a-hole this product refuses everywhere else.
    expect(heads.length).toBeGreaterThanOrEqual(22);
    let prev = heads[0]!.lvl;
    expect(prev).toBe(1);
    for (const h of heads.slice(1)) {
      expect(h.lvl, `${h.text} after level ${prev}`).toBeLessThanOrEqual(prev + 1);
      prev = h.lvl;
    }
  });

  it('skips no level under a filter either', async () => {
    // A search re-cuts the page: groups disappear whole, and a group that
    // survives keeps only some of its sections. A filtered outline measured
    // `h1 h2 h3 h2 h3 h3 h3 h3 h2 h3 h2 h3` — no group left without its level,
    // no section left as the first heading under the page title.
    const { container } = render(<DocsPanel />);
    await searchGuide('approval');
    const heads = guideOutline(container);
    expect(heads.filter((h) => h.kind === 'title').length).toBeGreaterThan(0);
    expect(heads.filter((h) => h.kind === 'group').length).toBeGreaterThan(0);
    // Non-vacuity the other way: the filter really did hide something.
    expect(heads.filter((h) => h.kind === 'title').length).toBeLessThan(17);
    let prev = heads[0]!.lvl;
    for (const h of heads.slice(1)) {
      expect(h.lvl, `${h.text} after level ${prev}`).toBeLessThanOrEqual(prev + 1);
      prev = h.lvl;
    }
  });

  it('names the glossary answers at level 2 as well', async () => {
    // « shadow » is the search that found this block in the first place: the
    // Guide calls it watch-only mode, so no section matches and the glossary
    // is the whole answer. A block that IS the answer and carries no heading
    // is unreachable to the reader this pass is for.
    const { container } = render(<DocsPanel />);
    await searchGuide('shadow');
    const heads = guideOutline(container);
    const glossary = heads.filter((h) => h.kind === 'glossary');
    expect(glossary).toHaveLength(1);
    expect(glossary[0]!.lvl).toBe(2);
  });

  it('leaves the page head\'s kicker a span', () => {
    // Passes before AND after. The kicker sits above the `h1` that names the
    // screen: promoting every kicker because two of them name sections would
    // put a second heading on the one block that already has its own.
    const { container } = render(<DocsPanel />);
    const kicker = container.querySelector('.soc-page-head .soc-kicker');
    expect(kicker).toBeTruthy();
    expect(kicker!.tagName).toBe('SPAN');
  });
});

describe('the Guide\'s headings keep the type they had', () => {
  it('takes the section title\'s font from the summary, not from the h3 scale', () => {
    // The half a mutation reaches: promoting the element and skipping this
    // rule is a silent change on seventeen folds. `font: inherit` rather than
    // the summary's numbers copied, because the 760px block takes that
    // summary to 0.86rem and a copy would stop following it.
    const rule = SHEET.match(/\n\.soc-doc-title \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font:\s*inherit/);
    expect(rule).toMatch(/letter-spacing:\s*inherit/);
    expect(rule).toMatch(/margin:\s*0/);
  });

  it('gives a kicker that is also a heading back its weight and line height', () => {
    // `.soc-kicker` already declares the font, the size, the tracking, the
    // colour and the margin; what a heading element adds and it does not is
    // `font-weight` and `line-height`.
    const rule = SHEET.match(/h2\.soc-kicker,\s*\.soc-panel h2\.soc-kicker \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font-weight:\s*inherit/);
    expect(rule).toMatch(/line-height:\s*inherit/);
  });

  it('names the element for the kicker inside a panel', () => {
    // A CLAIM ABOUT DURABILITY, AND IT IS HONEST ABOUT TODAY. Measured in
    // Chromium, the bare `h2.soc-kicker` renders IDENTICALLY: it is (0,1,1),
    // `.soc-panel h2` is (0,1,1), and the bare form wins the tie only by
    // sitting forty lines further down the sheet. Moved above that rule it
    // measures 16.384px -> 13.312px on the glossary block — the defect back,
    // from an edit that touched neither the markup nor this rule. So this
    // assertion cannot be made as a rendering one in jsdom, which applies no
    // cascade, and it would be vacuous as one in a browser: it is read off
    // `styles.css`, the way the `.soc-setup` claim above it is. (0,2,1) is
    // what makes the cascade decide it — the `.soc-field.soc-check-field >
    // span` lesson, paid for once already.
    expect(SHEET).toMatch(/\.soc-panel h2\.soc-kicker/);
  });

  it('leaves the fold\'s own register on the summary', () => {
    // Passes before AND after. The Guide's titles look the way they do
    // because the SUMMARY sets the display face, the capitals and the size —
    // not because a heading scale reached them. A change that moved that onto
    // the heading would pass every assertion above and alter the screen.
    const rule = SHEET.match(/\.soc-doc summary \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font-family:\s*var\(--display\)/);
    expect(rule).toMatch(/text-transform:\s*uppercase/);
    expect(rule).toMatch(/font-size:\s*0\.94rem/);
  });
});
