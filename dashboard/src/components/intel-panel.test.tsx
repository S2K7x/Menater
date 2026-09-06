/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the Lookup tab.
 *
 * ============================================================================
 * WHAT THEY PROTECT
 *
 * Two promises this screen makes in writing, and one it makes by omission:
 *
 *  1. THE PASSWORD NEVER LEAVES THE BROWSER. The panel states it in bold above
 *     the field, someone types a real password on the strength of that
 *     sentence, and nothing but a test keeps it true. The assertion is on the
 *     REQUEST: five characters, and no substring of the password or of the
 *     rest of its hash anywhere in the URL.
 *
 *  2. A SKIPPED SOURCE IS VISIBLY A SKIPPED SOURCE. The screen must never
 *     print reassurance over a value nobody looked at — so a lookup where
 *     everything skipped shows "No answer", never "Nothing against it".
 *
 *  3. The panel does not empty the password field on failure only: it clears
 *     it either way. A password left in a React tree after the answer is one
 *     more copy nobody asked for.
 *
 * AND, SINCE THE READABILITY PASS, A FOURTH — WHAT MAY BE FOLDED HERE.
 *
 * The source catalogue is reference and folds away; its fold summary carries
 * the COVERAGE, because on an install with no keys that is the most useful
 * fact on the screen — it says in advance that every answer will be "not
 * asked" rather than "nothing found". When nothing at all is reachable the
 * fold opens itself: filing a zero coverage behind a silent click would be
 * showing green over a hole, which is exactly what promise 2 forbids one
 * screen lower.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { IntelPanel } from './IntelPanel.tsx';
import type { IntelResult } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const result = (over: Partial<IntelResult> = {}): IntelResult => ({
  observable: {
    input: '8.8.8.8', value: '8.8.8.8', kind: 'ipv4', hash_kind: null,
    private_address: false, refanged: false, reason: null,
  },
  verdict: 'clean',
  headline: '2 sources answered and none flagged this IPv4 address.',
  signals: [],
  sources: [],
  answered: 2,
  queried_at: '2026-09-03T10:00:00.000Z',
  ms: 210,
  ...over,
});

/** Stubs `fetch` for both the provider list and whatever the test needs. */
function stubFetch(handler: (url: string, init?: any) => { status?: number; body?: unknown; text?: string }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/intel/providers')) {
      return new Response(JSON.stringify({ providers: [], kinds: [] }), { status: 200 });
    }
    const out = handler(u, init);
    return new Response(out.text ?? JSON.stringify(out.body), { status: out.status ?? 200 });
  }));
  return calls;
}

