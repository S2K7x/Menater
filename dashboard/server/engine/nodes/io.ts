/**
 * Nœuds qui touchent au monde extérieur.
 *
 * ============================================================================
 * CE QUI DISTINGUE CE FICHIER DU PRÉCÉDENT
 *
 * Les nœuds purs se rejouent librement. Ceux-ci, non : le moteur journalise
 * l'intention avant l'appel, et une reprise qui retrouve un appel `write` en
 * cours refuse de le relancer. Chaque gestionnaire écrit ici est donc appelé
 * AU PLUS UNE FOIS par étape — ce qui change la façon de les écrire :
 *
 *   - inutile d'implémenter une déduplication maison, le moteur s'en charge ;
 *   - en revanche, un gestionnaire ne doit JAMAIS faire deux appels modifiants
 *     en une seule étape. Le moteur ne peut pas savoir que le premier a abouti
 *     et pas le second. Un effet = un nœud.
 *
 * ============================================================================
 * LES SECRETS NE SONT PAS DANS LA DÉFINITION DU WORKFLOW
 *
 * Une définition est de la donnée : elle est lue, éditée dans l'interface,
 * versionnée, affichée. Y écrire une clé d'API l'exposerait à chacune de ces
 * étapes. Les nœuds désignent donc une CRÉDENTIALE par nom ; c'est le porteur
 * de secrets qui la résout au moment de l'appel.
 *
 * Même discipline que la console : « les secrets ne ressortent jamais du
 * serveur ». Un champ affiche « renseigné » ou « vide », jamais la valeur.
 * ============================================================================
 */

import { describeFetchError, fetchWithDeadline } from '../../http.ts';
import type { NodeHandler } from '../engine.ts';
import { resolve, type ValueRef } from '../values.ts';
import type { PureDeps } from './pure.ts';

/** Résout un secret par son nom. Ne le renvoie qu'au moment de l'appel. */
export type SecretResolver = (name: string) => string | undefined;

export interface IoDeps extends PureDeps {
  secret: SecretResolver;
  /** Injectable : les tests ne doivent jamais sortir sur le réseau. */
  fetch?: typeof globalThis.fetch;
  /** Exécute une requête paramétrée. `null` = pas de base configurée. */
  query?: (sql: string, params: unknown[]) => Promise<unknown[]>;
}

/**
 * `fetchWithDeadline`, with the cause of a failure named.
 *
 * ============================================================================
 * A CALL THAT REACHED NOBODY MUST NOT LAND ON A CARD AS "fetch failed"
 *
 * The engine records `(err as Error).message` as the step error, and the
 * console prints that string in the two places somebody reads while an
 * incident is open: the technical incident on the card, and the run's note in
 * the Tracking tab. Node's `fetch` rejects EVERY transport failure with the
 * same `TypeError: "fetch failed"` and puts the reason one level down in
 * `err.cause` — so a hostname with a typo in it, a chat service behind a
 * firewall, a switched-off ticket endpoint and an expired certificate all
 * arrived as those two words.
 *
 * `describeFetchError` already unwraps it for the three console screens (see
 * the traps table). These nodes are the fourth surface, and ROADMAP § 7 held
 * them back deliberately rather than by oversight: the wording of five call
 * sites inside the engine is its own pass, and this is it.
 *
 * `what` NAMES THE DESTINATION AND NEVER THE URL. A webhook URL is itself the
 * credential — anyone holding it can post into that channel — and a step error
 * is written to the run journal and printed on screen. So the two webhook
 * transports are named in words, and an operator-configured endpoint is quoted
 * by host alone, never by its path or its query.
 * ============================================================================
 */
async function reach(
  what: string,
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; fetchImpl: typeof globalThis.fetch },
): Promise<Response> {
  try {
    return await fetchWithDeadline(url, init, opts);
  } catch (err) {
    throw new Error(`Could not reach ${what}: ${describeFetchError(err)}`);
  }
}

