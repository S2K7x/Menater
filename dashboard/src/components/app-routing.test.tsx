/**
 * @vitest-environment jsdom
 */
/**
 * C1.1 — the screen you are on, in the address bar.
 *
 * ============================================================================
 * WHAT IS BEING CLAIMED
 *
 * Three things, and the third is the one that is easy to get wrong:
 *
 *   1. A LINK OPENS A SCREEN. `#/health` opens Health, on a cold load and
 *      through the lock.
 *   2. BACK AND FORWARD WORK. They are the browser's own controls, so a
 *      console that ignores them teaches people not to press them.
 *   3. THE ADDRESS BAR NEVER LIES, AND NEVER FILLS UP. A fragment this
 *      version cannot read is corrected rather than obeyed, and a correction
 *      REPLACES where a navigation PUSHES — measured in Chromium 1194 and in
 *      jsdom alike, `pushState` with an identical URL still adds an entry, so
 *      a writer that does not compare makes Back a no-op somebody has to
 *      press twice.
 *
 * ============================================================================
 * WHY jsdom CAN VOUCH FOR THIS, WHICH IS NOT THE USUAL ANSWER
 *
 * This file drives `history.back()` and `history.forward()`, not a
 * hand-dispatched `popstate`. That is only honest because the two were
 * measured against each other first, nine steps each, and jsdom 27 agreed
 * with Chromium 1194 on every one: which events fire for `pushState` (none),
 * for `location.hash =` (popstate then hashchange), for Back (popstate, plus
 * hashchange only when the string differs), and that an identical `pushState`
 * still grows `history.length`. A fake cannot vouch for an option the fake
 * does not implement — this one implements them.
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { App } from '../App.tsx';
import { api, ApiError } from '../lib/api.ts';

/**
 * The console with no pipeline behind it.
 *
 * The snapshot is REFUSED rather than faked: a hand-written window would be a
 * fixture in the reader's vocabulary, and nothing this file asserts needs one
 * — the tab bar is rendered whatever the pipeline answers, which is the point
 * of asserting on it.
 */
function mountConsole(opts: { locked?: boolean } = {}) {
  vi.spyOn(api, 'authStatus').mockResolvedValue({
    enabled: opts.locked === true,
    password_set: opts.locked === true,
    authenticated: opts.locked !== true,
  });
  vi.spyOn(api, 'snapshot').mockRejectedValue(new ApiError('No pipeline in this test.'));
  return render(<App />);
}

/** The label of the tab the nav says is current. */
function current(): string {
  const el = document.querySelector('.soc-tab[aria-current="page"]');
  return el?.textContent?.trim() ?? '(none)';
}

/** Walk the browser's own history, and let React settle after it. */
async function navigate(step: 'back' | 'forward') {
  await act(async () => {
    window.history[step]();
    await new Promise((r) => setTimeout(r, 40));
  });
}

beforeEach(() => {
  // One jsdom window serves the whole file, so the URL is reset rather than
  // assumed. `history.length` is NOT reset — it cannot be — which is why
  // every assertion about it below is a delta.
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a link opens a screen', () => {
  it('opens the tab its fragment names', async () => {
    window.history.replaceState(null, '', '#/health');
    mountConsole();
    await waitFor(() => expect(current()).toBe('Health'));
  });

  it('opens the Guide on #/guide, content and all', async () => {
    window.history.replaceState(null, '', '#/guide');
    mountConsole();
    await waitFor(() => expect(current()).toBe('Guide'));
    // The Guide reads no API, so this is the one deep link whose CONTENT can
    // be asserted without inventing a pipeline.
    expect(screen.getByRole('heading', { level: 1, name: 'How it works' })).toBeTruthy();
  });

  it('mounts the code analysis on #/code, which is loaded on demand', async () => {
    window.history.replaceState(null, '', '#/code');
    mountConsole();
    await waitFor(() => expect(current()).toBe('Code'));
    // The page head is rendered outside the lazy boundary: its presence is
    // what says the tab was MOUNTED and not merely marked current.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Code analysis' })).toBeTruthy());
  });

  it('survives the lock: the fragment is still honoured after signing in', async () => {
    window.history.replaceState(null, '', '#/health');
    mountConsole({ locked: true });
    const login = vi.spyOn(api, 'login').mockResolvedValue({ ok: true } as never);
    const field = await screen.findByLabelText(/password/i);
    await userEvent.type(field, 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in|unlock|enter/i }));
    expect(login).toHaveBeenCalled();
    await waitFor(() => expect(current()).toBe('Health'));
  });
});

describe('the address bar says what is on screen', () => {
  it('names the default tab on a visit with no fragment, without adding an entry', async () => {
    const before = window.history.length;
    mountConsole();
    await waitFor(() => expect(window.location.hash).toBe('#/alerts'));
    expect(current()).toBe('Alerts');
    expect(window.history.length).toBe(before);
  });

  it('corrects a fragment it cannot read rather than obeying it', async () => {
    window.history.replaceState(null, '', '#/nonsense');
    const before = window.history.length;
    mountConsole();
    await waitFor(() => expect(window.location.hash).toBe('#/alerts'));
    expect(current()).toBe('Alerts');
    expect(window.history.length).toBe(before);
  });

  it('corrects the spelling of a fragment it can read', async () => {
    window.history.replaceState(null, '', '#/HEALTH/');
    const before = window.history.length;
    mountConsole();
    await waitFor(() => expect(current()).toBe('Health'));
    expect(window.location.hash).toBe('#/health');
    expect(window.history.length).toBe(before);
  });
});

describe('the browser’s own controls', () => {
  it('pushes one entry per tab change, and none for the tab already open', async () => {
    mountConsole();
    await waitFor(() => expect(window.location.hash).toBe('#/alerts'));
    const before = window.history.length;

    await userEvent.click(screen.getByRole('button', { name: /^Metrics$/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/metrics'));
    expect(window.history.length).toBe(before + 1);

    // The measured trap: `pushState` with the same URL adds an entry, so this
    // is what keeps Back from needing two presses.
    await userEvent.click(screen.getByRole('button', { name: /^Metrics$/ }));
    expect(window.location.hash).toBe('#/metrics');
    expect(window.history.length).toBe(before + 1);
  });

  it('goes back to the previous tab and forward again', async () => {
    mountConsole();
    await waitFor(() => expect(current()).toBe('Alerts'));

    await userEvent.click(screen.getByRole('button', { name: /^Tracking$/ }));
    await waitFor(() => expect(current()).toBe('Tracking'));
    await userEvent.click(screen.getByRole('button', { name: /^Rules$/ }));
    await waitFor(() => expect(current()).toBe('Rules'));

    await navigate('back');
    await waitFor(() => expect(current()).toBe('Tracking'));
    expect(window.location.hash).toBe('#/tracking');

    await navigate('back');
    await waitFor(() => expect(current()).toBe('Alerts'));

    await navigate('forward');
    await waitFor(() => expect(current()).toBe('Tracking'));
  });

  it('mounts the code analysis when Back is what opens it', async () => {
    mountConsole();
    await waitFor(() => expect(current()).toBe('Alerts'));
    await userEvent.click(screen.getByRole('button', { name: /^Code$/ }));
    await waitFor(() => expect(current()).toBe('Code'));
    await userEvent.click(screen.getByRole('button', { name: /^Metrics$/ }));
    await waitFor(() => expect(current()).toBe('Metrics'));
    await navigate('back');
    await waitFor(() => expect(current()).toBe('Code'));
    expect(screen.getByRole('heading', { name: 'Code analysis' })).toBeTruthy();
  });
});
