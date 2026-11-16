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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { codeIncidents, groupBySystem } from './systems.ts';
import { INVENTORY_MATCHES, type AlertCase, type Severity } from './types.ts';
import { findingToAlert, scanRepository } from '../../server/findings.ts';
import { resolveRepository } from '../../server/inventory.ts';
import { tagAttack } from '../../server/engine/attack.ts';
import { codeLead } from '../../server/engine/code-lead.ts';

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

/**
 * J0.4 second slice — the offer this screen makes, and what qualifies it.
 *
 * J0.2 exists because *Analyse this code* on every case the inventory matched
 * is an offer that carries no information, and because an offer whose scope is
 * unstated buys a report whose silence reads as *nothing wrong*. The incident
 * card was fixed; this screen makes the same offer once per block and said
 * neither thing. The three claims below are what stop it saying nothing again.
 */
describe('the lead that qualifies the offer', () => {
  /** A detection built through the REAL pair, as the pipeline builds one. */
  function exploited(over: Partial<AlertCase> = {}): AlertCase {
    const c = detection(over);
    const attack = tagAttack(c.rule_name, c.raw_log);
    return { ...c, attack, code_lead: codeLead(attack) };
  }

  it('says WHY this system’s code is worth reading, and how many alerts said so', () => {
    const { systems } = groupBySystem([
      exploited({
        alert_id: 'ALT-A', host: 'web-01',
        rule_name: 'Web attack: SQL injection attempt on /orders',
      }),
      exploited({
        alert_id: 'ALT-B', host: 'web-01',
        rule_name: 'Cross-site scripting attempt blocked',
      }),
      // Same system, and nothing to do with the code: it must not be counted.
      exploited({
        alert_id: 'ALT-C', host: 'web-01',
        rule_name: 'Brute force: 40 failed SSH logins',
      }),
    ]);

    expect(systems).toHaveLength(1);
    expect(systems[0].lead).toEqual({
      technique_id: 'T1190', technique: 'Exploit Public-Facing Application',
    });
    // Scoped to the technique the sentence NAMES, not to the system's size:
    // the set of application techniques is built to grow, and a count covering
    // a technique the sentence does not name would stop being true the day it
    // does.
    expect(systems[0].leadAlerts).toBe(2);
  });

  it('reads the field the pipeline wrote, and never re-infers it from the rule name', () => {
    // The rule name matches `attack.ts`'s T1190 pattern exactly. `code_lead`
    // is `null` because this case did not go through that inference — a
    // promoted finding is the real example, since `tagAttack` deliberately
    // does not match flaw names. A second ruler here would disagree with the
    // tags printed on the card, on the screen that sends somebody to read
    // code during an incident.
    const { systems } = groupBySystem([
      detection({
        alert_id: 'ALT-A', host: 'web-01',
        rule_name: 'Web attack: SQL injection attempt on /orders',
        code_lead: null,
      }),
    ]);
    expect(systems[0].lead).toBeNull();
    expect(systems[0].leadAlerts).toBe(0);
  });

  it('answers nothing on a machine no code is mapped to', () => {
    // Gated on the repository, exactly as the card is: "the flaw may be in
    // this code" with no code to name is the line nobody can act on that J0.3
    // prints nothing at all rather than carry.
    const { systems } = groupBySystem([
      exploited({
        alert_id: 'ALT-A', host: 'unmapped-host',
        rule_name: 'Web attack: SQL injection attempt on /orders',
      }),
    ]);
    expect(systems[0].repository).toBeNull();
    expect(systems[0].lead).toBeNull();
  });

  it('leaves a system nothing exploited alone', () => {
    const { systems } = groupBySystem([
      exploited({
        alert_id: 'ALT-A', host: 'web-01',
        rule_name: 'Brute force: 40 failed SSH logins',
      }),
      promoted('/srv/src/billing-api'),
    ]);
    expect(systems[0].repository).toBe('/srv/src/billing-api');
    expect(systems[0].lead).toBeNull();
    expect(systems[0].leadAlerts).toBe(0);
  });
});

/**
 * J0.7 — the same join, read from the CODE's side.
 *
 * ============================================================================
 * WHAT THESE TESTS PROTECT
 *
 * `groupBySystem` answers *what threatens this machine*. This answers the
 * question a scan report asks: *is the code I am reading running anywhere that
 * already has an incident?* The join is the same one — `case.repository` — and
 * three ways of answering it are wrong in a way nothing else would catch:
 *
 *  - **counting a promoted finding's case.** Its `repository` comes out of
 *    `extensions`, and the derived alert id does not cover `target`, so a log
 *    source would decide which code this report calls attacked. The gate is
 *    `INVENTORY_MATCHES`, read from its declaration rather than spelled as
 *    "not a scan target", so a fifth origin is excluded the day it exists;
 *  - **matching loosely.** A suffix rule or a `.git` tolerance would send
 *    somebody to the wrong incident; the comparison is the inventory's own,
 *    which is J0.3's refusal to guess which repository runs where;
 *  - **claiming an absence.** The window is bounded and this tab renders with
 *    no snapshot at all, so a miss is `null` and the screen says nothing.
 * ============================================================================
 */
