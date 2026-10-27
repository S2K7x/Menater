/**
 * Nothing this console dials may hand it an unbounded answer.
 *
 * ============================================================================
 * THE RULE EXISTED, ON ONE READER OUT OF THIRTEEN
 *
 * `readCapped` was written for the ingestion poller, under a comment that
 * states the rule in full: "`await res.json()` buffers whatever arrives, and
 * the address is one somebody typed into a form: a source that answers a
 * gigabyte, by malice or by a forgotten pagination parameter, grows the heap
 * until the console dies. The console has no business being taken down by a
 * log source."
 *
 * Every other outbound read in `server/` buffered whatever the far end sent.
 * Three of them dial an address an operator typed — the engine's `http` node
 * (`endpoint.isolation`, the containment call) and the two chat webhooks,
 * whose URL IS the credential — and the rest dial third parties about a value
 * an attacker chose.
 *
 * Measured over a real socket against a chunked answer, before the fix:
 *
 *    MB  | worst blocked loop | heapUsed | the row it writes to soc_run_step
 *    16  |             117 ms |  48.9 MB | 16.1 MB
 *    64  |             489 ms | 192.4 MB | 64.1 MB
 *   128  |           3 270 ms | 382.3 MB | 128.1 MB
 *
 * That is the thread that also answers the ingestion webhook, and in the
 * engine's `http` node the parsed body becomes the node's OUTPUT — so an
 * unbounded answer is not merely held, it is persisted into the run journal.
 *
 * ============================================================================
 * WHY THE CLAIM IS A SUBTRACTION
 *
 * A test naming the thirteen sites goes stale silently the day a fourteenth
 * outbound call is written — which is exactly how this lasted. So the claim is
 * that NO response body is read in `server/` except through the capped reader,
 * with one named exemption: the module that OWNS that reader, where the
 * uncapped read legitimately lives. It is asserted in both directions, because
 * a rule that cannot find its own owner would pass over a product that had
 * stopped reading bodies at all.
 *
 * ============================================================================
 * WHAT IS A FAKE HERE, AND WHAT CANNOT BE
 *
 * The PRIMITIVE is driven over a real socket: a fake cannot vouch for a socket
 * being released, and "the stream is cancelled rather than buffered" is the
 * whole property. The CALL SITES are driven with a `Response` whose body is a
 * lazily-generating `ReadableStream` — the fake does implement the option
 * under test (the body stream), nothing is pre-allocated, and what is being
 * claimed of a call site is only that it goes through the primitive.
 * ============================================================================
 */

import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_ANSWER_BYTES, ResponseTooLarge, readCapped } from './http.ts';
import { ioHandlers, type IoDeps } from './engine/nodes/io.ts';
import { TransformRegistry } from './engine/nodes/pure.ts';
import type { NodeContext } from './engine/engine.ts';
import type { NodeDef, NodeType } from './engine/types.ts';
import { lookup, pwnedRange } from './intel/lookup.ts';
import { chat } from './assistant/chat.ts';
import { resetCursorCache } from './ingest/cursors.ts';
import { pollSource } from './ingest/poller.ts';
import { defaultPolicy } from './ingest/policy.ts';

const MB = 1024 * 1024;

