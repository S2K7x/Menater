/**
 * @vitest-environment jsdom
 */
/**
 * The assistant panel.
 *
 * ============================================================================
 * WHAT THESE PROTECT
 *
 * Not "does it chat" — that needs a model. The three things a rendering bug
 * would break silently, and that make the difference between a panel people
 * use and one they open once:
 *
 *   - IT OPENS ON SUGGESTIONS, drawn from the screen you are on. An empty box
 *     is why in-app assistants get closed and never reopened.
 *   - IT SAYS WHAT IT CANNOT DO, before the first question. The limits are
 *     what make the capability trustworthy, and a limit documented only in the
 *     Guide is a limit nobody reads.
 *   - IT NAMES ITS OWN REFUSAL. With no key, "the assistant is unavailable"
 *     sends the operator to the wrong screen; the server's sentence names the
 *     key and the section.
 * ============================================================================
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Assistant } from './Assistant.tsx';
import { I18nProvider } from '../i18n/context.tsx';
import { consoleDictionary } from '../i18n/console.ts';
import { api } from '../lib/api.ts';

function mount(page = { tab: 'queue' }) {
  return render(
    <I18nProvider>
      <Assistant page={page} />
    </I18nProvider>,
  );
}

const READY = {
  enabled: true,
  ready: true,
  key_source: 'provider' as const,
  key_locked: false,
  provider: 'openrouter',
  provider_label: 'OpenRouter (any model)',
  model: 'test/model',
  max_steps: 6,
  suggestions: ['Explain this alert to me simply', 'What is the actual danger here?'],
  tools: ['get_alert'],
  blocking: null,
};

afterEach(() => {
  // Explicit: auto-cleanup only runs with `globals: true`, and this config
  // does not set it. Without it the previous render stays in the document and
  // every query finds two launchers.
  cleanup();
  vi.restoreAllMocks();
});

describe('the assistant panel', () => {
  it('stays out of the way until it is asked for', () => {
    const state = vi.spyOn(api, 'assistantState');
    mount();
    // The launcher is there; the panel is not, and no request went out. A
    // console left open on the queue has no reason to ask about an assistant
    // nobody summoned.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state).not.toHaveBeenCalled();
  });

  it('opens on suggestions rather than on a blank box', async () => {
    vi.spyOn(api, 'assistantState').mockResolvedValue(READY);
    mount();
    await userEvent.click(screen.getByRole('button', { name: /ask the assistant/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Explain this alert to me simply' })).toBeTruthy(),
    );
  });

  it('says what it cannot do before the first question', async () => {
    vi.spyOn(api, 'assistantState').mockResolvedValue(READY);
    mount();
    await userEvent.click(screen.getByRole('button', { name: /ask the assistant/i }));

    // The safety promise, on screen, not in a Guide section nobody opens.
    await waitFor(() =>
      expect(screen.getByText(/cannot approve, isolate, close or replay/i)).toBeTruthy(),
    );
  });

  it('names the missing key instead of looking broken', async () => {
    vi.spyOn(api, 'assistantState').mockResolvedValue({
      ...READY,
      ready: false,
      key_source: null,
      suggestions: [],
      blocking: 'No key for OpenRouter (any model). Set ASSISTANT_APIKEY in Settings → Credentials.',
    });
    mount();
    await userEvent.click(screen.getByRole('button', { name: /ask the assistant/i }));

    await waitFor(() => expect(screen.getByText(/ASSISTANT_APIKEY/)).toBeTruthy());
    // And the composer is shut, rather than accepting a question that would
    // fail on send.
    expect(screen.getByRole('textbox')).toHaveProperty('disabled', true);
  });

  it('sends the page context with the question, so "this alert" resolves', async () => {
    vi.spyOn(api, 'assistantState').mockResolvedValue(READY);
    const chat = vi.spyOn(api, 'assistantChat').mockResolvedValue({
      reply: 'It is a failed SSH login burst.',
      tools: [{ name: 'get_alert', args: {}, ok: true }],
      steps: 2,
      capped: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    mount({ tab: 'queue', alert_id: 'alert-1234' } as { tab: string; alert_id: string });
    await userEvent.click(screen.getByRole('button', { name: /ask the assistant/i }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());

    await userEvent.type(screen.getByRole('textbox'), 'explain this alert');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(chat).toHaveBeenCalled());
    const [messages, page] = chat.mock.calls[0];
    expect(messages[messages.length - 1].content).toBe('explain this alert');
    // The whole point of the panel: the operator never typed the identifier.
    expect(page.alert_id).toBe('alert-1234');

    // And the trace is shown, so the answer can be checked.
    await waitFor(() => expect(screen.getByText(/Looked up: get_alert/)).toBeTruthy());
  });
});

describe('the link into the Guide', () => {
  it('opens the Guide on the assistant section, from where the question arose', async () => {
    vi.spyOn(api, 'assistantState').mockResolvedValue(READY);
    const onOpenGuide = vi.fn();
    render(
      <I18nProvider>
        <Assistant page={{ tab: 'queue' }} onOpenGuide={onOpenGuide} />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /ask the assistant/i }));
    await userEvent.click(await screen.findByRole('button', { name: /how does it work/i }));
    expect(onOpenGuide).toHaveBeenCalled();
  });
});


/**
 * What the operator is TOLD the assistant can read.
 *
 * ============================================================================
 * A COUNT IS A CLAIM WITH AN EXPIRY DATE
 *
 * Three screens describe the assistant's reach — the panel's own note, the
 * Settings block beside the key, and the Guide — and all three were written
 * when the catalogue held seven tools. It holds fourteen. The Guide's was the
 * one that had gone flatly false: "Seven lookups, and every answer about this
 * installation comes through one of them", followed by the seven from 2026-09.
 *
 * Nothing broke. It cost the operator the half they were never told about:
 * nobody asks "is this a one-off or a campaign?" or "what happened while I was
 * away?" of an assistant they have been told does seven other things.
 *
 * So the copy describes REACH and the test forbids the COUNT. A sentence about
 * what it can read stays true when a fifteenth tool lands; a number does not,
 * and this project has already paid twice for a number nobody remembered to
 * move (`CLAUDE.md`: "A number that skips is worse than no number", "A name
 * that outlives the thing it named").
 * ============================================================================
 */
