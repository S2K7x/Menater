/**
 * @vitest-environment jsdom
 */
/**
 * `role="tab"` is a promise, and this file is the promise written down.
 *
 * ============================================================================
 * WHAT A ROLE COSTS
 *
 * Putting `role="tab"` on a button does not describe it — it ANNOUNCES a
 * contract to anything that reads the page without looking at it. A screen
 * reader tells its user, in so many words, that they are on tab 3 of 10, that
 * the arrow keys move between them, and that a panel somewhere is the thing
 * this tab controls. None of that comes from the markup; all of it comes from
 * the role, and all of it is a lie unless the component keeps it.
 *
 * Two halves of the contract, and both were declared and unimplemented:
 *
 *   1. THE PANEL EXISTS. Every tab carried `aria-controls="soc-subpanel-<id>"`.
 *      Two of the four call sites — Ingestion and Workflow — render no
 *      `SectionPanel` at all, so those IDREFs pointed at nothing. A reference
 *      to an element that is not there is not a weaker relationship than a
 *      correct one, it is a broken one: "go to the controlled panel" arrives
 *      somewhere no assistive technology can follow.
 *
 *   2. THE ARROW KEYS MOVE. A tablist is ONE stop in the tab order and the
 *      arrows choose within it. With every tab at the browser default, Settings
 *      put ten stops between the page and its first setting — and a user who
 *      was told to press an arrow key pressed it and nothing happened, which is
 *      indistinguishable from a broken page.
 *
 * These are asserted on the REAL call sites and not on a synthetic tablist:
 * the defect was never in `SectionTabs`' own markup, it was in what two callers
 * did and did not render around it.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { SectionPanel, SectionTabs } from './SectionTabs.tsx';
import { IngestionPanel } from './IngestionPanel.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { WorkflowPanel, type WorkflowsPayload } from './WorkflowPanel.tsx';
import { api } from '../lib/api.ts';
import type { IngestionPayload } from '../lib/ingestion.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Every `aria-controls` on a tab, resolved against the document it lives in.
 *
 * Returns the ones that resolve to nothing. An empty array is the contract
 * kept; anything in it is a tab pointing at an element that does not exist.
 */
function danglingControls(root: ParentNode = document): string[] {
  const dangling: string[] = [];
  for (const tab of Array.from(root.querySelectorAll('[role="tab"]'))) {
    const ref = tab.getAttribute('aria-controls');
    if (!ref) continue;
    for (const id of ref.split(/\s+/).filter(Boolean)) {
      if (!document.getElementById(id)) dangling.push(id);
    }
  }
  return dangling;
}

/**
 * The same question asked backwards: every panel names a tab that is there.
 *
 * A tab pointing at nothing and a panel named by nothing are one defect seen
 * from its two ends, and only one of them was in the brief. This is what found
 * the other.
 */
function orphanPanels(): string[] {
  return Array.from(document.querySelectorAll('[role="tabpanel"]')).flatMap((panel) => {
    const ref = panel.getAttribute('aria-labelledby');
    return ref && !document.getElementById(ref) ? [ref] : [];
  });
}

const tabs = () => screen.getAllByRole('tab');

/* ==========================================================================
 * 1. The panel a tab claims to control
 * ========================================================================== */

const INGESTION: IngestionPayload = {
  policy: {
    delivery: 'hybrid',
    fastLane: ['critical', 'high'],
    pull: { enabled: false, intervalSeconds: 60, batchSize: 100, overlapSeconds: 30, sources: [] },
  },
  lanes: { critical: 'fast', high: 'fast', medium: 'paced', low: 'paced' },
  state: { running: false, cursors: {}, last: [] },
};

