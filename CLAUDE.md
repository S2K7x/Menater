# MENATER — AI SOC Mini

An LLM-driven SOC triage pipeline, demonstrating a secure agentic architecture
(guardrails, human-in-the-loop, shadow mode), together with its orchestration
console — which also hosts **VulnPipe**, the code vulnerability analysis, in the
same web application.

Two halves, one interface: the SOC handles what **has happened** (an alert is
already an incident), VulnPipe what **is about to** (a flaw in the code before
it ships).

**Write everything in English** — code, comments, documentation, user-facing
strings. The product was bilingual; it is not any more. The i18n catalogue
machinery was kept, with one locale in it, because it is what keeps user-facing
strings out of components.

## This project deploys with Docker

**That is the normal installation mode, not an option.** Every instruction in
this file assumes the containerised stack unless stated otherwise.

```bash
cp .env.example .env          # fill in the two passwords
docker compose up -d --build  # → http://localhost:4400
```

`npm run dev` is the **development** mode — hot reload, Vite serving the
interface. It is not a deployment mode: it assumes Node, an existing Postgres
and an already-applied schema.

## Stack

- **MENATER console** — `dashboard/`, Vite + React + TypeScript. Node API server
  with **a single production dependency** (`pg`); contains the VulnPipe section
  (`dashboard/src/vulnpipe/`) and the **workflow engine**
  (`dashboard/server/engine/`)
- **Postgres** — engine run log, hash-chained audit, deduplication, pipeline
  variables, tuning rules. Schema in `sql/`, applied on the container's first
  start
- **VulnPipe** — `VulnPipe/`, code analysis engine (tree-sitter, LLM,
  arbitration), a separate service on port 4319
- **OpenRouter** for the triage decision, **Slack** for notifications

## Architecture

## MENATER RUNS ITS OWN PIPELINE. THERE IS NO THIRD PARTY.

The six workflows are TypeScript definitions compiled into the console's own
process and executed by `dashboard/server/engine/`. The console reads what they
did from `soc_run` / `soc_run_step` — its own journal — via
`server/engine/cases.ts`.

**Nothing external orchestrates the pipeline, and nothing external is needed to
read it.** No n8n, no workflow platform, no second product that has to be
reachable for an alert to be triaged. What is deployed is three containers:
Postgres, the console (interface + API + engine), and the code analysis.

There is no publish step, so a workflow cannot be half-deployed, renamed in an
editor or left unpublished — a whole family of failures the console used to
have to detect and report simply cannot occur. What CAN still go wrong is the
database, the schema, the model key and the entry point, and those are exactly
what `Health → Test connectivity` checks.

6 independent workflows, communicating by sub-workflow calls, strict JSON
payload.

```
Ingestion → Enrichment → AI Decision → Action/Routing → Audit Log
                                                            ↑
                              Error Handler ────────────────┘
```

The 6th is called from the error branches of any parent, and declared as the
native *error workflow* on the other five. **Never in the normal sequence.**

| Workflow | Engine id |
|---|---|
| 01-Ingestion | `01-ingestion` |
| 02-Enrichment | `02-enrichment` |
| 03-AI-Decision | `03-ai-decision` |
| 04-Action-Routing | `04-action-routing` |
| 05-Audit-Log | `05-audit-log` |
| 06-Error-Handler | `06-error-handler` |

---

## Rules

### Design

- Every workflow has a fixed input and output schema, and they are **typed**
  (`server/engine/transforms/domain.ts`).
- **No irreversible action** is triggered without explicit human approval. The
  action catalogue is closed: `isolate_host_temporary` (with a TTL and
  auto-revert), `ticket`, `escalate`, `auto_close`. Nothing else is
  implementable, **not even behind an approval** — and no tuning rule can reach
  it.
- The LLM runs in `shadow_mode: true` by default until the false-positive rate
  has been measured over at least 50 alerts. **The default is fail-safe: missing
  configuration cannot enable execution.**
- Every external-call node must have Retry On Fail enabled, and Continue On Fail
  for non-critical enrichment.
- Never throw a silent error: every failure branch must log, notify, or both.
- **Silence is never consent**: an approval timeout executes nothing.
- **Never fill a gap with a default.** Missing data = shown as missing.
  Rejecting an alert because a field is absent is the same mistake in its
  harshest form: it replaces the alert with nothing.

### The alert contract — two tiers

- **Identity** (`alert_id`, `rule_name`, `severity`, `timestamp`, `raw_log`) is
  required. Missing means rejected, and the rejection names the fields.
- **Observables** (`source_ip`, `dest_ip`, `user`, `host`, `process`,
  `file_path`, `url`) are optional. Absent stays absent — `null`, never `''`,
  and never invented. Most real detections carry no destination address.
- **Extensions** keeps every unmapped vendor field, whole.

Consequence to hold onto: `isolate_host_temporary` **refuses to run when it has
no host to name** (`isolationTarget()` in `domain.ts`). An action whose target
is unknown is not an action.

### Measurement

Two distinct rates, never conflated:

- `ai_false_positive_verdict_rate` — the share of alerts classed as false
  positives. A measure of **distribution**, not of correctness.
- `human_disagreement_rate` — the share of decisions put to a human that they
  **rejected**. The only false-positive proxy observable without ground truth.
  **This is the one** that gates leaving shadow mode.

---

## Traps found on this instance

These cost time; they are written down so they do not cost it again.

