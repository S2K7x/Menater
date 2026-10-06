/**
 * The login throttle's table, and what makes an address leave it.
 *
 * ============================================================================
 * WHAT THESE PROTECT
 *
 * `attempts` is the only process-lifetime table in this module that an
 * UNAUTHENTICATED caller can write to: one `POST /api/auth/login` with a wrong
 * password creates an entry, and `/api/auth/login` is in `PUBLIC_ROUTES`
 * because otherwise nobody could ever log in.
 *
 * It had no test of any kind. Two facts followed from that, both measured on
 * the real module before anything here was written:
 *
 *   - A record carrying a PARTIAL streak (1 to 7 failures) had no expiry
 *     instant at all, and `throttle` only ever deleted a record whose `until`
 *     was non-zero — so it was immortal. 200,000 addresses cost 24.7 MiB at
 *     129 B an entry, and calling `throttle` on every one of them, the only
 *     function in the module that deletes anything, reclaimed 0%.
 *   - The same immortality locks the OPERATOR out of their own console with no
 *     attacker anywhere: eight typos spread over eight months, one a month,
 *     answered `{"blocked":true,"retryInSeconds":300}`.
 *
 * So the claim under test is one rule — an address that has gone quiet is
 * forgotten — and the tests come in two halves. Those that are RED on
 * unmodified production code claim the forgetting. Those that are GREEN before
 * AND after claim the BOUNDARY, and each one names a plausible wrong fix: a
 * shortened lock, a tightened count, a cap that evicts a record still in use.
 * The last is the one that matters, because an eviction an attacker can
 * provoke resets their own streak at will, which is strictly worse than the
 * leak it would be fixing.
 * ============================================================================
 */

import { beforeEach, describe, expect, it } from 'vitest';

const { throttle, recordFailure, recordSuccess, resetThrottle, throttleRecordCount } =
  await import('./auth.ts');

/** The contract these tests are written against, restated so a change is loud. */
const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60 * 1000;
const STREAK_MS = 60 * 60 * 1000;

const T0 = Date.parse('2026-01-01T09:00:00Z');
const MINUTE = 60_000;
const DAY = 86_400_000;

beforeEach(() => { resetThrottle(); });

describe('the login throttle forgets an address that has gone quiet', () => {
  it('drops a partial streak after an hour of silence', () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) recordFailure(ip, T0);
    expect(throttle(ip, T0).blocked).toBe(false);

    // Still counting one second BEFORE the window closes: an eighth failure
    // there is a real streak and must still lock. A window asserted on one
    // side only is half asserted.
    expect(throttleRecordCount()).toBe(1);
    recordFailure(ip, T0 + STREAK_MS - 1000);
    expect(throttle(ip, T0 + STREAK_MS - 1000).blocked).toBe(true);

    // And one millisecond past it the record is GONE, not merely ignored: the
    // table is the thing that was unbounded.
    resetThrottle();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) recordFailure(ip, T0);
    expect(throttle(ip, T0 + STREAK_MS + 1).blocked).toBe(false);
    expect(throttleRecordCount()).toBe(0);
  });

  it('does not lock an operator out over typos spread across seven months', () => {
    const ip = '192.0.2.50';
    let clock = T0;
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      expect(throttle(ip, clock).blocked, `typo ${i + 1}`).toBe(false);
      recordFailure(ip, clock);
      clock += 30 * DAY;
    }

    // The eighth typo, seven months after the first. The assertion is AT the
    // instant it is made and not a month later: the lock itself lasts five
    // minutes, so a check on the next visit cannot see the lockout at all —
    // which is how the first draft of this test went green over the defect.
    // Measured on unmodified production code, this answered
    // {"blocked":true,"retryInSeconds":300}.
    recordFailure(ip, clock);
    expect(throttle(ip, clock)).toEqual({ blocked: false, retryInSeconds: 0 });
  });

  it('reclaims the table rather than holding every address that ever failed', () => {
    // Past the sweep floor, so the housekeeping is reached at all.
    for (let i = 0; i < 600; i++) recordFailure(`2001:db8::${i.toString(16)}`, T0);
    expect(throttleRecordCount()).toBe(600);

    // One failed login after they have all expired, and the table holds that
    // one address. Before the fix it held 601, for the life of the process.
    recordFailure('198.51.100.1', T0 + STREAK_MS + 1);
    expect(throttleRecordCount()).toBe(1);
  });

  it('restarts the count on an expired record even if nothing read it first', () => {
    // The route calls `throttle` before `recordFailure`, so in production the
    // lazy delete usually clears an expired record before this function sees
    // it. That makes `recordFailure` LOOK correct for a reason that lives in
    // its caller — « a guard that was right until a second thing could answer »
    // — so the window is claimed here with no read in between.
    const ip = '203.0.113.21';
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) recordFailure(ip, T0);
    recordFailure(ip, T0 + STREAK_MS + 1);
    expect(throttle(ip, T0 + STREAK_MS + 1).blocked).toBe(false);
  });

  it('forgets an address the moment it gets the password right', () => {
    const ip = '203.0.113.9';
    recordFailure(ip, T0);
    recordSuccess(ip);
    expect(throttleRecordCount()).toBe(0);
  });
});

describe('what the forgetting must NOT change', () => {
  it('still blocks on the eighth failure, and not before', () => {
    const ip = '203.0.113.11';
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      recordFailure(ip, T0);
      expect(throttle(ip, T0).blocked, `after ${i + 1} failures`).toBe(false);
    }
    recordFailure(ip, T0);
    expect(throttle(ip, T0)).toEqual({ blocked: true, retryInSeconds: LOCK_MS / 1000 });
  });

  it('still holds the block for its full five minutes', () => {
    const ip = '203.0.113.12';
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(ip, T0);

    expect(throttle(ip, T0 + LOCK_MS - 1000).blocked).toBe(true);
    expect(throttle(ip, T0 + LOCK_MS - 1000).retryInSeconds).toBe(1);
    expect(throttle(ip, T0 + LOCK_MS + 1).blocked).toBe(false);
  });

  it('never evicts a record still in use, and lets the table exceed its floor', () => {
    // THE eviction test. A cap that took "the oldest" would hand an attacker
    // the way to flush their own lock: spray addresses until the record holding
    // their block is the one dropped. So the locked address below is
    // deliberately the OLDEST thing in the table at the instant the sweep runs,
    // and it is still inside its five minutes — the only arrangement in which
    // an oldest-first eviction and an expiry-only sweep disagree.
    // One address that is genuinely expired by the time the sweep runs, so this
    // test cannot go green over a sweep that never happened at all.
    recordFailure('203.0.113.1', T0 - STREAK_MS - MINUTE);

    const locked = '203.0.113.200';
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(locked, T0);
    expect(throttle(locked, T0).blocked).toBe(true);

    // Past the floor, one minute later, so the housekeeping is reached while
    // that lock still has four of its five minutes to run.
    const later = T0 + MINUTE;
    for (let i = 0; i < 600; i++) recordFailure(`2001:db8:1::${i.toString(16)}`, later);

    expect(throttle(locked, T0 + 2 * MINUTE).blocked).toBe(true);
    // 601 and not 602: the quiet address was dropped, so the scan ran. And not
    // 512: a bound that threw live records away would be throttling nobody
    // while reporting that it was.
    expect(throttleRecordCount()).toBe(601);
  });
});
