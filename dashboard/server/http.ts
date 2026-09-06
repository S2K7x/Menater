/**
 * Outgoing HTTP with a hard deadline.
 *
 * WHY THIS FILE EXISTS
 *
 * Node's `fetch` sets no deadline of its own. A host that accepts the
 * connection and then never answers leaves the caller hanging until the
 * operating system gives up — several minutes later, with nothing said in the
 * meantime. Every outbound call in the console therefore carries an
 * `AbortController` and a timer.
 *
 * That boilerplate had been written out six times, in six files, with six
 * slightly different shapes — and one of them, the Slack node that posts the
 * approval request, had been written without it at all. A primitive that has
 * to be re-typed by hand is a primitive that will eventually be forgotten.
 *
 * WHAT THIS DOES NOT DECIDE
 *
 * It does not decide what a failure means. A non-2xx answer is returned as a
 * `Response` like any other: the engine's `http` node routes it to its error
 * port, the webhook relay turns it into a 502, the diagnostic reads its status
 * code. Collapsing those into one policy here would take the decision away
 * from the three callers that legitimately disagree about it.
 */

/** The shape both the engine and the webhook relay inject in their tests. */
export type FetchLike = typeof globalThis.fetch;

export interface DeadlineOptions {
  /** Milliseconds before the request is aborted. */
  timeoutMs?: number;
  /** Injectable transport: tests must never reach the network. */
  fetchImpl?: FetchLike;
  /**
   * Builds the error thrown when the deadline fires. Without it the raw
   * `AbortError` propagates, which is what callers that catch everything
   * already expect; the console's settings probes pass one so the operator
   * reads the host and the delay rather than the word "aborted".
   */
  onTimeout?: (url: string, timeoutMs: number) => Error;
}

/**
 * `fetch`, aborted after `timeoutMs`.
 *
 * The timer is cleared in a `finally`, so a fast answer does not leave a
 * pending handle keeping the process awake.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  opts: DeadlineOptions = {},
): Promise<Response> {
  const { timeoutMs = 20_000, fetchImpl = globalThis.fetch, onTimeout } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (onTimeout && (err as Error).name === 'AbortError') {
      throw onTimeout(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