/** The host alone. See `reach`: a configured endpoint may carry a token. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || 'that address';
  } catch {
    return 'that address';
  }
}

function scope(ctx: Parameters<NodeHandler>[0], deps: IoDeps) {
  return {
    input: ctx.input,
    outputs: ctx.outputs,
    vars: deps.vars(),
    ctx: {
      now: deps.now().toISOString(),
      runId: ctx.runId,
      alertId: ctx.alertId,
      workflowId: ctx.workflow.id,
    },
  };
}

/**
 * Appel HTTP.
 *
 * Classé `read` par le moteur, et c'est une simplification assumée : un POST
 * est une écriture. La règle du projet — un effet, un nœud — veut donc qu'un
 * appel modifiant soit porté par un nœud dédié, `slack` par exemple. Un `http`
 * en POST vers un endpoint de ticket reste rejouable ; c'est le prix de ne pas
 * inspecter le verbe pour deviner l'intention.
 */
export function makeHttp(deps: IoDeps): NodeHandler {
  const doFetch = deps.fetch ?? globalThis.fetch;

  return async (ctx) => {
    const p = ctx.node.params as {
      url: ValueRef;
      method?: string;
      body?: ValueRef;
      headers?: Record<string, string>;
      /** Nom de la crédentiale ; sa valeur n'est jamais dans la définition. */
      authHeader?: { header: string; secret: string; prefix?: string };
      timeoutMs?: number;
    };

    const s = scope(ctx, deps);
    const url = String(resolve(p.url, s));
    const method = p.method ?? 'GET';
    const headers: Record<string, string> = { ...(p.headers ?? {}) };

    if (p.authHeader) {
      const value = deps.secret(p.authHeader.secret);
      if (value === undefined) {
        // Partir sans l'en-tête produirait un 401 qu'on irait chercher chez le
        // fournisseur. Nommer la crédentiale absente économise ce détour.
        throw new Error(
          `Credential "${p.authHeader.secret}" is missing: the call is not attempted.`,
        );
      }
      headers[p.authHeader.header] = `${p.authHeader.prefix ?? ''}${value}`;
    }

    const body = p.body === undefined ? undefined : JSON.stringify(resolve(p.body, s));
    if (body !== undefined) headers['content-type'] ??= 'application/json';

    // An external call with NO deadline freezes the execution until the system
    // times out, several minutes later, saying nothing.
    const res = await reach(
      hostOf(url),
      url,
      { method, headers, body },
      { timeoutMs: p.timeoutMs ?? 10_000, fetchImpl: doFetch },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON answer is not an error: return it as-is rather than failing
      // a node whose call succeeded.
    }
    return {
      output: { status: res.status, ok: res.ok, body: parsed },
      port: res.ok ? 'main' : 'error',
    };
  };
}

/**
 * Requête SQL paramétrée.
 *
 * LES PARAMÈTRES NE SONT JAMAIS INTERPOLÉS DANS LE TEXTE. Le SQL est une
 * constante de la définition, les valeurs voyagent à part. C'est ce qui rend
 * une injection impossible même si un champ d'alerte contient du SQL — et une
 * alerte, par nature, contient du texte fourni par un attaquant.
 */
export function makePostgres(deps: IoDeps): NodeHandler {
  return async (ctx) => {
    const p = ctx.node.params as { sql: string; params?: ValueRef[] };
    if (typeof p.sql !== 'string') {
      throw new Error(`\u201c${ctx.node.id}\u201d: \u201csql\u201d must be a constant string.`);
    }
    if (!deps.query) {
      throw new Error(
        `No database configured: the query of \u201c${ctx.node.id}\u201d ` +
          `is not attempted. Set the coordinates in Settings \u2192 Database.`,
      );
    }
    const s = scope(ctx, deps);
    const values = (p.params ?? []).map((ref) => resolve(ref, s));
    return { output: { rows: await deps.query(p.sql, values) } };
  };
}

/**
 * Message Slack.
 *
 * Un nœud à part entière plutôt qu'un `http` : c'est ce qui le fait classer
 * `write`, donc « au plus une fois ». Poster deux fois une demande
 * d'approbation donnerait deux boutons pour la même décision.
 */
