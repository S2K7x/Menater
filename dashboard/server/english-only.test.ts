/**
 * Nothing this console can WRITE is in French.
 *
 * ============================================================================
 * WHY A CATALOGUE SWEEP COULD NEVER SEE THESE
 *
 * `CLAUDE.md` opens with one absolute rule — *"Write everything in English —
 * code, comments, documentation, user-facing strings"* — and § English only
 * explains how it is kept: a typed catalogue refuses a key added on one side
 * only, and that is what keeps user-facing strings out of components.
 *
 * It cannot refuse a string that never asked it anything. `n8n-removed.test.ts`
 * walks the four catalogues by key name; the strings below are template
 * literals inside server modules, so they were never *asked* anything — the
 * same shape as the Health tab's hardcoded engine card and the Rules tab's
 * French `Base de données (règles)`, both of which this table records.
 *
 * And the one place they render is a FAILURE. Measured, through the real engine
 * on the real workflows:
 *
 *   validateDecision          7 of its ~16 violation strings were French, mixed
 *                             into one list with the English ones, and
 *                             `fallbackDecision` interpolates them into
 *                             `decision.reasoning` — the field the incident
 *                             card prints, the chat approval request quotes,
 *                             the assistant is handed and `soc_audit_log`
 *                             keeps. So a rejected model answer produced
 *                             "Verdict forced by the pipeline: … Last
 *                             violation(s): reasoning manquant ou vide."
 *   registry.ts `need`        a pipeline variable that is not a number answers
 *                             `Variable « shadow.exitThreshold » : « fifty »
 *                             n'est pas un nombre.` into `soc_run.error` and
 *                             `soc_run_step.error` — reachable from Settings,
 *                             where every numeric variable is a free-text box
 *                             — five lines under its English sibling
 *   ingestion.ts              `Deduplication returned no row. With no answer we
 *                             cannot affirmer que l'alerte est nouvelle.` — one
 *                             sentence, two languages, on the run error a
 *                             sender is told about
 *   vulnpipe.ts               the Code tab's 503 banner, i.e. the first thing a
 *                             fresh install reads on that tab
 *   demo.ts                   a `validator_violations` entry on the
 *                             demonstration incident card, which is the state
 *                             every install with no database is in
 *
 * Three of them switch language MID-SENTENCE, and one is ungrammatical in both
 * ("…une sortie de repli. Sans it, an unexpected value stops the flow…"). That
 * is not a language choice left in place: it is an edit that stopped halfway,
 * and no test and no sweep could see it. Two tests were asserting ON the
 * French, which is the third and fourth instance of that trap here.
 *
 * ============================================================================
 * WHY THE TYPESCRIPT AST AND NOT A REGEX
 *
 * Measured, because the first ruler was wrong. A hand-rolled comment stripper
 * read the `/` of `.replace(/[^a-zA-Z0-9]+/g, '-')` as ordinary text, then took
 * the quote inside the regex as the start of a string literal and ran on — so
 * it reported two French COMMENTS in `vulnpipe/lib/report-markdown.ts` as
 * strings, and silently swallowed whatever lay between them. A ruler that
 * over-reports and under-reports in the same pass is this repository's own
 * warning about a contrast sampled during the theme cross-fade.
 *
 * `ts.createSourceFile` has none of those failure modes: comments are not
 * nodes, a regex literal is one node and holds no strings, and a template's
 * `${…}` expressions are not part of its text — so `${err.message}` is never
 * read as prose. `typescript` is already a devDependency (`tsc --noEmit` is
 * `npm run typecheck`), so this adds nothing to the tree.
 *
 * ============================================================================
 * THE DETECTOR, AND WHAT IT CANNOT SEE
 *
 * Four signals. Three are always French and apply to every literal: an
 * accented letter, a guillemet (`«` `»` — this product's English strings use
 * `“` `”`, and every French one here used guillemets), and an elision
 * (`l'alerte`, `d'audit`, `n'est`; English `don't` and `it's` do not match,
 * because the apostrophe there is not preceded by a word boundary).
 *
 * The fourth is a closed list of French tokens that are not English words, and
 * it is applied only to PROSE — a literal with a space in it, or one carrying
 * punctuation — with identifier-shaped runs removed first. That gate is what
 * keeps protocol identifiers out of it: `alerte`, `sain` and `a_verifier` are
 * VulnPipe's confidence zones, `attente` is a node id and `n8n_soc` is the
 * application role. Renaming any of them is a protocol change, not a
 * translation.
 *
 * Measured over the corpus: 43 literals flagged, every one genuinely French,
 * zero false positives. Getting there cost three prunings — `execution`,
 * `secret`, `base`, `refuse`, `cycle`, `source`, `phrase`, `segment` and
 * `impossible` all look French and are English, and each of them flagged real
 * English sentences this product ships. They are claimed below so the list
 * cannot grow back into them.
 *
 * WHAT IT CANNOT SEE, stated because it is the interesting half: a French
 * sentence built only of words that look English. There was one —
 * `insertion en base impossible` — and the ONLY token in it the detector could
 * use was `en`. A sentence one word away from that is invisible here, and no
 * list of words fixes that. This file is a floor, not a ceiling.
 *
 * NOT IN SCOPE, and all three are named rather than quietly left out. TEST
 * FILES: excluded by the walk, because this repository's test names and
 * fixtures are written in French throughout and they have no operator on the
 * other end — the cost is that a French string planted in a fixture is not
 * caught, which is why the three tests that were asserting ON the French had to
 * be found by running the suite rather than by this sweep. COMMENTS:
 * `server/engine/` is commented in French throughout, and translating that is a
 * mass reformatting of files this change does not otherwise touch. The claim
 * here is about what this console can WRITE, which is the half with an operator
 * on the other end. AND `VulnPipe/src`: a separate package with its own vitest
 * root, so this file cannot reach it — measured with the same detector at **180
 * flagged literals in 57 files**, the largest block being the analysis engine's
 * own model prompts in `master/claude-client.ts`. Translating a prompt changes
 * what a model is shown, which cannot be checked from an environment with no
 * key; it is a product decision, not a translation. Both are in ROADMAP § 7.
 * ============================================================================
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** `dashboard/`, one level up from this file. */
const ROOT = resolve(import.meta.dirname, '..');

