/**
 * The model providers the assistant can run on.
 *
 * ============================================================================
 * WHY AN ADAPTER AND NOT FOUR COPIES OF THE LOOP
 *
 * The loop in `chat.ts` is the part with the caps, the fencing and the
 * guarantee that a capped run still produces a sentence. None of that is
 * provider-specific, and none of it should be written four times — the fourth
 * copy is where the deadline gets forgotten.
 *
 * So the loop speaks ONE internal transcript, and each provider translates it
 * both ways. Everything genuinely different lives here:
 *
 *   - OpenRouter and OpenAI share a wire format (`/chat/completions`,
 *     `tool_calls`), and differ only in host and default model.
 *   - Anthropic puts the system prompt at the TOP LEVEL, not in the message
 *     list, requires `max_tokens`, and returns tool calls as `tool_use`
 *     content blocks whose results go back as a USER turn.
 *   - Gemini calls the roles `user` and `model`, wraps everything in `parts`,
 *     and its function declarations reject JSON-Schema keywords it does not
 *     know — `additionalProperties` included, which every one of our tools
 *     sets.
 *
 * ============================================================================
 * ONE KEY PER PROVIDER, AND THE STORE STAYS A CLOSED LIST
 *
 * Each provider names the environment variable it reads. Those names are added
 * to `MANAGED_CREDENTIALS`, which is a closed list for a reason: accepting an
 * arbitrary name would turn the settings endpoint into a way to inject any
 * variable into the process. Adding a provider therefore means adding its name
 * in both places, deliberately.
 *
 * ============================================================================
 * WHAT IS NOT HERE: CLAUDE OAUTH
 *
 * Signing in with a Claude subscription is not an API-key swap. It needs a
 * registered OAuth client, a redirect the console does not have, and a refresh
 * loop for tokens that expire — and a consumer subscription is not licensed as
 * a server-side API for a third-party application. An `anthropic.apiKey` from
 * the Anthropic Console is the supported path, and it is the one implemented.
 * ============================================================================
 */

/** One turn of the loop's own transcript. Providers translate, never the loop. */
export type Turn =
  /**
   * `cacheable` marks the INVARIANT half of the system prompt. Providers put
   * their cache breakpoint at the end of it: everything before is byte-identical
   * across requests and can be reused, everything after — the fence nonce, the
   * page context — cannot. See `prompt.ts` for why that split exists.
   */
  | { role: 'system'; text: string; cacheable?: boolean }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string | null; calls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: unknown };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON as the provider sent it. Parsed by the loop, which reports bad JSON to the model. */
  argsJson: string;
}

/** A tool, in the neutral shape both `tools.ts` and every provider understand. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ProviderReply {
  text: string | null;
  calls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  /** A provider that answers 200 with an error object in the body. */
  error: string | null;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** The credential this provider reads. Must also be in `MANAGED_CREDENTIALS`. */
  keyEnv: string;
  defaultModel: string;
  /** Where an operator goes to get a key. Shown in Settings. */
  keyUrl: string;
  /** Example model names, shown under the model field. */
  modelHint: string;
  build: (input: {
    model: string;
    turns: Turn[];
    tools: ToolSpec[];
    /** `false` on the final turn: no tools offered, so the model must answer in words. */
    offerTools: boolean;
    apiKey: string;
  }) => ProviderRequest;
  parse: (payload: any) => ProviderReply;
}

export type ProviderId = 'openrouter' | 'anthropic' | 'openai' | 'google';

/**
 * How many tokens a single answer may be.
 *
 * Anthropic REQUIRES this field and fails the request without it; the others
 * accept it. Set once, here, rather than left to each adapter to remember —
 * a missing `max_tokens` is a 400 that reads like a key problem.
 */
const MAX_OUTPUT_TOKENS = 2_000;

/* -------------------------------------------------------------------------
 * OpenAI-compatible: OpenRouter and OpenAI itself
 * ---------------------------------------------------------------------- */

