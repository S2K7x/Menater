/**
 * The service ↔ repository inventory (J0.3).
 *
 * Three things are worth a test here, and they are the three ways this
 * feature could hurt someone:
 *
 *  1. IT MUST NEVER GUESS. A near-miss on a hostname has to resolve to
 *     nothing, because the alternative sends an analyst to read the wrong
 *     repository while an incident is open.
 *  2. IT MUST NEVER HOLD AN AMBIGUITY. Two entries claiming one machine is a
 *     question, and the store refuses questions rather than tossing a coin.
 *  3. DELETING AN ENTRY MUST DELETE IT. `config.json`'s merge spreads
 *     sections, and a list stored as a section would come back from the dead.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ENTRIES, MAX_IDENTIFIERS, MAX_TEXT,
  normalizeInventory, readInventory, resolveRepository,
} from './inventory.ts';
import type { InventoryEntry } from '../src/lib/types.ts';

const entry = (over: Partial<InventoryEntry> = {}): InventoryEntry => ({
  service: 'orders-api',
  identifiers: ['web-01', '10.12.4.31'],
  repository: '/srv/src/orders-api',
  ...over,
});

describe('resolving a machine to the code it runs', () => {
  it('matches a hostname exactly, and says which observable did it', () => {
    const match = resolveRepository({ host: 'web-01' }, [entry()]);
    expect(match).toEqual({
      service: 'orders-api',
      repository: '/srv/src/orders-api',
      matched_on: 'host',
      matched_value: 'web-01',
    });
  });

  it('ignores case and surrounding spaces — a hostname is not case-sensitive', () => {
    expect(resolveRepository({ host: '  WEB-01 ' }, [entry()])?.service).toBe('orders-api');
  });

  /**
   * THE POINT OF THE WHOLE DESIGN. A suffix rule, a CIDR range or a "looks
   * close enough" would each be an invented default in the one place where
   * being wrong costs an investigation.
   */
  it('does NOT match a hostname that merely resembles one it knows', () => {
    expect(resolveRepository({ host: 'web-01.corp.lan' }, [entry()])).toBeNull();
    expect(resolveRepository({ host: 'web-011' }, [entry()])).toBeNull();
    expect(resolveRepository({ dest_ip: '10.12.4.3' }, [entry()])).toBeNull();
  });

  it('answers nothing when the inventory says nothing about the machine', () => {
    expect(resolveRepository({ host: 'db-07' }, [entry()])).toBeNull();
    expect(resolveRepository({ host: 'web-01' }, [])).toBeNull();
  });

  /**
   * `—` is the console's DISPLAY value for an address a detection did not
   * record. An inventory entry named `—` must not become a wildcard for every
   * alert that carries no address.
   */
  it('treats the display dash as absent, not as a value', () => {
    const dashed = [entry({ identifiers: ['—'] })];
    expect(resolveRepository({ source_ip: '—', dest_ip: '—', host: null }, dashed)).toBeNull();
  });

  it('prefers the host, then the destination, then the source', () => {
    const inventory = [
      entry({ service: 'by-host', identifiers: ['web-01'], repository: '/srv/a' }),
      entry({ service: 'by-dest', identifiers: ['10.0.0.9'], repository: '/srv/b' }),
      entry({ service: 'by-source', identifiers: ['10.0.0.4'], repository: '/srv/c' }),
    ];
    const all = { host: 'web-01', dest_ip: '10.0.0.9', source_ip: '10.0.0.4' };
    expect(resolveRepository(all, inventory)?.service).toBe('by-host');
    expect(resolveRepository({ ...all, host: null }, inventory)?.service).toBe('by-dest');
    expect(resolveRepository({ ...all, host: null, dest_ip: '—' }, inventory)?.service)
      .toBe('by-source');
  });

  /**
   * Lateral movement is the case that justifies looking at `source_ip` at
   * all: the other end of the connection is one of ours.
   */
  it('names the source address when that is what matched', () => {
    const match = resolveRepository({ host: null, source_ip: '10.12.4.31' }, [entry()]);
    expect(match?.matched_on).toBe('source_ip');
    expect(match?.matched_value).toBe('10.12.4.31');
  });
});

