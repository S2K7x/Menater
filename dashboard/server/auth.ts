/**
 * Authentification de la console.
 *
 * ============================================================================
 * CE QUE CETTE AUTHENTIFICATION EST, ET CE QU'ELLE N'EST PAS
 *
 * C'est un verrou SIMPLE : un mot de passe unique, une session en memoire. Il
 * repond a « la console ne doit pas etre ouverte a quiconque atteint l'URL »,
 * qui etait jusqu'ici une limite assumee.
 *
 * Il ne repond PAS a « qui a approuve cette isolation ». Un mot de passe partage
 * n'identifie personne : l'identite de l'approbateur reste declarative, et
 * l'interface continue de le dire. Confondre les deux serait pire que ne rien
 * avoir, parce qu'on croirait avoir une piste d'audit nominative.
 *
 * Les sessions vivent en memoire : redemarrer le serveur deconnecte tout le
 * monde. C'est voulu — pas de jeton persiste sur disque a exfiltrer.
 * ============================================================================
 */

import { randomBytes } from 'node:crypto';
import { getConfig } from './config.ts';

const COOKIE = 'menater_session';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 h : une garde SOC, pas un mois

const sessions = new Map<string, number>();

function sweep() {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
}

export function createSession(): string {
  sweep();
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + TTL_MS);
  return token;
}

export function destroySession(token: string | null) {
  if (token) sessions.delete(token);
}

export function readCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=') || null;
  }
  return null;
}

