/**
 * The in-console assistant.
 *
 * ============================================================================
 * A DOCKED PANEL, NOT A TENTH TAB
 *
 * Everything else in this console is a destination: you go to Alerts, you go
 * to Rules. This one has to be reachable FROM wherever you are, because the
 * question it answers is always about the screen you are already looking at —
 * "explain this alert", "why is this one still waiting". A tab would mean
 * leaving the thing you are asking about.
 *
 * ============================================================================
 * FOUR DECISIONS WORTH KEEPING
 *
 *  1. IT OPENS ON SUGGESTIONS, NEVER ON A BLANK BOX. A curated set of prompts
 *     derived from the current screen is what puts a useful answer in the first
 *     session; an empty field is why most in-app assistants are opened once.
 *
 *  2. THE TOOL TRACE IS SHOWN, NOT HIDDEN. Each answer says what it looked up
 *     ("Looked up: get_alert, get_trace"). An answer an operator cannot check
 *     is an answer that gets believed for the wrong reasons — and this is a
 *     screen where being believed for the wrong reasons has consequences.
 *
 *  3. THE THREAD LIVES IN THIS COMPONENT AND NOWHERE ELSE. No server storage,
 *     no `localStorage`: alert content would then sit in a fourth place with
 *     no retention policy. Closing the panel keeps the thread (state stays
 *     mounted); reloading the page ends it, and that is the intended lifetime.
 *
 *  4. THE PAGE CONTEXT IS SENT, NOT TYPED. `{ tab, alert_id }` travels with
 *     every turn, so "this alert" resolves without the operator pasting an
 *     identifier. That is the single biggest difference between a copilot that
 *     gets used and one that gets closed.
 *
 * The class prefix is `soc-ai-`, checked free before it was written: `.soc-`
 * has burnt this project twice already (`.vp-scope`, `.soc-sources`), and once
 * more through a descendant selector (`.soc-field span`) that dressed every
 * span underneath it.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from './Icon.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import type { AssistantPage, AssistantState, AssistantTurn } from '../lib/types.ts';

/** One line of the thread, plus what the server said about how it was produced. */
interface Bubble extends AssistantTurn {
  tools?: string[];
  capped?: 'steps' | 'tool_calls' | 'deadline' | null;
  failed?: boolean;
}

