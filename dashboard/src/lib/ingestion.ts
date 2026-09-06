/**
 * N5 — the delivery policy, as the browser sees it.
 *
 * A MIRROR OF `server/ingest/policy.ts`, and deliberately nothing more. The
 * routing rule itself is NOT reimplemented here: `laneFor` runs on the server
 * and the resolved lanes travel in the payload. A second implementation of a
 * safety rule is a second thing that can disagree with the one that runs, and
 * the one that runs is not the one you are looking at.
 */

export type DeliveryMode = 'push' | 'pull' | 'hybrid';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Lane = 'fast' | 'paced';

export interface PullSource {
  source: string;
  enabled: boolean;
  url: string;
  cursorParam: string;
  authHeader: string;
  authCredential: string;
  itemsPath: string;
}

export interface IngestionPolicy {
  delivery: DeliveryMode;
  fastLane: Severity[];
  pull: {
    enabled: boolean;
    intervalSeconds: number;
    batchSize: number;
    overlapSeconds: number;
    sources: PullSource[];
  };
}

export interface Cursor {
  since: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  received: number;
  /** Consecutive failed polls. Reset by any answer, including an empty one. */
  failures: number;
  /** Before this instant the poller skips this source. `null` = due now. */
  nextAttemptAt: string | null;
}

export interface PollOutcome {
  source: string;
  accepted: number;
  unusable: number;
  error: string | null;
  since: string | null;
  nextAttemptAt: string | null;
}

export interface IngestionPayload {
  policy: IngestionPolicy;
  /** Resolved by the server. See the note at the top of this file. */
  lanes: Record<Severity, Lane>;
  state: {
    running: boolean;
    cursors: Record<string, Cursor>;
    last: PollOutcome[];
  };
}

/** The severities, worst first — the order every screen in this console uses. */
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * The P-number an SOC says out loud, next to the severity the pipeline stores.
 *
 * P1–P4 is the vocabulary of the people configuring this, `critical`…`low` is
 * the vocabulary of every other screen and of the audit rows. Showing both,
 * once, is cheaper than making anyone hold a conversion in their head — and
 * cheaper than renaming a field the hash chain depends on.
 */
export const PRIORITY_LABEL: Record<Severity, string> = {
  critical: 'P1',
  high: 'P2',
  medium: 'P3',
  low: 'P4',
};
