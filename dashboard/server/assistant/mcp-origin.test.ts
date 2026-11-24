/**
 * The MCP endpoint's DNS-rebinding guard, and the premise that licenses it.
 *
 * ============================================================================
 * WHAT WAS WRONG, AND WHY IT READ AS A GUARD
 *
 * `POST /api/mcp` is reachable by anything that can open a socket to the port
 * the container publishes, and it is in `PUBLIC_ROUTES` on purpose: an MCP
 * client has no browser session. The spec's answer to "what stops a web page
 * using the operator's browser as a tunnel into it" is one line — validate the
 * `Origin` header — and this endpoint's own comment stated the premise that
 * makes that work: a real MCP client is not a browser and sends no Origin.
 *
 * It then decided whether an Origin was "ours" by comparing it to the `Host`
 * header OF THE SAME REQUEST. In a DNS-rebinding attack the attacker supplies
 * both: the page is served from a name they own, the name is rebound to
 * 127.0.0.1, and the browser dials the console sending `Host: evil.example`
 * and `Origin: http://evil.example` — a page that is same-origin with itself.
 * The comparison passed, so the one request shape the guard exists for was the
 * one shape it let through, and the four shapes it refused are the ones no
 * attack produces.
 *
 * Measured through the real handler before the fix, which is what the first
 * test below pins:
 *
 *   200  Origin: http://evil.example:4400   Host: evil.example:4400
 *   200  Origin: http://evil.example        Host: evil.example
 *   200  Origin: https://evil.example       Host: evil.example
 *   200  Origin: https://localhost:4400     Host: localhost:4400
 *   403  Origin: https://evil.example       Host: localhost:4400
 *
 * Two documents and two comments already described the fix. CLAUDE.md: *"The
 * browser cannot test it: the Origin guard refuses browsers on purpose."*
 * ROADMAP § 3 bis: *"a browser cannot test an endpoint whose Origin guard
 * refuses browsers."* `routes/assistant.ts`: *"the Origin guard refuses
 * browsers."* All three were false for a browser whose Origin agreed with the
 * Host, which is every browser on the console's own address.
 *
 * ============================================================================
 * WHY THESE TESTS LOOK THE WAY THEY DO
 *
 * TWO CLAIMS, AND ONLY ONE OF THEM IS ABOUT THIS SERVER.
 *
 * The server-side claim — *given an Origin, refuse* — is about headers, so the
 * recorder harness `mcp.test.ts` already uses is exactly the right instrument:
 * a browser's contribution to this attack IS a pair of header values, and a
 * fake that sets them is not approximating anything.
 *
 * The other claim is about THIRD PARTIES — *no legitimate client sends an
 * Origin, so refusing every one costs nothing* — and a fake cannot vouch for
 * it at all. It was measured, with the output pasted into `originAllowed`:
 * the reference SDK's `StreamableHTTPClientTransport` (1.32.1) sends none,
 * `mcp-remote@0.8.3` sets none, Node's bare `fetch` sends none. What CAN be
 * claimed here is the one legitimate caller that lives in this repository, and
 * it is the regression this change most plausibly causes: the console's own
 * self-test. So the last test starts a REAL server on the port
 * `routes/assistant.ts` believes it answers on, drives `POST
 * /api/assistant/mcp-test` through the real `handleRequest`, and lets the
 * probe reach the real `/api/mcp` over a real loopback socket. A fetch double
 * would have been asked whether the code called it the way we expect, which is
 * the same assumption the defect was made of.
 *
 * NOTHING HERE DEPENDS ON A PORT BEING CLOSED. The listener is bound on port 0
 * and the port the OS hands out is what `MENATER_API_PORT` is then set to,
 * before `app.ts` is imported — so the socket the self-test dials is the one
 * this file is already holding. That is `persistent-cache.test.ts`'s lesson
 * avoided rather than re-provoked: a test must provoke the failure it is
 * testing, never borrow a premise from the machine it runs on.
 *
 * AND TWO TESTS PASS BEFORE AND AFTER ON PURPOSE. A client sending no Origin
 * is still served, and a foreign Origin is still refused BEFORE the token is
 * looked at. A guard that broke the only legitimate caller, or that turned
 * into a token oracle for a page, would be worse than the defect.
 * ============================================================================
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Never the developer's own `config.json`: `CONFIG_PATH` is resolved at load. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-mcp-origin-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

const TOKEN = 'test-mcp-token-0123456789';

/* ------------------------------------------------------------------------- *
 * The header-level claims: the recorder harness, same shape as `mcp.test.ts`.
 * ------------------------------------------------------------------------- */

