/**
 * N5 — how alerts get in, and which transport carries which alert.
 *
 * ============================================================================
 * TWO TRANSPORTS, AND THEY ANSWER DIFFERENT QUESTIONS
 *
 * PUSH. The source calls us the moment it detects something. Latency is one
 * network hop, which is the only thing that makes "contain in seconds" a real
 * sentence rather than a slogan. Its cost is that we are only as reliable as
 * the source's retry policy: a webhook nobody received is a webhook nobody
 * knows about, and the sender is the only party who could have noticed.
 *
 * PULL. We ask the source, on our own clock, for what happened since a cursor
 * we hold. Latency is half a polling interval on average — minutes, not
 * seconds — and in exchange nothing is lost by a missed call: the cursor is
 * still where it was, and the next poll fetches the gap. It also bounds the
 * load: a source that emits a thousand alerts in a burst is read in batches
 * WE size, instead of opening a thousand simultaneous requests at us.
 *
 * ============================================================================
 * WHY HYBRID IS THE DEFAULT, AND NOT A COMPROMISE
 *
 * The two costs above land on different alerts. A `critical` alert whose
 * containment is late by four minutes is a containment that did not happen;
 * a `low` alert whose triage is late by four minutes is a `low` alert. So the
 * transport is chosen by what the delay would actually cost:
 *
 *   critical / high  (P1/P2) → PUSH.  Seconds matter.
 *   medium  / low    (P3/P4) → PULL.  Smoothing the load matters more.
 *
 * That is the recommended default, and it is a POLICY, not a constant: an
 * install whose sources cannot call out picks `pull`, one that has no API to
 * poll picks `push`. The console says which, and why, on the screen where the
 * choice is made.
 *
 * ============================================================================
 * WHAT THIS FILE REFUSES TO DO
 *
 * IT NEVER DROPS AN ALERT. A `low` alert that arrives by push on a hybrid
 * install is not refused — refusing it would delete a detection because of a
 * routing preference, which is the same mistake as rejecting an alert for a
 * missing field. It is ACCEPTED and marked as having arrived off its lane, so
 * the count is visible on screen and someone can fix the source's wiring.
 *
 * IT NEVER GUESSES A SEVERITY. An alert whose severity did not survive
 * normalization takes the FAST lane: an unknown urgency is treated as if it
 * were urgent, because the reverse — quietly parking something that might be a
 * `critical` — is the failure this product exists to make impossible.
 * ============================================================================
 */

import { SEVERITIES, type Severity } from '../engine/transforms/domain.ts';