describe('what the queue already holds about one piece of code', () => {
  /** A detection built through the REAL pair, as the pipeline builds one. */
  function exploited(over: Partial<AlertCase> = {}): AlertCase {
    const c = detection(over);
    const attack = tagAttack(c.rule_name, c.raw_log);
    return { ...c, attack, code_lead: codeLead(attack) };
  }

  it('counts the detections about the system the inventory maps to this code', () => {
    const incidents = codeIncidents(
      [
        detection({ alert_id: 'ALT-A', host: 'web-01', state: 'awaiting_approval' }),
        detection({ alert_id: 'ALT-B', host: '10.12.4.31' }),
        // Another machine entirely: the count is about this code, not the window.
        detection({ alert_id: 'ALT-C', host: 'db-07' }),
      ],
      '/srv/src/billing-api',
    );

    expect(incidents).not.toBeNull();
    expect(incidents!.alerts).toBe(2);
    expect(incidents!.awaiting).toBe(1);
    // The name the operator gave the system, so the sentence says WHICH one.
    expect(incidents!.services).toEqual(['Billing API']);
  });

  it('names the technique that says the way in was this code, and counts only it', () => {
    const incidents = codeIncidents(
      [
        exploited({
          alert_id: 'ALT-A', host: 'web-01',
          rule_name: 'Web attack: SQL injection attempt on /orders',
        }),
        exploited({
          alert_id: 'ALT-B', host: 'web-01',
          rule_name: 'Cross-site scripting attempt blocked',
        }),
        exploited({
          alert_id: 'ALT-C', host: 'web-01',
          rule_name: 'Brute force: 40 failed SSH logins',
        }),
      ],
      '/srv/src/billing-api',
    );

    expect(incidents!.alerts).toBe(3);
    expect(incidents!.lead).toEqual({
      technique_id: 'T1190', technique: 'Exploit Public-Facing Application',
    });
    expect(incidents!.leadAlerts).toBe(2);
  });

  /**
   * THE SECURITY CLAIM, and the reason this is not `groupBySystem`.
   *
   * The promoted case here is built by the real `findingToAlert` and stamped
   * by the real `scanRepository`, so its `repository` is exactly the string
   * the scan carried — which is the string an attacker can choose, because
   * `findingAlertId` covers the flaw and the run and not the target. Counted,
   * it would let anything that can post an alert put a fabricated incident at
   * the top of a report about code somebody just typed.
   */
  it('refuses a case whose answer came out of `extensions`', () => {
    const forged = promoted('/srv/src/billing-api');
    expect(forged.repository?.matched_on).toBe('scan_target');
    expect(forged.repository?.repository).toBe('/srv/src/billing-api');

    expect(codeIncidents([forged], '/srv/src/billing-api')).toBeNull();

    // And it does not merely drop it from an otherwise empty answer: a real
    // detection beside it is still counted, and counted ONCE.
    const mixed = codeIncidents(
      [forged, detection({ alert_id: 'ALT-A', host: 'web-01' })],
      '/srv/src/billing-api',
    );
    expect(mixed!.alerts).toBe(1);
  });

  /**
   * The gate is DERIVED from the declaration, not from a list written tonight.
   * Every origin `CaseRepository` declares is either in the trusted set or
   * excluded, and this reads the union out of `types.ts` the way
   * `code-half.test.ts` does — so a fifth value cannot be counted by default.
   */
  it('counts an origin exactly when `INVENTORY_MATCHES` holds it', () => {
    const types = readFileSync(
      fileURLToPath(new URL('./types.ts', import.meta.url)), 'utf8',
    );
    const line = /matched_on:\s*([^;]+);/.exec(types);
    expect(line, 'the `matched_on` union is no longer where this test reads it').not.toBeNull();
    const declared = [...line![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(1);

    for (const origin of declared) {
      const one = kase({
        alert_id: `ALT-${origin}`,
        repository: {
          service: 'Billing API',
          repository: '/srv/src/billing-api',
          matched_on: origin as 'host',
          matched_value: 'web-01',
        },
      });
      const answer = codeIncidents([one], '/srv/src/billing-api');
      expect(
        answer !== null,
        `origin ${origin} should ${INVENTORY_MATCHES.has(origin) ? '' : 'not '}be counted`,
      ).toBe(INVENTORY_MATCHES.has(origin));
    }
  });

  it('matches the repository the way the inventory matches an identifier', () => {
    // Case and surrounding space, and nothing else. The same claim
    // `groupBySystem` makes above, on the string a LAUNCHER typed rather than
    // on the one a resolver stored.
    const one = detection({ alert_id: 'ALT-A', host: 'web-01' });
    expect(codeIncidents([one], '  /SRV/src/Billing-API  ')!.alerts).toBe(1);
    // No suffix rule, no `.git` tolerance: a near-match is a guess, and J0.3
    // refuses to guess which repository runs where.
    expect(codeIncidents([one], '/srv/src/billing-api.git')).toBeNull();
    expect(codeIncidents([one], 'billing-api')).toBeNull();
  });

  it('claims nothing when nothing matches, and nothing without a target', () => {
    const window = [
      detection({ alert_id: 'ALT-A', host: 'web-01' }),
      detection({ alert_id: 'ALT-B', host: 'db-07' }),
    ];
    // A non-empty window, so this is the discriminating case rather than an
    // absent one.
    expect(codeIncidents(window, '/srv/src/orders-api')).toBeNull();
    expect(codeIncidents(window, null)).toBeNull();
    expect(codeIncidents(window, '   ')).toBeNull();
  });
});
