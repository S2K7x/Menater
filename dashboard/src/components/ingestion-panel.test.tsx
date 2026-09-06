/**
 * @vitest-environment jsdom
 */
/**
 * The Ingestion tab: what someone choosing an architecture must be able to see.
 *
 * ============================================================================
 * THIS SCREEN IS A DECISION, NOT A REPORT
 *
 * Every other tab in this console shows you what happened. This one asks you to
 * commit to a trade-off, and it is the only screen where the wrong choice is
 * invisible afterwards — a P1 sitting in a five-minute polling queue looks
 * exactly like a P1 nobody has triaged yet.
 *
 * So the assertions are not "the panel renders". They are the four things that
 * make the decision an informed one:
 *
 *   1. Each option's COST is on screen, in the clear. A card that listed only
 *      benefits would be an advertisement for whichever we wrote first, and the
 *      readability rules already forbid folding what a reader must weigh.
 *   2. The hybrid is marked recommended, and the other two are still pickable.
 *      A default presented as the only option is not a default.
 *   3. The lane table says the DELAY, not the interval — half of it. The number
 *      someone weighs a P1 against must be the one that is true.
 *   4. "Nothing is dropped" is stated. The table reads like a routing rule, and
 *      a reasonable person would otherwise fear that pointing a P4 source at
 *      the webhook silently discards it.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { IngestionPanel } from './IngestionPanel.tsx';
import { api } from '../lib/api.ts';
import type { IngestionPayload } from '../lib/ingestion.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PAYLOAD: IngestionPayload = {
  policy: {
    delivery: 'hybrid',
    fastLane: ['critical', 'high'],
    pull: {
      enabled: false,
      intervalSeconds: 60,
      batchSize: 100,
      overlapSeconds: 30,
      sources: [],
    },
  },
  lanes: { critical: 'fast', high: 'fast', medium: 'paced', low: 'paced' },
  state: { running: false, cursors: {}, last: [] },
};

const WITH_SOURCE: IngestionPayload = {
  ...PAYLOAD,
  policy: {
    ...PAYLOAD.policy,
    pull: {
      ...PAYLOAD.policy.pull,
      enabled: true,
      sources: [{
        source: 'generic', enabled: true, url: 'https://siem.example.com/alerts',
        cursorParam: 'since', authHeader: '', authCredential: '', itemsPath: '',
      }],
    },
  },
};

function mount(payload: IngestionPayload = PAYLOAD) {
  vi.spyOn(api, 'ingestionPolicy').mockResolvedValue(payload);
  // The source catalogue lives in its own panel and has its own tests; here it
  // must not turn every assertion into a wait on an unrelated request.
  vi.spyOn(api, 'ingestSources').mockResolvedValue({
    base_url: 'http://localhost:4400',
    secret_set: true,
    mode: 'on',
    sources: [],
  } as Awaited<ReturnType<typeof api.ingestSources>>);
  vi.spyOn(api, 'workflows').mockResolvedValue({ workflows: [], variables: {} });
  return render(<IngestionPanel />);
}

describe('choosing a delivery architecture', () => {
  it('shows all three options, with the hybrid marked recommended', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Hybrid')).toBeTruthy());
    expect(screen.getByText('Push only')).toBeTruthy();
    expect(screen.getByText('Pull only')).toBeTruthy();
    // Recommended, and exactly once: a page that recommends everything
    // recommends nothing.
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
  });

  it('states what each option COSTS, not only what it buys', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('Hybrid')).toBeTruthy());
    const costs = container.querySelectorAll('.soc-ing-card-cost');
    expect(costs).toHaveLength(3);
    // In the clear, never inside a closed `<details>`: a cost you have to open
    // something to read is a cost nobody reads.
    for (const cost of costs) {
      expect(cost.closest('details')).toBeNull();
      expect((cost.textContent ?? '').length).toBeGreaterThan(40);
    }
    // And the two sentences someone actually decides on.
    expect(container.textContent).toMatch(/retry policy/);
    expect(container.textContent).toMatch(/Half a polling interval|half a polling interval/);
  });

  it('marks the active option, and leaves the others selectable', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Hybrid')).toBeTruthy());
    const cards = screen.getAllByRole('button', { pressed: false });
    // Two unpicked architectures at minimum: a default nobody can move away
    // from is not a default, it is a constant with a border around it.
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  it('saves the choice immediately, with no draft to lose', async () => {
    const save = vi.spyOn(api, 'saveIngestionPolicy')
      .mockResolvedValue({ policy: { ...PAYLOAD.policy, delivery: 'pull' } });
    mount();
    await waitFor(() => expect(screen.getByText('Pull only')).toBeTruthy());
    await userEvent.click(screen.getByText('Pull only'));
    // No save bar on this screen on purpose: the lane table below must never
    // describe a policy that is not the one running.
    await waitFor(() => expect(save).toHaveBeenCalledWith({ delivery: 'pull' }));
  });
});

describe('the lane table', () => {
  it('names every priority with the transport it takes', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('P1')).toBeTruthy());
    for (const p of ['P1', 'P2', 'P3', 'P4']) {
      expect(screen.getByText(p)).toBeTruthy();
    }
    expect(container.textContent).toMatch(/Critical/);
    expect(container.textContent).toMatch(/Low/);
  });

  it('quotes HALF the interval as the delay, not the interval', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('P3')).toBeTruthy());
    // 60 s interval → about 30 s of average added delay. Quoting 60 would
    // overstate it by a factor of two, and this is the number someone weighs
    // a critical alert against.
    expect(container.textContent).toMatch(/About 30 s on average/);
    expect(container.textContent).not.toMatch(/About 60 s on average/);
  });

  it('says out loud that nothing is dropped for taking the wrong lane', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('P1')).toBeTruthy());
    expect(container.textContent).toMatch(/No alert is ever refused/);
  });
});

describe('what the tab did not lose when it replaced Workflow', () => {
  it('still reaches the pipeline graph, as its third section', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Hybrid')).toBeTruthy());
    // The graph was not deleted, it was re-filed. "One click away" and "erased"
    // look identical on a screenshot and are nothing alike for someone looking.
    expect(screen.getByRole('tab', { name: /Pipeline/ })).toBeTruthy();
  });

  it('keeps the hidden sections mounted rather than unmounting them', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('Hybrid')).toBeTruthy());
    // `hidden`, not absent: a half-typed poll address must survive a round trip
    // through the other two sections.
    expect(container.querySelectorAll('div[hidden]').length).toBeGreaterThanOrEqual(2);
  });
});


/* ==========================================================================
 * Saving — the half of a defect that lived on this side.
 * ========================================================================== */

