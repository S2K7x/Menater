/**
 * @vitest-environment jsdom
 */
/**
 * The Rules tab skipped a heading level in every state you click into.
 *
 * ============================================================================
 * WHAT THIS FILE CLAIMS
 *
 * C0.36 gave the console an `h1`, C0.44 the Guide's section titles, C0.45 the
 * scan report's findings, C0.46 Settings -> Code analysis and C0.47 the three
 * folds that ARE their panel. Every one of those swept DESTINATIONS — tabs and
 * sub-tabs. `CLARITY.md` § 7's own rule is that **a state you click into is a
 * screen too**, and the Rules tab has three of them: the template picker, the
 * editor, and both at once. None was in any sweep, and all three skipped.
 *
 * Measured in Chromium 1243 on the screens mounted with data, heading nodes
 * read out of CDP `Accessibility.getFullAXTree` and WALKED from the root — the
 * flat `nodes` array is not in document order (`CLARITY.md` § 7):
 *
 *     scene              BEFORE            AFTER
 *     rules, idle        h1 h2             h1 h2
 *     + template picker  h1 h4 h2          h1 h2 h2
 *     + editor only      h1 h3 h4 h2       h1 h2 h3 h2
 *     + both open        h1 h4 h3 h4 h2    h1 h2 h2 h3 h2
 *     Settings, sources  h2 h4             h2 h3
 *     Workflow, a node   h2 h2 h3 h4 h2    h2 h2 h3 h4 h2   (correct already)
 *
 * `h1 RULES` -> `h4 TEMPLATES` skips two levels, in the state somebody reaches
 * by pressing the SECOND BUTTON on the page, on the screen where a team writes
 * the rules deciding what stops reaching a human. Over 6 scenes x 6 themes x 3
 * widths (320, 375, 1280) the skips go **72 -> 0**, and the whole before/after
 * difference in computed type and geometry is **126 differences, every one of
 * them the TAG NAME**: no font size, line height, tracking, weight, family,
 * transform, colour or bounding box moved, and no document width, panel total
 * or long-heading count moved in any of the 108 cells.
 *
 * Five things these tests are shaped around.
 *
 * ONE — `.soc-wf-subhead` has FOUR call sites and they are not all the same
 * level. `WorkflowPanel`'s node card sits under an `h3` and is CORRECT as an
 * `h4`; promoting the class everywhere would have broken it. The level belongs
 * to the CALL SITE, so the call sites are discovered from source and their
 * number is asserted: a fifth one fails and asks to be measured, which is how
 * three of these four stayed wrong through five heading passes.
 *
 * TWO — the claim is about the OUTLINE, never about the size. The sizes are
 * unchanged to the hundredth of a pixel on all six themes; what changed is
 * which element carries them. jsdom applies no cascade, so the rules that hold
 * the type are read out of `styles.css` as TEXT, the way `heading-outline.test.tsx`
 * and `narrow-viewport.test.tsx` already do — with comments stripped, because
 * the paragraphs above and the sheet's own quote the selectors this file hunts,
 * and a test that reads its own prose goes green on its own explanation.
 *
 * THREE — « no level is skipped » passes perfectly on a screen carrying ONE
 * heading, which is the state the Guide was in (`CLARITY.md` § 7). So every
 * monotonicity claim here carries a FLOOR on how many headings it walked and
 * names the ones it is about. 7 of these 12 are red on unmodified `main`.
 *
 * FOUR — the boundary is half the fix, and two tests claim it by passing
 * BEFORE and after on purpose: `WorkflowPanel`'s `h4` stays an `h4`, and the
 * idle Rules tab is unchanged. A pass that promoted every subhead would be
 * green on the skips and would have moved a correct screen.
 *
 * FIVE — the level-2 selectors must out-specify `.soc-panel h2` (0,1,1), or
 * they tie and win only by source order. Probed in Chromium by editing the
 * sheet: written bare, the template block measures 10.56px -> 16px and the
 * editor title 13.76px -> 16px, i.e. the defect back. The level-3 member's
 * parent is NOT load-bearing today and the sheet says so; the structural
 * claim below is therefore written over the level-2 ones only, where a
 * mutation can kill it.
 * ============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { RulesPage } from './RulesPage.tsx';
import { SourcesPanel } from './SettingsSetup.tsx';
import { WorkflowPanel } from './WorkflowPanel.tsx';
import { api } from '../lib/api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HERE = import.meta.dirname;

/** Source with its comments stripped. A test must not read its own prose. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SHEET = code(readFileSync(join(HERE, '..', 'styles.css'), 'utf8'));

type Head = { lvl: number; text: string };

/** Every heading the screen rendered, in document order, with its level. */
const outline = (root: HTMLElement): Head[] =>
  [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    lvl: Number(h.tagName[1]),
    text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));