export function isValidSession(token: string | null): boolean {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function sessionCookie(token: string): string {
  // HttpOnly : inaccessible au JavaScript de la page, donc inexploitable par une
  // injection dans un champ de la console. Pas de Secure : l'instance tourne en
  // HTTP sur un reseau interne, et un cookie Secure ne serait jamais envoye.
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Routes joignables sans session de console.
 *
 * The first three, or logging in would be impossible.
 *
 * THE FOURTH IS NOT "PUBLIC", and the word would be dangerous here: the alert
 * entry point carries its OWN authentication — a shared secret, checked in
 * constant time, without which it refuses to serve. An appliance emitting an
 * alert has no browser session; putting it behind the human lock would make
 * ingestion impossible the moment the console is protected, and would push
 * someone to switch one of the two off.
 */
const PUBLIC_ROUTES = new Set([
  '/api/auth/status', '/api/auth/login', '/api/auth/logout',
  '/api/webhook/soc/alert',
  // THE FIFTH, and "public" is just as wrong a word for it. An MCP client is
  // not a browser and has no session cookie — putting it behind the human lock
  // would make the endpoint unusable the moment the console is protected, which
  // is the same argument as for the alert entry point above. It carries its own
  // bearer token, compared in constant time, and it is off by default.
  '/api/mcp',
]);

/**
 * The per-source entry points, N4's replacement for the single webhook above.
 *
 * THIS WAS A DEFECT, and it showed nowhere. `PUBLIC_ROUTES` is an exact-match
 * set and N4 added `/api/ingest/:source` beside the legacy path without adding
 * it here — so the moment someone set a console password, every Wazuh agent
 * started getting `401` with a JSON body about signing in, at an endpoint that
 * authenticates with a shared secret and has never had a session cookie. The
 * argument in the comment above applies to these paths word for word.
 *
 * `/api/ingest/sources` is NOT in it: that one hands out the install snippets
 * an operator reads, it is part of the console, and it stays behind the lock.
 * The control plane lives under `/api/ingestion/` precisely so that this
 * pattern can stay a single unambiguous shape.
 */
const INGEST_PATH = /^\/api\/ingest\/(?!sources$)[a-z0-9-]+$/;

/**
 * The API's namespace — and therefore, by subtraction, the interface's.
 *
 * THE LOCK GUARDS DATA, NOT THE PAGE THAT ASKS FOR IT. Everything this console
 * knows is answered under `/api/`; a path outside it can only be served by
 * `serveStatic`, which refuses `/api/` by itself and cannot leave its root. So
 * the files of the built interface — `index.html`, the fingerprinted bundle,
 * the stylesheet, and every navigation route that falls back to the shell —
 * carry nothing an unauthenticated visitor could not already read in this
 * repository, and they are served without a session.
 *
 * THIS WAS A DEFECT, and it was the lock locking the operator out. The login
 * form is a React component INSIDE that bundle (`LoginScreen` in
 * `src/App.tsx`), so while `requiresAuth` answered `true` for `/`, setting a
 * console password made the console unopenable: a fresh browser got
 * `401 {"error":"Authentication required."}` instead of a page, and — sessions
 * living in memory — a container restart did the same to everyone already in.
 * The way out was to edit `config.json` on disk.
 *
 * It showed nowhere because it could not show in development: there Vite
 * serves the interface and only the `/api` calls ever reach this function.
 * Exactly the shape of the `/api/*`-served-the-SPA defect in CLAUDE.md, whose
 * note reads "only broken in Docker, for want of a `dist/` to serve".
 *
 * The subtraction is deliberately the whole rule rather than a list of file
 * names: a list is the exact-match set that already cost this project the
 * ingestion endpoints, one Vite output away from going stale.
 */
const API_NAMESPACE = /^\/api(\/|$)/;

export function requiresAuth(path: string): boolean {
  if (!getConfig().auth.enabled) return false;
  if (!API_NAMESPACE.test(path)) return false;
  if (INGEST_PATH.test(path)) return false;
  return !PUBLIC_ROUTES.has(path);
}

/**
 * Limitation des tentatives. Un mot de passe unique sur un reseau interne reste
 * devinable si l'on peut essayer mille fois par seconde.
 *
 * AND AN ADDRESS THAT HAS GONE QUIET IS FORGOTTEN. That half was missing, and
 * it was missing in the single field this record has: `until` was written only
 * when a streak REACHED the lock, so a record carrying 1 to 7 failures had no
 * expiry instant at all and nothing in this module could remove it —
 * `throttle` deleted a record only when its `until` was non-zero, and `sweep()`
 * above walks `sessions`, a different table. Two costs followed, and the
 * second needs no attacker at all.
 *
 * `/api/auth/login` is in `PUBLIC_ROUTES` because otherwise nobody could ever
 * log in, so ONE unauthenticated request with a wrong password bought a
 * permanent entry: measured on this module at 129 B an entry, 200,000
 * addresses cost 24.7 MiB, and calling `throttle` on every one of them — the
 * only function here that deletes anything — reclaimed 0%. Only a restart did.
 *
 * And the streak never decayed, so it accumulated across the life of the
 * install: eight typos spread over seven months, one a month, on a console
 * nobody was attacking, answered `blocked, 300 s`. A counter that drifts
 * towards a lockout is not a stronger throttle, and this one guards the
 * console's own front door — see CLAUDE.md's « the lock that locked the
 * operator out », one function over.
 *
 * So `until` now means ONE thing for both shapes of record — the instant after
 * which this record carries nothing — and being locked is `count >=
 * MAX_ATTEMPTS` rather than a second field. There is no longer a state in
 * which a record is live and undated.
 *
 * The rule was already written one directory away: `routes/intel.ts` keys its
 * own per-address budget this way and sweeps it, under a comment naming THIS
 * throttle as the sibling it inherited the shared-bucket property from. The
 * mirror of a rule is not the rule.
 */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60 * 1000;

/**
 * How long one failure goes on counting towards the next lock.
 *
 * It is a POLICY NUMBER and not a measured maximum, so what has to be checked
 * is that forgetting cannot make anybody faster than this design already is.
 * The lock permits 8 guesses per 5 minutes per address — 2,304 a day — and
 * always did, because a lapsed lock was already deleted outright. Pacing
 * slower than this window to avoid the lock entirely therefore costs an
 * attacker everything above 24 guesses a day: a 96x slowdown on a password
 * stored with scrypt. Shorter would work and hands that order of magnitude
 * back; longer starts counting last week's typos again, which is the half
 * above.
 */
const STREAK_MS = 60 * 60 * 1000;

/**
 * Housekeeping, driven by the work that CREATES the entries rather than by a
 * timer: a clean-up postponed far enough is a clean-up that does not happen,
 * and the table only ever grows in `recordFailure`.
 *
 * Two properties, and both are arguments rather than details.
 *
 * It deletes only what has genuinely EXPIRED. A cap that evicted "the oldest"
 * would hand an attacker the way to flush their own lock — spray addresses
 * until the record holding their block is the one dropped — so the table is
 * allowed to exceed this floor instead of throwing away a record still in use.
 * Memory is cheaper than a throttle that reports it is throttling somebody it
 * has just forgotten.
 *
 * And it scans at most once per STREAK_MS. Nothing here expires sooner than
 * that window except a lapsed lock, which `throttle` deletes the moment that
 * address comes back, so scanning more often cannot reclaim more. Under a
 * spray it would reclaim NOTHING, because every record is then still inside
 * its window — holding one window's worth of addresses is what this table is
 * for. A size-triggered scan would have been pure work bought with the leak's
 * own money.
 */
const SWEEP_FLOOR = 512;
let lastSweptAt = 0;

function forgetQuietAddresses(now: number) {
  if (attempts.size < SWEEP_FLOOR || now - lastSweptAt < STREAK_MS) return;
  for (const [addr, rec] of attempts) if (rec.until <= now) attempts.delete(addr);
  lastSweptAt = now;
}

export function throttle(ip: string, now = Date.now()): { blocked: boolean; retryInSeconds: number } {
  const rec = attempts.get(ip);
  if (!rec) return { blocked: false, retryInSeconds: 0 };
  // Expired is expired whichever shape it is: a lapsed lock and a streak that
  // has gone quiet are both records carrying nothing, and the second one is
  // the shape this used to keep for ever.
  if (rec.until <= now) {
    attempts.delete(ip);
    return { blocked: false, retryInSeconds: 0 };
  }
  if (rec.count < MAX_ATTEMPTS) return { blocked: false, retryInSeconds: 0 };
  return { blocked: true, retryInSeconds: Math.ceil((rec.until - now) / 1000) };
}

export function recordFailure(ip: string, now = Date.now()) {
  const prev = attempts.get(ip);
  const rec = prev && prev.until > now ? prev : { count: 0, until: 0 };
  rec.count += 1;
  rec.until = now + (rec.count >= MAX_ATTEMPTS ? LOCK_MS : STREAK_MS);
  attempts.set(ip, rec);
  forgetQuietAddresses(now);
}

export function recordSuccess(ip: string) {
  attempts.delete(ip);
}

/**
 * Exposed for the tests, and for nothing else.
 *
 * The bound this module keeps is a statement about the TABLE, and a test that
 * cannot see the table can only assert the lazy delete in `throttle` — the one
 * half that was never the leak. `routes/intel.ts` exports `resetIntelThrottle`
 * for the same reason: a throttle is module state, so a test that does not
 * start from a clean budget is reading the previous test's.
 */
export const resetThrottle = (): void => { attempts.clear(); lastSweptAt = 0; };
export const throttleRecordCount = (): number => attempts.size;