| Trap | Detail |
|---|---|
| **Sonnet 5 / recent models** | `temperature` and `budget_tokens` are rejected with a 400. Use `output_config.effort` |
| **Splitting a SQL file on `;`** | Breaks as soon as a comment contains a `;`. Strip the comments first |
| **`keep-alive` on the VulnPipe relay** | A scan's SSE stream is cut when you leave the page; the socket returned to the pool poisons the next request — an empty-bodied `400` **right after a successful scan**, shown as a failure. `new Agent({ keepAlive: false })` in `dashboard/server/vulnpipe.ts` |
| **Class `.vp-scope` already taken** | VulnPipe uses it for an absolutely-positioned badge: the merged section container is called `.vp-embed`. **Same trap with `.soc-sources`**, already used by CaseView's enrichment grid (`repeat(auto-fit, minmax(220px, 1fr))`): the log-sources panel rendered as five 257 px columns with the `ossec.conf` block in pieces. Check a class name is free BEFORE writing it |
| **Two stylesheets stacked** | Both defined `:root`, `body`, `h1`… The VulnPipe sheet no longer carries tokens or globals, and its bare element selectors are scoped under `.vp-embed` |
| **Language set in an effect** | Child component effects run BEFORE the provider's: the screen reloaded its data in the language you had just left. *(Moot since the product went English-only, kept because the ordering trap is general.)* |
| **Snapshot cache without the locale** | Same origin as above, same resolution. *(Moot for the same reason.)* |
| **`overflow-x: auto` on a flex item** | A flex item has `min-width: auto`: it refuses to become narrower than its content, so `overflow-x` never applies. The tab bar kept its 668 px and **the whole page** scrolled at 375 px. `min-width: 0` on `.soc-nav` |
| **`React.lazy` with no net** | A chunk that fails to arrive bubbles to the root and **unmounts the whole application** — a white screen, while the alert queue worked fine. `SectionBoundary` keeps the failure inside its tab |
| **`closed` is the weakest sort weight** | In shadow mode — the default — **every successfully handled alert ends `closed`**, so at the bottom of the table, under two-day-old cases. Injecting an alert and watching it land last reads as "it never arrived". Fixed: a "new" badge (< 10 min) plus a rise under whatever blocks a human, and a sort selector |
| **`refreshSeconds` adjustable up to 3600** | At 3600 the screen does not move for an hour. That is half the diagnosis of "my alert is not arriving". Settings warns beyond 120 s |
| **Injection follow-up at `setTimeout(3000)`** | The full chain takes ~16 s (03's LLM call): at +3 s you only see the ingestion. The follow-up now polls to the end of the chain, 45 s at most, and **says** when nothing arrived |
| **TypeScript parameter property** | `constructor(msg: string, readonly key: string)` compiles under `tsc` and under vitest, but **the service runs under `node --experimental-strip-types`**, which strips types without compiling and refuses that syntax. It breaks at startup only, never in tests. Declare the field then assign it *(on the console side `erasableSyntaxOnly` refuses it at typecheck — that is the right place)* |
| **Bare `PORT`** | The most generic variable there is: hosts, preview harnesses and `npm` all propagate it. The analysis service started on the web interface's port while the console relayed to 4319 — a **503 "start the service" on a service already started**. `VULNPIPE_API_PORT` wins, the launcher **imposes** the port it just probed, and the log says where the value came from |
| **`Promise.all` over the whole window** | 120 heavy requests opened at once, each with its 25 s timeout: the last ones expired before being served and a chain lost its steps **through slowness, not failure**. `DETAIL_CONCURRENCY = 8` |
| **Invalidating `cache` without `inFlight`** | A traversal that started before a write finishes after it, and reinstalls the pre-approval state in the cache. `invalidate()` throws away both |
| **`.soc-field span` catches everything** | A descendant selector (0,1,1): it dresses EVERY span under a field in small grey capitals, including those of a nested component. A theme name showed in discreet grey at 11 px. Prefix your own selectors rather than touching a shared rule. **It has come back twice since**: a `REQUIRED` pill rendered as a full-width bar (indistinguishable from a second input), and `.soc-help` — a bare class (0,1,0) does not beat that selector, so twelve help texts rendered in capitals. A simple class is never enough here: you need `.soc-field span.my-class` |
| **Poster palette ≠ interface palette** | A reference image is lit and contrasted by its composition; its colours laid down as interface surfaces carry nothing. Lower the values, keep the hue |
| **`--hero` set to near-black on the light theme** | Described as "the most contrasted background", it was then exactly `--fg`: a contrast of **1.00:1**, black text on black, in EIGHT places (code blocks, connection strings, inset panels). Its real role is an **inset** — one step further from the text, in the same direction as the theme. A test checks it |
| **`pg` raises an error with an EMPTY message** | On `ECONNREFUSED`, `pg` returns an `AggregateError` whose `.message` is the empty string; the code is in `.code`, and in that of the aggregated errors. The webhook answered `"error": ""` — an unreachable database became a failure with no cause. `describePgError` goes and finds the code |
| **An ingestion endpoint with no secret** | "No authentication configured" reads as "no authentication required". Here an empty secret **closes** the door instead of opening it. And the tunnel launcher refuses to start without a secret: a tunnel exposes the console on the Internet |
| **Comparing two model calls** | A model is not deterministic: two calls on the same alert return `0.88` and `0.91`. You would measure its noise while believing you were measuring the correctness of a port. Only compare the deterministic part — guardrails, caps, routing |
| **Comparing a case the pipeline did not produce** | A test alert injected downstream, a fallback decision written by the pipeline: neither went through the guardrails. Comparing them produces disagreements that are not disagreements, and that block the cut-over for nothing |
| **A junction started too early** | A node with SEVERAL upstreams must not start as soon as one has answered. 02's assembly would have worked on a third of its sources — with no error, no trace, and a plausible result. The engine sorts topologically and waits until the fate of every upstream is known |
| **No DB coordinates reach the console** | `docker-compose.yml` passed no database environment, and `config.ts` had no env resolution for it — so the engine used `localhost`, i.e. its own container. **Every alert died on `ECONNREFUSED`**, visible only inside a `console_engine` block in a webhook reply. The environment now wins over `config.json` for the database block, because a file written once must not mask a deployment decision forever |
| **`sql/10-engine.sql` had no GRANTs** | The four other schema files grant to `n8n_soc`; the one holding the engine's own tables did not. → `permission denied for table soc_run`, again visible nowhere in the interface |
| **05 reads `alert_id` at the TOP level** | It answers `row_ok: false` otherwise, routes to `unusable`, writes nothing — **and the run still reports `done`**. Nesting the alert one level down produced a rule-closed alert with no audit row at all: closed AND dropped |
| **The API trusted the shape of its body** | `validateRule` checked meaning, nothing checked types. `conditions: "nope"` reached `.entries()`, `priority: "high"` reached Postgres. Six different 500s carrying an internal message: the caller learned something broke, never that THEY had sent something wrong. `normalizeRuleInput` runs first now |
| **A per-request nonce in a cached prefix** | Every provider reuses a prompt PREFIX; one byte changing before the breakpoint invalidates everything after it. The assistant's fence nonce changes on every request by design, and sitting mid-prompt it made the whole prefix — tool schemas included — uncacheable, once per step of the loop. Nothing fails: it is a bill. Invariant text first and argument-free, volatile block after |
| **`max_tokens` on GPT-5** | *"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."* The OpenAI adapter's default model is a GPT-5, so every request failed on the first call, with a message that reads like a bad key. OpenRouter still normalises the old name — the two adapters differ |
| **`cache_control` is not portable** | Anthropic-style per-block `cache_control` is forwarded by OpenRouter and REJECTED by OpenAI direct, whose caching is automatic on a stable prefix. Sent everywhere it turns one provider's optimisation into another's 400 |
| **A transcript opening on an assistant turn** | Anthropic and Gemini refuse it. A browser replaying a thread that starts with a greeting gets a 400 naming neither cause nor fix. Leading assistant turns are dropped before the request |
| **A tool schema is a bill you pay whether or not the tool is called** | Every definition is loaded into the context on EVERY request — Anthropic measures MCP metadata at roughly 40% of token usage in some setups, and GitHub's server at 17,600 tokens of definitions. Adding tools is not free. Descriptions say WHEN to reach for a tool and stop; `destructiveHint` is omitted because the spec defines it as meaningful only when `readOnlyHint` is false. Four tools were added for +12% schema, and the per-tool cost fell from 615 to 493 bytes |
| **Returning fewer FIELDS beats every other saving** | `get_alert` takes a `sections` argument: a narrow read is 62% smaller. The default stays "everything" — a caller who does not know what it needs must not get a truncated record it believes is complete — and a narrowed reply says its reading is partial |
| **The test suite read the developer's `config.json`** | `getConfig()` falls back to `dashboard/config.json`, which on a used machine holds real coordinates and keys. Every snapshot-backed test then went and dialled THEM, and waited **10.5 s** for the connection to time out. Tests timed out on one machine and passed on another. `vitest.config.ts` now points `MENATER_CONFIG` at a path that does not exist: the suite went from ~10 s of flakiness to **1.8 s** |
| **An MCP text block must stay parseable** | The spec asks a tool returning structured content to also return the SERIALISED form in a text block. Prefixing the fence note onto it left `content[0].text` as something no client could parse — while `structuredContent` beside it made everything look fine. The note is a second block now. Found by calling the endpoint, not by reading the code |
| **401 and 502 are poisoned status codes** | `lib/api.ts` turns ANY 401 into `AuthRequiredError` — "log in again" — and replaces the body of a 502/503/504 with a generic "the API is not responding" (those usually come from the Vite proxy and are not JSON). So a route that forwards an upstream's 401 answers a refused **model** key with *"Authentication required."* and sends the operator to the login screen; one that reports a named failure as a 502 has its sentence thrown away. Everything the operator can fix leaves the assistant as a **409** |
| **`/api/*` served the SPA on 200** | The static fallback rendered `index.html` for any unknown route, `/api/` included. A `GET` on a POST-only route answered 200 and HTML, so the client failed on `Unexpected token '<'`. Only broken in Docker: in development the 404 fell out correctly, for want of a `dist/` to serve |
| **A prompt whose invariant half sits AFTER the variable half** | Symmetric to the nonce trap below. VulnPipe's IDOR system prompt was two lines; the directives, calibration grid and output format lived in the *user* message, after the route's code. The longest prefix two calls of a scan shared was **130 characters**, so no provider's cache — automatic on OpenAI and Gemini, explicit on Anthropic — could ever fire, and the same three thousand characters were billed at full rate forty times over. Nothing fails: it is a bill. Invariant first, volatile after — and measure the prefix, because under ~1024 tokens the cache does not engage at all (this one is at 460-660: the shape is right, the saving is not there yet) |
| **`cache_control` marked on a prefix that is too short** | Marking costs a write premium (1.25× input) and returns nothing if the block is never re-read. `cacheableSystem` in `nodes/shared/llm/types.ts` refuses below a length threshold. The constant lives in `types.ts`, not `anthropic.ts`, so the OpenAI-compatible adapter can read it **without loading the Anthropic SDK** |
| **Retry wired on one provider out of five** | `withRetry` existed and only Gemini called it. A 429 on Anthropic, a 502 from a router, an Ollama still loading its model: all transient, all fatal to the address concerned — and **a route that was not analysed is not a healthy route**. Now on all five. The test-visible cost: an error test waits for the real backoff, so every client takes a `retry` option and the error tests pass `{ attempts: 1 }` |
| **Retrying in lockstep once calls are parallel** | With sequential calls only one retry could ever be pending, so the wait time did not matter. With four in flight, four calls cross the quota at the same instant, get the same suggested delay, and all restart together — refused again in a block. Full jitter fixes it, with the API's suggested delay kept as a **floor**: it says "not before", and undercutting it guarantees the second refusal |
| **A cache key that does not carry the code** | Keying a detection verdict on `IDOR:GET:/orders/:id` would re-serve "vulnerable" on code just fixed, and "safe" on code just broken — a false negative served instantly and for free, the worst failure mode this product has. Both caches key on the exact text shown to the model, plus provider and model. In doubt, the cache stays silent and you pay again |
| **An estimate that sums latencies** | It was right only while addresses were scanned one at a time. Once they go out in waves, quoting eighty seconds for a scan that takes twenty is not prudence, it is a wrong number — and it talks people out of an affordable scan. `estimateScan` counts **waves** (`ceil(calls / concurrency)`), and only for detection: arbitration is a single call for the whole batch, so dividing it too would make real waiting time disappear |
| **Two free things counted as one** | "Settled without the AI" and "already known from the cache" both cost nothing, and say opposite things about coverage. Summed into one counter, the cache's work is credited to the deterministic scanner, and the rules look like they cover ground they do not. Counted and worded separately, in the live view and at the end of detection |
| **A cache that outlives the code that produced it** | In memory, a restart wiped it: an entry could not survive the pipeline that made it. On disk it survives a `git pull`. The key carries the prompt, so the code — but not the SHAPE of what is stored: change `IDOR_OUTPUT_SCHEMA` and yesterday's entries are re-served with a field today's code reads and they do not have, their key unmoved. Two answers: the output schema went **into** the key, and the file header carries a `version` that makes a file of another format ignored **wholesale**, never read crookedly |
| **A model name is stable, the model behind it is not** | `claude-opus-5` keeps its name while the provider moves the snapshot under it. In RAM that never mattered — nothing lived past a restart. On disk, a six-month-old verdict would be re-served as if a model that no longer exists had just answered. Hence a 30-day expiry, generous on purpose: an expired entry costs a call, never an error |
| **Adding memory to a product obliges you to add forgetting** | Restarting the service used to be the escape hatch when a verdict looked stuck on code you had just fixed. Persistence removed it, and nothing replaced it — so someone who doubted a report had no way to check, and would have been right to stop trusting it. `DELETE /cache` and a **Forget everything** button in Settings. `forget()` clears the LRU *before* the file and cancels the pending write, otherwise a debounced flush already in flight would put back what was just erased |
| **A shutdown flush that trusts a `dirty` flag** | `close()` only wrote when `touch()` had been called. Any entry placed in the cache without going through that bookkeeping was lost at shutdown — silently, and precisely for the last scan, the one you just paid for. A test caught it. The final write is unconditional now: the guarantee must not depend on accounting kept somewhere else |
| **A test suite that reads the developer's cache** | Same family as the `config.json` trap below, one notch worse: the suite would also *write* into `.vulnpipe/`. Two locks rather than one — `vitest.config.ts` sets `VULNPIPE_CACHE_PERSIST=false` **and** points `VULNPIPE_CACHE_DIR` somewhere that does not exist, and `makeServer` passes the flag explicitly because that server reads the env object it is handed, not `process.env` |
| **A run that shows `running` forever** | Persisting run state creates a state that did not exist before: a journal with no terminal line. The process that was executing it is gone and nobody will resume it, so re-reading it as "running" would be a failure that shows green — the exact defect the Tracking tab exists to expose, reproduced in the other half of the product. It is re-read `interrupted`, it says so in plain language, and it does **not** pretend to resume: the pipeline has no per-step journal, so "resuming" would silently re-run everything and present it as a continuation |
| **A recovery that is not idempotent** | `recoverInterrupted` graved a terminal line on every boot, because it could not tell "interrupted, deduced from a missing line" from "interrupted, already recorded". The journal grew at every restart and the same scan was re-announced months later. The reader now reports whether the terminal line was *written* or *inferred* |
| **`fsync` applied out of prudence** | It is synchronous and it blocks the whole event loop; on macOS it made the same test file swing between 3.5 s and 32 s. The question to ask per line is what a power cut in the next few milliseconds would actually cost. The run header: the run is dead anyway and will be re-launched — no fsync, and it sits on the launch path where someone is waiting. The terminal line: the **report**, i.e. what was just paid for — fsync. Synchronise what cost money, not what cost an intention |
| **A cap that evicts something still in use** | The emitter cap took "the oldest", and the queue runs jobs one at a time — so a burst of launches left them all pending and the oldest was the one about to start. A legitimate scan, never run, reported as a failure. A cap must skip anything still live and let itself be exceeded rather than break work in flight; memory is cheaper than a lost scan |
| **A periodic clean-up throttled only by time** | Throttling `sweep()` to once per 30 s stopped it costing 200 syscalls per launch — and stopped retention holding at all: 20 runs created in one second left 20 files against a bound of 5. A clean-up postponed far enough is a clean-up that does not happen. Throttle by **work done** as well as by time; the overshoot is then bounded and known |
| **A shutdown that only flushes what it wrote** | `shutdown()` flushed the caches and the run journals, and left the pending estimates alone — each holding a repo index, a context-server connection and, for a GitHub target, a **temp clone**. The periodic sweeper collects them, but it does not run once the service is stopped: every restart left clones behind that nothing would ever collect. Found while chasing a test that hung; the cause was a production resource leak |
| **A request body with no size limit** | `for await (const chunk of req) chunks.push(chunk)` accumulates without bound. One large POST grows the heap until it chokes — the most ordinary denial of service against a JSON API. Cap it, **discard what is already held** rather than finishing the accumulation before refusing, and say it was the size |
| **A global "non-2xx means failure" rule** | Correct for the three enrichment sources, wrong the moment a fourth arrives: HIBP answers **404** for "this address appears in no breach", which is the best news the endpoint has, and Shodan and VirusTotal say "never seen it" the same way. Under one shared rule every clean address became *source unavailable* — a result that reads like an outage, on the single most common outcome. Each provider declares its own answering codes; there is no global rule, because there is no global truth |
| **An API flag that removes the field you came for** | Shodan's `minify=true` returns "the list of ports and general host information **with no banners**" — and `vulns` is a banner field. The one thing the paid source adds over the free InternetDB came back empty every time, with nothing on screen to suggest a flag was responsible. The symmetrical waste on the neighbouring source: AbuseIPDB's `verbose` adds one field nobody maps and a `reports` array **capped at ten thousand elements**, downloaded and parsed on every lookup to be discarded. Read what a convenience flag removes, not only what it adds |
| **A response body nobody reads** | Node's `fetch` keeps the socket checked out of the connection pool until the body is consumed or cancelled. Every early return — a 429, an unexpected status, a 404 treated as an answer — walked away from one, so a long-running console held sockets open against five services with nothing to show for them. Undici reclaims them on garbage collection, which is the kind of "eventually" that only misbehaves under load. `drain()` cancels explicitly |
| **`Retry-After` as an HTTP date** | The spec allows both forms, and `Number('Wed, 03 Sep 2026 17:30:00 GMT')` is `NaN` — which fell through to a 60 s default and **undercut** the delay the service asked for. The suggested delay is a floor: undercutting it buys the second refusal. Parse both, cap the result, so one bad header cannot park a source for a day |
| **A regex that can never match, next to one that can** | `refang()` opened with a rule requiring `tt` where a defanged scheme has `xx`. It never fired; the rule below it did all the work. Dead code that looks load-bearing is worse than no code — the next person moves it, or "fixes" the one that works |
| **A verdict that says "clean" because nobody looked** | With no key configured every source skips, every skip is silent, and the naive reduction prints reassurance over a value nobody queried. `clean` now requires at least one source that ACTUALLY ANSWERED, the count sits next to the verdict, and the no-key case is `unknown` and says so. Same family as filling a gap with a default, moved into the investigation surface |
| **A test that actually sleeps** | The retry tests waited out real backoff to check a multiplication. They were the first to go red on a loaded machine — an intermittent test is a test people learn to ignore, so it protects nothing. Making the sleep injectable took that file from 3.49 s to 130 ms and removed the flakiness at the root |
| **A modifier class that loses to its own container** | `.soc-statbar li` is (0,1,1), `.soc-stat-focus` (0,1,0). The tile that carries the accent therefore kept the PANEL background and still took `--accent-fg` — white on cream, **1.05:1** — on the one number that says an alert is waiting for a human. Same family as `--hero` and as `.soc-field span`, and the third time this project has paid for it: a modifier written as a bare class never beats the rule that dressed the element. Name both, `.soc-statbar li.soc-stat-focus` |
| **A shared component whose CSS names only one parent** | The glossary bubble is styled as `.soc-term .soc-term-bubble` — deliberately two classes, because it renders inside containers that impose capitals. The circled "i" reuses that bubble under `.soc-info`, so with the parent unlisted it was neither positioned nor reset: the explanation rendered as a paragraph of Archivo Black capitals **inside the `<h3>`**, pushing the number it explains out of the tile. Reusing a styled element means adding your parent to every one of its selectors, the responsive ones included |
| **Invisible to the eye is not hidden** | A closed `<details>` popover was positioned absolutely and never hidden: out of flow, unseen, and still in the render tree — so it joined the accessible NAME of the heading or `<th>` around it. A metric tile was announced as its own definition, twice over. `innerText` is the cheap test: it returns only RENDERED text, so if it contains what you thought was hidden, assistive technology reads it too. `:not([open]) .soc-term-bubble { display: none }` — and note this fixes every call site at once, where moving the markup fixes only the ones you remember |
| **`<details open={x}>` in React is half-controlled** | React re-asserts the attribute whenever the value changes, `false` included — so a prop named `defaultOpen` will close, on its own, a fold somebody just opened, the moment any data lands. `Fold` freezes the initial value at mount and treats the prop as a signal that OPENS and never closes. Every real call site is "open when this becomes true, asynchronously" (a key appears, a health check answers, a step starts), and none of them wants the reverse |
| **A modifier written as a bare class, for the third time** | `.soc-field span` is (0,1,1). `.soc-wf-var-help` is (0,1,0) — someone had already noticed the problem, written the fix as a bare class, and it never once applied: the fourteen pipeline-variable help texts rendered in spaced capitals. This table has warned about this selector twice before, and both earlier fixes named the element. **Naming the element is not a style preference here, it is the only thing that works**: `.soc-field span.soc-wf-var-help` |
| **An empty screen shows none of its defects** | Tracking and Workflow were blank on the test install — no database — and reviewing them that way found nothing. Mounted with data of the right shape (a throwaway preview page, deleted after), they gave up four defects in ten minutes, including a run log that showed ERROR without the reason it already held. If a screen cannot be filled from the environment, fill it from a fixture; do not conclude from an empty one |
| **The same thing said three times reads as three things** | The Lookup tab explained itself in the page header, again in a paragraph above the field, and a third time in the empty state below it — 2 609 px before anyone could type. Each sentence was written at a different moment, by someone looking at one screen; none of them is wrong. Duplication of INTENT is invisible per-file and obvious on the rendered page, which is why this pass measured screens rather than reading components. Keep the header and the empty state, fold the mechanical one |
| **A fold summary can be worth more than what it hides** | The Lookup source catalogue does not say "7 sources", it says **"1 of 7 reachable"** — on an install with no keys, that is the most useful sentence on the screen: it says in advance that every answer will be *not asked* rather than *nothing found*. And at zero it opens itself, because filing a null coverage behind a silent click is showing green over a hole — the rule the tab already applies to its verdicts, applied to its own chrome |
| **A reference you cannot search is a reference you scroll** | The Guide is seventeen sections and a hundred-odd points behind an accordion. Folding was right and not enough: someone arrives with a WORD, and had to guess which section held it. Worse, the search — once written — proved the guide could not answer "shadow", its own default mode, because the text calls it "watch-only mode". The fix reads the GLOSSARY as well as the sections rather than keeping a hand-written synonym list beside the text: a second list of words diverges from the text on the first edit, the glossary is already the product's answer to "what does this word mean". And a filtered section says "1 of 5 points" — a silent filter makes a section look shorter than it is |
| **A number that skips is worse than no number** | The guide's sections carry `01`…`15`. Grouping reordered the page while the numbers still followed the catalogue, so one group read "04, 05, 06, 07, 10, 12". A number stops marking a position and starts making people hunt for the missing ones. Number by reading order, and keep it stable under a filter |
| **A bar that scrolls without looking like it scrolls** | Settings has ten sub-sections; at 1280 px the bar showed seven and hid three behind a horizontal scroll with no cue. On a page you BROWSE that is a nuisance; on a page where you come looking for one named section, it means those three do not exist. A gradient on the overflowing edge, measured from `scrollWidth` — and the measurement must never be able to take the bar down with it (`ResizeObserver` is missing under jsdom and on old browsers, so its absence is caught and the bar renders without the cue) |
| **A procedure filed among the settings** | The Ingestion tab was three quarters install script, `ossec.conf` block and a twelve-row mapping table — things you follow ONCE, on another machine — and you had to scroll past them to reach the setting next door. Fold what is executed elsewhere, keep what is configured here; the endpoint stays in the clear because it is the one line people come back for. Same split on the engines page: six settings blocks, one open, and the Status block opens ITSELF when the engine is unreachable |
| **The same help, printed once per instance** | The provider form is rendered twice on the engines page — one per role — so its two three-line help paragraphs appeared twice each: six lines of identical prose between the four fields you are comparing. Duplicated explanation is invisible in the code (one string, one component) and obvious on screen. Behind the circled "i", read from the same catalogue |
| **An empty screen is a claim, and it needs a scope** | The scan report printed one sentence — "nothing to report" — whether everything had been read, whether six addresses had failed, or whether only the changed files were re-checked. Three situations, one reassuring sentence, one green. "Nothing found" is only true of what was READ: the screen now names files indexed, addresses found and analysed, and a partial coverage changes the TITLE rather than adding a footnote. Same rule as `clean` requires a source that ANSWERED on the Lookup tab. And the first version of the fix took green by default when coverage was UNKNOWN — reassuring about a scan it knew nothing of, i.e. the defect it exists to remove, rebuilt inside itself. Green is earned, grey is the tone of the undetermined |
| **A screen you cannot reach without credentials is a screen no sweep covers** | The move to English-only was checked by opening every tab in the browser and hunting accented characters — and reported as "Zero". Nine French strings survived, all of them in the scan report and the usage panel, which **cannot render without a completed scan** (a model key, real code, a few minutes). The tests did not catch them either: five were *asserting on the French*. Six of the nine even had an unused English entry already in the catalogue — a typed catalogue refuses a key added on one side only, it cannot refuse a string that never asked it anything. Enumerate the credential-gated screens deliberately, or read the components |
| **Two correct rules whose INTERSECTION loses data** | *An empty poll does not advance the cursor* (right) and *with no cursor, ask from now* (right on its own) together made a permanent, silent hole: a source that has never delivered keeps a `null` cursor, so the poll at T-15s asked `[T-15s, ∞)`, an alert was raised at T-10s, and the poll at T asked `[T, ∞)` — the window between two polls was requested by neither, and **every alert raised before a source's first delivery fell into it, forever, under a green check**. With no cursor the poll now looks back `interval + overlap`, which is by construction longer than the gap between two polls, so consecutive windows always overlap. Found by reading a fixture's request log — neither rule looks wrong in the file that holds it, and no test of either one would have failed |
| **A settings form that saved on every keystroke, wired to a poller that polled on every save** | Each half was defensible. The Ingestion tab has no draft on purpose — the lane table must never describe a policy that is not running — and `sync()` re-polled so that "enable polling" took effect without a restart. Together, typing `120` into the interval field made **three real requests to somebody's SIEM in under a second**, and typing a URL made one per character; the server's 15 s floor also rewrote the `1` you had just typed and fought your cursor. Measured on the running console: nine saves used to mean nine polls, now one. The fix is on both sides — fields commit on blur or Enter, and `sync()` restarts the timer **only when the period changed**, polling immediately on a cold start and never on a re-sync |
| **`setDraft(null)` then `blur()` does not cancel anything** | Escape was written that way and saved the abandoned value anyway: React had not re-rendered by the time `onBlur` ran, so `commit` closed over the draft the user had just discarded. State is what the render sees; a **ref** is what the event handler sees at the instant it runs. Caught by a test, not by pressing Escape |
| **A response body with no size limit** | The mirror of the request-body trap below, pointing outward. `await res.json()` buffers whatever arrives, from an address somebody typed into a form — a source answering a gigabyte, by malice or by a forgotten pagination parameter, grows the heap until the console dies. **A log source must not be able to take the console down.** Streamed and counted rather than buffered then measured (checking `.length` afterwards is checking whether the heap survived), held bytes discarded on refusal, and `Content-Length` used only to refuse early — it is a claim by the other end, never a reason to let something through |
| **A limit nobody can read** | `max / 1024 / 1024` printed *"over 0.00048828125 MB"*. A cap an operator cannot say out loud is a cap they cannot act on; `humanBytes` prints bytes, kB or MB |
| **Bounded concurrency changes what a cursor may mean** | Delivering a batch one alert at a time is a poll that holds a source for twenty-six minutes (`engine.start` awaits the whole pipeline, ~16 s an alert). Four at a time fixes that — and immediately breaks the checkpoint, because alert 7 can succeed while alert 3 fails, so "the newest thing that worked" places the cursor past an alert nobody will ever fetch again. The cursor takes the longest **consecutive prefix** of successes; `mapLimit` returns results in INPUT order, which is what makes a prefix meaningful rather than an accident of who finished first |
| **A poller with no failure backoff** | A source refusing us for an hour does not become reachable by being asked every fifteen seconds, and hammering one that answered 429 is how a poller gets its key revoked. Doubling per consecutive failure, capped at 30 min, **jittered downward only** so sources that failed together (one network outage) do not all return at the same instant. Two things it must not do: back off in **silence** — the wait is on the cursor and on screen, because a skipped source is otherwise indistinguishable from a poller that stopped — and apply to the **"Poll now" button**, since a diagnostic control that answers *"not yet, wait 8 minutes"* is one nobody presses twice |
| **`writeFileSync` on a timer** | The cursor file was written synchronously on every poll of every source: blocking I/O on the event loop, forever, so the console's request handling paid for a background transport. What a power cut costs here is one overlap window, which dedup absorbs — an intention, not money — so it is debounced, asynchronous and **not** `fsync`ed, with an unconditional flush on `SIGTERM`. Unconditional because a flush that consults a `dirty` flag loses exactly the last poll |
| **`pg` returns `bigint` as a STRING** | `soc_audit_log.id` is a `bigserial`, so the audit row id reaches the case builder as `"2651"`. Read with `typeof v === 'number'` it became `null`, every case was recorded as having no committed audit row, and the Health tab announced **"38 cases with no committed audit row: those decisions are not traceable"** over a database whose hash chain was intact. **A false red costs more than no red at all** — this console's whole risk grammar rests on red being trustworthy, and a red raised over healthy data teaches an operator to discount the one screen that must never be discounted. Same family as the `{ rows: [...] }` trap: the shape was right and the TYPE was not. Found by running it against the real database; a hand-written fixture would have used a number and proved nothing |
| **A console that could not read its own engine** | The queue, the metrics and the Tracking tab were built by walking an n8n execution list, while the built-in engine wrote every run to `soc_run` and `soc_run_step` — and **nothing ever read them back**. A console running on its own engine showed an empty queue. Removing n8n was therefore not a deletion but `engine/cases.ts` plus `recentRuns`/`stepsOfMany`: the journal had been write-only for its whole life |
| **`identity_source: 'n8n_form_self_declared'`** | The approver's identity was labelled after the FORM it came through. The console's lock protects access and identifies nobody, whatever the transport, so the field now says `console_self_declared` — what it actually means, rather than where it happened to arrive from |
| **Three transports, three different ways of saying "it worked"** | Slack's bot API answers **HTTP 200 with `{"ok": false}`** when it FAILED, so the status code is useless. A Slack incoming webhook answers **HTTP 200 with the literal text `ok`** — `res.json()` throws on it. A Discord webhook answers **HTTP 204 with an EMPTY body** — `res.json()` throws on that too, and a truthiness check on the body calls a delivered message a failure. Reading any one of them with another's rules turns a message nobody received into a success, or the reverse; and the message is usually the approval request, so the cost is a run waiting for an answer to a question never asked — or an alert escalated that a human WAS asked about |
| **Two chat platforms, two payload vocabularies** | Slack takes `text` + Block Kit `blocks`; Discord takes `content` + `embeds`, caps `content` at 2000 characters and allows at most 10 embeds. Both forms are built in `buildApprovalRequest` from the SAME structured facts rather than converting Block Kit into embeds — a mapper between two rich formats is a lossy translator nobody can read or check, and it would drift the moment either side gained a field. The over-long case is CLIPPED, not refused: a truncated escalation still tells somebody to come and look, a 400 loses the notification entirely |
| **Naming a node after one of its destinations** | The node type was `slack`, which was true until Discord arrived and then was a lie in the one place the graph is read from. Renamed `notify`, and the setting with it — `slack.transport` became `notify.transport`. `migrateVariables` carries the old key's VALUE across and deletes it, because `merge` would otherwise leave the dead key in the list: editable, saved, and read by nothing, which is the "setting that looks applied and is not" this product refuses everywhere else |
| **A webhook is locked to one channel, and the settings that pretend otherwise** | Slack binds an incoming webhook to the channel it was created for and IGNORES a `channel` field in the payload. So the four channel variables stop meaning anything the moment the transport is a webhook. The node does not send `channel` at all, and the interface says the settings no longer apply — four fields that look configurable and do nothing is a screen that lies quietly |
| **Suppressing a QUESTION is not the same as suppressing a notification** | A severity threshold on Slack is the standard cure for alert fatigue, and on this product most Slack messages are approval REQUESTS. Suppressing one and then waiting thirty minutes for its answer is the worst of both: nobody was asked, and the alert sits blocked until it times out. So a suppressed request is not posted AND not waited on — the run escalates immediately, the case says why, no action is executed, and the alert is still in the console queue. Slack is a notification channel, never the system of record |
| **A threshold nobody set must not silence a console** | `slack.minSeverity` defaults to `low`, i.e. notify about everything, which is what the pipeline did before the setting existed. An unreadable or missing value falls back the same way, and an alert whose severity did not survive normalization ALWAYS notifies — the same rule the ingestion lanes apply to an unrated alert |
| **A free-text box for a value with five legal words** | Pipeline variables are strings, and a text input is the honest default for one. But typing `Webhook` or `HIGH` would be accepted, saved, and then silently ignored by the engine — a setting that looks applied and is not. `VAR_CHOICES` gives the two enum variables a picker; the vocabularies are listed rather than inferred, because inferring them from the current value offers exactly one option |
| **A hash chain sealed under a lock, with the id allocated OUTSIDE it** | `soc_audit_seal()` takes `pg_advisory_xact_lock` before reading the previous link, so no two transactions can seal against the same predecessor. But `id` is a `bigserial` and its DEFAULT is evaluated BEFORE the trigger — that is, before the lock. So txn A takes id 433 and waits, txn B takes 434, seals first against 432, and A then seals against 434 while carrying 433. **The chain is a perfectly intact linked list that is no longer in id order** — and `soc_audit_verify_chain()` walks by id, so it reported `BROKEN_LINK: row deleted or reordered` on rows nobody had touched. Measured under a stress pass: 22 of 3195 rows, all in pairs. The worst possible false alarm on this table: it is the product's only tamper-evidence, and a verifier that cries wolf is one an auditor stops believing — which would hide a real deletion in the noise. `NEW.id := nextval(...)` moved INSIDE the lock; the value the DEFAULT burned is skipped, and a gap in a sequence costs nothing. Verified: ~500 rows at 40-way concurrency, zero new breaks |
| **`WHERE NOT EXISTS` is not a race-safe insert** | The deduplication query read *"insert unless a row exists"* inside one statement, which looks atomic and is not: under MVCC two concurrent transactions both see the row absent, both insert, and one dies on the unique constraint. Twelve simultaneous sends of one `alert_id` answered ten 200s, one 202 and **one 500** — and a 500 tells the sender to retry an alert that was already accepted. `ON CONFLICT (alert_id) DO NOTHING` pushes the decision into the index where it is atomic by construction. The outer `SELECT NOT EXISTS (SELECT 1 FROM inserted)` keeps the query returning EXACTLY ONE ROW, which is what preserves the other guarantee: an empty answer still means *"the store did not answer"*, never *"this alert is new"* |
| **The entry point answered 202 for an alert the pipeline REFUSED** | `01-Ingestion` has four `respond` nodes — 400 invalid schema, 200 duplicate, 500 dedup unavailable, 202 accepted — and they exist to be the answer the sender gets. The webhook ignored all four and returned a blanket `202 accepted` for every alert it managed to start. So an alert rejected for missing fields was reported as accepted, the sender had no reason to fix anything, and the reason — already computed and written down — never left the server. `Engine.responseOf()` reads the run's terminal `__response`; the last one wins, because a graph reaching two of them branched after the first |
| **A `respond` node with a `fn` that was never called** | `respond-400` is declared with `fn: 'rejectionBody'` and a `body` of constant `null`. `makeRespond` read only `body`, so the sender got a 400 with a null body while `rejectionBody` had already composed the sentence naming the missing fields. The node's own note says *"Says WHAT is missing, not 'invalid'"* — and the thing that says it was wired to nothing |
| **Reading a node's output under a field name you remembered** | `cases.ts` reads named nodes AND named fields inside them. The node ids were tested against the workflow definitions; the FIELD names were not, and every fixture was written from the same memory as the reader. Three got through: `validation.valid` where the transform writes `validation_ok` (so a REJECTED alert's stage note read *"received and validated"*), `tuning.routing_outcome` which that transform does not produce at all, and `row_id` as a number. The fix is not a fourth careful read — it is `pipeline-to-case.test.ts`, which runs the REAL workflows through the REAL engine and hands the result to `buildCases`, so no fixture is written by hand |
| **Sorting a case's stages by timestamp alone** | A sub-workflow is started by its parent, so under load the two runs land in the SAME millisecond — and run ids are UUIDs, which order nothing. The case card then showed `03-AI-Decision → 01-Ingestion → …`, a chain that appears to have run backwards. Within one instant the canonical order is the one the pipeline is wired in |
| **The diagnostic probe counted as an anomaly** | The Health tab's probe posts an invalid payload on purpose, so it has no `alert_id` and lands among the orphans. Counted, it raised `attention` on the Tracking tab after every connectivity test — and a permanent alarm stops being read. `diagnostic_probe` is listed and deliberately absent from `UNEXPECTED_ORPHANS`. This was documented as a rule and lost in the rewrite; the test now pins it |
| **`extensions` reached the audit row and never the card** | The contract says unmapped vendor fields travel *"on the case and in the audit row"*, and only the second half was true: `AlertCase` had no field for them at all. Someone who adds a source often does it FOR those fields, and they were unreachable from the incident card. Folded, because it is reference material, and the fold says how many there are |
| **A poll whose HTTP call succeeded, reported as a success** | The GET returned 200 and one alert, `deliver` threw because no database was configured, and `pollSource` still answered `error: null`. The screen showed a green check and *« 0 alerts collected, last answer 3 s ago »* over a pipeline dropping everything handed to it — a failure showing green, which is the exact defect the Tracking tab exists to expose, rebuilt in the transport layer. **The question the operator is asking is not whether the HTTP call worked.** A poll that read alerts and placed none is a failed poll, it says how many it read, and it names the cause. Found by running it, not by reading it |
| **Advancing a cursor after an empty poll** | A source that is down, slow or rate-limiting returns nothing — indistinguishable from a source where nothing happened. Advancing on the first case skips whatever it was holding, permanently, with no error anywhere. `recordPoll` only ever writes a `since` taken off an alert we actually delivered, and each poll reaches back past the cursor by an overlap because a source that timestamps at detection and indexes a second later would otherwise lose that second. Dedup absorbs the repeats |
| **A per-source ingestion endpoint behind the console's lock** | `PUBLIC_ROUTES` is an exact-match Set, and N4 added `/api/ingest/:source` beside the legacy `/api/webhook/soc/alert` without adding it there. So the moment anyone set a console password, **every Wazuh agent got a 401 telling it to sign in** — at an endpoint that authenticates with a shared secret and has never had a session cookie. The data plane is now a regex, and the control plane was given its own namespace (`/api/ingestion/`) precisely so that regex needs no growing list of exceptions |
| **`.soc-field span` sets the FONT and the COLOUR too** | The trap below is about its capitals; neutralising only those left every help text under a field as `--faint` **monospace** prose. Mono is for values you compare character by character, and `--faint` is the token for what you may skip — a sentence explaining that an empty push lane would send P1 down the slow lane is neither. Invisible while each help text was one short line; obvious the moment one ran to three. `.soc-field span.soc-help` now resets `font-family` and `color` as well |
| **One string for an architecture and for a transport** | The delivery card is named *« Pull only »* — a choice. The lane table names the pipe an alert travels down. Reusing the card's string put *« Pull only »* in a row of a table describing a **hybrid** policy, which reads as a contradiction. Caught by a test that failed on a duplicate match, not by looking at the screen |
| **`payload.workflows[0].nodes` with no guard** | Harmless while the graph was its own tab and the API always returned six workflows. It became a whole-tab crash the moment that panel turned into a section of Ingestion: an empty list took the delivery policy and the source catalogue down with it. An empty list is a state, not an impossibility |
| **A modifier that resets everything EXCEPT the font — fourth recurrence** | `.soc-check-field > span` neutralised the capitals, the tracking, the size and the colour of `.soc-field span`, and not `font-family` — so all **five** checkbox explanations in Settings rendered as monospace prose. Mono is semantic here: it means *this string came from the machine, and it is exact*. A sentence explaining what watch-only mode does is neither, and the reader pays a font switch that carries no meaning. Exactly the omission the `.soc-help` rule documents two hundred lines below, in the one place it had not been applied. Second half of the fix: the two rules were tied at (0,1,1) and this one won only by sitting 166 lines further down — `.soc-field.soc-check-field > span` (0,2,1) wins by SPECIFICITY, which the next edit to the sheet cannot silently change |
| **A name that outlives the thing it named** | n8n left with W-final and four surfaces went on naming it, all of them reading as working software: the Health tab's engine card (a hardcoded literal — the only user-facing string on that screen outside the catalogue, so the typed catalogue could not refuse it: it was never *asked* anything), a Settings banner promising *"restart n8n"* over pipeline variables the engine re-reads on every run, a Guide entry documenting a third ingestion mode that no longer exists, and three *"open in n8n"* links whose `href` was always `''`. **A stale name is the cheapest thing to carry and the most expensive thing to believe** — and three of the four are screens whose whole job is to say what is true right now. The Settings one is the mirror of the defect this product refuses everywhere else: a change that HAD applied, reported as one that had not. `n8n-removed.test.ts` walks the catalogue, calls the functions too, and fails on any user-facing string naming it |
| **A controlled field that NORMALISES on every keystroke** | The inventory's identifiers are one per line, so the first draft split the textarea on every change and joined the list back into `value`. Splitting drops empty lines — which is right on the way out, and fatal while typing: the newline is removed the instant it is typed, Enter appears to do nothing, and a machine's SECOND address can never be entered. The field silently refuses the only thing it exists for. Same family as `setDraft(null)` then `blur()`: the state a controlled input shows must be what the typist typed, and the tidying belongs at the boundary — here, once, in `fromInventoryDraft` on save. The dirty check compares the CONVERTED value, so a trailing newline is not an unsaved change |
| **A LIST stored as a `config.json` section** | `merge()` walks the sections of the default config and does `{ ...base[section], ...patch[section] }`. `typeof [] === 'object'`, so an array section is spread INDEX BY INDEX: saving `[a]` over `[a, b]` yields `{"0":a,"1":b}` — the entry that was just deleted survives, at the index the shorter list no longer covers, and the section stops being an array at all. Measured on the real function before writing the feature. The service inventory is therefore `{ entries: [...] }`, one level down, where the spread replaces the whole key. Any future list-shaped setting owes the same wrapper, and the test that proves it is the one that REMOVES an entry — a test that only adds passes either way |
| **`defaultPath` on a component that is never unmounted** | The Code tab is mounted on its first visit and kept mounted, because unmounting would cut a running scan. `ScanLauncher` takes its target as an INITIAL value and owns the field afterwards — which is what lets someone edit it — so handing it a second repository from a second alert does nothing: the tab opens with a path in the box and it is the previous alert's. Silent, and plausible enough to be believed. Fixed by re-keying on the jump counter (`key={prefill?.n}`), not by an effect writing into the field: a child's effect runs before the provider's, the ordering trap this table already carries twice. The counter is the same device `intelPrefill` uses so that asking the SAME question twice still re-runs it |
| **A rule appended at the end of the stylesheet** | `.soc-panel { padding }` and `.soc-info { position: relative }` were written at the bottom, after the `@media (max-width: 760px)` block. Same specificity, later source order — so both silently **cancelled the mobile overrides**, and the popover positioned itself against a parent it should not have had. A stylesheet with media queries in the middle has no "end": a new rule goes next to the one it modifies, not after everything |
| **Untrusted text that is not a log** | The fence covered the alert — `raw_log`, `rule_name`, `reasoning` — and `get_alert` returned `enrichment` **verbatim** beside it. But Shodan's `hostnames` is the reverse DNS of the attacking address, a PTR record its owner sets; `org` and `isp` are WHOIS on that same address; VirusTotal's `meaningful_name` is the file name whoever submitted the sample chose; and a failed lookup's `reason` is `clip(e.message)`, the provider's own prose forwarded. Third-party text ABOUT a value an attacker chose is attacker-influenced text, and it reached the model through `menater://alert/{id}` as well as the panel. It read as reference data, which is why nobody looked — and `ROADMAP.md` X2 **already asserted enrichment free text was fenced**, so the documentation hid the hole instead of exposing it. Fixed by `fenceEnrichment`, and note the shape of the fix: `UNTRUSTED_ALERT_FIELDS` can be a list of names because an alert has a contract in `domain.ts`, whereas `EnrichmentSource` is `{ status, source, [key: string]: unknown }` — an **open bag**, so a name list would go stale silently the day a mapper gains a field. The rule is inverted there: everything is fenced EXCEPT the two fields whose vocabulary is ours and closed, plus numbers and booleans, which carry no instruction and must stay comparable |
| **A fix applied at the front door and not at the two buttons behind it** | `Engine.responseOf` was added because the entry point answered **202 accepted** for alerts `01-Ingestion` had refused. `webhook.ts` got it. `POST /api/simulate` (Health → inject a test alert) and `POST /api/replay` (Tracking) did not, and kept answering `ok: true, status: 202` for every run they managed to START — which is not the same question as what the pipeline DECIDED. The cost lands on the two scenarios that ship for this exact purpose: `malformed` (“a rejection is a behaviour too, and this is how you see what the sender is told”) showed a green *injected* banner and, forty-five seconds later, *no trace of that alert* — while `rejectionBody` had already written `invalid_severity: expected one of low\|medium\|high\|critical` and it never left the server; and a `same_id` replay, the documented way to test deduplication, reported *Alert replayed* over a pipeline that answered `duplicate, skipped` and replayed nothing. **A fix is not done when the defect is gone from the path you were looking at**: grep for the other callers of the thing you fixed, and note that neither button had a test, because neither has an HTTP sender to disappoint. `server/injection.ts` is the one reading now, and `injection.test.ts` drives the REAL workflows so the assertion is that `respond-400` is reached, not that a fixture maps 400 to `false`. Found the same night: the sentence shown on that failure asked *“Are the workflows published?”* — a question about a publish step that left with n8n |
| **`fetch` fails with a message that says nothing** | The mirror of the `pg` trap above, and it needed its own fix rather than the same one. `pg` fails with an EMPTY message; `fetch` fails with a message that is not empty and is worthless — every transport failure there is rejects with the identical `TypeError: "fetch failed"`, the real cause one level down in `err.cause`. So `describePgError`, which keys on the message being empty, returns it unchanged. Read as `(err as Error).message` — which is what every caller did — a typo in a hostname, a service that is switched off, a firewall and an expired certificate all reach the operator as those two words, on the three screens whose entire job is to name what is wrong: **Health → Test connectivity** (the entry-point check), the **Ingestion tab** (per source, and persisted into the cursor file as `lastError`), and Settings → MCP's test button. Two different faults produced byte-identical strings — measured, in a test that asserts they differ. `describeFetchError` in `http.ts` unwraps the cause, keys on `.code`, and shares `tcpProbe`'s vocabulary so the same refusal is not worded two ways depending on which button was pressed. Two shapes make the code table insufficient on its own and were found by PROBING Node 22, not by reading documentation: an aborted request is a `DOMException` with **no cause at all**, and a blocked port (`:1`) yields `cause.message: "bad port"` with **no code** — falling through to "fetch failed" for it would have rebuilt the defect inside its own fix. It passes an error that already explains itself through untouched, which is what makes it safe on the catches that see more than transport failures |
| **A refusal read as an empty answer** | The other half of the trap above, found while carrying its fix into the engine — and the worse half, because a cause that is MISSING at least looks missing. `makeLlm` never inspected the status: it went straight to `res.json()`, so OpenRouter's 401 on a wrong key, its 402 on an exhausted account and its 429 all left `choices` undefined and fell through to the next check, which threw **"The model answered with no content."** The model had not been asked. That sentence sends an operator to look at the model, the prompt and the schema — everything except the one field that is wrong — on the node the whole triage hangs on, and a wrong key is the likeliest misconfiguration a fresh install has. A refusal carrying no body at all was worse still: `res.json()` threw **`Unexpected end of JSON input`**, naming neither the provider nor the status. The rule is not "check `res.ok`" — the neighbouring `notify` branches already did, and `http` deliberately does not (a non-2xx is data there, routed to its error port). It is that **a fallback sentence must not be reachable from a state it does not describe**: "answered with no content" is true of an empty 200 and of nothing else, so the states that are not that one have to be taken off the path before it. Same family as `clean` requiring a source that ANSWERED |
| **Dropping a reference is not stopping the work it started** | The other half of the `invalidate()` trap above, and it survived that fix for its whole life. `invalidate()` sets `cache = null` and `inFlight = null` — but the disowned rebuild is still running, still holds its own `.then`, and wrote its result into the cache anyway when it landed, stamped `Date.now()`. **Fresh timestamp, pre-write data.** So an approval answered while a background revalidation was in flight left the queue showing that alert as *awaiting approval* for up to the full 15 s TTL, after the operator had been told the approval was sent — and nothing anywhere said so. The telling detail: `.finally` already made the identity check (`inFlight?.promise === promise`) for `inFlight`; the `.then` beside it did not make it for `cache`, which is the half that is READ. The fix is that one comparison. Note what is NOT refused — the caller still receives the snapshot, because they asked before the write and a real read answered them; what is refused is PUBLISHING it to everyone else. And the cost of never publishing a disowned rebuild is bounded by the other half of the cache: concurrent callers still share one walk, so a write storm costs one rebuild per poll cycle, never one per tab. `snapshot.test.ts` pins both halves — the console's central read path had no test at all until then |
| **Naming a destination in an error, when the destination is the credential** | The fix above wraps five calls as `Could not reach ${what}`, and the obvious `what` is the URL that was dialled. For two of the five it is a **secret**: a Slack or Discord webhook URL carries its own authorisation, which is why both platforms call it a secret URL — and a step error is written to `soc_run_step`, replayed in the Tracking tab and printed on the incident card. So the webhook transports are named in words (`Slack`, `Discord`) and the one operator-configured endpoint is quoted by **host alone** (`hostOf`), never its path or its query, since a configured endpoint can carry a token in either. A diagnostic string is an egress path like any other |
| **`await res.json()` puts a JSON parser in charge of the error message** | The last unguarded one, in `makeNotify`'s `slack-bot` branch — the transport whose success is READ from the body. Slack's own API answers JSON even on `ok: false`, so the parse only fails when something ELSE answered: a gateway or proxy in front of Slack, a captive portal, a body-less 5xx. Measured on Node 22, on a synthetic `Response` and over a real socket alike: `Unexpected token '<', "<html><hea"... is not valid JSON`, and `Unexpected end of JSON input` — that second one the exact string `makeLlm` had just been fixed for, one branch over. A sentence about JSON syntax, on the step that posts the approval request, naming neither Slack nor the status nor the fact that a call was made. **The parser is not a diagnostician**: read the body as text, parse it yourself, and let the status speak when the parse fails. And the half nobody commissioned was underneath: because the parse threw FIRST, `if (!body.ok)` had never been reached with `ok` absent, so a captive portal answering **200** would have been reported as `Slack refused: no reason given` — a refusal BY Slack that never happened, sending an operator to check a channel name and a bot scope over a network problem. Same rule as the `llm` fix: a sentence must not be reachable from a state it does not describe, and `Slack refused` describes an `ok: false` envelope and nothing else. **The shape you cast to is a claim, not a fact** — `ok` being a `boolean` is what tells the Slack API's answer from an intermediary's, and it is checked before it is believed |
| **A body that could not be READ, reported as an empty body** | The guard in the row above swallowed the read into `''` — `res.text().catch(() => '')` — and then printed *« (empty body) »*. But `res.text()` rejects **after** the status line is already in: a truncated `content-length`, a chunked body the other end drops mid-answer. Measured on Node 22.22.2 against a real socket that promises 200 bytes and destroys itself: `TypeError: terminated`, cause `other side closed`. So the sentence asserted what Slack's endpoint SENT over an event where nobody ever found out what it sent — and the two faults do not have the same fix: an empty body sends you looking for the intermediary that answered nothing, a cut connection is the network. **This is the defect the guard exists to remove, rebuilt one state further in** — the same shape as the scan report that took green by default when coverage was UNKNOWN. The three states are now distinct: unread names the cause through `describeFetchError`, empty says empty, present is quoted. And the sibling one branch up had no catch at all, so `slack-webhook` surfaced the bare `TypeError: terminated` — **grep for the neighbours of the line you are fixing**, not only for its callers |
| **Normalising the lookup table inside the loop that searches it** | `resolveRepository` compared by `key(id)` — `trim().toLowerCase()` — as it scanned, so the whole service inventory was re-normalised **for every case of every snapshot rebuild**. Nothing is wrong per call; the multiplier is the defect. `withRepositories` resolves one case at a time against the same array, and `null` is the COMMON answer — the function's own header says so — which is exactly the answer that must look at every identifier of every entry before it can be given. Measured at the declared ceilings (200 entries × 20 identifiers, a 500-run window): **111 ms of blocked event loop per rebuild, every 20 s**, against 0.12 ms once the table is read once — and the console API is single-threaded, so that is 111 ms in which no alert webhook is served. The index is memoised on the **array's identity**, and that choice is the whole safety argument rather than a convenience: `sanitizeInventory` builds a NEW array on every load and every save, so a changed table cannot be served from a stale index, and a `WeakMap` lets the previous configuration's index be collected with it. The test counts WORK — how many times an entry's identifiers are read — and not milliseconds: a timing assertion is the flaky kind this project already removed once |
| **A role token used for a job nobody measured it for** | `themes.test.ts` computes five families of WCAG ratios and refuses a palette that fails one. It measures TEXT. The **focus ring** — the only thing a keyboard user navigates by — was drawn in `var(--accent)` by all fifteen rules that draw one, across both halves of the product, and no test looked at it. Measured on the six palettes against the five surfaces a ring can land on plus the border it replaces: the accent falls under the 3:1 floor of WCAG 1.4.11 on **two** of them — `punk` at **1.24:1** against `--line` and 1.61 on `--surface` (a dark red on khaki), `dark` at 2.75:1 against `--line`. And the four console fields that take a ring **delete the browser's own first** (`outline: none`, replaced by a 1 px border swap), so on Punk tabbing into the field where you type the ingestion secret changed nothing anyone could see, with no fallback. The fix is a `--focus` token — a ROLE, like `--accent-fg`, whose value follows the contrast of what is behind it rather than the theme's identity: four themes keep their accent, two take their type colour. Two lessons, and the second is the general one: **the accent is reserved for « something is waiting for a human »** (rule 4 of `styles.css`), so it was never the right colour for a ring on every control — and **a contrast suite that measures text does not measure an interface**. The test now also refuses any `:focus` rule written in `var(--accent)`, because the fifteenth would have been silent too |
| **A role is a promise, and two of the four call sites did not keep it** | `role="tab"` does not DESCRIBE a button, it ANNOUNCES a contract that assistive technology then reads out — *tab 3 of 10*, the arrow keys move between them, and a panel somewhere is what this tab controls. `SectionTabs` declared it on all four screens and implemented none of the three. **The panel: 15 dangling IDREFs.** `SettingsPage` and `TracePanel` render a `SectionPanel` per tab; `IngestionPanel` re-implemented the `hidden` half as three bare `<div hidden={…}>` and `WorkflowPanel` rendered nothing at all, so every `aria-controls` there pointed at an element that does not exist — 9 of them on the Ingestion tab alone, which nests both tablists. **The keyboard: no roving tabindex and no arrow handling anywhere**, so Settings was one stop per tab before the first setting — 9 in the measured mount, ten in the product — and a user who had just been told to press an arrow key pressed it and nothing happened — which does not read as a missing feature, it reads as a broken page. **And the same defect backwards**, found by the probe and not by the brief: Settings pushes its code-analysis TAB only when the caller supplies the section and rendered the PANEL unconditionally, so an empty region was named by a tab that is not in the document. Two shapes, one rule — *a tab and its panel exist together or not at all* — and it has to be asserted in **both directions** or half of it is unchecked. Note what the fix does NOT do: Workflow's six tabs choose which workflow the ONE frame below them describes, so they share a panel (`panelId`) named by the selected tab (`labelledBy`) rather than getting six panels of which five are empty — **inventing content to satisfy a pattern is the same mistake as filling a gap with a default**. Measured with the three screens mounted with data, before and after; an empty Settings page renders no tab list and would have shown none of it |