/* ==========================================================================
 * THE DETECTOR
 * ========================================================================== */

const ACCENTS =
  /[À-ÆÈ-ÏÒ-ÖÙ-Üà-æè-ïò-öù-üÿŒœ]/;
const GUILLEMETS = /[«»]/;
const ELISION = /\b[cdjlmnst]'[a-zà-ÿ]/i;

/**
 * French tokens that are not English words.
 *
 * Closed by the LANGUAGE, not by this codebase: it is a list of function words
 * and of the handful of verbs and nouns the engine's own failure vocabulary
 * used. That is why it is a list at all — the alternative is an English
 * dictionary, which is a dependency.
 */
const FRENCH_WORDS = new RegExp(
  '\\b(' + [
    'aucun', 'aucune', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'est', 'sont',
    'pas', 'qui', 'que', 'sur', 'dans', 'avec', 'sans', 'sous', 'pour', 'ne', 'ses',
    'son', 'ici', 'tout', 'toute', 'tous', 'depuis', 'doit', 'avoir', 'etre', 'fait',
    'faire', 'peut', 'et', 'ou', 'donc', 'mais', 'aux', 'en', 'jamais', 'deja',
    'encore', 'comme', 'quand', 'chaque', 'entre', 'meme', 'trop', 'tres',
    'inconnu', 'inconnue', 'manquant', 'manquante', 'invalide', 'attendu', 'attendue',
    'vide', 'exige', 'affirmer', 'changerait', 'comportement', 'processus', 'contexte',
    'fournit', 'gestionnaire', 'ligne', 'lignes', 'inexploitable', 'nombre', 'valeur',
    'valeurs', 'droite', 'gauche', 'chemin', 'sortie', 'repli', 'modele', 'glissants',
    'jours', 'raison', 'disponible', 'indisponible', 'repond', 'demarrer', 'dossier',
    'lancer', 'injoignable', 'nouvelle', 'alerte',
  ].join('|') + ')\\b',
  'i',
);

