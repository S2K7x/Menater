/**
 * J0.3 — which repository runs on the machine an alert is about.
 *
 * ============================================================================
 * WHY A DECLARED TABLE, AND NOT A GUESS
 *
 * The roadmap's § 2 states the problem in one line: *nothing says which
 * repository runs on `10.12.4.31`*. Everything the console holds about an
 * asset is an address or a hostname, and everything the code analysis holds is
 * a folder or a repository URL. There is no function from one to the other —
 * there is only what an operator knows about their own estate.
 *
 * So this is a table someone fills in, and the matching is EXACT. No CIDR
 * range, no suffix rule, no "`web-01` looks like `web-01.corp.lan`". Deriving
 * a repository from a resemblance would be the invented default § 8 forbids,
 * and it would be invented in the worst possible place: the answer sends
 * somebody to read the wrong code while an incident is open.
 *
 * ============================================================================
 * AN AMBIGUITY IS REFUSED AT THE DOOR, NOT RESOLVED LATER
 *
 * If one identifier appeared under two entries, a resolver would have to pick
 * one — and "the first one" is a coin toss dressed as an answer. The
 * validation refuses the save instead, naming the identifier. The inventory
 * therefore cannot hold an ambiguity, so the resolver never has to invent a
 * tie-break.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT DO
 *
 * It resolves; it never acts. The match is displayed on the incident card and
 * pre-fills the code-analysis target — a human still presses Launch. Starting
 * a scan because an alert arrived would be an outward action taken with no
 * approval, on a target read out of a settings file.
 * ============================================================================
 */

import type { CaseRepository, InventoryEntry } from '../src/lib/types.ts';

/**
 * `InventoryEntry` is declared in `src/lib/types.ts`, with the other shapes
 * both halves read — the console's convention. Two notes belong here, next to
 * the code that enforces them:
 *
 *  - `identifiers` are compared case-insensitively after trimming, and
 *    nothing else. A hostname is compared to a hostname, an address to an
 *    address; nothing is parsed, expanded or ranged.
 *  - `repository` is NOT checked against the analysis service's three target
 *    forms. That vocabulary belongs to `scan-target.ts` on the other side, and
 *    a second copy of it here would be one more thing to keep in step. What
 *    this stores is a string an operator typed, and what the console does with
 *    it is put it in a form.
 */
export type { InventoryEntry };

/**
 * The observables this table can match on — the inventory's half of
 * `CaseRepository['matched_on']`.
 *
 * `scan_target` is the other half and is deliberately excluded: it is not an
 * observable, nothing here can produce it, and it is answered one layer up by
 * `scanRepository` in `server/findings.ts`. Written as an `Extract` rather
 * than as its own list so that a member removed from the type cannot go on
 * living here.
 */
export type MatchField = Extract<
  CaseRepository['matched_on'], 'host' | 'dest_ip' | 'source_ip'
>;

/** Same shape as `validateRule`'s: the caller learns which field, and why. */
export interface InventoryProblem {
  field: string;
  detail: string;
}

/**
 * Bounds. An inventory is typed by a person, so these are generous — they
 * exist to stop a body from growing the config file without limit, not to
 * ration a real estate.
 */
export const MAX_ENTRIES = 200;
export const MAX_IDENTIFIERS = 20;
/**
 * Long enough that no real hostname or repository path reaches it, and an
 * over-length value is REPORTED rather than quietly shortened: a truncated
 * path fails later, in the launcher, saying nothing about what cut it.
 */
export const MAX_TEXT = 400;

/** The comparison key. Hostnames are case-insensitive; so are hex addresses. */
const key = (value: string): string => value.trim().toLowerCase();

/**
 * One field, trimmed and bounded — and the sentence that says it was cut.
 *
 * A non-string becomes `''`, which the checks below then refuse by name. That
 * is deliberate: `service: 42` should read as "name the service", not as a
 * type error nobody can act on.
 */
function checked(
  value: unknown, field: string, problems: InventoryProblem[],
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > MAX_TEXT) {
    problems.push({ field, detail: `Longer than ${MAX_TEXT} characters.` });
  }
  return trimmed.slice(0, MAX_TEXT);
}