function openAiCompatible(
  id: ProviderId,
  label: string,
  url: string,
  keyEnv: string,
  defaultModel: string,
  keyUrl: string,
  modelHint: string,
  opts: {
    extraHeaders?: Record<string, string>;
    /**
     * OpenAI renamed the field, and the new models REFUSE the old name:
     * "Unsupported parameter: 'max_tokens' is not supported with this model.
     * Use 'max_completion_tokens' instead." Since the default model here is a
     * GPT-5, sending `max_tokens` failed every request on the first call.
     * OpenRouter still normalises `max_tokens`, so the two differ.
     */
    tokenField?: 'max_tokens' | 'max_completion_tokens';
    /**
     * Anthropic-style per-block `cache_control`. OpenRouter forwards it to the
     * providers that need it explicitly (Anthropic, Gemini) and ignores it for
     * the rest. OpenAI itself REJECTS the field — its caching is automatic on
     * a stable prefix — so this is off for the direct OpenAI endpoint.
     */
    explicitCache?: boolean;
  } = {},
): Provider {
  const { extraHeaders = {}, tokenField = 'max_tokens', explicitCache = false } = opts;
  return {
    id,
    label,
    keyEnv,
    defaultModel,
    keyUrl,
    modelHint,
    build({ model, turns, tools, offerTools, apiKey }) {
      const messages = turns.map((t) => {
        if (t.role === 'tool') {
          return { role: 'tool', tool_call_id: t.callId, content: JSON.stringify(t.result) };
        }
        if (t.role === 'assistant') {
          return {
            role: 'assistant',
            content: t.text,
            ...(t.calls.length > 0
              ? {
                  tool_calls: t.calls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: c.argsJson },
                  })),
                }
              : {}),
          };
        }
        if (t.role === 'system' && t.cacheable && explicitCache) {
          // The breakpoint: everything up to and including this block is the
          // stable prefix. As a plain string it would be cached by prefix
          // heuristics only; as a marked block it is cached explicitly.
          return {
            role: 'system',
            content: [{ type: 'text', text: t.text, cache_control: { type: 'ephemeral' } }],
          };
        }
        return { role: t.role, content: t.text };
      });

      const body: Record<string, unknown> = { model, messages, [tokenField]: MAX_OUTPUT_TOKENS };
      if (offerTools) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      }
      return {
        url,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body,
      };
    },
    parse(payload) {
      const message = payload?.choices?.[0]?.message;
      return {
        text: typeof message?.content === 'string' ? message.content : null,
        calls: (message?.tool_calls ?? []).map((c: any) => ({
          id: String(c.id),
          name: String(c.function?.name ?? ''),
          argsJson: String(c.function?.arguments ?? '{}'),
        })),
        inputTokens: Number(payload?.usage?.prompt_tokens ?? 0),
        outputTokens: Number(payload?.usage?.completion_tokens ?? 0),
        error: payload?.error?.message ?? null,
      };
    },
  };
}

/* -------------------------------------------------------------------------
 * Anthropic
 * ---------------------------------------------------------------------- */

const anthropic: Provider = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  keyEnv: 'ANTHROPIC_APIKEY',
  defaultModel: 'claude-sonnet-4-5',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  modelHint: 'claude-sonnet-4-5, claude-opus-4-1, claude-haiku-4-5',
  build({ model, turns, tools, offerTools, apiKey }) {
    // The system prompt is a TOP-LEVEL field here, not a message. Sent as a
    // `system` role in the list it is either rejected or silently demoted to
    // an ordinary user turn — which is the whole fencing contract gone.
    //
    // Sent as BLOCKS rather than one string, so the invariant half can carry a
    // cache breakpoint. Anthropic hashes tools → system → messages, so a
    // breakpoint at the end of the stable system block caches the tool schemas
    // too — the largest fixed cost in the request.
    const system = turns
      .filter((t) => t.role === 'system')
      .map((t) => {
        const block: Record<string, unknown> = { type: 'text', text: (t as any).text };
        if ((t as any).cacheable) block.cache_control = { type: 'ephemeral' };
        return block;
      });

    const messages: any[] = [];
    for (const t of turns) {
      if (t.role === 'system') continue;
      if (t.role === 'user') {
        messages.push({ role: 'user', content: [{ type: 'text', text: t.text }] });
        continue;
      }
      if (t.role === 'assistant') {
        const content: any[] = [];
        if (t.text) content.push({ type: 'text', text: t.text });
        for (const c of t.calls) {
          content.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: safeParse(c.argsJson),
          });
        }
        messages.push({ role: 'assistant', content });
        continue;
      }
      // A tool RESULT is a user turn here, and consecutive results must be
      // merged into ONE turn: two user turns in a row are rejected.
      const block = {
        type: 'tool_result',
        tool_use_id: t.callId,
        content: JSON.stringify(t.result),
      };
      const last = messages[messages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
    }

    const body: Record<string, unknown> = {
      model,
      system,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (offerTools) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      body.tool_choice = { type: 'auto' };
    }
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    };
  },
  parse(payload) {
    const blocks: any[] = payload?.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return {
      text: text === '' ? null : text,
      calls: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: String(b.id),
          name: String(b.name),
          argsJson: JSON.stringify(b.input ?? {}),
        })),
      inputTokens: Number(payload?.usage?.input_tokens ?? 0),
      outputTokens: Number(payload?.usage?.output_tokens ?? 0),
      error: payload?.error?.message ?? null,
    };
  },
};