---

## MENATER console

`dashboard/` — see [dashboard/README.md](dashboard/README.md).

### The merge with VulnPipe

**VulnPipe is no longer a product: it is a feature.** No logo, no landing page,
no internal tabs, no separate settings. The console has ten tabs:

| Tab | Contents |
|---|---|
| Alerts | Triage queue and incident card |
| Code | Run a code analysis and read the report |
| Ingestion | **How alerts get in**, in three sections: the delivery architecture (push / pull / the recommended hybrid), the sources on each transport, and the pipeline as it runs — graph, per-step effect, editable variables. It replaced the tab called *Workflow* |
| Rules | Tuning rules: what is normal here, and what should stop reaching a human |
| Tracking | The **unreduced** view: broken chains, runs attached to no alert, searchable log, replay — in three sub-tabs |
| Metrics | The two shadow-mode rates |
| Health | Connectivity diagnostic, injection of a test alert (nine scenarios) |
| Lookup | Manual threat-intel on one value — IP, domain, URL, hash, email — plus the Pwned Passwords check |
| Guide | Documentation of every feature: seventeen sections in four groups, searchable — the search also reads the glossary |
| Settings | Nine areas in sub-tabs, including credentials, log sources, the **service inventory**, the code-analysis engines and the assistant |

**The Tracking tab shows what the stitching hides.** The queue stitches runs by
`alert_id` to display cases; two failures disappear in that reduction, and both
show **green** everywhere else:

| Detection | Signal |
|---|---|
| `broken` — broken chain | The handoff node ran and passed **zero items**. `handoffState()` distinguishes `empty` (the node ran for nothing) from `absent` (it never ran): `nodeOut` conflated both into `null` |
| `empty_input` — sub-workflow started empty | The trigger ran without receiving anything. That is the signature of `mode: "once"` — 8 historic occurrences on this instance |
| `stalled` | Nothing new for 5 min, **outside an approval wait**: the 30 approval minutes are never counted |
| `no_alert_id` / `no_data` | The run exists and appears in no case |
| `diagnostic_probe` / `foreign_workflow` | **Expected**: listed, never counted. Otherwise the tab blinks after every connectivity test, and a permanent alarm stops being read |

Traceability travels **inside the snapshot**, not on a separate route:
rebuilding cases costs one request per run, and both views read exactly the same
batch. `POST /api/replay` refuses if the original payload is unknown, rather
than replaying a reconstructed alert.

**Merged: the interface.** One application, one origin, one lock, one build. The
**Code** tab mounts `dashboard/src/vulnpipe/` on its first open (via
`React.lazy`), then keeps it mounted — changing tab during a scan does not cut
it.

**Not merged: the engines.** VulnPipe stays a service of its own (`VulnPipe/`,
port 4319); `dashboard/server/vulnpipe.ts` relays `/api/vulnpipe/*` to it.
Bringing the analyser into the console API — which deliberately has no
dependency — would have imported tree-sitter and the LLM SDKs for no gain.

