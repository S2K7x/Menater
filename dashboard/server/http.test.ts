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

import { createServer, type Server } from 'node:http';
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

/**
 * ============================================================================
 * WHO CHOOSES WHERE AN OUTBOUND CALL ENDS UP
 * ============================================================================
 *
 * Every secret this console sends out travels in a request header: the poller
 * puts a managed credential in a header an operator NAMED, at an address an
 * operator TYPED; the enrichment node does the same with its provider keys;
 * the assistant sends Anthropic's key as `x-api-key`. `fetch` follows a
 * redirect by default, and — measured on Node 22.22.2, two servers on two
 * ports — a cross-origin hop strips `authorization` and KEEPS every custom
 * header, `x-api-key` included. So the host we dialled got to choose the host
 * our credential was delivered to.
 *
 * The rule asserted below is that it does not. A redirect is followed only
 * while it stays on the host the caller named; anything else is refused and
 * SAID, because a call that reached somewhere nobody chose is not an answer.
 *
 * `intel/lookup.ts` had this right, on one of its two calls, as a
 * hand-written `redirect: 'manual'`. It belongs in the primitive for the
 * reason `http.ts`'s own header gives about the deadline: a guard that has to
 * be re-typed at every call site is a guard that will be forgotten — and it
 * had been, at seven of eight.
 */
