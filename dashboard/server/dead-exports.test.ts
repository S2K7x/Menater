/**
 * Nothing here exports a symbol nobody reads.
 *
 * ============================================================================
 * THE FAMILY, AND WHY IT KEPT BEING FOUND BY ACCIDENT
 *
 * A declaration with writers and no readers is one of this project's most
 * expensive recurring shapes, and every instance of it was found sideways,
 * while somebody was looking at something else:
 *
 *   NodeDef.retry            five nodes declared a retry policy; the engine
 *                            read the field nowhere, the Ingestion tab PRINTED
 *                            it, and an operator incident said the audit write
 *                            had failed "after retries" over one attempt
 *   Settings.meta.from_env   written by `config.ts` under a comment explaining
 *                            why a field must say where its value came from,
 *                            read by no screen
 *   soc_tuning_rule.match_count
 *                            a column three screens read, a method that writes
 *                            it, and no caller — so every rule on every
 *                            install read "Never matched"
 *   PromoteResult.alert_id   the promote route has answered it since J0.1 and
 *                            nothing read it, so the one control bridging the
 *                            two halves forgot its own outcome
 *
 * And the journal has carried `readVariables` / `writeVariables` and
 * `fetchWithTimeout` in its standing leads for weeks, each time under its own
 * verdict — *"the honest row is the deletion, and it is not this night's
 * subject"* — because the only instrument that had ever found them was a
 * Sunday that happened to look. **Nothing in this repository looked for them**,
 * which is the whole reason this file exists: the cost of this family is not
 * any one instance, it is that noticing is unscheduled.
 *
 * ============================================================================
 * WHY THE CLAIM IS A SUBTRACTION
 *
 * A test naming the symbols that are dead tonight goes stale silently the day
 * a new one is written, which is exactly how these lasted. So the claim is
 * that NO exported symbol under `server/` or `src/` is unreferenced, with an
 * exemption list — `KEPT` — where every entry carries a written reason.
 *
 * It is asserted in BOTH directions. An exemption whose symbol has gained a
 * reader, or gone away, FAILS and asks to be deleted, rather than passing over
 * nothing: that is the rule `ADVISORY_FLOORS` already applies to a package
 * that has left the tree.
 *
 * ============================================================================
 * HOW A REFERENCE IS RESOLVED, AND WHY NOT BY NAME
 *
 * By import PATH, not by name. A name-based sweep cannot tell which module's
 * symbol was used, and this repository has ten names declared in two places —
 * which is not a hypothetical cost: `hostOf` is exported by
 * `intel/observables.ts` and ALSO declared, privately and differently, in
 * `http.ts` and in `engine/nodes/io.ts`. Every name-based sweep a previous
 * night ran reported it as referenced. It is not.
 *
 * Resolution is reliable here for one reason: this server runs under
 * `node --experimental-strip-types`, so every relative import carries its
 * extension. There is nothing to guess.
 *
 * Three things measured while building the ruler, each of which had it reading
 * the wrong number first:
 *
 *   - `from '…'` alone misses `await import('…')`, and three symbols are
 *     reached only that way (`resetThrottle`, `throttleRecordCount`,
 *     `resetIntelThrottle`). A sweep without it calls them dead.
 *   - `grep` treats a file holding a NUL byte as BINARY and prints no lines
 *     from it. Two files here hold one (`intel/lookup.ts`,
 *     `assistant/assistant.test.ts`), which is what made a grep-based sweep
 *     report `providersFor` as an orphan while `lookup.ts` calls it.
 *   - Tests count as readers. A symbol exported so a test can reach it is not
 *     dead; the test is the reader.
 *
 * Resolving by path is also what makes THIS file safe to leave in its own
 * corpus. `KEPT`'s keys are string literals holding the very names the sweep
 * hunts — a test whose own text satisfies it is a trap this repository has
 * paid for twice — and they are harmless only because nothing here imports a
 * product module, so no reference of this file's can ever be attributed to
 * one. Excluding the file instead was measured and is a line no test can
 * fail on; the invariant that actually holds is asserted below.
 *
 * ============================================================================
 * WHAT THIS RULER CANNOT SEE, STATED BECAUSE IT IS THE INTERESTING HALF
 *
 * It sees top-level `export function|const|let|class` and nothing else. So
 * interface FIELDS and class METHODS are outside it — and FOUR of the five
 * instances listed at the top of this file were fields. There is a live one
 * today: `RuleStore.history` is the only reader of `soc_tuning_rule_history`,
 * a table three write paths fill on every rule change, and it has no caller —
 * so the history is written and reachable from nowhere. Catching that needs a
 * type-aware pass, not a regex, and this file does not pretend to be one.
 * ============================================================================
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `dashboard/`, two levels up from this file. */
const ROOT = resolve(import.meta.dirname, '..');