/**
 * The observables that can name one of OUR machines, in the order they are
 * tried.
 *
 * `host` is the machine the detection is about, so it answers directly.
 * `dest_ip` is the address that was reached — our side of a connection, when
 * a detection records one. `source_ip` is usually the other end, and matching
 * it is only meaningful when that other end is also ours, which is exactly
 * what lateral movement looks like; it is tried LAST, and because the match
 * always says which observable produced it, nobody is told "this alert is
 * about repository X" without being told why.
 */
const MATCH_ORDER: MatchField[] = ['host', 'dest_ip', 'source_ip'];

/**
 * `—` is the console's DISPLAY value for an address a detection did not
 * record. Reading it as data would let a single inventory entry named `—`
 * match every alert that carries no address at all.
 */
const observable = (value: string | null | undefined): string | null => {
  const v = (value ?? '').trim();
  if (v === '' || v === '—') return null;
  return v;
};

/**
 * The shape a caller sent, checked before it reaches the config file.
 *
 * Returns what it could read AND everything wrong with it, rather than
 * throwing on the first problem: someone fixing a pasted inventory wants the
 * list, not one line per round trip. `problems` non-empty means the caller
 * must be refused — see the settings route.
 */
export function normalizeInventory(
  input: unknown,
): { entries: InventoryEntry[]; problems: InventoryProblem[] } {
  const problems: InventoryProblem[] = [];

  if (input === undefined || input === null) return { entries: [], problems };
  if (!Array.isArray(input)) {
    return {
      entries: [],
      problems: [{ field: 'inventory', detail: 'The inventory must be a list of entries.' }],
    };
  }
  if (input.length > MAX_ENTRIES) {
    problems.push({ field: 'inventory', detail: `At most ${MAX_ENTRIES} entries.` });
  }

  const entries: InventoryEntry[] = [];
  /** Identifier key → the index of the entry that already claimed it. */
  const claimed = new Map<string, number>();

  for (const [i, raw] of input.slice(0, MAX_ENTRIES).entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push({ field: `inventory.${i}`, detail: 'An entry must be an object.' });
      continue;
    }
    const row = raw as Record<string, unknown>;
    const service = checked(row.service, `inventory.${i}.service`, problems);
    const repository = checked(row.repository, `inventory.${i}.repository`, problems);

    if (service === '') {
      problems.push({
        field: `inventory.${i}.service`,
        detail: 'Name the service. It is what the incident card will show.',
      });
    }
    if (repository === '') {
      problems.push({
        field: `inventory.${i}.repository`,
        detail: 'Give the folder or repository URL to analyse.',
      });
    }

    const rawIdentifiers = row.identifiers;
    if (rawIdentifiers !== undefined && !Array.isArray(rawIdentifiers)) {
      problems.push({
        field: `inventory.${i}.identifiers`,
        detail: 'Identifiers must be a list of hostnames or addresses.',
      });
      continue;
    }
    const list = Array.isArray(rawIdentifiers) ? rawIdentifiers : [];
    if (list.length > MAX_IDENTIFIERS) {
      problems.push({
        field: `inventory.${i}.identifiers`,
        detail: `At most ${MAX_IDENTIFIERS} identifiers per entry.`,
      });
    }

    const identifiers: string[] = [];
    /**
     * Whether anything was taken away by the duplicate rule.
     *
     * An entry whose ONLY identifier is a duplicate ends up empty, and adding
     * "list at least one identifier" underneath "web-01 is already listed"
     * points at the wrong fix. One cause, one sentence.
     */
    let lostToDuplicate = false;
    for (const candidate of list.slice(0, MAX_IDENTIFIERS)) {
      const value = checked(candidate, `inventory.${i}.identifiers`, problems);
      if (value === '') continue;
      const k = key(value);
      const owner = claimed.get(k);
      if (owner !== undefined) {
        // Refused rather than resolved: see the header. Either entry could be
        // the right answer, and the store must not hold a question.
        problems.push({
          field: `inventory.${i}.identifiers`,
          detail: owner === i
            ? `"${value}" is listed twice on this entry.`
            : `"${value}" is already listed on entry ${owner + 1}. One machine, one repository.`,
        });
        lostToDuplicate = true;
        continue;
      }
      claimed.set(k, i);
      identifiers.push(value);
    }

    // An entry that can never match is a setting that looks applied and is
    // not — the failure this console refuses everywhere else.
    if (identifiers.length === 0 && !lostToDuplicate) {
      problems.push({
        field: `inventory.${i}.identifiers`,
        detail: 'List at least one hostname or address, or this entry matches nothing.',
      });
    }

    entries.push({ service, identifiers, repository });
  }

  return { entries, problems };
}