/* ==========================================================================
 * HELPERS
 * ========================================================================== */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/`;
}

/**
 * A chunked answer of `bytes`, generated as it is written.
 *
 * No `content-length`, deliberately: with one, `readCapped` refuses on the
 * header alone and the streaming guard — the half that matters — is never
 * exercised. Measured: a `Response` built from a string carries no
 * `content-length` either, so the two agree.
 */
async function serveBytes(bytes: number): Promise<string> {
  return listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
    const chunk = `"${'x'.repeat(65_531)}",`;
    let sent = 1;
    const pump = () => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end('"end"]');
    };
    pump();
  });
}

/** A `Response` whose body yields `bytes` total, a chunk at a time. */
function streamed(bytes: number, status = 200): Response {
  let sent = 0;
  const chunk = new TextEncoder().encode('z'.repeat(64 * 1024));
  return new Response(
    new ReadableStream({
      pull(c) {
        if (sent >= bytes) {
          c.close();
          return;
        }
        sent += chunk.byteLength;
        c.enqueue(chunk);
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** A transport that answers `res` to anything. */
const answers = (res: Response | (() => Response)) =>
  vi.fn(async () => (typeof res === 'function' ? res() : res)) as unknown as typeof globalThis.fetch;

function deps(over: Partial<IoDeps> = {}): IoDeps {
  return {
    transforms: new TransformRegistry(),
    vars: () => new Map(),
    now: () => new Date('2026-10-27T03:00:00.000Z'),
    secret: () => undefined,
    ...over,
  };
}

function ctx(type: NodeType, params: Record<string, unknown>): NodeContext {
  const node: NodeDef = { id: 'n1', type, label: 'probe', params, position: { x: 0, y: 0 } };
  return {
    runId: 'run-1',
    workflow: { id: 'wf', name: 'test', version: 1, nodes: [node], edges: [] },
    node,
    input: {},
    outputs: new Map(),
    alertId: 'A-1',
  };
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the call was expected to be refused and was not');
}

/* ==========================================================================
 * 1 — THE RULE, AS A SUBTRACTION OVER THE WHOLE SERVER
 * ========================================================================== */

/** Where the uncapped read legitimately lives. */
const OWNER = 'http.ts';

/**
 * Comments and imports stripped before the search.
 *
 * This repository has twice written a sweep whose own prose satisfied it — a
 * test that explains the pattern it hunts, in a file the hunt then reads. The
 * modules below describe `res.text()` at length in their headers.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import[\s\S]*?from\s+'[^']*';$/gm, '');
}

function serverFiles(dir = join(import.meta.dirname, '.')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...serverFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const BODY_READ = /\b\w+\.(?:text|json|arrayBuffer|blob|bytes)\s*\(\s*\)/g;

describe('no response body is read outside the capped reader', () => {
  it('finds no uncapped read in server/, the reader own module aside', () => {
    const offenders: string[] = [];
    for (const path of serverFiles()) {
      if (path.endsWith(OWNER)) continue;
      const body = code(path);
      for (const m of body.matchAll(BODY_READ)) {
        const line = body.slice(0, m.index).split('\n').length;
        offenders.push(`${path.replace(import.meta.dirname, 'server')}:${line} — ${m[0]}`);
      }
    }
    expect(offenders, `read a response body without a cap:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('still finds the reader that owns the uncapped read', () => {
    // The other direction. Without it the rule above passes over a server that
    // had stopped reading bodies at all — green over nothing.
    const owner = code(join(import.meta.dirname, OWNER));
    expect(owner.match(BODY_READ) ?? []).not.toEqual([]);
    expect(owner).toContain('readCapped');
  });
});

/* ==========================================================================
 * 2 — THE PRIMITIVE, OVER A REAL SOCKET
 * ========================================================================== */

describe('readCapped, against a real server', () => {
  it('refuses a body past the cap and names the size', async () => {
    const url = await serveBytes(4 * MB);
    const res = await fetch(url);
    await expect(readCapped(res, 1 * MB)).rejects.toThrow(ResponseTooLarge);
  });

  it('stops reading at the cap instead of buffering the whole body', async () => {
    /**
     * THE PROPERTY, and it is asserted by counting WORK — how many bytes the
     * reader actually pulled — because the two obvious instruments are both
     * broken here, and I measured that rather than assuming it.
     *
     * A HEAP SAMPLE CANNOT SEE IT. My first version read 64 MB over a real
     * socket and asserted `heapUsed` had not grown by it. A mutation that
     * buffers the whole body and compares the total only AFTER the loop
     * SURVIVED all 21 tests: by the time the rejection is observed, the
     * refusal has already dropped the buffer, and a `Uint8Array`'s backing
     * store is external memory anyway. The assertion was reading a number that
     * says nothing about when the cap fired.
     *
     * A TIMING ASSERTION WOULD BE THE FLAKY KIND this project has removed
     * once already.
     *
     * So the body is a stream that counts what is pulled out of it. A cap
     * applied after the fact reads every byte; one applied while reading stops
     * within a chunk of the limit.
     */
    let pulled = 0;
    const chunk = new TextEncoder().encode('q'.repeat(64 * 1024));
    const body = new ReadableStream({
      pull(c) {
        // 64 MB worth, generated on demand: nothing is pre-allocated, so the
        // count is the reader's behaviour and not the fixture's.
        if (pulled >= 64 * MB) {
          c.close();
          return;
        }
        pulled += chunk.byteLength;
        c.enqueue(chunk);
      },
    });
    await expect(readCapped(new Response(body), 1 * MB)).rejects.toThrow(ResponseTooLarge);
    // One chunk of slack: the cap is noticed on the read that passes it.
    expect(pulled).toBeLessThanOrEqual(1 * MB + chunk.byteLength);
  });

  it('releases the socket of an answer it refused', async () => {
    // What the stream above cannot vouch for, and the reason a socket is used
    // here: a body left unconsumed keeps the connection checked out of
    // undici's pool. Two sequential requests to a one-connection server both
    // complete only if the first was released.
    const url = await serveBytes(8 * MB);
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(url);
      await expect(readCapped(res, 64 * 1024)).rejects.toThrow(ResponseTooLarge);
    }
  });

  it('refuses early on an announced size, without reading anything', async () => {
    // Moved here with the reader, from `poller.test.ts`. `content-length` is a
    // claim by the other end: it may refuse early, and is never trusted to let
    // anything through.
    const res = new Response('{}', { headers: { 'content-length': String(50 * MB) } });
    await expect(readCapped(res, 1024)).rejects.toThrow(/announced 50 MB, over the 1 kB/);
  });

  it('states a cap an operator can say out loud', async () => {
    // Also moved. `max / 1024 / 1024` printed "over 0.00048828125 MB" here,
    // which is a limit nobody can act on.
    await expect(readCapped(new Response('x'.repeat(2000)), 500))
      .rejects.toThrow(/over the 500 bytes/);
  });

  it('carries the facts rather than a sentence, so each caller words it', async () => {
    // The `BodyTooLarge` shape: the poller says "lower the batch size", which
    // a containment receipt has no use for.
    const err = await readCapped(new Response('x'.repeat(2000)), 500).catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLarge);
    expect(err.limit).toBe(500);
    expect(err.announced).toBeNull();
    const announced = await readCapped(
      new Response('{}', { headers: { 'content-length': '999999' } }), 500,
    ).catch((e) => e);
    expect(announced.announced).toBe(999_999);
  });

  it('reads an honest answer whole', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const res = await fetch(url);
    expect(await readCapped(res, 1 * MB)).toBe('{"ok":true}');
  });
});

