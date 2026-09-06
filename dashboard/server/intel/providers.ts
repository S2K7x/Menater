/**
 * The closed catalogue of sources a manual lookup may reach.
 *
 * ============================================================================
 * WHY A CATALOGUE, AND WHY IT IS CLOSED
 *
 * This is the fourth closed catalogue in this product, and it is closed for
 * the reason the other three are: the surface an operator can point at the
 * Internet from a SOC console is a surface an injected instruction can also
 * point. A provider table means the endpoint takes a value and a kind — never
 * a URL — so there is no request shape the caller gets to invent. Adding a
 * source is an edit to this file plus an entry in the credential store, and
 * that friction is deliberate.
 *
 * ============================================================================
 * THE THREE STATES ARE THE ENRICHMENT PIPELINE'S THREE STATES
 *
 *   `ok`          — asked, and it answered;
 *   `skipped`     — not asked, and the reason is not a failure (no key for it,
 *                   private address, wrong kind of observable);
 *   `unavailable` — asked, and it failed.
 *
 * Deliberately the same vocabulary as `transforms/enrichment.ts`. An operator
 * who has read one screen has read the other, and the distinction that matters
 * is the same one: a source we did not question is not a hole in what we know.
 *
 * ============================================================================
 * 404 IS AN ANSWER
 *
 * Have I Been Pwned returns 404 for "this address appears in no breach" —
 * which is the best news the endpoint has. Treating a non-2xx as a failure,
 * the way the enrichment normaliser legitimately does for its three sources,
 * would turn every clean address into "source unavailable" and hide the one
 * result the operator came for. Each provider therefore says for itself which
 * status codes are answers; there is no global rule, because there is no
 * global truth here.
 * ============================================================================
 */

import type { ManagedCredential } from '../credentials.ts';
import { vtUrlId, type Observable, type ObservableKind } from './observables.ts';

export type SourceStatus = 'ok' | 'skipped' | 'unavailable';

/** One signal read out of a provider's answer, for the synthesis. */
export interface Signal {
  /** `strong` moves the verdict on its own; `weak` only qualifies it. */
  weight: 'strong' | 'weak' | 'context';
  text: string;
}

export interface ProviderResult {
  provider: string;
  label: string;
  status: SourceStatus;
  /** Present on `ok`: the normalised fields, never the raw body. */
  fields: Record<string, unknown> | null;
  /** Present on `skipped` / `unavailable`: why, in a sentence. */
  reason: string | null;
  http_status: number | null;
  /** Milliseconds the call took. Absent for a skip: nothing was called. */
  ms: number | null;
  signals: Signal[];
  /** Where a human goes to read the full record. */
  permalink: string | null;
  /** `true` when the answer came from this process's cache, not the network. */
  cached: boolean;
}

/** What a provider decided to do with one observable. */
type Plan =
  | { call: true; url: string; headers: Record<string, string>; permalink: string | null }
  | { call: false; reason: string };