/**
 * The lenient read, for a file that is already on disk.
 *
 * `getConfig()` must not throw: a `config.json` edited by hand must not stop
 * the console from starting. So entries that cannot be read are DROPPED — and
 * the count is written to the log, because silently shrinking an operator's
 * table is how a machine stops being covered without anyone noticing.
 */
export function readInventory(raw: unknown): InventoryEntry[] {
  const { entries, problems } = normalizeInventory(raw);
  const usable = entries.filter(
    (e) => e.service !== '' && e.repository !== '' && e.identifiers.length > 0,
  );
  if (problems.length > 0) {
    // Counted against what was in the FILE, not against what survived
    // parsing: an entry dropped for not being an object never reaches
    // `entries`, and a count that omitted it would understate the loss.
    const found = Array.isArray(raw) ? Math.min(raw.length, MAX_ENTRIES) : 0;
    console.error(
      `[menater] service inventory: ${problems.length} problem(s) in the stored list, `
        + `${usable.length} of ${found} entries kept. First: ${problems[0].field} — ${problems[0].detail}`,
    );
  }
  return usable;
}

/**
 * The inventory, turned into a lookup ONCE per list.
 *
 * ============================================================================
 * WHY THIS IS MEMOISED, AND WHY ON THE ARRAY ITSELF
 *
 * `withRepositories` resolves one case at a time against the SAME entries
 * array, and `null` is the common answer — see the header below — which is
 * exactly the answer that has to look at every identifier of every entry
 * before it can be given. Comparing by `key()` on the way meant re-normalising
 * the whole table for every case: at the declared ceilings (200 entries × 20
 * identifiers) that is 12,000 `trim().toLowerCase()` allocations per case, and
 * the console rebuilds the snapshot on every refresh. Measured on this
 * machine, at those ceilings over a 500-run window: 111 ms of blocked event
 * loop per rebuild, against 0.6 ms once the table is read once.
 *
 * THE KEY IS THE ARRAY'S IDENTITY, and that is not a convenience — it is what
 * makes the memo impossible to leave stale. `sanitizeInventory` in `config.ts`
 * builds a NEW array on every load and on every save, so a changed table is a
 * different array and gets a different index. Nothing on the server mutates
 * the list in place; a memo that survived a save would name a repository the
 * operator had just deleted, which is the "setting that looks applied and is
 * not" this console refuses everywhere else.
 *
 * A `WeakMap` rather than a `Map`: the previous configuration's array becomes
 * garbage the moment `cached` is replaced, and its index must go with it.
 * ============================================================================
 */
const indexes = new WeakMap<InventoryEntry[], InventoryIndex>();

interface IndexHit { entry: InventoryEntry; identifier: string }

/**
 * The TWO questions this table can answer, built in one pass over it.
 *
 * `byIdentifier` is J0.3's: *which repository runs on this machine*. It is the
 * only one the table had an index for, and `scanRepository`'s own comment drew
 * the wrong conclusion from that for its whole life — *« the inventory is
 * keyed on machines, which this alert has none of »*, which is true of the
 * INDEX and false of the DATA. Every entry also stores a repository, so the
 * table can be read the other way round, and `serviceOf` is that reading.
 */
interface InventoryIndex {
  /** Identifier → the entry that claimed it. */
  byIdentifier: Map<string, IndexHit>;
  /**
   * Repository → the name the operator gives that code, or `null` when the
   * table gives it TWO.
   *
   * `null` is the refusal, not an absence, and the two answer alike on
   * purpose: see `declaredService`.
   */
  serviceOf: Map<string, string | null>;
}

