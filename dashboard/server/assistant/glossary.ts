/**
 * The product's own vocabulary, server-side.
 *
 * ============================================================================
 * WHY THIS IS NOT IN THE GUIDE'S CATALOGUE
 *
 * The Guide lives in `src/i18n/console.ts`, which is browser code: the server
 * cannot read it, and an MCP client is not a browser. Without this file, an
 * external agent asked "what does shadow mode mean here?" answers from its
 * training — which is to say, about shadow mode in general, confidently, and
 * possibly about a different product's version of it.
 *
 * The console already refuses to show a raw pipeline identifier on screen
 * (`shadow_logged`, `needs_human`, `isolate_host_temporary` all go through a
 * catalogue). This is the same refusal applied to the export: an identifier
 * that leaves the building should leave with its meaning attached.
 *
 * It is deliberately SHORT. Everything here is a term whose ordinary English
 * meaning is misleading in this product — that is the entry test. "Alert" is
 * not in it; "human disagreement rate" is, because a reader who guesses is
 * wrong in a way that changes a decision.
 * ============================================================================
 */

export interface GlossaryEntry {
  term: string;
  /** What it means HERE. Not a dictionary definition. */
  meaning: string;
  /** The wrong reading it exists to prevent. Absent when there is no trap. */
  trap?: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'shadow_mode',
    meaning:
      'The pipeline decides and records, but executes nothing. It is the default and the fail-safe: '
      + 'missing configuration cannot enable execution.',
    trap:
      'An alert that ends "closed" with no action taken is the system working, not failing. In '
      + 'shadow mode every successfully handled alert ends closed.',
  },
  {
    term: 'needs_human',
    meaning: 'The triage verdict meaning the model would not decide: it goes to a person.',
    trap:
      'It is also the FAIL-SAFE verdict. With no model key every alert takes it with confidence 0, '
      + 'so a queue that is entirely needs_human usually means a missing key, not a wave of hard cases.',
  },
  {
    term: 'human_disagreement_rate',
    meaning:
      'The share of decisions put to a human that they REJECTED. It is the only false-positive '
      + 'proxy observable without ground truth, and it is what gates leaving shadow mode.',
    trap: 'Do not confuse it with the verdict distribution below.',
  },
  {
    term: 'ai_false_positive_verdict_rate',
    meaning: 'The share of alerts the model CLASSED as false positives.',
    trap:
      'A measure of distribution, not of correctness. It says what the model decided, never whether '
      + 'it was right. Presenting it as an accuracy figure is the single most common misreading here.',
  },
  {
    term: 'isolate_host_temporary',
    meaning:
      'The only containment action in the catalogue: a network quarantine with a TTL and an '
      + 'automatic revert. The machine stays powered on and reachable from the console.',
    trap:
      'It REFUSES to run when the alert names no host. An action whose target is unknown is not an '
      + 'action, so it is not attempted rather than aimed at a guess.',
  },
  {
    term: 'broken chain',
    meaning:
      'A handoff node ran and passed ZERO items to the next workflow. The chain stops mid-way with '
      + 'nothing failing.',
    trap:
      'It shows as SUCCESS everywhere. That is why the Tracking tab exists: the queue stitches runs '
      + 'by alert_id, and that reduction hides exactly this.',
  },
  {
    term: 'empty_input',
    meaning: 'A sub-workflow trigger ran without receiving anything.',
    trap:
      'The signature of an Execute Sub-workflow set to "once" instead of "each": it finishes in '
      + 'success having executed nothing.',
  },
  {
    term: 'stalled',
    meaning: 'No new step for five minutes, OUTSIDE an approval wait.',
    trap: 'The thirty approval minutes are never counted as stalling. Waiting on a human is not a failure.',
  },
  {
    term: 'guardrails',
    meaning:
      'Deterministic caps applied to the model’s answer after it returns: confidence ceilings on '
      + 'incomplete intelligence, action downgrades, forced human review.',
    trap:
      'They are the part of a decision that is reproducible. Comparing two engines compares these, '
      + 'never the model’s own numbers — a model is not deterministic.',
  },
  {
    term: 'tuning rule',
    meaning:
      'What a team declares normal here. A rule can only close an alert as known-good, soften or '
      + 'raise its severity, or force it to a human.',
    trap:
      'No rule can cause an action. A text field an operator types into is the last place from which '
      + 'a machine should be cut off the network.',
  },
  {
    term: 'observables',
    meaning:
      'The optional half of the alert contract: source_ip, dest_ip, user, host, process, file_path, '
      + 'url. Absent stays absent — null, never an empty string, never invented.',
    trap:
      'Most real detections carry no destination address. A null means NOT OBSERVED, not "zero" and '
      + 'not "none".',
  },
  {
    term: 'audit chain',
    meaning:
      'Every decision is written to soc_audit_log with a hash of the previous row, so the log cannot '
      + 'be edited without breaking the chain.',
  },
];

const BY_TERM = new Map(GLOSSARY.map((e) => [e.term.toLowerCase(), e]));

/**
 * Looks a term up, tolerantly.
 *
 * Exact match first, then a substring both ways: an operator asks about
 * "disagreement", a model asks about "human_disagreement_rate_pct", and both
 * mean the same entry. Returning the closest match beats returning nothing and
 * letting the caller answer from memory.
 */
export function lookupTerm(raw: string): { entry: GlossaryEntry | null; suggestions: string[] } {
  const needle = raw.trim().toLowerCase().replace(/\s+/g, '_');
  const exact = BY_TERM.get(needle);
  if (exact) return { entry: exact, suggestions: [] };

  const near = GLOSSARY.filter(
    (e) => e.term.toLowerCase().includes(needle) || needle.includes(e.term.toLowerCase()),
  );
  if (near.length === 1) return { entry: near[0], suggestions: [] };
  return { entry: null, suggestions: near.length > 0 ? near.map((e) => e.term) : GLOSSARY.map((e) => e.term) };
}