/**
 * Posting a chat notification, by any of the three transports on offer.
 *
 * ============================================================================
 * THREE TRANSPORTS, AND THREE DIFFERENT IDEAS OF "IT WORKED"
 *
 * This is the whole reason they cannot share one code path. Each says success
 * a different way, and reading one with another's rules turns a message nobody
 * received into a success — or the reverse:
 *
 *   SLACK BOT (`chat.postMessage`)  HTTP 200 with `{"ok": false, "error": …}`
 *                                   when it FAILED, so the status cannot decide
 *                                   it — but it is the only clue left when what
 *                                   answered is not the envelope at all.
 *   SLACK WEBHOOK                   HTTP 200 with the literal TEXT `ok`.
 *                                   `res.json()` throws on it.
 *   DISCORD WEBHOOK                 HTTP 204 with an EMPTY body. Both
 *                                   `res.json()` and a truthiness check on the
 *                                   body would call that a failure.
 *
 * The message being posted is usually the approval request, so getting this
 * wrong either leaves a run waiting for an answer to a question never asked,
 * or escalates an alert a human was in fact asked about.
 *
 * ============================================================================
 * THEY ALSO DO NOT SPEAK THE SAME PAYLOAD
 *
 * Slack takes `text` + Block Kit `blocks`. Discord takes `content` + `embeds`,
 * caps `content` at 2000 characters, and allows at most 10 embeds. The rich
 * form is built per transport in `buildApprovalRequest` from the SAME facts —
 * translating Block Kit into embeds at this layer would be a lossy converter
 * nobody could read.
 *
 * ============================================================================
 * WHAT IS SHARED
 *
 * The deadline, and the rule that a refusal must throw. Without a deadline, a
 * chat service that accepts the connection and never answers leaves the run
 * waiting for a human to answer a question that was never asked.
 * ============================================================================
 */

/** Discord refuses a `content` over 2000 characters with a 400. */
const DISCORD_CONTENT_MAX = 2000;

/**
 * What `chat.postMessage` answers with. Every field is optional because this
 * shape is a CLAIM about what came back, checked before it is believed: `ok`
 * being a boolean is what tells the Slack API's answer from an intermediary's.
 */
type SlackEnvelope = { ok?: boolean; error?: string; ts?: string };

