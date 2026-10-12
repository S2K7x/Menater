/**
 * C1.1 — the screen you are on, in the address bar.
 *
 * ============================================================================
 * WHY THE FRAGMENT AND NOT THE PATH
 *
 * A fragment is **never sent to the server**. That is not a detail here: the
 * reason somebody wants this feature is to paste a console link into a chat
 * message or a ticket, and a path would put the screen they were on — later,
 * the alert they were on — into every access log and proxy log between the two
 * of them. The console answers everything it knows under `/api/`, so a
 * fragment also needs no server change at all: `requiresAuth`'s
 * `/^\/api(\/|$)/` subtraction and `serveStatic` both see `/`, whichever
 * screen the URL names.
 *
 * ============================================================================
 * THE TABLE IS THE TYPE
 *
 * `Tab` is the keys of `TAB_SLUGS`, so a tab with no slug does not compile and
 * a slug naming no tab cannot be written. This project has paid repeatedly for
 * a declaration checked in one direction only — a node id list asserted to
 * exist in the workflows while nothing asserted the reverse, a prompt naming
 * seven of fourteen tools — so the pairing is held by the compiler rather than
 * by a test. What a test still has to claim is UNIQUENESS: two tabs sharing a
 * slug type-checks perfectly and makes one of them unreachable by link.
 *
 * ============================================================================
 * THE SLUGS FOLLOW THE LABELS, AND ARE FROZEN HERE RATHER THAN READ
 *
 * A URL is read and typed by people, so `#/lookup` and not `#/intel`,
 * `#/tracking` and not `#/trace`, `#/alerts` and not `#/queue` — the internal
 * ids are a decade of this codebase's own history and name nothing an operator
 * sees. They are nevertheless written out here instead of taken from
 * `i18n/console.ts`: a label is the one thing in this product that is allowed
 * to be reworded, and a bookmark must not move when somebody improves a word.
 * ============================================================================
 */

/** Every tab, and the word that names it in a URL. */
export const TAB_SLUGS = {
  queue: 'alerts',
  code: 'code',
  ingestion: 'ingestion',
  rules: 'rules',
  trace: 'tracking',
  metrics: 'metrics',
  health: 'health',
  intel: 'lookup',
  docs: 'guide',
  settings: 'settings',
} as const;

export type Tab = keyof typeof TAB_SLUGS;

/**
 * Where the console opens, and where a fragment it cannot read lands.
 *
 * Not an invented default: it is the screen this console has always opened on.
 */
export const DEFAULT_TAB: Tab = 'queue';

const BY_SLUG: Map<string, Tab> = new Map(
  (Object.keys(TAB_SLUGS) as Tab[]).map((tab) => [TAB_SLUGS[tab], tab]),
);

/** The canonical fragment for a tab. One spelling, so one URL to compare against. */
export function routeHash(tab: Tab): string {
  return `#/${TAB_SLUGS[tab]}`;
}

/**
 * The tab a fragment names, or `null` when it names none.
 *
 * `null` is the honest answer and the caller decides what to do with it — it
 * covers an empty fragment (the ordinary first visit), a typo, and a link from
 * a version that carries more than this one understands. What it deliberately
 * does NOT do is read the first segment of `#/alerts/1234` as `alerts`: this
 * version does not carry the open incident, and answering a link it does not
 * fully understand with the half it recognises is the kind of guess § 8
 * refuses. A `null` is corrected in the address bar; a half-obeyed link would
 * leave the sender believing the other person is looking at an alert.
 *
 * Tolerant about the three things a URL survives being copied by hand — a
 * missing slash, a trailing one, and capitals — and about nothing else.
 */
export function parseRoute(hash: string): Tab | null {
  const slug = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  return BY_SLUG.get(slug) ?? null;
}