export interface Provider {
  id: string;
  label: string;
  /** What it can be asked about. Anything else is not even a skip: it is off-topic. */
  kinds: ObservableKind[];
  /** The credential it needs, or `null` when the source is free. */
  env: ManagedCredential | null;
  /** Where to get a key. Shown next to the field that is empty. */
  signup: string;
  /** One line, shown in the provider list so nobody has to guess what it adds. */
  purpose: string;
  /** How long an answer stays good. Reputation moves in hours, not seconds. */
  ttlMs: number;
  /** Status codes that carry an answer rather than a failure. */
  answers: (status: number) => boolean;
  plan(o: Observable, key: string | undefined): Plan;
  /** `body` is the parsed JSON, or `null` on a 404-as-answer. */
  map(body: unknown, o: Observable): Record<string, unknown>;
  read(fields: Record<string, unknown>): Signal[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const orNull = (v: unknown): unknown => (v === undefined ? null : v);
const arrayOr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const HOUR = 3_600_000;

/** The sentence a provider gives back when the address is not on the Internet. */
const PRIVATE_SKIP =
  'Private address (RFC 1918, loopback or link-local). It is not on the Internet, '
  + 'so a reputation service would be answering about somebody else\'s machine.';

const missingKey = (label: string, field: string): string =>
  `No ${label} key. Add it in Settings → Credentials (${field}) and run the lookup again.`;

/**
 * The IP an IP-source should be asked about.
 *
 * A URL and a domain both have a host, but a host is a NAME: resolving it here
 * would mean this console picked one of the addresses behind it and presented
 * the answer as if it were about the name. The IP sources therefore answer
 * about IPs only, and say nothing rather than something approximate.
 */
const ipOnly = (o: Observable): string | null =>
  o.kind === 'ipv4' || o.kind === 'ipv6' ? o.value : null;

export const PROVIDERS: Provider[] = [
  {
    id: 'abuseipdb',
    label: 'AbuseIPDB',
    kinds: ['ipv4', 'ipv6'],
    env: 'ABUSEIPDB_APIKEY',
    signup: 'https://www.abuseipdb.com/account/api',
    purpose: 'Community abuse reports: how many people have reported this address, and for what.',
    ttlMs: 6 * HOUR,
    answers: (s) => s === 200,
    plan(o, key) {
      const ip = ipOnly(o);
      if (!ip) return { call: false, reason: 'Answers about IP addresses only.' };
      if (o.private_address) return { call: false, reason: PRIVATE_SKIP };
      if (!key) return { call: false, reason: missingKey('AbuseIPDB', 'ABUSEIPDB_APIKEY') };
      return {
        call: true,
        // NO `verbose`. It adds `countryName` — which we do not map — and a
        // `reports` array capped at TEN THOUSAND elements, downloaded and
        // parsed on every lookup only to be thrown away. `hostnames` and
        // `isTor`, the two fields worth having, are in the standard response.
        url: `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
        headers: { Key: key, Accept: 'application/json' },
        permalink: `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}`,
      };
    },
    map(body) {
      const d = obj(obj(body).data);
      return {
        abuse_confidence_score: orNull(d.abuseConfidenceScore),
        total_reports: orNull(d.totalReports),
        distinct_reporters: orNull(d.numDistinctUsers),
        last_reported_at: orNull(d.lastReportedAt),
        country_code: orNull(d.countryCode),
        isp: orNull(d.isp),
        usage_type: orNull(d.usageType),
        domain: orNull(d.domain),
        hostnames: arrayOr(d.hostnames),
        is_tor: orNull(d.isTor),
        is_whitelisted: orNull(d.isWhitelisted),
      };
    },
    read(f) {
      const out: Signal[] = [];
      const score = num(f.abuse_confidence_score);
      const reports = num(f.total_reports) ?? 0;
      // The thresholds are AbuseIPDB's own reading of its score, not invented
      // here: 100 is "certainly abusive", 25 is where its own UI starts
      // colouring the row.
      if (score !== null && score >= 75) {
        out.push({ weight: 'strong', text: `AbuseIPDB confidence ${score}% over ${reports} reports.` });
      } else if (score !== null && score >= 25) {
        out.push({ weight: 'weak', text: `AbuseIPDB confidence ${score}% over ${reports} reports.` });
      } else if (score !== null) {
        out.push({ weight: 'context', text: `AbuseIPDB confidence ${score}% (${reports} reports).` });
      }
      if (f.is_tor === true) out.push({ weight: 'weak', text: 'Known Tor exit node.' });
      if (f.is_whitelisted === true) out.push({ weight: 'context', text: 'On AbuseIPDB\'s whitelist.' });
      if (f.usage_type) out.push({ weight: 'context', text: `Usage type: ${String(f.usage_type)}.` });
      return out;
    },
  },

  {
    id: 'shodan',
    label: 'Shodan',
    kinds: ['ipv4', 'ipv6'],
    env: 'SHODAN_APIKEY',
    signup: 'https://account.shodan.io/',
    purpose: 'What this host exposes to the Internet: open ports, banners, known vulnerabilities.',
    ttlMs: 12 * HOUR,
    answers: (s) => s === 200 || s === 404, // 404 = Shodan has never scanned it.
    plan(o, key) {
      const ip = ipOnly(o);
      if (!ip) return { call: false, reason: 'Answers about IP addresses only.' };
      if (o.private_address) return { call: false, reason: PRIVATE_SKIP };
      if (!key) return { call: false, reason: missingKey('Shodan', 'SHODAN_APIKEY') };
      // THE KEY IS A QUERY PARAMETER HERE. Shodan has no header form; the
      // pipeline's enrichment node sends it as a `key:` header, which that
      // API ignores. Copying the node would have reproduced the mistake.
      // NO `minify`. It returns "the list of ports and general host information
      // with no banners" — and the CVE list lives IN the banners. The one
      // thing this paid source adds over the free InternetDB below would have
      // come back empty every time, with no error to notice. A silently
      // missing CVE is the worst failure mode this panel has; a few tens of
      // kilobytes is the cheaper side of that trade.
      return {
        call: true,
        url: `https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}`,
        headers: { Accept: 'application/json' },
        permalink: `https://www.shodan.io/host/${encodeURIComponent(ip)}`,
      };
    },
    map(body) {
      const j = obj(body);
      // A 404 arrives as `null`: Shodan simply has no record. That is an
      // answer — "not seen by Shodan" — and it must not read as a failure.
      if (body === null) return { scanned: false };
      return {
        scanned: true,
        org: orNull(j.org), isp: orNull(j.isp), asn: orNull(j.asn),
        country: orNull(j.country_name), city: orNull(j.city), os: orNull(j.os),
        open_ports: arrayOr(j.ports),
        hostnames: arrayOr(j.hostnames),
        tags: arrayOr(j.tags),
        vulns: Array.isArray(j.vulns) ? j.vulns : Object.keys(obj(j.vulns)),
        last_update: orNull(j.last_update),
      };
    },
    read(f) {
      const out: Signal[] = [];
      if (f.scanned === false) return [{ weight: 'context', text: 'Shodan has no record of this address.' }];
      const vulns = arrayOr(f.vulns);
      const ports = arrayOr(f.open_ports);
      if (vulns.length > 0) {
        out.push({
          weight: 'weak',
          // An exposed CVE is an attack SURFACE, not proof of malice: it is
          // reported as a qualifier, never as the thing that flags an address.
          text: `${vulns.length} known CVE${vulns.length > 1 ? 's' : ''} on exposed services (${vulns.slice(0, 4).join(', ')}${vulns.length > 4 ? '…' : ''}).`,
        });
      }
      if (ports.length > 0) out.push({ weight: 'context', text: `${ports.length} open port${ports.length > 1 ? 's' : ''}: ${ports.slice(0, 10).join(', ')}${ports.length > 10 ? '…' : ''}.` });
      const tags = arrayOr(f.tags).map(String);
      if (tags.length > 0) out.push({ weight: 'context', text: `Shodan tags: ${tags.join(', ')}.` });
      if (f.org) out.push({ weight: 'context', text: `Hosted by ${String(f.org)}.` });
      return out;
    },
  },

