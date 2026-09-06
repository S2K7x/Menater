/**
 * The agent loop.
 *
 * ============================================================================
 * A LOOP CALLING A PAID API NEEDS THREE CAPS, NOT ONE
 *
 * The shape is standard — call the model, run whatever tools it asked for, feed
 * the results back, repeat — and the interesting part is entirely in when it
 * stops:
 *
 *   - MAX STEPS bounds the reasoning. Without it a model that keeps asking for
 *     one more lookup runs until something else breaks.
 *   - MAX TOOL CALLS bounds the fan-out INSIDE a step. A model may request
 *     several tools per turn, so a step cap alone still allows a burst.
 *   - A WALL-CLOCK DEADLINE bounds the whole request, because the two caps
 *     above count events, and a slow upstream produces neither.
 *
 * When a cap fires while the model is still asking for tools, the loop makes
 * ONE more call with `tool_choice: 'none'`. Without that the run ends on a
 * half-finished tool call and the operator sees an empty bubble: the request
 * succeeded, the screen says nothing. A capped answer must still be an answer,
 * and it says it was capped.
 *
 * ============================================================================
 * WHY THIS IS NOT MCP
 *
 * MCP is the right protocol for exposing this catalogue to consumers OUTSIDE
 * the console — Claude Desktop, an editor, another agent — and X8 does exactly
 * that over the same `TOOLS`. It is the wrong transport for this loop: the
 * data and the code are in the same process, and MCP would add a JSON-RPC
 * negotiation and a hop (measured at 300–800 ms) to every turn of a chat panel
 * whose whole value is that it answers quickly. One catalogue, two surfaces.
 * ============================================================================
 */

import { fetchWithDeadline } from '../http.ts';
import { newFence } from './sanitize.ts';
import { runTool, toolSpecs } from './tools.ts';
import { stableSystemPrompt, volatileSystemPrompt, type PageContext } from './prompt.ts';
import { providerFor, type Provider, type Turn } from './providers.ts';
import type { Locale } from '../i18n.ts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  messages: ChatTurn[];
  page: PageContext;
  locale: Locale;
  apiKey: string;
  model: string;
  maxSteps: number;
  /**
   * Which provider the key belongs to. Everything that differs between
   * OpenRouter, Anthropic, OpenAI and Gemini lives in `providers.ts`; the loop
   * below is the same for all four, which is the point.
   */
  provider?: string;
  /** Injectable transport: a test must never reach the network. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  /** Injected so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** One tool call, as the panel shows it. */
export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface ChatResult {
  reply: string;
  tools: ToolTrace[];
  steps: number;
  /** Set when a cap ended the run. The panel says so rather than hiding it. */
  capped: 'steps' | 'tool_calls' | 'deadline' | null;
  usage: { input_tokens: number | null; output_tokens: number | null };
}

/** Per-request budget. Small on purpose: this answers questions, it does not investigate. */
const MAX_TOOL_CALLS = 12;
const DEADLINE_MS = 90_000;
const PER_CALL_TIMEOUT_MS = 45_000;

/**
 * The transcript the browser sends is bounded here, not trusted.
 *
 * A client that keeps appending turns would grow the context — and the bill —
 * without limit, and the body cap in `respond.ts` is a blunt instrument that
 * would reject the request outright rather than answering with what fits.
 */
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 8_000;

export class AssistantError extends Error {
  // Explicit field, NOT a parameter property: the service runs under
  // `node --experimental-strip-types`, which refuses that syntax at startup.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const fence = newFence();
  const ctx = { locale: opts.locale, fence };