`npm run dev` in `dashboard/` starts the three processes (console API, VulnPipe
service, interface). If the analysis service is absent, the section shows a
**503 with the command to run**, not an `ECONNREFUSED`.

What remains: the two flows do not talk *automatically* yet. A scan creates no
case in the triage queue, and no alert starts a scan on its own.

**What does connect them is the service inventory (J0.3).** `server/inventory.ts`
plus a Settings sub-tab: a table an operator fills in, mapping the hostnames
and addresses their alerts carry to the folder or repository that runs there.
The console resolves it onto every case in `snapshot.ts`, so an incident card
names the code running on the machine it is about, and hands that target to
the Code tab with one click.

Three rules hold it up, and they are the reason it is a table and not a
heuristic:

- **Matching is exact.** A hostname or an address, compared case-insensitively
  after trimming, and nothing else — no CIDR, no suffix rule, no resemblance. A
  guessed repository sends somebody to read the wrong code while an incident is
  open, which is § 8's invented default in the worst possible place.
- **An ambiguity is refused at the door.** One identifier under two entries is
  a question, and the save is refused naming the identifier rather than the
  resolver picking a side. So there is no tie-break to get wrong.
- **It resolves, it never acts.** The jump fills the launcher in. Nothing is
  estimated and nothing is scanned until a human launches it — a scan is spent
  money, started from a string in a settings file.