  {
    id: 'internetdb',
    label: 'Shodan InternetDB',
    kinds: ['ipv4'],
    // FREE, AND THAT IS WHY IT IS HERE. Without it a fresh install has an
    // empty Lookup tab until someone signs up for something, and a feature
    // that shows nothing on first use is a feature nobody comes back to.
    env: null,
    signup: 'https://internetdb.shodan.io/',
    purpose: 'Free, no key: open ports, hostnames and CVEs for an IPv4 address.',
    ttlMs: 12 * HOUR,
    answers: (s) => s === 200 || s === 404,
    plan(o) {
      if (o.kind !== 'ipv4') return { call: false, reason: 'Answers about IPv4 addresses only.' };
      if (o.private_address) return { call: false, reason: PRIVATE_SKIP };
      return {
        call: true,
        url: `https://internetdb.shodan.io/${encodeURIComponent(o.value)}`,
        headers: { Accept: 'application/json' },
        permalink: `https://www.shodan.io/host/${encodeURIComponent(o.value)}`,
      };
    },
    map(body) {
      if (body === null) return { scanned: false };
      const j = obj(body);
      return {
        scanned: true,
        open_ports: arrayOr(j.ports),
        hostnames: arrayOr(j.hostnames),
        tags: arrayOr(j.tags),
        vulns: arrayOr(j.vulns),
        cpes: arrayOr(j.cpes),
      };
    },
    read(f) {
      if (f.scanned === false) return [{ weight: 'context', text: 'No InternetDB record for this address.' }];
      const out: Signal[] = [];
      const vulns = arrayOr(f.vulns);
      if (vulns.length > 0) {
        out.push({ weight: 'weak', text: `${vulns.length} known CVE${vulns.length > 1 ? 's' : ''} (${vulns.slice(0, 4).join(', ')}${vulns.length > 4 ? '…' : ''}).` });
      }
      const ports = arrayOr(f.open_ports);
      if (ports.length > 0) out.push({ weight: 'context', text: `Open ports: ${ports.slice(0, 12).join(', ')}${ports.length > 12 ? '…' : ''}.` });
      return out;
    },
  },

