/**
 * What an outgoing call says when it never reached anybody.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `fetch` fails with `TypeError: "fetch failed"` and hides the reason one level
 * down, in `err.cause`. Read with `(err as Error).message` — which is what
 * every caller in this console did — an unreachable host, a name that does not
 * resolve, a refused port and an expired certificate all reach the operator as
 * the same two words.
 *
 * That is the trap CLAUDE.md already records for `pg` ("an unreachable database
 * became a failure with no cause"), on the HTTP side. It is NOT the same fix,
 * and that is the point of `describeFetchError` existing beside
 * `describePgError` rather than being it: `describePgError` keys on an EMPTY
 * message, and `fetch`'s message is not empty — it is merely worthless. Handing
 * a fetch failure to `describePgError` returns "fetch failed" unchanged.
 *
 * The shapes asserted here were MEASURED against Node 22.22.2's `fetch`, not
 * read from documentation. See the header of `describeFetchError`.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import { describeFetchError, fetchWithDeadline } from './http.ts';

/** The shape Node's `fetch` really rejects with: a useless message, a real cause. */
function fetchFailure(cause: unknown): TypeError {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = cause;
  return err;
}

/** A `node:net` style error: a code, and a message that already contains it. */
function sysError(code: string, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

describe('describeFetchError', () => {
  it('never leaves the operator with the words "fetch failed"', () => {
    const said = describeFetchError(
      fetchFailure(sysError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:4400')),
    );
    expect(said).not.toBe('fetch failed');
    expect(said).not.toMatch(/^fetch failed/);
  });

  it('names a refused connection, and keeps the code for a search engine', () => {
    const said = describeFetchError(
      fetchFailure(sysError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:4400')),
    );
    expect(said).toMatch(/nothing is listening/i);
    expect(said).toContain('ECONNREFUSED');
  });

  it('tells a name that does not resolve from a port that refuses', () => {
    const dns = describeFetchError(
      fetchFailure(sysError('ENOTFOUND', 'getaddrinfo ENOTFOUND siem.example.com')),
    );
    expect(dns).toMatch(/cannot be found/i);
    // The two must not read the same: one is a typo in a hostname, the other is
    // a service that is switched off, and they send someone to different places.
    expect(dns).not.toEqual(
      describeFetchError(fetchFailure(sysError('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443'))),
    );
  });

  it('names a TLS certificate the console refused', () => {
    const said = describeFetchError(
      fetchFailure(sysError('CERT_HAS_EXPIRED', 'certificate has expired')),
    );
    expect(said).toMatch(/certificate/i);
    expect(said).toContain('CERT_HAS_EXPIRED');
  });

  it('says the deadline fired, rather than "This operation was aborted"', () => {
    // What an `AbortController` really produces: a DOMException, no cause.
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const said = describeFetchError(aborted);
    expect(said).toMatch(/deadline|did not answer/i);
    expect(said).not.toContain('This operation was aborted');
  });

  it('falls back to the cause’s own words when it carries no code', () => {
    // Measured: undici refuses a request to port 1 with `cause.message = "bad
    // port"` and NO code at all. A helper that only understood codes would put
    // us back at "fetch failed" for it.
    const said = describeFetchError(fetchFailure(new Error('bad port')));
    expect(said).toContain('bad port');
    expect(said).not.toBe('fetch failed');
  });

  it('keeps an unrecognised code readable instead of swallowing it', () => {
    const said = describeFetchError(fetchFailure(sysError('UND_ERR_WHATEVER', 'something new')));
    expect(said).toContain('UND_ERR_WHATEVER');
  });

  it('says SOMETHING for an error carrying neither cause nor message', () => {
    // The rule this whole file defends: no failure reaches a screen mute.
    const said = describeFetchError(new TypeError(''));
    expect(said.trim()).not.toBe('');
    expect(said).toMatch(/TypeError|no reason|unknown/i);
  });

  /**
   * The property that makes it safe to wrap a catch that sees more than fetch.
   *
   * Two of the call sites — the MCP test button and the assistant's provider
   * call — catch everything, not only transport failures. If this helper
   * rewrote a message that already said something, it would DESTROY
   * information at those sites instead of adding it. It must only ever replace
   * the ones that say nothing.
   */
  it('leaves an error that already explains itself completely alone', () => {
    const real = new Error('The model refused the key: invalid_api_key.');
    expect(describeFetchError(real)).toBe('The model refused the key: invalid_api_key.');
  });

  it('is not confused by a non-Error thrown value', () => {
    expect(describeFetchError('nope').trim()).not.toBe('');
    expect(describeFetchError(undefined).trim()).not.toBe('');
  });
});

describe('fetchWithDeadline still decides nothing about the answer', () => {
  it('returns a non-2xx as a Response, for the caller to judge', async () => {
    const impl = vi.fn(async () => new Response('nope', { status: 503 }));
    const res = await fetchWithDeadline('https://x.example', {}, {
      fetchImpl: impl as unknown as typeof globalThis.fetch,
    });
    expect(res.status).toBe(503);
  });
});
