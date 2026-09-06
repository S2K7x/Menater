/**
 * The delivery policy: which transport carries which alert.
 *
 * ============================================================================
 * WHAT THESE TESTS CLAIM
 *
 * Not "the default is hybrid" — that is a constant, and a test that reads a
 * constant back proves the constant is spelled the same twice. They claim the
 * three things that would be a security or data-loss defect if they broke:
 *
 *   1. An alert whose severity did not survive normalization takes the FAST
 *      lane. The reverse — quietly parking something that might be a critical —
 *      is the failure this product exists to make impossible.
 *   2. The push lane can never be emptied under `hybrid`, whichever order the
 *      two fields arrive in. An empty one sends `critical` down the slow lane
 *      and looks like a valid choice on the way in.
 *   3. A pull address is http(s) and nothing else, and a credential is one of
 *      the ones this console manages. Both fields are typed into a form by a
 *      human and dialled by the server; either is a request-forgery surface if
 *      it is not closed.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  defaultPolicy, expectedTransport, laneFor, normalizePolicyInput, onExpectedTransport,
} from './policy.ts';

describe('laneFor', () => {
  const hybrid = defaultPolicy();

  it('sends critical and high to the push lane under hybrid', () => {
    expect(laneFor('critical', hybrid)).toBe('fast');
    expect(laneFor('high', hybrid)).toBe('fast');
  });

  it('sends medium and low to the paced lane under hybrid', () => {
    expect(laneFor('medium', hybrid)).toBe('paced');
    expect(laneFor('low', hybrid)).toBe('paced');
  });

  it('treats an unrated alert as urgent, never as background', () => {
    // The whole point: an unknown urgency is not evidence of a low one.
    expect(laneFor(null, hybrid)).toBe('fast');
    expect(laneFor(undefined, hybrid)).toBe('fast');
  });

  it('ignores the severity entirely under a single-transport policy', () => {
    expect(laneFor('low', { ...hybrid, delivery: 'push' })).toBe('fast');
    expect(laneFor('critical', { ...hybrid, delivery: 'pull' })).toBe('paced');
  });
});

describe('expectedTransport', () => {
  it('names push for what the policy puts on the fast lane', () => {
    expect(expectedTransport('critical', defaultPolicy())).toBe('push');
    expect(expectedTransport('low', defaultPolicy())).toBe('pull');
  });

  it('never disagrees with a single-transport policy', () => {
    const push = { ...defaultPolicy(), delivery: 'push' as const };
    expect(onExpectedTransport('low', 'push', push)).toBe(true);
    // Under push-only there is no pull to be wrong about either: the question
    // does not apply, and a false here would light a warning nobody can act on.
    expect(onExpectedTransport('low', 'pull', push)).toBe(true);
  });

  it('reports a hybrid mismatch without that meaning a refusal', () => {
    expect(onExpectedTransport('low', 'push', defaultPolicy())).toBe(false);
    expect(onExpectedTransport('critical', 'push', defaultPolicy())).toBe(true);
  });
});

describe('normalizePolicyInput', () => {
  const current = defaultPolicy();

  it('keeps every field the caller did not mention', () => {
    const { policy, error } = normalizePolicyInput({ delivery: 'pull' }, current);
    expect(error).toBeNull();
    expect(policy.delivery).toBe('pull');
    // A save must not silently reset what it was not asked about.
    expect(policy.fastLane).toEqual(current.fastLane);
    expect(policy.pull.intervalSeconds).toBe(current.pull.intervalSeconds);
  });

  it('refuses an unknown delivery mode by name', () => {
    const { policy, error } = normalizePolicyInput({ delivery: 'firehose' }, current);
    expect(error).toMatch(/push, pull, hybrid/);
    expect(policy).toEqual(current);
  });

  it('refuses to empty the push lane under hybrid', () => {
    const { error } = normalizePolicyInput({ fastLane: [] }, current);
    expect(error).toMatch(/cannot be empty/);
  });

  it('refuses to empty it by switching TO hybrid, in either order', () => {
    // The check runs last as well as inline, so a caller cannot slip past it
    // by sending the two fields in the order that suits them.
    const pullOnly = { ...current, delivery: 'pull' as const, fastLane: [] };
    const { error } = normalizePolicyInput({ delivery: 'hybrid' }, pullOnly);
    expect(error).toMatch(/cannot be empty/);
  });

  it('allows an empty push lane when the policy is not hybrid', () => {
    const { error, policy } = normalizePolicyInput(
      { delivery: 'pull', fastLane: [] }, current,
    );
    expect(error).toBeNull();
    expect(policy.fastLane).toEqual([]);
  });

  it('refuses a severity it does not know rather than dropping it', () => {
    const { error } = normalizePolicyInput({ fastLane: ['critical', 'urgent'] }, current);
    expect(error).toMatch(/fastLane/);
  });

  it('clamps the interval instead of failing on an absurd one', () => {
    expect(normalizePolicyInput({ pull: { intervalSeconds: 1 } }, current).policy.pull.intervalSeconds)
      .toBe(15);
    expect(normalizePolicyInput({ pull: { intervalSeconds: 99999 } }, current).policy.pull.intervalSeconds)
      .toBe(3600);
  });

  it('answers with a sentence, not a 500, when the body is the wrong shape', () => {
    expect(normalizePolicyInput({ pull: { sources: 'nope' } }, current).error)
      .toMatch(/must be a list/);
    expect(normalizePolicyInput({ pull: { batchSize: 'many' } }, current).error)
      .toMatch(/must be a number/);
  });

  it('refuses a poll address that is not http or https', () => {
    const { error } = normalizePolicyInput(
      { pull: { sources: [{ source: 'wazuh', url: 'file:///etc/passwd' }] } },
      current,
    );
    expect(error).toMatch(/http:\/\/ or https:\/\//);
  });

  it('refuses a source name that could reach outside the mapping table', () => {
    const { error } = normalizePolicyInput(
      { pull: { sources: [{ source: '../secrets', url: '' }] } },
      current,
    );
    expect(error).toMatch(/not a valid source name/);
  });

  it('refuses the same source listed twice', () => {
    const { error } = normalizePolicyInput(
      { pull: { sources: [{ source: 'wazuh' }, { source: 'wazuh' }] } },
      current,
    );
    expect(error).toMatch(/listed twice/);
  });
});
