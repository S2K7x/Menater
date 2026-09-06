/**
 * Notices you can acknowledge, per page.
 *
 * ============================================================================
 * ACKNOWLEDGED IS NOT HIDDEN
 *
 * The rule this console already holds for its sub-tabs — "nothing is hidden
 * without leaving a trace" — applies here with more force, because these
 * notices are the ones that say something is wrong.
 *
 * So acknowledging does three things, and not a fourth:
 *
 *  1. It COLLAPSES the notice, it does not delete it. A line stays, with the
 *     count, and one click brings them all back.
 *  2. It is keyed BY CONTENT. If the finding changes wording — a different
 *     workflow, a different count — it is a different fact, and it comes back
 *     unread. Acknowledging "3 chains broken" must never silence "5 chains
 *     broken".
 *  3. It is a BROWSER preference, like the theme. Reading a notice is not a
 *     decision about the pipeline: it does not belong in `config.json`, which
 *     has two writes and both are deliberate acts on the SOC.
 *
 * What it does NOT do is suppress the underlying condition. The Health tab
 * still counts the finding, the Tracking tab still lists the broken chain.
 * This hides a REPETITION, never a state.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../i18n/context.tsx';
import { Icon } from './Icon.tsx';

const KEY = 'menater.notices.read';

/**
 * A stable, short key for a piece of text.
 *
 * djb2 — not a security hash, and it does not need to be. It has to be
 * deterministic across reloads and cheap; a collision costs one notice shown
 * as already read, not a wrong decision.
 */
function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function readStore(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // A browser with storage disabled must not break the page: nothing is
    // acknowledged, every notice shows. Fail towards MORE visible, never less.
    return new Set();
  }
}

function writeStore(ids: Set<string>): void {
  try {
    // Bounded: the list only ever grows, and a console left open for months
    // would otherwise accumulate keys for notices that no longer exist.
    localStorage.setItem(KEY, JSON.stringify([...ids].slice(-300)));
  } catch {
    /* storage full or disabled — acknowledging simply does not persist */
  }
}

export interface Notice {
  /** Distinguishes two notices that happen to carry the same words. */
  scope: string;
  tone: 'error' | 'warn' | 'ok';
  text: string;
  /** Rendered before `text`, in bold. Part of the identity. */
  title?: string;
}

export function useNotices() {
  const [read, setRead] = useState<Set<string>>(() => readStore());

  const markRead = useCallback((ids: string[]) => {
    setRead((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      writeStore(next);
      return next;
    });
  }, []);

  const markUnread = useCallback((ids: string[]) => {
    setRead((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      writeStore(next);
      return next;
    });
  }, []);

  return { read, markRead, markUnread };
}

export const noticeId = (n: Notice): string =>
  `${n.scope}:${fingerprint(`${n.title ?? ''}|${n.text}`)}`;

/**
 * Renders a page's notices, with "mark all as read" and a way back.
 *
 * Takes the whole list rather than being wrapped around each banner: "read
 * all" and "N acknowledged" are statements about the SET, and a component that
 * only ever saw one notice could make neither.
 */
export function NoticeList({ notices }: { notices: Notice[] }) {
  const { c } = useI18n();
  const t = c.notices;
  const { read, markRead, markUnread } = useNotices();
  const [showRead, setShowRead] = useState(false);

  // The set changes as the pipeline does; recomputing per render is cheap and
  // avoids a stale memo showing an acknowledged notice as new.
  const withIds = notices.map((n) => ({ ...n, id: noticeId(n) }));
  const unread = withIds.filter((n) => !read.has(n.id));
  const acknowledged = withIds.filter((n) => read.has(n.id));

  useEffect(() => {
    // Collapse the "show acknowledged" view when there is nothing left in it.
    if (acknowledged.length === 0 && showRead) setShowRead(false);
  }, [acknowledged.length, showRead]);

  if (withIds.length === 0) return null;

  const shown = showRead ? withIds : unread;

  return (
    <div className="soc-notices">
      {unread.length > 1 ? (
        <div className="soc-notices-bar">
          <span className="soc-faint soc-help">{t.count(unread.length)}</span>
          <button
            type="button"
            className="soc-secondary soc-notices-action"
            onClick={() => markRead(unread.map((n) => n.id))}
          >
            <Icon name="check" size={14} /> {t.readAll}
          </button>
        </div>
      ) : null}

      {shown.map((n) => {
        const isRead = read.has(n.id);
        return (
          <div
            key={n.id}
            className={`soc-banner soc-banner-${n.tone} ${isRead ? 'soc-banner-read' : ''}`}
          >
            <Icon name={n.tone === 'ok' ? 'check' : 'alert'} size={16} />
            <p>
              {n.title ? <strong>{n.title}</strong> : null}
              {n.text}
            </p>
            <button
              type="button"
              className="soc-notice-dismiss"
              title={isRead ? t.markUnread : t.markRead}
              aria-label={isRead ? t.markUnread : t.markRead}
              onClick={() => (isRead ? markUnread([n.id]) : markRead([n.id]))}
            >
              <Icon name={isRead ? 'refresh' : 'cross'} size={14} />
            </button>
          </div>
        );
      })}

      {acknowledged.length > 0 ? (
        <button
          type="button"
          className="soc-notices-toggle"
          onClick={() => setShowRead(!showRead)}
        >
          {/* THE TRACE. Acknowledged notices are collapsed behind a line that
              still counts them — never removed, or the page would claim a
              cleanliness it does not have. */}
          <Icon name="chevron" size={13} />
          {showRead ? t.hideRead : t.showRead(acknowledged.length)}
        </button>
      ) : null}
    </div>
  );
}
