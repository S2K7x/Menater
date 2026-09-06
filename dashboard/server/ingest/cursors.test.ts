/**
 * The cursor file: what it remembers, and what it is allowed to forget.
 *
 * ============================================================================
 * WHY THESE TESTS EXIST AT ALL
 *
 * Everything here is bookkeeping, and bookkeeping is where this product's worst
 * failures come from — a checkpoint moved one alert too far skips that alert
 * for good, silently, and looks identical to a quiet source.
 *
 * The write became debounced and asynchronous because a `writeFileSync` per
 * poll is synchronous I/O on the event loop, on a timer, forever. That trade is
 * only safe if the shutdown flush is UNCONDITIONAL — a flush that consults a
 * `dirty` flag loses exactly the last poll, which is the one that just cost
 * something. This project has already paid for that lesson once, in the
 * VulnPipe cache.
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

/**
 * A FRESH MODULE PER TEST, pointed at a throwaway directory.
 *
 * `CURSOR_PATH` is resolved once at import time, and the store keeps an
 * in-process cache. Importing once and clearing the cache would leave every
 * test writing to the same file — the developer's own, if `MENATER_CURSORS`
 * ever stopped being set in `vitest.config.ts`. Two locks, like the VulnPipe
 * cache: the config points somewhere that does not exist, and this points
 * somewhere disposable.
 */
async function freshStore(path: string) {
  process.env.MENATER_CURSORS = path;
  // `resetModules` rather than a query-string import: Vite refuses a dynamic
  // specifier it cannot analyse statically, and this is the supported way to
  // get a module whose top-level constants are recomputed.
  vi.resetModules();
  return import('./cursors.ts');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'menater-cursors-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.MENATER_CURSORS = '/nonexistent/menater-test-cursors.json';
});

describe('what a poll records', () => {
  it('counts consecutive failures, and clears them on any answer', async () => {
    const s = await freshStore(join(dir, 'c.json'));
    s.recordPoll('wazuh', { error: 'boom', received: 0, backoffMs: 1000 });
    s.recordPoll('wazuh', { error: 'boom', received: 0, backoffMs: 1000 });
    expect(s.readCursor('wazuh').failures).toBe(2);

    // AN EMPTY POLL IS AN ANSWER. The source is talking to us again; keeping
    // it in backoff would punish it for a fault it has recovered from.
    s.recordPoll('wazuh', { error: null, received: 0 });
    expect(s.readCursor('wazuh').failures).toBe(0);
    expect(s.readCursor('wazuh').nextAttemptAt).toBeNull();
  });

  it('does not treat a failed poll as having heard from the source', async () => {
    const s = await freshStore(join(dir, 'c.json'));
    s.recordPoll('wazuh', { error: null, received: 1, since: '2026-09-04T10:00:00Z' });
    const heardAt = s.readCursor('wazuh').lastPollAt;

    s.recordPoll('wazuh', { error: 'refused', received: 0, backoffMs: 1000 });
    // Otherwise "last answer: 3 s ago" sits next to an endpoint that has been
    // refusing us for an hour.
    expect(s.readCursor('wazuh').lastPollAt).toBe(heardAt);
    expect(s.readCursor('wazuh').since).toBe('2026-09-04T10:00:00Z');
  });

  it('keeps the checkpoint when a poll passes no new one', async () => {
    const s = await freshStore(join(dir, 'c.json'));
    s.recordPoll('wazuh', { error: null, received: 1, since: '2026-09-04T10:00:00Z' });
    s.recordPoll('wazuh', { error: null, received: 0 });
    // The rule the whole module is written around: nothing delivered, nothing
    // moved.
    expect(s.readCursor('wazuh').since).toBe('2026-09-04T10:00:00Z');
  });
});

describe('persistence', () => {
  it('does not write synchronously on every poll', async () => {
    const path = join(dir, 'c.json');
    const s = await freshStore(path);
    s.recordPoll('wazuh', { error: null, received: 1, since: '2026-09-04T10:00:00Z' });
    // Debounced: nothing on disk yet, and the event loop was not blocked.
    expect(existsSync(path)).toBe(false);
  });

  it('writes what it is holding when asked to flush, whatever the bookkeeping says', async () => {
    const path = join(dir, 'c.json');
    const s = await freshStore(path);
    s.recordPoll('wazuh', { error: null, received: 3, since: '2026-09-04T10:00:00Z' });
    await s.flushCursors();

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.wazuh.since).toBe('2026-09-04T10:00:00Z');
    expect(written.wazuh.received).toBe(3);
  });

  it('flushes even when nothing looks pending — the guarantee is not conditional', async () => {
    const path = join(dir, 'c.json');
    const s = await freshStore(path);
    s.recordPoll('wazuh', { error: null, received: 1 });
    await s.flushCursors();
    // A second flush with no new work must still produce a correct file rather
    // than skipping on a `dirty` flag.
    await s.flushCursors();
    expect(JSON.parse(readFileSync(path, 'utf8')).wazuh.received).toBe(1);
  });

  it('starts from scratch on a corrupt file rather than refusing to poll', async () => {
    const path = join(dir, 'c.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{ not json');
    const s = await freshStore(path);
    // Losing a cursor costs one overlap window, which dedup absorbs. Refusing
    // to start costs every alert from here on.
    expect(s.readCursor('wazuh').since).toBeNull();
  });
});
