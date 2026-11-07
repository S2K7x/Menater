/**
 * @vitest-environment jsdom
 */
/**
 * The scan report: five findings, and the only heading on it belonged to the
 * empty state.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * The scan report is the longest screen this product renders, and it is one
 * nobody has ever swept: reaching it costs a model key, real code and a few
 * minutes, so it is in no tab list and `CLARITY.md` § 7 files it under
 * *« enumerate the screens you cannot reach »*. Mounted with a five-finding
 * report in Chromium 1243 — the device that file prescribes, a throwaway
 * preview page deleted in the same session — and read out of CDP
 * `Accessibility.getFullAXTree`, walked from the root (§ 7 again: the flat
 * node list is not in document order):
 *
 *     BEFORE   h1 CODE
 *              h2 YOUR REPORT
 *              h2 WHAT THIS SCAN ACTUALLY USED
 *
 *     AFTER    h1 CODE
 *              h2 YOUR REPORT
 *              h3 GET /orders/:id
 *              h3 GET /invoices/:invoiceId/attachments/:attachmentId
 *              h3 POST /admin/users/:id/impersonate
 *              h3 DELETE /api/v2/projects/:projectId/members
 *              h3 GET /files/:key
 *              h2 WHAT THIS SCAN ACTUALLY USED
 *
 * Three headings for 3,727 px of document at 1280 px — 5,857 at 320 px — and
 * the unit of this screen is the FINDING. A reader listing the headings got
 * the page, the report and the bill, and no way to reach any of the five
 * things the report is about.
 *
 * The tell is in the same slot: `NothingFound` — the state where there is
 * nothing to say — renders an `h3` and always has. **The empty report could be
 * navigated and the full one could not.**
 *
 * This is C0.44 in the other half of the product: the Guide's seventeen
 * section titles were spans too, and that pass promoted them. *The mirror of a
 * rule is not the rule.*
 *
 * ============================================================================
 * THE HEADING IS A VALUE, SO IT KEEPS ITS SPELLING
 *
 * `.vp-embed h1, .vp-embed h2, .vp-embed h3` sets the display face, 900 and
 * `text-transform: uppercase`. A route is case-sensitive. Promoted and left to
 * that rule, measured:
 *
 *     GET /ORDERS/:ID   Archivo Black 13.76px/900, uppercase, display: block
 *
 * — and Chromium computes an accessible name from RENDERED text, so a screen
 * reader dictates the wrong path too. Third instance of this trap after J0.4's
 * repository URL and C0.42's `ossec.conf` path, and the rule is `DESIGN.md`'s:
 * a name may take the display register, a value keeps its spelling, in mono.
 *
 * **The parent is NAMED, and that is not a style preference.** A bare
 * `h3.vp-finding-route` is (0,1,1), which TIES with `.vp-embed h3` and wins
 * only by sitting further down the sheet. Measured by injecting a copy of the
 * base rule after the candidate, i.e. what moving the rule up amounts to:
 *
 *     .vp-embed h3.vp-finding-route  (0,2,1)   GET /orders/:id, ui-monospace 12.48px
 *     h3.vp-finding-route            (0,1,1)   GET /ORDERS/:ID, Archivo Black 13.76px
 *
 * Fifth time this project has paid for that; the two earlier ones are
 * `.soc-field.soc-check-field > span` and `.soc-panel h2.soc-kicker`.
 *
 * Every one of the nine declarations is load-bearing, each measured by
 * dropping it alone from the rule:
 *
 *     without font-family      ui-monospace → Archivo Black
 *     without font-size        12.48px → 13.76px
 *     without font-weight      400 → 900
 *     without text-transform   GET /orders/:id → GET /ORDERS/:ID
 *     without letter-spacing   normal → 0.7488px
 *     without line-height      19.968px → 13.104px
 *     without margin           margin-bottom 0 → 12px
 *     without display          inline → block, x 145 → 64, page 3,727 → 3,827 px
 *     without overflow-wrap    document 320 → 397 px at a 320 px viewport
 *
 * With all nine, the computed type and the bounding box of the route are
 * IDENTICAL to the span's, on all six themes at 320, 375 and 1280 px.
 *
 * ============================================================================
 * AND THE SAME VALUE WAS FLOORING THE PAGE
 *
 * C0.42's row says it: the value put in a heading is also the longest
 * unbreakable token on its line, so marking it is what stops it flooring the
 * page. `GET /invoices/:invoiceId/attachments/:attachmentId` is 345.3 px of
 * mono with nowhere to break, in a 264 px content box. Measured on the report
 * mounted at the two widths WCAG 2.2 § 1.4.10 (Reflow, AA) is about:
 *
 *     state                      320 px        375 px      1280 px
 *     BEFORE                     397           397         1280
 *     after, folds shut          320           375         1280
 *     after, technical open      320           375         1280
 *     after, route only          370           375         1280
 *
 * That last row is the neighbour the same run found: with the technical panel
 * open, the `Where` definition holds `src/modules/orders/order.controller.ts`,
 * a 38-character path in a bare `dd`, and it takes the page to 370 px on its
 * own. *A width that passes is not a width that has margin* — and the rule is
 * *grep for the neighbours of the line you are fixing*, not only its callers.
 *
 * The price is stated rather than hidden: reflow makes the report TALLER —
 * 5,857 → 5,905 px at 320 px and 5,094 → 5,118 at 375 — and 0 px at 1280. A
 * page that scrolls sideways hides its own right-hand edge; a taller page
 * hides nothing.
 *
 * The code excerpt is deliberately NOT touched: `.vp-code-pre` scrolls on
 * purpose (*« the code overflows horizontally rather than breaking the
 * layout »*), and breaking a line of source mid-token is how somebody reads
 * the wrong statement.
 *
 * ============================================================================
 * WHY THE STYLESHEET IS READ AS TEXT
 *
 * jsdom applies no cascade and computes no layout, so the suite cannot see any
 * of the numbers above — `readability.test.tsx`, `narrow-viewport.test.tsx`
 * and `heading-outline.test.tsx` all read `styles.css` for that reason. Each
 * stylesheet claim therefore comes with a MARKUP claim beside it: a rule that
 * exists is not a rule that reaches anything.
 *
 * Comments are stripped from everything read that way — this header quotes the
 * selectors it hunts, and a test that reads its own prose goes green on its
 * own explanation.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { render } from '../test-utils.tsx';
import {
  NothingFound,
  ReportView,
  type ReportFinding,
  type SecurityReport,
} from './ReportView.tsx';
import { resetPreferences } from '../lib/preferences.ts';

afterEach(() => {
  cleanup();
  resetPreferences();
});

const HERE = import.meta.dirname;

/** Source with its comments stripped. A test must not read its own prose. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SHEET = code(readFileSync(join(HERE, '..', 'styles.css'), 'utf8'));
const REPORT_SRC = code(readFileSync(join(HERE, 'ReportView.tsx'), 'utf8'));

const finding = (over: Partial<ReportFinding> = {}): ReportFinding => ({
  severity: 'critical',
  report_level: 'critical',
  vulnerability: 'IDOR',
  route: '/orders/:id',
  http_method: 'GET',
  file: 'src/modules/orders/order.controller.ts',
  line: 142,
  claude_verdict: 'confirmed',
  claude_reasoning: 'The handler reads the identifier out of the path and never compares it to the signed-in user.',
  technical_summary: 'findById(id) with no userId filter on the query.',
  plain_language_summary: 'Anyone signed in can read another customer order.',
  suggested_fix_direction: 'Filter the query on the signed-in user.',
  owasp_category: 'A01',
  evidence: 'code',
  local_confidence_score: 0.91,
  detected_by: ['static'],
  code_excerpt: null,
  ...over,
});

/**
 * The five findings of the measurement above. The long route is the one that
 * floored the page, and it is in the fixture for that reason: a report of
 * `/orders/:id` alone shows none of this.
 */