function recorder() {
  const out = {
    status: 0,
    headers: {} as Record<string, unknown>,
    body: '' as string,
    req: { headers: {} },
    headersSent: false,
    writeHead(status: number, headers: Record<string, unknown>) {
      out.status = status;
      out.headers = headers;
      out.headersSent = true;
    },
    end(payload?: Buffer | string) {
      out.body = payload ? payload.toString() : '';
    },
  };
  return out;
}

/**
 * One request at the endpoint.
 *
 * `origin` is deliberately typed as `string | undefined` and set whenever it
 * is not `undefined` — including when it is the empty string, which is a
 * shape the old truthiness test read as "no Origin at all". Measured on Node
 * 22.23.5: `Origin:` and `Origin: ` both arrive as the key `origin` holding
 * `''`, so a presence test and a truthiness test disagree about them.
 */
async function call(options: {
  origin?: string;
  host?: string;
  token?: string | null;
  method?: string;
} = {}) {
  const { MCP_PATH, mcpRoutes } = await import('./mcp.ts');
  const { messages } = await import('../i18n.ts');
  const host = options.host ?? 'localhost:4400';
  const headers: Record<string, string> = { host };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.origin !== undefined) headers.origin = options.origin;

  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const req: any = {
    method: options.method ?? 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload, 'utf8');
    },
  };
  const res = recorder();
  res.req = req;
  const c = {
    req,
    res,
    url: new URL(`http://${host}${MCP_PATH}`),
    path: MCP_PATH,
    locale: 'en',
    am: messages('en').api,
    token: null,
    ip: '127.0.0.1',
  } as unknown as any;
  await mcpRoutes(c);
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
}

async function enableEndpoint() {
  const { getConfig } = await import('../config.ts');
  const cfg = getConfig();
  cfg.assistant.mcpEnabled = true;
  cfg.assistant.mcpToken = TOKEN;
  return cfg;
}

beforeEach(async () => {
  const { resetMcpRateLimit } = await import('./mcp.ts');
  resetMcpRateLimit();
  await enableEndpoint();
});