`repository: null` on a case means *the inventory says nothing about this
machine*, never *this machine runs no code*, and the card prints the first by
showing nothing at all: an install that has not filled the table in must not
carry a line nobody can act on at the top of every incident.

### The in-console assistant

A docked chat panel (`src/components/Assistant.tsx`, `server/assistant/`) that
answers questions about **this** installation — "explain alert 1234 simply",
"why is it still waiting?", "what is left to configure?". It is not a tab: the
question is always about the screen you are already on, so it follows you and
receives a typed page context (`{ tab, alert_id }`) that resolves "this alert"
with nothing typed.

**Its whole security model is that it cannot act.** The tool catalogue
(`server/assistant/tools.ts`) is closed, read-only, and contains seven getters:
queue, one alert, one chain, rules, metrics, health, setup state. There is no
tool that approves, isolates, closes, replays, edits a rule or writes a
setting — the third closed catalogue in this product, and the strictest.

That is not caution for its own sake. An operator asking about an alert is
asking about a log **an attacker composed**; unrestricted LLM access to log
content is measured at an 87% prompt-injection success rate. Three layers, in
order of what actually holds:

| Layer | What it does |
|---|---|
| **No writes in the catalogue** | An injected instruction arrives at a model holding seven getters. This is the one that matters |
| **Fencing** (`assistant/sanitize.ts`) | Untrusted fields travel inside `<untrusted:NONCE>` markers with a **per-request nonce** — a log cannot forge a closing tag for a marker that did not exist when it was written. Nothing is deleted: rewriting evidence is the same mistake as filling a gap with a default |
| **The system prompt** | Declares what a fence means. Advisory, and third for a reason — a prompt is not a boundary |

| Point | Detail |
|---|---|
| **Why not MCP for the panel** | MCP adds JSON-RPC negotiation and a hop (300–800 ms) between code and data that share a process. It is the right protocol for exposing the catalogue OUTSIDE the console, which is what `POST /api/mcp` does — over the same `TOOLS`, so there is no second list to audit |
| **The MCP endpoint is off by default** | `server/assistant/mcp.ts`, Streamable HTTP, no SDK: one endpoint, POST only, one JSON response, no sessions — a conforming subset, since the spec lets a server answer `application/json` and requires 405 on a GET it does not stream. Disabled or tokenless it answers **404**; its bearer token is compared in constant time; `Origin` is validated (DNS rebinding); tools carry `readOnlyHint`; the fencing contract goes in `instructions`, the only place an MCP server can speak to the model on the other side |
| **Four providers, one key each** | OpenRouter, Anthropic, OpenAI, Google — chosen in Settings → Assistant, next to the key it reads. The loop speaks a neutral transcript; `assistant/providers.ts` translates. Only OpenRouter falls back to `OPENROUTER_APIKEY`, because that key IS an OpenRouter key |
| **Changing provider clears the model** | `anthropic/claude-sonnet-4.5` is an OpenRouter name and means nothing to Anthropic. Empty = that provider's default, and the field says which |
| **Anthropic: system prompt is top-level** | In the message list it is rejected or demoted to a user turn — and the whole fencing contract lives in that prompt. Its tool results are USER turns, and consecutive ones must be merged into one |
| **Gemini refuses `additionalProperties`** | Its function declarations take an OpenAPI subset. Stripped for Gemini only — every tool sets it so a model cannot invent a parameter, and dropping it everywhere would weaken the other three |
| **Nothing is persisted** | The whole transcript travels with every turn. Storing threads would create a fourth copy of alert content, outside the audit chain, with no retention policy |
| **The tool trace is shown** | Each answer says what it looked up. An answer an operator cannot check is an answer believed for the wrong reasons |
| **The prompt is two blocks** | Invariant first (argument-free, so byte-identical — it carries the cache breakpoint), nonce and page context after. Anthropic hashes tools → system → messages, so the breakpoint at the end of the stable block caches the tool schemas too |
| **Tools of one turn run in parallel** | Safe *because* the catalogue is read-only and closed: no two calls can affect each other, so execution order cannot change a result. Asserted in the tests, not assumed. Plus a per-request memo keyed on sorted arguments |
| **Tool results are bounded** | `sanitize.ts` caps individual untrusted fields; this caps the whole object. Three full cases push the operator's question out of the window — silently, producing a fluent answer about the wrong thing |
| **Retry: transient only** | 429/5xx/529 with exponential backoff and full jitter, `Retry-After` winning when sent. Never 400 or 401 — just as refused two seconds later, on the operator's clock. Every wait is checked against the request deadline, because the other caps count events and a sleeping request produces none |
| **Three caps, not one** | Steps bound reasoning, tool calls bound the fan-out inside a step, a wall clock bounds the request. When a cap fires the loop makes one more call with `tool_choice: none`, so a capped run still produces a sentence instead of an empty bubble |
| **Class prefix `soc-ai-`** | Checked free before it was written. See the `.vp-scope` / `.soc-sources` / `.soc-field span` traps |

---

### The Ingestion tab

`src/components/IngestionPanel.tsx`, `server/ingest/`, control plane under
`/api/ingestion/`.

**« Workflow » named the machinery, not the question.** On this product the word
already meant three things — the workflow editor it once had, the six sub-workflows, the built-in
engine — so someone looking for *how do my alerts reach this console* had no
reason to click it, and someone who did found a graph rather than an answer. The
graph was not deleted: it is the tab's third section, where « what happens once
an alert arrives » follows « how it arrives ».

| Point | Detail |
|---|---|
| **Two transports, and they fail differently** | Push: one network hop, and you are as reliable as the source's own retry policy — a webhook nobody received is a webhook nobody knows about. Pull: half a polling interval of delay, and nothing is lost to a call that never arrived, because the cursor is still where it was. Neither is better |
| **Hybrid is the default because the costs land on different alerts** | A `critical` contained four minutes late was not contained; a `low` triaged four minutes late is a `low`. So `critical`/`high` (P1/P2) take the webhook and `medium`/`low` (P3/P4) are polled — which also bounds the load, since a burst is read in batches WE size rather than opening a thousand requests at us. It is a policy, not a constant: `push` and `pull` alone are one click each |
| **An unrated alert takes the FAST lane** | Severity did not survive normalization ⇒ treat it as urgent. Quietly parking something that might be a `critical` is the failure this product exists to make impossible |
| **Nothing is ever refused for taking the wrong transport** | A P4 on the webhook is accepted and triaged; the reply carries a `delivery` block saying which transport the policy expected. Dropping a detection over a routing preference is « fill a gap with a default » in its harshest form — it replaces the alert with nothing |
| **The push lane cannot be emptied under hybrid** | Checked inline AND last, so it cannot be slipped past by sending `delivery` and `fastLane` in the convenient order. An empty list sends `critical` down the slow lane and looks valid on the way in |
| **The poller lives OUTSIDE the engine** | The node catalogue is closed at sixteen types and has no `trigger.schedule`. Collection is a transport concern; the closed catalogue is a safety property worth keeping closed. A pulled alert enters `01-Ingestion` at the same line a pushed one does — one pipeline, one set of guardrails, one audit chain |
| **The cursor moves only onto data we DELIVERED** | Not onto data we read, and never after an empty or failed poll. Each poll reaches back past it by an overlap, because a source that timestamps at detection and indexes a second later loses that second forever otherwise — and with **no cursor at all** it looks back `interval + overlap`, so the window between two polls is never left unasked. See the traps table: that pair of rules was a data-loss bug |
| **A poll that placed nothing is a failed poll** | See the traps table. The HTTP call succeeding is not the question |
| **Polls do not pile up** | One in flight per source. A source slower than the interval simply polls less often, which is the honest consequence of being slow — the alternative accumulates requests until the heap gives out |
| **Three bounds, and they measure different things** | `batchSize` bounds what one poll READS; `DELIVERY_CONCURRENCY` (4) bounds what RUNS at once — that one is the smoothing, and it is what push has no equivalent of; `SOURCE_CONCURRENCY` (4) bounds how many sources are dialled together, the `Promise.all`-over-the-window trap this codebase already paid for once. `mapLimit` is shared rather than copied |
| **The response body is capped at 16 MB** | Streamed and counted. See the traps table |
| **Failure backoff, announced** | Doubling per consecutive failure, capped at 30 min, jittered downward, cleared by any answer including an empty one. Skipped sources stay in the results carrying their error and the time of the next attempt; "Poll now" ignores the wait |
| **The outbound credential is a NAME from the closed catalogue** | `isManagedCredential` gates it. Reading an arbitrary environment variable into a header, at an address typed into the same form, is an exfiltration primitive with a save button. The address is `http(s)` only, for the same reason the Lookup tab dials nothing it was handed |
| **No draft, no save bar** | Unlike Settings. Every control here is one decision with a visible consequence, and the lane table on screen must never describe a policy that is not the one running |
| **The lane table quotes HALF the interval** | The average added delay is half a polling interval. Quoting the interval overstates it twofold, and that is the number someone weighs a P1 against |
| **Class prefix `soc-ing-`** | Checked free before it was written. See the `.vp-scope` / `.soc-sources` / `.soc-field span` traps |

The source catalogue moved here from Settings → Ingestion rather than being
copied: the same help printed twice is invisible in the code and obvious on
screen. Settings keeps what it SAVES — the mode, the shared secret, the tunnel.

---

### Chat notifications — Slack and Discord

`server/engine/nodes/io.ts` (`makeNotify`, node type `notify`),
`notify.transport` and `notify.minSeverity` in the pipeline variables,
`SLACK_WEBHOOKURL` and `DISCORD_WEBHOOKURL` in the credential store.

| Point | Detail |
|---|---|
| **Three transports, and they are not interchangeable plumbing** | **`slack-bot`** (`chat.postMessage`) routes per channel, so the four channel settings mean something — but it needs an app, scopes and an install. **`slack-webhook`** and **`discord-webhook`** are one secret URL and nothing else, by far the fastest way to get notifications working; both are locked by the platform to one channel, and each has its own payload and its own way of lying about success. See the traps table |
| **Discord's rate limit is named, not swallowed** | About 5 requests per 2 seconds per webhook, answered with a 429 carrying `retry_after` in SECONDS. The node says *rate-limited* rather than *refused*: telling a 429 from a 500 is what stops somebody debugging a network that is fine |
| **A webhook URL is a credential, not a setting** | Anyone holding it can post into that channel — it carries its own authorisation, which is why both platforms call it a secret URL. Both live in the 0600 store beside the bot token, on the same closed list, and neither comes back out of the server |
| **`slack-bot` is the default** | A new transport setting must not change what an existing install does. An install that never touches it keeps posting exactly as before |
| **The threshold gates alerts, and it has a consequence** | `notify.minSeverity` is the lowest alert severity that reaches your chat; `off` sends nothing. Below it no approval is REQUESTED — and because nobody was asked, the alert is not left waiting: it escalates at once, the card says why, and no action is executed. Fail-safe, and stated on the screen where the choice is made rather than discovered later |
| **The default notifies about everything** | `low`. So does an unreadable value, and so does an alert whose severity did not survive normalization. A knob nobody set must not quietly silence a console |
| **The decision is made in the transform, not in the I/O node** | `buildApprovalRequest` computes `notify` and the reason, the graph branches on it (`notify?` → `below-threshold`), and the case can therefore SAY why nothing was posted. Deciding it inside `makeSlack` would bury a routing decision in a step nobody reads |
| **Slack failing and Slack being skipped are different facts** | A refused post goes to `notify-failed`; a suppressed one to `below-threshold`. Both escalate without waiting, and they say different things — *"we could not ask"* and *"we chose not to ask"* call for different fixes |

---

### The Lookup tab

`src/components/IntelPanel.tsx`, `server/intel/`, `server/routes/intel.ts`.

**The pipeline enriches automatically, but only what an alert happened to
carry.** Everything else — a value out of a mail, a ticket, a colleague's
message, the second address in a log the parser did not map — meant leaving the
console for four browser tabs. This is those four tabs in one pass, answering
in the vocabulary the rest of the console already uses.