/**
 * Exemptions. The key is `<path relative to dashboard/>::<symbol>`, and the
 * value is why it is still here. Each one is a thing somebody decided to keep,
 * which is the point: an exemption with a reason is visible, where a symbol
 * quietly left in the tree is not.
 */
const KEPT: Record<string, string> = {
  'server/ingest/cursors.ts::forgetCursor':
    'The server half of a feature nobody has built: there is no way for an '
    + 'operator to make a source re-read its window after a bad cursor. '
    + 'Deleting it would delete the one place that thought about it.',
  'server/intel/observables.ts::hostOf':
    'The unwired half of a product question. A `url` observable reaches '
    + 'exactly one provider (VirusTotal, which takes the URL itself); the '
    + 'three IP providers take `ipv4`/`ipv6` only. Whether a URL lookup should '
    + 'also ask the domain providers about its HOST is a decision, and this is '
    + 'the function that answers it.',
  'src/vulnpipe/lib/finding-status.ts::DISMISSING_STATUSES':
    'Byte-identical to `STATUSES_NEEDING_NOTE` beside it, so the open question '
    + 'is whether a "still to handle" filter was meant to exist. A product '
    + 'question, not residue.',
};

/* ==========================================================================
 * THE SWEEP
 * ========================================================================== */

/**
 * Comments stripped; import and `export … from` lines removed, so neither a
 * re-export nor a file's own prose can vouch for a symbol.
 *
 * `[^:]` before `//` is what keeps `'http://…'` from being read as the start
 * of a comment — this repository holds a great many of those in strings.
 *
 * MEASURED: stripping comments changes the orphan list by NOTHING today, and
 * a mutation that keeps them is green. For prose to vouch for a symbol it
 * would have to name it from inside a module that imports the symbol's module,
 * and no comment here does; nor is there a single commented-out relative
 * import anywhere under `server/` or `src/`, which is the other thing the
 * strip protects (`pulls` reads the stripped text). It stays because a comment
 * is not a reference and this repository has twice paid for a sweep its own
 * prose satisfied — not because a test stands behind it. This note is here so
 * the next reader does not believe one does.
 */
function body(src: string): string {
  return comments(src)
    .replace(/^\s*(?:import|export)[\s\S]*?from\s+'[^']*';$/gm, ' ')
    .replace(/^\s*import\s+'[^']*';$/gm, ' ');
}

function comments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The modules a file pulls from — static import, `export … from`, dynamic. */
function pulls(src: string, from: string): Set<string> {
  const out = new Set<string>();
  for (const m of comments(src).matchAll(/(?:from|import\s*\()\s*'([^']*)'/g)) {
    if (m[1].startsWith('.')) out.add(resolve(dirname(from), m[1]));
  }
  return out;
}

const EXPORTED = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

interface Sweep {
  orphans: string[];
  declarations: number;
  files: string[];
  text: Map<string, string>;
}