export function Assistant({
  page,
  onOpenGuide,
}: {
  page: AssistantPage;
  /**
   * Opens the Guide ON the assistant's section. The limits are what make the
   * capability trustworthy, and the panel only has room for two lines of them
   * — the rest has to be one click away from where the question arises, not in
   * a tab someone has to think to open.
   */
  onOpenGuide?: () => void;
}) {
  const { c } = useI18n();
  const a = c.assistant;

  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AssistantState | null>(null);
  const [thread, setThread] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Readiness is fetched when the panel opens, not on mount.
   *
   * A console left open on the queue has no reason to ask about an assistant
   * nobody summoned — and the answer would be stale by the time it is used,
   * since it changes the moment someone sets a key in Settings.
   */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .assistantState(page)
      .then((s) => alive && setState(s))
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
    // `page.alert_id` on purpose: the suggestions change with the open incident.
  }, [open, page.tab, page.alert_id]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // The newest bubble, in view. Without this an answer arrives below the fold
  // and the panel looks like it did nothing.
  //
  // Guarded on the METHOD, not just the ref: `scrollTo` is absent on elements
  // in jsdom, and an effect that throws does not degrade — it bubbles to the
  // root and unmounts the panel. Assigning `scrollTop` is the fallback every
  // environment has.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread, busy]);

  // Escape closes, from anywhere in the panel. A modal-looking surface that
  // ignores Escape is one people click around to get rid of.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (question === '' || busy) return;
      const next: Bubble[] = [...thread, { role: 'user', content: question }];
      setThread(next);
      setDraft('');
      setBusy(true);
      try {
        // The whole thread goes with the request: the server stores none of it.
        const reply = await api.assistantChat(
          next.map((m) => ({ role: m.role, content: m.content })),
          page,
        );
        setThread((t) => [
          ...t,
          {
            role: 'assistant',
            content: reply.reply,
            tools: [...new Set(reply.tools.map((x) => x.name))],
            capped: reply.capped,
          },
        ]);
      } catch (err) {
        // The server's own sentence, when there is one: it names the missing
        // key or the refused model. A generic "it failed" would send the
        // operator to the wrong screen.
        setThread((t) => [
          ...t,
          {
            role: 'assistant',
            content: err instanceof ApiError ? err.message : a.failed,
            failed: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [thread, busy, page, a.failed],
  );

  const blocked = state !== null && !state.ready;

  return (
    <>
      <button
        type="button"
        className={`soc-ai-launcher${open ? ' soc-ai-launcher-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={a.launcher}
        aria-expanded={open}
      >
        <Icon name={open ? 'cross' : 'chat'} size={20} />
      </button>

      {open ? (
        <section className="soc-ai-panel" role="dialog" aria-label={a.title}>
          <header className="soc-ai-head">
            <div>
              <strong>{a.title}</strong>
              <span className="soc-ai-sub">{a.subtitle}</span>
            </div>
            <div className="soc-ai-head-actions">
              {thread.length > 0 ? (
                <button type="button" className="soc-ai-ghost" onClick={() => setThread([])}>
                  {a.clear}
                </button>
              ) : null}
              <button
                type="button"
                className="soc-ai-ghost"
                onClick={() => setOpen(false)}
                aria-label={a.close}
              >
                <Icon name="cross" size={16} />
              </button>
            </div>
          </header>

          <div className="soc-ai-scroll" ref={scroller}>
            {thread.length === 0 ? (
              <div className="soc-ai-intro">
                <p>{a.emptyLede}</p>
                {/*
                  Said before the first question, not in a help page nobody
                  opens. What the assistant CANNOT do is the part an operator
                  needs in order to trust the part it can.
                */}
                <p className="soc-ai-note">{a.readOnlyNote}</p>
                <p className="soc-ai-note">
                  {a.cannotAct}
                  {onOpenGuide ? (
                    <>
                      {' '}
                      <button type="button" className="soc-ai-link" onClick={onOpenGuide}>
                        {a.howItWorks}
                      </button>
                    </>
                  ) : null}
                </p>
                {blocked ? (
                  <div className="soc-ai-blocked">
                    <Icon name="alert" size={15} />
                    <p>{state?.blocking ?? a.notReady}</p>
                  </div>
                ) : (
                  <>
                    <span className="soc-ai-suggest-title">{a.suggestionsTitle}</span>
                    <div className="soc-ai-suggestions">
                      {(state?.suggestions ?? []).map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="soc-ai-suggestion"
                          onClick={() => send(s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              thread.map((m, i) => (
                <div
                  key={i}
                  className={`soc-ai-bubble soc-ai-bubble-${m.role}${m.failed ? ' soc-ai-bubble-failed' : ''}`}
                >
                  <p>{m.content}</p>
                  {m.tools && m.tools.length > 0 ? (
                    <span className="soc-ai-trace">{a.lookedUp(m.tools.join(', '))}</span>
                  ) : null}
                  {m.capped ? (
                    <span className="soc-ai-capped">
                      {m.capped === 'steps'
                        ? a.cappedSteps
                        : m.capped === 'tool_calls'
                          ? a.cappedTools
                          : a.cappedDeadline}
                    </span>
                  ) : null}
                </div>
              ))
            )}
            {busy ? (
              <div className="soc-ai-bubble soc-ai-bubble-assistant soc-ai-pending">
                <span className="soc-ai-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {a.thinking}
              </div>
            ) : null}
          </div>

          <form
            className="soc-ai-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              ref={input}
              value={draft}
              rows={1}
              placeholder={a.placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line. The opposite makes
                // a one-line question take two gestures, forty times a shift.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              disabled={blocked}
            />
            <button
              type="submit"
              className="soc-ai-send"
              disabled={busy || blocked || draft.trim() === ''}
              aria-label={a.send}
            >
              <Icon name="send" size={16} />
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