| Point | Detail |
|---|---|
| **The endpoint takes a value and a kind, never a URL** | Fourth closed catalogue in this product, closed for the reason the other three are: an operator points this console at attacker-composed text all day, and a route that fetched what it was handed would be a request forgery with a button on it. `intel/providers.ts` decides every address dialled |
| **Classification is the server's, and forceable** | It decides which quota is spent, so the browser proposes and the server re-derives. A forced kind is still VALIDATED: forcing `ipv4` on `hello` yields `unknown`, not four failed calls |
| **Defanging is an input format** | `hxxp://`, `1.2.3[.]4`, `evil(.)com`, `user[at]corp.com`. Refanged before detection, and the result carries **both** forms — silently querying something other than what was pasted is the surprise that costs an investigation |
| **The enrichment pipeline's three states** | `ok` / `skipped` / `unavailable`, same words. A source with no key is *Not asked*: a question nobody put, not a hole in what is known |
| **`clean` requires a source that ANSWERED** | With no key configured every provider skips. Printing "nothing found" over a value nobody looked at is the exact defect the Tracking tab exists to expose, and it is refused here in the same words. The count of sources that answered sits beside the verdict, never below the fold |
| **404 is an answer** | HIBP says "in no breach" with a 404, Shodan and VirusTotal say "never seen it" the same way. A global "non-2xx is a failure" rule — which the enrichment normaliser legitimately has — would hide the single most common, and best, outcome behind the word *unavailable*. Each provider declares its own answering codes |
| **Three engines, not one** | A single VirusTotal detection out of seventy is the industry's most common false positive. It shows as *Worth a look*. Flagging on it would train an operator to ignore the panel, which is worse than not having it |
| **A key-free source is in the catalogue on purpose** | Shodan's InternetDB and Pwned Passwords need nothing. A feature that shows an empty screen until someone signs up for something is a feature nobody comes back to |
| **The password never leaves the browser** | SHA-1 in `crypto.subtle`, the first five characters of the hash relayed by `GET /api/intel/pwned-range/:prefix`, the match made on the page. The route's regex is `[0-9A-Fa-f]{5}` — one that accepted more is one that can be talked into forwarding a whole hash. The guarantee is asserted in `intel-panel.test.tsx`, on the REQUEST, not on the sentence printed above the field |
| **Why relay at all** | A console on an isolated network reaches the Internet through its server or not at all; and `Add-Padding` (800–1000 records, so the response SIZE stops leaking how common the prefix is) is a header a browser implementation would eventually forget |
| **Memory in RAM, and it says its age** | 1 to 12 h per source. A lookup is an answer about a LIVE thing, so a restart clearing it is correct — and persisting it would make a fourth copy of alert-adjacent data outside the audit chain, which is why the assistant persists nothing either. A cached card carries its age; a failure is never remembered |
| **429 is obeyed, not retried** | The suggested `retry-after` becomes a per-provider cooldown, and the card names the wait. HIBP's limit is per KEY across the whole install: retrying into it takes the feature away from every other screen |
| **Everything the operator can fix leaves as a 200** | `lib/api.ts` turns any 401 into "log in again". A provider's 401 forwarded as a status code would send an analyst to the login screen because VirusTotal's key expired. It leaves as a sentence inside the payload |
| **Shodan's key is a QUERY PARAMETER** | The enrichment node sends it as a `key:` header, which that API ignores. Copying the node would have reproduced the mistake |
| **HIBP refuses a request with no `user-agent`** | With a 403 — next to an api-key header, that reads as "your key is wrong", and sends someone to regenerate a key that was always fine |
| **Class prefix `soc-intel-`** | Checked free before it was written. `.soc-field span.soc-intel-label` names the element too: a bare class (0,1,0) does not beat `.soc-field span` (0,1,1), and that trap has come back twice |

**It writes nothing.** No case, no rule, no audit row, nothing on disk; the
session history lives in the browser tab and dies with it. A scan still creates
no case and no alert starts a scan on its own — that is J0, and this tab
deliberately did not invent a second path into the pipeline. What it does do is
the smallest honest version of the two halves talking: **every observable on an
incident card carries a jump that opens the tab with the question already
asked.** J0.3's repository jump is the same move in the other direction, and
it is built on the same rule: it opens a screen with a question filled in, it
answers nothing by itself.

---

### Connecting an MCP client

**Settings → MCP** is a four-step install page, and it is the answer to "how do
I set this up on someone else's machine": turn it on, generate a token, copy the
block for your client, press the test button. Nothing is retyped from
documentation.

| The page's rule | Why |
|---|---|
| **The URL comes from the address you reached the console on** | Not from a README. Install on a colleague's machine and the block says their host, because that is the host their browser used. Same rule as the Ingestion tab |
| **The token is generated here and shown ONCE** | The single exception to "a secret never comes back out", and it is a different act: the rule forbids reading back a *stored* secret, not returning one created by this click. The alternative — asking someone to invent 32 random bytes — produces `menater2024` |
| **Four clients, each in its own form** | Claude Desktop (JSON + the stdio bridge), Claude Code (one command), Cursor, VS Code. Offering one and calling the rest "similar" turns five minutes into an afternoon |
| **The test button runs on the SERVER** | The browser cannot test it: the Origin guard refuses browsers on purpose. The console probes its own endpoint over the loopback socket, through the real auth — a test that checked something easier would be worse than none |

What it exposes: **14 tools, 8 prompts, 9 resources**, all read-only. Prompts
matter more than they look — a client that sees ten tool names sees ten getters
and no reason to use them; `explain-alert`, `assess-danger`, `why-waiting`,
`shift-handover` and `what-to-configure` are the questions this console is built
to answer, offered rather than remembered. Resources (`menater://attention`,
`menater://queue`, `menater://alert/{id}`, `menater://glossary`…) are the same
data *attached* by the person instead of *fetched* by the model.

`explain_term` and `menater://glossary` exist because the Guide is browser code
the server cannot read: without them an external agent asked "what is shadow
mode?" answers from its training, confidently, about a different product.

