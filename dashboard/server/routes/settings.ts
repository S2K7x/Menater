/**
 * Settings, credentials, and the two connectivity probes.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import { invalidate } from '../snapshot.ts';
import {
  CredentialError, describeCredentials, saveCredentials } from '../credentials.ts';
import {
  connectionString, getConfig, hashPassword,
  publicView, saveConfig } from '../config.ts';
import { normalizeInventory } from '../inventory.ts';
import { tcpProbe } from '../probes.ts';
import type { Ctx } from './context.ts';

export async function settingsRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, am } = c;

    // --- Reglages ----------------------------------------------------------
    if (req.method === 'GET' && path === '/api/settings') {
      return json(res, 200, {
        settings: publicView(),
        connection_string: connectionString(true) });
    }

    if (req.method === 'PUT' && path === '/api/settings') {
      const body = await readBody(req);

      // The password arrives in clear exactly once, here, and is never stored
      // as such: only a scrypt derivation of it is kept.
      if (typeof body?.auth?.password === 'string' && body.auth.password !== '') {
        const { salt, hash } = hashPassword(body.auth.password);
        body.auth = { ...body.auth, salt, hash };
      }
      if (body?.auth) delete body.auth.password;

      // Enabling the lock with no password would shut the user out.
      if (body?.auth?.enabled === true && !body?.auth?.hash && getConfig().auth.hash === '') {
        return json(res, 400, {
          error: am.passwordFirst });
      }

      /**
       * J0.3 — the inventory is checked BEFORE it is stored.
       *
       * `saveConfig` would happily write whatever shape arrives, and the
       * console would then show a table it cannot resolve — the "the API
       * trusted the shape of its body" trap, on a list this time. The caller
       * gets the reason and the field, not a 500 carrying an internal
       * message.
       */
      if (body?.inventory !== undefined) {
        // A BARE ARRAY IS REFUSED, not ignored. `merge` would spread it over
        // the stored section and change nothing at all — a save that reports
        // success and applies none of what was sent.
        const shape = body.inventory;
        const problems = (shape === null || typeof shape !== 'object' || Array.isArray(shape))
          ? [{ field: 'inventory', detail: 'Send the list as { "entries": [ … ] }.' }]
          : normalizeInventory(shape.entries).problems;
        if (problems.length > 0) {
          return json(res, 400, {
            error: am.inventoryRefused(problems.map((p) => `${p.field}: ${p.detail}`)),
            problems });
        }
      }

      saveConfig(body);
      invalidate();
      return json(res, 200, {
        settings: publicView(),
        connection_string: connectionString(true) });
    }

    /**
     * Pipeline credentials. Effective IMMEDIATELY — `secretFor()` reads
     * `process.env` at call time, so the next alert uses the new key.
     *
     * Kept OUT of `/api/settings` on purpose: `config.json` is written by
     * `saveConfig` on every settings save, and a credential that lives there
     * would be rewritten by anyone who changes a refresh interval. This store
     * has its own file, its own 0600, and its own closed list.
     */
    if (req.method === 'GET' && path === '/api/credentials') {
      return json(res, 200, { credentials: describeCredentials() });
    }

    if (req.method === 'PUT' && path === '/api/credentials') {
      const body = await readBody(req);
      try {
        // Empty KEEPS, `null` erases — the same rule as every other secret
        // field in this console.
        return json(res, 200, { credentials: saveCredentials(body ?? {}) });
      } catch (err) {
        if (err instanceof CredentialError) {
          return json(res, 409, { error: err.message, key: err.key });
        }
        throw err;
      }
    }

    if (req.method === 'POST' && path === '/api/settings/test/database') {
      const body = await readBody(req);
      const d = getConfig().database;
      const host = String(body.host ?? d.host).trim();
      const port = Number(body.port ?? d.port);
      if (!host) return json(res, 400, { ok: false, detail: am.hostMissing });
      const probe = await tcpProbe(host, port);
      return json(res, 200, {
        ok: probe.ok,
        detail: probe.ok ? `${probe.detail} (${probe.ms} ms)` : probe.detail,
        // Honesty: reaching the port proves neither the credentials nor that
        // the tables exist. The console has no Postgres driver.
        caveat: probe.ok ? am.portCaveat : undefined });
    }

      return false;
}