/** Every place the outline jumps DOWN by more than one level. */
const skips = (heads: Head[]): string[] => {
  const out: string[] = [];
  let prev: number | null = null;
  for (const h of heads) {
    if (prev !== null && h.lvl > prev + 1) out.push(`h${prev} -> h${h.lvl} ${h.text}`);
    prev = h.lvl;
  }
  return out;
};

const RULE = {
  id: 'r1',
  name: 'Nightly backup agent',
  enabled: true,
  action: 'auto_close',
  severity: null,
  reason: 'Known maintenance window',
  conditions: [{ field: 'rule_name', op: 'contains', values: ['backup'] }],
  expires_at: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by: 'alice',
  match_count: 3,
  last_matched_at: '2026-02-01T00:00:00Z',
};

const TEMPLATE = {
  id: 't1',
  title: 'Vulnerability scanner',
  description: 'Close alerts raised by the authorised scanner.',
  action: 'auto_close',
  severity: null,
  conditions: [{ field: 'source_ip', op: 'equals', values: ['10.0.0.9'] }],
  expiresInDays: null,
  placeholders: [],
};

/** The Rules tab with a rule and a template, i.e. not an empty screen. */
async function rulesTab(): Promise<HTMLElement> {
  vi.spyOn(api, 'rules').mockResolvedValue({ rules: [RULE] } as never);
  vi.spyOn(api, 'ruleTemplates').mockResolvedValue({ templates: [TEMPLATE], drafts: [] } as never);
  const { container } = render(<RulesPage />);
  await screen.findByText(RULE.name);
  return container;
}

const press = async (label: RegExp) =>
  userEvent.click(await screen.findByRole('button', { name: label }));

/**
 * `SourcesPanel` as `IngestionPanel` mounts it. The parent's level is read out
 * of THAT file rather than assumed here, so the pair cannot drift apart: a
 * test that hardcodes the wrapper vouches for a wrapper the product may have
 * changed.
 */
const SOURCES = {
  sources: [
    {
      source: 'wazuh',
      label: 'Wazuh',
      endpoint: 'http://localhost:4400/api/ingest/wazuh',
      setup: {
        install: ['scp integrations/wazuh/custom-menater root@HOST:/var/ossec/'],
        configFile: '/var/ossec/etc/ossec.conf',
        config: '<integration>\n  <name>custom-menater</name>\n</integration>',
        verify: 'tail -f /var/ossec/logs/integrations.log',
      },
      fields: { alert_id: 'id', rule_name: 'rule.description', host: 'agent.name' },
    },
  ],
};

async function sourcesSection(): Promise<HTMLElement> {
  vi.spyOn(api, 'ingestSources').mockResolvedValue(SOURCES as never);
  const { container } = render(
    <section className="soc-panel">
      <h2>Push sources</h2>
      <SourcesPanel />
    </section>,
  );
  await screen.findByText(SOURCES.sources[0].endpoint);
  return container;
}

const WORKFLOWS = {
  workflows: [
    {
      id: '01-ingestion',
      name: 'Ingestion',
      version: 1,
      nodes: [
        { id: 'webhook', type: 'trigger.webhook', label: 'POST /soc/alert', params: {}, position: { x: 0, y: 0 }, effect: 'pure' },
        { id: 'dedup', type: 'postgres', label: 'Deduplication', note: 'A note.', params: { sql: 'SELECT 1' }, position: { x: 200, y: 0 }, effect: 'write' },
      ],
      edges: [{ from: 'webhook', fromPort: 'main', to: 'dedup' }],
    },
  ],
  variables: { 'pipeline.shadowMode': true },
};

/* ==========================================================================
 * The outline, in every state you click into
 * ========================================================================== */

