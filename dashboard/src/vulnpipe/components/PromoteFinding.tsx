/**
 * J0.1 — the one control on the scan report that leaves the Code tab.
 *
 * ============================================================================
 * WHY IT IS A BUTTON AND NOT A RULE
 *
 * A scan that raised its own alerts would spend a model call, and downstream an
 * approval request, on a report nobody had read yet. J0.3 settled the same
 * question in the other direction — it resolves, it never acts — and the answer
 * is the same here: the jump is filled in, a human presses it.
 *
 * ============================================================================
 * WHAT THE SCREEN OWES THE PERSON PRESSING IT
 *
 * `CLARITY.md` § 3: a state, a count and a failure REPORT, and may never fold.
 * The outcome of a press is all three, so it is printed in the clear under the
 * button and stays there. What the button MEANS — that the flaw becomes an
 * alert, gets enriched, decided and audited — explains, and is read once, so it
 * sits behind the circled "i".
 *
 * The sentence shown is always the SERVER'S. The console must not compose its
 * own "sent!" beside a pipeline that answered `duplicate, skipped` or refused
 * the alert outright: that is the failure-that-shows-green this product exists
 * to make impossible, and it was found in this exact shape on the two injection
 * buttons (`server/injection.ts`).
 *
 * ============================================================================
 * AND THE SENTENCE HAS TO ARRIVE, WHICH IS WHY THIS GOES THROUGH `lib/api.ts`
 *
 * This component used to call `fetch('/api/findings/promote')` itself. It was
 * the ONLY raw `fetch` left in the browser half of the product — every other
 * request in the console and in this section goes through one of the two
 * clients — and the console's client is the single place that knows how to
 * read this server's refusals. So the one control that bridges the two halves
 * of this product was the one that could not read what the server said:
 *
 *   `BASE`   a hardcoded path ignores `VITE_API_URL`, so on a console served
 *            from another origin the press goes to the page's host, not the
 *            API's. `lib/api.ts` carries that exact defect in `pwnedRange`'s
 *            header, already paid for once on the password panel.
 *   the 401  `AuthRequiredError` is raised in `lib/api.ts` and nowhere else.
 *   the body `namedReason` reads the three keys this server names a reason
 *            under. The route is careful to answer 200 for everything IT
 *            decides, precisely so the reason survives — but the access lock
 *            and the 256 kB body cap answer before it runs.
 *
 * Measured by driving the real handler: with a console password set, the press
 * printed *"The console could not be reached: HTTP 401. Nothing entered the
 * queue."* over a console that had answered `{"error":"Authentication
 * required."}` in milliseconds, and a body over the cap printed `HTTP 413`
 * over the sentence `server/respond.ts` composes for exactly that.
 *
 * ============================================================================
 * J0.5 — AND THE DOOR NOW OPENS BOTH WAYS
 *
 * The press used to leave no trace: its sentence lived in this component's
 * state, so leaving the report — a tab change, a re-render, a reload — took it
 * with it. Twelve findings, three of them sent, and nothing on screen saying
 * which three; the route has always answered `alert_id` and `run_id`, and both
 * were read by nothing.
 *
 * Nothing is stored to fix that. `promoted` answers out of the cases the
 * console already holds, because "sent to the queue" is not a fourth status an
 * operator sets — it is a thing that happened, and the queue is the record of
 * it. See `src/lib/promoted.ts` for why a copy in `localStorage` would be the
 * ticked box that `finding-status.ts` already refuses to believe over the code.
 *
 * TWO THINGS THE RENDERING HAS TO GET RIGHT. The sentence is a STANDING
 * condition — re-derived on every snapshot poll — so it is NOT in a live
 * region: `CLAUDE.md` records that a permanent announcement is the permanent
 * alarm the `diagnostic_probe` row refuses, and the region below it belongs to
 * the press, which is an answer to something somebody just did. And the button
 * stays ENABLED: the server is the authority on a second press and answers
 * `duplicate, skipped`, where a disabled control would be this console
 * guessing the dedup table's answer.
 * ============================================================================
 */

import { useState } from 'react';

import { Explain } from '../../components/Guidance.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../i18n/context.tsx';
import type { PromotedLink } from '../../lib/promoted.ts';
import { Icon } from './Icon.tsx';
import type { ReportFinding } from './ReportView.tsx';

