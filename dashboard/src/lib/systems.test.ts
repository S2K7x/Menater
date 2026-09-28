/**
 * J0.4 — the grouping behind the "By system" view.
 *
 * ============================================================================
 * WHAT THESE TESTS PROTECT
 *
 * The screen's whole claim is that everything threatening one system is in one
 * place. Three ways of being wrong are silent, and each has a test here:
 *
 *  - **the join not happening**: a machine's alerts and its code's flaws
 *    filed as two systems, so the screen shows twice as many systems as there
 *    are and every one of them is half a story;
 *  - **a system invented**: `—` is the console's display value for an address
 *    a detection did not record, and read as data it collects every
 *    address-less alert into a system nobody owns;
 *  - **a case dropped**: one that names neither a machine nor any code must be
 *    COUNTED, because an overview that quietly omits part of the queue is the
 *    failure that shows green.
 *
 * The case that carries a repository is not hand-written: it is built by
 * `findingToAlert` and read back by `scanRepository`, the real pair, because
 * the field this file splits on (`matched_on`) has one producer and this is
 * the reader. Three field names in `cases.ts` were wrong for their whole life
 * for exactly the want of that.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { groupBySystem } from './systems.ts';
import type { AlertCase, Severity } from './types.ts';
import { findingToAlert, scanRepository } from '../../server/findings.ts';
import { resolveRepository } from '../../server/inventory.ts';

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-1',
    received_at: '2026-09-28T10:00:00.000Z',
    state: 'closed',
    severity: 'medium' as Severity,
    rule_name: 'Something happened',
    source_ip: '185.220.101.47',
    dest_ip: '—',
    host: null,
    raw_log: 'log',
    extensions: null,
    shadow_mode: true,
    executed: false,
    routing_outcome: null,
    action_taken: null,
    enrichment: null,
    enrichment_meta: null,
    decision: null,
    approval: null,
    audit: null,
    stages: [],
    errors: [],
    attack: [],
    dwell_ms: null,
    repository: null,
    code_lead: null,
    ...over,
  }) as AlertCase;

/** The inventory an operator filled in for these tests. */
const INVENTORY = [
  { service: 'Billing API', identifiers: ['web-01', '10.12.4.31'], repository: '/srv/src/billing-api' },
];

/** A detection about a machine, resolved by the REAL inventory resolver. */
function detection(over: Partial<AlertCase> = {}): AlertCase {
  const c = kase(over);
  return { ...c, repository: resolveRepository(c, INVENTORY) };
}

/**
 * A case opened by promoting a scan finding, through the real pair: the alert
 * is composed by `findingToAlert` and its repository read back out of
 * `extensions` by `scanRepository`, which checks the derived id before
 * answering.
 */
function promoted(target: string, vulnerability = 'IDOR', runId = 'run-1'): AlertCase {
  const outcome = findingToAlert(
    {
      scan_run_id: runId,
      target,
      finding: {
        vulnerability, http_method: 'GET', route: '/orders/:id',
        file: 'src/routes/orders.ts', severity: 'high',
      },
    },
    new Date('2026-09-28T09:00:00.000Z'),
  );
  if (!outcome.ok) throw new Error(outcome.errors.join(', '));
  const alert = outcome.alert as Record<string, unknown>;
  const c = kase({
    alert_id: outcome.alert_id,
    rule_name: alert.rule_name as string,
    severity: alert.severity as Severity,
    extensions: alert.extensions as Record<string, unknown>,
    host: null,
    dest_ip: '—',
  });
  return { ...c, repository: scanRepository(c) };
}

describe('a machine and its code are one system', () => {
  it('files an alert about the machine and a flaw in its code under one entry', () => {
    // The whole point of the screen: the inventory says `web-01` runs
    // `/srv/src/billing-api`, and a flaw promoted from a scan of that same
    // target belongs to the same system — even though the promoted alert
    // deliberately names no machine at all.
    const { systems, unattributed } = groupBySystem([
      detection({ alert_id: 'ALT-A', host: 'web-01' }),
      promoted('/srv/src/billing-api'),
    ]);

    expect(unattributed).toBe(0);
    expect(systems).toHaveLength(1);
    expect(systems[0].alerts.map((c) => c.alert_id)).toEqual(['ALT-A']);
    expect(systems[0].flaws).toHaveLength(1);
    expect(systems[0].label).toBe('Billing API');
    expect(systems[0].repository).toBe('/srv/src/billing-api');
    expect(systems[0].machines).toEqual(['web-01']);
  });

  it('matches the repository the way the inventory matches an identifier', () => {
    // Case and surrounding space are the comparison and nothing else — the
    // rule `server/inventory.ts` states for an identifier, applied to the
    // string that joins the two halves. The inventory here is spelled with
    // capitals and the scan target in lower case with spaces around it: they
    // are one system.
    const mixed = [
      { service: 'Billing API', identifiers: ['web-01'], repository: '/srv/src/Billing-API' },
    ];
    const one = kase({ alert_id: 'ALT-A', host: 'web-01' });
    const { systems } = groupBySystem([
      { ...one, repository: resolveRepository(one, mixed) },
      promoted('  /srv/src/billing-api  '),
    ]);
    expect(systems).toHaveLength(1);
    expect(systems[0].flaws).toHaveLength(1);
    // AND THE VALUE SHOWN IS THE ONE SOMEBODY TYPED, never the comparison key:
    // the screen hands this string to the Code tab's launcher, and a path
    // silently lower-cased is a path that does not exist on a case-sensitive
    // filesystem.
    expect(systems[0].repository).toBe('/srv/src/Billing-API');
  });

  it('keeps a flaw whose target nobody mapped as a system of its own', () => {
    // Not an error and not a gap to fill: the inventory is keyed on machines
    // and this alert has none. It is code that was scanned, and it threatens
    // something, so it gets a line.
    const { systems } = groupBySystem([promoted('acme/checkout')]);
    expect(systems).toHaveLength(1);
    expect(systems[0].kind).toBe('code');
    expect(systems[0].label).toBe('acme/checkout');
    expect(systems[0].services).toEqual([]);
    expect(systems[0].machines).toEqual([]);
    expect(systems[0].alerts).toEqual([]);
  });
});

