/**
 * @vitest-environment jsdom
 */
/**
 * How many times a page load reads the console's most expensive endpoint.
 *
 * ============================================================================
 * WHAT WAS WRONG
 *
 * `GET /api/snapshot` is the triage queue, the metrics and the Tracking tab in
 * one object, and `snapshot.ts` puts a fifteen-second cache in front of it for
 * a reason its own header states: *"long enough that ten open tabs do not
 * hammer the database"*. `?force=1` deliberately walks past that cache — it is
 * for the Refresh button and the injection follow-up, which want the REAL
 * state rather than the last one known.
 *
 * Every page load asked for it. Measured in Chromium 1243 against a real
 * PostgreSQL 16 seeded by driving the six workflows through the engine:
 *
 *   120 runs (the default window)   2 requests, 10,804 B of duplicate wire
 *                                   bytes, and a 24-29 ms rebuild of a window
 *                                   the cache had just answered in 3 ms
 *   500 runs (the documented ceiling) 37,508 B duplicate, a 52 ms rebuild
 *
 * ============================================================================
 * WHERE IT CAME FROM, AND THE GENERAL LESSON
 *
 * One effect, written so that CHANGING LANGUAGE re-reads the snapshot (the
 * server writes the chain notes, the blocking findings and the sample set, so
 * retranslating the labels alone leaves the queue in the language you just
 * left). It carried `authed` in its dependency array to read it as a guard —
 * `if (authed !== false)` — and a guard in a dependency array is a TRIGGER.
 * `authed` goes from `null` to `true` once per page load, when the auth probe
 * answers, so the effect fired there every time.
 *
 * What was supposed to stop that was `useRef(true)` skipping the first run.
 * It is a RENDER COUNT, and the fact it wanted is *has the locale changed
 * since the last read* — so it spent its one skip on the render before the
 * auth probe answered, and the real first load then asked for a forced
 * rebuild.
 *
 * ============================================================================
 * WHAT THIS FILE CANNOT CLAIM, AND SAYS SO
 *
 * There is ONE locale in the catalogue, so the behaviour the effect exists for
 * cannot be driven from a test: `setLocale` has no second value to take. The
 * mechanism is therefore claimed STRUCTURALLY, and `LOCALES` is asserted to
 * still hold one entry — the day a second one arrives this file fails and asks
 * for a behavioural claim instead of going on vouching for a shape.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { App } from '../App.tsx';
import { api, ApiError } from '../lib/api.ts';
import { LOCALES } from '../i18n/dictionary.ts';

/**
 * The reads, in order, with the flag each one carried.
 *
 * The snapshot is REFUSED rather than faked: what is being counted is the
 * REQUESTS, and a hand-written window would be a fixture in the reader's
 * vocabulary. A rejection also exercises the shape that matters — `load`
 * catches it and the screen shows its banner, so nothing here depends on the
 * pipeline answering.
 */
function countReads(opts: { locked?: boolean } = {}) {
  const forced: boolean[] = [];
  vi.spyOn(api, 'authStatus').mockResolvedValue({
    enabled: opts.locked === true,
    password_set: opts.locked === true,
    authenticated: opts.locked !== true,
  });
  vi.spyOn(api, 'snapshot').mockImplementation(async (force = false) => {
    forced.push(force);
    throw new ApiError('No pipeline in this test.');
  });
  render(<App />);
  return forced;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a page load reads the snapshot once', () => {
  it('asks for it exactly once, and does not force a rebuild', async () => {
    const forced = countReads();
    // The banner is what says the load has happened and settled: asserting on
    // the count alone would pass before the first read had been made.
    await screen.findByText('No pipeline in this test.');
    // Give the auth probe's state change a chance to run its effects: that is
    // precisely where the second read came from.
    await waitFor(() => expect(forced.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 60));
    expect(forced).toEqual([false]);
  });
});

describe('signing in reads it once', () => {
  it('asks for it exactly once, forced, and not twice', async () => {
    const forced = countReads({ locked: true });
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    // A locked console reads nothing before the password: the lock's whole
    // point is that the queue is not answered.
    expect(forced).toEqual([]);

    vi.spyOn(api, 'login').mockResolvedValue({ ok: true });
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    await waitFor(() => expect(forced.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 60));
    // FORCED, and that is right: somebody has just signed in and the cache may
    // hold a window from before they could see it.
    expect(forced).toEqual([true]);
  });
});

describe('the boundaries, which hold before and after', () => {
  it('still forces a rebuild when the Refresh button is pressed', async () => {
    const forced = countReads();
    const user = userEvent.setup();
    await screen.findByText('No pipeline in this test.');
    await new Promise((r) => setTimeout(r, 60));
    const before = forced.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(forced.length).toBe(before + 1));
    expect(forced[forced.length - 1]).toBe(true);
  });

  it('reads nothing at all while the lock has not been answered', async () => {
    const forced = countReads({ locked: true });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await new Promise((r) => setTimeout(r, 80));
    expect(forced).toEqual([]);
  });
});

describe('the mechanism the effect exists for', () => {
  /**
   * Structural, and only because it cannot be behavioural: see the header.
   * A test asserting the two reads are gone would be satisfied by DELETING the
   * re-read, which would cost a future second locale the one thing that makes
   * the sentences the server writes follow the selector.
   */
  it('still re-reads the snapshot when the locale changes', () => {
    const src = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
      // This file's own prose quotes the code it hunts, and so does App.tsx's.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const effect = src.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[locale[^\]]*\]\);/);
    expect(effect, 'no effect in App.tsx depends on the locale any more').toBeTruthy();
    expect(effect![0]).toContain('load(true)');
  });

  it('asks to become a behavioural claim the day a second locale exists', () => {
    expect(
      LOCALES.length,
      'a second locale exists: drive it through the provider and assert the read, '
      + 'instead of asserting the shape of App.tsx',
    ).toBe(1);
  });
});