  {
    id: 'virustotal',
    label: 'VirusTotal',
    // The only source here that answers about all five kinds — which is why
    // it is the one an install should configure first.
    kinds: ['ipv4', 'ipv6', 'domain', 'url', 'hash'],
    env: 'VIRUSTOTAL_APIKEY',
    signup: 'https://www.virustotal.com/gui/my-apikey',
    purpose: 'Seventy-odd engines\' verdict on a file, address, domain or URL, plus its reputation score.',
    ttlMs: 6 * HOUR,
    answers: (s) => s === 200 || s === 404, // 404 = never submitted to VT.
    plan(o, key) {
      if (o.kind === 'email' || o.kind === 'unknown') {
        return { call: false, reason: 'Does not answer about email addresses.' };
      }
      if (o.private_address) return { call: false, reason: PRIVATE_SKIP };
      if (!key) return { call: false, reason: missingKey('VirusTotal', 'VIRUSTOTAL_APIKEY') };
      const base = 'https://www.virustotal.com/api/v3';
      const gui = 'https://www.virustotal.com/gui';
      const route =
        o.kind === 'hash' ? { path: `files/${o.value}`, ui: `${gui}/file/${o.value}` }
        : o.kind === 'domain' ? { path: `domains/${encodeURIComponent(o.value)}`, ui: `${gui}/domain/${encodeURIComponent(o.value)}` }
        : o.kind === 'url' ? { path: `urls/${vtUrlId(o.value)}`, ui: `${gui}/url/${vtUrlId(o.value)}` }
        : { path: `ip_addresses/${encodeURIComponent(o.value)}`, ui: `${gui}/ip-address/${encodeURIComponent(o.value)}` };
      return {
        call: true,
        url: `${base}/${route.path}`,
        headers: { 'x-apikey': key, Accept: 'application/json' },
        permalink: route.ui,
      };
    },
    map(body, o) {
      if (body === null) {
        return { known: false, note: `Never submitted to VirusTotal — no engine has looked at this ${o.kind === 'hash' ? 'file' : o.kind}.` };
      }
      const a = obj(obj(obj(body).data).attributes);
      const s = obj(a.last_analysis_stats);
      const votes = obj(a.total_votes);
      return {
        known: true,
        malicious: orNull(s.malicious), suspicious: orNull(s.suspicious),
        harmless: orNull(s.harmless), undetected: orNull(s.undetected),
        reputation: orNull(a.reputation),
        community_harmless: orNull(votes.harmless),
        community_malicious: orNull(votes.malicious),
        // Only ever some of these are present; the ones that are not stay
        // absent rather than being filled with a plausible blank.
        as_owner: orNull(a.as_owner), country: orNull(a.country),
        registrar: orNull(a.registrar),
        creation_date: orNull(a.creation_date),
        last_analysis_date: orNull(a.last_analysis_date),
        meaningful_name: orNull(a.meaningful_name),
        type_description: orNull(a.type_description),
        popular_threat_label: orNull(obj(a.popular_threat_classification).suggested_threat_label),
        categories: Object.values(obj(a.categories)).map(String).slice(0, 8),
        tags: arrayOr(a.tags).map(String).slice(0, 12),
      };
    },
    read(f) {
      if (f.known === false) return [{ weight: 'context', text: String(f.note ?? 'Not known to VirusTotal.') }];
      const out: Signal[] = [];
      const mal = num(f.malicious) ?? 0;
      const sus = num(f.suspicious) ?? 0;
      const total = mal + sus + (num(f.harmless) ?? 0) + (num(f.undetected) ?? 0);
      // THREE ENGINES, NOT ONE. A single detection out of seventy is the
      // industry's most common false positive, and flagging on it would train
      // an operator to ignore this panel — which is worse than not having it.
      if (mal >= 3) out.push({ weight: 'strong', text: `${mal} of ${total} engines call it malicious.` });
      else if (mal + sus > 0) out.push({ weight: 'weak', text: `${mal} malicious, ${sus} suspicious out of ${total} engines — below the 3-engine bar, treat as a lead.` });
      else if (total > 0) out.push({ weight: 'context', text: `No detection: 0 of ${total} engines.` });
      if (f.popular_threat_label) out.push({ weight: 'strong', text: `Threat label: ${String(f.popular_threat_label)}.` });
      const rep = num(f.reputation);
      if (rep !== null && rep <= -20) out.push({ weight: 'weak', text: `Community reputation ${rep}.` });
      const cats = arrayOr(f.categories).map(String);
      if (cats.length > 0) out.push({ weight: 'context', text: `Categories: ${[...new Set(cats)].join(', ')}.` });
      return out;
    },
  },