function mountIngestion() {
  vi.spyOn(api, 'ingestionPolicy').mockResolvedValue(INGESTION);
  vi.spyOn(api, 'ingestSources').mockResolvedValue({
    base_url: 'http://localhost:4400',
    secret_set: true,
    mode: 'on',
    sources: [],
  } as Awaited<ReturnType<typeof api.ingestSources>>);
  vi.spyOn(api, 'workflows').mockResolvedValue({ workflows: [], variables: {} });
  return render(<IngestionPanel />);
}

/**
 * Settings as `App` renders it, minus the one optional prop.
 *
 * Mounted with data of the right shape rather than reviewed empty: an empty
 * Settings page renders no tab list at all and would have shown none of this.
 */
const SETTINGS = {
  settings: {
    webhook: { mode: 'off', secretSet: false },
    tunnel: { hostname: '', tokenSet: false },
    console: { refreshSeconds: 20, executionWindow: 120, forceDemo: false },
    auth: { enabled: false, passwordSet: false },
    database: {
      preset: 'local', host: 'localhost', port: 5432, database: 'menater',
      user: 'n8n_soc', ssl: false, passwordSet: false,
    },
    pipeline: {
      shadowMode: true, slackApproval: '', slackEscalation: '', slackWarnings: '',
      slackCritical: '', ticketEndpoint: '', isolationEndpoint: '',
      isolationTtlMinutes: 60, errorWindowMinutes: 60,
      errorSystemicThreshold: 5, errorSuppressMinutes: 30,
    },
    assistant: {
      enabled: true, provider: 'openrouter', model: '', maxSteps: 6,
      mcpEnabled: false, mcpTokenSet: false,
    },
    inventory: { entries: [] },
    meta: {
      config_path: '/tmp/config.json', config_exists: true,
      from_env: { db_host: false, db_password: false },
    },
  },
  connection_string: 'postgres://localhost:5432/menater',
} as never;

/** Two workflows, because the defect only shows with something to switch to. */
const WORKFLOWS: WorkflowsPayload = {
  workflows: [
    {
      id: '01-ingestion',
      name: 'Ingestion',
      version: 1,
      nodes: [{
        id: 'webhook', type: 'trigger.webhook', label: 'POST /soc/alert',
        params: {}, position: { x: 0, y: 0 }, effect: 'pure',
      }],
      edges: [],
    },
    {
      id: '02-enrichment',
      name: 'Enrichment',
      version: 1,
      nodes: [{
        id: 'shodan', type: 'http', label: 'Shodan',
        params: {}, position: { x: 0, y: 0 }, effect: 'read',
      }],
      edges: [],
    },
  ],
  variables: {},
};

function mountWorkflows() {
  vi.spyOn(api, 'workflows').mockResolvedValue(WORKFLOWS);
  return render(<WorkflowPanel />);
}

