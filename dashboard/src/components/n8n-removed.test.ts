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
 *
 * ============================================================================
 * AND THE HALF THIS FILE DID NOT COVER
 *
 * That sweep walked ONE of the two catalogues. `server/i18n.ts` writes the
 * diagnostic, the chain notes and every route answer, and it kept the
 * VOCABULARY of the thing that left even though it never kept the name:
 *
 *   · `api.webhookUnreachable` told an operator to "check that 01-Ingestion is
 *     published and the instance answers" — a publish step that does not
 *     exist, on the screen whose whole job is to name what is wrong;
 *   · `api.approvalUnreachable` / `api.approvalRefused` described relaying a
 *     decision to another product over HTTP. The engine runs in this process;
 *   · `api.urlMissing` / `api.keyMissing` / `api.keyRefused` / `api.connected`
 *     / `api.answered` / `health.noApiKey` asked for an instance address and an
 *     API key nothing dials any more;
 *   · `health.findingNothingPublished` is a finding that can never fire.
 *
 * None of them contains the string "n8n", which is why the test above passed
 * over them, and NOTHING referenced them — a typed catalogue refuses a key
 * added on one side only, it cannot refuse a string that never asked it
 * anything. Ten of them were in the server catalogue and four more in the
 * console one. So the two rules below are: no publish vocabulary in either
 * catalogue, and no message either catalogue declares that no code mentions.
 * ============================================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { consoleDictionary } from '../i18n/console.ts';
import { messages } from '../../server/i18n.ts';

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

/**
 * Every leaf KEY of a catalogue, whatever the leaf turned out to be.
 *
 * `strings()` above answers "what could appear on a screen"; this answers
 * "what does this catalogue declare", which is the question a dead entry hides
 * from. A function leaf has to count: `webhookUnreachable` was one.
 */
function leafKeys(node: unknown, path = ''): string[] {
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leafKeys(v, path ? `${path}.${k}` : k));
  }
  return path ? [path] : [];
}

/**
 * Every line of PRODUCT code that could name a message.
 *
 * Read as ONE string and searched for the bare key name, so a key reached by
 * destructuring (`const { approvalSent } = m.api`) counts as used. That makes
 * the check one-directional ON PURPOSE: a key whose name collides with an
 * ordinary word is reported as used even if it is not, and nothing is ever
 * flagged that is actually referenced. It under-reports; it does not lie.
 *
 * TESTS AND COMMENTS ARE EXCLUDED, and that is not tidiness. The first draft
 * of this file listed the dead keys in its own header to explain them —
 * and the rule below went green on prose describing the defect it exists to
 * catch. A string only a test asserts on, or only a comment mourns, is a
 * string no operator will ever read.
 *
 * BOTH CATALOGUES ARE EXCLUDED for the same reason one notch in: a catalogue
 * declares its own keys, so leaving its file in here makes every key vouch for
 * itself. The second draft did exactly that, and the console-catalogue rule
 * below passed on a catalogue that still held four dead entries.
 */
const CATALOGUES = [join('server', 'i18n.ts'), join('src', 'i18n', 'console.ts')];

const sourceText = (() => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
        && !CATALOGUES.some((c) => full.endsWith(c))) files.push(full);
    }
  };
  walk(join(process.cwd(), 'server'));
  walk(join(process.cwd(), 'src'));
  return code(files.map((f) => readFileSync(f, 'utf8')).join('\n'));
})();

/**
 * "Publication" is in there too: the Health fold was titled with it, and a
 * word this product does not have should not survive because it was spelt as
 * a noun.
 */
const PUBLISH_VOCABULARY = /publish|publicat/i;

describe('no screen describes a publish step this product does not have', () => {
  it('has no user-facing string, on either side, claiming a workflow is published', () => {
    const offenders = [
      ...strings(consoleDictionary('en')),
      ...strings(messages('en')).map(([path, value]): [string, string] => [`server.${path}`, value]),
    ]
      // The Guide is the one place the word belongs, because it is where the
      // product explains what it no longer has. Carved out by PREFIX rather
      // than by a frozen path: `docs.sections.7.points.1` moves the day a
      // section is inserted above it, and a test that has to be renumbered is
      // a test somebody eventually renumbers wrongly.
      .filter(([path]) => !path.startsWith('docs.'))
      .filter(([, value]) => PUBLISH_VOCABULARY.test(value))
      .map(([path, value]) => `${path}: ${value.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it('keeps the Guide entry that explains the absence, so the carve-out cannot go stale', () => {
    // Without this, deleting the explanation would silently widen the rule
    // above into "the Guide may say anything".
    const explains = strings(consoleDictionary('en'))
      .filter(([path]) => path.startsWith('docs.'))
      .filter(([, value]) => /no publish step/i.test(value));
    expect(explains.length).toBeGreaterThan(0);
  });
});

describe('neither catalogue carries a message nothing asks for', () => {
  /**
   * A key nothing mentions is a string that cannot reach a screen — and the
   * twelve this caught were all describing a product that left. The typed
   * catalogue cannot see them: it refuses a key added on ONE side, and both
   * sides of a dead key agree with each other perfectly.
   */
  const orphans = (catalogue: unknown): string[] =>
    leafKeys(catalogue).filter((path) => {
      const key = path.split('.').pop() as string;
      // Array indices are positions, not names: `docs.sections.3` is reached
      // by iterating, and no source file will ever contain the digit as a key.
      return !/^\d+$/.test(key) && !sourceText.includes(key);
    });

  it('mentions every key the server catalogue declares', () => {
    expect(orphans(messages('en'))).toEqual([]);
  });

  it('mentions every key the console catalogue declares', () => {
    expect(orphans(consoleDictionary('en'))).toEqual([]);
  });
});
