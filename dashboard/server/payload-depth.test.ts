/**
 * How deep a payload may be nested before this console refuses to read it.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `normalize()` carried a header promising it *"never throws: a payload it
 * cannot read produces missing identity fields, which `validateAlertSchema`
 * turns into a named rejection"*, and it did `JSON.stringify(v)` on a mapped
 * field with no floor under the nesting. `JSON.stringify` is RECURSIVE in V8
 * and `JSON.parse` is not, so a body the parser accepts happily is one the
 * serialiser cannot survive — measured on Node 22.22.2, parse is still fine at
 * 200 000 levels while stringify gives up at 4 165.
 *
 * That asymmetry reached two doors, and it was worse at the second one:
 *
 *   - `POST /api/ingest/:source` — outside the console's access lock by
 *     design, because an appliance emitting an alert holds no browser session.
 *     A 117 kB body of `{"raw_log":[[[…]]]}`, comfortably inside the 256 kB
 *     cap because that cap is on BYTES, answered **500 `{"error":"Maximum
 *     call stack size exceeded"}`** to a caller holding no credential at all:
 *     a server-fault code for a sender fault, plus V8's internal message
 *     forwarded to whoever asked for it.
 *   - `pollSource()` — the other caller of `normalize`. There the throw
 *     escaped the function entirely, so the `fail()` path that records the
 *     error, backs the source off and shows it on the Ingestion tab never ran;
 *     it escaped `tick()` too, which the timer calls as `void this.tick()`.
 *     An unhandled rejection from a timer TERMINATES a Node 22 process. One
 *     over-deep item from a polled source takes the whole console down, on
 *     every interval.
 *
 * So the assertions are: the refusal is the SENDER'S fault and says so, it
 * names the cap rather than quoting V8, a legitimately-nested alert is
 * untouched — "lower it until nothing gets through" is the plausible wrong
 * fix — and the guard refuses on the way DOWN, because measuring the depth
 * first and comparing after overflows on exactly the input it exists to
 * refuse.
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-payload-depth-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is resolved once, at load.
const { handleRequest } = await import('./app.ts');
const { getConfig } = await import('./config.ts');
const { MAX_PAYLOAD_DEPTH, PayloadTooDeep, normalize, mappingFor } =
  await import('./engine/transforms/normalize.ts');
const { pollSource } = await import('./ingest/poller.ts');
const { defaultPolicy } = await import('./ingest/policy.ts');
const { resetCursorCache } = await import('./ingest/cursors.ts');
const { consoleDictionary } = await import('../src/i18n/console.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * A payload nested `depth` levels, AS TEXT.
 *
 * Built by repeating brackets rather than by nesting a value and calling
 * `JSON.stringify` on it — the test fixture cannot serialise this either, which
 * is the defect seen from the other side.
 */
function deepText(depth: number, inner = '1'): string {
  return '['.repeat(depth) + inner + ']'.repeat(depth);
}

/** The same thing as a live value, built iteratively for the same reason. */
function deepValue(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i += 1) v = [v];
  return v;
}

/**
 * A body whose measured nesting is EXACTLY `depth`, so the boundary tests
 * below say what they mean rather than doing arithmetic in the assertion.
 *
 * The body object is level 1, each bracket adds one, and the scalar inside the
 * innermost bracket adds one more.
 */
function bodyAtDepth(depth: number): string {
  const brackets = depth - 2;
  return `{"alert_id":"A1","vendor_blob":${'['.repeat(brackets)}1${']'.repeat(brackets)}}`;
}

/** Drives the real handler with a RAW body, since ours cannot be stringified. */
async function postRaw(url: string, raw: string, headers: Record<string, string> = {}) {
  const payload = Buffer.from(raw, 'utf8');
  const captured = { status: 0, body: '' };
  const req: any = {
    method: 'POST',
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    // Yielded in 64 kB chunks, like a socket delivers it.
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < payload.length; i += 65536) yield payload.subarray(i, i + 65536);
    },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) { if (chunk) captured.body = chunk.toString(); },
    setHeader() {},
  };
  await handleRequest(req, res);
  return captured;
}

