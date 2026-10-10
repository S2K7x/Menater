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