export function makeNotify(deps: IoDeps): NodeHandler {
  const doFetch = deps.fetch ?? globalThis.fetch;

  return async (ctx) => {
    const p = ctx.node.params as {
      channel: ValueRef; text: ValueRef; blocks?: ValueRef; embeds?: ValueRef;
    };
    const s = scope(ctx, deps);
    const transport = String(deps.vars().get('notify.transport') ?? 'slack-bot');

    const text = String(resolve(p.text, s) ?? '');

    // ---------------------------------------------------------------- Discord
    if (transport === 'discord-webhook') {
      const url = deps.secret('discord.webhookUrl');
      if (url === undefined) {
        throw new Error(
          'Credential "discord.webhookUrl" is missing: nothing is posted. '
          + 'Set it, or change notify.transport.',
        );
      }
      const embeds = p.embeds ? resolve(p.embeds, s) : undefined;
      const body: Record<string, unknown> = {
        // CLIPPED, not sent and refused. A 400 on an over-long escalation
        // message would lose the notification entirely; a truncated one still
        // tells somebody to come and look.
        content: text.length > DISCORD_CONTENT_MAX
          ? `${text.slice(0, DISCORD_CONTENT_MAX - 1)}\u2026`
          : text,
      };
      if (Array.isArray(embeds) && embeds.length > 0) body.embeds = embeds.slice(0, 10);

      const res = await reach(
        'Discord',
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        { timeoutMs: 10_000, fetchImpl: doFetch },
      );

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        if (res.status === 429) {
          // Discord's `retry_after` is SECONDS as a float, in the JSON body as
          // well as the header. Naming the wait is what lets an operator tell a
          // rate limit from an outage; the engine's own retry does the waiting.
          throw new Error(`Discord rate-limited the webhook (429): ${detail || 'retry later'}`);
        }
        throw new Error(`Discord refused: ${detail || `HTTP ${res.status}`}`);
      }
      // 204 AND AN EMPTY BODY IS THE SUCCESS. There is nothing to read, and
      // nothing to thread or edit later either — hence `ts: null`.
      return { output: { ts: null, transport: 'discord-webhook' } };
    }

    const blocks = p.blocks ? resolve(p.blocks, s) : undefined;

    // ---------------------------------------------------------- Slack webhook
    if (transport === 'slack-webhook') {
      const url = deps.secret('slack.webhookUrl');
      if (url === undefined) {
        throw new Error(
          'Credential "slack.webhookUrl" is missing: nothing is posted. '
          + 'Set it, or change notify.transport.',
        );
      }
      // NO `channel` FIELD. Slack ignores it on an incoming webhook, and
      // sending one would suggest the four channel settings still apply.
      const body: Record<string, unknown> = { text };
      if (blocks) body.blocks = blocks;

      const res = await reach(
        'Slack',
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        { timeoutMs: 10_000, fetchImpl: doFetch },
      );
      // PLAIN TEXT, both ways. `res.json()` would throw on the literal `ok`
      // that means success.
      //
      // AND THE READ ITSELF CAN FAIL, which is the sibling of the guard on the
      // bot branch below. Unwrapped, a body the other end cut off surfaced here
      // as a bare `TypeError: terminated` — the "fetch failed" family this file
      // was fixed for, one line past where `reach` stops looking.
      let answer: string;
      try {
        answer = (await res.text()).trim();
      } catch (err) {
        throw new Error(
          `Slack answered HTTP ${res.status}, but its answer could not be read: `
          + describeFetchError(err),
        );
      }
      if (!res.ok) throw new Error(`Slack refused: ${answer || `HTTP ${res.status}`}`);
      return { output: { ts: null, transport: 'slack-webhook' } };
    }

    // -------------------------------------------------------------- Slack bot
    const token = deps.secret('slack.botToken');
    if (token === undefined) {
      throw new Error('Credential "slack.botToken" is missing: nothing is posted.');
    }
    const payload: Record<string, unknown> = { channel: resolve(p.channel, s), text };
    if (blocks) payload.blocks = blocks;

    const res = await reach(
      'Slack',
      'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 10_000, fetchImpl: doFetch },
    );
    // NOT `res.json()`, AND THE REASON IS THE SAME AS THE ONE BELOW.
    //
    // Everything that is not Slack's envelope — an HTML error page from a
    // gateway or a proxy in front of it, a captive portal's sign-in page, a
    // body-less 5xx — surfaced as whatever `JSON.parse` had to say about the
    // first ten bytes. Measured on Node 22: `Unexpected token '<', "<html><hea"
    // ... is not valid JSON`, and `Unexpected end of JSON input` — that second
    // one being the exact string the `llm` node was fixed for one branch over.
    // A sentence about JSON syntax, on the step that posts the approval
    // request, naming neither Slack, nor the status, nor the fact that a call
    // was made at all.
    //
    // `Slack refused: …` is true of an `ok: false` envelope and of nothing
    // else. Calling a gateway's 502 a refusal BY Slack sends somebody to check
    // a channel name and a bot scope over a network problem — so the envelope
    // is what decides, and the status is what is reported when it is absent.
    // A BODY THAT COULD NOT BE READ IS NOT AN EMPTY BODY, and the difference
    // is the whole point of the guard below it. `res.text()` rejects after the
    // status line is already in — a truncated chunked body, a connection the
    // other end drops mid-answer — and swallowing that into `''` makes the
    // sentence claim Slack's endpoint SENT nothing, over an event where we
    // never found out what it sent. Measured on Node 22: `TypeError:
    // terminated`, cause `other side closed`. Two different faults reported in
    // the same words send somebody looking for an intermediary that answered
    // empty, when the fault is a dropped connection — this node's own defect,
    // rebuilt one state further in.
    let raw: string | null = null;
    let unread = '';
    try {
      raw = (await res.text()).trim();
    } catch (err) {
      unread = describeFetchError(err);
    }
    if (raw === null) {
      throw new Error(
        `Slack answered HTTP ${res.status}, but its answer could not be read: ${unread}`,
      );
    }

    let body: SlackEnvelope | null = null;
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed !== null && typeof parsed === 'object') body = parsed as SlackEnvelope;
    } catch {
      // Not the envelope. Reported below, with the status — which is the clue.
    }

    if (body === null || typeof body.ok !== 'boolean') {
      // The body is the intermediary's own prose, so it is clipped like
      // Discord's above and never assumed to have a shape.
      throw new Error(
        `Slack's endpoint answered HTTP ${res.status}, but not with the Slack API's JSON`
        + (raw ? `: ${raw.slice(0, 300)}` : ' (empty body).'),
      );
    }
    if (!body.ok) {
      // The Slack API answers HTTP 200 with `ok: false`. Trusting the status
      // code would turn a failure into a success — an approval message never
      // posted, and a run waiting for an answer to a question never asked.
      throw new Error(`Slack refused: ${body.error ?? 'no reason given'}`);
    }
    return { output: { ts: body.ts, transport: 'slack-bot' } };
  };
}

