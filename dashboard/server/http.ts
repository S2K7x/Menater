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
 *
 * AND IT DECIDES WHERE A CALL MAY END UP — see `followOrRefuse`. That is not
 * a judgement about the answer either: it is the question of whether we ever
 * spoke to the host the caller named.
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
 * ============================================================================
 * WHO CHOOSES WHERE AN OUTBOUND CALL ENDS UP
 *
 * Every secret this console sends out travels in a request HEADER. The poller
 * puts a managed credential in a header an operator named, at an address an
 * operator typed (`ingest/poller.ts`); the enrichment node does the same with
 * its provider keys (`engine/nodes/io.ts`); the assistant sends Anthropic's
 * key as `x-api-key` (`assistant/chat.ts`).
 *
 * `fetch` follows a redirect by default, and the spec strips exactly one
 * header when it crosses an origin. Measured on Node 22.22.2, two servers on
 * two ports, one `302` between them:
 *
 *   authorization   sent → ABSENT at the second host   (the spec's one rule)
 *   x-api-key       sent → DELIVERED at the second host
 *   x-soc-token     sent → DELIVERED at the second host
 *
 * So `Authorization` was safe by an accident of the specification, and every
 * other credential this console sends was delivered wherever the host we
 * dialled pointed. A redirect is a reply, and a reply is not allowed to
 * choose the next destination for a request that carries a secret.
 *
 * THE RULE, AND WHY IT IS NOT "REFUSE EVERY REDIRECT"
 *
 * A redirect that stays on the host the caller NAMED is followed: a
 * trailing-slash `301` is the commonest redirect there is, and refusing it
 * would break a working log source over a threat that is not present — the
 * credential never leaves the host it had already been sent to. Everything
 * else is refused and SAID, because a call that reached somewhere nobody
 * chose is not an answer, and a silent one is the failure showing green that
 * this product exists to make impossible.
 *
 * Three refusals, and each names something different:
 *
 *  1. ANOTHER HOST. The case above.
 *  2. OUT OF TLS. Same host, `https:` → `http:`: nobody else was chosen, and
 *     the credential would go on the wire in clear on the next hop. The
 *     upgrade in the other direction is followed — it is strictly safer than
 *     the hop already made.
 *  3. A WRITE. A redirect is followed on `GET` and `HEAD` only. `notify`
 *     POSTs the approval request — the alert's own text — to a webhook;
 *     following a `307` would replay that body at an address the caller did
 *     not name, and a `302` would silently turn it into a `GET`. There is no
 *     method rewriting here, because there is no redirected write.
 *
 * WHY IT LIVES IN THE PRIMITIVE
 *
 * `intel/lookup.ts` had this right, as a hand-written `redirect: 'manual'`
 * with a comment saying a 3xx "would mean the endpoint moved, which is a
 * thing to notice, not to obey". It was on one of that file's two calls, and
 * on none of the other six across the server. That is the same sentence this
 * file's own header already makes about the deadline — a primitive that has
 * to be re-typed by hand is a primitive that will eventually be forgotten —
 * and it had been, seven times out of eight.
 * ============================================================================
 */

/** Statuses whose whole meaning is "ask somewhere else". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hops allowed while a redirect stays on the host the caller named. */
const MAX_REDIRECTS = 5;

/**
 * The destination, by HOST alone — never its path and never its query.
 *
 * This sentence is written to `soc_run_step`, replayed in the Tracking tab and
 * printed on an incident card. A configured endpoint can carry a token in
 * either half of its URL, which is why `reach()` in the engine's I/O nodes
 * already quotes a host and never an address. `null` for a relative `Location`
 * (a same-host hop, so there is nothing to warn about) or an unparseable one.
 */
function hostOf(location: string, base: string): string | null {
  try {
    return new URL(location, base).host || null;
  } catch {
    return null;
  }
}

/** Releases a body nobody will read: the socket stays checked out otherwise. */
async function release(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed, or no body: nothing to reclaim */
  }
}

/**
 * Where this redirect may be followed to, or why it may not.
 *
 * Returns the parsed URL, and the caller then dials THAT rather than the
 * header's text. Comparing one string and sending another is how a check and
 * the request it guards come to disagree about what the address was.
 */
function followOrRefuse(
  from: string,
  location: string,
  method: string,
): { next: URL } | { refusal: string } {
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      refusal: `redirected a ${method}. This console does not follow that: the body would be `
        + 'replayed at an address the call did not name, or silently turned into a GET. '
        + 'Point the setting at the final address.',
    };
  }

  let current: URL;
  let next: URL;
  try {
    current = new URL(from);
    next = new URL(location, current);
  } catch {
    return { refusal: 'redirected to an address that is not a valid URL.' };
  }

  if (next.host !== current.host) {
    return {
      refusal: `redirected to ${next.host}. This console does not follow a redirect off the `
        + 'host it was pointed at: the credentials it sends travel with it, so the destination '
        + 'would be chosen by whoever answered. Point the setting at the final address.',
    };
  }
  if (current.protocol === 'https:' && next.protocol !== 'https:') {
    return {
      refusal: 'redirected out of TLS, to http: on the same host. The credentials this call '
        + 'carries would go on the wire in clear. Point the setting at the final address.',
    };
  }
  return { next };
}

/**
 * `fetch`, aborted after `timeoutMs`, and never redirected off its host.
 *
 * The timer is cleared in a `finally`, so a fast answer does not leave a
 * pending handle keeping the process awake — and the ONE controller covers the
 * whole chain of hops, so a source cannot buy itself five deadlines by
 * answering `301` four times.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  opts: DeadlineOptions = {},
): Promise<Response> {
  const { timeoutMs = 20_000, fetchImpl = globalThis.fetch, onTimeout } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // UPPERCASED because `fetch` normalises the well-known methods on the wire
  // while this comparison would not: `method: 'get'` is sent as a GET and would
  // be read here as a write. That is the check and the request it guards
  // disagreeing about what was asked — the mistake `followOrRefuse` is written
  // to avoid one line further down.
  const method = (init.method ?? 'GET').toUpperCase();
  try {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      // `manual` hands back the 3xx itself, `Location` readable, instead of
      // undici deciding the next address for us.
      const res = await fetchImpl(target, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (!REDIRECT_STATUSES.has(res.status)) return res;
      const location = res.headers.get('location');
      // A 3xx pointing nowhere redirects nothing. Inventing a refusal for it
      // would be a sentence reachable from a state it does not describe.
      if (!location) return res;

      await release(res);

      // The SPECIFIC refusal first: "it redirected to attacker.example" sends
      // someone somewhere, and "it is sending us in circles" does not. A cap
      // reached is only the right answer when the hops were otherwise allowed.
      const step = followOrRefuse(target, location, method);
      if ('refusal' in step) {
        throw new Error(`the address answered HTTP ${res.status} and ${step.refusal}`);
      }
      if (hop >= MAX_REDIRECTS) {
        const where = hostOf(location, target);
        throw new Error(
          `the address answered HTTP ${res.status} again after ${MAX_REDIRECTS} redirects`
          + `${where ? ` (${where})` : ''}: it is sending this console in circles.`,
        );
      }
      target = step.next.toString();
    }
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