describe('a field saves when you leave it, not while you type in it', () => {
  it('sends ONE save for a value typed a character at a time', async () => {
    const save = vi.spyOn(api, 'saveIngestionPolicy')
      .mockResolvedValue({ policy: WITH_SOURCE.policy });
    mount(WITH_SOURCE);
    await waitFor(() => expect(screen.getByDisplayValue('60')).toBeTruthy());

    const interval = screen.getByDisplayValue('60');
    await userEvent.clear(interval);
    await userEvent.type(interval, '120');
    // Still nothing: three keystrokes used to be three saves, and each save
    // restarted the poller and fired an immediate poll — three real requests
    // to somebody's SIEM from typing a number.
    expect(save).not.toHaveBeenCalled();

    await userEvent.tab();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]?.pull?.intervalSeconds).toBe(120);
  });

  it('lets you type a URL without the server rewriting it under your cursor', async () => {
    const save = vi.spyOn(api, 'saveIngestionPolicy')
      .mockResolvedValue({ policy: WITH_SOURCE.policy });
    mount(WITH_SOURCE);
    const url = await screen.findByDisplayValue('https://siem.example.com/alerts');

    await userEvent.clear(url);
    await userEvent.type(url, 'https://new.example.com/a');
    expect(save).not.toHaveBeenCalled();
    // And what you typed is what is on screen — not a value echoed back from a
    // save that happened mid-word.
    expect((url as HTMLInputElement).value).toBe('https://new.example.com/a');
  });

  it('saves nothing when the value comes back unchanged', async () => {
    const save = vi.spyOn(api, 'saveIngestionPolicy')
      .mockResolvedValue({ policy: WITH_SOURCE.policy });
    mount(WITH_SOURCE);
    const interval = await screen.findByDisplayValue('60');

    await userEvent.click(interval);
    await userEvent.tab();
    // A save that writes the same bytes still costs a round trip, a re-render,
    // and on this screen a poller re-sync.
    expect(save).not.toHaveBeenCalled();
  });

  it('abandons an edit on Escape', async () => {
    const save = vi.spyOn(api, 'saveIngestionPolicy')
      .mockResolvedValue({ policy: WITH_SOURCE.policy });
    mount(WITH_SOURCE);
    const interval = await screen.findByDisplayValue('60');

    await userEvent.clear(interval);
    await userEvent.type(interval, '999{Escape}');
    expect(save).not.toHaveBeenCalled();
    expect((interval as HTMLInputElement).value).toBe('60');
  });

  it('still saves a checkbox immediately — one click is an unambiguous decision', async () => {
    const save = vi.spyOn(api, 'saveIngestionPolicy')
      .mockResolvedValue({ policy: WITH_SOURCE.policy });
    mount(WITH_SOURCE);
    // The Sources section starts HIDDEN, and `hidden` removes it from the
    // accessibility tree — which is the behaviour we want and the reason this
    // has to open the section rather than reach into it. Worth knowing: a
    // control nobody can find by role is a control a screen reader cannot
    // reach either.
    await userEvent.click(await screen.findByRole('tab', { name: /Sources/ }));

    await userEvent.click(await screen.findByRole('checkbox', { name: /Poll the sources below/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
  });
});

describe('a source held back by the backoff says so', () => {
  it('names the wait rather than sitting silently still', async () => {
    const soon = new Date(Date.now() + 8 * 60 * 1000).toISOString();
    mount({
      ...WITH_SOURCE,
      state: {
        running: true,
        cursors: {
          generic: {
            since: null, lastPollAt: null, lastError: 'the source answered HTTP 429.',
            received: 0, failures: 3, nextAttemptAt: soon,
          },
        },
        last: [],
      },
    });
    const banner = await screen.findByText(/HTTP 429/);
    // A source the poller has decided to skip for eight minutes, with nothing
    // on screen saying so, is indistinguishable from a poller that has stopped.
    expect(banner.textContent).toMatch(/next automatic attempt in about 8 min/);
    expect(banner.textContent).toMatch(/Poll now/);
  });
});
