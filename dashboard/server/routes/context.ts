/**
 * What a route group is handed, and what it answers.
 *
 * ============================================================================
 * THE CONTRACT
 *
 * A group receives the request already parsed and already authorised, and
 * answers `true` if it dealt with it, `false` if none of its branches matched.
 * `json()` returns `true` for exactly this reason: a branch says "handled" by
 * writing `return json(...)`, which is what every branch already did when they
 * all lived in one function.
 *
 * ORDER IS PART OF THE BEHAVIOUR. The groups are tried in the order `app.ts`
 * lists them, because some paths are only distinguishable by which pattern is
 * tested first — `/api/rules/test` must be seen before `/api/rules/:id`, and
 * the ingestion routes carry a regex that a later group would also match.
 * Sorting that list alphabetically would change what the server does.
 * ============================================================================
 */

import type { messages } from '../i18n.ts';
import type { Locale } from '../i18n.ts';

export interface Ctx {
  req: any;
  res: any;
  url: URL;
  path: string;
  /** Language asked for by the client; the server writes sentences too. */
  locale: Locale;
  /** `messages(locale).api` — the catalogue this request answers in. */
  am: ReturnType<typeof messages>['api'];
  /** Session cookie, if one was sent. */
  token: string | null;
  /** Caller address, for the login throttle. */
  ip: string;
}

/** `true` when the group answered the request. */
export type RouteGroup = (c: Ctx) => Promise<boolean>;
