/**
 * J0.4 — one system, and everything that threatens it.
 *
 * ============================================================================
 * THE QUESTION NEITHER TAB ANSWERS ALONE
 *
 * The triage queue answers *what should I work on next*: one row per alert,
 * ordered by what is waiting on a human. The scan report answers *what is
 * wrong with this code*. Nobody asks either of those about an estate — they
 * ask **what threatens this machine**, and until now the only way to find out
 * was to read forty rows and remember which ones named `web-01`.
 *
 * This groups the cases the console already holds by the system they are
 * about, so the alerts raised against a machine and the flaws promoted out of
 * its code end up in one place.
 *
 * ============================================================================
 * WHY THIS IS A PURE FUNCTION IN THE BROWSER, AND NOT A FIELD ON THE SNAPSHOT
 *
 * Every case is already in the browser: the snapshot carries the whole window.
 * Computing the grouping on the server would mean sending the same alerts a
 * second time, and this project has already measured what that costs — the
 * duplicate `trace.chains[].payload` sat 85,644 bytes away from its original
 * at the default window, far outside DEFLATE's 32,768-byte sliding window, so
 * gzip could not collapse one onto the other. A regrouping of data the client
 * holds is a function, not a payload.
 *
 * ============================================================================
 * NOTHING HERE GUESSES, AND THAT IS THE WHOLE DESIGN
 *
 * The join between an alert and a piece of code is `case.repository`, which
 * two things can answer and neither ever invents: the service inventory an
 * operator filled in (J0.3, exact matching only), or the scan a promoted
 * finding came out of (J0.1). This function adds no third answer. What it
 * does when nothing named the code is fall back to the machine the detection
 * names — which is not an inference either: those alerts literally carry the
 * same hostname.
 *
 * A case that names neither is **not attributed to anything**. It is counted
 * and said out loud rather than filed under a plausible system: an absence
 * needs a scope, and a system view that quietly dropped a third of the queue
 * would be the failure that shows green, rebuilt in the screen that exists to
 * give an overview.
 * ============================================================================
 */

import { INVENTORY_MATCHES, type AlertCase, type CodeLead, type Severity } from './types.ts';

/** How the system was identified — which decides what the screen may claim. */
export type SystemKind =
  /** Something named the code: the inventory, or the scan a flaw came from. */
  | 'code'
  /** Only a machine: no inventory entry maps it to any repository. */
  | 'machine';

export interface SystemThreats {
  /**
   * Identity, and the React key. Carries its own namespace (`code:` /
   * `machine:`) so a repository and a hostname that happen to be spelled the
   * same string cannot collide into one system.
   */
  key: string;
  kind: SystemKind;
  /** The heading: the service name(s) if any, else the code, else the machine. */
  label: string;
  /** The code that runs here, as somebody typed it. `null` when nothing named it. */
  repository: string | null;
  /**
   * The names the inventory gave this code. Usually one; several when two
   * entries point at the same repository, which `normalizeInventory` does not
   * refuse — so they are all listed rather than one of them picked. Picking
   * would be the tie-break J0.3 refuses to have.
   */
  services: string[];
  /** Our machines it was seen under, spelled as the detections spelled them. */
  machines: string[];
  /** Detections. Ordered as the caller ordered them. */
  alerts: AlertCase[];
  /** Cases opened by promoting a finding out of a scan of this code. */
  flaws: AlertCase[];
  /**
   * Why this system's code is worth reading, or `null`.
   *
   * READ, NEVER RE-INFERRED. `code_lead` is written once, by `cases.ts`, off
   * the ATT&CK tags the incident card prints — so the reason this screen
   * gives is checkable against something already on the operator's screen.
   * Matching the rule name a second time here would be a second ruler
   * disagreeing with the first, on the decision to go and read code during an
   * incident.
   *
   * GATED ON THE REPOSITORY, exactly as the incident card gates it: *the flaw
   * may be in this code* with no code to name is the line nobody can act on
   * that J0.3 prints nothing at all rather than carry. So this is `null` on
   * every `machine`-kind system, whatever its alerts say.
   */
  lead: CodeLead | null;
  /**
   * How many of this system's cases carry the technique `lead` NAMES.
   *
   * Scoped to that one technique and not to the system: `APPLICATION_TECHNIQUES`
   * is a set built to grow, and a count covering a technique the sentence does
   * not name would stop being true the day a second one is added. `0` exactly
   * when `lead` is `null`.
   */
  leadAlerts: number;
  /** Cases waiting on a human decision, across both lists. */
  awaiting: number;
  /** Cases the pipeline could not finish, across both lists. */
  failed: number;
  /** The worst severity present. A system always holds at least one case. */
  worst: Severity;
  /** The most recent `received_at` in the system, as an ISO string. */
  last: string;
}