describe('fetchWithDeadline decides where a call may end up', () => {
  /** A fake transport that records every address it was asked for. */
  function transport(answers: Array<Response | ((url: string) => Response)>) {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      const next = answers[seen.length - 1];
      if (!next) throw new Error(`no answer prepared for call ${seen.length}`);
      return typeof next === 'function' ? next(url) : next;
    });
    return { impl: impl as unknown as typeof globalThis.fetch, seen };
  }

  const redirect = (to: string, status = 302) =>
    new Response('moved', { status, headers: { location: to } });

  it('does not deliver the credential to a host the redirect chose', async () => {
    const { impl, seen } = transport([
      redirect('https://attacker.example/collect'),
      new Response('{"alerts":[]}', { status: 200 }),
    ]);

    await expect(fetchWithDeadline(
      'https://siem.corp/api/alerts',
      { headers: { 'x-api-key': 'WAZUH-SECRET-VALUE' } },
      { fetchImpl: impl },
    )).rejects.toThrow(/redirect/i);

    // THE ASSERTION THAT MATTERS: the second host was never dialled at all.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://siem.corp/api/alerts');
    expect(JSON.stringify(seen)).not.toContain('attacker.example');
  });

  it('still follows a redirect that stays on the host the caller named', async () => {
    // A trailing-slash 301 is the commonest redirect there is, and refusing it
    // would break a working source over a threat that is not present: the
    // credential never leaves the host it was already sent to.
    const { impl, seen } = transport([
      redirect('https://siem.corp/api/alerts/', 301),
      new Response('{"alerts":[]}', { status: 200 }),
    ]);
    const res = await fetchWithDeadline(
      'https://siem.corp/api/alerts',
      { headers: { 'x-api-key': 'WAZUH-SECRET-VALUE' } },
      { fetchImpl: impl },
    );
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual([
      'https://siem.corp/api/alerts',
      'https://siem.corp/api/alerts/',
    ]);
    expect(seen[1]!.headers['x-api-key']).toBe('WAZUH-SECRET-VALUE');
  });

  it('resolves a relative Location against the address it was dialling', async () => {
    const { impl, seen } = transport([
      redirect('/v2/alerts', 301),
      new Response('{"alerts":[]}', { status: 200 }),
    ]);
    await fetchWithDeadline('https://siem.corp/api/alerts', {}, { fetchImpl: impl });
    expect(seen[1]!.url).toBe('https://siem.corp/v2/alerts');
  });

  it('refuses a same-host redirect that drops out of TLS', async () => {
    // The host is the same, so the "who chose this" test passes — and the
    // credential would go out in clear on the next hop. A downgrade is refused
    // for what it costs, not for where it points.
    const { impl, seen } = transport([redirect('http://siem.corp/api/alerts')]);
    await expect(fetchWithDeadline(
      'https://siem.corp/api/alerts',
      { headers: { 'x-api-key': 'SECRET' } },
      { fetchImpl: impl },
    )).rejects.toThrow(/http:|clear|TLS/i);
    expect(seen).toHaveLength(1);
  });

  it('follows the upgrade in the other direction, which is strictly safer', async () => {
    const { impl, seen } = transport([
      redirect('https://siem.corp/api/alerts', 301),
      new Response('ok', { status: 200 }),
    ]);
    const res = await fetchWithDeadline('http://siem.corp/api/alerts', {}, { fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(seen[1]!.url).toBe('https://siem.corp/api/alerts');
  });

  it('never replays a POST body at a redirect, even on the same host', async () => {
    // `notify` POSTs the approval request — the alert's own text — to a webhook.
    // Following a 307 would re-send that body somewhere the caller did not
    // name, and following a 302 would silently turn it into a GET. A redirect
    // on a write is a thing to notice.
    const { impl, seen } = transport([redirect('https://hooks.slack.com/services/B/C', 307)]);
    await expect(fetchWithDeadline(
      'https://hooks.slack.com/services/A',
      { method: 'POST', body: '{"text":"approval request"}' },
      { fetchImpl: impl },
    )).rejects.toThrow(/redirect/i);
    expect(seen).toHaveLength(1);
  });

  it('reads a lower-case method as the method fetch will actually send', async () => {
    // `fetch` normalises `get` to `GET` on the wire. A comparison that did not
    // would refuse a read as though it were a write, and the sentence would
    // name a state the request is not in.
    const { impl, seen } = transport([
      redirect('https://siem.corp/api/alerts/', 301),
      new Response('ok', { status: 200 }),
    ]);
    const res = await fetchWithDeadline(
      'https://siem.corp/api/alerts', { method: 'get' }, { fetchImpl: impl },
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('stops a redirect loop instead of spinning on it', async () => {
    const { impl, seen } = transport(
      Array.from({ length: 20 }, () => redirect('https://siem.corp/again')),
    );
    await expect(fetchWithDeadline('https://siem.corp/start', {}, { fetchImpl: impl }))
      .rejects.toThrow(/redirect/i);
    expect(seen.length).toBeLessThanOrEqual(6);
  });

  it('names the destination by HOST alone, never its path or its query', async () => {
    // A configured endpoint can carry a token in either, and this sentence is
    // written to the run journal and printed on an incident card. Same rule as
    // `reach()` in the engine's I/O nodes.
    const { impl } = transport([
      redirect('https://attacker.example/collect/SECRET-PATH?token=SECRET-QUERY'),
    ]);
    const err = await fetchWithDeadline('https://siem.corp/api', {}, { fetchImpl: impl })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('attacker.example');
    expect(err!.message).not.toContain('SECRET-PATH');
    expect(err!.message).not.toContain('SECRET-QUERY');
    expect(err!.message).toContain('302');
  });

  it('reaches the operator through describeFetchError unchanged', async () => {
    // The poller prints `describeFetchError(err)` and the engine's `reach()`
    // wraps it. A sentence that said nothing at those two sites would be a
    // refusal nobody can act on.
    const { impl } = transport([redirect('https://attacker.example/collect')]);
    const err = await fetchWithDeadline('https://siem.corp/api', {}, { fetchImpl: impl })
      .then(() => null, (e: unknown) => e);
    const said = describeFetchError(err);
    expect(said).toContain('attacker.example');
    expect(said).not.toBe('fetch failed');
  });

  it('hands back a 3xx carrying no Location, because that is not a redirect', async () => {
    // Nothing was pointed anywhere, so there is nothing to refuse. Inventing a
    // failure here would be a sentence reachable from a state it does not
    // describe — the rule `makeLlm` was fixed for.
    const { impl } = transport([new Response('', { status: 302 })]);
    const res = await fetchWithDeadline('https://siem.corp/api', {}, { fetchImpl: impl });
    expect(res.status).toBe(302);
  });

  it('releases the body of the redirect it refused', async () => {
    // The socket stays checked out of the pool until the body is read or
    // cancelled — the reason `drain()` exists in the poller and in the Lookup
    // tab. A guard that leaks a socket per refusal is half a guard.
    const moved = redirect('https://attacker.example/collect');
    const { impl } = transport([moved]);
    await fetchWithDeadline('https://siem.corp/api', {}, { fetchImpl: impl }).catch(() => {});
    expect(moved.bodyUsed || moved.body?.locked).toBeTruthy();
  });
});

/**
 * ============================================================================
 * THE SAME RULE, AGAINST THE REAL `fetch`
 * ============================================================================
 *
 * The block above drives an injected transport, and an injected transport
 * ignores `redirect: 'manual'` — it hands back whatever Response the test
 * wrote, 302 included. So those assertions hold even with that option deleted,
 * and against the real `fetch` the deletion would mean undici follows the
 * redirect ITSELF, delivering the credential before this code ever sees a 3xx.
 * Measured, by deleting the line: eleven green tests over a reopened hole.
 *
 * Every assertion there is therefore worth exactly as much as this one, which
 * uses two real sockets and no fake at all. It is the lesson the `notify`
 * transports are in CLAUDE.md for: found by running it, not by reading it.
 */
describe('against the real fetch, on two real sockets', () => {
  async function listen(handler: Parameters<typeof createServer>[1]): Promise<[Server, number]> {
    const server = createServer(handler);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return [server, (server.address() as { port: number }).port];
  }

  it('never delivers the header to the host a real 302 pointed at', async () => {
    const delivered: Array<Record<string, unknown>> = [];
    const [sink, sinkPort] = await listen((req, res) => {
      delivered.push({ ...req.headers });
      res.writeHead(200).end('{}');
    });
    const [source, sourcePort] = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/collect` }).end();
    });

    try {
      const err = await fetchWithDeadline(
        `http://127.0.0.1:${sourcePort}/api/alerts`,
        { headers: { 'x-api-key': 'WAZUH-SECRET-VALUE' } },
        { timeoutMs: 5_000 },
      ).then(() => null, (e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/redirect/i);
      // A different PORT is a different host, and the credential stopped here.
      expect(delivered).toHaveLength(0);
    } finally {
      sink.close();
      source.close();
    }
  });

  it('still reaches the answer behind a real same-host redirect', async () => {
    let asked = 0;
    const [server, port] = await listen((req, res) => {
      asked += 1;
      if (req.url === '/api/alerts/') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"alerts":[]}');
        return;
      }
      res.writeHead(301, { location: '/api/alerts/' }).end();
    });

    try {
      const res = await fetchWithDeadline(
        `http://127.0.0.1:${port}/api/alerts`, {}, { timeoutMs: 5_000 },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alerts: [] });
      expect(asked).toBe(2);
    } finally {
      server.close();
    }
  });
});
