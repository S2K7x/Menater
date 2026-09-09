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
 *
 * It does, however, decide how a call that reached NOBODY is described — see
 * `describeFetchError`. Naming a cause is not deciding what it means.
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

/**
 * What actually went wrong, in a sentence an operator can act on.
 *
 * ============================================================================
 * `fetch` FAILS WITH A MESSAGE THAT SAYS NOTHING
 *
 * Every transport failure rejects with the same `TypeError: "fetch failed"`,
 * and the reason sits one level down, in `err.cause`. Read the way every caller
 * here read it — `(err as Error).message` — a hostname with a typo in it, a
 * service that is switched off, a firewall and an expired certificate all reach
 * the screen as those two words.
 *
 * That is the trap CLAUDE.md already records for `pg` ("`pg` raises an error
 * with an EMPTY message … an unreachable database became a failure with no
 * cause"), pointing the other way. It needs its OWN function rather than
 * `describePgError`: that one keys on the message being empty, and this one is
 * not empty — it is merely worthless, so it would be returned unchanged.
 *
 * MEASURED, NOT ASSUMED. Against Node 22.22.2's `fetch`:
 *
 *   refused port    TypeError "fetch failed" → cause.code ECONNREFUSED,
 *                   cause.message "connect ECONNREFUSED 127.0.0.1:34689"
 *   unknown host    → cause.code ENOTFOUND,
 *                     cause.message "getaddrinfo ENOTFOUND …"
 *   peer hung up    → cause.code UND_ERR_SOCKET, cause.message "other side closed"
 *   blocked port    → cause.message "bad port", and NO code at all
 *   aborted         DOMException, name "AbortError", NO cause
 *
 * The "bad port" line is why the code table alone is not enough: a cause can
 * carry a message and no code, and falling through to "fetch failed" for it
 * would rebuild the defect inside its own fix.
 *
 * The vocabulary deliberately matches `tcpProbe`'s in `probes.ts`, which has
 * had this table for the socket path all along: the same refusal must not be
 * described two different ways depending on which button was pressed.
 *
 * These sentences are not in a catalogue, for the reason CLAUDE.md gives for
 * the engine's own strings and for `describePgError`: they are produced by
 * infrastructure, they live where they are produced, and they are English.
 * ============================================================================
 */
export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string } | undefined;

  // The deadline above fired. `onTimeout` gives the callers that want the host
  // and the delay a better sentence still; this is what the others get instead
  // of the browser's "This operation was aborted".
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return 'the host did not answer before the deadline expired.';
  }

  const cause = (err as { cause?: unknown } | undefined)?.cause as
    | { code?: string; message?: string }
    | undefined;
  const code = cause?.code;

  const explained: Record<string, string> = {
    ECONNREFUSED: 'connection refused — nothing is listening at that address',
    ENOTFOUND: 'the host cannot be found — check the domain name',
    EAI_AGAIN: 'the name could not be resolved — the DNS server did not answer',
    EHOSTUNREACH: 'the host is unreachable from this machine',
    ENETUNREACH: 'the network is unreachable from this machine',
    ETIMEDOUT: 'the connection timed out — a firewall, or the host is switched off',
    ECONNRESET: 'the connection was reset by the other end',
    UND_ERR_SOCKET: 'the other end closed the connection before answering',
    UND_ERR_CONNECT_TIMEOUT: 'the connection could not be established in time',
    CERT_HAS_EXPIRED: 'the TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed and not trusted here',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified',
    ERR_INVALID_URL: 'that is not a valid address',
  };

  if (code) return `${explained[code] ?? `the call failed with ${code}`} (${code})`;

  // A cause with words but no code — "bad port" is the measured example.
  const causeMessage = (cause?.message ?? '').trim();
  if (causeMessage !== '') return causeMessage;

  // No cause at all. The outer message is still better than nothing, EXCEPT
  // when it is the one word that started all this.
  const own = (e?.message ?? '').trim();
  if (own !== '' && own !== 'fetch failed') return own;

  return 'the call failed with no reason given '
    + `(${(err as Error)?.constructor?.name ?? typeof err})`;
}
