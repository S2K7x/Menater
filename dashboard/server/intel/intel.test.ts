/**
 * Tests for the manual lookup.
 *
 * ============================================================================
 * WHAT THESE PROTECT
 *
 * Three things, and they are the three that would be wrong in a way nobody
 * would notice:
 *
 *  1. THE CLASSIFICATION. It decides which API quota is spent. A hash read as
 *     a domain, a defanged address read as garbage, a URL read as a hostname —
 *     each of those produces a confident answer about the wrong value.
 *
 *  2. `404 IS AN ANSWER`. HIBP says "in no breach" with a 404. If that ever
 *     regresses to `unavailable`, the panel stops reporting the single most
 *     common — and best — outcome, and it stops in the direction that looks
 *     like an outage rather than like a bug.
 *
 *  3. `clean` REQUIRES A SOURCE THAT ANSWERED. With no key configured every
 *     provider skips; printing "nothing found" over a value nobody looked at
 *     is the one sentence this feature must never produce.
 *
 * No test here reaches the network: `fetchImpl` and `secret` are injected.
 * ============================================================================
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { detect, refang, vtUrlId } from './observables.ts';
import {
  describeProviders, forgetLookups, lookup, lookupMemorySize, pwnedRange, synthesise,
} from './lookup.ts';
import { PROVIDERS, providersFor, type ProviderResult } from './providers.ts';

/** A `fetch` that answers from a table keyed on a substring of the URL. */
function fakeFetch(routes: Array<{ match: string; status: number; body?: unknown; headers?: Record<string, string> }>) {
  const seen: string[] = [];
  const impl = (async (url: any, init: any) => {
    const u = String(url);
    seen.push(u);
    const hit = routes.find((r) => u.includes(r.match));
    if (!hit) throw new Error(`unexpected call to ${u}`);
    return new Response(
      hit.body === undefined ? '' : typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body),
      { status: hit.status, headers: hit.headers },
    );
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen, init: undefined as any };
}

const allKeys = (env: string) => `key-for-${env}`;
const noKeys = () => undefined;

beforeEach(() => forgetLookups());

describe('classification', () => {
  it('reads the five kinds out of the value', () => {
    expect(detect('8.8.8.8').kind).toBe('ipv4');
    expect(detect('2001:4860:4860::8888').kind).toBe('ipv6');
    expect(detect('evil.example.com').kind).toBe('domain');
    expect(detect('https://evil.example.com/a?b=1').kind).toBe('url');
    expect(detect('d41d8cd98f00b204e9800998ecf8427e').kind).toBe('hash');
    expect(detect('a@b.com').kind).toBe('email');
  });

  it('names the hash algorithm rather than just its length', () => {
    expect(detect('d41d8cd98f00b204e9800998ecf8427e').hash_kind).toBe('md5');
    expect(detect('a'.repeat(40)).hash_kind).toBe('sha1');
    expect(detect('a'.repeat(64)).hash_kind).toBe('sha256');
  });

  it('refangs, and says it did', () => {
    const o = detect('1.2.3[.]4');
    expect(o.kind).toBe('ipv4');
    expect(o.value).toBe('1.2.3.4');
    expect(o.refanged).toBe(true);
    expect(o.input).toBe('1.2.3[.]4');
    expect(refang('hxxps://evil[.]com')).toBe('https://evil.com');
    expect(detect('user[at]corp.com').kind).toBe('email');
  });

  it('separates private addresses from routable ones, and both from "not an IP"', () => {
    expect(detect('10.0.0.5').private_address).toBe(true);
    expect(detect('172.16.4.1').private_address).toBe(true);
    expect(detect('172.32.4.1').private_address).toBe(false);
    expect(detect('8.8.8.8').private_address).toBe(false);
    // The third state: the question does not apply.
    expect(detect('evil.com').private_address).toBeNull();
  });

  it('refuses an octet with a leading zero rather than reading it as a host', () => {
    // 127.0.0.01 is octal to some resolvers: it is not the same address
    // everywhere, so it is not an address this console will query.
    expect(detect('127.0.0.01').kind).not.toBe('ipv4');
  });

  it('promotes a scheme-less path to a URL and leaves a bare host a domain', () => {
    expect(detect('evil.com/pay.php').kind).toBe('url');
    expect(detect('evil.com/pay.php').value).toBe('http://evil.com/pay.php');
    expect(detect('evil.com.').kind).toBe('domain');
    expect(detect('evil.com.').value).toBe('evil.com');
  });

  it('explains an unknown value instead of guessing at it', () => {
    const o = detect('what even is this');
    expect(o.kind).toBe('unknown');
    expect(o.reason).toMatch(/Not recognised/);
  });

  it('validates a forced kind rather than trusting it', () => {
    expect(detect('hello', 'ipv4').kind).toBe('unknown');
    expect(detect('hello', 'ipv4').reason).toMatch(/not a valid IPv4/);
    // Forcing is still allowed to override a correct auto-detection.
    expect(detect('1.2.3.4', 'domain').kind).toBe('unknown');
  });

  it('computes VirusTotal\'s URL identifier as base64url without padding', () => {
    expect(vtUrlId('http://a.com/')).toBe('aHR0cDovL2EuY29tLw');
    expect(vtUrlId('http://a.com/')).not.toMatch(/[+/=]/);
  });
});

