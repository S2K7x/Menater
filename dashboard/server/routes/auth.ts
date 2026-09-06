/**
 * Access lock: who may open the console at all.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import {
  getConfig, verifyPassword } from '../config.ts';
import {
  clearCookie, createSession, destroySession, isValidSession, recordFailure, recordSuccess, sessionCookie, throttle } from '../auth.ts';
import type { Ctx } from './context.ts';

export async function authRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, am, token, ip } = c;

    if (req.method === 'GET' && path === '/api/auth/status') {
      const c = getConfig();
      return json(res, 200, {
        enabled: c.auth.enabled,
        password_set: c.auth.hash !== '',
        authenticated: !c.auth.enabled || isValidSession(token) });
    }

    if (req.method === 'POST' && path === '/api/auth/login') {
      const t = throttle(ip);
      if (t.blocked) return json(res, 429, { error: am.tooManyAttempts(t.retryInSeconds) });
      const body = await readBody(req);
      if (!verifyPassword(String(body.password ?? ''))) {
        recordFailure(ip);
        // Identical message whatever the reason: never reveal whether a
        // password is configured or merely wrong.
        return json(res, 401, { error: am.wrongPassword });
      }
      recordSuccess(ip);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(createSession()) });
    }

    if (req.method === 'POST' && path === '/api/auth/logout') {
      destroySession(token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }


  return false;
}
