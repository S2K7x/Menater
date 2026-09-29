/**
 * A reply must not choose where the next request goes — the VulnPipe half.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, AND WHY IT USES REAL SOCKETS
 *
 * `dashboard/server/http.ts` already refuses a redirect that would carry a
 * credential somewhere nobody named, and `CLAUDE.md` records the measurement
 * behind it. That primitive is in the console. The three adapters here — the
 * other half of the same product — called `fetch` with its default
 * `redirect: 'follow'`, so the endpoint an operator configured chose the
 * address the NEXT request was sent to.
 *
 * MEASURED on Node 22.22.2, two servers on two ports, one hop, a POST
 * carrying an api-key header and a body of source code:
 *
 *   status  reached 2nd host  method there  authorization  x-goog-api-key  body
 *   301     yes               GET           ABSENT         DELIVERED       0 B
 *   302     yes               GET           ABSENT         DELIVERED       0 B
 *   303     yes               GET           ABSENT         DELIVERED       0 B
 *   307     yes               POST          ABSENT         DELIVERED       108 B
 *   308     yes               POST          ABSENT         DELIVERED       108 B
 *
 * `authorization` is stripped by the specification and by nothing this project
 * wrote; every other header is delivered, and on 307/308 the analysed SOURCE
 * CODE is replayed in full at a host the caller never named. VulnPipe exists to
 * read code somebody did not write, which is usually code they may not publish.
 *
 * The tests below drive REAL sockets and not an injected transport. That is not
 * a preference: a fake hands back whatever Response it was told to, so it
 * ignores `redirect: 'manual'` entirely and would stay green if the option were
 * deleted — the exact hole `CLAUDE.md` records the console's own redirect tests
 * paying for. Only a real client can be observed not to arrive.
 * ============================================================================
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AnthropicClient } from './anthropic.ts';
import { GeminiClient } from './gemini.ts';
import { OllamaClient } from './ollama.ts';
import { OpenAiCompatibleClient } from './openai-compatible.ts';
import { LlmError, type LlmRequest } from './types.ts';

/** What the second host saw. Empty is the whole point of this file. */
interface Seen {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const open: Server[] = [];

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))));
  // Restored rather than deleted: this suite must leave the environment the
  // way it found it, whatever it found.
  if (ANTHROPIC_BASE_URL === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL;
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    open.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** The host the redirect points at. It records, and it must stay empty. */
async function decoy(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const url = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', headers: req.headers, body });
      // A plausible answer, so that a client which DOES follow gets a verdict
      // rather than a parse error: the test must fail on having arrived, not
      // on what it found when it did.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          message: { content: '{"ok":true}' },
        }),
      );
    });
  });
  return { url, seen };
}

/** The address the operator configured. It answers "ask over there". */
function redirector(to: string, status: number): Promise<string> {
  return listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { location: `${to}/stolen` });
      res.end();
    });
  });
}

const REQUEST: LlmRequest = {
  system: 'You audit code.',
  user: 'PROPRIETARY SOURCE CODE: app.get("/orders/:id", (req, res) => db.find(req.params.id))',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

/** Every status whose whole meaning is "ask somewhere else". */
const REDIRECTS = [301, 302, 303, 307, 308];

describe('a redirect never chooses the next address for a write', () => {
  for (const status of REDIRECTS) {
    it(`openai-compatible refuses a ${status} and the second host is never dialled`, async () => {
      const target = await decoy();
      const base = await redirector(target.url, status);
      const client = new OpenAiCompatibleClient({
        apiKey: 'sk-SECRET',
        model: 'm',
        baseUrl: base,
        providerName: 'openai',
        retry: { attempts: 1 },
      });

      await expect(client.complete(REQUEST)).rejects.toThrow(LlmError);
      expect(target.seen).toEqual([]);
    });

    it(`gemini refuses a ${status} and its api key is never delivered there`, async () => {
      const target = await decoy();
      const base = await redirector(target.url, status);
      const client = new GeminiClient({ apiKey: 'SECRET-gemini-key', model: 'm', baseUrl: base });

      await expect(client.complete(REQUEST)).rejects.toThrow(LlmError);
      expect(target.seen).toEqual([]);
    });

    it(`ollama refuses a ${status} and the analysed code is never replayed there`, async () => {
      const target = await decoy();
      const base = await redirector(target.url, status);
      const client = new OllamaClient({ model: 'm', baseUrl: base, retry: { attempts: 1 } });

      await expect(client.complete(REQUEST)).rejects.toThrow(LlmError);
      expect(target.seen).toEqual([]);
    });
  }

  /**
   * The fourth adapter, and the one with the most to lose.
   *
   * It does not call `fetch` itself — the Anthropic SDK does — so a sweep of
   * this directory's own call sites would have passed straight over it. It is
   * also the only one whose credential the specification does NOT protect:
   * `authorization` is stripped across an origin, `x-api-key` is delivered.
   * Measured on 22.22.2 against a real 307 before the fix: the SDK followed
   * it, the decoy received `x-api-key` and 82 bytes of body, and the call
   * returned a VERDICT — a scan reading an answer from a host nobody named.
   */
  for (const status of REDIRECTS) {
    it(`anthropic refuses a ${status}, key and code included`, async () => {
      const target = await decoy();
      const base = await redirector(target.url, status);
      // `ANTHROPIC_BASE_URL` is the real knob, and the reason this adapter is
      // exposed at all: the SDK reads it, so the endpoint is operator-chosen
      // exactly like the other three. No test-only option is added to reach it.
      process.env.ANTHROPIC_BASE_URL = base;
      const client = new AnthropicClient({
        apiKey: 'SECRET-anthropic-key',
        model: 'm',
        retry: { attempts: 1 },
        maxRetries: 0,
      });

      await expect(client.complete(REQUEST)).rejects.toThrow(LlmError);
      expect(target.seen).toEqual([]);
    });
  }

  it('the SDK does not re-word the refusal as a server it could not reach', async () => {
    // Without the cause unwrap this is `APIConnectionError: Connection error.`
    // mapped to "API Anthropic injoignable." — a sentence about a call that
    // never got an answer, printed over one that did.
    const target = await decoy();
    const base = await redirector(target.url, 307);
    process.env.ANTHROPIC_BASE_URL = base;
    const client = new AnthropicClient({
      apiKey: 'SECRET-anthropic-key',
      model: 'm',
      retry: { attempts: 1 },
      maxRetries: 0,
    });

    const error = await client.complete(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain(new URL(target.url).host);
    expect((error as LlmError).retryable).toBe(false);
  });

  it('says WHERE it was being sent, and does not offer to try again', async () => {
    const target = await decoy();
    const base = await redirector(target.url, 307);
    const client = new OpenAiCompatibleClient({
      apiKey: 'sk-SECRET',
      model: 'm',
      baseUrl: base,
      providerName: 'openai',
      retry: { attempts: 1 },
    });

    const error = await client.complete(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    const llm = error as LlmError;
    // The host is the actionable half: "it is sending your code to X" sends
    // somebody somewhere, "the call failed" does not.
    expect(llm.message).toContain(new URL(target.url).host);
    expect(llm.message).toContain('307');
    // Retrying re-asks the same endpoint and gets the same 3xx. Offering it
    // would spend a paid call to learn what is already known.
    expect(llm.retryable).toBe(false);
  });

  it('a 3xx that points NOWHERE is not dressed up as a redirect', async () => {
    // A sentence must not be reachable from a state it does not describe:
    // nothing was redirected anywhere, so the adapter reports the status it
    // actually got. Same rule the console's primitive states for this case.
    const base = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(302, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'moved, somewhere' } }));
      });
    });
    const client = new OpenAiCompatibleClient({
      apiKey: 'sk-SECRET',
      model: 'm',
      baseUrl: base,
      providerName: 'openai',
      retry: { attempts: 1 },
    });

    const error = await client.complete(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).not.toContain('redirect');
  });
});

