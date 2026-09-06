# VulnPipe — Project context (CLAUDE.md)

> This file is the project's source of truth. It must stay at the repository root.
> Every Claude Code session should read it before starting to code.
>
> **Write everything in English** — code, comments, documentation, user-facing
> strings. See the root [CLAUDE.md](../CLAUDE.md).

## 1. Product mission

VulnPipe is an automated security pipeline, built for **"vibe coders"** —
developers shipping code generated or co-written with AI, without necessarily
having a security background. The goal: give them an automatic security scan
that is understandable and financially affordable, on every commit.

Two non-negotiable promises:
1. **Low-cost**: most of the work happens on free/open-source local LLMs. The
   paid API (Claude) only steps in for ambiguous or critical cases.
2. **Understandable**: the user must never read raw JSON or a technical log.
   Every stage of the pipeline must be translated into human language, with an
   explanation of the *why* behind each alert.

> **Since the merge, VulnPipe is a feature of the MENATER console, not a
> standalone product.** The engine still runs as its own service on port 4319;
> the interface lives in the console's **Code** tab. See the root README.

## 2. General architecture (do not deviate without discussion)

```
[ Git webhook ]
       │
       ▼
[ INDEXER node ]  (Tree-sitter: AST, routes, symbol table, local call graph)
       │  publishes a "repo indexed" event
       ▼
[ MCP server ]  (exposes the index through tools: get_context(route, depth))
       │
       ├──► [ IDOR node ]        ┐
       ├──► [ XSS node ]         │  in parallel, each one:
       ├──► [ SQLi node ]        │  deterministic scanner (pattern/Semgrep)
       ├──► [ Sec.Config node ]  │  + local LLM (verdict + confidence_score)
       └──► [ ... node ]         ┘
       │  each node returns structured JSON with a confidence_score
       ▼
[ AGGREGATOR node ]  (deterministic, no LLM)
   - deduplicates findings
   - severity scoring (public route vs /admin/*)
   - filter: score < 0.4 = rejected, 0.4-0.7 = grey zone → Claude,
     > 0.7 = validated directly (Claude bypass optional)
       │  sends only 10-15% of the volume to Claude
       ▼
[ Master CLAUDE ]  (arbitration, writing the final report)
       │
       ▼
[ UI / Report ]  (human language, no raw JSON visible)
```

## 3. Architecture decisions already settled (do not reopen without a strong reason)

- **Tree-sitter, not the TypeScript compiler.** We accept imperfect (heuristic)
  link resolution in order to stay language-agnostic (JS/TS today, Python/Go
  later on the same engine). An ambiguous class (two `findById` methods in two
  different services) is tagged `reason: "ambiguous_logic"` and left for the LLM
  to settle — that is not a bug, it is an accepted choice.
- **Symbol table indexed by `(injected_type_class, method)`**, not by method
  name alone, to reduce collisions without reimplementing a TypeChecker.
- **MCP protocol** between the Indexer and the detection nodes (no ad-hoc REST
  call, no peer-to-peer A2A). The Indexer is the MCP server, each node an MCP
  client.
- **Three-zone confidence score**, not a plain boolean:
  - `0.0–0.3` → clean, the pipeline stops, nothing sent to Claude
  - `0.4–0.7` → grey zone, sent to Claude for arbitration
  - `0.8–1.0` → near-certain vulnerability, direct alert (Claude bypass optional)
- **Two distinct modes, different pricing**:
  - `full_scan` (first scan, no diff possible) → chunking by complete route via
    the AST, batch processing, heavier, billed differently
  - `incremental_scan` (normal commit) → triage by `git diff`, re-analysing only
    the changed routes/functions; this is the day-to-day low-cost mode
- **Every local node verdict separates two kinds of doubt** in its JSON:
  `reason: "missing_context"` (code is missing, e.g. an unresolved guard) versus
  `reason: "ambiguous_logic"` (the context is complete but the business
  judgement is hard). The first can trigger a deeper MCP request before going to
  Claude; the second goes straight to Claude.

## 4. Cross-cutting requirement: explainability (NON-negotiable)

**Every component producing output destined for the user must produce, in
addition to the technical JSON, a `plain_language_summary` field.**

Expected shape of a node's output:

```json
{
  "vulnerability": "IDOR",
  "confidence_score": 0.85,
  "reason": null,
  "plain_language_summary": "The /orders/:id route fetches an order by its number alone, without checking it belongs to the logged-in user. Anyone logged in can therefore read anyone else's orders just by changing the number in the URL.",
  "technical_detail": { ... }
}
```

The final UI must be able to show `plain_language_summary` to a non-developer
and have them understand the risk, without ever needing to open the technical
JSON. The Claude master has an explicit instruction to write that summary in
plain English, oriented towards "what can happen to me and how do I fix it",
never in SAST jargon.

## 5. Chosen technical stack

- **Indexing engine language**: Node.js / TypeScript (tree-sitter,
  web-tree-sitter or native bindings depending on the runtime)
- **Local LLMs**: Ollama, models to be settled in Phase 3 (start on an 8B,
  benchmark recall before scaling up if needed)
- **Orchestration**: a light message queue — no Celery/Temporal for the MVP, too
  heavy for a solo builder
- **Master**: Anthropic API (Claude), called only by the Aggregator
- **Index storage**: structured JSON in V1 (no Neo4j while the volume does not
  justify it)

## 6. What is NOT in the MVP scope

- No complete OWASP Top 10 coverage in V1 — we start with Injection (SQLi), XSS,
  IDOR and Security Misconfiguration (the most detectable and worthwhile), the
  rest comes after the pipeline is validated
- No TS compiler (ts-morph) — decided, see section 3
- No multi-tenant dashboard or billing in V1 — one repository, local use, before
  thinking about commercial scale

## 7. How each phase should behave

Before coding anything in a phase:
1. Re-read this file
2. Re-read `ROADMAP.md` to see where things stand and what is already delivered
3. Never hallucinate a third-party API (tree-sitter bindings, Anthropic SDK,
   etc.) — if there is any doubt about the exact shape of a function's return,
   write a minimal test or a verification `console.log` BEFORE building logic on
   top of it, and say so explicitly in the output
4. Every phase must end with tests runnable on a concrete example provided in
   the phase prompt, not just "the code compiles"
