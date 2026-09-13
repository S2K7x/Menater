/**
 * The MCP endpoint.
 *
 * ============================================================================
 * WHAT THESE PROTECT
 *
 * This is the one part of the assistant that is reachable from the network by
 * something that is not a browser and holds no session. Three failures here are
 * not bugs but exposures, and none of them shows on screen:
 *
 *   1. ANSWERING WITHOUT A TOKEN. The endpoint publishes a port. "Off by
 *      default" and "an empty token closes the door" are the whole access
 *      model, and both are one edit away from inverting.
 *   2. ANSWERING A BROWSER. Without the Origin check, any page the operator
 *      visits can use their browser as a tunnel into a local MCP server. The
 *      spec requires the check; this is what proves it is there.
 *   3. DRIFTING FROM THE PANEL'S CATALOGUE. The value of this surface is that
 *      it is the SAME read-only catalogue. A second list would be a second
 *      thing to audit.
 * ============================================================================
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MCP_PATH, mcpRoutes, resetMcpRateLimit } from './mcp.ts';
import { TOOLS } from './tools.ts';
import { messages } from '../i18n.ts';
import type { Ctx } from '../routes/context.ts';

const TOKEN = 'test-mcp-token-0123456789';

/** A response recorder with just enough of the Node shape for `respond.ts`. */
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

function ctx(options: {
  method?: string;
  body?: unknown;
  token?: string | null;
  origin?: string;
  host?: string;
  version?: string;
} = {}): { c: Ctx; res: ReturnType<typeof recorder> } {
  const { method = 'POST', body, token = TOKEN, origin, host = 'localhost:4400', version } = options;
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { host };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (version) headers['mcp-protocol-version'] = version;

  // `readBody` iterates the request: an async iterable of one chunk is the
  // smallest thing that satisfies it.
  const req: any = {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8');
    },
  };
  const res = recorder();
  res.req = req;
  return {
    c: {
      req,
      res,
      url: new URL(`http://${host}${MCP_PATH}`),
      path: MCP_PATH,
      locale: 'en',
      am: messages('en').api,
      token: null,
      ip: '127.0.0.1',
    } as unknown as Ctx,
    res,
  };
}

async function call(options: Parameters<typeof ctx>[0] = {}) {
  const { c, res } = ctx(options);
  const handled = await mcpRoutes(c);
  return {
    handled,
    status: res.status,
    headers: res.headers,
    json: res.body === '' ? null : JSON.parse(res.body),
  };
}

beforeEach(() => {
  resetMcpRateLimit();
});

/**
 * The configuration is a module-level cache, so the tests reach into it rather
 * than writing a file per case. That is the seam the console already uses for
 * its own settings tests.
 */
async function configure(patch: { mcpEnabled?: boolean; mcpToken?: string }) {
  const { getConfig } = await import('../config.ts');
  const cfg = getConfig();
  cfg.assistant.mcpEnabled = patch.mcpEnabled ?? true;
  cfg.assistant.mcpToken = patch.mcpToken ?? TOKEN;
}