/**
 * Anything shaped like an identifier, a path, a URL or a dotted field name.
 *
 * Removed before the word rule so that `soc-pill-phrase`, `webhook.secret` and
 * `repository.service` cannot be read as prose.
 */
const IDENTIFIER_RUN = /[A-Za-z0-9À-ſ]*[-_./:@\\][A-Za-z0-9À-ſ_./:@\\-]*/g;

/** Why this text reads as French, or an empty list. */
function frenchReasons(text: string): string[] {
  const out: string[] = [];
  const a = ACCENTS.exec(text);
  if (a) out.push(`accented letter ${JSON.stringify(a[0])}`);
  const g = GUILLEMETS.exec(text);
  if (g) out.push(`guillemet ${JSON.stringify(g[0])}`);
  const e = ELISION.exec(text);
  if (e) out.push(`elision ${JSON.stringify(e[0])}`);
  // The word rule needs prose. A bare single token is an identifier until it
  // carries a space or punctuation — which is what lets `(aucune)` be read and
  // `a_verifier` be left alone.
  const trimmed = text.trim();
  if (/\s/.test(trimmed) || /[^A-Za-z0-9_$.\-/:@]/.test(trimmed)) {
    const w = FRENCH_WORDS.exec(trimmed.replace(IDENTIFIER_RUN, ' '));
    if (w) out.push(`French word ${JSON.stringify(w[0])}`);
  }
  return out;
}

/* ==========================================================================
 * THE WALK
 * ========================================================================== */

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every string, template part and JSX text node a file holds. */
function literalsOf(fileName: string, source: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    } else if (ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return out;
}

function sweep(): { files: number; literals: number; flagged: string[] } {
  const files = [...sources(join(ROOT, 'server')), ...sources(join(ROOT, 'src'))];
  const flagged: string[] = [];
  let literals = 0;
  for (const file of files) {
    for (const text of literalsOf(file, readFileSync(file, 'utf8'))) {
      if (text.trim() === '') continue;
      literals += 1;
      const why = frenchReasons(text);
      if (why.length > 0) {
        flagged.push(
          `${file.slice(ROOT.length + 1)} — ${why.join(', ')}: ${JSON.stringify(text.slice(0, 120))}`,
        );
      }
    }
  }
  return { files: files.length, literals, flagged };
}

/* ==========================================================================
 * THE CLAIM
 * ========================================================================== */

describe('every string this console can write is English', () => {
  const result = sweep();

  it('finds no French literal under server/ or src/', () => {
    expect(result.flagged).toEqual([]);
  });

  it('read a corpus large enough for that to mean something', () => {
    // A sweep whose walk returns nothing agrees with every codebase. Measured
    // on 2026-11-26: 139 files, 11,685 non-blank literals. The floors sit under
    // those rather than at them, because a file legitimately comes and goes.
    expect(result.files).toBeGreaterThanOrEqual(130);
    expect(result.literals).toBeGreaterThanOrEqual(10_000);
  });
});