describe('what the operator is told the assistant can read', () => {
  const d = consoleDictionary('en');
  const guide = d.docs.sections.find((s) => s.id === 'assistant')!;

  /** Every sentence on a screen that describes the assistant's reach. */
  const claims: Array<[string, string]> = [
    ['assistant.readOnlyNote', d.assistant.readOnlyNote],
    ['assistant.cannotAct', d.assistant.cannotAct],
    ['settings.assistantSection.reads', d.settings.assistantSection.reads],
    ['settings.assistantSection.cannot', d.settings.assistantSection.cannot],
    ['docs.assistant.lede', guide.lede],
    ...guide.points.map((p, i) => [`docs.assistant.points[${i}]`, `${p.term} ${p.text}`] as [string, string]),
  ];

  it('counts none of them, because the catalogue outgrew the last count', () => {
    const counted =
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d+)\s+(?:lookups?|tools?|getters?)\b/i;
    const offenders = claims
      .filter(([, text]) => counted.test(text))
      .map(([path, text]) => `${path}: ${text.slice(0, 90)}`);
    expect(offenders).toEqual([]);
  });

  /**
   * The claim the copy exists to make, and the one that must survive the
   * rewrite above: it reads, it does not act. Widening the description of what
   * it READS must not quietly soften that.
   */
  it('still says on both screens that it can change nothing', () => {
    expect(d.assistant.cannotAct).toMatch(/cannot|no tool/i);
    expect(d.settings.assistantSection.cannot).toMatch(/There is no tool/i);
  });
});
