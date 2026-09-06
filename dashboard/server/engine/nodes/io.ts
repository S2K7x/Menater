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

import { fetchWithDeadline } from '../../http.ts';
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
    const res = await fetchWithDeadline(
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
 *                                   when it FAILED. The status code is useless.
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

      const res = await fetchWithDeadline(
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

      const res = await fetchWithDeadline(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        { timeoutMs: 10_000, fetchImpl: doFetch },
      );
      // PLAIN TEXT, both ways. `res.json()` would throw on the literal `ok`
      // that means success.
      const answer = (await res.text()).trim();
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

    const res = await fetchWithDeadline(
      'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 10_000, fetchImpl: doFetch },
    );
    const body = (await res.json()) as { ok?: boolean; error?: string; ts?: string };
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
    const res = await fetchWithDeadline(
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