describe('a tab points at a panel that is really there', () => {
  it('holds on a tablist rendered with its panels', () => {
    // The pin for the shape that was already right: `SettingsPage` and
    // `TracePanel` render a `SectionPanel` per tab, and nothing here may
    // regress that while fixing the two call sites that do not.
    render(
      <>
        <SectionTabs
          items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]}
          active="a"
          onChange={() => {}}
          label="sections"
        />
        <SectionPanel id="a" active>first</SectionPanel>
        <SectionPanel id="b" active={false}>second</SectionPanel>
      </>,
    );
    expect(danglingControls()).toEqual([]);
  });

  it('holds on the Ingestion tab', async () => {
    mountIngestion();
    await waitFor(() => expect(screen.getByText('Hybrid')).toBeTruthy());
    // Three sections — delivery, sources, pipeline — each announced as the
    // panel its tab controls, and each rendered as a bare `<div hidden>`.
    expect(danglingControls()).toEqual([]);
  });

  it('holds on the Workflow section, where six tabs share one region', async () => {
    mountWorkflows();
    await waitFor(() => expect(tabs().length).toBe(2));
    // The workflow tabs do not select between panels: they choose which
    // workflow the ONE region below them describes. Sharing is legal — several
    // controls may point at one region — dangling is not.
    expect(danglingControls()).toEqual([]);
  });

  it('renders no panel for a section that has no tab', async () => {
    // `SettingsPage` builds its tab list conditionally — the code-analysis
    // section is pushed only when the caller supplies it — and rendered the
    // matching `SectionPanel` UNCONDITIONALLY. Omit the prop and the page
    // carries an empty region named by a tab that is not in the document.
    //
    // Latent rather than operator-visible: `App.tsx` always passes the prop.
    // It is fixed because the invariant is what the other half of this file
    // asserts, read from the other end, and a rule that holds in one direction
    // only is a rule nobody can check.
    vi.spyOn(api, 'settings').mockResolvedValue(SETTINGS);
    vi.spyOn(api, 'credentials').mockResolvedValue({ credentials: [] } as never);
    vi.spyOn(api, 'assistantProviders').mockResolvedValue({ providers: [] } as never);
    render(<SettingsPage onChanged={() => {}} />);
    await waitFor(() => expect(tabs().length).toBe(9));

    expect(orphanPanels()).toEqual([]);
    expect(danglingControls()).toEqual([]);
    // One panel per tab, and no spare.
    expect(document.querySelectorAll('[role="tabpanel"]').length).toBe(tabs().length);
  });

  it('gives the shared region a role and a name that follows the selection', async () => {
    mountWorkflows();
    await waitFor(() => expect(tabs().length).toBe(2));
    const panel = screen.getByRole('tabpanel');
    const labelledBy = panel.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)!.getAttribute('aria-selected')).toBe('true');

    await userEvent.click(tabs()[1]);
    const after = screen.getByRole('tabpanel').getAttribute('aria-labelledby')!;
    // The region is the same one; what changed is which tab names it.
    expect(after).not.toBe(labelledBy);
    expect(document.getElementById(after)!.getAttribute('aria-selected')).toBe('true');
  });
});

/* ==========================================================================
 * 2. The keyboard contract
 * ========================================================================== */

describe('a tablist is one stop in the tab order', () => {
  it('leaves only the selected tab reachable by Tab', () => {
    render(
      <SectionTabs
        items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]}
        active="b"
        onChange={() => {}}
        label="sections"
      />,
    );
    // Ten sections on Settings meant ten stops before the first setting. The
    // roving tabindex is what turns them back into one.
    expect(tabs().map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('moves the selection with the arrow keys, and takes the focus with it', async () => {
    const onChange = vi.fn();
    render(
      <SectionTabs
        items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]}
        active="a"
        onChange={onChange}
        label="sections"
      />,
    );
    tabs()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('b');
    // Focus must follow, or the next arrow key starts from where it was.
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it('wraps at both ends rather than stopping', async () => {
    const onChange = vi.fn();
    render(
      <SectionTabs
        items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]}
        active="a"
        onChange={onChange}
        label="sections"
      />,
    );
    tabs()[0].focus();
    // Left from the first reaches the last: a bar that stops dead at the edge
    // makes the tenth section the hardest one to reach, and it is the one the
    // setup checklist sends people to.
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('c');
    expect(document.activeElement).toBe(tabs()[2]);
  });

  it('jumps to the first and the last with Home and End', async () => {
    const onChange = vi.fn();
    render(
      <SectionTabs
        items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]}
        active="b"
        onChange={onChange}
        label="sections"
      />,
    );
    tabs()[1].focus();
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(tabs()[2]);

    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it('leaves the other keys alone', async () => {
    // The bar scrolls horizontally and sits above real content. Swallowing
    // ArrowUp/ArrowDown here would take the page's own scrolling away from
    // somebody navigating with the keyboard, which is a worse trade than the
    // one this fix makes.
    const onChange = vi.fn();
    render(
      <SectionTabs
        items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]}
        active="a"
        onChange={onChange}
        label="sections"
      />,
    );
    tabs()[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{PageDown}');
    expect(onChange).not.toHaveBeenCalled();
  });
});