/**
 * Appel au modèle, avec sortie structurée.
 *
 * Classé `read` : un appel au modèle ne modifie rien à l'extérieur. Il coûte,
 * ce qui est différent — et le rejouer après une interruption coûte deux fois
 * plutôt que de laisser une alerte sans décision.
 */
export function makeLlm(deps: IoDeps): NodeHandler {
  const doFetch = deps.fetch ?? globalThis.fetch;

  return async (ctx) => {
    const p = ctx.node.params as {
      model: ValueRef;
      prompt: ValueRef;
      /** Schéma attendu en retour. La réponse est REFUSÉE si elle n'y répond pas. */
      requiredKeys?: string[];
      timeoutMs?: number;
    };
    const key = deps.secret('openrouter.apiKey');
    if (key === undefined) {
      throw new Error('Credential "openrouter.apiKey" is missing: no call is attempted.');
    }

    const s = scope(ctx, deps);
    const res = await reach(
      'the model provider (openrouter.ai)',
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: resolve(p.model, s),
          messages: [{ role: 'user', content: String(resolve(p.prompt, s)) }],
          response_format: { type: 'json_object' },
        }),
      },
      { timeoutMs: p.timeoutMs ?? 60_000, fetchImpl: doFetch },
    );

    // A REFUSAL IS NOT AN EMPTY ANSWER, AND THIS NODE USED TO CONFLATE THEM.
    // The status was never looked at: a 401 on a wrong key, a 402 on an
    // exhausted account and a 429 all left `choices` undefined and fell
    // through to "The model answered with no content" — a cause that is not
    // missing but WRONG, which sends an operator to look at the model rather
    // than at their key. A wrong key is the likeliest misconfiguration there
    // is here, and this is the node the whole triage hangs on. A body-less
    // refusal was worse still: `res.json()` threw `Unexpected end of JSON
    // input`, naming neither the provider nor the status.
    //
    // The status is named because 401, 402 and 429 call for three different
    // actions. The body is the provider's own prose, so it is clipped like
    // Discord's above, and never assumed to have a shape.
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(
        `The model provider refused the request (HTTP ${res.status})`
        + (detail ? `: ${detail}` : '.'),
      );
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = body.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') throw new Error('The model answered with no content.');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('The model did not answer in JSON.');
    }

    // An incomplete decision is REFUSED, never completed. Inventing a missing
    // verdict is exactly "filling a gap with a default" — on the very data that
    // decides whether to isolate a machine.
    const missing = (p.requiredKeys ?? []).filter((k) => !(k in parsed));
    if (missing.length > 0) {
      throw new Error(`Incomplete decision: ${missing.join(', ')} missing.`);
    }

    return {
      output: {
        decision: parsed,
        usage: {
          input_tokens: body.usage?.prompt_tokens ?? null,
          output_tokens: body.usage?.completion_tokens ?? null,
        },
      },
    };
  };
}

export function ioHandlers(deps: IoDeps): Record<string, NodeHandler> {
  return {
    http: makeHttp(deps),
    postgres: makePostgres(deps),
    notify: makeNotify(deps),
    llm: makeLlm(deps),
  };
}