describe('what it refuses to invent', () => {
  it('groups by the machine when no inventory entry names the code', () => {
    // An install with an empty inventory still gets an overview: two alerts
    // naming the same host are about the same machine, which is a fact the
    // alerts carry rather than an inference.
    const { systems } = groupBySystem([
      kase({ alert_id: 'ALT-A', host: 'db-07' }),
      kase({ alert_id: 'ALT-B', host: 'DB-07' }),
    ]);
    expect(systems).toHaveLength(1);
    expect(systems[0].kind).toBe('machine');
    expect(systems[0].label).toBe('db-07');
    expect(systems[0].alerts).toHaveLength(2);
    expect(systems[0].repository).toBeNull();
  });

  it('never reads the em dash as a machine', () => {
    // `—` is what the card PRINTS for an address a detection did not record.
    // Taken as data it would collect every address-less alert into one
    // system, and that system would look like the busiest thing in the estate.
    const { systems, unattributed } = groupBySystem([
      kase({ alert_id: 'ALT-A', host: null, dest_ip: '—' }),
      kase({ alert_id: 'ALT-B', host: null, dest_ip: '—' }),
    ]);
    expect(systems).toEqual([]);
    expect(unattributed).toBe(2);
  });

  it('never groups by the source address', () => {
    // The source is usually the other end of the connection. Grouping by it
    // would file two unrelated alerts under the attacker's address as though
    // it were an asset of ours.
    const { systems, unattributed } = groupBySystem([
      kase({ alert_id: 'ALT-A', source_ip: '185.220.101.47' }),
      kase({ alert_id: 'ALT-B', source_ip: '185.220.101.47' }),
    ]);
    expect(systems).toEqual([]);
    expect(unattributed).toBe(2);
  });

  it('counts what it could not attribute instead of dropping it', () => {
    const { systems, unattributed } = groupBySystem([
      kase({ alert_id: 'ALT-A', host: 'web-01' }),
      kase({ alert_id: 'ALT-B' }),
      kase({ alert_id: 'ALT-C' }),
    ]);
    expect(systems).toHaveLength(1);
    expect(unattributed).toBe(2);
  });

  it('lists both names when two entries point at one repository, and picks neither', () => {
    // `normalizeInventory` refuses a duplicate IDENTIFIER, not a duplicate
    // repository, so this state is reachable from a legal inventory. Picking
    // one would be the tie-break J0.3 exists in order not to have.
    const shared = [
      { service: 'Billing API', identifiers: ['web-01'], repository: '/srv/app' },
      { service: 'Orders API', identifiers: ['web-02'], repository: '/srv/app' },
    ];
    const one = kase({ alert_id: 'ALT-A', host: 'web-01' });
    const two = kase({ alert_id: 'ALT-B', host: 'web-02' });
    const { systems } = groupBySystem([
      { ...one, repository: resolveRepository(one, shared) },
      { ...two, repository: resolveRepository(two, shared) },
    ]);
    expect(systems).toHaveLength(1);
    expect(systems[0].services).toEqual(['Billing API', 'Orders API']);
    expect(systems[0].label).toBe('Billing API · Orders API');
    expect(systems[0].machines).toEqual(['web-01', 'web-02']);
  });
});

describe('the order is the queue’s order, for the queue’s reason', () => {
  it('puts what is waiting on a human first, whatever its severity or date', () => {
    const { systems } = groupBySystem([
      kase({ alert_id: 'ALT-A', host: 'a', severity: 'critical', received_at: '2026-09-28T12:00:00.000Z' }),
      kase({
        alert_id: 'ALT-B', host: 'b', severity: 'low',
        state: 'awaiting_approval', received_at: '2026-09-20T12:00:00.000Z',
      }),
    ]);
    expect(systems.map((s) => s.label)).toEqual(['b', 'a']);
    expect(systems[0].awaiting).toBe(1);
  });

  it('then the worst severity present, then the most recent activity', () => {
    const { systems } = groupBySystem([
      kase({ alert_id: 'ALT-A', host: 'a', severity: 'medium', received_at: '2026-09-28T12:00:00.000Z' }),
      kase({ alert_id: 'ALT-B', host: 'b', severity: 'critical', received_at: '2026-09-01T12:00:00.000Z' }),
      kase({ alert_id: 'ALT-C', host: 'c', severity: 'medium', received_at: '2026-09-28T13:00:00.000Z' }),
    ]);
    expect(systems.map((s) => s.label)).toEqual(['b', 'c', 'a']);
    expect(systems[0].worst).toBe('critical');
    expect(systems[1].last).toBe('2026-09-28T13:00:00.000Z');
  });

  it('counts failures and the worst severity across BOTH halves of a system', () => {
    // A system whose only critical thing is a promoted flaw must not read as
    // a quiet one: the two lists are one answer to one question.
    const { systems } = groupBySystem([
      detection({ alert_id: 'ALT-A', host: 'web-01', severity: 'low', state: 'failed' }),
      promoted('/srv/src/billing-api'),
    ]);
    expect(systems[0].worst).toBe('high');
    expect(systems[0].failed).toBe(1);
  });
});
