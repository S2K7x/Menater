/**
 * Tests for the relay to the code-analysis service.
 *
 * ============================================================================
 * WHAT THEY PROTECT
 *
 * The relay is the only thing between the browser and a SEPARATE PROCESS that
 * indexes code with tree-sitter and talks to model APIs. That process can die
 * in the middle of an answer — out of memory on a large repository, a
 * `docker compose restart vulnpipe`, an operator pressing ctrl-C — and when it
 * does, the head of its answer has usually already been relayed.
 *
 * `pipe()` does not forward a failure of its SOURCE. It unpipes and returns,
 * so the error that said the answer was cut was dropped and the console's own
 * response was left OPEN: HTTP 200, a truncated body, and no end. The scan
 * report spun for ever and the live timeline froze with no message — a failure
 * wearing the face of work still in progress, which is the one thing this
 * product exists to make impossible.
 *
 * So the four shapes an unfinished answer takes are driven here over REAL
 * sockets, and four healthy shapes are driven beside them: a fix that cuts a
 * transfer whenever anything goes quiet would pass the first four and break
 * every scan. The controls are green before AND after on purpose.
 * ============================================================================
 */

import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { isVulnPipePath, proxyToVulnPipe } from './vulnpipe.ts';

/** Everything a test stood up, torn down whatever the test did. */
const open: Server[] = [];
const savedUrl = process.env.VULNPIPE_API_URL;

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (savedUrl === undefined) delete process.env.VULNPIPE_API_URL;
  else process.env.VULNPIPE_API_URL = savedUrl;
});

async function listen(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}

/**
 * Stands up a fake analysis service and the console relay in front of it, and
 * returns the console's base URL. `upstream` is the service's behaviour.
 */
async function relayInFrontOf(upstream: RequestListener): Promise<string> {
  const upstreamPort = await listen(upstream);
  process.env.VULNPIPE_API_URL = `http://127.0.0.1:${upstreamPort}`;
  const consolePort = await listen((req, res) => {
    proxyToVulnPipe(req, res, new URL(req.url ?? '/', 'http://console.local'));
  });
  return `http://127.0.0.1:${consolePort}`;
}

/**
 * Asks the relay for something and reports how the request SETTLED.
 *
 * The budget is a safety net, not the measurement: every upstream here fails
 * within ~30 ms, so a request still open after two seconds is one that will
 * never close. The assertions are on the OUTCOME — `hung` versus a named
 * transfer failure — because a test that asserted a duration would be the
 * flaky kind this project has already removed once.
 */