/* -------------------------------------------------------------------------
 * Google Gemini
 * ---------------------------------------------------------------------- */

/**
 * Gemini's function declarations take an OpenAPI schema SUBSET.
 *
 * `additionalProperties` is not in it, and every one of our tools sets it
 * — deliberately, so an over-eager model cannot invent a parameter. Sent as-is
 * the whole request is rejected, so it is stripped here rather than removed
 * from the catalogue: the other three providers enforce it, and losing it
 * everywhere to satisfy one would be the wrong trade.
 */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue;
    out[key] = geminiSchema(value);
  }
  return out;
}

const google: Provider = {
  id: 'google',
  label: 'Google (Gemini)',
  keyEnv: 'GEMINI_APIKEY',
  defaultModel: 'gemini-2.5-flash',
  keyUrl: 'https://aistudio.google.com/apikey',
  modelHint: 'gemini-2.5-flash, gemini-2.5-pro',
  build({ model, turns, tools, offerTools, apiKey }) {
    // Gemini caches implicitly on a stable prefix, so there is no breakpoint to
    // place — the split still pays, because the invariant half now sits first
    // and byte-identical instead of being broken by the nonce.
    const system = turns.filter((t) => t.role === 'system').map((t) => (t as any).text).join('\n\n');

    const contents: any[] = [];
    for (const t of turns) {
      if (t.role === 'system') continue;
      if (t.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: t.text }] });
        continue;
      }
      if (t.role === 'assistant') {
        const parts: any[] = [];
        if (t.text) parts.push({ text: t.text });
        for (const c of t.calls) {
          parts.push({ functionCall: { name: c.name, args: safeParse(c.argsJson) } });
        }
        // The model turn is called `model`, not `assistant`.
        contents.push({ role: 'model', parts });
        continue;
      }
      // Function responses are user parts, merged into one turn like Anthropic's.
      const part = { functionResponse: { name: t.name, response: { result: t.result } } };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts[0]?.functionResponse) {
        last.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
    }

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
    if (offerTools) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: geminiSchema(t.parameters),
          })),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    return {
      // The model is in the PATH here, not in the body.
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body,
    };
  },
  parse(payload) {
    const parts: any[] = payload?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    return {
      text: text === '' ? null : text,
      // Gemini gives function calls NO identifier. The loop needs one to pair a
      // result with its call, so it is synthesised from the position — stable
      // within a turn, which is all the pairing needs.
      calls: parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          id: `gemini-${i}-${String(p.functionCall.name)}`,
          name: String(p.functionCall.name),
          argsJson: JSON.stringify(p.functionCall.args ?? {}),
        })),
      inputTokens: Number(payload?.usageMetadata?.promptTokenCount ?? 0),
      outputTokens: Number(payload?.usageMetadata?.candidatesTokenCount ?? 0),
      error: payload?.error?.message ?? null,
    };
  },
};

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: openAiCompatible(
    'openrouter',
    'OpenRouter (any model)',
    'https://openrouter.ai/api/v1/chat/completions',
    'ASSISTANT_APIKEY',
    'anthropic/claude-sonnet-4.5',
    'https://openrouter.ai/keys',
    'anthropic/claude-sonnet-4.5, openai/gpt-5, google/gemini-2.5-pro',
    {
      // Attribution only. It is how a shared key's usage can be told apart later.
      extraHeaders: { 'x-title': 'MENATER console assistant' },
      explicitCache: true,
    },
  ),
  anthropic,
  openai: openAiCompatible(
    'openai',
    'OpenAI (GPT)',
    'https://api.openai.com/v1/chat/completions',
    'OPENAI_APIKEY',
    'gpt-5',
    'https://platform.openai.com/api-keys',
    'gpt-5, gpt-5-mini, gpt-4.1',
    { tokenField: 'max_completion_tokens' },
  ),
  google,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/**
 * The provider a configured id names, or OpenRouter.
 *
 * The fallback is not a shrug: an unknown id in `config.json` — a hand edit, a
 * downgrade — must not take the assistant down, and OpenRouter is the one that
 * reaches every model. The Settings field is a closed list, so this only ever
 * fires on a file nobody typed through the interface.
 */
export function providerFor(id: unknown): Provider {
  return PROVIDERS[id as ProviderId] ?? PROVIDERS.openrouter;
}

/** What the browser needs to draw the Settings section. No secrets. */
export function describeProviders() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return {
      id: p.id,
      label: p.label,
      key_env: p.keyEnv,
      default_model: p.defaultModel,
      key_url: p.keyUrl,
      model_hint: p.modelHint,
    };
  });
}