  {
    id: 'hibp_breaches',
    label: 'Have I Been Pwned — breaches',
    kinds: ['email'],
    env: 'HIBP_APIKEY',
    signup: 'https://haveibeenpwned.com/API/Key',
    purpose: 'Which public breaches contain this address, when, and what data classes leaked.',
    // Breach corpora change on the scale of days. An hour is short enough to
    // pick up a fresh one and long enough that re-checking an address during
    // one investigation does not spend the quota twice.
    ttlMs: HOUR,
    answers: (s) => s === 200 || s === 404, // 404 = in no breach. The good news.
    plan(o, key) {
      if (o.kind !== 'email') return { call: false, reason: 'Answers about email addresses only.' };
      if (!key) return { call: false, reason: missingKey('Have I Been Pwned', 'HIBP_APIKEY') };
      return {
        call: true,
        url: `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(o.value)}?truncateResponse=false`,
        headers: hibpHeaders(key),
        permalink: `https://haveibeenpwned.com/account/${encodeURIComponent(o.value)}`,
      };
    },
    map(body) {
      const list = Array.isArray(body) ? body : [];
      const breaches = list.map((b) => {
        const e = obj(b);
        return {
          name: String(e.Title ?? e.Name ?? '?'),
          domain: orNull(e.Domain),
          breach_date: orNull(e.BreachDate),
          added_date: orNull(e.AddedDate),
          pwn_count: orNull(e.PwnCount),
          data_classes: arrayOr(e.DataClasses).map(String),
          verified: e.IsVerified === true,
          sensitive: e.IsSensitive === true,
          malware: e.IsMalware === true,
          stealer_log: e.IsStealerLog === true,
        };
      });
      const classes = new Set<string>();
      for (const b of breaches) for (const dc of b.data_classes) classes.add(dc);
      // Sorted newest first: "when was it last exposed" is the question, and
      // an unordered list makes the reader do that sort by hand.
      breaches.sort((a, b) => String(b.breach_date ?? '').localeCompare(String(a.breach_date ?? '')));
      return {
        breach_count: breaches.length,
        breaches: breaches.slice(0, 60),
        data_classes: [...classes].sort(),
        passwords_exposed: [...classes].some((c) => /password/i.test(c)),
        latest_breach: breaches[0]?.breach_date ?? null,
      };
    },
    read(f) {
      const n = num(f.breach_count) ?? 0;
      if (n === 0) return [{ weight: 'context', text: 'This address appears in no known breach.' }];
      const out: Signal[] = [{
        weight: f.passwords_exposed === true ? 'strong' : 'weak',
        text: `Found in ${n} breach${n > 1 ? 'es' : ''}${f.latest_breach ? `, most recent ${String(f.latest_breach)}` : ''}.`,
      }];
      if (f.passwords_exposed === true) {
        out.push({ weight: 'strong', text: 'Passwords were among the leaked data classes: treat any reuse as compromised.' });
      }
      const classes = arrayOr(f.data_classes).map(String);
      if (classes.length > 0) out.push({ weight: 'context', text: `Data classes: ${classes.slice(0, 10).join(', ')}${classes.length > 10 ? '…' : ''}.` });
      return out;
    },
  },

