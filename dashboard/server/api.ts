/**
 * MENATER console — process entry point.
 *
 * This file does one thing: put the request surface defined in `app.ts` on a
 * socket, and say clearly what happened if it cannot.
 *
 * WHY THE SPLIT
 *
 * The server used to be built at module top level, next to the thirty route
 * branches it serves. Importing the module therefore started listening, so the
 * routes that decide authentication, settings, tuning rules and alert
 * ingestion could not be exercised by a test without opening a port. The
 * handler now lives in `app.ts` as an ordinary function; what remains here is
 * the part that genuinely belongs to a process — the port, the startup
 * banner, and the two handlers that keep a failure from being silent.
 */

import { createServer } from 'node:http';

import { handleRequest } from './app.ts';
import { PORT, UI_ROOT } from './env.ts';
import { getConfig } from './config.ts';
import { applyCredentialStore } from './credentials.ts';
import { hasBuiltUi } from './static.ts';
import { getPoller, stopPoller, syncPoller } from './ingest/runtime.ts';
import { flushCursors } from './ingest/cursors.ts';

const server = createServer(handleRequest);

// The server itself can fail to start (port already taken). Without this
// handler Node would print a raw stack trace and exit with code 1, saying
// nothing about what to do.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[menater] port ${PORT} is already in use. Stop the other instance, or set MENATER_API_PORT.`);
  } else {
    console.error('[menater] cannot start:', err.message);
  }
  process.exit(1);
});

// A promise rejected outside the handler must not bring the server down: the
// console would stay unreachable until someone restarted it by hand.
process.on('unhandledRejection', (reason) => {
  console.error('[menater] unhandled promise rejection:', reason);
});

// Credentials stored by the console, applied to this process BEFORE the first
// request. `secretFor()` reads `process.env`, so without this the store would
// be written and never read, and every alert would keep taking the fallback.
const restoredCredentials = applyCredentialStore();

/**
 * An orderly stop writes the cursors it is holding.
 *
 * The cursor write is debounced — see `ingest/cursors.ts` — so a container
 * stopped within half a second of a poll would otherwise lose that poll's
 * checkpoint and re-read its window on the next start. That costs a dedup
 * lookup rather than an alert, which is why the write is debounced at all;
 * paying it on every `docker compose restart` is still avoidable, and the
 * flush is UNCONDITIONAL so it cannot be defeated by bookkeeping.
 *
 * Registered ONCE for both signals, and it never blocks the exit for long: a
 * shutdown that hangs on a disk is worse than a re-read window.
 */
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    stopPoller();
    void flushCursors().finally(() => process.exit(0));
  });
}

server.listen(PORT, () => {
  const c = getConfig();
  const db = c.database;
  const mode = db.host && db.database
    ? `engine on ${db.host}:${db.port}/${db.database}`
    : 'DEMONSTRATION MODE (no database configured)';
  console.log(
    hasBuiltUi(UI_ROOT)
      ? `[menater] Interface served from ${UI_ROOT}`
      : `[menater] Interface not built: Vite serves it in development`,
  );
  console.log(`[menater] API on http://localhost:${PORT} — ${mode}`);
  if (c.auth.enabled) console.log('[menater] access lock enabled');
  if (restoredCredentials.length > 0) {
    console.log(`[menater] pipeline credentials from the store: ${restoredCredentials.join(', ')}`);
  }
  // The one that decides whether the pipeline can decide at all. Saying it at
  // startup beats discovering it alert by alert in a fallback verdict.
  if (!process.env.OPENROUTER_APIKEY) {
    console.warn(
      '[menater] no OPENROUTER_APIKEY: every alert will take the fail-safe '
      + 'verdict (needs_human, confidence 0). Set it in Settings, or in .env.',
    );
  }

  // N5 — the pull transport, if this install asked for one. `syncPoller` is
  // idempotent and does nothing when polling is off or has no enabled source,
  // so a push-only install pays one function call for it.
  syncPoller();
  const ing = c.ingestion;
  console.log(
    `[menater] ingestion: ${ing.delivery}`
    + (ing.delivery === 'hybrid' ? ` (push: ${ing.fastLane.join(', ')})` : '')
    + (getPoller().running()
      ? ` — polling every ${ing.pull.intervalSeconds}s`
      : ''),
  );
});