describe('the detector, claimed in both directions', () => {
  // Without this half the word list could be widened until it flagged the
  // whole product, and the claim above would still be green.
  //
  // One test per SIGNAL, each on a string that signal alone catches, so a
  // mutation deleting any one of the four is red and says which. That matters
  // because the four overlap heavily on the strings this change removed —
  // *two guards where one suffices is a line no test can fail on*, and the
  // only way to know which guard is load-bearing is to claim it alone.

  it('catches an accented letter, and nothing else in that sentence is a signal', () => {
    expect(frenchReasons('[menater] section non charg\u00e9e \u2014'))
      .toEqual(['accented letter "\u00e9"']);
  });

  it('catches a guillemet — the quote this product does not use in English', () => {
    // Every English message in the engine quotes with `\u201c \u201d`; every French
    // one used `\u00ab \u00bb`. Nothing else here is a signal: `Variable` is English and
    // the identifier is removed before the word rule runs.
    expect(frenchReasons('Variable \u00ab shadow.exitThreshold \u00bb'))
      .toEqual(['guillemet "\u00ab"']);
  });

  it('catches an elision, which is often the only signal a sentence has', () => {
    // `journal`, `audit` and `absent` are all English words. The apostrophe is
    // the whole of it — and English `don't` / `it's` do not match, because
    // there the apostrophe is not preceded by a word boundary.
    expect(frenchReasons("Journal d'audit absent")).toEqual(['elision "d\'a"']);
    expect(frenchReasons("it doesn't matter, and it's fine")).toEqual([]);
  });

  it('catches French with its accents STRIPPED, which is the form the relay used', () => {
    // `server/vulnpipe.ts` wrote its two sentences without accents, so an
    // accent-only detector — the obvious one — would have passed over the
    // sentence a fresh install reads first on the Code tab.
    expect(frenchReasons('ou `npm run dev` depuis la console pour lancer les deux.'))
      .toEqual(['French word "ou"']);
  });

  it('catches a sentence that is half English, which is how three of these survived', () => {
    expect(frenchReasons(
      'Deduplication returned no row. With no answer we cannot affirmer que l\'alerte est nouvelle.',
    )).not.toEqual([]);
    expect(frenchReasons('\u00bb : un switch DOIT avoir une sortie de repli. Sans ')).not.toEqual([]);
  });

  it('does not flag the English sentences this product really ships', () => {
    // Every one of these was flagged by a wider version of the word list, on a
    // word that looks French and is English. They are the boundary, and they
    // are why `execution`, `secret`, `base`, `refuse`, `cycle`, `source`,
    // `phrase`, `segment` and `impossible` are not on it.
    const english = [
      'Only the current execution window was searched. No match here does not mean no match ever.',
      'No shared secret: the entry point stays CLOSED rather than open to anyone.',
      'Going live stays a human call: base it on the disagreement rate below, not on volume alone.',
      'Approve or refuse',
      'User Execution',
      'Exploit Public-Facing Application',
      'the database refused the connection — nothing is listening at that address',
      'A rule with no condition matches every alert. Name what makes this activity expected.',
      'Verdict forced by the pipeline: the model is unreachable or erroring.',
      'isolate_host_temporary refused (no host to isolate: neither dest_ip nor host) \u2192 escalate',
      'Cycle in \u201c01-ingestion\u201d: in \u2192 guard',
      'Path \u201craw_log.0\u201d: empty segment.',
    ];
    for (const text of english) expect(frenchReasons(text), text).toEqual([]);
  });

  it('leaves the French PROTOCOL identifiers alone', () => {
    // These are values in a data contract, not prose. `alerte`, `sain` and
    // `a_verifier` are VulnPipe's three confidence zones, `attente` is the node
    // 04-Action-Routing suspends on, `n8n_soc` is the application role this
    // stack creates. Flagging them would ask for a protocol change under cover
    // of a translation — which is also why the word rule needs prose: drop that
    // gate and this test is the one that goes red.
    for (const id of ['alerte', 'sain', 'a_verifier', 'attente', 'n8n_soc', 'vp-zone-alert']) {
      expect(frenchReasons(id), id).toEqual([]);
    }
  });
});

describe('the instrument', () => {
  // The claims that stop the ruler reading the reassuring answer. Both of these
  // were real failures of the first version of it.

  it('does not read a comment as a string', () => {
    const src = [
      "// un commentaire en français qui n'est pas une chaîne",
      '/* et un bloc avec des accents : déjà, où, ça */',
      "const ok = 'an English string';",
    ].join('\n');
    expect(literalsOf('x.ts', src)).toEqual(['an English string']);
  });

  it('is not derailed by a regular expression holding a quote', () => {
    // The measured failure: a hand-rolled stripper took the `'` inside this
    // regex as the start of a literal and ran past the end of the statement,
    // which both invented literals and hid real ones.
    const src = "const slug = (s) => s.replace(/[^a-zA-Z0-9']+/g, '-');\nconst note = 'still read';";
    expect(literalsOf('x.ts', src)).toEqual(['-', 'still read']);
  });

  it('does not read a template\'s interpolated expression as prose', () => {
    // `${err.message}` is code. Reading it as text would make the detector
    // answer about identifiers rather than about sentences.
    const src = 'const m = `head ${une.valeur} tail`;';
    expect(literalsOf('x.ts', src)).toEqual(['head ', ' tail']);
  });
});
