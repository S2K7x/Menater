/**
 * The quote must price the prompt the scan SENDS.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 *
 * `estimateScan` replays the real pipeline up to the exact point where it
 * would become billable and measures the prompt it would have sent — that is
 * the whole argument for trusting the number, and `estimator.ts`'s own header
 * makes it: *« le volume de jetons est mesuré sur le prompt réellement
 * construit »*.
 *
 * It was measured on a FRAGMENT. `IDOR_SYSTEM_PROMPT` is the two-line role
 * (128 characters); what `nodes/idor/node.ts` hands the model as its system
 * turn is `idorSystemPrompt(...)` — 3,318 characters, i.e. the directives, the
 * calibration grid, the coupling rule, the output format and the fencing
 * contract. So every billed call was quoted ~798 tokens short, on the one
 * number somebody reads BEFORE paying, and short is the direction this product
 * refuses: `CLAUDE.md`'s row on `estimateScan` is about an estimate that talks
 * people out of an affordable scan, and an estimate that flatters fails the
 * same test from the other side — it is not the price.
 *
 * HOW THE PRICED PROMPT IS READ BACK, WITHOUT MIRRORING THE ARITHMETIC
 *
 * `ScanEstimate` publishes `tokens.input` for the whole scan, not a per-call
 * figure, and that total also carries the arbitration margin — a declared
 * approximation (one call per pending finding at 1.3x the measured route
 * prompt). Asserting the total against a formula would make this file a copy
 * of the estimator's arithmetic: it would then fail when the margin is
 * retuned, which is not what it is about, and it would still not be exact.
 *
 * So the per-call figure is obtained by DIFFERENCE. Quote the same route once,
 * then twice: the arbitration term is identical in both (`max(round(n * 0.15),
 * 1)` is 1 for n = 1 and n = 2) and the measured prompt is identical too (it
 * is the same route), so the two totals differ by exactly one detection call.
 * That difference is compared against the prompt the node would really build.
 * No constant of the estimator's appears here, and the claim is an equality
 * rather than a bound — which is what kills pricing the fragment, pricing the
 * system turn twice, and pricing either half alone.
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

import { estimateScan, prepareTarget, CHARS_PER_TOKEN } from './estimator.ts';
import { resolveTarget } from './scan-target.ts';
import { buildIdorPrompt, idorSystemPrompt, IDOR_SYSTEM_PROMPT } from '../nodes/idor/prompt.ts';
import { DEFAULT_INITIAL_DEPTH } from '../nodes/idor/node.ts';
import { scanForIdor } from '../nodes/idor/scanner.ts';
import { newFence } from '../shared/untrusted.ts';
import { DEFAULT_LOCALE } from '../i18n/locale.ts';
import type { ListedRoute } from '../nodes/shared/mcp-client.ts';

const FIXTURE = new URL('../nodes/idor/__fixtures__/repo', import.meta.url).pathname;

describe('the quote prices the prompt the scan sends', () => {
  it('counts the system turn and the user message, as the node sends them', async () => {
    const target = await resolveTarget(FIXTURE);
    const ready = await prepareTarget(target);
    try {
      // One route the deterministic scanner does NOT settle: a settled route
      // is never asked, so it would price nothing and the claim would be true
      // of nothing.
      let billed: ListedRoute | undefined;
      let realChars = 0;
      for (const route of ready.routes) {
        const bundle = await ready.provider.getContext(
          { route: route.route, httpMethod: route.http_method },
          DEFAULT_INITIAL_DEPTH
        );
        if (scanForIdor(bundle).decisive_score !== null) continue;
        billed = route;
        // Both halves, built by the real builders. `newFence()` mints a fresh
        // nonce per call and its LENGTH is constant — `randomBytes(9)` in
        // base64url is 12 characters, no padding — so this count does not
        // move between draws. Measured on the four fixture routes, ten draws
        // each: four distinct lengths, one per route.
        realChars =
          idorSystemPrompt({ locale: DEFAULT_LOCALE }).length +
          buildIdorPrompt(bundle, newFence()).length;
        break;
      }
      expect(billed).toBeDefined();
      expect(realChars).toBeGreaterThan(0);

      const quote = async (routes: ListedRoute[]) =>
        await estimateScan({
          target,
          mode: 'full_scan',
          routes,
          index: ready.index,
          provider: ready.provider,
          detection: { provider: 'gemini', model: 'gemini-3.5-flash' },
          arbitration: { provider: 'anthropic', model: 'claude-opus-5' },
          env: {},
        });

      const one = await quote([billed!]);
      const two = await quote([billed!, billed!]);

      // The premise of the difference, asserted rather than assumed: one
      // detection call apart, the same arbitration term, nothing else moving.
      expect(one.llm_calls.detection).toBe(1);
      expect(two.llm_calls.detection).toBe(2);
      expect(two.llm_calls.arbitration.high).toBe(one.llm_calls.arbitration.high);

      const pricedPerCall = two.tokens.input - one.tokens.input;
      expect(pricedPerCall).toBe(Math.round(realChars / CHARS_PER_TOKEN));
    } finally {
      await ready.close();
      await target.cleanup();
    }
  });
});

describe('the role line is a fragment, not a price', () => {
  it('is reached for nowhere outside the detector that owns it', async () => {
    // Written as a SUBTRACTION over the whole engine rather than as a check on
    // one line: what must hold is that nothing prices, logs or measures a
    // prompt from a PIECE of one. A list of the files that exist tonight goes
    // stale the day a second detector is wired, which is how this one lasted.
    const root = new URL('..', import.meta.url).pathname;
    const offenders: string[] = [];
    let read = 0;

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const relative = full.slice(root.length);
        // The detector owns the constant: `idorSystemPrompt` opens with it.
        if (relative.startsWith('nodes/idor/')) continue;
        read += 1;
        // Comments are stripped: this file's own prose names the constant, and
        // a sweep satisfied by an explanation is the defect it exists to
        // refuse — the `n8n-removed.test.ts` lesson.
        const code = (await readFile(full, 'utf8'))
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (code.includes('IDOR_SYSTEM_PROMPT')) offenders.push(relative);
      }
    };

    await walk(root.replace(/\/$/, ''));

    // A floor on the corpus: a walk that read nothing agrees with everything.
    expect(read).toBeGreaterThanOrEqual(30);
    expect(offenders).toEqual([]);
  });

  it('is what the system turn OPENS with, so the fragment is not dead', () => {
    // The other direction. `idorSystemPrompt` is the thing to price, and the
    // role line is its first characters — so a rule forbidding the fragment
    // elsewhere must not be read as forbidding it where it belongs.
    const system = idorSystemPrompt({ locale: DEFAULT_LOCALE });
    expect(system.startsWith(IDOR_SYSTEM_PROMPT)).toBe(true);
    expect(system.length).toBeGreaterThan(IDOR_SYSTEM_PROMPT.length * 10);
  });
});