function indexOf(entries: InventoryEntry[]): InventoryIndex {
  const known = indexes.get(entries);
  if (known) return known;

  const index: InventoryIndex = { byIdentifier: new Map(), serviceOf: new Map() };
  for (const entry of entries) {
    for (const identifier of entry.identifiers) {
      const k = key(identifier);
      // FIRST WINS, because the scan this replaces returned the first entry in
      // order. `normalizeInventory` refuses a duplicate so a stored inventory
      // cannot hold one — but the resolver is exported and callable with any
      // list, and letting the last writer win would silently change its answer.
      if (!index.byIdentifier.has(k)) index.byIdentifier.set(k, { entry, identifier });
    }

    // An entry missing either half names nothing: `normalizeInventory` reports
    // both as problems and `readInventory` drops the row, but both functions
    // here are exported and callable with any list, so neither may be assumed.
    const repository = key(entry.repository);
    const service = entry.service.trim();
    if (repository === '' || service === '') continue;

    if (!index.serviceOf.has(repository)) {
      // The string as STORED, never the comparison key — the same rule
      // `matched_value` follows: what is shown is the line they typed.
      index.serviceOf.set(repository, service);
      continue;
    }
    const first = index.serviceOf.get(repository)!;
    // Already refused: it stays refused. A third entry agreeing with the first
    // must not un-refuse a disagreement the second one established.
    if (first === null) continue;
    if (key(first) !== key(service)) index.serviceOf.set(repository, null);
  }

  indexes.set(entries, index);
  return index;
}

/**
 * What the operator calls this code, or nothing.
 *
 * ============================================================================
 * WHY THE TABLE IS READ BACKWARDS HERE
 *
 * A case opened by promoting a scan finding (J0.1) carries no host, no
 * destination and no source, so `resolveRepository` has nothing to match it
 * on — and `scanRepository` concluded from that that the inventory could not
 * name it at all. It can: the entry that declares the scanned repository is
 * the operator's own statement about what that code is called, and finding it
 * needs no observable. Measured before this existed, on an install whose
 * inventory maps `Billing API` to the scanned target: the console named the
 * service on the detection about the machine and `null` on the flaw out of
 * that very code, and `search_alerts('billing api')` returned **1 of 2**.
 *
 * ============================================================================
 * IT NAMES; IT DOES NOT AUTHENTICATE, AND IT CHANGES NO ATTRIBUTION
 *
 * The caller's `repository` came out of `extensions`, an open bag, and
 * `findingAlertId` does not cover `target` — ROADMAP § 7 carries that entry and
 * this does not close it. So what a crafted bag can do is SELECT an entry; the
 * string that comes back is the operator's own either way, and `matched_on`
 * still says `scan_target`, so `INVENTORY_MATCHES` goes on excluding the case
 * and J0.7's count goes on refusing it. Nothing here moves a trust boundary.
 *
 * ============================================================================
 * TWO ENTRIES, TWO NAMES: REFUSED, NOT RESOLVED
 *
 * `normalizeInventory` refuses a duplicate IDENTIFIER — one machine, one
 * repository — and deliberately allows two entries to point at one repository,
 * because two services legitimately share a monorepo and one service
 * legitimately runs on two machines. So the door cannot refuse this ambiguity
 * and the resolver has to: entries that AGREE on the name answer it (that is
 * the two-instance case, the ordinary one), entries that DISAGREE answer
 * nothing. Picking the first would be the tie-break this file's header refuses
 * to have, on the name an incident card prints.
 *
 * `null` therefore means *the table does not name this code* — whether because
 * nothing declares it or because two things do, which is why the lookup below
 * cannot tell a missing key from a refused one and does not need to.
 */
export function declaredService(
  repository: string, entries: InventoryEntry[],
): string | null {
  // No guard on an empty list and none on an empty key, and that is measured
  // rather than assumed: `indexOf` skips any entry missing either half, so
  // nothing is ever indexed under `''` and an empty table indexes to an empty
  // map. Both early returns were written here first and removing them left 76
  // tests green — *two guards where one suffices is a line no test can fail
  // on*. The behaviour is pinned by the test instead.
  return indexOf(entries).serviceOf.get(key(repository)) ?? null;
}

/**
 * The repository that runs on the machine this case is about, or nothing.
 *
 * `null` is a real answer and the common one — it means the inventory says
 * nothing about this machine, which is not the same as "this machine has no
 * code". The card prints the first; it must never print the second.
 */
export function resolveRepository(
  alert: { host?: string | null; dest_ip?: string | null; source_ip?: string | null },
  entries: InventoryEntry[],
): CaseRepository | null {
  if (entries.length === 0) return null;
  const index = indexOf(entries).byIdentifier;

  for (const field of MATCH_ORDER) {
    const value = observable(alert[field]);
    if (value === null) continue;
    const hit = index.get(key(value));
    if (hit === undefined) continue;
    return {
      service: hit.entry.service,
      repository: hit.entry.repository,
      matched_on: field,
      // The identifier as STORED, never the comparison key: the card shows the
      // operator the line they typed.
      matched_value: hit.identifier,
    };
  }
  return null;
}