beforeEach(() => {
  const c = getConfig();
  c.webhook.mode = 'on';
  c.webhook.secret = 'the-shared-secret';
  c.auth.enabled = false;
  resetCursorCache();
});

describe('the entry point, faced with a payload it cannot serialise', () => {
  it('answers 400 and names the cap, where it used to answer 500 with V8s message', async () => {
    const r = await postRaw(
      '/api/ingest/generic',
      `{"raw_log":${deepText(60_000)}}`,
      { 'x-soc-token': 'the-shared-secret' },
    );
    expect(r.status).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.reason).toBe('payload_too_deep');
    expect(body.detail).toContain(String(MAX_PAYLOAD_DEPTH));
    // The half that matters as much as the code: an internal message from the
    // engine's own runtime must not travel back to a sender.
    expect(r.body).not.toContain('Maximum call stack');
  });

  it('answers the same way with NO credential at all, rather than crashing', async () => {
    // This is the reachable case: `/api/ingest/*` sits outside the console
    // lock so that an appliance can post to it, and the 500 was reproduced
    // with no `x-soc-token` header at all.
    const r = await postRaw('/api/ingest/generic', `{"raw_log":${deepText(60_000)}}`);
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('Maximum call stack');
  });

  it('refuses the legacy path the same way', async () => {
    const r = await postRaw('/api/webhook/soc/alert', `{"raw_log":${deepText(60_000)}}`);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).reason).toBe('payload_too_deep');
  });

  it('refuses depth carried by an UNMAPPED key, which rides on in extensions', async () => {
    // A guard on the mapped fields alone would let this through, and the deep
    // value would then reach the engine, the run journal and the model prompt
    // — every one of which serialises it. `extensions` keeps what the table
    // did not read, WHOLE, which is exactly why the floor is on the payload.
    const r = await postRaw(
      '/api/ingest/generic',
      `{"alert_id":"A1","vendor_blob":${deepText(60_000)}}`,
      { 'x-soc-token': 'the-shared-secret' },
    );
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).reason).toBe('payload_too_deep');
  });

  it('leaves an alert AT the cap alone — the floor refuses nothing legitimate', async () => {
    // The plausible wrong fix is to lower the cap until nothing gets through.
    // At exactly the cap the payload is accepted, so it reaches the door's own
    // refusal: no token, therefore 401 and not 400.
    const r = await postRaw('/api/ingest/generic', bodyAtDepth(MAX_PAYLOAD_DEPTH));
    expect(r.status).toBe(401);
  });

  it('refuses at exactly one level past the cap, and not before', async () => {
    const r = await postRaw('/api/ingest/generic', bodyAtDepth(MAX_PAYLOAD_DEPTH + 1));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).reason).toBe('payload_too_deep');
  });

  it('still maps a realistic Wazuh alert, which is five levels deep', async () => {
    const wazuh = {
      id: '1758531242.884231',
      timestamp: '2026-09-22T09:14:02.123+0000',
      rule: {
        level: 10,
        description: 'sshd: brute force trying to get access',
        mitre: { id: ['T1110'], tactic: ['Credential Access'] },
      },
      agent: { name: 'web-01' },
      full_log: 'Failed password for root from 185.220.101.47',
      data: { srcip: '185.220.101.47' },
    };
    const mapping = mappingFor('wazuh');
    expect(mapping).not.toBeNull();
    const out = normalize(mapping!, wazuh);
    expect(out.alert_id).toBe('1758531242.884231');
    expect(out.rule_name).toBe('sshd: brute force trying to get access');
    expect(out.source_ip).toBe('185.220.101.47');
    expect(out.severity).toBe('high');
  });
});