function sweep(): Sweep {
  const files = [
    ...sources(join(ROOT, 'server')),
    ...sources(join(ROOT, 'src')),
    ...sources(join(ROOT, 'scripts')),
    join(ROOT, 'vite.config.ts'),
    join(ROOT, 'vitest.config.ts'),
  ];

  // `readFileSync` and not `grep`: see the NUL note in the header.
  const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const stripped = new Map(files.map((f) => [f, body(text.get(f)!)]));
  const imports = new Map(files.map((f) => [f, pulls(text.get(f)!, f)]));

  const orphans: string[] = [];
  let declarations = 0;

  for (const file of files) {
    if (/\.test\.tsx?$/.test(file)) continue;
    for (const m of stripped.get(file)!.matchAll(EXPORTED)) {
      declarations += 1;
      const name = m[1];
      const uses = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
      // Minus one: the declaration the match came from is not a reference.
      let refs = (stripped.get(file)!.match(uses) ?? []).length - 1;
      for (const other of files) {
        if (other === file || !imports.get(other)!.has(file)) continue;
        refs += (stripped.get(other)!.match(uses) ?? []).length;
      }
      if (refs <= 0) orphans.push(`${relative(ROOT, file)}::${name}`);
    }
  }

  return { orphans, declarations, files, text };
}

/* ==========================================================================
 * THE CLAIM, IN BOTH DIRECTIONS
 * ========================================================================== */

describe('no exported symbol is unreferenced', () => {
  it('finds no orphan outside the exemption list', () => {
    const { orphans } = sweep();
    const unexplained = orphans.filter((o) => !(o in KEPT));
    expect(
      unexplained,
      'exported and referenced nowhere — delete it, or add it to KEPT with a '
      + `reason:\n${unexplained.join('\n')}`,
    ).toEqual([]);
  });

  it('still finds every exemption, so none of them passes over nothing', () => {
    // The other direction. An exemption whose symbol has gained a reader is no
    // longer an exemption, and one whose symbol has gone describes nothing —
    // both have to be noticed, or this list becomes the stale documentation
    // the rule exists to refuse.
    const { orphans } = sweep();
    const stale = Object.keys(KEPT).filter((k) => !orphans.includes(k));
    expect(
      stale,
      `listed in KEPT and no longer an orphan — remove the entry:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});

describe('the ruler itself', () => {
  it('scanned the product rather than nothing', () => {
    // A subtraction is also satisfied by a sweep that read no files. Both
    // floors are well under what is there (453 exports over 265 files when
    // this was written), so they refuse an empty walk without going red on
    // ordinary growth or deletion.
    const { declarations, files } = sweep();
    expect(declarations).toBeGreaterThan(400);
    expect(files.length).toBeGreaterThan(200);
  });

  it('imports no product module, so its own text cannot vouch for a symbol', () => {
    // The invariant the header rests on, and the one that can break: add a
    // NAMED relative import here and `KEPT`'s string literals start counting
    // as references to whatever was imported — the sweep would then exempt
    // symbols it had just declared alive. Measured: adding
    // `import { forgetCursor } from './ingest/cursors.ts'` turns this test red
    // AND the stale-exemption test with it.
    //
    // A bare `import './x.ts';` is deliberately not an edge and this does not
    // see one: a side-effect import carries no names, so it cannot attribute
    // any of this file's text to that module.
    const own = readFileSync(import.meta.filename, 'utf8');
    expect([...pulls(own, import.meta.filename)]).toEqual([]);
  });

  it('reads the files grep calls binary', () => {
    // `intel/lookup.ts` holds two NUL bytes, so `grep` without `-a` prints
    // "binary file matches" and no lines — which is what made an earlier sweep
    // report `providersFor` as dead while this file calls it. Nothing depends
    // on it TONIGHT (no symbol is referenced only from a NUL-bearing file), so
    // this is a claim about the instrument: it goes red the day somebody
    // reimplements the sweep with a reader that skips binary.
    const { text } = sweep();
    const withNul = [...text].filter(([, src]) => src.includes('\0')).map(([f]) => relative(ROOT, f));
    expect(withNul).toContain('server/intel/lookup.ts');
    expect(text.get(join(ROOT, 'server/intel/lookup.ts'))).toContain('providersFor');
  });
});