export interface SystemView {
  systems: SystemThreats[];
  /**
   * Cases naming neither one of our machines nor any code.
   *
   * They are in the queue and not on this screen, and the screen says so. A
   * count is the honest form: filing them under "unknown system" would invent
   * a system, and dropping them silently would make the overview lie about
   * its own coverage.
   */
  unattributed: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3, high: 2, medium: 1, low: 0,
};

/** The comparison key — the same rule `server/inventory.ts` matches by. */
const norm = (value: string): string => value.trim().toLowerCase();

/**
 * Which of OUR machines this case is about, or nothing.
 *
 * `host` is the machine the detection is about, so it answers first.
 * `dest_ip` is the address that was reached — our side of a connection, the
 * same order `server/inventory.ts` tries. `source_ip` is deliberately NOT
 * read: it is usually the other end, and grouping by it would file an alert
 * under the attacker's address as though it were an asset of ours.
 *
 * `—` is the console's DISPLAY value for an address a detection did not
 * record. Read as data it would collect every address-less alert into one
 * system called "—", which is a system nobody owns.
 */
function machineOf(c: AlertCase): string | null {
  for (const value of [c.host, c.dest_ip]) {
    const v = (value ?? '').trim();
    if (v !== '' && v !== '—') return v;
  }
  return null;
}

/** A case opened by promoting a scan finding — the flaw half of the stack. */
const isFlaw = (c: AlertCase): boolean => c.repository?.matched_on === 'scan_target';

interface Bucket {
  kind: SystemKind;
  /**
   * What names this system when the inventory gave it no service name: the
   * repository, or the machine. Recorded when the bucket is created, so the
   * label never has to fall back to the comparison key.
   */
  identity: string;
  repository: string | null;
  services: Map<string, string>;
  machines: Map<string, string>;
  alerts: AlertCase[];
  flaws: AlertCase[];
}

/**
 * The cases, grouped by the system they threaten.
 *
 * Systems are ordered the way the queue orders rows, and for the same reason:
 * **what is waiting on a human comes first**, whatever its date. Then the
 * worst severity present, then the most recent activity — so a system that is
 * merely old does not outrank one that is on fire.
 */
