/**
 * No screen names a product this console no longer runs.
 *
 * ============================================================================
 * WHY THIS IS A TEST AND NOT A NOTE IN THE CHANGELOG
 *
 * n8n was removed when the built-in engine landed, and the code followed. The
 * WORDS did not, in four places that all read as working software:
 *
 *   · the Health tab titled its engine card `n8n` — a hardcoded literal, the
 *     only user-facing string on that screen outside the catalogue, so the
 *     typed catalogue could not refuse it: it was never asked anything;
 *   · Settings announced "needs an n8n restart" over pipeline variables the
 *     engine re-reads on every run, and offered a docker-compose snippet the
 *     server had stopped sending — a change that HAD applied, reported as one
 *     that had not;
 *   · the Guide documented a third ingestion mode, "Observation", that relays
 *     to n8n. There are two;
 *   · the Tracking tab rendered "open in n8n" links whose href was always the
 *     empty string, under an external-link icon.
 *
 * None of it broke anything, which is exactly why it survived. A stale name is
 * cheapest to carry and most expensive to believe: it sends someone looking for
 * a container that is not in the compose file, and the screens concerned are
 * the ones whose whole job is to say what is true right now.
 *
 * Two claims, failing for different reasons: the Health title comes from the
 * catalogue (so it cannot drift back into a literal), and NO string the
 * catalogue hands to a screen names n8n at all.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { consoleDictionary } from '../i18n/console.ts';

const healthSource = readFileSync(
  join(process.cwd(), 'src/components/HealthPanel.tsx'), 'utf8');

/** Strip comments: the project's history is allowed to say the name. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every string the catalogue can put on a screen, functions included. */
function strings(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (typeof node === 'function') {
    // Call it with arguments that render: a label built from a count still
    // has to be checked, and several take numbers.
    try {
      const out = (node as (...a: unknown[]) => unknown)(1, 2, 3);
      return typeof out === 'string' ? [[path + '()', out]] : [];
    } catch {
      return [];
    }
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('n8n is gone from the interface, not only from the code', () => {
  it('takes the Health engine card title from the catalogue', () => {
    expect(healthSource).toContain('{h.engineTitle}');
  });

  it('renders no hardcoded n8n label on the Health tab', () => {
    expect(code(healthSource)).not.toMatch(/\bn8n\b/i);
  });

  it('names the built-in engine', () => {
    expect(consoleDictionary('en').health.engineTitle).toBe('Built-in engine');
  });

  it('has no user-facing string naming n8n', () => {
    const offenders = strings(consoleDictionary('en'))
      .filter(([, value]) => /\bn8n\b/i.test(value))
      .map(([path, value]) => `${path}: ${value.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });
});
