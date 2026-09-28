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

import type { AlertCase, Severity } from './types.ts';

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