describe('normalize', () => {
  it('refuses a payload past the cap with an error that CARRIES the cap', () => {
    const mapping = mappingFor('generic')!;
    try {
      normalize(mapping, { raw_log: deepValue(60_000) });
      throw new Error('normalize accepted a payload it cannot serialise');
    } catch (err) {
      expect(err).toBeInstanceOf(PayloadTooDeep);
      expect((err as InstanceType<typeof PayloadTooDeep>).limit).toBe(MAX_PAYLOAD_DEPTH);
    }
  });

  it('refuses BEFORE descending, so the guard survives its own input', () => {
    // The obvious way to write the check is to measure the depth and then
    // compare it — which walks the whole structure and overflows on exactly
    // the payload it exists to refuse, the defect rebuilt inside its own
    // repair. 200 000 levels is far past any stack; the answer must still be a
    // `PayloadTooDeep` and not a `RangeError`.
    //
    // Note what this does NOT claim. Measured by mutation: a RECURSIVE check
    // that compares on the way down is bounded too, at `limit` frames, and
    // passes this test. What fails it is measure-then-compare, in either form.
    const mapping = mappingFor('generic')!;
    expect(() => normalize(mapping, { raw_log: deepValue(200_000) }))
      .toThrowError(PayloadTooDeep);
  });

  it('accepts a payload exactly at the cap, and serialises the mapped field', () => {
    const mapping = mappingFor('generic')!;
    const out = normalize(mapping, { alert_id: 'A3', raw_log: deepValue(MAX_PAYLOAD_DEPTH - 2) });
    expect(out.alert_id).toBe('A3');
    expect(typeof out.raw_log).toBe('string');
  });
});

describe('the poller, faced with the same payload from a polled source', () => {
  const SOURCE = {
    source: 'generic',
    enabled: true,
    url: 'https://siem.example.com/alerts',
    cursorParam: 'since',
    authHeader: '',
    authCredential: '',
    itemsPath: '',
  };

  /** A `fetch` answering with raw text, because this body cannot be built any other way. */
  function stubText(text: string) {
    return vi.fn(async () => new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
  }

  const good = (id: string) => `{"alert_id":"${id}","rule_name":"r","severity":"low",`
    + `"timestamp":"2026-09-22T09:00:00Z","raw_log":"sshd: invalid user"}`;

  it('does not throw out of pollSource — the error path exists and must be reached', async () => {
    const delivered: string[] = [];
    const out = await pollSource(
      SOURCE as any,
      defaultPolicy(),
      {
        deliver: async (_s: string, a: Record<string, unknown>) => {
          delivered.push(String(a.alert_id));
          return 'run-1';
        },
        fetchImpl: stubText(`[{"alert_id":"X1","raw_log":${deepText(60_000)}}]`),
      } as any,
    );
    // Counted and shown, like any item the mapping could not turn into an
    // alert. Silently skipping it is how a source that changed its shape looks
    // like a source that went quiet.
    expect(out.unusable).toBe(1);
    expect(out.accepted).toBe(0);
    expect(delivered).toEqual([]);
  });

  it('and the sentence the tab prints no longer asserts a cause it cannot know', () => {
    // `unusable` had exactly one cause when it was worded, so the sentence
    // said "carried no alert id and could not be read". A refused payload has
    // an alert id often enough; leaving that wording would put a diagnosis
    // nobody made in front of an operator — the shape `readBodyOrNull` exists
    // to remove at the other door. It names both possibilities now.
    const sentence = consoleDictionary('en').ingestion.pull.unusable(1);
    expect(sentence).toMatch(/alert id/);
    expect(sentence).toMatch(/nest/i);
  });

  it('keeps delivering the OTHER items of the same batch', async () => {
    // One poisoned item must not cost the ninety-nine good ones: refusing the
    // whole batch replaces the alerts with nothing, which is the harsher half
    // of the same mistake.
    const delivered: string[] = [];
    const out = await pollSource(
      SOURCE as any,
      defaultPolicy(),
      {
        deliver: async (_s: string, a: Record<string, unknown>) => {
          delivered.push(String(a.alert_id));
          return 'run-1';
        },
        fetchImpl: stubText(
          `[${good('G1')},{"alert_id":"X1","raw_log":${deepText(60_000)}},${good('G2')}]`,
        ),
      } as any,
    );
    expect(delivered).toEqual(['G1', 'G2']);
    expect(out.accepted).toBe(2);
    expect(out.unusable).toBe(1);
  });
});
