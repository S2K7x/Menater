/**
 * What an operator typed, and what it actually is.
 *
 * ============================================================================
 * WHY THE DETECTION LIVES ON THE SERVER
 *
 * The Lookup tab takes ONE field. Asking someone to pick "IP / domain / URL /
 * hash / email" from a dropdown before they can paste a value is a question
 * whose answer is already in the value. But the classification decides WHICH
 * PROVIDERS ARE CALLED — that is, which API quota is spent — so it cannot be a
 * browser-side guess the server then trusts: the browser proposes, the server
 * re-derives, and the server's answer is the one that routes the request.
 *
 * The kind can still be forced by the caller. Auto-detection that cannot be
 * overridden is a wall the first time it is wrong.
 *
 * ============================================================================
 * DEFANGING IS AN INPUT FORMAT, NOT AN ATTACK
 *
 * Threat-intel is copied out of tickets, mails and reports where addresses are
 * neutralised so nobody clicks them: `hxxp://`, `1.2.3[.]4`, `evil(.)com`,
 * `user[at]corp.com`. Refusing those is refusing the format the value arrives
 * in nine times out of ten. `refang()` restores them BEFORE detection, and the
 * result always reports both forms — what was typed, and what was queried —
 * because silently querying something other than what someone pasted is the
 * kind of surprise that costs an investigation.
 *
 * ============================================================================
 * WHAT IS REFUSED, AND WHY IT IS REFUSED RATHER THAN GUESSED
 *
 * An unrecognised value returns `kind: 'unknown'` and the reason. It does NOT
 * fall back to "treat it as a domain and see": a lookup that queries the wrong
 * thing answers confidently about a value nobody asked about — the same defect
 * as filling a gap with a default, moved into the investigation surface.
 * ============================================================================
 */

/** Everything this console knows how to look up. */
export type ObservableKind = 'ipv4' | 'ipv6' | 'domain' | 'url' | 'hash' | 'email' | 'unknown';

export type HashKind = 'md5' | 'sha1' | 'sha256';

export interface Observable {
  /** Exactly what was typed, clipped. Shown back, never queried. */
  input: string;
  /** What is actually queried: refanged, trimmed, lower-cased where safe. */
  value: string;
  kind: ObservableKind;
  /** Set for `hash` only. */
  hash_kind: HashKind | null;
  /**
   * `true` when the address is RFC 1918 / loopback / link-local, `false` when
   * it is routable, `null` when the question does not apply. Three states, as
   * everywhere else in this product: "not an IP" is not "not private".
   */
  private_address: boolean | null;
  /** `true` when refanging changed the string — the UI says so. */
  refanged: boolean;
  /** Present when `kind` is `unknown`: why nothing could be done with it. */
  reason: string | null;
}

/** Long inputs are a paste accident, not an observable. */
const MAX_INPUT = 2048;

const HASH_KINDS: Record<number, HashKind> = { 32: 'md5', 40: 'sha1', 64: 'sha256' };

/** RFC 1918, loopback, link-local, and the IPv6 equivalents. */
const PRIVATE_V4 = /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_V6 = /^(::1$|fc|fd|fe80:)/i;

/**
 * Undoes the neutralisations used when an indicator is written down.
 *
 * Deliberately narrow: it restores the four conventions that are actually in
 * circulation and nothing else. A permissive rewriter would eventually turn a
 * legitimate value into a different legitimate value.
 */
