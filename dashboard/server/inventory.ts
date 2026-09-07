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

export type MatchField = CaseRepository['matched_on'];

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

  for (const field of MATCH_ORDER) {
    const value = observable(alert[field]);
    if (value === null) continue;
    const k = key(value);
    for (const entry of entries) {
      const hit = entry.identifiers.find((id) => key(id) === k);
      if (hit === undefined) continue;
      return {
        service: entry.service,
        repository: entry.repository,
        matched_on: field,
        matched_value: hit,
      };
    }
  }
  return null;
}