/* ==========================================================================
 * 3 — THE CALL SITES
 * ========================================================================== */

describe('the engine http node — the containment call', () => {
  it('refuses an answer past the cap rather than parsing it', async () => {
    // `endpoint.isolation` is a pipeline variable: an address an operator
    // typed, which is the same provenance the poller caps for.
    const h = ioHandlers(deps({ fetch: answers(() => streamed(MAX_ANSWER_BYTES + MB)) }));
    const said = await messageOf(
      h.http(ctx('http', { url: { kind: 'const', value: 'https://edr.corp.test/isolate' } })),
    );
    expect(said).toMatch(/2 MB/);
    expect(said).toContain('edr.corp.test');
  });

  it('still returns a receipt of an honest size', async () => {
    // The boundary: green before AND after. A cap that broke the normal answer
    // would be worse than the defect.
    const h = ioHandlers(deps({ fetch: answers(new Response('{"isolated":true}')) }));
    const out = await h.http(ctx('http', { url: { kind: 'const', value: 'https://edr.corp.test/x' } }));
    expect(out.output).toEqual({ status: 200, ok: true, body: { isolated: true } });
  });
});

describe('the engine llm node — the triage decision', () => {
  it('refuses an answer past the cap', async () => {
    const h = ioHandlers(
      deps({
        fetch: answers(() => streamed(MAX_ANSWER_BYTES + MB)),
        secret: () => 'sk-test',
      }),
    );
    const said = await messageOf(
      h.llm(ctx('llm', { prompt: { kind: 'const', value: 'triage' }, model: { kind: 'const', value: 'm' } })),
    );
    expect(said).toMatch(/2 MB/);
  });

  it('refuses an over-cap REFUSAL body too', async () => {
    // The non-ok branch reads the body only to quote 300 characters of it, and
    // read the whole thing first. A refused call must not be able to cost more
    // than an accepted one.
    const h = ioHandlers(
      deps({
        fetch: answers(() => streamed(MAX_ANSWER_BYTES + MB, 500)),
        secret: () => 'sk-test',
      }),
    );
    const said = await messageOf(
      h.llm(ctx('llm', { prompt: { kind: 'const', value: 'triage' }, model: { kind: 'const', value: 'm' } })),
    );
    expect(said).toMatch(/2 MB/);
  });
});

