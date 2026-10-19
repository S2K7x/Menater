/**
 * J0.5 — the way back: a report finding that is already a case says so.
 *
 * ============================================================================
 * J0.1 SHIPPED A DOOR THAT ONLY OPENS ONE WAY, AND NAMED THE HOLE ITSELF
 *
 * *"The finding's status in the report does not change"* is the last line of
 * J0.1's own « what it does NOT do », filed there because wiring it looked like
 * touching `finding-status.ts`, the browser store that tracks fixed / accepted
 * / false alarm. So the single control that bridges the two halves of this
 * product forgot its own outcome the moment you left the report: twelve
 * findings, three of them sent to the queue, and no way to tell which three.
 * `POST /api/findings/promote` has always answered `alert_id` and `run_id` —
 * both declared on `PromoteResult` and read by NOTHING, the struct-member-with-
 * no-readers shape this repository has now paid for three times.
 *
 * ============================================================================
 * IT IS NOT A FOURTH STATUS, AND THAT IS WHY NOTHING IS STORED
 *
 * "Sent to the queue" is not a thing an operator decides about a flaw — it is
 * a thing that HAPPENED, and the queue is where it is recorded. Writing it
 * into `localStorage` beside the three statuses would make a second claim that
 * can disagree with the first, which is the defect `finding-status.ts` was
 * itself written to refuse: *« a flaw marked corrected and STILL DETECTED by
 * the next scan is flagged as such — the tool looks at the code, not at the
 * ticked box: if the two contradict each other, it is the box that is wrong. »*
 * Here the queue is the code and the box would be a copy of it. It would also
 * be a fourth copy of alert-adjacent data outside the audit chain, which is
 * the reason the assistant persists no transcript and the Lookup tab keeps its
 * memory in RAM.
 *
 * So this reads. Every case is already in the browser — the snapshot carries
 * the window — so the answer is a pure function over data the client holds,
 * which is the argument J0.4 made for grouping by system in the browser rather
 * than adding a payload.
 *
 * ============================================================================
 * THE TRUST COMES FROM THE SERVER, AND IT IS ALREADY COMPUTED
 *
 * `extensions` is an OPEN BAG: the alert contract keeps every unmapped vendor
 * field in it, whole, so any log source can put a `vulnpipe` key there. Left
 * unchecked, a SIEM that enriches its alerts with scanner output would decide
 * which of this report's findings the console claims are already triaged.
 *
 * `scanRepository` in `server/findings.ts` already settled that: it recomputes
 * the alert id from the bag and refuses a bag the id was not derived from, and
 * `matched_on: 'scan_target'` is the stamp it leaves when the two agree. So
 * this reader gates on that stamp rather than re-deriving a second opinion.
 * The digest needs SHA-256, i.e. `crypto.subtle`, which only exists in a
 * secure context — measured in Chromium 1194 on one server bound to 0.0.0.0:
 * `http://127.0.0.1` and `http://localhost` report `isSecureContext: true`
 * and `typeof crypto.subtle === 'object'`, while `http://192.0.2.2` on the
 * same port reports `false` and **`undefined`**. `http://<host>:4400` is how
 * an operator on another machine reaches this console, so a browser-side
 * check would simply stop working there and say nothing about it.
 *
 * ============================================================================
 * ONLY THE POSITIVE CLAIM IS EVER MADE
 *
 * A finding this finds is printed as being in the queue. A finding it does not
 * find is printed exactly as it was before J0.5: the button, and no sentence.
 * That is not timidity, it is the only honest reading available — the window
 * is bounded, and a console with no snapshot at all renders this tab anyway
 * (the Code tab is deliberately outside the snapshot's error screen). Saying
 * *"this finding is NOT in the queue"* would be a claim whose scope is the run
 * window, on a screen that cannot show that scope, i.e. the reassurance over a
 * hole that `clean` refuses on the Lookup tab and the scan report refuses
 * about its own coverage.
 * ============================================================================
 */

import { clip, FIELD_MAX, findingIdentityKey, type FindingIdentity } from './finding-identity.ts';
import type { AlertCase, CaseState } from './types.ts';

/** A case that a promotion of one finding opened. */
export interface PromotedCase {
  alert_id: string;
  /** Where the pipeline got to. The queue's own vocabulary, via `queue.states`. */
  state: CaseState;
  received_at: string;
}

/** Promotions of ONE scan, by the key of the flaw they were made from. */
export type PromotedIndex = Map<string, PromotedCase>;

/**
 * What a report hands a finding card: the question, and the way through.
 *
 * A FUNCTION AND AN ID, deliberately, rather than the cases themselves. The
 * Code tab does not read the alert pipeline — that is why `App.tsx` renders it
 * beside the snapshot's error screen rather than inside it — and handing
 * `AlertCase[]` down three components would make the report depend on the
 * queue's shape for the sake of one lookup.
 */
export interface PromotedLink {
  find: (identity: FindingIdentity) => PromotedCase | null;
  open: (alertId: string) => void;
}

/**
 * Binds an index and a jump into what a report card reads.
 *
 * It exists so the LOOKUP — `findingIdentityKey` over the index — is written
 * once. Spelled out at the one call site, a test driving a card would have had
 * to spell it a second time, and then it would be vouching for its own copy
 * rather than for the one the product runs. The walk is the expensive half and
 * stays in `promotedIndex`, so this can be rebuilt on every render.
 */
export function promotedLink(
  index: PromotedIndex,
  open: (alertId: string) => void,
): PromotedLink {
  return { find: (identity) => index.get(findingIdentityKey(identity)) ?? null, open };
}

/** A stored string, or nothing. Never a coerced number, never an empty string. */
function stored(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The promotions this scan has already made, out of the cases the console holds.
 *
 * Keyed on the flaw and NOT on the scan, because the scan is the filter: an
 * alert id is a function of the scan run and the flaw, so within one run the
 * flaw alone is unique and `buildCases` produces one case per alert id. There
 * is no collision to break a tie over.
 */
export function promotedIndex(cases: AlertCase[], scanRunId: string | null): PromotedIndex {
  const index: PromotedIndex = new Map();
  // A report with no run id promotes nothing — the button is disabled for the
  // same reason — so there is nothing to look up and no window to walk.
  const run = scanRunId === null ? null : clip(scanRunId.trim(), FIELD_MAX);
  if (run === null || run === '') return index;

  for (const kase of cases) {
    const from = kase.repository;
    // The server's stamp, and the whole of the integrity argument: it is only
    // written when the alert id was recomputed from this bag and matched.
    if (from?.matched_on !== 'scan_target') continue;
    if (from.matched_value.trim() !== run) continue;

    const bag = kase.extensions?.vulnpipe;
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
    const v = bag as Record<string, unknown>;

    const vulnerability = stored(v.vulnerability);
    const httpMethod = stored(v.http_method);
    const route = stored(v.route);
    const file = stored(v.file);
    if (!vulnerability || !httpMethod || !route || !file) continue;

    index.set(
      findingIdentityKey({ vulnerability, http_method: httpMethod, route, file }),
      { alert_id: kase.alert_id, state: kase.state, received_at: kase.received_at },
    );
  }

  return index;
}
