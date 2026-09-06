/**
 * The one poller this process runs, and the door the pulled alerts go through.
 *
 * ============================================================================
 * A PULLED ALERT AND A PUSHED ALERT ARE THE SAME ALERT
 *
 * `deliver` below starts `01-Ingestion` with exactly the payload the webhook
 * handler starts it with. That is the whole point of putting collection in a
 * transport layer: there is one pipeline, one set of guardrails, one audit
 * chain, and the transport is a fact about how the alert arrived — recorded on
 * the run, never a second code path through the product.
 *
 * The one thing it does NOT reuse is the shared secret. That secret answers
 * "is this sender allowed to hand us an alert"; on the pull side there is no
 * sender — we chose the address, we made the call. Requiring a token we would
 * have to hand ourselves would be theatre.
 * ============================================================================
 */

import { getConfig } from '../config.ts';
import { getEngine } from '../runtime.ts';
import { invalidate } from '../snapshot.ts';
import { Poller } from './poller.ts';

let poller: Poller | null = null;

export function getPoller(): Poller {
  if (!poller) {
    poller = new Poller(() => getConfig().ingestion, {
      deliver: async (source, alert) => {
        const engine = getEngine();
        // No engine means no database. We refuse rather than swallow: the
        // cursor then does not advance past this alert, so it is re-read once
        // a database is configured instead of being lost to a window that
        // already passed.
        if (!engine) throw new Error('no engine: no database is configured.');
        const run = await engine.start(
          '01-ingestion',
          { ...alert, source, transport: 'pull' },
          typeof alert.alert_id === 'string' ? alert.alert_id : null,
        );
        // An alert received changes what the console must show.
        invalidate();
        return run.id;
      },
    });
  }
  return poller;
}

/** Called at boot and after every settings save. Idempotent. */
export function syncPoller(): void {
  getPoller().sync();
}

export function stopPoller(): void {
  poller?.stop();
}
