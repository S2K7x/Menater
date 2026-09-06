/**
 * Tuning rules: what a team declares normal.
 *
 * Moved out of the single request function unchanged; see `routes/context.ts`
 * for why the ORDER these groups are tried in is part of the behaviour.
 */

import { json, readBody } from '../respond.ts';
import {
  getRuleStore, ruleDb } from '../runtime.ts';
import { evaluateRules, normalizeRuleInput, validateRule } from '../engine/transforms/tuning.ts';
import { RULE_TEMPLATES, ruleFromTemplate } from '../engine/transforms/tuning-templates.ts';
import type { Ctx } from './context.ts';

export async function rulesRoutes(c: Ctx): Promise<boolean> {
  const { req, res, path, am } = c;

    // --- Tuning rules -------------------------------------------------------
    if (path === '/api/rules/templates' && req.method === 'GET') {
      return json(res, 200, {
        templates: RULE_TEMPLATES,
        // The draft each template produces, so the UI never has to know how
        // an expiry is computed from a number of days.
        drafts: RULE_TEMPLATES.map((t) => ({ id: t.id, draft: ruleFromTemplate(t) })) });
    }

    /**
     * Dry run: WHICH rule would match this alert, and why.
     *
     * The question an operator actually has is never "is my regex valid", it
     * is "why was this alert closed" or "why was this one not". Answering it
     * without touching the pipeline is the difference between tuning and
     * guessing.
     */
    if (path === '/api/rules/test' && req.method === 'POST') {
      const store = getRuleStore();
      if (!store) return json(res, 503, { error: am.rulesNoDatabase });
      const body = await readBody(req);
      const alert = body?.alert ?? {};
      // Rules passed in the body are tried INSTEAD of the stored set: that is
      // what lets someone test a rule they have not saved yet.
      // Caller-supplied rules go through the same shaping: a dry run on a
      // malformed draft should answer "no match", not crash.
      const rules = Array.isArray(body?.rules)
        ? body.rules.map((r: unknown, i: number) => ({
          id: String((r as { id?: unknown })?.id ?? `draft-${i}`),
          created_at: '', updated_at: '',
          ...normalizeRuleInput(r).rule,
          // AFTER the spread, deliberately. A draft is being TESTED: refusing
          // to evaluate it because it is not enabled yet would answer "no
          // match" to the one question the dry run exists to answer.
          enabled: true }))
        : await store.list();
      const outcome = evaluateRules(alert, rules);
      return json(res, 200, {
        matched: outcome.rule ? { id: outcome.rule.id, name: outcome.rule.name } : null,
        action: outcome.action,
        severity: outcome.severity,
        note: outcome.note,
        expired: outcome.expired,
        // Per-rule, so the UI can show which condition failed rather than a
        // bare "no match".
        evaluated: rules.map((r: any) => ({
          id: r.id, name: r.name, enabled: r.enabled,
          matched: evaluateRules(alert, [r]).rule !== null })) });
    }

    if (path === '/api/rules' && req.method === 'GET') {
      const store = getRuleStore();
      if (!store) return json(res, 503, { error: am.rulesNoDatabase });
      return json(res, 200, { rules: await ruleDb(() => store.list()) });
    }

    if (path === '/api/rules' && req.method === 'POST') {
      const store = getRuleStore();
      if (!store) return json(res, 503, { error: am.rulesNoDatabase });
      const body = await readBody(req);
      // SHAPE FIRST, then meaning. Without this a `conditions: "nope"` reached
      // `conditions.entries()` and a `priority: "high"` reached Postgres —
      // both answered 500 with an internal message, telling the caller that
      // something broke but never that THEY had sent something wrong.
      const { rule: shaped, problems: shapeProblems } = normalizeRuleInput(body);
      const problems = [...shapeProblems, ...validateRule(shaped)];
      // REFUSED WITH THE REASONS, not with "invalid". Each problem names the
      // field and says what goes wrong if it stands.
      if (problems.length > 0) return json(res, 400, { problems });
      const now = new Date().toISOString();
      const created = await ruleDb(() => store.create(
        { ...shaped, created_at: now, updated_at: now },
        shaped.owner || 'console',
      ));
      return json(res, 201, { rule: created });
    }

    const ruleMatch = /^\/api\/rules\/([0-9a-fA-F-]{36})$/.exec(path);
    if (ruleMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const store = getRuleStore();
      if (!store) return json(res, 503, { error: am.rulesNoDatabase });
      const id = ruleMatch[1]!;

      if (req.method === 'DELETE') {
        const gone = await ruleDb(() => store.remove(id, 'console'));
        return gone ? json(res, 200, { ok: true }) : json(res, 404, { error: am.ruleNotFound(id) });
      }

      const body = await readBody(req);
      const { rule: shaped, problems: shapeProblems } = normalizeRuleInput(body);
      const problems = [...shapeProblems, ...validateRule(shaped)];
      if (problems.length > 0) return json(res, 400, { problems });
      const updated = await ruleDb(() => store.update(id, shaped, shaped.owner || 'console'));
      return updated ? json(res, 200, { rule: updated }) : json(res, 404, { error: am.ruleNotFound(id) });
    }



  return false;
}
