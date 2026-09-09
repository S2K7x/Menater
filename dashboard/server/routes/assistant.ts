/**
 * The in-console assistant's two routes.
 *
 * ============================================================================
 * WHAT IS AND IS NOT DECIDED HERE
 *
 * This group validates the request, resolves the key and the model, and hands
 * off. It decides NOTHING about what the assistant may read — that is the
 * closed catalogue in `assistant/tools.ts` — and nothing about what it is
 * told — that is `assistant/prompt.ts`.
 *
 * Two things it does own:
 *
 *  1. THE REFUSAL IS NAMED. No key, assistant switched off, model rejected:
 *     each answers with the specific reason and where to fix it. "The
 *     assistant is unavailable" sends an operator looking at the wrong screen,
 *     which is the same defect the console spent § 9 removing everywhere else.
 *
 *  2. NOTHING IS PERSISTED. The transcript arrives with the request and leaves
 *     with the response. Storing threads would create a fourth copy of alert
 *     content, outside the audit chain, with no retention policy attached —
 *     and the value of doing so is a scrollback the browser already has.
 * ============================================================================
 */

import { json, readBody } from '../respond.ts';
import { getConfig } from '../config.ts';
import { describeCredentials } from '../credentials.ts';
import { AssistantError, chat, type ChatTurn } from '../assistant/chat.ts';
import { suggestions, type PageContext } from '../assistant/prompt.ts';
import { TOOLS } from '../assistant/tools.ts';
import { describeProviders, providerFor } from '../assistant/providers.ts';
import { mcpCatalogue } from '../assistant/mcp.ts';
import { saveConfig } from '../config.ts';
import { describeFetchError, fetchWithDeadline } from '../http.ts';
import { PORT } from '../env.ts';
import { randomBytes } from 'node:crypto';
import type { Ctx } from './context.ts';

/**
 * The key the assistant runs on, for the provider it is set to.
 *
 * Each provider names its own variable (`providers.ts`), and only OpenRouter
 * has a fallback: it is the provider the TRIAGE pipeline already uses, so an
 * installation with one OpenRouter account sets one key and everything works.
 * That fallback does not generalise — an Anthropic key is not an OpenRouter
 * key, and quietly trying one against the other produces a 401 that reads like
 * a typo rather than like a wrong provider.
 */
function assistantKey(providerId: string): { key: string; from: 'provider' | 'triage' } | null {
  const provider = providerFor(providerId);
  const own = process.env[provider.keyEnv];
  if (own) return { key: own, from: 'provider' };
  if (provider.id === 'openrouter') {
    const triage = process.env.OPENROUTER_APIKEY;
    if (triage) return { key: triage, from: 'triage' };
  }
  return null;
}

/** The page context, taken apart rather than trusted whole. */
function readPageContext(raw: unknown): PageContext {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const pick = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined;
  return {
    tab: pick(src.tab, 40),
    alert_id: pick(src.alert_id, 200),
    filter: pick(src.filter, 80),
  };
}