describe('the engine notify node — the approval request', () => {
  const params = {
    channel: { kind: 'const', value: '#soc-approvals' },
    text: { kind: 'const', value: 'Approval required' },
  };

  it('slack-webhook refuses an answer past the cap, without quoting the URL', async () => {
    const h = ioHandlers(
      deps({
        fetch: answers(() => streamed(MAX_ANSWER_BYTES + MB, 500)),
        vars: () => new Map([['notify.transport', 'slack-webhook']]),
        secret: () => 'https://hooks.slack.test/services/T/B/s3cr3t',
      }),
    );
    const said = await messageOf(h.notify(ctx('notify', params)));
    expect(said).toMatch(/2 MB/);
    // A webhook URL IS the credential, and a step error is written to the run
    // journal and printed on the card.
    expect(said).not.toContain('s3cr3t');
  });

  it('discord-webhook refuses an answer past the cap', async () => {
    const h = ioHandlers(
      deps({
        fetch: answers(() => streamed(MAX_ANSWER_BYTES + MB, 500)),
        vars: () => new Map([['notify.transport', 'discord-webhook']]),
        secret: () => 'https://discord.test/api/webhooks/1/s3cr3t',
      }),
    );
    const said = await messageOf(h.notify(ctx('notify', params)));
    expect(said).toMatch(/2 MB/);
    expect(said).not.toContain('s3cr3t');
  });

  it('slack-bot refuses an answer past the cap', async () => {
    // The transport whose success is read from the BODY, and the one that
    // posts the approval request: a run waits on this call.
    const h = ioHandlers(
      deps({ fetch: answers(() => streamed(MAX_ANSWER_BYTES + MB)), secret: () => 'xoxb-test' }),
    );
    const said = await messageOf(h.notify(ctx('notify', params)));
    expect(said).toMatch(/2 MB/);
    expect(said).toContain('Slack');
    // NOT the sentence for a read that failed, and not the one for an empty
    // body: three states, three sentences.
    expect(said).not.toMatch(/could not be read/);
  });

  it('still reads Slack own envelope on an honest answer', async () => {
    // Boundary, green before AND after: the transport whose success is read
    // from the BODY must go on being read.
    const h = ioHandlers(
      deps({ fetch: answers(new Response('{"ok":true,"ts":"1"}')), secret: () => 'xoxb-test' }),
    );
    const out = await h.notify(ctx('notify', params));
    expect((out.output as { transport: string }).transport).toBe('slack-bot');
  });
});

describe('the Lookup tab — a provider answering without end', () => {
  it('reports the source unavailable and names the size', async () => {
    const out = await lookup('1.2.3.4', 'ipv4', {
      fresh: true,
      only: ['internetdb'],
      fetchImpl: answers(() => streamed(MAX_ANSWER_BYTES + MB)),
      secret: () => undefined,
    });
    const source = out.sources.find((s) => s.provider === 'internetdb');
    expect(source?.status).toBe('unavailable');
    expect(source?.reason).toMatch(/2 MB/);
  });

  it('the Pwned Passwords relay enforces the size its comment claims', async () => {
    // Its header says "the answer is a few kilobytes"; nothing enforced it,
    // and the whole body is handed to the browser.
    const out = await pwnedRange('ABCDE', {
      fetchImpl: answers(() => streamed(MAX_ANSWER_BYTES + MB)),
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/2 MB/);
  });
});

describe('the assistant — a model provider answering without end', () => {
  it('refuses rather than buffering it', async () => {
    const said = await messageOf(
      chat({
        messages: [{ role: 'user', content: 'what is waiting?' }],
        page: {},
        locale: 'en',
        apiKey: 'sk-test',
        provider: 'openrouter',
        model: '',
        maxSteps: 1,
        fetchImpl: answers(() => streamed(MAX_ANSWER_BYTES + MB)),
      }),
    );
    expect(said).toMatch(/2 MB/);
  });

  it('refuses an over-cap REFUSAL body too', async () => {
    // The non-ok branch read the body whole and kept 300 characters of it. A
    // provider that refuses us must not be able to cost more than one that
    // answers.
    const said = await messageOf(
      chat({
        messages: [{ role: 'user', content: 'what is waiting?' }],
        page: {},
        locale: 'en',
        apiKey: 'sk-test',
        provider: 'openrouter',
        model: '',
        maxSteps: 1,
        fetchImpl: answers(() => streamed(MAX_ANSWER_BYTES + MB, 500)),
      }),
    );
    expect(said).toMatch(/2 MB/);
  });
});

/* ==========================================================================
 * 4 — THE CAP THAT WAS ALREADY THERE
 * ========================================================================== */

describe('the poller keeps its own, larger cap', () => {
  it('still reads a batch bigger than one answer cap', async () => {
    // Green before AND after. The two numbers measure different things: a page
    // of alerts, and one record. Collapsing them into the smaller one would
    // break the transport this rule was written for.
    resetCursorCache();
    const alerts = Array.from({ length: 4000 }, (_v, i) => ({
      alert_id: `A-${i}`,
      rule_name: 'x'.repeat(700),
      severity: 'low',
      timestamp: '2026-10-27T03:00:00.000Z',
      raw_log: 'y'.repeat(100),
    }));
    const payload = JSON.stringify(alerts);
    expect(payload.length).toBeGreaterThan(MAX_ANSWER_BYTES);

    const delivered: unknown[] = [];
    const out = await pollSource(
      {
        source: 'generic',
        enabled: true,
        url: 'https://siem.corp.test/alerts',
        cursorParam: 'since',
        authHeader: '',
        authCredential: '',
        itemsPath: '',
      },
      defaultPolicy(),
      {
        deliver: async (_s, a) => {
          delivered.push(a);
          return 'run';
        },
        fetchImpl: answers(() => new Response(payload)),
      },
    );
    expect(out.error).toBeNull();
    expect(delivered.length).toBeGreaterThan(0);
  });
});
