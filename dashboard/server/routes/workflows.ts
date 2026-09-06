/**
 * The pipeline as it runs: definitions, variables, log sources.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import { invalidate } from '../snapshot.ts';
import { messages } from '../i18n.ts';
import { PIPELINE_WORKFLOWS } from '../engine/workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from '../engine/workflows/routing.ts';
import { NODE_EFFECTS } from '../engine/types.ts';
import { MAPPINGS } from '../engine/transforms/normalize.ts';
import {
  getConfig, saveConfig } from '../config.ts';
import { PORT } from '../env.ts';
import type { Ctx } from './context.ts';

export async function workflowsRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, locale } = c;

    /**
     * The six workflows, exactly as the engine runs them.
     *
     * The definition is returned AS IS: it is what the Workflow tab draws, and
     * it is the same one that executes. A view that recomposed the graph could
     * drift from what actually runs — which is precisely what the console
     * lived through with the n8n editor.
     */
    if (req.method === 'GET' && path === '/api/workflows') {
      const all = [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS];
      return json(res, 200, {
        workflows: all.map((wf) => ({
          ...wf,
          // Each node's effect travels with it: that is what lets the
          // interface flag at a glance what touches the outside world, without
          // duplicating the effects table on the client side.
          nodes: wf.nodes.map((n) => ({ ...n, effect: NODE_EFFECTS[n.type] })) })),
        variables: getConfig().variables });
    }

    /**
     * Changing the pipeline variables.
     *
     * THE SERVER'S THIRD WRITE, and it is bounded: only keys that ALREADY
     * exist are accepted. A key invented from the browser would be read by no
     * workflow — it would give the illusion of a setting having been applied,
     * which is worse than no setting at all.
     */
    if (req.method === 'PUT' && path === '/api/workflows/variables') {
      const body = await readBody(req);
      const current = getConfig().variables;
      const patch = (body ?? {}) as Record<string, unknown>;

      const unknown = Object.keys(patch).filter((k) => !(k in current));
      if (unknown.length > 0) {
        return json(res, 400, {
          error: messages(locale).variables.unknownKeys(unknown.join(', ')) });
      }

      const next: Record<string, string | number | boolean> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        // The EXISTING value's type is authoritative. Accepting "30" where a
        // number is expected would fail the node at run time, far from here.
        const shape = typeof current[key];
        if (shape === 'number') {
          const n = Number(value);
          if (!Number.isFinite(n)) {
            return json(res, 400, { error: messages(locale).variables.notANumber(key, String(value)) });
          }
          next[key] = n;
        } else if (shape === 'boolean') {
          next[key] = value === true || value === 'true';
        } else {
          next[key] = String(value ?? '');
        }
      }

      saveConfig({ variables: next });
      invalidate();
      return json(res, 200, { variables: getConfig().variables });
    }

    /**
     * The alert entry point.
     *
     * Deliberately PLACED BEFORE the console's access lock: an appliance
     * emitting an alert has no session, it has a shared secret. Folding it
     * into the human lock would make one of the two useless.
     */
    /**
     * The sources this console can normalize, and how to point each at it.
     *
     * Served rather than documented: the URL and the path are things the
     * console already knows, and an operator retyping them from a README is
     * an operator debugging a typo. Same reasoning as `composeSnippet`.
     *
     * The shared secret is NEVER included — the snippet says where to paste
     * it. Secrets do not leave the server, and a setup guide is no exception.
     */
    if (req.method === 'GET' && path === '/api/ingest/sources') {
      // The address the operator reached us on IS the address their source
      // must use. Guessing it from config would hand out `localhost` to a
      // manager on another machine.
      const host = String(req.headers.host ?? `localhost:${PORT}`);
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
      const baseUrl = `${proto}://${host}`;

      return json(res, 200, {
        base_url: baseUrl,
        secret_set: getConfig().webhook.secret !== '',
        mode: getConfig().webhook.mode,
        sources: MAPPINGS.map((m) => ({
          source: m.source,
          label: m.label,
          endpoint: `${baseUrl}/api/ingest/${m.source}`,
          fields: Object.fromEntries(
            Object.entries(m.fields).map(([k, v]) => [k, v.join(' ?? ')]),
          ),
          setup: m.setup ? m.setup(baseUrl) : null })) });
    }


  return false;
}