export async function assistantRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, locale } = c;

  /**
   * Readiness and starter prompts.
   *
   * The panel calls this before showing anything, so it can open on a reason
   * rather than on a chat box that fails at the first message.
   */
  if (req.method === 'GET' && path === '/api/assistant/state') {
    const cfg = getConfig();
    const provider = providerFor(cfg.assistant.provider);
    const key = assistantKey(cfg.assistant.provider);
    const cred = describeCredentials().find((x) => x.env === provider.keyEnv);
    const page = readPageContext({
      tab: c.url.searchParams.get('tab'),
      alert_id: c.url.searchParams.get('alert_id'),
    });
    return json(res, 200, {
      enabled: cfg.assistant.enabled,
      ready: cfg.assistant.enabled && key !== null,
      key_source: key?.from ?? null,
      key_locked: cred?.locked ?? false,
      provider: provider.id,
      provider_label: provider.label,
      // The model actually used, not the field's contents: an empty field means
      // "this provider's default", and showing an empty model would read as a
      // misconfiguration.
      model: cfg.assistant.model || provider.defaultModel,
      max_steps: cfg.assistant.maxSteps,
      suggestions: suggestions(page),
      // Shown in the Guide and in the panel's "what can it see?" line. The
      // list is the answer to the question every operator asks second.
      tools: TOOLS.map((t) => t.name),
      blocking: !cfg.assistant.enabled
        ? 'The assistant is switched off in Settings → Assistant.'
        : key === null
          // NAMES THE VARIABLE FOR THE CHOSEN PROVIDER. "No model key" was
          // accurate and useless the moment there were four of them.
          ? `No key for ${provider.label}. Set ${provider.keyEnv} in Settings → Credentials, `
            + 'or pick another provider in Settings → Assistant.'
          : null,
    });
  }

  /**
   * The provider catalogue, so Settings does not hard-code a list that lives
   * on the server. Same reason `/api/simulate/scenarios` exists.
   */
  if (req.method === 'GET' && path === '/api/assistant/providers') {
    return json(res, 200, { providers: describeProviders() });
  }

  /* --- MCP: status, token, self-test ------------------------------------ */

  /**
   * What the setup page needs to draw itself.
   *
   * The endpoint PATH travels, not a URL: the browser knows the address it
   * reached the console on, and the server does not. That is the same reasoning
   * as the Ingestion tab — a README that says `localhost` gets copied onto
   * another machine and then debugged for an hour.
   */
  if (req.method === 'GET' && path === '/api/assistant/mcp') {
    const cfg = getConfig();
    return json(res, 200, {
      enabled: cfg.assistant.mcpEnabled,
      token_set: cfg.assistant.mcpToken !== '',
      // Live when both are true. Either alone is a door that does not open.
      live: cfg.assistant.mcpEnabled && cfg.assistant.mcpToken !== '',
      path: '/api/mcp',
      ...mcpCatalogue(),
    });
  }

  /**
   * Generates the bearer token, and RETURNS IT ONCE.
   *
   * This is the single exception to "a secret never comes back out", and the
   * distinction is real: the rule forbids reading back a STORED secret, because
   * a tab left open or a browser cache would then hold it forever. A value
   * created in response to this exact click has not been stored anywhere the
   * caller could have read it, and there is no other way to make copy-paste
   * setup work — the alternative is telling someone to invent 32 random bytes
   * by hand, which ends in a token like "menater2024".
   *
   * It is never returned again: `GET /api/assistant/mcp` answers "set" or not.
   */
  if (req.method === 'POST' && path === '/api/assistant/mcp-token') {
    const token = randomBytes(32).toString('hex');
    saveConfig({ assistant: { mcpToken: token } });
    return json(res, 200, {
      token,
      shown_once:
        'This is the only time this token is shown. Copy it into your client now; if you lose it, '
        + 'generate a new one — which invalidates this one.',
    });
  }

  /**
   * Tests the endpoint the way a client reaches it: over the loopback socket,
   * with the stored token, through the real auth and Origin checks.
   *
   * It CANNOT be tested from the browser, and that is by design: the Origin
   * guard refuses browsers, because a page the operator visits must not be able
   * to tunnel into a local MCP server. So the console tests it from the inside,
   * and a green result here means a client outside will succeed too.
   */
  if (req.method === 'POST' && path === '/api/assistant/mcp-test') {
    const cfg = getConfig();
    if (!cfg.assistant.mcpEnabled || cfg.assistant.mcpToken === '') {
      return json(res, 200, {
        ok: false,
        detail: 'The endpoint is off, or has no token. Both are needed before it answers anything.',
      });
    }
    try {
      const probe = await fetchWithDeadline(
        `http://127.0.0.1:${PORT}/api/mcp`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cfg.assistant.mcpToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'menater-selftest', version: '1.0.0' },
            },
          }),
        },
        { timeoutMs: 5_000 },
      );
      const body = (await probe.json()) as any;
      if (!probe.ok || body?.error) {
        return json(res, 200, {
          ok: false,
          detail: `The endpoint answered ${probe.status}: ${body?.error?.message ?? body?.error ?? 'no reason given'}`,
        });
      }
      const cat = mcpCatalogue();
      return json(res, 200, {
        ok: true,
        detail:
          `Answered as "${body.result?.serverInfo?.name}" on protocol `
          + `${body.result?.protocolVersion}, offering ${cat.tools.length} tools, `
          + `${cat.prompts.length} prompts and ${cat.resources.length} resources — all read-only.`,
      });
    } catch (err) {
      // "Could not reach it: fetch failed" told the person installing an MCP
      // client nothing they did not already know. The cause is one level down.
      return json(res, 200, { ok: false, detail: `Could not reach it: ${describeFetchError(err)}` });
    }
  }

  if (req.method === 'POST' && path === '/api/assistant/chat') {
    const cfg = getConfig();
    if (!cfg.assistant.enabled) {
      return json(res, 409, {
        error: 'The assistant is switched off. Turn it on in Settings → Assistant.',
      });
    }
    const provider = providerFor(cfg.assistant.provider);
    const key = assistantKey(cfg.assistant.provider);
    if (!key) {
      return json(res, 409, {
        error:
          `The assistant has no key for ${provider.label}. Set ${provider.keyEnv} in `
          + 'Settings → Credentials, or pick another provider in Settings → Assistant.',
      });
    }

    const body = await readBody(req);
    const messages: ChatTurn[] = Array.isArray(body?.messages)
      ? body.messages
          .filter((m: unknown) => m && typeof m === 'object')
          .map((m: Record<string, unknown>) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: typeof m.content === 'string' ? m.content : '',
          }))
      : [];

    if (messages.length === 0 || messages[messages.length - 1].content.trim() === '') {
      return json(res, 400, { error: 'No message to answer.' });
    }

    try {
      const result = await chat({
        messages,
        page: readPageContext(body?.page),
        locale,
        apiKey: key.key,
        provider: provider.id,
        model: cfg.assistant.model,
        maxSteps: cfg.assistant.maxSteps,
      });
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof AssistantError) {
        return json(res, err.status, { error: err.message });
      }
      // 409 and not 502: the client replaces the body of a 502 with a generic
      // "the API is not responding", because on those the body usually comes
      // from the Vite proxy and is not JSON. Sending this sentence as a 502
      // would throw away the only part that says WHICH upstream failed.
      // …and "could not reach it" is the half of the sentence the reader
      // already has. `describeFetchError` supplies the other half; it leaves an
      // error that already explains itself untouched, so nothing is lost here
      // for the failures that are not transport failures.
      return json(res, 409, {
        error: `The assistant could not reach the model provider: ${describeFetchError(err)}`,
      });
    }
  }

  return false;
}