async function ask(base: string, path = '/api/vulnpipe/runs/r1/report'): Promise<{
  hung: boolean;
  status: number | null;
  body: string | null;
  failure: string | null;
}> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctl.signal });
    const body = await res.text();
    return { hung: false, status: res.status, body, failure: null };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') return { hung: true, status: null, body: null, failure: null };
    const cause = (e.cause as Error | undefined)?.message;
    return { hung: false, status: null, body: null, failure: `${e.name}: ${e.message}${cause ? ` / ${cause}` : ''}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The four ways the service can leave an answer unfinished AFTER its head has
 * been relayed. Measured on Node 22.22.2: each one makes the upstream response
 * stream emit `aborted`, then `error` (`ECONNRESET`), then `close` with
 * `complete === false` — and `pipe()` swallows all three.
 */
const UNFINISHED: ReadonlyArray<{ name: string; upstream: RequestListener }> = [
  {
    name: 'the socket dies in the middle of a report',
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2000' });
      res.write('{"findings":[');
      setTimeout(() => res.socket?.destroy(), 20);
    },
  },
  {
    name: 'the socket dies in the middle of the live event stream',
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"step":"index"}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
    },
  },
  {
    name: 'a chunked answer stops without its terminating chunk',
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      res.write('{"findings":[');
      setTimeout(() => res.socket?.destroy(), 20);
    },
  },
  {
    // The one that does not look like a crash from the outside: the service
    // closes cleanly, having sent fewer bytes than it promised.
    name: 'the service ends cleanly, short of the length it announced',
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2000' });
      res.end('{"findings":[');
    },
  },
];

describe('an answer the analysis service did not finish', () => {
  // The three claims are one test on purpose. Asserting "no body arrived"
  // on its own would pass over the unfixed relay for the wrong reason — a
  // request that hangs until it is aborted has no body either — and a test
  // that cannot fail is worth less than no test.
  it.each(UNFINISHED)('$name: the transfer fails, and no half-answer is handed over', async ({ upstream }) => {
    const got = await ask(await relayInFrontOf(upstream));

    // The defect, stated as the operator met it: the console answered and then
    // never finished, so the browser waited for ever. `hung` is that.
    expect(got.hung).toBe(false);

    // It failed as a cut transfer, which is what actually happened — not as a
    // 200 carrying half a report.
    expect(got.failure).toMatch(/terminated|closed|reset|socket/i);

    // The plausible wrong fix is `res.end()`: on a chunked answer that writes
    // the terminating chunk, so a truncated body arrives as a well-formed HTTP
    // message. The client would then blame the REPORT for being unreadable
    // when the service had died — and on a truncation that happens to stay
    // parseable, it would show a scan that found nothing.
    expect(got.body).toBeNull();
  });
});

describe('answers that arrived whole', () => {
  // These four pass BEFORE the fix as well. They are what stops it being
  // widened into "cut the transfer whenever the upstream goes quiet".

  it('relays a complete report untouched', async () => {
    const base = await relayInFrontOf((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"findings":[],"ok":true}');
    });
    const got = await ask(base);
    expect(got.status).toBe(200);
    expect(got.body).toBe('{"findings":[],"ok":true}');
  });

  it('relays an answer with no body at all', async () => {
    // A bodiless answer is `complete` the moment its head is in. Keyed wrongly,
    // the fix would cut every 204 the service sends.
    const base = await relayInFrontOf((_req, res) => res.writeHead(204).end());
    const got = await ask(base, '/api/vulnpipe/runs/r1');
    expect(got.status).toBe(204);
    expect(got.body).toBe('');
  });

  it('relays an event stream that closes normally', async () => {
    // A scan that finishes ends its own stream. That close must not be read as
    // the service having died: the timeline would report a lost stream on
    // every successful scan.
    const base = await relayInFrontOf((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"step":"index"}\n\n');
      setTimeout(() => res.end('event: end\ndata: {}\n\n'), 20);
    });
    const got = await ask(base, '/api/vulnpipe/runs/r1/events');
    expect(got.status).toBe(200);
    expect(got.body).toContain('event: end');
  });

  it('leaves the browser\'s connection usable for the next request', async () => {
    // Green before and after, and it is the control that catches the answer
    // side of the hop-by-hop rule: forwarded onward, the service's
    // `connection: close` tells the BROWSER to hang up after every scan poll.
    //
    // It does NOT claim the `complete` test in the relay. Nothing here does,
    // and that was measured rather than assumed: destroying a response `pipe()`
    // has already ended is a no-op on Node 22.22.2 — `res.writableLength` is 0
    // by then, and the connection survives — so no assertion about a body or a
    // socket can fail on its removal. The reason it stays is written where it
    // is, in `vulnpipe.ts`.
    const base = await relayInFrontOf((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });

    const { Agent: ClientAgent, request } = await import('node:http');
    const keepAlive = new ClientAgent({ keepAlive: true, maxSockets: 1 });
    const url = new URL(base);

    const ports: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      await new Promise<void>((resolve, reject) => {
        const r = request(
          { hostname: url.hostname, port: Number(url.port), path: '/api/vulnpipe/runs/r1', agent: keepAlive },
          (res) => {
            ports.push(res.socket.localPort ?? -1);
            res.resume();
            res.on('end', () => resolve());
          },
        );
        r.on('error', reject);
        r.end();
      });
    }
    keepAlive.destroy();

    // The same socket served both, which is only true if the first answer left
    // the connection alive.
    expect(ports[0]).toBeGreaterThan(0);
    expect(ports[1]).toBe(ports[0]);
  });

  it('relays a report that arrives in many chunks, byte for byte', async () => {
    // A real report is streamed. A fix reading "more than one chunk" as
    // trouble would break exactly the large scans that matter.
    const chunk = 'x'.repeat(8192);
    const base = await relayInFrontOf((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      let sent = 0;
      const tick = setInterval(() => {
        res.write(chunk);
        if (++sent === 20) {
          clearInterval(tick);
          res.end();
        }
      }, 1);
    });
    const got = await ask(base);
    expect(got.status).toBe(200);
    expect(got.body).toBe(chunk.repeat(20));
  });
});

describe('a service that never answered at all', () => {
  // Green before and after: this half already worked, and it is the half an
  // operator meets on a fresh install.

  it('says the service is not running rather than forwarding ECONNREFUSED', async () => {
    process.env.VULNPIPE_API_URL = 'http://127.0.0.1:1';
    const consolePort = await listen((req, res) => {
      proxyToVulnPipe(req, res, new URL(req.url ?? '/', 'http://console.local'));
    });
    const got = await ask(`http://127.0.0.1:${consolePort}`);
    expect(got.status).toBe(503);
    expect(got.body).toContain('npm run serve');
  });

  it('answers 503 when the service dies before writing a head', async () => {
    const base = await relayInFrontOf((_req, res) => {
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const got = await ask(base);
    expect(got.status).toBe(503);
    // The body must name a reason. A 503 with an empty body sends an operator
    // looking for a service that is running.
    expect(got.body).not.toBe('');
  });
});

