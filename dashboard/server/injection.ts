/**
 * Injecting an alert into the console's own pipeline, and REPORTING WHAT THE
 * PIPELINE ANSWERED.
 *
 * ============================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 *
 * `01-Ingestion` has four `respond` nodes — 400 (invalid schema, naming what is
 * wrong), 200 (duplicate), 500 (deduplication store unavailable) and 202
 * (accepted). They exist to BE the answer. `webhook.ts` reads them through
 * `Engine.responseOf` — that was fixed once, because the entry point used to
 * tell a sender its refused alert had been accepted.
 *
 * The two buttons inside the console never got that fix. `POST /api/simulate`
 * (Health → inject a test alert) and `POST /api/replay` (Tracking → replay a
 * broken chain) both answered `ok: true, status: 202` for every run they
 * managed to start, whatever the pipeline had decided about it.
 *
 * So the `malformed` scenario — which exists for one reason, "a rejection is a
 * behaviour too, and this is how you see what the sender is told" — showed a
 * GREEN "injected" banner, and then, forty-five seconds later, "no trace of
 * that alert". The reason had already been computed by `rejectionBody` and
 * never left the server. Same for a `same_id` replay, which is the documented
 * way to test deduplication: the pipeline answers "duplicate, skipped" and the
 * console said "Alert replayed".
 *
 * A failure that shows green, on the two screens whose whole job is to say what
 * is true. That is the defect this product is built to make impossible, and it
 * was sitting in its own diagnostic.
 *
 * ============================================================================
 * WHAT IS AND IS NOT DECIDED HERE
 *
 * This decides how to REPORT a run, never whether to start one. It invents no
 * status: where the pipeline reached no `respond` node it says so with `0`
 * rather than borrowing the 202 the webhook has to send because HTTP obliges it
 * to send something. A console button is not a protocol; it can say "the
 * pipeline chose no answer" and name the run.
 * ============================================================================
 */

import type { Engine } from './engine/engine.ts';
import type { RunStatus } from './engine/types.ts';

export interface InjectionResult {
  /** True only when the pipeline ACCEPTED the alert (202). */
  ok: boolean;
  /** The pipeline's own HTTP status, or `0` when it chose none. */
  status: number;
  run_id: string;
  run_status: RunStatus;
  /** The pipeline's own reason, when it wrote one. Never invented. */
  detail: string | null;
}

/**
 * The sentence the pipeline wrote about its own answer.
 *
 * `errors` first, because that is where `rejectionBody` puts what a sender has
 * to fix; then `detail`, which `dedupDownBody` uses for the database's message;
 * then the short status word (`duplicate, skipped`). `reason` is deliberately
 * NOT read: `schema_validation_failed` is a pipeline identifier, and this
 * console never shows one raw.
 */
export function answerDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const errors = Array.isArray(b.errors) ? b.errors.filter((e) => typeof e === 'string') : [];
  if (errors.length > 0) return errors.join('; ');
  if (typeof b.detail === 'string' && b.detail.trim() !== '') return b.detail;
  if (typeof b.status === 'string' && b.status.trim() !== '') return b.status;
  return null;
}

/**
 * Starts `01-Ingestion` and reads back the answer the pipeline decided on.
 *
 * The two callers differ only in the sentence they print, so the reading lives
 * here: a second copy of "did it actually get accepted" is a second place for
 * this defect to come back.
 */
export async function injectAlert(
  engine: Engine,
  input: Record<string, unknown>,
  alertId: string,
): Promise<InjectionResult> {
  const run = await engine.start('01-ingestion', input, alertId);
  const decided = await engine.responseOf(run.id);

  if (decided) {
    return {
      // 202 IS THE ONLY ACCEPTANCE. 200 is a duplicate — nothing new was
      // started — and 400/500 are refusals.
      ok: decided.status === 202,
      status: decided.status,
      run_id: run.id,
      run_status: run.status,
      detail: answerDetail(decided.body),
    };
  }

  // No `respond` node was reached: the graph ended some other way, which on
  // this workflow means it broke before deciding. The run exists and is
  // inspectable, so we name it rather than claiming an acceptance nobody wrote.
  return {
    ok: false,
    status: 0,
    run_id: run.id,
    run_status: run.status,
    detail: run.error,
  };
}