The manual form, for reference — Claude Desktop speaks stdio, so it reaches an
HTTP endpoint through the `mcp-remote` bridge. In
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "menater": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote@0.8.3",
        "http://localhost:4400/api/mcp",
        "--transport", "http-only",
        "--allow-http",
        "--header", "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer <your token>" }
    }
  }
}
```

| Detail | Why it is written that way |
|---|---|
| **No space around the `:` in the header** | Some clients do not escape spaces inside `args` when they invoke `npx`, and the header arrives mangled. The credential goes in `env` instead. Documented upstream; the env form is safe everywhere, so it is used everywhere |
| **`--transport http-only`** | The console answers JSON and never opens an SSE stream. The default `http-first` strategy would probe for one that is not there |
| **`--allow-http`** | The endpoint is plain HTTP on loopback. Over anything but loopback, put it behind TLS |
| **The version is pinned** | A bridge that silently changes version underneath a security console is a moving part nobody chose to move |
| **Restart Claude Desktop** | The config is read at startup. Nothing appears until it is relaunched |

**The token is the whole access control.** The console publishes its port, so
anyone who can reach it and holds the token can READ the queue, the alerts and
the rules — treat it like the console password. They can change nothing: the
catalogue has no write in it.

---

### Sub-navigation: what splits, and what does not

Settings ran to 620 lines — six stacked blocks, four of them invisible without
scrolling. `components/SectionTabs.tsx` distributes them, and the Tracking tab
follows the same logic. **Three rules decide whether a split helps or hurts:**

| Rule | Why |
|---|---|
| **Nothing hides without leaving a trace** | A counter stays on the CLOSED tab, red if it needs action. Filing a broken chain behind a silent tab would reproduce exactly the defect Tracking exists to expose — a failure that shows green |
| **Content is hidden, not unmounted** | `hidden`, not an unmount: a half-filled field, a search in progress, a scroll position survive a round trip. Unmounting would reset them |
| **You do not split what reads as one piece** | Health and Metrics keep their stacked blocks: their job is to give an overview at a glance, and an overview spread across four tabs is no longer one |
| **The role is a contract, and it is kept** | `role="tab"` promises one stop in the tab order with the arrows choosing inside it, and a panel each tab controls. So: roving tabindex, `ArrowLeft`/`ArrowRight` wrapping at both ends, `Home`/`End`, automatic activation (every panel is already mounted, so walking the bar loads nothing) — and up, down and page keys left to the browser, because the bar is sticky above content that scrolls. Every tab points at a panel that EXISTS, and `panelId` covers the one screen where six tabs share a single region |

Two consequences of splitting Settings, both visible on screen: the draft is
**shared across the sections** (a change made in "Pipeline" saves from
"Console"), so the save bar is **sticky** and carries an "unsaved changes"
indicator. And each sub-tab's subtitle announces the **effect** (applied
immediately / restart required / to copy elsewhere): that was the main information of
the old single page, and losing it in the split would have made the screen worse.

The sub-nav also **scrolls the active tab into view**: the setup checklist sends
you straight to a section, and the bar is horizontally scrollable, so the target
could sit off-frame — the content changed with no tab looking active.

---

### Six themes

`theme/themes.css` — one definition per theme, `data-theme` on `<html>`.

| Theme | Palette |
|---|---|
| `grayed` | Slate and acid green — the historic one, still the default |
| `punk` | Military khaki, red, cream typography |
| `blued` | Electric blue, lime green |
| `attck` | Incandescent orange, signal yellow |
| `acme` | **Light** — cream paper, printer's red |
| `dark` | Near-black grey, application blue |

**This was possible because nothing was hardcoded.** The whole console and the
whole analysis section already went through tokens; only four `rgba()` remained
in the VulnPipe sheet, moved to `color-mix` on `--accent-fg` and `--accent`. A
hardcoded colour is now **immediately wrong**: it will follow none of the six
themes.

| Point | Detail |
|---|---|
| **Every theme redefines the ENTIRE palette** | Inheriting three tokens produces an accident invisible on review — a dark `--faint` left on Acme's cream background. A test refuses any missing token |
| **`--accent-fg` follows the accent, not the background** | It is the text laid ON the accent. A bright yellow accent with a white `--accent-fg` gives a button whose label cannot be read |
| **`--focus` follows what is BEHIND the ring** | Same kind of role, one step further: the focus ring is drawn on five different surfaces and over the border it replaces, so its colour cannot be the theme's identity. It is the accent on four themes and the type colour on the two where the accent measures under 3:1 |
| **No flash** | A script in `index.html` sets `data-theme` BEFORE the first paint. It deliberately duplicates the key and the list (it runs before any module, it can import nothing); a test checks they have not drifted |
| **`color-scheme` follows** | Without it, Acme keeps black scrollbars and dropdowns — the only areas CSS does not paint |
| **No automatic detection** | `prefers-color-scheme` is not consulted: four themes are neither light nor dark but coloured choices |
| **A browser preference, not a server one** | A colour is not a security decision: it does not go through `config.json` |

**Contrast is tooled, not judged by eye.** `theme/themes.test.ts` computes each
theme's WCAG ratios: text on background and on panel (≥ 4.5), text laid on the
accent (≥ 4.5), **risk palette on panels and inside its own pills** (≥ 4.5),
secondary mentions (≥ 3), and the **focus ring** on every surface it can land on
plus the border it replaces (≥ 3, WCAG 1.4.11). That is the test that counts: a
palette transposed straight from a poster gives ravishing, unreadable pastels —
Attck's failure red had fallen to **2.5:1**, on the screen that depends on it
most. It also revealed an original defect: the historic theme's `--faint` was at
2.77:1 on panels. The ring came later and from the other direction — the suite
measured text, so the one colour a keyboard user navigates by was the one nobody
had measured; see the traps table.

### Where the eye lands

Six themes decide the colours; this decides the WEIGHTS. The console had one
visual weight for everything — every panel opened with a mono kicker, an
Archivo Black headline the size of the page title, and a paragraph of
explanation — so a tab whose whole content was "nothing to report" carried
three billboards. When everything shouts, nothing is loud.

| Rule | Detail |
|---|---|
| **Three levels, nothing between them** | The page title (one per screen, in `PageHead`), a section, a block inside a section. `.soc-panel.soc-page-head h2` is (0,2,1) against `.soc-panel h2` (0,1,1): the page title wins by specificity, never by source order |
| **What EXPLAINS folds, what REPORTS does not** | A definition, a method note, a how-to goes behind the circled "i" (`Explain`) or a fold (`Fold`). A state, a count, a failure, an incomplete-intelligence banner, an action awaiting approval stays on screen. Filing a failure behind a silent fold reproduces exactly the defect the Tracking tab exists to expose — a failure that shows green |
| **Nothing is deleted** | Folded text is in the DOM and reachable by keyboard. "One click away" and "erased" look identical on a screenshot and are nothing alike for someone searching |
| **A fold says what is inside** | `hint` carries the size — "412 characters", "5 steps", "two hashes". A fold you must open to know whether it was worth opening saves nothing |
| **An explanation must survive out of context** | It is read alone, without the sentence that used to precede it |
| **Good news gets one line** | `soc-quiet`, with a green check. "No broken chain" as a full panel made a calm screen look busy |
| **Grouping, not amputating** | Ten tabs in four groups separated by a hairline. The cost of ten identical buttons is a DECISION cost; the remedy is categorisation. No group titles and no sub-menu — a second navigation level gives back what the grouping just saved, and "no tab inside a tab" still holds |
| **One primitive, both halves** | `Fold` and `Explain` live in `components/Guidance.tsx` and are imported by the VulnPipe section too. One fold shape and one popover shape in the product — a second implementation under a `vp-` prefix would have been two things to learn and two to keep in step. The stylesheet rule stands unchanged: `vulnpipe/styles.css` still carries no tokens and no globals |
| **A heading level is a size AND an outline** | `UsagePanel` and `LiveActivity` titled themselves `h3` while being siblings of the report. Under a real three-level scale that made them level 3 — and it also mis-stated the document structure to a screen reader. Promote by meaning, not by how big you want the text |
| **Columns merge by QUESTION, and never shrink the facts** | The triage table shows five columns and eight facts: severity sits inside *Alert* (« what is it » and « how bad » are one question), confidence inside *AI decision* (`0.58` means nothing without the verdict it qualifies), dwell under *Received*. A word that leaves the header keeps its definition — via `<Explain term="…" />` on the header and, for a value repeated on every row, a `title` rather than forty `<details>`. The test claims the three VALUES, not the headers: that is what separates a regrouping from a deletion |

**The working file is [CLARITY.md](CLARITY.md).** It carries the same rules with
the method behind them: how to measure a screen, why an empty screen must never
be reviewed empty, which screens no browser sweep can reach, and the checklist
before shipping a screen change. Read it before changing or adding any screen;
[DESIGN.md](DESIGN.md) stays the reference for what things look like.

`readability.test.tsx` asserts the boundary rather than trusting the comments:
the raw log is behind a closed fold, the incomplete-intelligence banner and a
technical incident are not, a metric's value is in the clear and its definition
is not.

### English only

The product was bilingual; it is not any more. The **catalogue machinery was
kept** — a typed catalogue refuses a key added on one side only, and it is what
keeps user-facing strings out of components:

| Catalogue | Covers |
|---|---|
| `dashboard/src/i18n/console.ts` | The whole console, including the Guide |
| `dashboard/src/i18n/dictionary.ts` | Code analysis (inherited) |
| `dashboard/server/i18n.ts` | Diagnostic, chain, sample set, route answers |
| `VulnPipe/src/i18n/messages.ts` | The analysis engine's own messages |

Strings written by the engine — node labels and notes, guardrail messages,
the Slack approval block, the action catalogue — are **not** in a catalogue.
They live where they are produced, and they are English too.

### Mobile

Horizontally scrolling tab bar, triage table folded into cards (`data-label` on
each cell), 44 px touch targets, `16px` fields to avoid iOS auto-zoom.

### Not getting lost

Per-tab header (with a "How does it work?" link that opens the Guide on the
right section), welcome card on the first visit, a "what awaits you" line at the
top of Alerts, glossary tooltips on the hard words, and a **setup checklist** at
the top of Settings naming what is still missing before an alert can be triaged.

**A pipeline identifier is never shown raw.** `shadow_logged`, `needs_human`,
`isolate_host_temporary` go through a catalogue; a value outside it is rendered
as-is rather than invented.

The console **has a database** — that changed with the built-in engine. It
executes no security action: the writes are counted, and each is a deliberate
human act.

**Coupling to know about:** the console reads **exact node names**. Renaming
`Finalize Decision + shadow_mode` in the editor makes it blind. From the
Tracking tab, the four handoff nodes (`Execute 02-Enrichment` → `Execute
05-Audit-Log`) and the five sub-workflow triggers are part of the same contract:
they are how a step that ends in "success" while passing nothing is detected.
The *connectivity diagnostic* (Health tab) checks that contract on every run and
names the missing node — the first reflex after any workflow change.

---

## Roadmap

**One only: [ROADMAP.md](ROADMAP.md).** It covers the SOC pipeline, the code
analysis and the console — a feature is prioritised against all the others, not
against those of its own half.

| Section | Contents |
|---|---|
| § 2 — **J0** | Make the two halves talk. **The priority that outranks the others**: until it is done, the merge is visual |
| § 2 bis — **N** | Polyvalent ingestion: the two-tier contract, normalization, log sources |
| § 2 ter — **R** | Tuning rules: what a team declares normal, and what is refused |
| § 2 quater — **D** | Documentation and English-only |
| § 3 — **C** | Console and experience: what is delivered, what is coming |
| § 4 — **S / V** | The two engines: SOC pipeline, code analysis |
| § 4 bis — **W** | The built-in workflow engine, and the removal of n8n |
| § 5 — **A** | Autonomy under guardrails (A2 never before A1) |
| § 6 — **E** | Scale and integrations |
| § 7 | Known technical debt |
| § 8 | The principles that do not change |
| § 9 | Appendix: the testing defects, fixed, and the QA/stress results |

`VulnPipe/ROADMAP.md` is an **archive**: its history stays readable, it is no
longer maintained.

**Every new feature goes into ROADMAP.md before being coded**, with its
justification and its number. Once delivered it becomes struck through and
ticked in its section — the history of decisions is worth as much as the list.

---

## Docker — the full stack

```bash
cp .env.example .env          # fill in the two passwords
docker compose up -d --build  # → http://localhost:4400
```

Three services: `postgres`, `console` (interface + API + workflow engine),
`vulnpipe`. **Nothing else is required** — no third machine.

| Profile | Command | When |
|---|---|---|
| `tunnel` | `docker compose --profile tunnel up -d` | After setting an ingestion secret |

**The API serves the interface itself** (`server/static.ts`): one image, one
origin, one lock. An nginx alongside would have meant two origins, so a lock
protecting half the application.

| Docker trap | Detail |
|---|---|
| **`tree-sitter` has no `linux-arm64` binary** | On an ARM host, npm compiles from source — and fails against Node 24's **C++20 headers**. VulnPipe is therefore on `node:22-slim` with the compilers confined to the build stage. This is NOT a musl story: moving from Alpine to Debian changes nothing |
| **`:?` in compose is evaluated for ALL services** | Including those whose profile is inactive. A `${TOKEN:?}` on `cloudflared` stopped the default stack from starting |
| **`psql` does not substitute its variables inside a `$$` block** | `:'app_password'` arrived literally at the server. The guard lives in `docker/init-db.sh` |
| **`pg_isready` without `-h`** | During initialisation Postgres listens only on its local socket: the probe answered "ready" before the schema was applied |
| **BuildKit crashes in parallel** | `concurrent map iteration and map write` in the Docker daemon. Build the images one at a time |
| **Docker Hub metadata timeouts** | `load metadata for docker.io/library/node:24-alpine` can fail with `DeadlineExceeded` on a slow network. It is not a code problem; retry the build |

**Containerisation revealed an incomplete schema**: the `n8n_soc` role was
created nowhere (while `05-audit-log.sql` grants it rights), the deduplication
table was declared nowhere in `sql/`, and `soc_metrics_7d()` was called
without existing. Fixed by `sql/01-role-and-dedup.sql` and `sql/20-metrics.sql`.

**The QA pass revealed two more**: no database coordinates reached the console
at all, and `sql/10-engine.sql` — the file holding the engine's own tables —
granted nothing to `n8n_soc`. Both are in the traps table above. `sql/` files
only run on the **first** database start: applying one to an existing stack is a
manual `psql`.

---

## Commands

```bash
# --- Deployment: this is the normal mode ---
cp .env.example .env
docker compose up -d --build     # → http://localhost:4400
docker compose logs -f console   # follow
docker compose down              # stop (volumes survive)
docker compose down -v           # erase EVERYTHING, database included

# --- Development: hot reload ---
cd dashboard && npm install
npm run dev            # console API (4400) + VulnPipe service (4319) + interface (5174)
npm run serve          # console API alone
npm run serve:vulnpipe # code analysis engine alone
                       # (both probe the port: a service already started is not
                       #  a failure, it is noted and reused)
npm run tunnel         # Cloudflare tunnel to the alert entry point
                       # (refuses to start without a shared secret)
npm run typecheck
npm run test           # 953 tests
npm run build

# VulnPipe has its own suite
cd VulnPipe && npm test   # 365 tests
cd VulnPipe && npm run qa # QA + stress pass: 36 checks over 10 areas
```

**After any workflow change:** open the console → Health tab → *Test
connectivity*. The diagnostic checks access, publication, chaining, credentials,
the node contract and the ingestion webhook.

---

## Required configuration

**In Docker there is nothing to configure beyond `.env`.** The database, the
application role, the full schema and the three services set themselves up.
Everything below concerns manual installs only.

## The QA and stress pass, on the real stack

Run against `docker compose up` — Postgres, console, code analysis, and nothing
else. Scripts in the scratchpad; the findings are in the traps table above and
the numbers are reproducible.

| Pass | Result |
|---|---|
| **Functional** | 24 checks, 24 pass: the three ingestion guards, the two-tier contract, Wazuh normalization, deduplication, the full five-stage chain, the fail-safe verdict with no model key, shadow mode, ATT&CK tagging, the connectivity diagnostic, the unreduced trace, and both rates |
| **Stress** | 400 alerts at 50 concurrent — **400/400 accepted, ~134 alerts/s, p95 424 ms**, every chain settled, nothing left `running` |
| **Deduplication race** | 12 simultaneous copies of one `alert_id` → 1 accepted, 11 *already seen*, **zero errors** |
| **Audit chain** | Verified across the whole table: no fork, no altered row, and **zero broken links among the ~500 rows written at 40-way concurrency after the seal fix** |
| **Unit** | 889 tests, typecheck clean |

**Eight defects found and fixed**, three of them serious enough to name here:
the entry point told senders their refused alerts had been accepted; the
deduplication insert was not race-safe and answered 500 under a burst; and the
audit chain's verifier reported broken links on healthy rows because ids were
allocated outside the sealing lock.

**The seal fix is a schema change, and `sql/` only runs on a database's FIRST
start.** An existing stack needs it applied by hand:

```bash
docker compose exec -T postgres psql -U menater -d menater < sql/05-audit-log.sql
```

Rows sealed before it keep their broken links: the table is append-only and
immutable by design, which is the right trade — they cannot be rewritten, and
`soc_audit_verify_chain()` goes on naming them honestly.

---

## Known state

**The 5 blocking defects are fixed and verified in real runs** (see
[ROADMAP.md](ROADMAP.md) § 9). The SQL schema is applied, deduplication works,
the audit hash chain is verified — checked again across 2,644 rows written under
concurrent load, with zero discrepancies.

**What the Docker stack handles by itself**, and used to need manual work:
creating the `n8n_soc` application role and applying the SQL files with their
`GRANT`/`REVOKE`. *(The role keeps that name from the project's history; it is
simply the application's role.)*

**What still needs filling in** — configuration, not defects:
- the model key, in Settings → Credentials or in `.env`. **Without it every
  alert takes the fail-safe verdict**: the pipeline runs, nothing is triaged;
- the enrichment keys, same place;
- a shared secret in Settings → Ingestion **before** opening a tunnel.

The console detects and displays all of it: the **setup checklist** at the top
of Settings, and **Health → Test connectivity**.

**n8n is gone.** The pipeline is the built-in engine, the console reads its own
run journal, and there is no cut-over gate left to satisfy — the thing it
guarded has happened.

---

## Settings page

`dashboard` → **Settings** tab, in sub-tabs. Three effect categories, announced
on the navigation itself:

| Effect | Contents |
|---|---|
| **Immediate** | Access lock, refresh rate, run window, forced demo mode, **pipeline credentials**, code-analysis engines, ingestion |
| **Next execution** | Slack channels, endpoints, TTLs and thresholds. They are pipeline variables read on every run, so a change applies to the next alert with nothing to restart |
| **To copy elsewhere** | Database coordinates (local / Supabase / other), and the ingestion snippets for each source |

**A setup checklist heads the page**: the four things missing before an alert can
be triaged, each with its consequence, gone once they are done.

### Two credential stores, same rule

| Store | Holds | File |
|---|---|---|
| `dashboard/server/credentials.ts` | The **pipeline's** keys: OpenRouter, Slack, Shodan, AbuseIPDB, VirusTotal — plus HIBP, which only the Lookup tab reads | next to `config.json`, 0600 |
| `VulnPipe/src/config/keystore.ts` | The **code analysis** engine keys | `VulnPipe/.vulnpipe/keys.json`, 0600 |

Both hold a **closed list** of variable names — accepting an arbitrary name
would turn the endpoint into a way to inject any environment variable into the
process, `PATH` included. Both take effect **hot**: everything reads
`process.env` at call time, so writing into it is enough.

Precedence for both: **real environment > store > `.env`**. A key set by the
shell, Docker or CI is a deployment decision; the console shows it read-only
with the reason rather than accepting an entry that would never be used —
accepting a value that will never be read is the worse of the two answers.

Settings are written to `dashboard/config.json` (0600 permissions, gitignored).
**Secrets never come back out of the server**: a field shows "set" or "empty",
never the value. Leaving it empty keeps the existing value.

The access lock is a single password (scrypt, 12 h session, 8 attempts then a
5-minute block). **It protects access, it identifies nobody**: the approver's
identity stays self-declared.