describe('the headers that describe one hop', () => {
  /** Stands up a relay whose upstream records what it was handed. */
  async function record(answer?: Record<string, string>): Promise<{
    base: string;
    seen: () => { headers: Record<string, string | string[] | undefined>; body: string };
  }> {
    let headers: Record<string, string | string[] | undefined> = {};
    let body = '';
    const base = await relayInFrontOf((req, res) => {
      headers = req.headers;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json', ...(answer ?? {}) }).end('{"ok":true}');
      });
    });
    return { base, seen: () => ({ headers, body }) };
  }

  it('lets the relay\'s own agent decide the connection, not the browser', async () => {
    // Measured before this rule existed: the upstream saw `connection:
    // keep-alive` on every relayed request, because that is what a browser
    // sends — so the `keepAlive: false` agent this file is built around
    // governed one side of the hop only, and the service held a socket open
    // waiting for a second request that would never come on it.
    //
    // The header is not absent afterwards: `http.request` writes the agent's
    // own choice, which is `close`. That is the whole point — the value the
    // service reads is now this relay's decision.
    const { base, seen } = await record();
    await ask(base, '/api/vulnpipe/runs/r1');

    expect(seen().headers.connection).toBe('close');
    expect(seen().headers['keep-alive']).toBeUndefined();
  });

  it('strips the rest of the hop-by-hop set', async () => {
    const { base, seen } = await record();
    await fetch(`${base}/api/vulnpipe/runs/r1`, {
      headers: { te: 'trailers', trailer: 'x-checksum', 'proxy-authorization': 'Basic bm9wZQ==' },
    }).then((r) => r.text());

    expect(seen().headers.te).toBeUndefined();
    expect(seen().headers.trailer).toBeUndefined();
    expect(seen().headers['proxy-authorization']).toBeUndefined();
  });

  it('leaves the headers that describe the MESSAGE alone', async () => {
    // The boundary: a strip wide enough to take `content-type` or the client's
    // own headers with it would break every scan launch. Claimed, not assumed.
    const { base, seen } = await record();
    await fetch(`${base}/api/vulnpipe/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-scan-mode': 'full_scan' },
      body: '{"target":"/srv/orders-api"}',
    }).then((r) => r.text());

    expect(seen().headers['content-type']).toBe('application/json');
    expect(seen().headers['x-scan-mode']).toBe('full_scan');
    // And the body itself: `transfer-encoding` is deleted on the way out, so
    // the framing of this upload is re-declared by the client. If that went
    // wrong, a scan launch would arrive empty.
    expect(seen().body).toBe('{"target":"/srv/orders-api"}');
  });

  it('still keeps the console session cookie away from the service', async () => {
    // Green before and after: this one was already right.
    const { base, seen } = await record();
    await fetch(`${base}/api/vulnpipe/runs/r1`, { headers: { cookie: 'menater_session=secret' } })
      .then((r) => r.text());

    expect(seen().headers.cookie).toBeUndefined();
  });

  it('does not hand the service\'s connection choice to the browser', async () => {
    // The half that had to be added with the other one. Copied onward, the
    // upstream's `connection: close` made the browser read end-of-connection as
    // end-of-body — so a cut event stream arrived as a 200 with a body, which
    // is exactly the confusion the cut in this relay exists to remove.
    const { base } = await record({ connection: 'close', 'keep-alive': 'timeout=600, max=99' });
    const res = await fetch(`${base}/api/vulnpipe/runs/r1`);
    await res.text();

    // Node puts its OWN `Keep-Alive: timeout=5` on this hop's answer, which is
    // correct and is not what is being claimed here. What must not survive is
    // the UPSTREAM's value, so the assertion names it.
    expect(res.headers.get('keep-alive') ?? '').not.toContain('max=99');
    // `fetch` does not expose `connection` at all, so the claim that really
    // carries this direction is the cut-stream test above: it can only fail a
    // chunked answer while the browser is still reading chunked framing, and
    // stripping the request side alone made it pass over a truncated body.
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('the prefix', () => {
  it('claims its own namespace and nothing next to it', () => {
    expect(isVulnPipePath('/api/vulnpipe')).toBe(true);
    expect(isVulnPipePath('/api/vulnpipe/runs/1')).toBe(true);
    // `/api/vulnpipe-something` is not this relay's, and matching it would
    // hand a console route to another process.
    expect(isVulnPipePath('/api/vulnpipe-extra')).toBe(false);
    expect(isVulnPipePath('/api/settings')).toBe(false);
  });
});