describe('what the store refuses to hold', () => {
  it('refuses one identifier claimed by two entries, and names it', () => {
    const { problems } = normalizeInventory([
      entry({ service: 'orders-api' }),
      entry({ service: 'billing-api', identifiers: ['web-01'], repository: '/srv/billing' }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe('inventory.1.identifiers');
    expect(problems[0].detail).toContain('web-01');
    expect(problems[0].detail).toContain('entry 1');
  });

  it('says the same identifier is listed twice on one entry, in those words', () => {
    // "already listed on entry 1", read while editing entry 1, sends someone
    // hunting for a second entry that does not exist.
    const { problems } = normalizeInventory([entry({ identifiers: ['web-01', 'WEB-01'] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0].detail).toContain('twice on this entry');
  });

  /**
   * Silently shortening a path is worse than refusing it: the save looks like
   * it worked, and the failure surfaces much later in the scan launcher,
   * saying nothing about what cut the value.
   */
  it('REPORTS an over-long value rather than quietly cutting it', () => {
    const { problems } = normalizeInventory([entry({ repository: 'x'.repeat(MAX_TEXT + 1) })]);
    expect(problems.map((p) => p.field)).toContain('inventory.0.repository');
    expect(problems[0].detail).toContain(String(MAX_TEXT));
  });

  it('refuses an entry that lists nothing — it could never match', () => {
    const { problems } = normalizeInventory([entry({ identifiers: [] })]);
    expect(problems.map((p) => p.field)).toContain('inventory.0.identifiers');
  });

  it('refuses a missing service name and a missing repository, separately', () => {
    const { problems } = normalizeInventory([entry({ service: '', repository: '' })]);
    expect(problems.map((p) => p.field)).toEqual([
      'inventory.0.service',
      'inventory.0.repository',
    ]);
  });

  it('says the body was the wrong shape rather than throwing on it', () => {
    expect(normalizeInventory('nope').problems[0].field).toBe('inventory');
    expect(normalizeInventory([42]).problems[0].field).toBe('inventory.0');
    expect(normalizeInventory([{ ...entry(), identifiers: 'web-01' }]).problems[0].field)
      .toBe('inventory.0.identifiers');
  });

  it('bounds the list and each entry rather than growing the config file', () => {
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) =>
      entry({ service: `s${i}`, identifiers: [`h${i}`] }));
    const { entries, problems } = normalizeInventory(many);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(problems.some((p) => p.field === 'inventory')).toBe(true);

    const wide = normalizeInventory([
      entry({ identifiers: Array.from({ length: MAX_IDENTIFIERS + 3 }, (_, i) => `h${i}`) }),
    ]);
    expect(wide.entries[0].identifiers).toHaveLength(MAX_IDENTIFIERS);
  });

  it('accepts a well-formed inventory with nothing to say about it', () => {
    expect(normalizeInventory([entry()]).problems).toEqual([]);
    expect(normalizeInventory(undefined)).toEqual({ entries: [], problems: [] });
  });
});

describe('reading a file that was edited by hand', () => {
  it('keeps what it can read, drops what it cannot, and says so', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kept = readInventory([entry(), { service: 'broken' }]);
    expect(kept.map((e) => e.service)).toEqual(['orders-api']);
    // Silently shrinking somebody's table is how a machine stops being covered
    // without anyone noticing.
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('never throws: a corrupt list must not stop the console from starting', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readInventory('garbage')).toEqual([]);
    expect(readInventory(null)).toEqual([]);
    spy.mockRestore();
  });
});

/**
 * The config file, for real.
 *
 * `merge()` spreads one level of sections. Stored as a bare array the
 * inventory would be spread index by index, and a save that REMOVED an entry
 * would leave the removed one behind at its old index — a machine deleted from
 * the table and still on screen. Hence `{ entries: [...] }`, and hence this
 * test, which is the only one that would have caught it.
 */
describe('through config.json', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'menater-inv-'));
    process.env.MENATER_CONFIG = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.MENATER_CONFIG = '/nonexistent/menater-test-config.json';
  });

  async function load() {
    vi.resetModules();
    return import('./config.ts');
  }

  it('starts empty — the console claims to know no machine it was not told about', async () => {
    const { getConfig } = await load();
    expect(getConfig().inventory.entries).toEqual([]);
  });

  it('stores an inventory and gives it back', async () => {
    const { saveConfig, publicView } = await load();
    saveConfig({ inventory: { entries: [entry()] } });
    expect(publicView().inventory.entries).toEqual([entry()]);
  });

  it('REMOVES an entry when the saved list no longer has it', async () => {
    const { saveConfig } = await load();
    const a = entry({ service: 'a', identifiers: ['host-a'], repository: '/srv/a' });
    const b = entry({ service: 'b', identifiers: ['host-b'], repository: '/srv/b' });
    saveConfig({ inventory: { entries: [a, b] } });
    const after = saveConfig({ inventory: { entries: [a] } });
    expect(after.inventory.entries).toEqual([a]);
  });

  it('drops an unusable entry on the way in rather than storing it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { saveConfig } = await load();
    const stored = saveConfig({ inventory: { entries: [entry(), { service: 'no-target' }] } });
    expect(stored.inventory.entries).toHaveLength(1);
    spy.mockRestore();
  });
});
