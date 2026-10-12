/**
 * The URL contract, in the one place it is decided (C1.1).
 *
 * The pairing of tab and slug needs no test — `Tab` is `keyof typeof
 * TAB_SLUGS`, so neither half can exist without the other. What a type cannot
 * say is in here: that no two tabs share a slug (which type-checks and leaves
 * one of them unreachable by link), that a link survives being copied by hand,
 * and that a fragment this version does not fully understand is refused whole
 * rather than read down to the part it recognises.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TAB, TAB_SLUGS, parseRoute, routeHash, type Tab } from './route.ts';

const TABS = Object.keys(TAB_SLUGS) as Tab[];

describe('the slug table', () => {
  it('gives every tab a distinct word', () => {
    const slugs = TABS.map((t) => TAB_SLUGS[t]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('spells them the way a URL is typed', () => {
    for (const slug of TABS.map((t) => TAB_SLUGS[t])) {
      expect(slug).toMatch(/^[a-z]+$/);
    }
  });

  it('round-trips every tab through its own fragment', () => {
    for (const tab of TABS) {
      expect(parseRoute(routeHash(tab))).toBe(tab);
    }
  });

  it('names the screens by what the operator calls them', () => {
    // The four that would otherwise carry an internal id into a URL somebody
    // reads out loud. Pinned because the whole point of the table is that
    // these four are NOT the ids.
    expect(routeHash('queue')).toBe('#/alerts');
    expect(routeHash('trace')).toBe('#/tracking');
    expect(routeHash('intel')).toBe('#/lookup');
    expect(routeHash('docs')).toBe('#/guide');
  });
});

describe('reading a fragment', () => {
  it('survives the three things a hand-copied link loses', () => {
    expect(parseRoute('#/health')).toBe('health');
    expect(parseRoute('#health')).toBe('health');
    expect(parseRoute('#/health/')).toBe('health');
    expect(parseRoute('#/HEALTH')).toBe('health');
  });

  it('answers null for a visit that names nothing', () => {
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#')).toBeNull();
    expect(parseRoute('#/')).toBeNull();
  });

  it('answers null for a word that is not a tab', () => {
    expect(parseRoute('#/nonsense')).toBeNull();
    expect(parseRoute('#/alert')).toBeNull();
  });

  it('refuses a fragment carrying more than this version understands', () => {
    // `#/alerts/1234` is what a later version would use for an open incident.
    // Reading it as `alerts` would open the queue and let the sender believe
    // the other person is looking at the alert.
    expect(parseRoute('#/alerts/1234')).toBeNull();
    expect(parseRoute('#/alerts?id=1234')).toBeNull();
  });

  it('opens where the console has always opened', () => {
    expect(DEFAULT_TAB).toBe('queue');
  });
});