export function groupBySystem(cases: AlertCase[]): SystemView {
  const buckets = new Map<string, Bucket>();
  let unattributed = 0;

  for (const c of cases) {
    const repository = c.repository?.repository ?? null;
    const machine = machineOf(c);
    // The repository FIRST, because it is what joins a machine's alerts to
    // its code's flaws: a promoted finding carries no host at all (J0.1 leaves
    // it absent on purpose, so `isolationTarget()` refuses), so a grouping
    // keyed on the machine alone could never put the two halves together —
    // which is the entire point of this screen.
    const key = repository !== null
      ? `code:${norm(repository)}`
      : machine !== null ? `machine:${norm(machine)}` : null;

    if (key === null) {
      unattributed += 1;
      continue;
    }

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        kind: repository !== null ? 'code' : 'machine',
        identity: repository ?? machine!,
        // The string as STORED, never the comparison key: the screen shows the
        // operator the line they typed.
        repository,
        services: new Map(),
        machines: new Map(),
        alerts: [],
        flaws: [],
      };
      buckets.set(key, bucket);
    }

    const service = c.repository?.service ?? null;
    if (service !== null && service !== '') {
      if (!bucket.services.has(norm(service))) bucket.services.set(norm(service), service);
    }
    if (machine !== null && !bucket.machines.has(norm(machine))) {
      bucket.machines.set(norm(machine), machine);
    }
    (isFlaw(c) ? bucket.flaws : bucket.alerts).push(c);
  }

  const systems = [...buckets.entries()].map(([key, b]) => {
    const all = [...b.alerts, ...b.flaws];
    const services = [...b.services.values()];
    const machines = [...b.machines.values()];
    // The first lead in the caller's order, which is the queue's order — the
    // same choice the card makes between two techniques pointing at the code:
    // two of them do not make the code twice as worth reading.
    const lead = b.repository !== null
      ? all.find((c) => c.code_lead !== null)?.code_lead ?? null
      : null;
    return {
      key,
      kind: b.kind,
      // The name a team uses comes first when the inventory gave one. The code
      // is the fallback for a flaw promoted from a target nobody mapped, and
      // the machine for an install with no inventory at all.
      label: services.length > 0 ? services.join(' · ') : b.identity,
      repository: b.repository,
      services,
      machines,
      alerts: b.alerts,
      flaws: b.flaws,
      lead,
      leadAlerts: lead === null
        ? 0
        : all.filter((c) => c.code_lead?.technique_id === lead.technique_id).length,
      awaiting: all.filter((c) => c.state === 'awaiting_approval').length,
      failed: all.filter((c) => c.state === 'failed').length,
      worst: all.reduce<Severity>(
        (worst, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[worst] ? c.severity : worst),
        'low',
      ),
      // Compared as instants, not as strings: two sources can spell the same
      // moment differently, and a lexicographic maximum would then pick by
      // spelling.
      last: all.reduce(
        (latest, c) => (new Date(c.received_at).getTime() > new Date(latest).getTime()
          ? c.received_at
          : latest),
        all[0]!.received_at,
      ),
    };
  });

  systems.sort((a, b) => {
    const blocking = (s: SystemThreats) => (s.awaiting > 0 ? 0 : 1);
    const byBlocking = blocking(a) - blocking(b);
    if (byBlocking !== 0) return byBlocking;
    const bySeverity = SEVERITY_RANK[b.worst] - SEVERITY_RANK[a.worst];
    if (bySeverity !== 0) return bySeverity;
    return new Date(b.last).getTime() - new Date(a.last).getTime();
  });

  return { systems, unattributed };
}

/* ===========================================================================
   J0.7 — THE SAME JOIN, READ FROM THE CODE'S SIDE

   J0.2 brings the incident next to the code: a case whose inferred technique
   says the way in was the application itself carries that reason on its card,
   beside the repository J0.3 resolved. Nothing does the reverse. Somebody
   reading a scan report of `/srv/src/billing-api` could not tell whether the
   machine running it had an incident open, and that is the fact that decides
   whether the findings in front of them are hypothetical.

   Measured on the real pair — `resolveRepository` for the join, `tagAttack`
   plus `codeLead` for the technique — with three cases in the window about a
   machine the inventory maps to the scanned target, two of them carrying
   T1190 and one waiting on a human: the rendered report named the service
   **0** times, the technique **0**, and said nothing about anything waiting.
   Its only two mentions of the queue were the promote control's own label,
   i.e. the door OUT.

   TWO ORIGINS, AND ONLY ONE OF THEM MAY ANSWER THIS. `INVENTORY_MATCHES` is
   the trusted set, declared once in `types.ts` with its reasons: a promoted
   finding's `repository` comes out of `extensions`, an open bag whose
   `target` the derived alert id does not cover, so a log source could make
   this report claim an incident about whatever code an operator had just
   typed. A count presented as *detections against this system* has to be
   built out of the operator's own table and nothing else.

   SO IT ALSO DOES NOT COUNT FLAWS, and that falls out of the same gate: a
   case opened by promoting a finding is `scan_target`. J0.5 already answers
   *is THIS finding in the queue* for the findings of this run, which is the
   question a report can scope; what it could not say is what the DETECTIONS
   say about the machine.
   =========================================================================== */