describe('the provider catalogue', () => {
  it('covers every kind the interface offers', () => {
    for (const kind of ['ipv4', 'ipv6', 'domain', 'url', 'hash', 'email'] as const) {
      expect(providersFor(kind).length).toBeGreaterThan(0);
    }
  });

  it('names a credential this console actually manages, or none at all', async () => {
    const { MANAGED_CREDENTIALS } = await import('../credentials.ts');
    const known = new Set(MANAGED_CREDENTIALS.map((c) => c.env));
    for (const p of PROVIDERS) {
      if (p.env !== null) expect(known.has(p.env), `${p.id} → ${p.env}`).toBe(true);
    }
  });

  it('reports what is configured without ever returning a value', () => {
    const state = describeProviders((env) => (env === 'VIRUSTOTAL_APIKEY' ? 'secret' : undefined));
    const vt = state.find((p) => p.id === 'virustotal')!;
    const hibp = state.find((p) => p.id === 'hibp_breaches')!;
    const free = state.find((p) => p.id === 'internetdb')!;
    expect(vt.configured).toBe(true);
    expect(hibp.configured).toBe(false);
    // A key-free source is usable on a fresh install: that is why it is here.
    expect(free.configured).toBe(true);
    expect(JSON.stringify(state)).not.toContain('secret');
  });
});