describe('no state of the Rules tab skips a heading level', () => {
  it('idle — unchanged, and this test passes before the fix as much as after', async () => {
    const heads = outline(await rulesTab());
    expect(heads.map((h) => h.lvl)).toEqual([1, 2]);
    expect(skips(heads)).toEqual([]);
  });

  it('the template picker open: h1 -> h4 skipped TWO levels', async () => {
    const root = await rulesTab();
    await press(/From a template/i);
    const heads = await waitFor(() => {
      const h = outline(root);
      expect(h.some((x) => /templates/i.test(x.text))).toBe(true);
      return h;
    });
    // The floor: a monotonicity claim over one heading is vacuous.
    expect(heads.length).toBeGreaterThanOrEqual(3);
    expect(skips(heads)).toEqual([]);
  });

  it('the editor open: h1 -> h3 skipped a level', async () => {
    const root = await rulesTab();
    await press(/^New rule/i);
    const heads = await waitFor(() => {
      const h = outline(root);
      expect(h.some((x) => /conditions/i.test(x.text))).toBe(true);
      return h;
    });
    expect(heads.length).toBeGreaterThanOrEqual(4);
    expect(skips(heads)).toEqual([]);
  });

  /*
   * The sixth state, and the one the sweep that found this did not measure
   * either: the editor opened on an EXISTING rule, where its title is the
   * rule's own name. Measured in Chromium, `h1 RULES` · `h2 NIGHTLY BACKUP
   * AGENT` · `h3 CONDITIONS` · `h2 TRY IT ON AN ALERT`.
   */
  it('the editor opened on an existing rule', async () => {
    const root = await rulesTab();
    await press(new RegExp(`Edit rule .${RULE.name}.`));
    const heads = await waitFor(() => {
      const h = outline(root);
      expect(h.some((x) => x.text === RULE.name)).toBe(true);
      expect(h.some((x) => /conditions/i.test(x.text))).toBe(true);
      return h;
    });
    expect(heads.length).toBeGreaterThanOrEqual(4);
    expect(skips(heads)).toEqual([]);
  });

  it('both open at once', async () => {
    const root = await rulesTab();
    await press(/From a template/i);
    await press(/^New rule/i);
    const heads = await waitFor(() => {
      const h = outline(root);
      expect(h.some((x) => /templates/i.test(x.text))).toBe(true);
      expect(h.some((x) => /conditions/i.test(x.text))).toBe(true);
      return h;
    });
    expect(heads.length).toBeGreaterThanOrEqual(5);
    expect(skips(heads)).toEqual([]);
  });
});

/* ==========================================================================
 * The level each promoted heading carries
 * ========================================================================== */