/** What the triage queue already holds about one piece of code. */
export interface CodeIncidents {
  /**
   * The name(s) the operator's inventory gives this code.
   *
   * Never empty: `normalizeInventory` refuses an entry with no service name,
   * so every inventory match carries one. Several when two entries point at
   * the same repository — which the inventory does not refuse — and then they
   * are all listed rather than one of them picked, the tie-break J0.3 refuses
   * to have.
   */
  services: string[];
  /** Detections in the window about those systems. Never `0`. */
  alerts: number;
  /** How many of them are waiting on a human decision. */
  awaiting: number;
  /**
   * The technique that says the way in was this code, or `null`.
   *
   * READ, NEVER RE-INFERRED — `code_lead` is written once, by `cases.ts`, off
   * the ATT&CK tags the incident card prints, so the sentence this feeds is
   * checkable against something already on the operator's screen. A second
   * matcher here would be two rulers disagreeing about one alert.
   */
  lead: CodeLead | null;
  /**
   * How many of those alerts carry the technique `lead` NAMES.
   *
   * Scoped to that one technique, exactly as `SystemThreats.leadAlerts` is:
   * `APPLICATION_TECHNIQUES` is a set built to grow, and a count covering a
   * technique the sentence does not name stops being true the day a second
   * one is added. `0` exactly when `lead` is `null`.
   */
  leadAlerts: number;
}

/**
 * What a scan report reads, and the way through to the screen that stacks it.
 *
 * An OBJECT and not two props, the shape `PromotedLink` already has: the Code
 * tab does not depend on the alert pipeline — `App.tsx` renders it beside the
 * snapshot's error screen rather than inside it — so everything it knows about
 * the queue arrives through one optional prop that may simply be absent.
 */
export interface CodeIncidentsLink {
  incidents: CodeIncidents;
  /** Opens the Alerts tab's "By system" view, which is J0.4's screen. */
  openSystems: () => void;
}

/**
 * The window's detections about the system(s) the inventory maps to `target`.
 *
 * `null` when nothing matches, and that is the whole of what this screen may
 * claim. The run window is bounded and the Code tab renders with no snapshot
 * at all, so *"no alert is about this code"* would be a claim whose scope this
 * screen cannot show — the reassurance over a hole that `clean` refuses on the
 * Lookup tab and that the scan report refuses about its own coverage. Only the
 * positive claim is ever made, exactly as in `promotedIndex`.
 *
 * `target` is the string that was TYPED at launch (`ScanState.launchedTarget`),
 * never the report header's label: `shortLabel()` keeps the last two path
 * segments, so matching on it would compare `src/billing-api` against an
 * inventory line reading `/srv/src/billing-api` and find nothing, silently.
 *
 * The comparison is the inventory's own and nothing more — case-insensitive
 * after trimming, no suffix rule, no `.git` tolerance. A target typed in
 * another spelling than the inventory line therefore matches nothing and the
 * report says nothing, which is the direction this join has always failed in:
 * J0.3 refuses to guess which repository runs where, and a near-match is a
 * guess.
 */
export function codeIncidents(cases: AlertCase[], target: string | null): CodeIncidents | null {
  const wanted = norm(target ?? '');
  if (wanted === '') return null;

  const matched: AlertCase[] = [];
  const services = new Map<string, string>();

  for (const c of cases) {
    const r = c.repository;
    // The trust gate, and it is read from the declaration rather than spelled
    // as « not a scan target »: a fifth origin is excluded on the day it is
    // added instead of counted until somebody remembers to come back.
    if (!r || !INVENTORY_MATCHES.has(r.matched_on)) continue;
    if (norm(r.repository) !== wanted) continue;
    matched.push(c);
    // An inventory match always carries a service name. The string as STORED,
    // never the comparison key: the screen shows the line they typed.
    if (r.service !== null && r.service !== '' && !services.has(norm(r.service))) {
      services.set(norm(r.service), r.service);
    }
  }

  if (matched.length === 0) return null;

  // The first lead in the caller's order, which is the queue's — the same
  // choice `groupBySystem` and the incident card make between two techniques
  // pointing at the code: two of them do not make the code twice as worth
  // reading.
  const lead = matched.find((c) => c.code_lead !== null)?.code_lead ?? null;

  return {
    services: [...services.values()],
    alerts: matched.length,
    awaiting: matched.filter((c) => c.state === 'awaiting_approval').length,
    lead,
    leadAlerts: lead === null
      ? 0
      : matched.filter((c) => c.code_lead?.technique_id === lead.technique_id).length,
  };
}
