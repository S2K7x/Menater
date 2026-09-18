/**
 * The triage queue and one incident card.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json } from '../respond.ts';
import { snapshot } from '../snapshot.ts';
import type { Ctx } from './context.ts';

export async function casesRoutes(c: Ctx): Promise<boolean> {
  const { req, res, url, path, locale, am } = c;

    if (req.method === 'GET' && path === '/api/snapshot') {
      // THE CACHED OBJECT ITSELF, not a copy of it. `json()` encodes a body
      // once per object identity, and the snapshot is the same object for
      // every caller until it is rebuilt — spreading it here to bolt on
      // `refresh_seconds` produced a new object per request and paid for the
      // serialisation and the gzip again every time. The cadence is on the
      // snapshot now; see `withRefreshRate`.
      const snap = await snapshot(locale, url.searchParams.get('force') === '1');
      return json(res, 200, snap);
    }

    if (req.method === 'GET' && path.startsWith('/api/cases/')) {
      const id = decodeURIComponent(path.slice('/api/cases/'.length));
      const snap = await snapshot(locale);
      const found = snap.cases.find((c) => c.alert_id === id);
      if (!found) return json(res, 404, { error: am.caseNotFound(id) });
      return json(res, 200, found);
    }

      return false;
}