const ROUTES: Array<[string, string]> = [
  ['GET', '/orders/:id'],
  ['GET', '/invoices/:invoiceId/attachments/:attachmentId'],
  ['POST', '/admin/users/:id/impersonate'],
  ['DELETE', '/api/v2/projects/:projectId/members'],
  ['GET', '/files/:key'],
];

const report = (): SecurityReport => ({
  scan_summary: {
    total_findings: ROUTES.length,
    critical: 3,
    warning: 2,
    dismissed_by_arbiter: 0,
    not_arbitrated: 0,
    plain_language_intro: 'We read 214 files and kept five points worth your time.',
  },
  findings: ROUTES.map(([http_method, route]) => finding({ http_method, route })),
  dismissed: [],
  source_root: null,
});

/** Every heading the screen rendered, in document order, with its level. */
const outline = (root: HTMLElement): Array<{ lvl: number; name: string }> =>
  [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    lvl: Number(h.tagName[1]),
    name: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));

/* ==========================================================================
 * 1. Each finding is a heading, and the heading names the finding
 * ========================================================================== */

describe('a report of five findings has five findings in its outline', () => {
  it('names every one of them, at level 3, with its route spelled as it is', () => {
    const { container } = render(<ReportView report={report()} />);
    const heads = outline(container);
    // Non-vacuity, and it is the whole point: five findings are mounted, so a
    // claim that passes with none of them named would say nothing.
    expect(container.querySelectorAll('article.vp-finding')).toHaveLength(ROUTES.length);
    for (const [method, route] of ROUTES) {
      expect(
        heads.find((h) => h.lvl === 3 && h.name === `${method} ${route}`),
        `${method} ${route} is not a level-3 heading`,
      ).toBeTruthy();
    }
  });

  it('puts them UNDER the report, not beside it', () => {
    // The report's own heading is the section; a finding is a block inside it.
    // Written relative to the report's level rather than as « level 3 », which
    // would pass if both moved together and the outline flattened again.
    const { container } = render(<ReportView report={report()} />);
    const heads = outline(container);
    const reportHead = heads[0]!;
    expect(reportHead.lvl).toBe(2);
    const routes = heads.filter((h) => /^(GET|POST|DELETE) \//.test(h.name));
    expect(routes).toHaveLength(ROUTES.length);
    for (const r of routes) expect(r.lvl).toBeGreaterThan(reportHead.lvl);
  });

  it('skips no level, over an outline long enough for a skip to exist', () => {
    // `heading-outline.test.tsx` paid for this: « no level is skipped » passes
    // perfectly on a screen carrying ONE heading, which is the state this
    // screen was in. The floor is what makes the claim mean something.
    const { container } = render(<ReportView report={report()} />);
    const heads = outline(container);
    expect(heads.length).toBeGreaterThanOrEqual(6);
    let prev = heads[0]!.lvl;
    for (const h of heads.slice(1)) {
      expect(h.lvl, `${h.name} after level ${prev}`).toBeLessThanOrEqual(prev + 1);
      prev = h.lvl;
    }
  });

  it('is the route and nothing else: the severity badge stays out of the name', () => {
    // The C0.44 lesson. Wrapping the whole header is the tidy move and it
    // names the finding « CRITICAL GET /orders/:id » — after its severity
    // rather than after the address it is about.
    const { container } = render(<ReportView report={report()} />);
    const head = screen.getByRole('heading', { level: 3, name: 'GET /orders/:id' });
    expect(head.querySelector('.vp-badge')).toBeNull();
    expect(container.querySelector('.vp-finding-head .vp-badge')).toBeTruthy();
  });
});

describe('the state with nothing to say keeps the heading it always had', () => {
  it('still names itself at level 3', () => {
    // Passes BEFORE and after, on purpose. It is the tell this pass came from:
    // the empty report could be navigated and the full one could not.
    const { container } = render(<NothingFound coverage={null} />);
    const heads = outline(container);
    expect(heads).toHaveLength(1);
    expect(heads[0]!.lvl).toBe(3);
  });
});

/* ==========================================================================
 * 2. A value in a heading keeps its spelling — and the parent is named
 * ========================================================================== */

/** The one rule that dresses the promoted heading. */
const ROUTE_RULE = SHEET.match(/\.vp-embed h3\.vp-finding-route \{([^}]*)\}/)?.[1] ?? '';

