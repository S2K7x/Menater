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
 * ============================================================================
 */

import { useState } from 'react';

import { Explain } from '../../components/Guidance.tsx';
import { useI18n } from '../../i18n/context.tsx';
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
}: {
  finding: ReportFinding;
  /** The scan this report came from. Part of the alert's identity. */
  scanRunId?: string | null;
  /** What was scanned, carried onto the alert for the incident card. */
  target?: string | null;
}) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

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
      // service through the relay, and this is the console's own route.
      const res = await fetch('/api/findings/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan_run_id: scanRunId, target, finding }),
      });
      const body = await res.json().catch(() => null);
      setOutcome({
        ok: body?.ok === true,
        // The server's sentence, or the plain statement that it sent none —
        // never a placeholder standing in for one.
        response: typeof body?.response === 'string' && body.response !== ''
          ? body.response
          : t.report.promoteUnreachable(`HTTP ${res.status}`),
      });
    } catch (err) {
      setOutcome({ ok: false, response: t.report.promoteUnreachable((err as Error).message) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="vp-promote">
      <button
        type="button"
        className="vp-promote-button"
        onClick={send}
        disabled={sending || noRun}
      >
        {sending ? t.report.promoteSending : t.report.promote}
      </button>
      <Explain label={t.report.promote}>{t.report.promoteHelp}</Explain>

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