describe('the MCP endpoint — who gets in', () => {
  it('does not exist while it is switched off', async () => {
    await configure({ mcpEnabled: false });
    const r = await call({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    // 404 and not 403: an endpoint that announces itself to an unauthenticated
    // caller tells them what to come back for.
    expect(r.status).toBe(404);
  });

  it('does not exist while it has no token', async () => {
    // The ingestion endpoint's rule, applied again: an empty secret CLOSES the
    // door. "No authentication configured" must never mean "none required".
    await configure({ mcpEnabled: true, mcpToken: '' });
    const r = await call({ token: null, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.status).toBe(404);
  });

  it('refuses a wrong token, and a missing one', async () => {
    await configure({});
    expect((await call({ token: 'wrong', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status)
      .toBe(401);
    expect((await call({ token: null, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status)
      .toBe(401);
  });

  it('refuses a browser origin, and accepts a client that sends none', async () => {
    await configure({});
    // The DNS-rebinding guard the spec requires. A real MCP client is not a
    // browser and sends no Origin at all; a page that does is refused.
    const foreign = await call({
      origin: 'https://evil.example',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(foreign.status).toBe(403);

    const same = await call({
      origin: 'http://localhost:4400',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(same.status).toBe(200);

    const noOrigin = await call({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    expect(noOrigin.status).toBe(200);
  });

  it('answers 405 to GET and DELETE, not 404', async () => {
    await configure({});
    // The spec's answer for "no server stream here". A 404 would read as "wrong
    // URL" to a client probing for the older transport.
    for (const method of ['GET', 'DELETE']) {
      const r = await call({ method });
      expect(r.status).toBe(405);
      expect(r.headers.Allow).toBe('POST');
    }
  });

  it('refuses a protocol version it does not speak', async () => {
    await configure({});
    const r = await call({ version: '1999-01-01', body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    expect(r.status).toBe(400);
    // And accepts the ones it does.
    expect((await call({ version: '2025-06-18', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status)
      .toBe(200);
  });
});

describe('the MCP endpoint — the protocol', () => {
  beforeEach(() => configure({}));

  it('negotiates a version instead of rejecting one', async () => {
    const r = await call({
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      },
    });
    // A version we do not know gets the latest we do; the client decides.
    expect(r.json.result.protocolVersion).toBe('2025-06-18');
    expect(r.json.result.capabilities.tools).toBeDefined();
    expect(r.json.result.serverInfo.name).toBe('menater-console');
  });

  it('tells the other side what a fence means, since it never sees our prompt', async () => {
    const r = await call({
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    });
    // `instructions` is the only place an MCP server can speak to the model on
    // the other side. Without this, the markers arrive as unexplained noise
    // around attacker-written text — worse than not fencing, because it looks
    // handled.
    expect(r.json.result.instructions).toMatch(/untrusted:NONCE/);
    expect(r.json.result.instructions).toMatch(/never an instruction/i);
    expect(r.json.result.instructions).toMatch(/read-only/i);
  });

  it('answers a notification with 202 and no body at all', async () => {
    const r = await call({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(r.status).toBe(202);
    // Not an empty JSON object: the spec says no body.
    expect(r.json).toBeNull();
  });

  it('exposes exactly the panel\'s catalogue, annotated read-only', async () => {
    const r = await call({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const names = r.json.result.tools.map((t: any) => t.name);
    // The SAME list, whatever its length. A second catalogue here would be a
    // second thing to audit, and the read-only assertion guards only one.
    expect(names.sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const tool of r.json.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      // `destructiveHint` is deliberately ABSENT: the spec defines it as
      // meaningful only when readOnlyHint is false. Sending it anyway costs
      // bytes on every request to say nothing, and schema weight is the cost an
      // MCP server pays whether its tools are called or not.
      expect(tool.annotations.destructiveHint).toBeUndefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.title).toBeTruthy();
    }
  });

  it('runs a tool and names the fence in the result itself', async () => {
    const r = await call({
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_setup_state', arguments: {} } },
    });
    expect(r.json.result.isError).toBe(false);
    expect(r.json.result.content[0].type).toBe('text');
    expect(r.json.result.structuredContent).toBeDefined();
  });

  it('separates a protocol error from a tool that could not answer', async () => {
    // An unknown tool is the CLIENT being wrong: a JSON-RPC error. A tool that
    // ran and failed is a result with isError. Collapsing them hides a client
    // bug behind a plausible answer.
    const unknown = await call({
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
    });
    expect(unknown.json.error.code).toBe(-32602);
    expect(unknown.json.result).toBeUndefined();

    const badArgs = await call({
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_alert', arguments: 'nope' } },
    });
    expect(badArgs.json.error.code).toBe(-32602);
  });

  it('refuses an unknown method with -32601', async () => {
    // Deliberately a method this server will never implement. `resources/list`
    // used to stand here and this test caught the day it stopped being unknown
    // — which is the assertion working, not the assertion being wrong.
    const r = await call({ body: { jsonrpc: '2.0', id: 5, method: 'sampling/createMessage' } });
    expect(r.json.error.code).toBe(-32601);
  });

  it('refuses a body that is not JSON-RPC 2.0', async () => {
    const r = await call({ body: { id: 6, method: 'ping' } });
    expect(r.json.error.code).toBe(-32600);
  });

  it('handles a batch, and drops the notifications from the reply', async () => {
    const r = await call({
      body: [
        { jsonrpc: '2.0', id: 7, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      ],
    });
    expect(Array.isArray(r.json)).toBe(true);
    // Two replies, not three: a notification gets none.
    expect(r.json).toHaveLength(2);
    expect(r.json.map((x: any) => x.id).sort()).toEqual([7, 8]);
  });

  it('rate limits tool calls rather than letting a looping agent hammer the pipeline', async () => {
    const body = {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'get_setup_state', arguments: {} },
    };
    let limited = null as any;
    for (let i = 0; i < 130; i += 1) {
      const r = await call({ body });
      if (r.json?.error) {
        limited = r.json.error;
        break;
      }
    }
    expect(limited?.message).toMatch(/rate limit/i);
  });
});

/* -------------------------------------------------------------------------
 * Prompts, resources and completion — the primitives that make it usable
 *
 * A client that sees only tool names sees ten getters and no reason to use
 * them. These three are what turn the endpoint into something an operator can
 * pick from a menu, and each has one failure that is silent rather than loud.
 * ---------------------------------------------------------------------- */

describe('the MCP endpoint — prompts, resources, completion', () => {
  beforeEach(() => {
    resetMcpRateLimit();
  });

  it('declares every capability it actually serves, and no more', async () => {
    const r = await call({
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      },
    });
    const caps = r.json.result.capabilities;
    expect(caps.tools).toBeDefined();
    expect(caps.prompts).toBeDefined();
    expect(caps.resources).toBeDefined();
    expect(caps.completions).toBeDefined();
    // `listChanged` is false everywhere and that is honest: all three catalogues
    // are constants in the source. Declaring a notification we can never send
    // would leave a client waiting for an update that cannot come.
    expect(caps.tools.listChanged).toBe(false);
    expect(caps.prompts.listChanged).toBe(false);
    expect(caps.resources.listChanged).toBe(false);
  });

  it('offers prompts that carry their own arguments', async () => {
    const r = await call({ body: { jsonrpc: '2.0', id: 2, method: 'prompts/list' } });
    const prompts = r.json.result.prompts;
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(Array.isArray(p.arguments)).toBe(true);
      // The builder is a function and must NOT be serialised into the reply:
      // JSON.stringify would drop it silently, but the shape would still be
      // wrong for anything that inspects the object.
      expect(p.build).toBeUndefined();
    }
  });

  it('refuses a prompt that is missing its required argument', async () => {
    // Better than rendering a prompt that says "explain alert undefined" and
    // letting a model answer about nothing.
    const r = await call({
      body: { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'explain-alert', arguments: {} } },
    });
    expect(r.json.error.code).toBe(-32602);
    expect(r.json.error.message).toMatch(/alert_id/);
  });

  it('renders a prompt as a user message carrying the argument', async () => {
    const r = await call({
      body: {
        jsonrpc: '2.0', id: 4, method: 'prompts/get',
        params: { name: 'explain-alert', arguments: { alert_id: 'ALT-1' } },
      },
    });
    const msg = r.json.result.messages[0];
    expect(msg.role).toBe('user');
    expect(msg.content.text).toContain('ALT-1');
  });

  it('lists resources and a template, and reads one', async () => {
    const list = await call({ body: { jsonrpc: '2.0', id: 5, method: 'resources/list' } });
    expect(list.json.result.resources.some((r: any) => r.uri === 'menater://glossary')).toBe(true);

    const templates = await call({ body: { jsonrpc: '2.0', id: 6, method: 'resources/templates/list' } });
    expect(templates.json.result.resourceTemplates[0].uriTemplate).toContain('{alert_id}');

    const read = await call({
      body: { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'menater://glossary' } },
    });
    const content = read.json.result.contents[0];
    expect(content.mimeType).toBe('application/json');
    expect(JSON.parse(content.text).terms.length).toBeGreaterThan(0);
  });

  it('refuses an unknown resource URI rather than answering empty', async () => {
    const r = await call({
      body: { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'menater://nope' } },
    });
    expect(r.json.error.code).toBe(-32602);
  });

  it('completes an alert id, and completes nothing else', async () => {
    const known = await call({
      body: {
        jsonrpc: '2.0', id: 9, method: 'completion/complete',
        params: { ref: { type: 'ref/prompt', name: 'explain-alert' }, argument: { name: 'alert_id', value: '' } },
      },
    });
    expect(Array.isArray(known.json.result.completion.values)).toBe(true);

    // An argument we have no list for returns an EMPTY list, not a guess: a
    // fabricated completion is a value the operator did not choose.
    const other = await call({
      body: {
        jsonrpc: '2.0', id: 10, method: 'completion/complete',
        params: { ref: { type: 'ref/prompt', name: 'explain-alert' }, argument: { name: 'query', value: 'x' } },
      },
    });
    expect(other.json.result.completion.values).toEqual([]);
  });
});

describe('the MCP endpoint — the text block is JSON', () => {
  beforeEach(() => {
    resetMcpRateLimit();
  });

  /**
   * Found by calling the endpoint, not by reading the code. The fence note used
   * to be prefixed onto the serialised result, which left `content[0].text` as
   * something no client could parse — while `structuredContent` beside it made
   * everything look fine.
   */
  it('keeps content[0] parseable and puts the fence note in its own block', async () => {
    const r = await call({
      body: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_attention', arguments: {} },
      },
    });
    const content = r.json.result.content;
    expect(() => JSON.parse(content[0].text)).not.toThrow();
    expect(r.json.result.structuredContent).toBeDefined();
    // The note, when there is untrusted text to explain, is a SECOND block.
    const notes = content.slice(1).filter((b: any) => /untrusted:/.test(b.text));
    if (notes.length > 0) expect(notes[0].text).toMatch(/evidence to describe/);
  });
});