describe('the route is dressed as a value, not as a heading', () => {
  it('is addressed with its parent NAMED, so it cannot lose on source order', () => {
    // A bare `h3.vp-finding-route` is (0,1,1) — the same as `.vp-embed h3` —
    // and would win only by sitting further down the file. Measured: it
    // renders `GET /ORDERS/:ID` in Archivo Black when the base rule follows
    // it. So EVERY occurrence of the compound has to carry the parent; a
    // blanket « the bare form is absent » cannot be written, because the named
    // selector contains the bare one as a substring.
    const all = SHEET.match(/h3\.vp-finding-route\s*\{/g) ?? [];
    const named = SHEET.match(/\.vp-embed h3\.vp-finding-route\s*\{/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(named).toHaveLength(all.length);
  });

  it('is declared exactly once', () => {
    // A duplicated rule is worse than a wrong one: the wrong one answers when
    // you edit it. `.soc-case-layout` cost this project a whole measurement.
    expect(SHEET.match(/\.vp-embed h3\.vp-finding-route \{/g)).toHaveLength(1);
  });

  for (const [prop, re, why] of [
    ['text-transform', /text-transform:\s*none/, 'GET /orders/:id → GET /ORDERS/:ID'],
    ['font-family', /font-family:\s*var\(--mono\)/, 'ui-monospace → Archivo Black'],
    ['font-size', /font-size:\s*0\.78rem/, '12.48px → 13.76px'],
    ['font-weight', /font-weight:\s*400/, '400 → 900'],
    ['letter-spacing', /letter-spacing:\s*normal/, 'normal → 0.7488px'],
    ['line-height', /line-height:\s*inherit/, '19.968px → 13.104px'],
    ['margin', /margin:\s*0/, 'margin-bottom 0 → 12px'],
    ['display', /display:\s*inline/, 'inline → block, the badge loses its line'],
  ] as Array<[string, RegExp, string]>) {
    it(`carries ${prop} — without it, ${why}`, () => {
      expect(ROUTE_RULE).toMatch(re);
    });
  }
});

/* ==========================================================================
 * 3. Reflow: two machine values, and the spelling that changes min-content
 * ========================================================================== */

describe('the two machine values on this screen are allowed to break', () => {
  it('lets the route break', () => {
    // 397 → 320 px of document at a 320 px viewport.
    expect(ROUTE_RULE).toMatch(/overflow-wrap:\s*(anywhere|break-all)|word-break:\s*break-all/);
  });

  it('lets the file path break', () => {
    // The neighbour: 370 → 320 px with the technical panel open.
    const where = SHEET.match(/\.vp-finding-where \{([^}]*)\}/)?.[1] ?? '';
    expect(where).toMatch(/overflow-wrap:\s*(anywhere|break-all)|word-break:\s*break-all/);
  });

  it('neither is written break-word', () => {
    // `overflow-wrap: break-word` wraps the visible line and leaves
    // min-content where it was. Measured here, it happens to give the same
    // document width TODAY, because neither element is a flex or grid item —
    // and `.vp-finding-head` carries no rule at all, so one `display: flex`
    // away it would silently stop working. The sheet already spells every
    // other machine value `anywhere`.
    const where = SHEET.match(/\.vp-finding-where \{([^}]*)\}/)?.[1] ?? '';
    // Both rules have to EXIST first: a « not break-word » claim over a
    // selector nobody wrote is satisfied by a stylesheet with no rule at all,
    // which is the shape this project calls a vacuous pass.
    expect(ROUTE_RULE.trim()).not.toBe('');
    expect(where.trim()).not.toBe('');
    expect(ROUTE_RULE).not.toMatch(/overflow-wrap:\s*break-word/);
    expect(where).not.toMatch(/overflow-wrap:\s*break-word/);
  });

  it('puts that class on the definition that holds the path', () => {
    // A rule that exists is not a rule that reaches anything.
    const { container } = render(<ReportView report={report()} />);
    fireEvent.click(container.querySelector('button.vp-toggle')!);
    const where = container.querySelector('dd.vp-finding-where');
    expect(where, 'no dd carries vp-finding-where once the technical panel is open').toBeTruthy();
    expect(where!.textContent).toContain('src/modules/orders/order.controller.ts');
  });

  it('leaves the code excerpt scrolling, which is what it is for', () => {
    // Passes BEFORE and after. Breaking a line of source mid-token is how
    // somebody reads the wrong statement, so `.vp-code-pre` keeps its own
    // horizontal scroll and is deliberately outside this pass.
    const pre = SHEET.match(/\.vp-code-pre \{([^}]*)\}/)?.[1] ?? '';
    expect(pre).toMatch(/overflow-x:\s*auto/);
    expect(pre).not.toMatch(/overflow-wrap/);
  });
});

/* ==========================================================================
 * 4. The markup the stylesheet is about
 * ========================================================================== */

describe('the component renders the elements those rules name', () => {
  it('renders the route as an h3, not as a span', () => {
    expect(REPORT_SRC).toMatch(/<h3 className="vp-finding-route">/);
    expect(REPORT_SRC).not.toMatch(/<span className="vp-finding-route">/);
  });
});