describe('the level belongs to the call site', () => {
  it("the template block is a section of the screen, so level 2", async () => {
    const root = await rulesTab();
    await press(/From a template/i);
    const h = await waitFor(() => {
      const found = outline(root).find((x) => /templates/i.test(x.text));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(h.lvl).toBe(2);
  });

  it("the editor's title is a section of the screen, so level 2", async () => {
    const root = await rulesTab();
    await press(/^New rule/i);
    const h = await waitFor(() => {
      const found = outline(root).find((x) => /new rule/i.test(x.text));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(h.lvl).toBe(2);
  });

  it("the editor's conditions are a block inside that section, so level 3", async () => {
    const root = await rulesTab();
    await press(/^New rule/i);
    const h = await waitFor(() => {
      const found = outline(root).find((x) => /conditions/i.test(x.text));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(h.lvl).toBe(3);
  });

  it('the log-source catalogue sits under an h2, so level 3 — and no skip', async () => {
    const heads = outline(await sourcesSection());
    expect(heads.length).toBeGreaterThanOrEqual(2);
    expect(heads[0].lvl).toBe(2);
    expect(skips(heads)).toEqual([]);
  });

  it("`IngestionPanel` really does title that panel with an h2", () => {
    // The render above asserts the pair; this asserts the product supplies the
    // parent it was mounted under, so the two cannot drift apart silently.
    const panel = code(readFileSync(join(HERE, 'IngestionPanel.tsx'), 'utf8'));
    const at = panel.indexOf('<SourcesPanel');
    expect(at, 'IngestionPanel no longer renders <SourcesPanel />').toBeGreaterThan(0);
    const before = panel.slice(0, at);
    const lastHeading = [...before.matchAll(/<h([1-6])[ >]/g)].at(-1);
    expect(lastHeading, 'no heading precedes <SourcesPanel />').toBeTruthy();
    expect(Number(lastHeading![1])).toBe(2);
  });

  /*
   * THE BOUNDARY, and it passes BEFORE the change as much as after. This is
   * the one call site of `.soc-wf-subhead` that was already right: its node
   * card sits under an `h3`, so an `h4` is the correct level and a pass that
   * promoted the class rather than the call site would have moved it.
   */
  it("WorkflowPanel's node card stays an h4, because it is under an h3", async () => {
    vi.spyOn(api, 'workflows').mockResolvedValue(WORKFLOWS as never);
    const { container } = render(<WorkflowPanel />);
    const rows = await screen.findAllByRole('button', { name: /Deduplication/ });
    await userEvent.click(rows.find((el) => el.tagName === 'BUTTON') ?? rows[0]);
    const heads = await waitFor(() => {
      const h = outline(container);
      expect(h.some((x) => x.lvl === 4)).toBe(true);
      return h;
    });
    const sub = heads.find((h) => h.lvl === 4)!;
    const before = heads.slice(0, heads.indexOf(sub));
    expect(before.at(-1)!.lvl).toBe(3);
    expect(skips(heads)).toEqual([]);
  });
});

/* ==========================================================================
 * The type is held, and the rules that hold it name the element
 * ========================================================================== */

/** Every selector in the sheet that declares `prop` and mentions `cls`. */
const selectorsSetting = (cls: string, prop: string): string[] =>
  [...SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel, body]) => sel.includes(cls) && new RegExp(`(^|;)\\s*${prop}\\s*:`).test(body))
    .map(([, sel]) => sel.replace(/\s+/g, ' ').trim());

describe('promoting the level does not move the type', () => {
  it('the level-2 subhead keeps its size, tracking and line height', () => {
    for (const prop of ['font-size', 'letter-spacing', 'line-height']) {
      const held = selectorsSetting('soc-wf-subhead', prop)
        .filter((s) => /h2\.soc-wf-subhead/.test(s));
      expect(held.length, `nothing holds ${prop} on h2.soc-wf-subhead`).toBeGreaterThan(0);
    }
  });

  it('the level-3 subhead keeps its line height', () => {
    const held = selectorsSetting('soc-wf-subhead', 'line-height')
      .filter((s) => /h3\.soc-wf-subhead/.test(s));
    expect(held.length).toBeGreaterThan(0);
  });

  it("the editor's title keeps its size and line height", () => {
    for (const prop of ['font-size', 'line-height']) {
      const held = selectorsSetting('soc-rule-title', prop);
      expect(held.length, `nothing holds ${prop} on .soc-rule-title`).toBeGreaterThan(0);
    }
  });

  /*
   * EVERY declaration, not the one somebody edited. `.soc-panel h2` is
   * (0,1,1): a level-2 rule written as a bare class is (0,1,0) and loses
   * outright, and written `h2.soc-wf-subhead` it TIES and wins only by source
   * order. Measured by editing the sheet: both bare forms put the defect back
   * (10.56px -> 16px and 13.76px -> 16px). Asserted over every matching
   * selector so a second declaration added later is covered the day it is
   * written — the `.soc-case-layout` lesson in `CLARITY.md` § 8.
   */
  it('every level-2 rule that holds this type names the element AND the panel', () => {
    const checked: string[] = [];
    for (const [cls, el] of [['soc-wf-subhead', 'h2'], ['soc-rule-title', 'h2']] as const) {
      for (const prop of ['font-size', 'letter-spacing', 'line-height']) {
        for (const sel of selectorsSetting(cls, prop)) {
          // The class's own base rule dresses the `h4` call site and is not a
          // level-2 rule; everything else that sets this type must out-specify
          // `.soc-panel h2`.
          if (!new RegExp(`${el}\\.${cls}|${cls}\\b(?![-\\w])`).test(sel)) continue;
          if (sel === `.${cls}`) continue;
          for (const member of sel.split(',').map((m) => m.trim())) {
            if (!member.includes(cls)) continue;
            if (!member.includes(`${el}.${cls}`)) continue;
            checked.push(member);
            expect(member, `${member} must name .soc-panel to beat .soc-panel h2`)
              .toMatch(/\.soc-panel\s+h2\./);
          }
        }
      }
    }
    // A sweep that matched nothing agrees with everything.
    expect(checked.length, 'no level-2 type rule was examined').toBeGreaterThanOrEqual(2);
  });
});

/* ==========================================================================
 * The call sites are DISCOVERED, so a fifth one cannot be silent
 * ========================================================================== */

describe('the call sites of a class that spans two levels', () => {
  it('there are exactly four, and each is examined above', () => {
    const files = readdirSync(join(HERE)).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
    const uses: Array<[string, string]> = [];
    for (const f of files) {
      const src = code(readFileSync(join(HERE, f), 'utf8'));
      for (const m of src.matchAll(/<h([1-6])\s+className="soc-wf-subhead"/g)) uses.push([f, `h${m[1]}`]);
    }
    /*
     * Both directions. A new call site fails and asks what names ITS section —
     * which is the question three of these four got wrong through five heading
     * passes — and a call site that goes away fails too, instead of letting
     * this file pass over nothing.
     */
    expect(uses.sort()).toEqual([
      ['RulesPage.tsx', 'h2'],
      ['RulesPage.tsx', 'h3'],
      ['SettingsSetup.tsx', 'h3'],
      ['WorkflowPanel.tsx', 'h4'],
    ]);
  });
});