  const history = opts.messages
    .slice(-MAX_HISTORY_TURNS)
    .filter((m) => typeof m.content === 'string' && m.content.trim() !== '')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }));

  // Anthropic and Gemini REFUSE a transcript that opens on an assistant turn.
  // A browser that replays a thread starting with a greeting would therefore
  // get a 400 naming neither the cause nor the fix, so the leading assistant
  // turns are dropped here rather than sent.
  while (history.length > 0 && history[0].role === 'assistant') history.shift();

  if (history.length === 0) throw new AssistantError('No message to answer.', 400);

  const provider: Provider = providerFor(opts.provider);
  const turns: Turn[] = [
    // Two system turns, and the order is the optimisation: the first is
    // byte-identical on every request and carries the cache breakpoint, the
    // second holds the nonce that must NOT be. See `prompt.ts`.
    { role: 'system', text: stableSystemPrompt(), cacheable: true },
    { role: 'system', text: volatileSystemPrompt(fence, opts.page) },
    ...history.map((m) =>
      m.role === 'user'
        ? ({ role: 'user', text: m.content } as Turn)
        : ({ role: 'assistant', text: m.content, calls: [] } as Turn),
    ),
  ];

  const tools: ToolTrace[] = [];
  /** Per-request memo: the same lookup, asked twice, is answered once. */
  const lookups = new Map<string, unknown>();
  let inputTokens = 0;
  let outputTokens = 0;
  let capped: ChatResult['capped'] = null;
  let steps = 0;

  while (true) {
    const outOfSteps = steps >= opts.maxSteps;
    const outOfTime = now() - startedAt > DEADLINE_MS;
    const outOfCalls = tools.length >= MAX_TOOL_CALLS;
    // The final turn: no tools offered, so the model has to answer in words.
    const finalTurn = outOfSteps || outOfTime || outOfCalls;
    if (finalTurn && capped === null) {
      capped = outOfTime ? 'deadline' : outOfSteps ? 'steps' : 'tool_calls';
    }

    const request = provider.build({
      model: opts.model || provider.defaultModel,
      turns,
      tools: toolSpecs(),
      offerTools: !finalTurn,
      apiKey: opts.apiKey,
    });

    const res = await callWithRetry(request, {
      doFetch,
      now,
      startedAt,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AssistantError(describeUpstream(res.status, detail), statusFor(res.status));
    }

    const answer = provider.parse(await res.json());
    // 409, not 502, for the same reason as above: the client replaces a 502
    // body with a generic sentence, and this one carries the provider's own
    // explanation — the most useful thing we have. Some providers answer 200
    // with the failure in the body, which is why this is checked after `res.ok`.
    if (answer.error) throw new AssistantError(answer.error, 409);

    inputTokens += answer.inputTokens;
    outputTokens += answer.outputTokens;
    steps += 1;

    const calls = answer.calls;
    if (calls.length === 0 || finalTurn) {
      const reply = (answer.text ?? '').trim();
      return {
        reply: reply || 'I could not produce an answer for that. Try rephrasing the question.',
        tools,
        steps,
        capped,
        usage: {
          input_tokens: inputTokens || null,
          output_tokens: outputTokens || null,
        },
      };
    }

    // The assistant turn goes back verbatim, tool calls included: dropping it
    // would leave the tool results replying to a question the transcript no
    // longer contains, and the next turn then repeats the same calls.
    turns.push({ role: 'assistant', text: answer.text, calls });

    /**
     * EVERY TOOL AT ONCE, and the catalogue is what makes that safe.
     *
     * A model routinely asks for three lookups in one turn. Run in sequence
     * they cost the sum of their latencies for no reason: the catalogue is
     * READ-ONLY and closed, so no two calls can affect each other and the
     * order of execution cannot change any result. That property is asserted
     * in `assistant.test.ts`, not assumed here.
     */
    const results = await Promise.all(
      calls.map(async (call) => {
        let args: Record<string, unknown> = {};
        try {
          args = call.argsJson ? (JSON.parse(call.argsJson) as Record<string, unknown>) : {};
        } catch {
          // Reported TO THE MODEL rather than thrown: it can call again with a
          // valid object, which is a better outcome than a failed request.
          return {
            call,
            args,
            result: {
              error: 'Arguments were not valid JSON. Call the tool again with a valid object.',
            },
          };
        }

        // A model that asks the same question twice in one run — common when it
        // re-checks itself — gets the first answer back rather than a second
        // pass over the snapshot.
        const key = `${call.name}:${stableKey(args)}`;
        const memo = lookups.get(key);
        const result = memo ?? (await runTool(call.name, args, ctx));
        if (!memo) lookups.set(key, result);
        return { call, args, result };
      }),
    );

    for (const { call, args, result } of results) {
      const ok = !(result && typeof result === 'object' && 'error' in (result as object));
      tools.push({ name: call.name, args, ok });
      turns.push({ role: 'tool', callId: call.id, name: call.name, result: capResult(result) });
    }
  }
}

/**
 * What OUR caller should be told, given what the provider answered.
 *
 * TWO CODES ARE POISONED AND MUST NOT BE REUSED HERE, and both were found by
 * pressing the button rather than by reading the code:
 *
 *   - 401 IS THE CONSOLE'S OWN LOCK. `lib/api.ts` turns any 401 into
 *     `AuthRequiredError`, which means "your session expired, log in again".
 *     Forwarding OpenRouter's 401 therefore answered a refused MODEL key with
 *     "Authentication required." — the operator goes to the login screen, and
 *     the actual problem, a key in Settings, is never mentioned. Exactly the
 *     "sent to the wrong screen" failure this feature exists not to commit.
 *   - 502/503/504 ARE THE VITE PROXY'S. The client replaces their body with a
 *     generic "the API is not responding", because on those the body is not
 *     JSON. A carefully named message sent as a 502 arrives as that generic
 *     sentence.
 *
 * So everything the OPERATOR can fix — wrong key, no credit, rate limit,
 * unknown model — leaves as a 409, whose body the client shows verbatim. 502
 * is kept for the case where the generic sentence is in fact the truth: we did
 * not get an answer at all.
 */