  {
    id: 'hibp_stealer',
    label: 'Have I Been Pwned — stealer logs',
    kinds: ['email'],
    env: 'HIBP_APIKEY',
    signup: 'https://haveibeenpwned.com/API/Key',
    purpose: 'Sites this address was captured signing into by infostealer malware — a live-credential signal.',
    ttlMs: HOUR,
    // 404 = not in any stealer log. A 403 is deliberately NOT listed: this
    // endpoint needs a subscription tier the breach endpoint does not, so a
    // 403 here IS a source that could not answer — but for a reason that is
    // the plan and not the key, which is what `explainStatus` says.
    answers: (s) => s === 200 || s === 404,
    plan(o, key) {
      if (o.kind !== 'email') return { call: false, reason: 'Answers about email addresses only.' };
      if (!key) return { call: false, reason: missingKey('Have I Been Pwned', 'HIBP_APIKEY') };
      return {
        call: true,
        url: `https://haveibeenpwned.com/api/v3/stealerlogsbyemail/${encodeURIComponent(o.value)}`,
        headers: hibpHeaders(key),
        permalink: `https://haveibeenpwned.com/account/${encodeURIComponent(o.value)}`,
      };
    },
    map(body) {
      const domains = (Array.isArray(body) ? body : []).map(String);
      return { domain_count: domains.length, domains: domains.slice(0, 60) };
    },
    read(f) {
      const n = num(f.domain_count) ?? 0;
      if (n === 0) return [{ weight: 'context', text: 'Not seen in any stealer log.' }];
      return [{
        // Stronger than a breach: a stealer log means malware ran on a machine
        // this person used, and captured a session as it was being used.
        weight: 'strong',
        text: `Captured by infostealer malware against ${n} site${n > 1 ? 's' : ''} (${arrayOr(f.domains).slice(0, 5).map(String).join(', ')}${n > 5 ? '…' : ''}).`,
      }];
    },
  },

  {
    id: 'hibp_pastes',
    label: 'Have I Been Pwned — pastes',
    kinds: ['email'],
    env: 'HIBP_APIKEY',
    signup: 'https://haveibeenpwned.com/API/Key',
    purpose: 'Public paste sites where this address has been dumped.',
    ttlMs: HOUR,
    answers: (s) => s === 200 || s === 404,
    plan(o, key) {
      if (o.kind !== 'email') return { call: false, reason: 'Answers about email addresses only.' };
      if (!key) return { call: false, reason: missingKey('Have I Been Pwned', 'HIBP_APIKEY') };
      return {
        call: true,
        url: `https://haveibeenpwned.com/api/v3/pasteaccount/${encodeURIComponent(o.value)}`,
        headers: hibpHeaders(key),
        permalink: `https://haveibeenpwned.com/account/${encodeURIComponent(o.value)}`,
      };
    },
    map(body) {
      const list = (Array.isArray(body) ? body : []).map((p) => {
        const e = obj(p);
        return {
          source: String(e.Source ?? '?'),
          title: orNull(e.Title),
          date: orNull(e.Date),
          email_count: orNull(e.EmailCount),
        };
      });
      return { paste_count: list.length, pastes: list.slice(0, 40) };
    },
    read(f) {
      const n = num(f.paste_count) ?? 0;
      return n === 0
        ? [{ weight: 'context', text: 'Not found in any indexed paste.' }]
        : [{ weight: 'weak', text: `Appears in ${n} paste${n > 1 ? 's' : ''}.` }];
    },
  },
];

/**
 * The two headers HIBP requires, and the one it refuses requests without.
 *
 * `user-agent` is not politeness: HIBP answers **403** to a request that does
 * not carry one, and a 403 next to an api-key header reads as "your key is
 * wrong" — sending someone to regenerate a key that was always fine.
 */
function hibpHeaders(key: string): Record<string, string> {
  return { 'hibp-api-key': key, 'user-agent': 'MENATER-SOC-Console', Accept: 'application/json' };
}

/** The providers that have anything to say about this kind of observable. */
export const providersFor = (kind: ObservableKind): Provider[] =>
  PROVIDERS.filter((p) => p.kinds.includes(kind));

/** Every kind at least one provider covers — what the UI offers to force. */
export const SUPPORTED_KINDS: ObservableKind[] =
  ['ipv4', 'ipv6', 'domain', 'url', 'hash', 'email'];