describe('the happy path is untouched', () => {
  // Claims the other side on purpose, and passes BEFORE and after: a fix that
  // refuses a redirect by refusing every answer would pass every test above.
  it('a straight 200 still yields a verdict', async () => {
    const base = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          }),
        );
      });
    });
    const client = new OpenAiCompatibleClient({
      apiKey: 'sk-SECRET',
      model: 'm',
      baseUrl: base,
      providerName: 'openai',
      retry: { attempts: 1 },
    });

    const answer = await client.complete<{ ok: boolean }>(REQUEST);
    expect(answer.parsed.ok).toBe(true);
  });
});

/**
 * The behavioural tests above prove the three adapters that exist. This one
 * covers the fourth: the defect is per-CALL-SITE, and a run exercises the call
 * sites somebody remembered. `CLAUDE.md` records this rule being re-typed by
 * hand and forgotten on seven call sites out of eight in the console half — so
 * what closes the class is not a fourth careful read, it is an assertion that
 * nothing in this directory reaches the network on its own.
 */
describe('nothing in this directory dials out on its own', () => {
  const DIR = new URL('.', import.meta.url).pathname;

  /**
   * Comments and string literals are removed before the search.
   *
   * Both directions matter. A comment saying "we call fetch here" would be a
   * false positive; a comment is also where a real call could hide from a
   * plain grep. The corpus has to be the CODE, which is the same reason
   * `n8n-removed.test.ts` strips its own.
   */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  const adapters = readdirSync(DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'types.ts'
  );

  it('finds the adapters it is meant to be checking', () => {
    // A sweep over an empty list passes and proves nothing — the shape this
    // project has already paid for as a scan report that took green when
    // coverage was UNKNOWN.
    expect(adapters).toEqual(
      expect.arrayContaining(['openai-compatible.ts', 'gemini.ts', 'ollama.ts'])
    );
  });

  for (const file of adapters) {
    it(`${file} calls no bare fetch()`, () => {
      const body = code(readFileSync(join(DIR, file), 'utf8'));
      expect(body).not.toMatch(/(?<!No)(?<![A-Za-z])fetch\s*\(/);
    });
  }

  it('and the adapter that dials through an SDK hands it the guarded transport', () => {
    // The sweep above reads CALL SITES, and `anthropic.ts` has none: the SDK
    // owns the socket. So that file passes it for a reason that has nothing to
    // do with being safe, and a sweep which vouches for a file it cannot see
    // into is the defect this project keeps paying for. Named explicitly.
    const body = code(readFileSync(join(DIR, 'anthropic.ts'), 'utf8'));
    expect(body).toMatch(/fetch:\s*\([^)]*\)\s*=>\s*\n?\s*fetchNoRedirect\(/);
  });

  it('and the one call that remains is the guarded one', () => {
    // The other direction: without this, deleting the primitive outright would
    // satisfy every assertion above.
    const body = code(readFileSync(join(DIR, 'types.ts'), 'utf8'));
    expect(body.match(/(?<![A-Za-z])fetch\s*\(/g)).toHaveLength(1);
    expect(body).toContain("redirect");
  });
});