function statusFor(upstream: number): number {
  return [400, 401, 402, 403, 404, 429].includes(upstream) ? 409 : 502;
}

/* -------------------------------------------------------------------------
 * Retrying, bounding, and keying — the three helpers the loop leans on
 * ---------------------------------------------------------------------- */

/**
 * Which upstream failures are worth trying again.
 *
 * TRANSIENT ONLY, and the list is short on purpose. 429 is a quota this key
 * exceeded; 529 is Anthropic's cluster at capacity, which typically clears in
 * under two minutes; 5xx is the provider failing. A 400 is a request we built
 * wrong and a 401 is a key that will be just as refused in two seconds — both
 * would burn the operator's wall clock to arrive at the same sentence.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

/** Attempts after the first. Three is the usual advice for server errors. */
const MAX_ATTEMPTS = 3;

/**
 * One model call, retried on transient failure.
 *
 * `Retry-After` WINS over the backoff when the provider sends it: the provider
 * knows when capacity returns and guessing is strictly worse. Otherwise
 * exponential with full jitter — a fixed schedule makes several consoles retry
 * in lockstep and rebuild the burst that caused the 429.
 *
 * Every wait is checked against the REQUEST's deadline, not just its own: a
 * retry that would land after the operator's answer is due buys nothing, and
 * the caps in the loop above count events, which a sleeping request does not
 * produce.
 */
async function callWithRetry(
  request: { url: string; headers: Record<string, string>; body: unknown },
  deps: {
    doFetch: typeof globalThis.fetch;
    now: () => number;
    startedAt: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<Response> {
  let last: Response | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const res = await fetchWithDeadline(
      request.url,
      { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) },
      { timeoutMs: PER_CALL_TIMEOUT_MS, fetchImpl: deps.doFetch },
    );
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    last = res;

    if (attempt === MAX_ATTEMPTS - 1) break;

    const advertised = Number(res.headers?.get?.('retry-after') ?? '');
    const wait = Number.isFinite(advertised) && advertised > 0
      ? Math.min(advertised * 1000, 10_000)
      : Math.random() * Math.min(8_000, 500 * 2 ** attempt);

    const spent = deps.now() - deps.startedAt;
    if (spent + wait > DEADLINE_MS) break;
    await deps.sleep(wait);
  }

  return last as Response;
}

/**
 * The size of ONE tool result, bounded.
 *
 * `sanitize.ts` caps individual untrusted FIELDS; nothing capped the whole
 * object. `get_alert` on a case with full enrichment, or `list_alerts` at its
 * limit, can serialise to tens of kilobytes — and a model asking for three of
 * them in one turn pushes the operator's actual question out of the context
 * window. That failure is silent: the answer comes back fluent and about the
 * wrong thing.
 *
 * The truncation SAYS SO, in the payload, so the model reports a partial
 * reading instead of presenting it as complete.
 */
const MAX_RESULT_CHARS = 12_000;

function capResult(result: unknown): unknown {
  const json = JSON.stringify(result ?? null);
  if (json.length <= MAX_RESULT_CHARS) return result;
  return {
    truncated: true,
    note:
      `This result was ${json.length} characters and was cut to ${MAX_RESULT_CHARS}. `
      + 'Say that your reading of it is partial, and ask a narrower question if you need the rest.',
    partial_json: json.slice(0, MAX_RESULT_CHARS),
  };
}

/**
 * A stable key for a set of arguments.
 *
 * `JSON.stringify` alone is not stable: `{a:1,b:2}` and `{b:2,a:1}` are the
 * same call and would miss each other in the memo. Sorting the keys costs
 * nothing on objects this small.
 */
function stableKey(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]),
  );
}

/** Upstream failures, named. */
function describeUpstream(status: number, detail: string): string {
  const trimmed = detail.slice(0, 300);
  if (status === 401 || status === 403) {
    return 'The model provider refused the assistant key. Check it in Settings → Assistant.';
  }
  if (status === 402) {
    return 'The account behind the assistant key has no credit left.';
  }
  if (status === 429) {
    return 'The provider is rate-limiting this key. Wait a moment, or use a different model.';
  }
  if (status === 404) {
    return 'That model does not exist on this provider. Check the model name in Settings → Assistant.';
  }
  return `The model provider answered ${status}. ${trimmed}`;
}