describe('the password check', () => {
  it('sends five characters of the hash and nothing else', async () => {
    const calls = stubFetch(() => ({ text: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3\n' }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    const field = await screen.findByPlaceholderText(/password to check/i);
    await user.type(field, 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /check it/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.includes('/api/intel/pwned-range/'))).toBe(true);
    });
    const range = calls.find((c) => c.includes('/api/intel/pwned-range/'))!;
    const prefix = range.split('/').pop()!;
    // SHA-1 of that passphrase begins ABF7A. Pinning the value pins the whole
    // chain: the right algorithm, uppercase hex, and exactly five characters.
    expect(prefix).toBe('ABF7A');
    // And nothing else about the password travelled.
    expect(range).not.toMatch(/horse|staple|correct/i);
    expect(prefix.length).toBe(5);
  });

  it('reports a hit with the number of times it has leaked', async () => {
    // SHA-1('password') = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
    stubFetch(() => ({ text: '1E4C9B93F3F0682250B6CF8331B7EE68FD8:24230577\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n' }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    await user.type(await screen.findByPlaceholderText(/password to check/i), 'password');
    await user.click(screen.getByRole('button', { name: /check it/i }));

    expect(await screen.findByText(/Found in breached data/i)).toBeTruthy();
    expect(screen.getByText(/24,230,577 times/i)).toBeTruthy();
  });

  it('says a password is absent from the corpus without calling it strong', async () => {
    stubFetch(() => ({ text: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n' }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    await user.type(await screen.findByPlaceholderText(/password to check/i), 'a-passphrase-nobody-has');
    await user.click(screen.getByRole('button', { name: /check it/i }));

    expect(await screen.findByText(/Not in the corpus/i)).toBeTruthy();
    // The distinction that matters: not leaked is not the same as strong.
    expect(screen.getByText(/nothing about whether it is strong/i)).toBeTruthy();
  });

  it('clears the field once the answer is known', async () => {
    stubFetch(() => ({ text: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n' }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    const field = await screen.findByPlaceholderText(/password to check/i) as HTMLInputElement;
    await user.type(field, 'something');
    await user.click(screen.getByRole('button', { name: /check it/i }));

    await waitFor(() => expect(field.value).toBe(''));
  });
});

describe('the verdict', () => {
  it('shows how many sources answered, next to the verdict', async () => {
    stubFetch(() => ({ body: result({
      sources: [
        { provider: 'a', label: 'A', status: 'ok', fields: {}, reason: null, http_status: 200, ms: 10, signals: [], permalink: null, cached: false },
        { provider: 'b', label: 'B', status: 'ok', fields: {}, reason: null, http_status: 200, ms: 12, signals: [], permalink: null, cached: false },
      ],
    }) }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    await user.type(screen.getAllByRole('textbox')[0]!, '8.8.8.8');
    await user.click(screen.getByRole('button', { name: /look it up/i }));

    // Twice on screen once a lookup has run: the verdict pill, and the same
    // verdict on the session-history row underneath it.
    expect((await screen.findAllByText('Nothing against it')).length).toBeGreaterThan(0);
    expect(screen.getByText('2 of 2 sources answered')).toBeTruthy();
  });

  it('says "No answer", not "nothing against it", when every source skipped', async () => {
    stubFetch(() => ({ body: result({
      verdict: 'unknown',
      answered: 0,
      headline: 'No source was queried about this IPv4 address.',
      sources: [
        { provider: 'a', label: 'A', status: 'skipped', fields: null, reason: 'No key.', http_status: null, ms: null, signals: [], permalink: null, cached: false },
      ],
    }) }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    await user.type(screen.getAllByRole('textbox')[0]!, '8.8.8.8');
    await user.click(screen.getByRole('button', { name: /look it up/i }));

    expect((await screen.findAllByText('No answer')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing against it')).toBeNull();
    // And the reason is on screen, not folded away.
    expect(screen.getByText('No key.')).toBeTruthy();
    expect(screen.getByText('Not asked')).toBeTruthy();
  });

  it('shows both the typed value and the one actually queried when they differ', async () => {
    stubFetch(() => ({ body: result({
      observable: {
        input: '1.2.3[.]4', value: '1.2.3.4', kind: 'ipv4', hash_kind: null,
        private_address: false, refanged: true, reason: null,
      },
    }) }));
    const user = userEvent.setup();
    render(<IntelPanel />);

    // Pasted rather than typed: `[` opens a key descriptor in user-event's
    // keyboard grammar, and a defanged address is full of them.
    await user.click(screen.getAllByRole('textbox')[0]!);
    await user.paste('1.2.3[.]4');
    await user.click(screen.getByRole('button', { name: /look it up/i }));

    // The heading and the history chip both carry it.
    expect((await screen.findAllByText('1.2.3.4')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Queried as 1\.2\.3\.4/)).toBeTruthy();
  });
});

/* ==========================================================================
 * Ce que le catalogue de sources a le droit de replier
 * ========================================================================== */

/** Providers avec la forme que la route renvoie, pour piloter la couverture. */
function stubProviders(providers: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/api/intel/providers')) {
      return new Response(JSON.stringify({ providers, kinds: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
}

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'vt',
  label: 'VirusTotal',
  purpose: 'Seventy-odd engines.',
  kinds: ['ipv4'],
  ttl_hours: 6,
  env: 'VIRUSTOTAL_APIKEY',
  configured: false,
  signup: 'https://example.com',
  ...over,
});

describe('le catalogue de sources se replie, et son pli rapporte', () => {
  it('annonce combien de sources repondront, sans qu on l ouvre', async () => {
    // Une source gratuite (`env: null`) est joignable, une source avec cle
    // posee aussi. Le reste ne repondra pas — et le dire d'avance evite de
    // lire « rien trouve » la ou personne n'a regarde.
    stubProviders([
      provider({ id: 'internetdb', env: null }),
      provider({ id: 'vt' }),
      provider({ id: 'abuseipdb', configured: true }),
    ]);
    render(<IntelPanel />);
    expect(await screen.findByText('2 of 3 reachable')).toBeTruthy();
  });

  it('reste replie tant qu au moins une source repond', async () => {
    stubProviders([provider({ id: 'internetdb', env: null }), provider({ id: 'vt' })]);
    render(<IntelPanel />);
    const summary = await screen.findByText('1 of 2 reachable');
    expect(summary.closest('details')!.open).toBe(false);
  });

  it("S'OUVRE quand aucune source ne repond", async () => {
    // Zero source joignable veut dire que cet onglet ne peut rien apprendre.
    // Le ranger derriere un clic silencieux afficherait vert une couverture
    // nulle — le defaut que ce meme ecran refuse dans ses verdicts.
    stubProviders([provider({ id: 'vt' }), provider({ id: 'abuseipdb' })]);
    render(<IntelPanel />);
    const summary = await screen.findByText('0 of 2 reachable');
    expect(summary.closest('details')!.open).toBe(true);
  });
});

describe('ce que la passe de lisibilite n avait pas le droit de replier', () => {
  it('laisse la garantie du mot de passe EN CLAIR, hors de tout pli', async () => {
    // On lit la description du service une fois ; on relit la garantie chaque
    // fois qu'on tape un mot de passe. Elle ne se replie pas, et elle reste
    // au-dessus du champ.
    stubProviders([]);
    render(<IntelPanel />);
    const promise = await screen.findByText(/does not leave this browser/i);
    expect(promise.closest('details')).toBeNull();
  });

  it('garde l explication du champ, repliee et non supprimee', async () => {
    stubProviders([]);
    render(<IntelPanel />);
    const explanation = await screen.findByText(/nobody looked" are not the same sentence/i);
    expect(explanation.closest('details')!.open).toBe(false);
  });
});