describe('running a lookup', () => {
  it('queries every applicable source in one pass', async () => {
    const f = fakeFetch([
      { match: 'abuseipdb.com', status: 200, body: { data: { abuseConfidenceScore: 0, totalReports: 0 } } },
      { match: 'api.shodan.io', status: 200, body: { ports: [22, 443], org: 'Example' } },
      { match: 'internetdb.shodan.io', status: 200, body: { ports: [22], vulns: [] } },
      { match: 'virustotal.com', status: 200, body: { data: { attributes: { last_analysis_stats: { malicious: 0, harmless: 70 } } } } },
    ]);
    const r = await lookup('8.8.8.8', null, { fetchImpl: f.impl, secret: allKeys });
    expect(r.observable.kind).toBe('ipv4');
    expect(r.sources.map((s) => s.provider).sort()).toEqual(['abuseipdb', 'internetdb', 'shodan', 'virustotal']);
    expect(r.sources.every((s) => s.status === 'ok')).toBe(true);
    expect(r.verdict).toBe('clean');
  });

  it('skips a private address without calling anything', async () => {
    const f = fakeFetch([]);
    const r = await lookup('10.1.2.3', null, { fetchImpl: f.impl, secret: allKeys });
    expect(f.seen).toEqual([]);
    expect(r.sources.every((s) => s.status === 'skipped')).toBe(true);
    expect(r.verdict).toBe('unknown');
    expect(r.headline).toMatch(/No source was queried/);
  });

  it('skips a source whose key is missing, and names the field to fill', async () => {
    const f = fakeFetch([{ match: 'internetdb', status: 200, body: { ports: [] } }]);
    const r = await lookup('8.8.8.8', null, { fetchImpl: f.impl, secret: noKeys });
    const vt = r.sources.find((s) => s.provider === 'virustotal')!;
    expect(vt.status).toBe('skipped');
    expect(vt.reason).toMatch(/VIRUSTOTAL_APIKEY/);
    // The free source still answered, so the verdict is not "unknown".
    expect(r.answered).toBe(1);
  });

  it('reads HIBP\'s 404 as "in no breach", not as a failure', async () => {
    const f = fakeFetch([
      { match: 'breachedaccount', status: 404 },
      { match: 'stealerlogsbyemail', status: 404 },
      { match: 'pasteaccount', status: 404 },
    ]);
    const r = await lookup('nobody@example.com', null, { fetchImpl: f.impl, secret: allKeys });
    expect(r.sources.every((s) => s.status === 'ok')).toBe(true);
    expect(r.sources.find((s) => s.provider === 'hibp_breaches')!.fields!.breach_count).toBe(0);
    expect(r.verdict).toBe('clean');
  });

  it('flags an address found in a breach that leaked passwords', async () => {
    const f = fakeFetch([
      { match: 'breachedaccount', status: 200, body: [
        { Name: 'Adobe', Title: 'Adobe', BreachDate: '2013-10-04', PwnCount: 152445165, DataClasses: ['Email addresses', 'Passwords'], IsVerified: true },
        { Name: 'Old', Title: 'Old', BreachDate: '2011-01-01', DataClasses: ['Email addresses'] },
      ] },
      { match: 'stealerlogsbyemail', status: 404 },
      { match: 'pasteaccount', status: 404 },
    ]);
    const r = await lookup('someone@example.com', null, { fetchImpl: f.impl, secret: allKeys });
    const b = r.sources.find((s) => s.provider === 'hibp_breaches')!;
    expect(b.fields!.breach_count).toBe(2);
    expect(b.fields!.passwords_exposed).toBe(true);
    // Newest first: "when was it last exposed" is the question being asked.
    expect((b.fields!.breaches as any[])[0].name).toBe('Adobe');
    expect(r.verdict).toBe('flagged');
    expect(r.headline).toMatch(/exposed/);
  });

  it('treats an infostealer capture as a strong signal on its own', async () => {
    const f = fakeFetch([
      { match: 'breachedaccount', status: 404 },
      { match: 'stealerlogsbyemail', status: 200, body: ['netflix.com', 'okta.com'] },
      { match: 'pasteaccount', status: 404 },
    ]);
    const r = await lookup('victim@example.com', null, { fetchImpl: f.impl, secret: allKeys });
    expect(r.verdict).toBe('flagged');
    expect(r.signals.some((s) => /infostealer/i.test(s.text))).toBe(true);
  });

  it('does not flag on one VirusTotal detection out of seventy', async () => {
    const f = fakeFetch([
      { match: 'virustotal', status: 200, body: { data: { attributes: { last_analysis_stats: { malicious: 1, suspicious: 0, harmless: 69, undetected: 0 } } } } },
    ]);
    const r = await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    expect(r.verdict).toBe('watch');
  });

  it('flags at three engines', async () => {
    const f = fakeFetch([
      { match: 'virustotal', status: 200, body: { data: { attributes: { last_analysis_stats: { malicious: 3, harmless: 60 } } } } },
    ]);
    const r = await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    expect(r.verdict).toBe('flagged');
  });

  it('turns a provider 401 into a sentence, never into a status code', async () => {
    const f = fakeFetch([{ match: 'virustotal', status: 401, body: { error: 'nope' } }]);
    const r = await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    const vt = r.sources[0]!;
    expect(vt.status).toBe('unavailable');
    expect(vt.reason).toMatch(/refused the key/);
    // And the whole lookup is "unknown", not "clean": nobody answered.
    expect(r.verdict).toBe('unknown');
    expect(r.headline).toMatch(/not "nothing found"/);
  });

  it('obeys a 429 instead of retrying into it', async () => {
    const f = fakeFetch([{ match: 'virustotal', status: 429, headers: { 'retry-after': '30' } }]);
    const first = await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    expect(first.sources[0]!.http_status).toBe(429);
    const second = await lookup('other.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    // The second call never left the process: the cooldown answered it.
    expect(f.seen.length).toBe(1);
    expect(second.sources[0]!.reason).toMatch(/holding off/);
  });

  it('serves a second identical lookup from memory, and says so', async () => {
    const f = fakeFetch([{ match: 'virustotal', status: 200, body: { data: { attributes: { last_analysis_stats: { malicious: 0, harmless: 70 } } } } }]);
    await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    const again = await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    expect(f.seen.length).toBe(1);
    expect(again.sources[0]!.cached).toBe(true);
    expect(again.sources[0]!.reason).toMatch(/less than a minute ago/);
    // No latency on a cached card: nothing was called, and printing the
    // original call's milliseconds next to "from memory" invites the reader to
    // think a request just went out.
    expect(again.sources[0]!.ms).toBeNull();
    // And `fresh` goes back out to the network.
    await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'], fresh: true });
    expect(f.seen.length).toBe(2);
  });

  it('remembers the refanged value, so both spellings hit the same entry', async () => {
    const f = fakeFetch([{ match: 'abuseipdb', status: 200, body: { data: { abuseConfidenceScore: 0 } } }]);
    await lookup('1.2.3.4', null, { fetchImpl: f.impl, secret: allKeys, only: ['abuseipdb'] });
    await lookup('1.2.3[.]4', null, { fetchImpl: f.impl, secret: allKeys, only: ['abuseipdb'] });
    expect(f.seen.length).toBe(1);
  });

  it('never remembers a failure', async () => {
    const f = fakeFetch([{ match: 'virustotal', status: 500 }]);
    await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    expect(f.seen.length).toBe(2);
  });

  it('answers an unrecognised value without calling anything', async () => {
    const f = fakeFetch([]);
    const r = await lookup('not an observable', null, { fetchImpl: f.impl, secret: allKeys });
    expect(r.sources).toEqual([]);
    expect(r.verdict).toBe('unknown');
    expect(f.seen).toEqual([]);
  });

  it('sends HIBP a user-agent, which it answers 403 without', async () => {
    let headers: any = null;
    const impl = (async (_u: any, init: any) => {
      headers = init.headers;
      return new Response('', { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    await lookup('a@b.com', null, { fetchImpl: impl, secret: allKeys, only: ['hibp_breaches'] });
    expect(headers['user-agent']).toBeTruthy();
    expect(headers['hibp-api-key']).toBeTruthy();
  });
});

describe('the synthesis', () => {
  const src = (over: Partial<ProviderResult>): ProviderResult => ({
    provider: 'x', label: 'X', status: 'ok', fields: {}, reason: null,
    http_status: 200, ms: 1, signals: [], permalink: null, cached: false, ...over,
  });
  const o = detect('8.8.8.8');

  it('refuses to say "clean" when nothing answered', () => {
    const s = synthesise(o, [src({ status: 'skipped', fields: null })]);
    expect(s.verdict).toBe('unknown');
    expect(s.answered).toBe(0);
  });

  it('separates "everything failed" from "nothing was asked"', () => {
    expect(synthesise(o, [src({ status: 'unavailable', fields: null })]).headline)
      .toMatch(/could answer/);
    expect(synthesise(o, [src({ status: 'skipped', fields: null })]).headline)
      .toMatch(/was queried/);
  });

  it('sorts the strong signals to the top', () => {
    const s = synthesise(o, [
      src({ signals: [{ weight: 'context', text: 'ctx' }] }),
      src({ signals: [{ weight: 'strong', text: 'bad' }, { weight: 'weak', text: 'meh' }] }),
    ]);
    expect(s.signals.map((x) => x.text)).toEqual(['bad', 'meh', 'ctx']);
    expect(s.verdict).toBe('flagged');
  });
});

describe('the Pwned Passwords relay', () => {
  it('refuses anything that is not exactly five hex characters', async () => {
    for (const bad of ['ABC', 'ABCDEF', 'ZZZZZ', '']) {
      const out = await pwnedRange(bad, { fetchImpl: (() => { throw new Error('called'); }) as any });
      expect(out.ok).toBe(false);
    }
  });

  it('forwards the prefix upper-cased, with padding on', async () => {
    let url = ''; let headers: any = null;
    const impl = (async (u: any, init: any) => {
      url = String(u); headers = init.headers;
      return new Response('ABC:1\n', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const out = await pwnedRange('abcde', { fetchImpl: impl });
    expect(url).toBe('https://api.pwnedpasswords.com/range/ABCDE');
    expect(headers['Add-Padding']).toBe('true');
    expect(out.ok && out.body).toBe('ABC:1\n');
  });
});

/**
 * The pass that followed the first one.
 *
 * Everything below is a defect this code actually had. They share a shape:
 * none of them raises an error, and each is wrong in the direction that looks
 * like a working feature.
 */
describe('found by audit', () => {
  it('does not ask AbuseIPDB for ten thousand reports it will not read', async () => {
    const f = fakeFetch([{ match: 'abuseipdb', status: 200, body: { data: { abuseConfidenceScore: 0 } } }]);
    await lookup('8.8.8.8', null, { fetchImpl: f.impl, secret: allKeys, only: ['abuseipdb'] });
    // `verbose` adds `countryName`, which is not mapped, and a `reports` array
    // capped at 10,000 elements, which is downloaded and parsed to be thrown
    // away. Nothing fails; it is bandwidth and heap on every lookup.
    expect(f.seen[0]).not.toMatch(/verbose/);
    expect(f.seen[0]).toMatch(/maxAgeInDays=90/);
  });

  it('does not ask Shodan to strip the banners its CVE list lives in', async () => {
    const f = fakeFetch([{ match: 'api.shodan.io', status: 200, body: { ports: [] } }]);
    await lookup('8.8.8.8', null, { fetchImpl: f.impl, secret: allKeys, only: ['shodan'] });
    // `minify=true` returns ports and general host information WITH NO
    // BANNERS — and `vulns` is a banner field. The one thing the paid source
    // adds over the free InternetDB would have come back empty every time,
    // with nothing on screen to suggest anything had gone wrong.
    expect(f.seen[0]).not.toMatch(/minify/);
  });

  it('sends Shodan its key as a query parameter, the only form that API has', async () => {
    const f = fakeFetch([{ match: 'api.shodan.io', status: 200, body: { ports: [] } }]);
    await lookup('8.8.8.8', null, { fetchImpl: f.impl, secret: allKeys, only: ['shodan'] });
    expect(f.seen[0]).toMatch(/[?&]key=key-for-SHODAN_APIKEY/);
  });

  it('refuses the three malformed IPv6 shapes the group count let through', () => {
    // `:::1` slips past "at most one `::`" — the match consumes the first two
    // colons and resumes after them — and a lone leading or trailing colon
    // passed the group count too. Each would have dialled three providers.
    for (const bad of [':::1', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:']) {
      expect(detect(bad).kind, bad).toBe('unknown');
    }
    // And the shapes that ARE addresses still are.
    for (const good of ['::1', '2001:db8::1', '::ffff:192.168.1.1', '1:2:3:4:5:6:7:8']) {
      expect(detect(good).kind, good).toBe('ipv6');
    }
  });

  it('still refangs every scheme form after the dead rule was removed', () => {
    expect(refang('hxxp://a.com')).toBe('http://a.com');
    expect(refang('hXXps://a.com')).toBe('https://a.com');
    expect(refang('HTTP://a.com')).toBe('http://a.com');
    expect(refang('https://a.com')).toBe('https://a.com');
  });

  it('reads a Retry-After given as an HTTP date, not just as seconds', async () => {
    const when = new Date(Date.now() + 90_000).toUTCString();
    const f = fakeFetch([{ match: 'virustotal', status: 429, headers: { 'retry-after': when } }]);
    await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    const second = await lookup('other.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    // `Number('Wed, 03 Sep …')` is NaN. It used to fall through to the 60 s
    // default, which UNDERCUTS the delay the service asked for — and the
    // suggested delay is a floor, so undercutting it buys a second refusal.
    expect(f.seen.length).toBe(1);
    expect(second.sources[0]!.reason).toMatch(/holding off for another (8\d|9\d) s/);
  });

  it('caps a Retry-After nobody should honour literally', async () => {
    const f = fakeFetch([{ match: 'virustotal', status: 429, headers: { 'retry-after': '86400' } }]);
    const r = await lookup('example.com', null, { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] });
    // One bad header must not park a source for a day.
    expect(r.sources[0]!.reason).toMatch(/300 s/);
  });

  it('releases the body of every response it does not read', async () => {
    // Node keeps the socket checked out of the pool until a body is consumed
    // or cancelled. Every early return used to walk away from one.
    const cancelled: number[] = [];
    const impl = (async (_u: any) => {
      const res = new Response('unread', { status: 500 });
      const original = res.body!.cancel.bind(res.body);
      Object.defineProperty(res, 'body', {
        value: { cancel: async () => { cancelled.push(1); return original(); } },
      });
      return res;
    }) as unknown as typeof globalThis.fetch;
    await lookup('example.com', null, { fetchImpl: impl, secret: allKeys, only: ['virustotal'] });
    expect(cancelled.length).toBe(1);
  });

  it('evicts the oldest entry without walking the whole table', async () => {
    // Behavioural, not a benchmark: the point is that a refreshed key moves to
    // the back of the queue, so an entry still being asked for is not the next
    // one evicted.
    const f = fakeFetch([{ match: 'virustotal', status: 200, body: { data: { attributes: { last_analysis_stats: { malicious: 0, harmless: 70 } } } } }]);
    const opts = { fetchImpl: f.impl, secret: allKeys, only: ['virustotal'] };
    await lookup('a.com', null, opts);
    await lookup('b.com', null, opts);
    expect(lookupMemorySize()).toBe(2);
    // Re-reading `a.com` comes from memory and does not duplicate the entry.
    await lookup('a.com', null, opts);
    expect(lookupMemorySize()).toBe(2);
    expect(f.seen.length).toBe(2);
  });

  it('explains a 403 differently for HIBP than for anyone else', async () => {
    const hibp = fakeFetch([{ match: 'breachedaccount', status: 403 }]);
    const r1 = await lookup('a@b.com', null, { fetchImpl: hibp.impl, secret: allKeys, only: ['hibp_breaches'] });
    expect(r1.sources[0]!.reason).toMatch(/subscription/);

    const vt = fakeFetch([{ match: 'virustotal', status: 403 }]);
    const r2 = await lookup('example.com', null, { fetchImpl: vt.impl, secret: allKeys, only: ['virustotal'] });
    // Telling a VirusTotal user about HIBP's tiers sends them looking for a
    // setting that is not theirs to change.
    expect(r2.sources[0]!.reason).not.toMatch(/subscription/);
    expect(r2.sources[0]!.reason).toMatch(/not allowed to make this call/);
  });
});
