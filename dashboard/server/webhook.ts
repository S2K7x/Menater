/**
 * The alert entry point.
 *
 * ============================================================================
 * WHAT THIS ENDPOINT MAKES POSSIBLE, AND WHAT IT MAKES DANGEROUS
 *
 * It is what connects the pipeline to real traffic, and — through a tunnel —
 * lets it receive alerts from outside the network.
 *
 * It is also the most sensitive door in the product: an alert is what triggers
 * a model's analysis, then an approval request, then potentially the isolation
 * of a machine. An open ingestion endpoint accepts alerts from anyone.
 *
 * ============================================================================
 * THREE GUARDS, AND NONE OF THEM IS OPTIONAL
 *
 *  1. CLOSED BY DEFAULT. `mode: 'off'` refuses everything. An ingestion door
 *     is not opened by accident.
 *
 *  2. NO SECRET, NO ENDPOINT. An empty secret CLOSES the endpoint instead of
 *     opening it to everyone. That is the opposite of the usual behaviour —
 *     "no authentication configured" reads far too often as "no authentication
 *     required".
 *
 *  3. CONSTANT-TIME COMPARISON. A `===` on a string stops at the first
 *     differing character, so the response time says how many characters were
 *     right and the secret is guessable one byte at a time. On an endpoint
 *     exposed to the Internet that is not theoretical.
 *
 * ============================================================================
 * THERE USED TO BE A THIRD MODE, AND IT WAS ABOUT n8n
 *
 * `shadow` relayed every alert to an n8n instance, returned ITS answer, and
 * replayed the alert through our engine beside it. It existed for one job:
 * migrating off n8n without a blind spot. With n8n gone the mode has no
 * meaning — and it had a sharp edge, since `shadow` on an install with no n8n
 * answered `502 upstream_unreachable` for every alert the engine had in fact
 * handled correctly.
 *
 * Two modes remain, and they answer the only question left: is the door open.
 * ============================================================================
 */

import { timingSafeEqual } from 'node:crypto';

import type { Engine } from './engine/engine.ts';

export type WebhookMode = 'off' | 'on';

export interface WebhookDeps {
  mode: WebhookMode;
  secret: string;
  /** The built-in engine. `null` while no database is configured. */
  engine: Engine | null;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

function secretMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // `timingSafeEqual` requires equal lengths: compare a fixed-size digest of
  // the length first so the length itself does not leak either.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function handleAlert(
  deps: WebhookDeps,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  /** Which source route received this, for the run's own record. */
  source = 'generic',
): Promise<WebhookResult> {
  if (deps.mode === 'off') {
    return {
      status: 503,
      body: {
        status: 'error',
        reason: 'webhook_disabled',
        detail:
          'The console entry point is closed. Open it in Settings → Ingestion, '
          + 'after setting a shared secret.',
      },
    };
  }

  // FAIL-CLOSED. A missing secret closes the endpoint instead of opening it.
  if (deps.secret === '') {
    return {
      status: 503,
      body: {
        status: 'error',
        reason: 'webhook_secret_missing',
        detail:
          'No shared secret is configured, so the entry point stays closed. An '
          + 'ingestion endpoint with no authentication accepts alerts from anyone, '
          + 'and an alert is what leads to isolating a machine.',
      },
    };
  }

  const raw = headers['x-soc-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (typeof token !== 'string' || !secretMatches(deps.secret, token)) {
    // No detail: saying "invalid secret" rather than "missing secret" tells an
    // attacker something about how this installation is configured.
    return { status: 401, body: { status: 'error', reason: 'unauthorized' } };
  }

  if (!deps.engine) {
    return {
      status: 503,
      body: {
        status: 'error',
        reason: 'engine_unavailable',
        detail: 'The engine is not started: no database is configured.',
      },
    };
  }

  const alertId = readAlertId(body);
  try {
    const run = await deps.engine.start('01-ingestion', { ...(body as object), source }, alertId);

    // THE ANSWER IS THE PIPELINE'S, NOT A BLANKET 202.
    //
    // `01-Ingestion` decides between 400 (invalid schema, naming the missing
    // fields), 200 (duplicate), 500 (deduplication unavailable) and 202
    // (accepted). Returning 202 regardless told the sender its alert had been
    // accepted when the pipeline had refused it — and the reason, which had
    // already been computed, never left the server.
    const decided = await deps.engine.responseOf(run.id);
    if (decided) {
      return {
        status: decided.status,
        body: {
          // The body the pipeline wrote, when it wrote one.
          ...(decided.body && typeof decided.body === 'object'
            ? (decided.body as Record<string, unknown>)
            : {}),
          alert_id: alertId,
          run_id: run.id,
          pipeline: 'console',
          // Which normalizer ran. Someone integrating a new source needs to see
          // it hit the mapping they meant, not merely that we said 202.
          source,
        },
      };
    }

    // No `respond` node was reached — the graph ended some other way. The run
    // exists and is inspectable, so we say accepted and name it rather than
    // inventing a status the pipeline never chose.
    return {
      status: 202,
      body: { status: 'accepted', alert_id: alertId, run_id: run.id, pipeline: 'console', source },
    };
  } catch (err) {
    return {
      status: 500,
      body: { status: 'error', reason: 'engine_failed', detail: (err as Error).message },
    };
  }
}

/** The alert id, when it is readable. `null` otherwise — never invented. */
export function readAlertId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>).alert_id;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