export function refang(raw: string): string {
  return raw
    .trim()
    .replace(/\[\.\]|\(\.\)|\{\.\}|\s+dot\s+/gi, '.')
    .replace(/\[:\]/g, ':')
    .replace(/\[at\]|\(at\)|\s+at\s+/gi, '@')
    // Last, and it is the only rule that touches the scheme: `hxxp` and
    // `hXXps` become `http` / `https`, lower-cased. An earlier version also
    // carried a rule ahead of this one that could never match — its pattern
    // demanded `tt` where the defanged form has `xx` — and whose only
    // reachable effect was to rewrite `http` to `http`.
    .replace(/^(h(?:xx|tt)ps?):\/\//i, (_m, s: string) => `${s.toLowerCase().replace('xx', 'tt')}://`)
    .trim();
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HASH_RE = /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/;
// Deliberately not RFC 5322: that grammar accepts things no provider will
// look up. This accepts what an operator pastes out of a log.
const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function isIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value);
  if (!m) return false;
  return m.slice(1).every((part) => {
    // "01" is not an octet: some resolvers read a leading zero as octal, so
    // 127.0.0.01 and 127.0.0.1 would not be the same address everywhere.
    if (part.length > 1 && part.startsWith('0')) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/**
 * IPv6, without pulling in a parser.
 *
 * Compact but strict: hex groups, at most one `::`, an optional embedded IPv4
 * tail. A zone index (`%eth0`) is dropped — no provider accepts one.
 */
function isIpv6(value: string): boolean {
  const v = value.split('%')[0]!;
  if (!/^[0-9a-f:.]+$/i.test(v) || (v.match(/::/g) ?? []).length > 1) return false;
  if (!v.includes(':')) return false;
  // `:::1` slips past the "at most one `::`" test — the regex matches the
  // first two colons and resumes after them — and so does a value that opens
  // or closes on a lone colon. None of the three is an address; accepting one
  // means dialling three providers with something they will each refuse in
  // their own words.
  if (v.includes(':::')) return false;
  if (/^:[^:]/.test(v) || /[^:]:$/.test(v)) return false;
  const tail = v.split(':').pop()!;
  const embedded = tail.includes('.');
  if (embedded && !isIpv4(tail)) return false;
  const groups = v.split(':').filter((g) => g !== '');
  const count = groups.length - (embedded ? 1 : 0) + (embedded ? 2 : 0);
  if (v.includes('::') ? count > 8 : count !== 8) return false;
  return groups.every((g, i) => (embedded && i === groups.length - 1) || /^[0-9a-f]{1,4}$/i.test(g));
}

function urlOf(value: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    const u = new URL(value);
    // Only what a reputation service can be asked about. A `file://` or
    // `javascript:` "URL" would be sent nowhere and answered about by nobody.
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Classifies one value. Never throws, always explains an `unknown`.
 *
 * `forced` skips detection but NOT validation: forcing `ipv4` on `hello` still
 * yields `unknown`, because the providers would be called with nonsense and
 * would each answer their own flavour of "no".
 */
export function detect(raw: unknown, forced?: ObservableKind | null): Observable {
  const input = String(raw ?? '').slice(0, MAX_INPUT).trim();
  const base: Observable = {
    input, value: input, kind: 'unknown', hash_kind: null,
    private_address: null, refanged: false, reason: null,
  };

  if (input === '') return { ...base, reason: 'Nothing to look up.' };

  const value = refang(input);
  const refanged = value !== input;
  const shaped: Observable = { ...base, value, refanged };

  const asIpv4 = () => (isIpv4(value)
    ? { ...shaped, kind: 'ipv4' as const, private_address: PRIVATE_V4.test(value) }
    : null);
  const asIpv6 = () => (isIpv6(value)
    ? { ...shaped, value: value.split('%')[0]!.toLowerCase(), kind: 'ipv6' as const,
        private_address: PRIVATE_V6.test(value) }
    : null);
  const asHash = () => (HASH_RE.test(value)
    ? { ...shaped, value: value.toLowerCase(), kind: 'hash' as const,
        hash_kind: HASH_KINDS[value.length]! }
    : null);
  const asEmail = () => (EMAIL_RE.test(value)
    ? { ...shaped, value: value.toLowerCase(), kind: 'email' as const }
    : null);
  const asUrl = () => {
    const u = urlOf(value);
    return u ? { ...shaped, value: u.toString(), kind: 'url' as const } : null;
  };
  const asDomain = () => {
    // A bare `evil.com/path` is a URL someone did not type the scheme of.
    // Promoting it is the right reading, and the result says what was queried.
    const [host, ...rest] = value.split('/');
    if (rest.length > 0 && rest.join('/') !== '' && DOMAIN_RE.test(host!)) {
      return { ...shaped, value: `http://${value}`, kind: 'url' as const };
    }
    const host2 = (rest.length > 0 ? host! : value).replace(/\.$/, '');
    return DOMAIN_RE.test(host2)
      ? { ...shaped, value: host2.toLowerCase(), kind: 'domain' as const }
      : null;
  };

  const byKind: Record<Exclude<ObservableKind, 'unknown'>, () => Observable | null> = {
    ipv4: asIpv4, ipv6: asIpv6, hash: asHash, email: asEmail, url: asUrl, domain: asDomain,
  };

  if (forced && forced !== 'unknown') {
    const got = byKind[forced]();
    return got ?? { ...shaped, reason: `That is not a valid ${LABELS[forced]}.` };
  }

  // ORDER MATTERS AND IS NOT ALPHABETICAL. A hash is checked before a domain
  // because a 32-character hex string is not a hostname; an email before a
  // domain because it contains one; a URL before a domain for the same reason.
  const got = asIpv4() ?? asIpv6() ?? asHash() ?? asEmail() ?? asUrl() ?? asDomain();
  return got ?? {
    ...shaped,
    reason:
      'Not recognised as an IP address, domain, URL, file hash or email address. '
      + 'Check for a stray space, or force the kind if you know what it is.',
  };
}

export const LABELS: Record<ObservableKind, string> = {
  ipv4: 'IPv4 address', ipv6: 'IPv6 address', domain: 'domain', url: 'URL',
  hash: 'file hash', email: 'email address', unknown: 'value',
};

/** The host a URL points at — what the IP/domain providers can be asked about. */
export function hostOf(o: Observable): string | null {
  if (o.kind === 'domain') return o.value;
  if (o.kind !== 'url') return null;
  try {
    return new URL(o.value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * VirusTotal's identifier for a URL: base64url of the URL, padding stripped.
 *
 * Written out rather than imported because it is four lines and the shape of
 * the identifier is part of the provider contract — hiding it in a helper file
 * away from the endpoint that uses it is how the two drift apart.
 */
export const vtUrlId = (url: string): string =>
  Buffer.from(url, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