/** The three shapes an install can choose between. */
export const DELIVERY_MODES = ['push', 'pull', 'hybrid'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** One source we poll, and the state of that polling. */
export interface PullSource {
  /** Must name a mapping in `normalize.ts` — the normalizer that will run. */
  source: string;
  enabled: boolean;
  /** Where to ask. Held here rather than guessed: we dial nothing we were not given. */
  url: string;
  /**
   * How the cursor is sent. `query` appends `?since=<cursor>`; a source with
   * its own vocabulary gets its parameter named here rather than assumed.
   */
  cursorParam: string;
  /** Header name carrying the source's own credential, if it wants one. */
  authHeader: string;
  /** Which managed credential fills that header. Never the value itself. */
  authCredential: string;
  /** JSON path to the array of alerts in the response. Empty = the body is the array. */
  itemsPath: string;
}

export interface IngestionPolicy {
  delivery: DeliveryMode;
  /**
   * The severities that take the push lane under `hybrid`.
   *
   * A LIST rather than a threshold: "critical and high" is a sentence a SOC
   * can disagree with, and a threshold hides that disagreement behind a
   * comparison operator.
   */
  fastLane: Severity[];
  pull: {
    enabled: boolean;
    /**
     * Seconds between two polls. The average added latency is HALF of this,
     * which is the number the interface shows — quoting the interval itself
     * would overstate the delay by a factor of two.
     */
    intervalSeconds: number;
    /** Alerts read per poll. What actually bounds the load. */
    batchSize: number;
    /**
     * How far back before the cursor each poll reaches.
     *
     * A source that timestamps an alert at the instant of DETECTION but makes
     * it queryable a second later drops everything in that second, forever,
     * with a cursor that never looks back. The overlap re-reads it; dedup
     * throws the duplicate away. Re-reading is cheap, a missed alert is not.
     */
    overlapSeconds: number;
    sources: PullSource[];
  };
}

export const DEFAULT_FAST_LANE: Severity[] = ['critical', 'high'];

/**
 * The recommended shape, and what a fresh install gets.
 *
 * `pull.enabled` is FALSE even though the delivery mode is `hybrid`: hybrid
 * says which transport SHOULD carry what, and enabling a poller says we have
 * somewhere to poll. Turning on a poller with no source configured would spin
 * a timer that reaches nothing and report it as healthy.
 */
export function defaultPolicy(): IngestionPolicy {
  return {
    delivery: 'hybrid',
    fastLane: [...DEFAULT_FAST_LANE],
    pull: {
      enabled: false,
      intervalSeconds: 60,
      batchSize: 100,
      overlapSeconds: 30,
      sources: [],
    },
  };
}

export type Lane = 'fast' | 'paced';

/**
 * Which lane an alert of this severity belongs to, under this policy.
 *
 * `null` severity — normalization found none — takes `fast`. See the header:
 * an unknown urgency is treated as urgent.
 */
export function laneFor(severity: Severity | null | undefined, policy: IngestionPolicy): Lane {
  if (policy.delivery === 'push') return 'fast';
  if (policy.delivery === 'pull') return 'paced';
  if (!severity) return 'fast';
  return policy.fastLane.includes(severity) ? 'fast' : 'paced';
}

/**
 * The transport this policy EXPECTS to carry that severity.
 *
 * Used to tell an operator that a source is wired against the policy — never
 * to refuse the alert. See "it never drops an alert" in the header.
 */
export function expectedTransport(
  severity: Severity | null | undefined,
  policy: IngestionPolicy,
): 'push' | 'pull' {
  return laneFor(severity, policy) === 'fast' ? 'push' : 'pull';
}

/**
 * Whether an alert that arrived this way arrived on the transport the policy
 * intended for it. `false` is a wiring observation, not an error.
 */
export function onExpectedTransport(
  severity: Severity | null | undefined,
  arrivedBy: 'push' | 'pull',
  policy: IngestionPolicy,
): boolean {
  if (policy.delivery !== 'hybrid') return true;
  return expectedTransport(severity, policy) === arrivedBy;
}

const isSeverity = (v: unknown): v is Severity =>
  typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);

/**
 * Coerce whatever the browser sent into a policy this process can run.
 *
 * SAME REASONING AS `normalizeRuleInput`: the API used to trust the shape of
 * its body and answered six different 500s carrying an internal message, so
 * the caller learned that something broke and never that THEY had sent
 * something wrong. Every field here is bounded, and an unusable value falls
 * back to the current one rather than to a default — a save must not silently
 * reset a setting the caller did not mention.
 */