/** What the server answered, verbatim. `ok` decides the tone, never the text. */
interface Outcome {
  ok: boolean;
  response: string;
}

export function PromoteFinding({
  finding,
  scanRunId = null,
  target = null,
  promoted = null,
}: {
  finding: ReportFinding;
  /** The scan this report came from. Part of the alert's identity. */
  scanRunId?: string | null;
  /** What was scanned, carried onto the alert for the incident card. */
  target?: string | null;
  /**
   * J0.5 — the queue, as this report can reach it. `null` when it cannot: the
   * Code tab renders outside the snapshot's error screen on purpose, so a
   * console that could not load its window shows this report exactly as it did
   * before J0.5 rather than claiming anything about the queue.
   */
  promoted?: PromotedLink | null;
}) {
  const { t, c } = useI18n();
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Only the POSITIVE claim. A finding this does not find prints no sentence:
  // the window is bounded, so "not in the queue" would be a claim whose scope
  // this screen cannot show — the reassurance over a hole that `clean` refuses
  // on the Lookup tab.
  const already = promoted?.find(finding) ?? null;

  /**
   * With no run id the alert would have no stable identity, so two presses
   * would open two cases. Saying so beats sending something we cannot
   * deduplicate — and beats hiding the button, which would leave someone
   * looking for a control they had seen before.
   */
  const noRun = !scanRunId;

  const send = async (): Promise<void> => {
    setSending(true);
    setOutcome(null);
    try {
      // Not through `vulnpipe/lib/api.ts`: that client talks to the analysis
      // service through the relay, and this is the console's own route — so it
      // goes through the CONSOLE's client, the way this file already imports
      // the console's `Explain`. It used to call `fetch` here directly, which
      // is what the header above this component now explains.
      const body = await api.promoteFinding({ scan_run_id: scanRunId, target, finding });
      setOutcome({
        ok: body.ok === true,
        // The server's sentence, or the plain statement that it sent none —
        // never a placeholder standing in for one. Unreachable from this
        // route, which answers `response` on every path; kept because what
        // makes that true is a rule in another file.
        response: typeof body.response === 'string' && body.response !== ''
          ? body.response
          : c.errors.unreadable,
      });
    } catch (err) {
      // `call()` names the reason the server wrote — the lock's
      // "Authentication required.", the body cap's sentence, a tuning-rule
      // style `problems` list — and falls back to its own transport sentence
      // when nothing answered. So this sentence must not claim the console
      // was out of reach — it was, in exactly one of those cases.
      setOutcome({
        ok: false,
        response: t.report.promoteNotSent(
          err instanceof ApiError ? err.message : (err as Error).message,
        ),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="vp-promote">
      {/* Above the button, because it is what you need BEFORE pressing it —
          and not in a live region: a standing state, re-derived on every poll,
          is not the answer to anything just done. */}
      {already && (
        <p className="vp-promote-note">
          {t.report.promotedAlready(c.queue.states[already.state])}
        </p>
      )}

      <button
        type="button"
        className="vp-promote-button"
        onClick={send}
        disabled={sending || noRun}
      >
        {sending ? t.report.promoteSending : t.report.promote}
      </button>
      <Explain label={t.report.promote}>{t.report.promoteHelp}</Explain>

      {/* The way back J0.1 never had. It opens the incident card, exactly as
          the Tracking and Health tabs' own jumps do — and the case is in the
          window by construction, because that window is where it was just
          found, so this link cannot dangle. */}
      {already && promoted && (
        <button
          type="button"
          className="vp-action"
          onClick={() => promoted.open(already.alert_id)}
        >
          <Icon name="inbox" />
          {t.report.promotedOpen}
        </button>
      )}

      {noRun && <p className="vp-promote-note">{t.report.promoteNoRun}</p>}

      {outcome && (
        // `role="status"` and not an alert: it is the result of something the
        // person just did, and it must be announced without stealing focus
        // from the report they are reading.
        <p
          className={`vp-promote-note${outcome.ok ? ' vp-promote-ok' : ' vp-promote-failed'}`}
          role="status"
        >
          {outcome.response}
        </p>
      )}
    </div>
  );
}
