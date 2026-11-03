/**
 * The dry-run door, which takes BOTH the rules and the alert from the body.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `POST /api/rules/test` is the sharpest of the four doors onto a caller-
 * supplied regular expression. It is not behind the console lock on an install
 * with no password — `requiresAuth` returns `false` for every path while
 * `auth.enabled` is `false`, which is the shipped default — it needs no stored
 * rule, and it uses the rules in the body INSTEAD of the stored set, through
 * `normalizeRuleInput` and deliberately not `validateRule`. So one request of
 * about 150 bytes carries the pattern and the text to run it against.
 *
 * Before `bounded-regex.ts` that request did not return. Not slowly: a nested
 * quantifier over a 2000-character subject is years, and a regex cannot be
 * interrupted, so the console, the engine, the scheduler and both ingestion
 * doors were gone for the life of the process, with nothing logged because
 * nothing threw.
 *
 * The assertions are therefore about the PROCESS rather than about a number:
 * the request answers, it says which rule it could not decide, and the next
 * request still works. The clock is read only with three orders of magnitude
 * of margin, and the blow-up is real exponential backtracking rather than a
 * slow machine borrowed for the occasion.
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'menater-rules-dry-run-'));
process.env.MENATER_CONFIG = join(SCRATCH, 'config.json');

// Imported AFTER the variable above: `CONFIG_PATH` is a module constant.
const { handleRequest } = await import('./app.ts');
const { saveConfig, getConfig } = await import('./config.ts');
const { REQUEST_BUDGET_MS } = await import('./engine/transforms/bounded-regex.ts');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

beforeAll(() => {
  /**
   * Configured and unreachable, the way `rules-refusal.test.ts` does it. The
   * dry run needs `getRuleStore()` to be non-null — it answers whether a
   * database is CONFIGURED, not whether it answers — and rules supplied in the
   * body never reach it, so no socket is opened. Port 1 is privileged:
   * nothing can be listening.
   */
  saveConfig({ database: { host: '127.0.0.1', port: 1, database: 'menater', user: 'menater' } });
});

interface Answer { status: number; body: string; ms: number }

/** Drives the real handler with no session and no credential of any kind. */
async function post(url: string, payload: unknown): Promise<Answer> {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const captured = { status: 0, body: '' };
  const req: any = {
    method: 'POST',
    url,
    headers: { host: 'localhost:4400' },
    socket: { remoteAddress: '203.0.113.7' },
    async *[Symbol.asyncIterator]() { yield raw; },
  };
  const res: any = {
    req,
    headersSent: false,
    writeHead(status: number) { captured.status = status; res.headersSent = true; },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    setHeader() {},
  };
  const started = Date.now();
  await handleRequest(req, res);
  return { ...captured, ms: Date.now() - started };
}

/** A rule as the dry run accepts one: no id, no owner, nothing stored. */
const draft = (name: string, pattern: string) => ({
  name,
  conditions: [{ field: 'raw_log', op: 'regex', values: [pattern] }],
  action: 'allow',
});

/** Six characters that do not terminate, against the subject cap. */
const EXPONENTIAL = '(a+)+$';
const SUBJECT = `${'a'.repeat(1999)}!`;

describe('a pattern an anonymous caller supplies', () => {
  it('is not behind the lock on the shipped default, which is why this matters', () => {
    // Stated as a test rather than as a comment: the door's exposure is half
    // the finding, and a future default that turns the lock on would make the
    // sentence above stale in silence.
    expect(getConfig().auth.enabled).toBe(false);
  });

  it('answers, instead of taking the process with it', async () => {
    const r = await post('/api/rules/test', {
      alert: { alert_id: 'A-1', raw_log: SUBJECT },
      rules: [draft('Anonymous draft', EXPONENTIAL)],
    });

    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    // It decided NOTHING, and it says so: a rule nobody can run must not be
    // reported as a rule that did not match.
    expect(body.matched).toBeNull();
    expect(body.abandoned).toEqual(['Anonymous draft']);
    expect(r.ms).toBeLessThan(5000);
  });

  it('cannot buy more than the request budget by sending more rules', async () => {
    /**
     * The per-rule bound alone would be multiplied by whatever the 256 kB body
     * holds — measured at 4,975 regex conditions across 199 rules. The route
     * therefore makes ONE budget and hands it to the full pass and to every
     * per-rule pass behind `evaluated`.
     */
    const rules = Array.from({ length: 40 }, (_, i) => draft(`draft ${i}`, EXPONENTIAL));
    const r = await post('/api/rules/test', {
      alert: { alert_id: 'A-2', raw_log: SUBJECT },
      rules,
    });

    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    // Every one of them named: a budget an earlier rule spent must not make a
    // later rule look like a rule that did not match.
    expect(body.abandoned).toHaveLength(40);
    expect(body.evaluated.every((e: { matched: boolean }) => e.matched === false)).toBe(true);
    // Forty rules do not cost forty slices. The margin is wide on purpose —
    // this asserts the SHAPE of the bound, not a speed.
    expect(r.ms).toBeLessThan(REQUEST_BUDGET_MS * 8);
  });

  it('leaves the console answering afterwards', async () => {
    // The whole point. Before the fix there was no "afterwards".
    const r = await post('/api/rules/test', {
      alert: { alert_id: 'A-3', raw_log: 'Failed password for root' },
      rules: [draft('Ordinary draft', 'failed password')],
    });

    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.matched?.name).toBe('Ordinary draft');
    expect(body.abandoned).toEqual([]);
  });
});