export function normalizePolicyInput(
  input: unknown,
  current: IngestionPolicy,
): { policy: IngestionPolicy; error: string | null } {
  const body = (input ?? {}) as Record<string, unknown>;
  const next: IngestionPolicy = {
    delivery: current.delivery,
    fastLane: [...current.fastLane],
    pull: { ...current.pull, sources: current.pull.sources.map((s) => ({ ...s })) },
  };

  if (body.delivery !== undefined) {
    if (!DELIVERY_MODES.includes(body.delivery as DeliveryMode)) {
      return { policy: current, error: `delivery must be one of: ${DELIVERY_MODES.join(', ')}.` };
    }
    next.delivery = body.delivery as DeliveryMode;
  }

  if (body.fastLane !== undefined) {
    if (!Array.isArray(body.fastLane) || !body.fastLane.every(isSeverity)) {
      return { policy: current, error: `fastLane must be a list of: ${SEVERITIES.join(', ')}.` };
    }
    // AN EMPTY FAST LANE IS REFUSED. Under `hybrid` it would send `critical`
    // down the paced lane — the one configuration this whole file exists to
    // prevent, and it would look like a valid choice on the way in.
    if (body.fastLane.length === 0 && next.delivery === 'hybrid') {
      return { policy: current, error: 'the push lane cannot be empty under the hybrid policy.' };
    }
    next.fastLane = body.fastLane as Severity[];
  }

  const pull = body.pull as Record<string, unknown> | undefined;
  if (pull !== undefined) {
    if (typeof pull !== 'object' || pull === null) {
      return { policy: current, error: 'pull must be an object.' };
    }
    if (pull.enabled !== undefined) next.pull.enabled = pull.enabled === true || pull.enabled === 'true';
    if (pull.intervalSeconds !== undefined) {
      const n = Number(pull.intervalSeconds);
      if (!Number.isFinite(n)) return { policy: current, error: 'pull.intervalSeconds must be a number.' };
      // 15 s floor: below it the poller costs more than the webhook it is
      // smoothing. 1 h ceiling: past it "the alert is not arriving" is the
      // diagnosis, exactly as with `refreshSeconds`.
      next.pull.intervalSeconds = Math.min(3600, Math.max(15, Math.round(n)));
    }
    if (pull.batchSize !== undefined) {
      const n = Number(pull.batchSize);
      if (!Number.isFinite(n)) return { policy: current, error: 'pull.batchSize must be a number.' };
      next.pull.batchSize = Math.min(1000, Math.max(1, Math.round(n)));
    }
    if (pull.overlapSeconds !== undefined) {
      const n = Number(pull.overlapSeconds);
      if (!Number.isFinite(n)) return { policy: current, error: 'pull.overlapSeconds must be a number.' };
      next.pull.overlapSeconds = Math.min(3600, Math.max(0, Math.round(n)));
    }
    if (pull.sources !== undefined) {
      if (!Array.isArray(pull.sources)) return { policy: current, error: 'pull.sources must be a list.' };
      const seen = new Set<string>();
      const out: PullSource[] = [];
      for (const raw of pull.sources) {
        if (typeof raw !== 'object' || raw === null) {
          return { policy: current, error: 'each pull source must be an object.' };
        }
        const s = raw as Record<string, unknown>;
        const source = String(s.source ?? '').trim().toLowerCase();
        if (!/^[a-z0-9-]+$/.test(source)) {
          return { policy: current, error: `"${source}" is not a valid source name (a-z, 0-9, -).` };
        }
        if (seen.has(source)) {
          return { policy: current, error: `source "${source}" is listed twice.` };
        }
        seen.add(source);
        const url = String(s.url ?? '').trim();
        // THE SAME RULE AS THE LOOKUP TAB'S: we dial an address an operator
        // typed into a field, never one that arrived inside an alert. And it
        // must be http(s) — a `file://` cursor would read this host's disk.
        if (url !== '' && !/^https?:\/\//i.test(url)) {
          return { policy: current, error: `the address for "${source}" must start with http:// or https://.` };
        }
        out.push({
          source,
          enabled: s.enabled === true || s.enabled === 'true',
          url,
          cursorParam: String(s.cursorParam ?? 'since').trim() || 'since',
          authHeader: String(s.authHeader ?? '').trim(),
          authCredential: String(s.authCredential ?? '').trim(),
          itemsPath: String(s.itemsPath ?? '').trim(),
        });
      }
      next.pull.sources = out;
    }
  }

  // Checked LAST, so switching to hybrid with an already-empty list is caught
  // whichever order the two fields arrive in.
  if (next.delivery === 'hybrid' && next.fastLane.length === 0) {
    return { policy: current, error: 'the push lane cannot be empty under the hybrid policy.' };
  }
  return { policy: next, error: null };
}