describe('the MCP endpoint — the Origin header cannot be validated against the Host header', () => {
  /**
   * The defect itself, in the four shapes an attacker actually produces.
   *
   * Every row here supplies BOTH headers, which is what a rebound page does —
   * so every row answered 200 before the fix. They are listed rather than
   * reduced to one because they are four different reasons the old comparison
   * passed: the port carried on the origin, the default port being omitted,
   * `URL.host` dropping the scheme, and the console's own name under another
   * scheme being a different ORIGIN that compared equal.
   */
  it('refuses the DNS-rebinding shapes, where the caller supplies both headers', async () => {
    const shapes: Array<[string, string, string]> = [
      ['the attack as deployed', 'http://evil.example:4400', 'evil.example:4400'],
      ['on the default port', 'http://evil.example', 'evil.example'],
      ['an https page, so `URL.host` drops the scheme', 'https://evil.example', 'evil.example'],
      ['our own name under another scheme', 'https://localhost:4400', 'localhost:4400'],
    ];
    for (const [why, origin, host] of shapes) {
      const r = await call({ origin, host });
      expect(r.status, `${why}: Origin ${origin} / Host ${host}`).toBe(403);
    }
  });

  /**
   * The presence-vs-truthiness half.
   *
   * No browser sends an empty `Origin`, so this was never the hole — it is the
   * reason the guard asks about EXISTENCE and not about a value. A guard whose
   * answer depends on the content of a header it only needs to know the
   * presence of has a second question to get wrong, and this one had already
   * got the first one wrong.
   */
  it('refuses an Origin that is present and empty, and one that is opaque', async () => {
    expect((await call({ origin: '' })).status).toBe(403);
    expect((await call({ origin: '   ' })).status).toBe(403);
    // A sandboxed iframe, a `file://` page, a redirect across origins.
    expect((await call({ origin: 'null' })).status).toBe(403);
    // Two `Origin` headers arrive joined into one string on Node.
    expect((await call({ origin: 'http://a.example, http://b.example' })).status).toBe(403);
  });

  /**
   * The console's own page is refused too, and that is the decision rather
   * than a side effect.
   *
   * Nothing in `src/` calls `/api/mcp` — the install page's test button posts
   * to `/api/assistant/mcp-test`, which is why that route exists. So there is
   * no legitimate browser caller to keep, and keeping one would mean keeping
   * the comparison that cannot tell our page from a rebound one.
   */
  it('refuses the console\'s own page origin, whatever the Host says', async () => {
    expect((await call({ origin: 'http://localhost:4400', host: 'localhost:4400' })).status).toBe(403);
    expect((await call({ origin: 'http://127.0.0.1:4400', host: '127.0.0.1:4400' })).status).toBe(403);
  });

  /**
   * BEFORE AND AFTER, on purpose: the one legitimate shape stays served.
   *
   * Trading one refusal for another is not a fix. A client that sends no
   * Origin is every MCP client that exists.
   */
  it('still serves a client that sends no Origin at all', async () => {
    const r = await call({});
    expect(r.status).toBe(200);
    expect(r.json.result).toEqual({});
  });

  /**
   * BEFORE AND AFTER, on purpose: the refusal does not depend on the token.
   *
   * If the order were reversed a rebound page would get 401 for a wrong token
   * and 200 for a right one — i.e. the endpoint would become an oracle for the
   * one secret that bounds this whole exposure. The page must learn nothing
   * but that it is a page.
   */
  it('refuses a page before the bearer token is looked at', async () => {
    expect((await call({ origin: 'http://evil.example', host: 'evil.example', token: null })).status)
      .toBe(403);
    expect((await call({ origin: 'http://evil.example', host: 'evil.example', token: 'wrong' })).status)
      .toBe(403);
    // And the sentence is about pages, not about credentials.
    const r = await call({ origin: 'http://evil.example', host: 'evil.example', token: 'wrong' });
    expect(String(r.json.error)).toContain('web pages');
  });

  /**
   * BEFORE AND AFTER, on purpose: a switched-off endpoint still answers 404
   * first.
   *
   * The order matters for the same reason as the token: 403 for a page and 404
   * for a disabled endpoint are two different facts, and a page must not learn
   * which by sending an Origin.
   */
  it('still answers 404 for a disabled endpoint, Origin or not', async () => {
    const cfg = await enableEndpoint();
    cfg.assistant.mcpEnabled = false;
    expect((await call({ origin: 'http://evil.example', host: 'evil.example' })).status).toBe(404);
    expect((await call({})).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------- *
 * The premise, over a real socket: the console's own self-test still passes.
 * ------------------------------------------------------------------------- */

describe('the console\'s own MCP self-test, over a real loopback socket', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    // Bound FIRST, on port 0, so the port is one the OS handed out and this
    // file is already holding it — then `MENATER_API_PORT` is set to it before
    // `app.ts` is imported, because `env.ts` freezes `PORT` at module load.
    let handler: ((req: any, res: any) => unknown) | null = null;
    server = createServer((req, res) => {
      if (handler) void handler(req, res);
      else res.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    process.env.MENATER_API_PORT = String(port);

    const { handleRequest } = await import('../app.ts');
    handler = handleRequest;
    await enableEndpoint();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.MENATER_API_PORT;
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  /**
   * This is the regression the change most plausibly causes, and the one the
   * night that found the defect asked to be checked first: the probe sends
   * whatever Node's `fetch` sends, and if that included an `Origin` the
   * absolute guard would refuse the console's own self-test and the install
   * page would report the endpoint broken on a working install.
   *
   * Driven end to end rather than reasoned about: a real POST to
   * `/api/assistant/mcp-test`, which opens a real socket back to
   * `/api/mcp` on this same listener and reads the `initialize` result.
   */
  it('answers ok, so no Origin travels on the probe', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/assistant/mcp-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; detail: string };
    expect(body.detail).not.toContain('403');
    expect(body.ok, body.detail).toBe(true);
    // The sentence the install page prints, so a green here is the green an
    // operator sees.
    expect(body.detail).toContain('read-only');
  });

  /**
   * The same socket, with an Origin on it: what a rebound page gets.
   *
   * Over a real connection rather than the recorder, because the claim that
   * matters to an operator is about the port, not about a function — and
   * because it is the control that says the test above passes for the right
   * reason. A probe that could not reach the endpoint at all would also
   * "send no Origin".
   */
  it('refuses a request carrying an Origin on that same port', async () => {
    const withOrigin = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(withOrigin.status).toBe(403);

    const without = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(without.status).toBe(200);
  });
});
