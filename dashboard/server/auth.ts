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

export function requiresAuth(path: string): boolean {
  if (!getConfig().auth.enabled) return false;
  if (INGEST_PATH.test(path)) return false;
  return !PUBLIC_ROUTES.has(path);
}

/**
 * Limitation des tentatives. Un mot de passe unique sur un reseau interne reste
 * devinable si l'on peut essayer mille fois par seconde.
 */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60 * 1000;

export function throttle(ip: string): { blocked: boolean; retryInSeconds: number } {
  const rec = attempts.get(ip);
  if (!rec) return { blocked: false, retryInSeconds: 0 };
  if (rec.until > Date.now()) {
    return { blocked: true, retryInSeconds: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  if (rec.until && rec.until <= Date.now()) attempts.delete(ip);
  return { blocked: false, retryInSeconds: 0 };
}

export function recordFailure(ip: string) {
  const rec = attempts.get(ip) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.until = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

export function recordSuccess(ip: string) {
  attempts.delete(ip);
}
