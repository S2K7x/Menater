# MENATER — Unified roadmap

The **single** roadmap for the product: the SOC triage pipeline, the code
vulnerability analysis, and the console that hosts both.

> **Why one roadmap.** There were two, each written when the halves were two
> products. They merged at the same time as the interface: a feature is
> prioritised against ALL the others, not against those of its own half. The
> detailed history stays readable in
> [`VulnPipe/ROADMAP.md`](VulnPipe/ROADMAP.md) — it is no longer maintained.

It is built on the real state of the product — measured, not assumed — and on a
comparison with Cortex XSOAR, Splunk SOAR, Tines, Torq, Swimlane and D3 Smart
SOAR on the SOC side, Semgrep and Snyk on the code side.

---

## 1. Where the product stands

### What exists and works

| Piece | State |
|---|---|
| Six chained, versioned workflows | ✅ shipped |
| Built-in workflow engine, with its own run log | ✅ verified — full chain 01→05 in a real run |
| Ingestion webhook + schema validation | ✅ verified in a real run |
| **Two-tier alert contract** (identity / observables / extensions) | ✅ verified — a real Wazuh alert is accepted |
| **Source normalization**, one mapping table per source | ✅ shipped — `generic` and `wazuh` |
| **Wazuh integrator**, single stdlib-only file | ✅ verified against a stub manager |
| Three-source enrichment, resilient (fail-open) | ✅ verified — all three down, the pipeline carries on |
| LLM decision under deterministic guardrails | ✅ shipped |
| Shadow mode: no real action | ✅ verified in a real run |
| Challenge-and-response human approval | ✅ shipped |
| Append-only audit, hash-chained | ✅ verified — chain intact across 2,644 rows under load |
| **Tuning rules**, with governance and history | ✅ verified — a rule closes an alert, still audited |
| **Pipeline credentials settable from the console** | ✅ shipped — effective with no restart |
| Code analysis: indexing, IDOR detection, arbitration, report | ✅ shipped |
| Cost estimate before spending, two modes (full / incremental) | ✅ shipped |
| Unified console: ten tabs, one origin, one lock | ✅ shipped |
| English-only interface **and server** | ✅ shipped |
| Mobile | ✅ shipped |
| Connectivity diagnostic (30 checks) | ✅ shipped |

### What is still open, and is not a defect

| Subject | State |
|---|---|
| Enrichment keys (Shodan / AbuseIPDB / VirusTotal) | To be filled in — the three sources report `unavailable`, and say so |
| Slack token | Not set: approval requests have nowhere to be posted, and the pipeline says so |
| **Model key** | Not set: **every** alert takes the fail-safe verdict. The pipeline runs; nothing is triaged |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | Only relevant under the `n8n` profile |

> The `GRANT`/`REVOKE` line that used to sit here is gone: the application role
> and the grants **are** applied now — that was one of the blocking defects
> found in QA (see § 2 bis).

The five blocking defects from testing (B1 to B5 + I1) are **fixed and verified
in real runs**; the detail and the evidence are kept in § 9.

---

## 2. The priority that outranks all the others

### J0 — Make the two halves talk

It is the only piece of work that justifies the two products living in the same
application. Until it is done, the merge is visual.

| # | Item | What it changes |
|---|---|---|
| **J0.1** | **A scan creates a case in the queue** — a confirmed critical flaw becomes an alert in the triage queue, with its card, its audit and its human approval | A flaw in the code stops being a report you close; it enters the circuit that gets it handled |
| **J0.2** | **An alert triggers a scan** — an alert whose ATT&CK technique points at a class of flaw (injection, access control) offers to analyse the repository of the service concerned | Bring the incident next to the defect that made it possible, while you have it in front of you |
| ~~**J0.3**~~ ✅ | ~~**Service ↔ repository inventory**~~ — `server/inventory.ts`, a Settings sub-tab, resolved onto every case in `snapshot.ts`. Exact matching only, ambiguity refused at the save, and the incident card names the code running on the machine it is about — with a jump that opens the Code tab on that target | Without it neither link means anything: nothing said which repository runs on `10.12.4.31` |
| **J0.4** | **Unified "what threatens this system" view** — one screen stacking, for one asset, its alerts and its flaws | The question the user actually asks, which neither tab answers alone |

> **Order:** J0.3 before J0.1 and J0.2. Guessing the repository from an IP
> address would be exactly the kind of invented default that § 8 forbids.

### J0.3 ✅ — the table, and the first thing it makes possible

**What it is.** A list an operator fills in: a service name, the hostnames and
addresses their alerts carry for it, and the folder or repository URL that runs
there. Stored in `config.json` under `inventory.entries`, validated by
`normalizeInventory`, and applied to every case — live or sample — in the one
funnel every snapshot passes through.

**Three decisions, and each of them is a refusal.**

| Decision | Why the other answer was worse |
|---|---|
| **Exact matching, nothing else** | No CIDR, no suffix rule, no `web-01` ≈ `web-01.corp.lan`. A guessed repository sends somebody to read the wrong code while an incident is open — § 8's invented default, in the place it costs most |
| **An ambiguity is refused, not resolved** | One identifier under two entries would force the resolver to pick, and "the first one" is a coin toss dressed as an answer. The save is refused naming the identifier, so the store cannot hold a question |
| **It resolves, it never acts** | The card's button fills the launcher in. Nothing is estimated, nothing is scanned, until a human launches it. Starting a scan because an alert arrived would be spending money on a target read out of a settings file |

**What `null` means, and what it must not look like.** A case with no match
means *the inventory says nothing about this machine*, never *this machine runs
no code*. So the card shows nothing at all rather than "not listed": an install
that has not filled the table in would otherwise carry a line nobody can act on
at the top of every incident.

**What it does NOT do, and is honest to say so:**

- **No scan creates a case, and no alert starts a scan.** J0.1 and J0.2 are
  still open. This is their prerequisite plus the smallest honest consumer —
  the same move the Lookup tab made in the other direction.
- **The assistant and the MCP catalogue do not read it.** The field is on
  `AlertCase`, so `get_alert` could expose it in a line; it was left out of
  this pass rather than widening a change that touches the fenced surface.
- **Nothing suggests entries.** The console will not propose a mapping from
  what it has seen — that is the guess the whole design refuses. An inventory
  that fills itself in is a research question, not a feature.
- **No CIDR ranges.** Deliberate for now, and the one extension worth
  considering later: a range is still a declaration, not a resemblance. It
  would need its own ambiguity rule (two overlapping ranges), which is exactly
  what the exact-match version avoids having to solve.

---

## 2 bis. Polyvalent ingestion — N

*Written in English. The rest of this file is still French pending a decision on
a full translation sweep.*

**Why this now outranks everything except J0.** The goal is that anyone can have
an automated SOC in minutes. Today a newcomer gets a working console in three
minutes and an SOC that cannot ingest, cannot decide, and cannot act. Two
measured facts, both reproduced against the running stack:

- A real Wazuh 4.x alert (rule 5710, SSH invalid user) is **rejected outright**:
  `missing_required_fields: alert_id, source_ip, dest_ip, rule_name, severity,
  raw_log` — 6 of the 7 required fields. Only `timestamp` survives.
- On a fresh install with no n8n, **both** `shadow` and `primary` answer
  `HTTP 502 upstream_unreachable`, even though the built-in engine processed the
  alert correctly. `primary` is gated on `compared >= 50` n8n-vs-engine
  comparisons, and with no n8n that count is permanently 0.

So the README promise — *"pas de n8n"* — holds for the console and not for
ingestion. N7 below is what makes it true.

### The standard we adopt

**OCSF vocabulary, not the full class.** OCSF is the vendor-neutral schema for
security findings; ECS was donated to OpenTelemetry and is merging into its
semantic conventions, which makes ECS an observability bet rather than a
security one. We take OCSF's *naming and enums* — `severity_id` 0–6,
`observables`, `finding_info`, `extensions` — as a small subset shaped like
Detection Finding (`class_uid` 2004), and not the literal class: 1.4.0 marks
`cloud` and `osint` as required, which is meaningless for an on-prem SSH alert.
Taking the vocabulary is what makes a future data-lake export trivial without
paying for the whole schema today.

**No new dependency.** The API has exactly one (`pg`) and keeps it. Mappings are
plain TypeScript data and JSON — no YAML parser, no OCSF SDK. A field-alias
table is data, not a library.

### The work

| # | Item | What it changes |
|---|---|---|
| **N1** ✅ | ~~**Two-tier alert contract**~~ — *identity* (`alert_id`, `rule_name`, `severity`, `timestamp`, `raw_log`) is required; *observables* (`source_ip`, `dest_ip`, `user`, `host`, `process`, `file_path`, `url`) may be absent; `source` and `extensions` are added. **The canonical names were kept as they were** — renaming them to `source_event_id`/`time`/`raw` as first drafted would have rippled into the audit table's columns, the console types, both i18n catalogues and the hash chain, for no gain the mapping table does not already give | The single change that unblocks polyvalence. A missing `dest_ip` stops being a 400 and becomes an absent field, which is what § 8 has always demanded |
| **N2** ✅ | ~~**Normalization layer**~~ — one declarative mapping table per source: field aliases, scale conversions, observable extraction, remainder into `extensions` | Adding a source becomes data, not code |
| **N3** ✅ | ~~**Wazuh as the first source**~~ — mapping, plus `integrations/wazuh/custom-menater` and its README — mapping table below, plus the `/var/ossec/integrations/` script shipped in `integrations/` | The user copies a file; they do not author one |
| **N4** ✅ | ~~**Push transport**~~ — `POST /api/ingest/:source`, shared secret unchanged | One endpoint per source instead of one schema for all sources |
| **N5** ✅ | ~~**Pull transport, and the hybrid delivery policy**~~ — `server/ingest/`: a poller with a per-source cursor, an overlap window and idempotent writes (an empty or failed poll does **not** advance the checkpoint), plus the lane policy that decides which severities take which transport. **The recommended default is hybrid**: push for `critical`/`high` (P1/P2), where containment is measured in seconds, and pull for `medium`/`low` (P3/P4), where the point is to smooth the processing load. `push` and `pull` alone stayselectable — an install decides | Sources that expose an API and never call out. The hybrid is the pattern that survives a missed webhook, and it is the one shape where the latency budget matches the alert's actual urgency |
| **N6** | **Severity policy as variables** — the level→severity thresholds live in `soc_variable`, per source, editable from Settings | Wazuh level 8 → `high` is a judgment call, not a constant. Versioned and dated, like every other threshold |
| **N7** ✅ | ~~**Cut-over gate applies only when an n8n is configured**~~ — with no n8n URL, `primary` is the normal mode, not a refused one | Without this, a plug-and-play install can never act on anything |
| **N9** ✅ | ~~**Pipeline credentials in the console**~~ — `server/credentials.ts` + a Settings sub-tab: closed list of five, 0600 store next to `config.json`, precedence *real environment > store > nothing*, locked fields shown read-only with the reason, effective without restart | Was the deepest plug-and-play blocker of all: the model key could only be set by editing `.env` and restarting, and until it was, **every alert took the fail-safe verdict**. An SOC that escalates 100% of its traffic is not automated |
| **N10** ✅ | ~~**Setup generated, not documented**~~ — `GET /api/ingest/sources` plus the source picker in Settings → Ingestion: endpoint, install commands, `ossec.conf` block and mapping table, with the base URL taken from the request | An operator retyping a URL from a README is an operator debugging a typo. Same reasoning as `composeSnippet` |
| **N11** ✅ | ~~**An Ingestion tab, in place of Workflow**~~ — the delivery policy, the source catalogue and the pipeline graph under one destination. « Workflow » named the implementation, not the question: someone looking for « how do alerts get in » had to guess it was behind a word that also means the n8n editor, the six sub-workflows, and the engine. Nothing is deleted — the graph and the pipeline variables become the tab's third section | A tab name is the only navigation help someone gets before clicking. Naming the question rather than the machinery is what the Guide, the Lookup tab and the Tracking tab already do |
| **N8** | **Fingerprint-based dedup** — the dedup key is computed from the normalized alert, not taken from the source's id | Not every source emits a stable id. `soc_ingested_alerts` already does the hard part |

> **Order:** N1 before everything — it is the contract the rest writes against.
> Then N7 (three lines, unblocks acting at all), then N2 → N3, then N4, then N5.
> N6 and N8 ride along with N3 and N2 respectively.
>
> **N5 raises one architectural question that must be settled before it is
> coded:** the node catalogue is deliberately closed at 16 types and has no
> `trigger.schedule`. Polling needs either a 17th type or a poller living
> outside the engine. The proposal is *outside* — collection is a transport
> concern, and the closed catalogue is a safety property worth keeping closed.

### N3 — Wazuh mapping table

Source: `alerts.json`, delivered by the Wazuh integrator
(`<integration>` block in `ossec.conf`, `alert_format: json`).

| MENATER canonical | Tier | Wazuh field | Notes |
|---|---|---|---|
| `source` | identity | *(constant)* | `"wazuh"` |
| `source_event_id` | identity | `id` | e.g. `"1756199642.884231"` |
| `time` | identity | `timestamp` | ISO-8601 with `+0000` offset; parses as-is |
| `rule_name` | identity | `rule.description` | |
| `severity` | identity | `rule.level` | 0–15 → policy, see below |
| `raw` | identity | `full_log` | falls back to `previous_output` when absent |
| `rule_id` | observable | `rule.id` | e.g. `"5710"` |
| `source_ip` | observable | `data.srcip` | |
| `dest_ip` | observable | `data.dstip` | **usually absent** — this is the field that rejects every Wazuh alert today |
| `source_port` | observable | `data.srcport` | |
| `dest_port` | observable | `data.dstport` | |
| `user` | observable | `data.srcuser` ?? `data.dstuser` | |
| `host` | observable | `agent.name` | |
| `host_ip` | observable | `agent.ip` | the agent's own address, **not** a destination |
| `agent_id` | observable | `agent.id` | |
| `file_path` | observable | `syscheck.path` | FIM alerts only |
| `url` | observable | `data.url` | |
| `protocol` | observable | `data.protocol` | |
| `mitre_ids` | observable | `rule.mitre.id` | feeds J0.2 |
| `decoder` | observable | `decoder.name` | |
| `location` | observable | `location` | |
| *(everything else)* | extensions | — | kept intact, never discarded |

Wazuh exposes thirteen predefined dynamic fields under `data.` — `user`,
`srcip`, `dstip`, `srcport`, `dstport`, `protocol`, `action`, `id`, `url`,
`data`, `extra_data`, `status`, `system_name` — and rulesets add their own. The
alias table covers the predefined ones; the rest lands in `extensions` rather
than being dropped.

**Default severity policy** (N6, adjustable per source, never silently applied
without being visible in Settings):

| Wazuh `rule.level` | OCSF `severity_id` | MENATER `severity` |
|---|---|---|
| 0–3 | 2 — Low | `low` |
| 4–7 | 3 — Medium | `medium` |
| 8–11 | 4 — High | `high` |
| 12–15 | 5 — Critical | `critical` |

A level of 0 means Wazuh itself chose not to alert; the integrator's own
`<level>` filter is the right place to drop those, not our pipeline.

### Delivered in this pass

`N1`, `N2`, `N4`, `N7`, and the N3 mapping. 561 tests pass, typecheck clean.

The alert that opened this section — real Wazuh 4.x, rule 5710 — is now
**accepted**: identity mapped from the nested shape, `severity` converted from
`rule.level` 5 to `medium`, `source_ip`/`user`/`host` populated, `dest_ip` left
**null** because an SSH login attempt has no destination, and `location`,
`decoder` and `manager` kept whole in `extensions`.

Two safety consequences of making observables optional, both closed here:

- `isolate_host_temporary` is **downgraded to `escalate` when neither
  `dest_ip` nor `host` is present**. Proposing to quarantine a machine we
  cannot name would have put "isolate `undefined`" in front of a human.
- The alert rebuilt for the n8n comparison now carries that target. It used to
  hold `enrichment_meta` and nothing else, so the new check saw no target on
  **every** case and would have reported a blocking divergence on all of them —
  barring the cut-over for a reason that does not exist.

**The Wazuh side is now copy-paste.** `integrations/wazuh/custom-menater` is a
single stdlib-only Python file: it forwards the alert exactly as Wazuh wrote it
and lets the product do the mapping, because an integrator that maps fields
turns "add a log source" into "maintain a parser on a production security
appliance", unversioned and invisible from the console. Verified against a stub
manager: success, `4xx` refused without retry, `5xx` retried three times over
8 s, and **exit code 0 on every failure path** — a traceback inside the Wazuh
manager's process tree is not an acceptable way to report a problem.

**Settings now renders all of it.** A **setup checklist** heads the page: the
four things still missing before an alert can be triaged, each stating its
CONSEQUENCE rather than its field name — "every alert takes the fail-safe
verdict" is actionable where "OPENROUTER_APIKEY: absent" is not. It disappears
when nothing is left to say, because a permanently lit banner stops being read.
A seventh sub-tab holds the credentials; the Ingestion tab holds a source
picker with the generated endpoint, install commands, `ossec.conf` block and
mapping table.

Four defects found by looking at the rendered screen, none of which a test
would have caught:

| Defect | Cause |
|---|---|
| The REQUIRED/OPTIONAL pill rendered as a full-width bar, indistinguishable from a second input | `.soc-field span` is a descendant selector in `display: block` — the trap already documented in CLAUDE.md. Fixed by prefixing our own class, not by touching the shared rule |
| The sources panel laid itself out in five 257 px columns, shredding the config block | `.soc-sources` was **already taken** by CaseView's enrichment grid, with `repeat(auto-fit, minmax(220px, 1fr))`. Renamed to `.soc-ingest-sources` — the same collision as `.vp-scope` |
| Jumping from the checklist to a section left no tab looking active | The sub-nav scrolls horizontally and the target tab was off-frame. `SectionTabs` now scrolls it into view — guarded, because `scrollIntoView` does not exist under jsdom and threw, taking eleven workflow tests down with it |
| Two Save buttons on the credentials panel, the larger one writing somewhere else | The sticky bar writes `config.json`; credentials go to their own store. It is now hidden on the sections it does not save |

One more trap closed at the point of choice: picking **Observation** on an
install with no n8n now warns that every alert will answer 502, instead of
letting it be discovered in a log.

### N5 and N11 — the hybrid, and the tab that names the question

**Delivered.** `server/ingest/` (policy, cursors, poller, runtime),
`src/components/IngestionPanel.tsx`, control plane under `/api/ingestion/`.
The recommended default is `hybrid`: push for P1/P2, pull for P3/P4. Full
rationale in CLAUDE.md → *The Ingestion tab*.

Four defects found while building it, three of them pre-existing:

| Defect | Where |
|---|---|
| **A poll whose HTTP call succeeded reported as a success** | Mine, found by running it against a console with no database: `deliver` threw on every alert and `pollSource` still answered `error: null` — a green check over a pipeline dropping everything |
| **`/api/ingest/:source` behind the console's access lock** | Pre-existing, since N4. With a console password set, every Wazuh agent got a 401 telling it to sign in |
| **Help text under a field rendered as faint monospace prose** | Pre-existing. `.soc-field span` sets the font and the colour too, and the `.soc-help` fix only neutralised the capitals |
| **`payload.workflows[0].nodes` with no guard** | Pre-existing, harmless until the graph became a section of another tab, where it took the whole tab down |

And the pg error strings were translated: they surface on this new screen, and
`describePgError` is eight strings — cheap enough not to leave French on a tab
someone reads while an ingestion is failing. The rest of § 7 stands.

### N5.1 — the optimisation pass over what N5 had just shipped

Re-reading the transport with fresh eyes, and **running** it rather than
reading it. Seven findings, three of them defects the first pass introduced:

| Finding | Detail |
|---|---|
| **A permanent hole between two polls** | The worst of the pass, and neither rule that caused it looks wrong alone: *an empty poll does not advance the cursor* plus *with no cursor, ask from now* meant the window between two polls was requested by neither, so every alert raised before a source's first delivery was lost — silently, under a green check. The lookback is now `interval + overlap`. **Found in a fixture's request log**, not in the code |
| **A save storm wired to a poll storm** | The form saved on every keystroke and `sync()` polled on every save. Typing `120` into the interval field made three real requests to the source. **Measured on the running console: nine saves were nine polls; they are now one cold start.** Fixed on both sides |
| **Escape did not cancel** | `setDraft(null)` then `blur()` — React had not re-rendered, so `onBlur` sent the abandoned value. A ref, not state |
| **A response body with no size limit** | `res.json()` buffered whatever an address typed into a form chose to send. Now streamed and counted, cap 16 MB, held bytes discarded on refusal. **Verified against a ~30 MB response: refused with a readable sentence, console still up** |
| **Strictly sequential delivery** | `engine.start` awaits the whole pipeline (~16 s an alert), so a batch of a hundred held a source for twenty-six minutes — a "smoothed" transport that stalls. Four at a time, and the cursor takes only the consecutive **prefix** of successes, because concurrency otherwise moves it past an alert that failed |
| **`Promise.all` over every source** | The trap `n8n.ts` already paid for. Bounded at four, and `mapLimit` is now shared rather than copied |
| **No failure backoff** | Doubling per consecutive failure, capped at 30 min, jittered downward so sources that failed together do not return together. Announced on screen, and ignored by the "Poll now" button |
| **`writeFileSync` on a timer** | Synchronous I/O on the event loop for the life of the process. Debounced, asynchronous, no `fsync` (a lost cursor costs one overlap window), unconditional flush on `SIGTERM` |

924 tests, typecheck clean. Verified against a live fixture: save storm, backoff,
body cap, and the timer's cadence.

Still open in N6/N8: severity thresholds as variables, fingerprint dedup.

### Two pre-existing gaps found while doing this

Neither was introduced by N, and neither is fixed by it. Both concern 02:

| Gap | Detail |
|---|---|
| ~~The skip rule is computed and never applied~~ | **WRONG — retracted.** Verified against a real run: `assembleEnriched` applies it in `registry.ts`, and the audit payload carries `"status": "skipped", "reason": "private source address: nothing to look up"` for Shodan and AbuseIPDB, and `"no hash in the raw log"` for VirusTotal (both strings since translated with the rest). I had searched for the producer of `__skipped` and concluded from its absence; the skip is decided one layer up instead |
| Enrichment URLs carry no indicator | `shodan`, `abuseipdb` and `virustotal` are built from `constant(...)` with nothing appended. They query the API root, not the address or hash under triage |

### What N does not do

It does not touch the closed action catalogue, the shadow-mode default, or the
human-in-the-loop rule. A normalized alert enters `01-Ingestion` exactly where a
hand-written one does today, and every guardrail downstream is unchanged.


---

## 2 ter. Tuning rules — R

*Written in English, like § 2 bis.*

**What a team can say about its own normal.** Until now the pipeline had one
idea of what mattered, and no way to be told that the vulnerability scanner is
supposed to trip the port-scan rule every Tuesday. Every SOC needs that, and
every SOC gets it wrong in the same way — so the shape of this feature is
mostly a set of refusals.

### The safety boundary

A rule can only ever **close an alert as known-good, soften or raise its
severity, or force it to a human.** It can never cause an action. There is no
rule outcome that reaches the closed action catalogue, and `closed_by_rule`
routes to 05-Audit-Log, never to 04-Action-Routing. A text field an operator
types into is the last place from which a machine should be cut off the network.

Losing the rules makes the pipeline **noisier, never more permissive**: the
`rules-load` error branch is wired straight into the tuning node, an unreadable
rule set resolves to an empty one, and the alert continues untuned.

### What is refused, and why

| Refusal | Reason |
|---|---|
| A permanent `allow` keyed on **one identity field** (`source_ip`, `user`, `host`, `dest_ip`) | The exclusion that gets abused. Attackers use legitimate addresses and privileged accounts; a blanket allow on either is a hole shaped exactly like a real intrusion. Add a second condition, or use `suppress` with an end date |
| A `suppress` with **no expiry** | Temporary by definition. One with no end is an `allow` that has not admitted what it is. Enforced by the type, the validator AND a `CHECK` constraint |
| A rule with **no owner or no reason** | An exception nobody owns and nobody can justify is security debt: nobody remembers why the pipeline stopped looking, so nobody dares remove it |
| A rule with **no conditions** | It would match every alert. As an `allow` it would silence the whole pipeline |
| A regex over 200 characters | It runs on every alert, and JavaScript cannot interrupt a running regex. Catastrophic backtracking needs no malice, only a nested quantifier |

An **invalid** regex matches *nothing*, never everything — the opposite choice
would silently allow everything the rule names.

An **absent field never matches** (except `not_exists`). Since N1 most
observables are optional, and reading a missing `source_ip` as "not in the
allowlist, therefore suspicious" invents data just as much as reading it as
equal to the empty string.

### Ordering

**First match wins, ordered by priority, ties broken on id.** Some platforms
evaluate every rule as a set; this one does not, because an operator has to be
able to answer *"why was this alert closed?"* with a single rule name. A
set-based engine answers with a combination, and that answer changes when an
unrelated rule is added later.

### Delivered

| # | Item |
|---|---|
| **R1** ✅ | Matcher — 10 operators including CIDR (IPv4 + IPv6, `::` form, bare address as /32), with prototype-walk refused |
| **R2** ✅ | `soc_tuning_rule` + append-only `soc_tuning_rule_history`. A rule can be deleted; the record that it existed cannot |
| **R3** ✅ | CRUD API, plus `POST /api/rules/test` — a dry run answering *which* rule would match, without touching the pipeline |
| **R4** ✅ | Wired into 01-Ingestion after dedup, before enrichment: a known-good alert costs neither three enrichment calls nor a model call, and is still audited |
| **R5** ✅ | 8 templates, all shipped **disabled and unowned**, all written as conjunctions |
| **R6** ✅ | Rules page — list ordered by *what needs attention* (expired, then never-triggered), editor, template picker, dry-run panel |

The bug the integration test caught: a `postgres` node answers `{ rows: [...] }`,
and the junction read one level too high. An unreadable rule set is
indistinguishable from an empty one, so **every rule silently stopped
applying** — green everywhere, and no rule ever firing.

### Also in this pass

- **The language selector moved into Settings.** A choice made once did not
  deserve a permanent seat on every screen next to Refresh. It stays on the
  login screen, where Settings is not reachable.
- **Notices can be acknowledged**, on the Alerts and Health tabs. Acknowledged
  is *not* hidden: they collapse behind a line that still counts them, they are
  keyed **by content** so a reworded finding comes back unread, and it is a
  browser preference — reading a notice is not a decision about the pipeline.

---

## 2 quater. Documentation and English-only — D

### D1 ✅ — The in-app Guide covers the product again

The Guide had nine sections and documented none of the recent work. It now has
twelve. Three are new:

| Section | Why it exists |
|---|---|
| **Getting started: the four things to set** | A fresh install runs in three minutes and triages nothing. Each of the four is a choice the console refuses to make for you, and each is stated with its CONSEQUENCE — "every alert takes the fail-safe verdict" rather than "OPENROUTER_APIKEY: absent" |
| **Connecting a log source** | One endpoint per source, the route decides the mapping, what is required versus optional, why an absent field stays absent, and why severity is a policy rather than a fact |
| **The Rules tab** | The four effects and the boundary they cannot cross; why two conditions are demanded; owner/reason/expiry; first-match-wins; the dry run; the templates |

Three existing sections were **factually wrong** and were corrected:

- `overview` claimed nothing about who runs the pipeline. It now says the
  engine is built into the console and that n8n is optional.
- `limits` still said **"it has no database"**. That stopped being true when the
  engine landed: there is `soc_run`, the audit log, the tuning rules. Replaced
  with the limit that IS still true — no security action starts from the
  screen, and no rule can trigger one.
- `settings` described only the n8n-era categories. It now covers the
  Credentials sub-tab and the generated source setup.

### D2 ✅ — English only

The bilingual catalogue was a feature; it is now one locale. What was removed,
and what was deliberately kept:

| Removed | Kept |
|---|---|
| The FR half of four catalogues — `console.ts` (1269 lines), `dictionary.ts` (656), `server/i18n.ts` (249), `VulnPipe/src/i18n/messages.ts` (229) | **The catalogue machinery itself.** It is what keeps user-facing strings out of components, and that is worth having with one language as much as with two |
| Both language selectors — the header one and the Settings one | |
| The French half of `report-markdown.ts` and `fix-prompt.ts` | |

Then the strings that are **not** in any catalogue, because they are written in
the engine: 52 workflow node labels and notes, the validator and guardrail
messages that land in audit rows, the Slack approval block an operator reads
before approving, the action catalogue's intent / blast radius / rollback plan,
the enrichment skip reasons, and the shadow-comparison divergences.

**Verified in the browser rather than assumed**: all the tabs of the day, with every
Guide accordion expanded, scanned for accented characters. Zero.

**And that sweep had a hole, found in the C0.24 pass.** Nine user-facing French
strings survived it — the report's three verdict counters (`1 à corriger vite`),
its empty state, its `(ligne 12)` and `Analyse` labels, and six column headers
plus a note in the usage panel. They share one property: **none of them can be
rendered without a completed scan**, which needs a model key and real code. A
browser sweep of "all the tabs" never reached them, and neither did the tests —
five of them *asserted on the French*, pinning the defect in place.

Worse, six of the nine had an English entry sitting unused in the catalogue
(`t.usage.stage`, `input`, `output`, `thinking`, `costColumn`, `showDetail`):
the catalogue was right and the component wrote past it. A typed catalogue
refuses a key added on one side only; it cannot refuse a string that never asked
it anything. The lesson is written into the traps table: **a screen you cannot
reach without credentials is a screen no sweep covers** — enumerate those
screens deliberately, or read the components.

### D3 ✅ — The documentation is English, and current again

| File | What changed |
|---|---|
| `README.md` | Rewritten. It now leads with **the four things to set after `up`** and what happens if you skip each, then log sources, tuning rules and the nine test scenarios. The old version described a stack that needed n8n |
| `dashboard/README.md` | Rewritten. The write-routes table gained `/api/credentials`, `/api/rules` and `/api/ingest/:source`; the tab list went from eight to nine; Settings gained its Credentials and Sources sub-tabs |
| `ROADMAP.md` | This file. Sections 1 and 3 carried **stale facts** — "GRANT/REVOKE not applied: the role `n8n_soc` does not exist" was fixed during the QA pass, and "bilingual fr/en" is no longer true |
| `integrations/wazuh/README.md` | Written in English from the start |
| `CLAUDE.md` | Rewritten. The traps table gained the five defects the QA pass found, and the alert contract now has its own section |
| `VulnPipe/CLAUDE.md` | Rewritten. It also now states that VulnPipe is a feature of the console, not a standalone product |
| `.env.example`, `docker-compose.yml` | Comments and the `:?` failure messages |

### What is NOT done, and is honest to say so

**Code comments are still French.** Roughly 148 of 176 source files. They are
not user-facing, and they are the most valuable prose in this repository —
they carry the reasoning, not the mechanics. Machine-translating them would
cost more than it returns. Tracked in § 7.

**`VulnPipe/README.md` is still French** (490 lines), and translating it as-is
would be the wrong move: it describes VulnPipe as a standalone product, which it
stopped being at the merge. It wants a rewrite describing the *engine*, not a
translation — that is a decision, not a mechanical pass.

**The `VulnPipe/` archives are still French** and deliberately left alone:
`ROADMAP.md` (explicitly an archive) and the six `Prompts/PHASE_*.md`. They are
history; rewriting history is how you lose it.
`NIGHTLY_LOG.md` moved to the root: it is memory about live code, not history.

---

## 3. Console and experience

### C0 — Delivered

| # | Feature |
|---|---|
| ~~C0.1~~ ✅ | **Interface merge** — one application, one origin, one lock, one build |
| ~~C0.2~~ ✅ | ~~Bilingual end to end~~ — **superseded by D2: the product is English-only.** The catalogue machinery was kept |
| ~~C0.3~~ ✅ | **Mobile** — scrolling tab bar, table folded into cards, 44 px targets |
| ~~C0.4~~ ✅ | **Per-tab header** — what you are looking at, what it is for, link to the Guide |
| ~~C0.5~~ ✅ | **Guide tab** — documentation of every feature, as an accordion |
| ~~C0.6~~ ✅ | **Glossary tooltip** — the hard word explains itself in place |
| ~~C0.7~~ ✅ | **Welcome card** — three ways in on the first visit |
| ~~C0.8~~ ✅ | **Pipeline vocabulary translated** — `shadow_logged`, `isolate_host_temporary`, `true_positive` are no longer shown raw |
| ~~C0.9~~ ✅ | **Start with no port conflict** — `npm run dev` notes what is already running instead of dying on `EADDRINUSE` |
| ~~C0.10~~ ✅ | **Tracking tab** — the unreduced view: broken chains, runs attached to no alert, log searchable by `alert_id`, replay from the interface. Replaces reading `soc_error_replay_queue` in the database |
| ~~C0.11~~ ✅ | **A new alert rises** — in shadow mode a handled alert ends `closed`, so last in the state sort: it now carries a "new" badge and rises under what blocks a human. A sort selector allows arrival order |
| ~~C0.12~~ ✅ | **The test injection follows its alert** — the console polls to the end of the chain (45 s) instead of one refresh at +3 s, and says "no step in 45 s" if nothing arrives |
| ~~C0.13~~ ✅ | **Two traps caught statically** — `mode: "once"` on an Execute Sub-workflow, and a Switch with no fallback output, checked by the diagnostic on every pass |
| ~~C0.14~~ ✅ | **Slow-refresh warning** — beyond 2 min, Settings says an injected alert will not appear before then |
| ~~C0.15~~ ✅ | **"Live" badge removed** — permanently saying everything is normal occupies the place where the abnormal should show |
| ~~C0.16~~ ✅ | **Loads divided by thirty** — the detail of a finished run is a settled fact: it is cached instead of re-downloaded on every refresh. Plus a shared rebuild across tabs, immediate service of the last known state during revalidation, bounded throughput to n8n, and response compression. Measured on 120 runs: 2.44 s → 0.08 s per refresh, 109 kB → 11 kB over the network |
| ~~C0.17~~ ✅ | **Analysis engine keys settable in Settings** — the page named "GEMINI_API_KEY missing" without letting you fill it in. The key now pastes next to the finding and takes effect hot, with no restart. A key set by the environment stays read-only, with the reason |
| ~~C0.18~~ ✅ | **Sub-navigation for long tabs** — Settings goes from six stacked blocks (620 lines) to sub-tabs, Tracking to three. Sticky save bar with an "unsaved" indicator, alarm counters visible on CLOSED tabs, content hidden rather than unmounted. Health and Metrics keep their stacked blocks: an overview spread across four tabs is no longer an overview |
| ~~C0.19~~ ✅ | **Six themes** — `grayed` (default), `punk`, `blued`, `attck`, `acme` (light), `dark`. One definition per theme in `theme/themes.css`, `data-theme` set before the first paint, a browser preference. Each palette's WCAG contrast is **tested**, not judged by eye: 47 tests, including the risk palette on panels — that is what caught a failure red at 2.5:1 on Attck, and an original defect in the historic theme |
| ~~C0.20~~ ✅ | **Acknowledgeable notices** — on Alerts and Health. Acknowledged is not hidden: they collapse behind a line that still counts them, they are keyed **by content** so a reworded finding comes back unread, and it is a browser preference |
| ~~C0.21~~ ✅ | **Setup checklist** — the four things missing before an alert can be triaged, each stated with its consequence, gone once they are done |
| ~~C0.22~~ ✅ | **Nine test-alert scenarios** — one per PATH rather than per story: no destination, with a hash, malformed, duplicate. A single hard-coded alert only ever proved the wiring |

### C0.23 ✅ — L (Lookup): asking about one value, by hand

*A tenth tab. The pipeline enriches automatically, but only what an alert
happened to carry; everything else meant leaving the console for four browser
tabs. This is those four tabs, in one pass, in the console's own vocabulary.*

| # | Feature | What it changes |
|---|---|---|
| ~~L1~~ ✅ | **One field, six kinds** — IPv4, IPv6, domain, URL, file hash (MD5/SHA-1/SHA-256), email. Classified **on the server**, because the classification decides which quota is spent; forceable, because auto-detection you cannot override is a wall the first time it is wrong | An analyst stops choosing a tool before knowing what they have |
| ~~L2~~ ✅ | **Defanged input is an input format** — `hxxp://`, `1.2.3[.]4`, `evil(.)com`, `user[at]corp.com` refanged before detection, and the result shows BOTH what was typed and what was queried | The form indicators actually arrive in stops being refused |
| ~~L3~~ ✅ | **Seven sources, closed catalogue** — AbuseIPDB, Shodan, Shodan InternetDB (free), VirusTotal, HIBP breaches / stealer logs / pastes. The endpoint takes a value and a kind, **never a URL**: a console pointed at attacker-composed text must not carry a request-forgery button | Adding a source is an edit to `intel/providers.ts`, deliberately |
| ~~L4~~ ✅ | **The enrichment pipeline's three states** — `ok` / `skipped` / `unavailable`, same words, same meaning. A source with no key is *Not asked*, which is not a hole in what is known | One vocabulary across both halves of the product |
| ~~L5~~ ✅ | **`clean` requires a source that answered** — with no keys every provider skips, and the panel says *No answer*, never "nothing found". The count of sources that answered sits beside the verdict, always | The failure this console exists to expose, refused on its newest screen |
| ~~L6~~ ✅ | **Flagged needs more than one engine** — three VT detections, a named threat label, AbuseIPDB ≥ 75 %, a breach that leaked passwords, or an infostealer capture. One detection out of seventy is *Worth a look* | A panel that cried wolf would be a panel nobody reads |
| ~~L7~~ ✅ | **Pwned Passwords, k-anonymity, in the browser** — SHA-1 in `crypto.subtle`, five characters of the hash relayed by the console, the match made on the page. Free, no key, and the guarantee is **tested**, not just written on screen | A password check that is safe to actually use |
| ~~L8~~ ✅ | **It spends your quota, so it remembers** — in memory only (1 to 12 h per source), a cached card **says so with its age**, "Ask again now" bypasses it. A 429 opens a cooldown that is obeyed rather than retried; a failure is never remembered | Re-reading a report does not re-spend a key |
| ~~L9~~ ✅ | **Private addresses are not sent anywhere** — RFC 1918, loopback, link-local: skipped with the reason. Asking a reputation service about `10.0.0.5` gets an answer about somebody else's machine | |
| ~~L10~~ ✅ | **From an alert to a lookup in one click** — every observable on the incident card carries a jump that opens the tab with the question already asked | The smallest version of § 2's "make the two halves talk" |
| ~~L11~~ ✅ | **It writes nothing** — no case, no rule, no audit row, nothing on disk. The session history lives in the browser tab and dies with it | A lookup is a read, and stays one |

**What L does not do.** It creates no case and feeds nothing back into the
queue: that is J0's job, and doing it here would have meant an ad-hoc second
path into the pipeline. It does not run on a schedule, and it does not watch an
address over time.

### C0.24 ✅ — R (Readability): telling the eye where to land

*The console had one visual weight for everything. Every panel opened with a
spaced mono kicker, an Archivo Black headline sized like the page title, and a
paragraph of explanation — so a Tracking tab whose entire content was "nothing
to report" carried three billboards, and the Health tab five. When every
element shouts, none of them is loud: the hierarchy existed in the markup and
nowhere on the retina.*

*Nothing was deleted. What explains moved behind an affordance; what reports
stayed exactly where it was.*

| # | Feature | What it changes |
|---|---|---|
| ~~R1~~ ✅ | **Three type levels, and nothing between them** — the page title (one per screen), a section (small display capitals, the size of a strong label), a block inside a section. `.soc-panel.soc-page-head h2` is (0,2,1) against `.soc-panel h2` (0,1,1), so the page title wins by SPECIFICITY and not by document order, which the next edit would silently change | A screen has one loud thing again, and it is the one worth being loud |
| ~~R2~~ ✅ | **The circled "i"** (`Explain`, `soc-info`) — a section's explanation moves behind a 16 px target beside its title. Native `<details>`: keyboard-openable, Escape-closable, no React state pushed into a forty-row table; the same bubble as the glossary, so there is one popover shape in the product and not two | Progressive disclosure in the strict sense: the sentence is one click away, and out of the scan |
| ~~R3~~ ✅ | **Folds that say what is inside** (`Fold`, `soc-fold`) — the raw log, the two audit hashes and the list of published workflows leave the case card, each announcing its size on the closed summary. A silent fold has to be opened to find out whether it was worth opening, and saves nothing | The incident card lost about a third of its height with no evidence removed |
| ~~R4~~ ✅ | **The line between what explains and what reports** — a state, a count, a failure, an incomplete-intelligence banner, an action awaiting approval **never** fold. Filing a failure behind a silent fold would reproduce the exact defect the Tracking tab exists to expose. The rule is asserted in `readability.test.tsx`, not only written in a comment | The simplification cannot quietly become a lie |
| ~~R5~~ ✅ | **Six metrics, six numbers** — each tile was label / big number / two grey lines saying what the number counts. The definitions moved into the "i", so the six values — the only thing that changes from one day to the next — stop competing with prose that never changes | The screen answers its own question at a glance |
| ~~R6~~ ✅ | **Good news reads as good news** (`soc-quiet`) — "no broken chain, no stalled chain" was a full panel with a headline the size of the page title. It is one quiet line with a green check | The screen looks as calm as what it is reporting |
| ~~R7~~ ✅ | **Ten tabs, four groups** — a hairline separates work / system / tools / reference. No sub-menu and no group titles: the cost of ten identical buttons is a DECISION cost, whose remedy is categorisation, not amputation — and a second navigation level would give back what was just saved. "No tab inside a tab" still holds | Eight tabs can be dismissed in one glance instead of ten comparisons |
| ~~R8~~ ✅ | **The "waiting on you" tile was invisible** — `.soc-statbar li` (0,1,1) beat `.soc-stat-focus` (0,1,0), so the tile kept the panel background and still took `--accent-fg`: **white on cream, 1.05:1**, on the single number that says something is waiting for a human. Found by looking at the screen, not by reading the code | A pre-existing defect, on the most important pixel of the console |

| ~~R9~~ ✅ | **The triage table: five columns for eight facts** — the eight narrow columns did not wrap, so the RULE NAME did, over four lines: 120 px of row height for five useful words, and a severity column that rippled instead of lining up. Severity folded into *Alert*, confidence into *AI decision*, dwell under *Received* — each into the column answering the same question. Nothing removed; `readability.test.tsx` claims the three VALUES rather than their headers, which is the only way to tell a regrouping from a deletion | Rows go from ~120 px to ~70 px, and the severity pills form a column the eye can actually compare |
| ~~R10~~ ✅ | **A definition exists once** — `Explain` accepts a glossary key (`<Explain term="severity" />`), so a word that is no longer written on screen keeps the catalogue's definition instead of a second copy of it. The severity pill also carries it as a `title`: forty openable `Term`s in a table would cost forty `<details>` | The two affordances read the same catalogue |

### The Code tab, same three rules

| # | Feature | What it changes |
|---|---|---|
| ~~R11~~ ✅ | **Seven steps, seven lines** — under the launcher (the one thing anyone comes to this tab for) sat FOURTEEN paragraphs: seven "what this is for" and seven analogies, 1 400 px of text read once in a lifetime. Each step is now a `Fold` carrying "What is this for?" — and during a scan **the running step opens itself**, which is the one moment the explanation earns its place. The tab went from 3 171 px to 2 047 px and fits on one screen | The launcher's red button is the loudest thing on the page again, which is what the page is for |
| ~~R12~~ ✅ | **The same three levels, and the same primitives** — `.vp-embed h2` was `clamp(1.3rem, 2.6vw, 1.9rem)`, so four sections carried page-sized titles under a page title. `Fold` and `Explain` are **imported from the console** rather than re-implemented: one fold shape and one popover shape in the product. Two headings promoted from `h3` to `h2` (usage, live activity) — they are siblings of the report, not blocks inside it, and the level decides both the size and the screen-reader outline | The two halves of the application stop looking like two applications |
| ~~R13~~ ✅ | **Nine French strings, in an English-only product** — the report's verdict counters, its empty state, `(ligne 12)`, `Analyse`, six usage columns and the "thinking" note. Six had an unused English entry already in the catalogue. See § 2 quater for why the D2 sweep missed them, and why five tests were pinning them | The most-read screen of this tab stops being half in French |
| ~~R14~~ ✅ | **A section stopped shouting its own name twice** — the progress panel printed `t.timeline.heading` as its kicker AND as its title: "The main steps", twice, stacked. Same defect as the Alerts tab's double "ALERTS" | |

**What R does not do.** It adds no per-user layout preference; that is C1.5. It
leaves the eight facts of a triage row intact: the table got shorter, not poorer.

### C0.29 ✅ — Re-reading the pass: five defects it had introduced

*A readability pass that adds a shared primitive to nine screens gets to be
audited like anything else. Re-reading it found five things, and the first is
the one that mattered.*

| # | Feature | What it changes |
|---|---|---|
| ~~R37~~ ✅ | **A closed bubble was still in the accessibility tree** — nothing hid the popover of a closed `<details>`: it was placed absolutely, out of flow, invisible **to the eye**, and still in the render tree (`innerText` returned it). So it joined the accessible NAME of whatever contained it. A metric tile was called *"Human disagreementHuman disagreementThe share of decisions put to a human that the human declined…"*. Heading navigation is the first way through a page for someone who cannot see it, and every section had become a paragraph. **One CSS rule** — `:not([open]) .soc-term-bubble { display: none }` — covers both bubbles everywhere they sit: headings, column headers, stat labels. It also fixes `Term`, which predates this pass | Zero headings or `<th>` on any tab now exceed 70 characters |
| ~~R38~~ ✅ | **`Fold` was half-controlled, and closed folds under people's fingers** — `<details open={x}>` in React is re-asserted whenever the value changes, `false` included. The prop was called `defaultOpen` and behaved like a controlled one. Visible symptom: the engines' Status block received `health !== 'online'`, so it opened while the check was running and shut itself a second later. The signal now **opens and never closes**, and the initial value is frozen at mount so React cannot replay it | The fold's state belongs to whoever clicks it |
| ~~R39~~ ✅ | **"Checking" is not "broken"** — that same Status fold treated the undetermined state as a failure. This console distinguishes four diagnostic states precisely so the two are not confused; `=== 'offline'` | |
| ~~R40~~ ✅ | **Green was being given away again** — `soc-quiet` coloured its icon green for both "no broken chain" (good news) and "nothing matches this search" (a null result). The same unearned green C1.4 removed one tab over. Green is now asked for, not inherited | |
| ~~R41~~ ✅ | **One document listener per bubble** — `useBubble` attached its outside-click handler on mount, so every popover on screen (six on Metrics) was called on every click of the page for five of them to find they were closed. The listener now exists only while a bubble is open: at most one | |
| ~~R42~~ ✅ | **A catalogue entry nobody read** — `report.nothingFound` was orphaned when the worked empty state took over. A typed catalogue's whole point is that strings and code stay in step | |

**And one honest correction.** Nine headings were restructured so the disclosure
is the heading's SIBLING rather than its child — flow content inside a heading
is invalid HTML, and that invalidity is what caused R37. Those edits are right
and they stay, but they are **not** what fixed the accessible names: the single
CSS rule did, and it covers the call sites no refactor could reach.

### C0.28 ✅ — Workflow, Rules, Tracking: three screens, four defects

*Two of these tabs were EMPTY on the test install — no database, no n8n — and
an empty screen shows none of its defects. Mounted with data of the right shape
(a throwaway preview page, deleted after), they showed four.*

| # | Feature | What it changes |
|---|---|---|
| ~~R30~~ ✅ | **Fourteen help texts rendered in SPACED CAPITALS** — the pipeline variables. `.soc-field span` is (0,1,1) and dresses every span under a field in small grey capitals; the rule meant to undo it was written as a bare class, (0,1,0), and had never undone anything. Forty lines of capitals on one screen, where capitals read about 10% slower and words lose the outline used to recognise them. **Third occurrence of a trap CLAUDE.md already documents as having come back twice** | Workflow: 3 914 px → 2 188 px |
| ~~R31~~ ✅ | **"Cut-over refused, 9 blocking divergences" — on an install with no n8n** — the comparison exists for one job, migrating off n8n, and § 4 bis says the gate does not apply without one. It was reporting a red refusal for a migration nobody was doing. The route now says whether an n8n is attached, and the block stands down to one sentence. A red light nobody should act on is how a console teaches people to ignore red | 1 210 px of false alarm → 144 px of fact |
| ~~R32~~ ✅ | **The run log showed ERROR and not why** — `note` carries the error code, the orphan list printed it, the log did not. On the screen whose whole job is to answer "why" once every other view has reduced the information away | |
| ~~R33~~ ✅ | **A value outside the catalogue printed "undefined"** — literally, beside a step name. The product's rule is that an unknown pipeline identifier is shown AS-IS rather than invented; "undefined" is neither. The engine can gain a status without the console starting to lie | |
| ~~R34~~ ✅ | **The rule tester folds** — 400 px of permanent 8-row JSON textarea under the rule list, filled when you DOUBT a rule, never when writing one. Its fold says how many **active** rules the alert will be tried against: a bench with no active rule proves nothing, and that shows before opening | |
| ~~R35~~ ✅ | **The replay explanation, once instead of once per chain** — what replay does is stable and repeated identically inside every open chain; it went behind the "i". What the checkbox changes follows the checkbox, so it stayed | |
| ~~R36~~ ✅ | **A French sentence on a blocking divergence** — `shadow.ts` wrote one divergence detail in French, shown under "BLOCKING" on the Workflow tab: the sentence read before refusing a cut-over | See § 7 |

**Tracking needed almost nothing else**, and that is worth recording: its chain
card was already `<details open={broken}>` — healthy folds, broken opens. It is
where the pattern this whole pass generalises was already right.

### C0.27 ✅ — The Lookup tab: it explained itself three times

*2 609 px before anyone could type. The tab said what it does in the page
header, said it again in a paragraph above the field, and said it a third time
in the empty state just below — three formulations of the same thing, stacked
between the person and the field they came to fill.*

| # | Feature | What it changes |
|---|---|---|
| ~~R26~~ ✅ | **Three explanations, two kept** — the tab header (what it does) and the empty state (which question it answers, which is an empty state's job). The middle one, the most mechanical, went behind the circled "i" on the label of the field it describes. Nothing deleted: a test claims it is folded, not gone | The field sits under the header instead of under three paragraphs |
| ~~R27~~ ✅ | **The source catalogue folds, and its fold REPORTS** — seven cards, ~800 px of reference read once while setting keys. The summary does not merely count them: it says **"1 of 7 reachable"**. On an install with no keys that is the most useful sentence on the screen, because it says in advance that every answer will be *not asked* rather than *nothing found* | A fold summary that is worth more than what it hides |
| ~~R28~~ ✅ | **Zero reachable opens the fold** — filing a null coverage behind a silent click would be showing green over a hole, which is precisely what this tab refuses one panel lower (`clean` requires a source that ANSWERED). The rule applies to the screen's own chrome, not only to its verdicts | |
| ~~R29~~ ✅ | **The password guarantee never folds** — the service description went behind the "i"; the sentence saying the password does not leave the browser stays in the clear, above the field. You read a description once; you re-read a guarantee every time you type a password. Asserted | |

2 609 px → **1 400 px**: the whole tab fits on one screen.

### C0.26 ✅ — The Guide: fifteen sections, and no way to search them

*The accordion was already there — folding was not the problem. What a
documentation of fifteen sections and ninety points was missing is the ability
to LOOK something up, and a list of titles you can scan rather than read one by
one. The component's own header still said "eight sections": they were added
one at a time and nobody reopened the list.*

| # | Feature | What it changes |
|---|---|---|
| ~~R20~~ ✅ | **A search across the guide** — titles, ledes and every point, with the term highlighted in `<mark>`. Someone arrives with a WORD, not with a plan: without search they must guess which of fifteen sections holds it, or open them all | The main function of a reference, which it did not have |
| ~~R21~~ ✅ | **It says what it hides** — a filtered section reads "1 of 5 points", never a silent filter. Hiding four points without saying so makes the section look shorter than it is, and you leave with a false idea of what the guide covers. A match on the TITLE keeps every point: the search answered at section level, and trimming there would be arbitrary | The same honesty the rest of the console owes its numbers |
| ~~R22~~ ✅ | **"shadow" returned nothing** — found by using the search, not by reading the code. It is the product's central concept and its default mode, but the guide calls it "watch-only mode": the word appears nowhere. Anyone who read `shadow_mode` in a payload concluded the documentation does not cover it. The search now also reads the GLOSSARY — key, term and definition — and answers with the entry. No hand-written synonym list beside the text, which would drift from it on the first edit: the glossary is already the product's answer to "what does this word mean" | A real question got a real answer |
| ~~R23~~ ✅ | **Fifteen flat titles, four groups** — start here / doing the work / checking the system / around the console. No section disappears, and the group heading does not fold: a third level to open before reading would give back what the grouping saves | |
| ~~R24~~ ✅ | **Each fold says how many points it holds** — the rule applied everywhere else in this pass, and the guide was the last screen without it | |
| ~~R25~~ ✅ | **Numbered in reading order** — the groups reorder the page, so numbering on catalogue order printed "04, 05, 06, 07, 10, 12" inside one group. A number that skips no longer marks a position, it sends you looking for the missing ones. Stable with and without a search | |

`docs-panel.test.tsx` — 11 tests, including that the highlighter splits the
ORIGINAL text: searching "wazuh" must not rewrite "Wazuh" in lowercase in a
document people copy onto a machine.

### C0.25 ✅ — The Settings tab: a setting is not a procedure

*The sub-tabs were delivered in C0.18 and the structure held. What it did not
fix is what sits INSIDE three of them: an installation script, four client
configurations and six stacked settings blocks, all unfolded, all at once.*

Measured before and after, content panels only:

| Sub-tab | Before | After |
|---|---|---|
| Ingestion | 2 576 px | **1 360 px** |
| MCP | 2 513 px | **1 928 px** |
| Engines and preferences | 5 013 px | **2 001 px** |

| # | Feature | What it changes |
|---|---|---|
| ~~R15~~ ✅ | **Three of ten sections did not exist** — at 1280 px the sub-navigation showed seven and scrolled, with nothing saying it scrolled. The engines and the MCP opening were unreachable for anyone who does not think to drag a bar that does not look draggable. A gradient on the overflowing edge, computed from `scrollWidth` and updated on scroll and resize. It costs no height, which a permanent second row would have — on a settings page you come looking for one section, and a section you cannot see does not exist | The most expensive defect of this pass, and invisible from the code |
| ~~R16~~ ✅ | **A procedure is not a setting** — the Wazuh install script, the `ossec.conf` block and the twelve-row field mapping took three quarters of the Ingestion tab. They are followed once, on ANOTHER machine. Folded, each announcing its size ("6 lines", "12 fields"); the endpoint stays in the clear, because that is the one thing you come back for. The tunnel folds too — it is optional, and it opens by itself when a token is already set, because a configured tunnel is a door onto the Internet | The setting is above the fold again |
| ~~R17~~ ✅ | **One MCP client at a time** — four full configurations were rendered at once, so three were always noise, and they pushed step 4 (the button that proves it works) off screen. A picker, and the four keep their complete form. The rule stands: offering one and calling the rest "similar" turns five minutes into an afternoon. The file path shows only for the client that has one — under the other three it sent people to edit a file that does not exist | |
| ~~R18~~ ✅ | **Six settings blocks, six folds** — engines open (what everyone comes for), routing / defaults / display / status closed, each carrying its scope badge on the fold ("applied on the server", "kept in this browser"). **Status opens itself when the engine is unreachable**: a fault filed behind a silent fold, on the page where you set engines, would be a failure showing green | |
| ~~R19~~ ✅ | **The same help was printed twice** — the provider form is rendered once per role, so `modelHint` and `effortHint`, three lines each, appeared twice on the page. Six lines of identical prose separating the four fields you are trying to compare. Behind the circled "i", read from the same catalogue | |

`settings-readability.test.tsx` — 9 tests, including that the bar still renders
without `ResizeObserver` (the edge gradient is a comfort; it must never take ten
sections down to signal three).

### C1.4 ✅ — A worked "no flaw found" state

*An empty report was one line of grey italic, centred. It reads as a failure —
and when it does not read as a failure, it reads as a PROOF, which it is not.
"Nothing found" is only ever true of what was actually read.*

The single sentence covered three situations that are not worth the same:

| Situation | What it is | What was shown before |
|---|---|---|
| Everything was read, nothing found | A result | `Nothing to report on this scan` |
| Some addresses **could not be read** | A partial result, with a hole | The same sentence, covering the hole |
| Only what changed was re-checked | Says nothing about the rest of the project | The same sentence, read as if it did |

The second is the serious one, and it is the failure this whole product is
built around: **a hole that shows green.** It is refused on the Lookup tab in
exactly these words — `clean` requires a source that ANSWERED — and it is
refused here now.

| # | Feature | What it changes |
|---|---|---|
| ~~C1.4a~~ ✅ | **The screen says what was read** — files indexed, addresses found, addresses analysed, and which mode. The data already reached the browser on the run snapshot (`routes_analyzed`, `routes_failed`, `effective_mode`, the estimate's `files_indexed` / `routes_found`); nothing on the server changed, the report simply never asked for it | An emptiness you can size |
| ~~C1.4b~~ ✅ | **Partial coverage changes the TITLE** — not a footnote. "No flaw found in what we could check", plus one caveat per cause naming what it takes away from the sentence above. A reassuring headline is what people keep | |
| ~~C1.4c~~ ✅ | **Three tones, and the green is earned** — green only when coverage is known complete, orange when there is a hole, **grey when coverage is unknown**. The first version of this very screen took green by default on an unknown scan: it reassured about a scan it knew nothing of, reproducing the defect it exists to remove. A test claims the absence of green | Colour is read before words; a green laid over a hole is a lie that costs no reading effort |
| ~~C1.4d~~ ✅ | **An empty report has a reason, and it shows** — "N candidates were found and dropped by the second opinion", with the list behind a fold. Without it, a blank screen reads as "it did not look" | |
| ~~C1.4e~~ ✅ | **Unread addresses are reported on a NON-empty report too** — the finding does not depend on the emptiness: it bounds what the report covers either way | |
| ~~C1.4f~~ ✅ | **Nothing is filled in** — every coverage field is nullable end to end, and a scan that did not report what it covered is not given a plausible number. It says so instead | The product's oldest rule, on the newest screen |

`nothing-found.test.tsx` — 11 tests.



### C1 — Next

| # | Feature | What it changes |
|---|---|---|
| C1.1 | **Tab remembered in the URL** (`#/alerts`, `#/code`) | A shared link opens the right screen; the browser Back button works |
| C1.2 | **Global search** (`/` or `Ctrl+K`) across alerts, settings and guide | Find something without knowing which tab it lives in |
| C1.3 | **Browser notifications** for cases awaiting approval | The 30-minute window stops expiring through inattention |
| C1.5 | **Adjustable density** (compact / comfortable) | Forty rows on a laptop, six on a projector |

---

## 3 bis. The in-console assistant — X

*A chat panel that follows the operator across the console and can answer
questions **about the data actually on screen** — "explain alert 1234 simply",
"what is the danger in this one?", "why is it still waiting?".*

> **Why this is its own section and not a C item.** Everything else in § 3 is a
> screen. This one is a **second consumer of the pipeline's data**, with its own
> credential, its own failure modes, and its own attack surface. Filing it under
> "console and experience" would hide the fact that it introduces a model that
> reads attacker-written text.

### The state of the art, and what it decided

| Finding | Consequence here |
|---|---|
| **Security logs are adversarial input.** `raw_log`, user agents, URIs, attempted usernames are written by the attacker before the defender stores them. Unrestricted LLM access to log content yields **87 % prompt-injection success rates** ([Poisoning the Watchtower](https://arxiv.org/abs/2605.24421)) | The assistant is **read-only, and the tool catalogue is closed.** No tool approves, isolates, closes, replays, edits a rule or writes a setting. An injected instruction reaches a model that has nothing to press |
| The recommended defence is a **quarantine architecture**: the model that reads untrusted content cannot act; the privileged path receives structured summaries | Ours is the degenerate, stronger case: *nothing* is privileged. Untrusted fields are additionally **fenced and labelled as data** in the prompt rather than pasted inline |
| **MCP adds 300–800 ms** of JSON-RPC negotiation and a process or network hop, and every connected tool definition is loaded into the context window ([MCP vs function calling](https://portkey.ai/blog/mcp-vs-function-calling/), [Fast.io](https://fast.io/resources/function-calling-vs-mcp/)) | MCP is **not** the transport for our own chat panel. The console API and the data are in the same process; a hop would buy nothing and cost latency on every turn |
| MCP earns its keep at **10+ tools, several consumers, several models**, as an *integration layer* | So MCP is a **second surface over the same catalogue**, not the first one. It is what lets Claude Desktop, Cursor or an external SOC agent read MENATER — a real feature, deliberately sequenced after the chat works |
| Curated starter prompts beat a blank box: value has to appear in the first session ([UX for AI](https://www.uxforai.com/p/ux-best-practices-copilot-design)) | The panel opens on **suggestions derived from what is on screen**, not on an empty field |
| Context beats phrasing: a copilot answers about *what is currently in scope* ([Microsoft](https://learn.microsoft.com/en-us/microsoft-cloud/dev/copilot/isv/ux-guidance)) | The client sends a small, typed **page context** (tab, selected alert, active filter). The assistant never has to ask "which alert?" when one is open |
| Prior art — Security Copilot in Defender — is exactly *summarise this incident, explain this alert, draft the report*, inside the investigation screen ([Microsoft Learn](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender)) | Confirms the shape. It does not confirm the *scope*: theirs writes queries and takes actions, ours does not |

### The architecture, in one line

**One closed tool catalogue, in-process, called by an agent loop the console
owns — and later re-exported over MCP for consumers outside the console.**

```
Browser panel ──POST /api/assistant/chat──▶ agent loop ──▶ OpenRouter
                                               │
                                               ├─ tool catalogue (read-only)
                                               │    snapshot · cases · trace
                                               │    rules · metrics · health
                                               │    settings state · guide
                                               │
                                    (X8) ──────┴──▶ MCP server, same catalogue
```

The catalogue is defined **once**. The chat loop dispatches it in-process; the
MCP server serialises the same definitions over JSON-RPC. One definition, one
permission model, one test suite — the same discipline as the engine's closed
node catalogue.

### What it refuses to do, and why

| Refusal | Reason |
|---|---|
| **No tool writes anything** | The model reads attacker-written text. A write reachable from that context is a write reachable by the attacker. This is principle 1 of § 8, applied to a new actor |
| **No tool returns a secret** | The catalogue reads through `publicView()` and `describeCredentials()`, which answer "set / not set". A model that has never seen a key cannot leak one |
| **The assistant is off until a key is set** | Not degraded, not silently disabled: the panel says which key is missing and where to set it. Missing configuration cannot enable anything (§ 8.4) |
| **Its key is separate from the triage key** | Same store, different name. The triage model decides whether a machine is isolated; the chat model answers questions. They deserve separate budgets, separate models, and separate blast radius. `ASSISTANT_APIKEY` falls back to `OPENROUTER_APIKEY` only when explicitly left empty |
| **No conversation is persisted server-side** | A thread is a browser session. Storing it would create a fourth copy of alert content, outside the audit chain, with no retention policy |
| **It never invents a field** | Tools return `null` for absent observables and the prompt says so. "The alert has no destination address" is the correct answer; "10.0.0.1" is the § 8.3 failure |
| **It says when it did not look** | An answer built without calling a tool is marked as general knowledge, not as a statement about this installation |

### The work

| # | Item | What it delivers |
|---|---|---|
| **X1** ✅ | **Tool catalogue** — `server/assistant/tools.ts`. Closed list, read-only, typed, each with a JSON-Schema parameter block: `list_alerts`, `get_alert`, `explain_verdict`, `get_trace`, `list_rules`, `test_rule_match`, `get_metrics`, `get_health`, `get_setup_state`, `search_guide` | The data floor. Every answer about this installation comes through here |
| **X2** ✅ | **Untrusted-text fencing** — `server/assistant/sanitize.ts`. `raw_log`, `extensions`, vendor rule names and enrichment free text are truncated, control-stripped and wrapped in a labelled fence the system prompt declares as data | The single defence the literature says actually matters, applied at the one place all untrusted text passes through |
| **X2.1** ✅ | **The enrichment half of X2, actually implemented** — `fenceEnrichment`. The row above claimed enrichment free text was fenced; it was not. `get_alert` returned the three sources verbatim, so Shodan `hostnames`/`org`/`isp`, VirusTotal `meaningful_name`/`popular_threat_label` and a failed lookup's forwarded `reason` reached the model in the clear, through the MCP resource as well as the panel | Third-party prose *about an address an attacker chose* is attacker-influenced text. A claim in this file is what kept it invisible — see the `CLAUDE.md` traps table |
| **X3** ✅ | **Agent loop** — `server/assistant/chat.ts`. OpenRouter tool-calling, bounded: max steps, max tool calls, hard deadline, one final turn with `tool_choice: none` so a run never ends mid-call | Multi-turn reasoning without an unbounded bill or a hung request |
| **X4** ✅ | **Route** — `POST /api/assistant/chat`, behind the same lock as everything else; `GET /api/assistant/state` for readiness and suggestions | One origin, one lock (§ Docker) |
| **X5** ✅ | **Credential + settings sub-tab** — `ASSISTANT_APIKEY` in the managed list, a dedicated **Assistant** section under Settings: key, model, step cap, enable switch, and a "test the assistant" button | The key the user sets, where they expect to set it |
| **X6** ✅ | **The panel** — floating launcher with an unread dot, docked card, streamed answer, visible tool-call trace ("read case 1234"), suggested prompts derived from page context, keyboard `Esc` to close | The screen in the mockup, in the console's own tokens |
| **X7** ✅ | **Page context** — a typed `{ tab, alert_id?, filter?, scan_id? }` sent with every turn, so "explain this alert" needs no identifier | The context-anchoring finding, made structural instead of asking the user to phrase it |
| **X8** ✅ | **MCP server** — `server/assistant/mcp.ts`, Streamable HTTP over the same catalogue, token-gated, **disabled by default** | MENATER readable from Claude Desktop, Cursor, or an external agent. Sequenced last on purpose: it is an export, not the product |
| **X9** ✅ | **The Guide section** — what the assistant can and cannot do, in the operator's words | An assistant whose limits are undocumented gets trusted past them |
| **X12** ✅ | **Optimisation pass** — prompt split for caching, tools of one turn run in parallel, per-request lookup memo, bounded tool results, retry with jitter on transient failures only |
| **X11** ✅ | **Four providers, one key each** — OpenRouter, Anthropic, OpenAI, Google. A neutral transcript in the loop, one adapter per provider in `assistant/providers.ts`, and the provider chosen in Settings next to the key it reads |
| **X10** ✅ | **Tests** — catalogue is read-only (asserted, not assumed), fencing survives a crafted `raw_log`, the loop stops at its caps, no secret in any tool output, no key ⇒ a named refusal | The assertions that keep X1 and X2 true after the next feature |

### Delivered in this pass

X1 through X7 and X10. The console has a working assistant: seven read-only
tools, per-request fencing, a capped agent loop, its own credential and its own
Settings section, and a panel that opens on suggestions drawn from the screen
you are on. 56 new tests (50 server, 6 panel); 694 green in total.

Two findings from doing it, both worth keeping:

- **`get_metrics` in a loop test made the test about n8n.** A test of the agent
  loop that calls a tool reaching the snapshot fails on whether the pipeline
  answers, in a suite that has no pipeline. The loop tests call
  `get_setup_state`, which reads config and credential statuses and nothing else.
- **Two HTTP status codes are poisoned, and only pressing the button showed
  it.** A refused OpenRouter key came back as a 401, which `lib/api.ts` turns
  into `AuthRequiredError` — so a wrong MODEL key displayed *"Authentication
  required."* and pointed at the login screen, while the actual problem sat in
  Settings. Precisely the "sent to the wrong screen" failure this feature was
  built not to commit. 502/503/504 are poisoned the other way: the client
  replaces their body with a generic "the API is not responding", so a
  carefully named message sent as a 502 never arrives. Everything the operator
  can fix now leaves as a **409**, and a test walks the six upstream codes to
  keep it that way.
- **An effect that throws unmounts the panel.** `scrollTo` does not exist on
  jsdom elements, and the failure was not "the test cannot scroll" — it was the
  whole panel disappearing, the same shape as the `React.lazy` trap that
  `SectionBoundary` exists for. Guarded on the method, with `scrollTop` as the
  fallback every environment has.
- **The fence nonce is the whole trick, and it is three lines.** A fixed marker
  is one an attacker writes into a log to close our fence early and continue
  outside it. Generated per request, it cannot be guessed by text that was
  stored before the request existed.

**And X11, added after the first pass on a request that turned out to be
structural.** The assistant was written against OpenRouter, which reaches every
model — but "which provider" is not the same question as "which model", and an
installation that already pays Anthropic, OpenAI or Google directly should not
be made to open an OpenRouter account to use a chat panel.

The loop now speaks its own transcript and each provider translates it both
ways. What that revealed — three rules a provider enforces and the other three
do not, each a 400 on the first request that reads like a bad key:

| Provider | The rule that bites |
|---|---|
| **Anthropic** | The system prompt is a TOP-LEVEL field, not a message. Sent in the list it is rejected or demoted to an ordinary user turn — and the entire fencing contract lives in that prompt. Tool results come back as USER turns, and consecutive ones must be merged into one: two user turns in a row are refused. `max_tokens` is mandatory |
| **Google** | Function declarations take an OpenAPI SUBSET that does not include `additionalProperties` — which all seven of our tools set, deliberately, so a model cannot invent a parameter. Stripped for Gemini only: dropping it everywhere to satisfy one provider would weaken the other three. The model turn is called `model`, the model name goes in the PATH, and function calls carry no id, so the loop synthesises one |
| **OpenAI / OpenRouter** | Identical wire format; they differ only in host, default model and one attribution header |

Two decisions that are not obvious:

- **Changing provider CLEARS the model.** `anthropic/claude-sonnet-4.5` is an
  OpenRouter name and means nothing to Anthropic; carrying it across produces a
  404 that reads like a broken key. Empty means "this provider's default", and
  the field says which one that is.
- **Only OpenRouter falls back to the triage key**, because that key IS an
  OpenRouter key. Generalising the fallback would try an Anthropic key against
  OpenAI and answer with a 401 that looks like a typo.

**Not done, and it is a refusal rather than a gap: signing in with a Claude,
ChatGPT or Gemini subscription.** Those are consumer sign-ins — an OAuth client,
a redirect the console does not have, a refresh loop — and a subscription is not
licensed as server-side API access for a third-party application. Settings says
so in one line rather than leaving someone hunting for the button.

### X9 and X12 — the Guide, and making it actually good

**X9.** A twelfth Guide section, reachable from the panel itself: the two lines
it has room for end in *"How does it work?"*, which opens the Guide **on** that
section rather than at the top of twelve folded ones. Seven points, and the
order is deliberate — what to ask it first, that it reads live data, that it can
do nothing, **why** being powerless is the design and not a limitation, that it
says when it did not look, the key and the provider, what it costs and where it
stops.

**X12.** The optimisation pass, and it found two things that were plainly wrong
rather than merely slow:

| Finding | What it cost |
|---|---|
| **The nonce sat in the middle of the system prompt** | Every provider reuses a prompt PREFIX, and one byte changing before the breakpoint invalidates everything after it. The fence nonce changes on every request BY DESIGN — so the whole prefix, the ~3 kB of tool schemas included, was re-read on every request, once per step of the loop. Invisible: nothing fails, it is a bill. The prompt is now two blocks — invariant first, taking no arguments, with the breakpoint at its end; nonce and page context after |
| **`max_tokens` on GPT-5** | *"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."* The OpenAI provider's default model is a GPT-5, so **every** request through it failed on the first call — with a message that reads like a key problem. OpenRouter still normalises the old name, so the two adapters genuinely differ |

And four changes that are optimisation proper:

- **The tools of one turn run in parallel.** A model routinely asks for three
  lookups at once; in sequence they cost the sum of their latencies for no
  reason. What makes it safe is the catalogue being read-only and closed — no
  two calls can affect each other, so execution order cannot change a result.
  That property is *asserted* in the tests, not assumed in the loop.
- **A per-request memo.** The same lookup asked twice in one run — a model
  re-checking itself — is answered once. Keyed on sorted arguments, because
  `{a,b}` and `{b,a}` are the same call.
- **Tool results are bounded.** `sanitize.ts` capped individual untrusted
  *fields*; nothing capped the whole object. A full case with enrichment
  serialises to tens of kilobytes, and three of them push the operator's actual
  question out of the window — silently, producing a fluent answer about the
  wrong thing. The truncation says so in the payload.
- **Retry on transient failures only**, exponential with full jitter, and
  `Retry-After` wins when the provider sends it — it knows when capacity
  returns, and guessing is strictly worse. 429/5xx/529 retry; 400 and 401 do
  not, because they would be just as refused two seconds later on the
  operator's clock. Every wait is checked against the REQUEST's deadline: the
  loop's other two caps count events, which a sleeping request does not produce.

One robustness fix found while doing it: **Anthropic and Gemini refuse a
transcript that opens on an assistant turn.** A browser replaying a thread that
starts with a greeting would have got a 400 naming neither cause nor fix, so
leading assistant turns are dropped before the request rather than sent.

### X8 — the MCP surface

`POST /api/mcp`, Streamable HTTP, JSON-RPC 2.0, **the same seven tools**. Claude
Desktop, an editor or somebody else's agent can now read this installation
without anyone writing a second API — and there is no second catalogue to audit:
a tool added for the panel appears here, and the read-only assertion that
guards one guards both.

**Written without the SDK, and that was the right call.** `@modelcontextprotocol/sdk`
would have been the second production dependency of an API that deliberately has
one, to buy a transport we need a strict subset of: one endpoint, POST only, one
JSON response per request, no sessions, no server-initiated messages. The spec
permits exactly that shape — a server MAY answer `application/json` instead of
opening an SSE stream, and MUST answer 405 to a GET when it offers no stream — so
the subset is a **conforming server**, not a corner cut.

| Decision | Why |
|---|---|
| **Off by default, and an empty token closes the door** | The ingestion endpoint's rule, applied again. This one publishes a port; "no authentication configured" must never read as "no authentication required". Disabled it answers **404**, not 403 — an endpoint that announces itself to an unauthenticated caller tells them what to come back for |
| **The `Origin` header is validated** | Required by the spec, and the attack is concrete: without it any page the operator visits can use their browser as a DNS-rebinding tunnel into a local MCP server. A real MCP client is not a browser and sends no Origin at all |
| **It is behind its own token, not the console session** | An MCP client has no cookie, exactly as an appliance posting an alert has none. The fifth entry in `PUBLIC_ROUTES`, and "public" is as wrong a word for it there as it is for the webhook: it carries a bearer token compared in constant time |
| **The fencing contract is in `instructions`** | A consumer outside the console never sees our system prompt, so the `<untrusted:…>` markers would arrive as unexplained noise around attacker-written text — worse than not fencing, because it *looks* handled. `instructions` is the one place an MCP server can speak to the model on the other side, and each result names its own single-use nonce |
| **Tools are annotated `readOnlyHint`** | Advisory — the spec says a client must treat annotations from an untrusted server as untrusted — and true here regardless, because the catalogue contains nothing else |
| **Rate limited** | The spec asks for it and is right to: each tool reads the pipeline snapshot, and an agent in a loop is exactly the client that calls them a thousand times without noticing |

Verified against the running container, not just in tests: disabled → 404;
no token → 401; a browser Origin → 403; GET → 405; `initialize` negotiating
2025-06-18; `notifications/initialized` → 202 with a zero-byte body; `tools/list`
returning the seven annotated read-only; `tools/call get_alert` returning the
raw log fenced with a nonce that differs between two calls and is named in the
text block, while our own fields (`verdict`, `confidence`) travel plain; a batch
answering two of three messages, the notification dropped; and
`tools/call isolate_host` refused as an unknown tool, because there is no such
thing to call.

**Left over from doing it:** the console binds `0.0.0.0` in Docker, which it must
— the spec's "bind to localhost when running locally" cannot apply to a
containerised service whose whole job is to be reachable. The token and the
Origin check are what stand in for it, and that is why neither is optional.

### Connected to a real client, and what that found

The endpoint was then driven through the **`mcp-remote` bridge** — the path
Claude Desktop actually takes — which reported *"Connected to remote server
using StreamableHTTPClientTransport"* and pulled all seven tools. A hand-written
server accepted by the reference client library is the only proof that counts;
a passing test of one's own JSON is not.

The bridge invocation is documented in CLAUDE.md, with the four details that do
not guess themselves: the credential in `env` and **no space around the colon**
in the header (some clients do not escape spaces inside `args` when they invoke
`npx`, and the header arrives mangled), `--transport http-only` because the
console never opens a stream, `--allow-http` for loopback, and a **pinned
version** — a bridge that changes underneath a security console is a moving part
nobody chose to move.

**And exporting the catalogue found a defect nothing else would have.**
`window_label` was the French, unaccented string `"executions recentes"` — five
words in a corner of the Metrics tab, unread for months. The moment the
catalogue became something another AI reads aloud, it was the product speaking
the wrong language to a stranger. **Exporting an interface is a review of it**,
and that is worth more than the export.

One honest limit, visible immediately on this installation: `get_trace` answers
*"no execution chain in the current window"* for every demo case, and that is
correct rather than broken — a demonstration alert has no real execution behind
it. On a live pipeline it has one.

### X13 — the features, and making it installable

Two things the first pass left: an endpoint with ten getters and no shape, and
an installation procedure that lived in a README.

**Prompts and resources, because tools alone are not a product.** A client that
lists ten tool names shows ten getters and no reason to use them — the same
blank-box problem the panel solves with suggestions, in a harsher form. Five
prompts (`explain-alert`, `assess-danger`, `why-waiting`, `shift-handover`,
`what-to-configure`) surface as commands the operator picks; six resources
(`menater://attention`, `queue`, `metrics`, `health`, `glossary`, and the
template `menater://alert/{alert_id}`) are the same data *attached by the person*
rather than *fetched by the model*. Argument completion finishes an `alert_id`,
which is not something anyone types correctly from memory.

**Three tools**, shared with the panel because there is one catalogue:
`search_alerts` (free text over the identifier, detection name, host and
addresses — deliberately NOT the raw log, which is the field an attacker
controls, and the result says which fields were searched), `get_attention` (the
first question of any shift, in one call instead of three), and `explain_term`,
backed by a server-side glossary.

That glossary exists because **the Guide is browser code the server cannot
read.** Without it an external agent asked "what does shadow mode mean here?"
answers from its training — confidently, and about a different product's version
of it. The console already refuses to show a raw pipeline identifier on screen;
this is that refusal applied to the export.

**Settings → MCP: four numbered steps.** Turn it on, generate a token, copy the
block for your client, press the test button. The URL is built from the address
you reached the console on; the token is generated here and shown **once**;
there are four client forms (Claude Desktop, Claude Code, Cursor, VS Code); and
the test button runs **on the server**, over the loopback socket, because the
browser cannot test an endpoint whose Origin guard refuses browsers.

Two things this pass found by exercising it rather than reading it:

- **The text block has to stay parseable.** The fence note was prefixed onto the
  serialised result, so `content[0].text` was no longer JSON — while
  `structuredContent` sitting beside it made the reply look correct. The note is
  its own content block now.
- **A duplicate screen is worse than a missing one.** The old MCP block stayed
  under the assistant while the new sub-tab appeared, so the console offered two
  places to configure one thing, and the older one said "seven tools" when there
  were ten. Removed, along with its now-dead catalogue keys.

### X14 — more surface, less weight

The brief was "more tools and features". The research made it a different
problem: **a tool schema is loaded into the context on every request, whether or
not the tool is called.** GitHub's MCP server costs 17,600 tokens of definitions
before an agent does any work, and Anthropic measures MCP metadata at roughly
40% of token usage in some setups. So the honest version of "add more tools" is
*add more tools and make the catalogue cheaper*, and both halves have to be
measured.

Measured, before and after:

| | Tools | Schema | Per tool |
|---|---|---|---|
| Before | 10 | 6,150 B (~1,537 tok) | 615 B |
| After | 14 | 6,915 B (~1,728 tok) | **493 B** |

**+40% tools for +12% schema.** What paid for it: descriptions that say WHEN to
reach for a tool and then stop, instead of also restating what it returns; and
dropping `destructiveHint`, which the spec defines as meaningful only when
`readOnlyHint` is false — bytes spent on every request to say nothing.

**Four tools, all aggregations rather than dumps** — the shape the research
recommends, because computing on the server keeps it out of the context window:

| Tool | The question it answers in one call |
|---|---|
| `find_similar` | "Is this a one-off or a campaign?" Scored, not filtered: a shared host AND rule is a stronger signal than either alone, and a flat filter cannot say so |
| `explain_verdict` | "Why this verdict?" — the raw confidence next to the capped one, which guardrail acted, what intelligence was missing. Reporting only the capped figure hides that a guardrail fired; only the raw one reports something the pipeline never acted on |
| `get_timeline` | "What happened while I was away?" Arrivals, decisions, approvals and failures, ordered |
| `test_rule` | "Why was this closed without a decision?" A dry run over the stored rules, naming expired ones rather than skipping them silently |

Plus three prompts (`triage-alert`, `hunt-related`, `explain-metrics`) and three
resources (`menater://rules`, `timeline`, `setup`) — **8 prompts, 9 resources**.

**And the saving that mattered most was on responses, not schemas.** "Returning
fewer fields" is the highest-leverage optimisation available, so `get_alert`
took a `sections` argument: a narrow read is **62% smaller** (5,275 → 2,007
characters). The default stays *everything* — a caller who does not know what it
needs must not receive a truncated record it believes is complete — and a
narrowed reply says its reading is partial.

### The defect this pass found, which had nothing to do with MCP

A protocol test kept timing out, and the reflex answer was a longer timeout.
Measuring instead: **a cold snapshot took 10.5 seconds in the test environment.**

`getConfig()` falls back to `dashboard/config.json`, which on any machine that
has actually been used holds a real n8n URL and API key — so every
snapshot-backed test went and asked *that* instance for its executions, and
waited for the connection to time out before falling back to the sample set. The
suite's duration, and which tests were flaky, depended on whose laptop it ran on.

`vitest.config.ts` now points `MENATER_CONFIG` at a path that does not exist, so
`getConfig()` returns its defaults — which is also the state a fresh clone is in.
**The suite went from ~10 s of intermittent timeouts to 1.8 s**, and 706 tests
pass deterministically.

A second one, smaller: argument completion read the snapshot with no bound, so a
cold cache would freeze a client mid-keystroke. It races a 1.5 s budget now and
returns nothing if it loses — which a client renders as "no suggestions", the
exact position the operator was already in.

### The section is complete

X1 through X14 are delivered.

### What X does not do

- **It does not act.** Approving, isolating, closing and replaying stay where
  they are: a deliberate human click, counted and audited. The assistant can
  tell you a case is waiting for you; it cannot answer for you.
- **It does not become a second source of truth.** Every number it says comes
  from a tool call against the same snapshot the screen renders.
- **It does not read the code-analysis engine** in this pass. VulnPipe scan
  results join the catalogue after J0 makes the two halves talk — before that,
  there is nothing shared to answer about.

---

---

## 3 ter. The presentation site — P

*`site/` — the page at menater.vercel.app. One source, a build script, no
framework, no dependency. It is the first thing anyone sees of this product,
and until now it was written for someone who already knew what a SOC is.*

**The defect it had.** 3 147 words in the clear, ten numbered sections plus a
table of contents, seven full-width screenshots and four group headings — a
reference manual with a hero on top. Every sentence in it was true and most
were worth keeping; that is exactly what made it unreadable. The measured
comparison, on the vendors this product sits beside: Dropzone and Prophet run
30–100 words per section and put a visual where the mechanism is. Landing
pages written at a 5th-to-7th grade reading level convert at 12.9 %, against
2.1 % for professional prose — a gap attributable to copy simplicity alone.
This page was on the wrong side of it.

**The rule this section adds, and it is the same one the console already
obeys:** *what EXPLAINS folds, what REPORTS does not.* CLARITY.md § 10 wrote
it for the console's screens. The site is a screen. Nothing is deleted —
folded text stays in the DOM, keyboard-reachable and findable by Ctrl-F —
because "one click away" and "erased" look identical on a screenshot and are
nothing alike for someone searching.

| # | Item | Why |
|---|---|---|
| **P1** | ~~**Six sections, not ten plus a map**~~ ✅ | A table of contents for a page you scroll is a second navigation level that gives back what the ordering already bought. The four group headings went with it |
| **P2** | ~~**~1 100 words in the clear, the rest folded**~~ ✅ | The cut is by ROLE, not by length: a claim, a number, a refusal and a consequence stay on screen; a mechanism, a rationale and a table of detail go behind a fold that says how much is inside |
| **P3** | ~~**A drawn pipeline, with the human gate in it**~~ ✅ | The thing this product is is a five-stage flow with a person standing in the middle of it, and the page described that in prose. Built in HTML and CSS rather than SVG so it reflows on a phone, repaints in all six palettes, and can be translated |
| **P4** | ~~**"Code scanning", never "VulnPipe"**~~ ✅ | A second product name on the page makes a reader ask which of the two they are being sold. It is one feature of one console, and the page now says so. The engine keeps its directory name; the *interface* has not called it that since the merge |
| **P5** | ~~**English and French, chosen by the reader**~~ ✅ | See below |
| **P6** | ~~**Three screenshots in the clear, four in a fold**~~ ✅ | Seven full-width captioned figures is seven stops. The four that document a screen rather than making a point are behind one fold that names them |
| **P7** | ~~**Split it: a front page and a `/docs`**~~ ✅ | See below. P1-P6 made one page shorter; this made it a different KIND of page |
| **P8** | ~~**Plain words on the front page**~~ ✅ | No SIEM, no webhook, no polling, no enrichment, no audit chain, no shadow mode. Every one of them is defined in the documentation's own vocabulary section, which exists because the front page had to stop using them |
| **P9** | ~~**A browser check, not an eye**~~ ✅ | `site/check.cjs`: 648 contrast measurements over two pages, two languages and six palettes, plus overflow from 320 px, every anchor, and script errors. It found six real defects on its first run |

### P7 — one page was still the wrong shape

Cutting the page from 3 147 words to 1 406 made it shorter. It did not make it
**readable at a glance**, because the material that was cut had to go somewhere
and "somewhere" was a fold on the same page — which is still a page that says
*there is more here* nine times before you reach the install command.

The measured difference between the two jobs, from the vendors this product
sits beside and from the reading research: 79 % of people **scan** a new page
rather than read it, in an F-shaped path — two horizontal sweeps and then a
vertical one down the left. A page built for that puts the conclusion first
(the inverted pyramid) and gives each line a front-loaded opening, because the
first words of a line are the only ones a scan reliably takes in. A reference
is the opposite: someone arrives already convinced, with a specific question,
and wants a visible shape and a searchable page.

**One page cannot be both.** So:

| | Front page `/` | Documentation `/docs` |
|---|---|---|
| Reader | deciding, in ten seconds, whether this is for them | already decided, has a question |
| Length | **~670 rendered words**, five sections | **~4 800 words**, sixteen sections |
| Vocabulary | plain words only — no jargon, and none introduced | technical, and every term defined in § 16 |
| Shape | scroll it, no folds, nothing hidden | sticky sidebar, groups, anchors, Ctrl-F |
| Ends on | the install command and a link here | what it does not do |

Nothing was deleted: everything the front page dropped is in the documentation,
in more detail than it had before. The two diagrams stay — the front page keeps
the five-step flow with the human gate, and the documentation carries its own
version naming the six workflows.

The rule for what goes where, so the next edit does not drift: **the front page
may not use a word it has to define.** If a sentence needs a definition, the
sentence belongs in the documentation and the front page gets the consequence
instead.

### P9 — what measuring the built pages found

The first run of `check.cjs` failed on six things a review had passed over,
five of them the same root cause: `--faint` is the colour of text you may
skip, it measures 3.2-4.2:1 against a panel, and it was dressing text that
**names** something — the label under a hero number, a table header, the
conditions a figure was taken under, a sidebar group, and the front page's
single most important sentence (*"on a fresh install, step 4 never even
happens"*). The sixth was `--accent` used as TEXT on `--hero`, the darkest
inset: **2.58:1** on the punk palette, on the line telling you which address to
open after installing.

`--faint` is now referenced nowhere and still defined in all six palettes, on
purpose: neither page has any text you may skip, and dropping the token would
make this palette drift from the console's.

### P5 — two languages, and the cheapest correct way to do it

The console is English-only and stays that way (§ 2 quater). The *site* is
not the console: it is read by people deciding whether to look at the console
at all, and the reason it is read in English is that nobody offered anything
else.

Three implementations were on the table, and the choice is the one that adds
no runtime:

| Approach | Why not |
|---|---|
| `data-i18n` + `fetch('fr.json')` at load | The page arrives in English and repaints — a flash of the wrong language on every visit, and a page that is empty to a crawler and to a reader with no JavaScript |
| A framework with an i18n plugin | A build system, a dependency tree and a node_modules for a page with no state |
| **Two static files from one source** ✅ | `build.py` already renders one source into two outputs. Rendering it into four (EN and FR, each in an inlined and a file-ref form) is the same loop with one more variable |

So: `data-i18n="key"` marks a translatable element, the English **stays in the
HTML** where the diff is readable, and `site/i18n/fr.json` holds the French
against the same keys. The build fails on a key present on one side only —
the typed-catalogue rule this product applies to `console.ts`, applied to a
page. `/` is English, `/fr` is French, each carries `hreflang` and its own
`lang` attribute, and the switcher is two links that preserve the anchor you
were reading. No cookie, no header sniffing, no redirect: a URL somebody
shares opens in the language they shared it in.

## 4. The two engines

### S — SOC pipeline

| # | Feature | Inspiration | What it changes |
|---|---|---|---|
| S1.1 | **Case assignment and status** | XSOAR, D3 | Two analysts stop working on the same alert |
| S1.2 | **Investigation notes** (light war room) | XSOAR | Human reasoning joins machine reasoning on the same card |
| S1.3 | **One-click audit chain verification** | — | The "tamper-evident" promise becomes demonstrable |
| S1.4 | **Full history instead of the last 120 runs** | — | Removes the inference about database health |
| S1.5 | **Alert correlation** (IP, hash, sliding window) | all | 40 alerts from one scan become 1 incident |
| ~~S1.6~~ ✅ | **Replay queue** exposed from the console | — | Delivered by C0.10 |
| S1.7 | **Distinct roles** — read / analyst / approver | all | The current lock is a shared password: it identifies nobody |
| S2.1 | **Authenticated approver identity** (OIDC) | — | Lifts the "self-declared identity" limit accepted today |
| S2.2 | **Real ATT&CK mapping**, versioned | Swimlane, D3 | Replaces the heuristic with a defensible reference |
| S2.3 | **Asset criticality** injected into the prompt and the blast radius | XSOAR | Isolating a test machine ≠ isolating the payroll server |
| S2.4 | **Scheduled reports** (volume, MTTR, human disagreement, cost) | Splunk, D3 | Management reads the SOC without opening the console |

### V — Code analysis

| # | Feature | What it changes |
|---|---|---|
| ~~V1.1~~ ✅ | **Scan persistence** — `VulnPipe/src/orchestration/run-store.ts`. One append-only JSONL journal per run: header, events, terminal line. A journal with no terminal line is re-read **`interrupted`**, never "running". Bounded in memory (20), on disk (200 / 90 days). Path-validated run ids | Restarting the service erased the report you were reading — and the two `Map` holding it were **never cleared**, so every scan's events and full report stayed in memory forever. A frank leak, invisible until you run more than a handful of scans |
| V1.2 | **History and comparison between two scans** — new / fixed / still there | Every scan starts from zero today; you never see that you are making progress. It is also what gives incremental mode its point |
| V1.3 | **Progress over time** — open flaws week by week | To wire after V1.2, on real data |
| ~~V1.4~~ ✅ | **Arbitration cache** — delivered in Phase 5, and **completed by V4.2**: it only ever covered the arbiter, i.e. 10-15 % of the calls | Re-running a scan on unchanged code becomes instant and free |
| V2.1 | **New detectors** — SSRF, authentication, cryptography | The pipeline carries one (IDOR); the architecture expects several in parallel |
| V2.2 | **Multi-language** — Python, Go, via new S-expression queries | Indexing engine unchanged; that is the tree-sitter bet |
| V2.3 | **GitHub Action + pre-commit hook** | Results arrive in the tools already in use rather than in a tab to open |
| V2.4 | **Automatic pull-request comment** | The logical follow-on from V2.3 |
| V2.5 | **Server-synced flaw statuses** | They live in the browser: they do not follow from one machine to another |
| V3.1 | **Shadow pipeline** — 5% sampling without the local detector, to measure the false-negative rate | The only way to know what the filter lets through |
| ~~V4.1~~ ✅ | **Bounded parallelism on detection** — `VulnPipe/src/orchestration/pool.ts`, 4 addresses at a time by default, adjustable 1-16 from Settings. The estimate counts *waves*, not a sum of latencies. **Measured end to end on the test repo** (4 addresses, 2 s per call): 8.14 s → 4.15 s → 2.15 s at 1, 2 and 4; flat at 8, there being nothing left to overlap | A scan spent its time waiting on the network one address after another, for calls that have no reason to wait for each other |
| ~~V4.2~~ ✅ | **Detection verdict cache** — `VulnPipe/src/nodes/shared/verdict-cache.ts`, keyed on the prompt word for word (so on the code shown), provider and model included. **Measured**: two scans of the test repo bill 2 calls then 2 without it, 2 then **0** with it | V1.4 covered the arbiter, which sees 10-15 % of the volume. The remaining 85 % — one call per undecided address — was repaid in full on every re-scan |
| ~~V4.3~~ ✅ | **Retry on every provider** — Anthropic, OpenAI-compatible, Ollama and Claude-subscription now do what only Gemini did. Full jitter, the API's own suggested delay as a floor | A transient 429 lost the address for good. And a route that was not analysed is not a healthy route |
| ~~V4.4~~ ✅ | **Cache-shaped prompt** — invariant instructions moved into the system block, the address's code alone left in the user turn. Marking for the provider cache is in place, gated on a length threshold | The longest prefix shared by two calls of a scan was 130 characters: no provider's cache could ever fire. **Measured: it still cannot** — the prefix is 460-660 tokens against a ~1024 minimum. What is acquired is the shape, not yet the saving |
| ~~V4.5~~ ✅ | **What was not billed, said out loud** — "settled without the AI" and "already known" counted and shown separately, in the live view and at the end of detection | A scan that costs less than the last one without saying why reads as a cheaper analysis. And merging the two would credit the deterministic rules with ground they do not cover |
| ~~V4.6~~ ✅ | **Cache persistence** — `VulnPipe/src/shared/persistent-cache.ts`. A file in `.vulnpipe/`, next to the key store, so Docker's existing `/data` volume carries it with no new mount. Atomic write, 0600, format-versioned, 30-day expiry, `DELETE /cache` and a **Forget everything** button | Without it V4.2's saving was fiction: a `docker compose restart` emptied the cache and the next scan paid for everything again — the exact situation the cache existed to end. **The storage decision, left open since Phase 5, is taken here**: a cache is not a source of truth, so no database |
| ~~V4.7~~ ✅ | **QA and stress pass** — `VulnPipe/scripts/qa-stress.ts`, `npm run qa`. 36 checks over 10 areas: malformed input, path traversal, load, concurrency, restart, corruption, retention, resources, unbounded growth, SSE hygiene. **Eight real defects found and fixed**, listed in § 9 | The unit suite checks rules on functions. It cannot see what only shows at scale or over time — a map that is never emptied, a body with no size limit, a recovery that is not idempotent |
| ~~V0.1~~ ✅ | **Engine key store** — `VulnPipe/src/config/keystore.ts`, closed list, 0600 write, applied to `process.env` so it takes effect with no restart. Precedence: real environment > store > `.env` | Setting a key no longer means editing a file and restarting the service |

---

## 4 bis. Leaving n8n — the built-in workflow engine

### W-final ✅ — n8n is removed

**Delivered.** The migration this section existed for is over, and the section
below is kept as the record of how it was done rather than as work outstanding.

What it took, and it was not a deletion:

| Piece | Detail |
|---|---|
| **`server/engine/cases.ts`** | The console's queue, metrics and Tracking tab were built by walking an n8n execution list. The built-in engine wrote every run to `soc_run` and **nothing ever read them back** — a console on its own engine showed an empty queue. This file stitches runs into cases and builds the unreduced trace in one pass, from one read |
| **`recentRuns` / `stepsOfMany`** | The store had no "list recent runs": the journal was write-only. `stepsOfMany` is one query for a hundred runs rather than a round trip each |
| **`server/diagnostics.ts`, rewritten** | It checked an n8n: API reachable, workflows published, nodes renamed, credentials attached. All of those questions vanished with n8n. It now checks what decides whether an alert is triaged here: database and schema, the model key, the node contract, the run journal, and a real probe of the entry point |
| **Approvals and replay** | Both relayed to n8n over HTTP — the approval to a French-labelled form, the replay to n8n's webhook. Both now call the engine directly. Replay through our own HTTP would have needed the ingestion secret, so a console with a closed entry point could not have replayed its own broken chain |
| **The `shadow` webhook mode** | Deleted. It relayed to n8n and returned ITS answer, which meant a `shadow` install with no n8n answered 502 for every alert the engine had handled correctly. Two modes remain: `off` and `on` |
| **`health.n8n` → `health.engine`** | The console's health used to be a report about somebody else's server |
| **Docker, `.env`, `N8N/`** | The `n8n` profile, its service, its volume, its variables and the workflow JSON directory are gone. Three services remain |

Two defects found on the way out:

- **`tagAttack` lived in `n8n.ts`**, so ATT&CK tagging would have disappeared
  with the file. It is now `server/engine/attack.ts`, where it belonged — the
  tagging was never about n8n. Pre-existing, in the sense that it was filed
  under the wrong concern from the start.
- **`pg` returns `bigint` as a string.** Read with `typeof === 'number'`, the
  audit row id became `null` and the Health tab announced *"38 cases with no
  committed audit row"* over a database whose hash chain was intact. **A false
  red costs more than no red at all.** Found by running against the real Docker
  database — no hand-written fixture would have made the id a string.

### W-final bis ✅ — the words followed, eighteen months late

**Delivered, September 2026.** The code left with W-final; four surfaces went on
saying otherwise, and every one of them read as working software.

| What said it | What it claimed | What is true |
|---|---|---|
| **Health → Pipeline state** | An engine card titled `n8n` — a hardcoded literal, the only user-facing string on that screen outside the catalogue, so the typed catalogue could not refuse it: it was never asked anything | `Built-in engine`, from `health.engineTitle` |
| **Settings → Pipeline behaviour** | *"The console cannot apply these values itself… copy the block into your docker-compose.yml, then restart n8n"*, over a `CopyBlock` whose `payload.compose` the server had stopped sending — so it rendered empty | They are pipeline variables, read on every run. The banner and the snippet are gone; the sub-tab says *applies to the next alert* |
| **Guide → Ingestion** | Three modes, one of them *"Observation"*, relaying to n8n | Two: `Open` and `Closed` |
| **Tracking** | *"Open in n8n"* links whose `href` was always the empty string, under an external-link icon | The execution id, as a mono value |

Also removed: the dead `shadow` comparison catalogue (the cut-over gate, whose
route and `engine/shadow.ts` had already gone), the dead `settings.n8n`
connection block, an `/api/shadow` assertion in `auth.test.ts` for a route that
no longer exists, and the never-populated `form_url` approval link.

**The rule is now a test.** `src/components/n8n-removed.test.ts` walks the whole
catalogue — functions called, not only literals — and fails on any user-facing
string naming n8n. Verified by mutation: putting the name back turns it red.

**Why this earns a roadmap entry rather than a commit message.** None of it
broke anything, which is exactly why it survived a whole migration. A stale name
is the cheapest thing to carry and the most expensive thing to believe, and
three of the four surfaces are the ones whose entire job is to say what is true
right now — the diagnostic, the settings, the reference. The Settings one was
the worst: a change that HAD applied, reported as one that had not, which is the
mirror image of the *"setting that looks applied and is not"* this product
refuses everywhere else.

### Verified against the real stack

`docker compose up`, three services, no n8n anywhere. The diagnostic reports
database and schema OK, the node contract intact on all six workflows, and the
journal readable. A pull source was configured and polled: three P4 alerts were
collected, each ran the full five-stage chain, and each produced an audit row
with its hash chained to the previous one.

### The QA and stress pass that followed the removal

Run against the real `docker compose` stack. Eight defects found; every one of
them is in CLAUDE.md's traps table with its cause.

| Pass | Result |
|---|---|
| Functional | 24/24 |
| Stress | 400 alerts at 50 concurrent — 400/400 accepted, ~134 alerts/s, p95 424 ms, all settled |
| Dedup race | 12 simultaneous copies → 1 accepted, 11 already-seen, zero errors |
| Audit chain | No fork and no broken link among ~500 rows written at 40-way concurrency after the fix |
| Unit | 889 tests, typecheck clean |

The three that mattered:

1. **The entry point returned 202 for alerts the pipeline had refused.** Four
   `respond` nodes decide the answer — 400, 200, 500, 202 — and the webhook
   ignored all of them. A sender whose alert was rejected for missing fields
   was told it had been accepted, and the reason never left the server.
2. **Deduplication was not race-safe.** `WHERE NOT EXISTS` inside one statement
   is not atomic under MVCC; twelve simultaneous sends produced a 500, which
   asks the sender to retry an alert already accepted. Now `ON CONFLICT`.
3. **The audit verifier reported broken links on healthy rows.** The sealing
   lock was right; the `bigserial` DEFAULT fires before it, so id order and
   seal order diverged and the id-ordered verifier called it tampering. The
   worst false alarm this table can raise.

Requires a manual `psql` on an existing database — `sql/` only runs on first
start. Documented in CLAUDE.md.

### Everything the pipeline says is English

The engine's own strings — guardrail messages, node labels and notes, approval
intents, Slack blocks, error messages, store errors — were French. They are the
strings an operator reads on the pipeline graph and in the approval message, so
they were the visible half of the "built-in engine writes French" debt in § 7.
All of them are translated; the tests that asserted on the French assertions
were updated with them.


**Decision taken 24 August 2026.** n8n is replaced by a durable execution
engine built into the console. Measured reason: 12 of the 20 entries in the
"Traps" table of CLAUDE.md are n8n workarounds, and the coupling by exact node
names makes the console blind to a simple rename.

Porting estimate: **113 nodes, 19 types (14 with execution), 973 lines of
JavaScript across 24 `code` nodes, and 168 `={{ … }}` expressions** scattered
through the `set` / `if` / `switch` nodes.

| # | Phase | State |
|---|---|---|
| ~~W1~~ ✅ | **Durable foundation** — typed model, run store, engine, resume after interruption, SQL schema. 18 tests, two of them verified by mutation | **Delivered** |
| ~~W2~~ ✅ | **Catalogue of the 16 node types** — typed value references instead of expressions; pure / IO / orchestration nodes. 55 tests, 4 verified by mutation | **Delivered** |
| ~~W3a~~ ✅ | **Porting 01 → 03** — ingestion, enrichment, decision. 54 n8n nodes → 36. 87 tests, 2 verified by mutation | **Delivered** |
| ~~W3b~~ ✅ | **Porting 04 → 06** — routing/approval, audit, error handler. All six workflows ported: **113 n8n nodes → 73**. 88 more tests, 1 verified by mutation | **Delivered** |
| ~~W4~~ ✅ | **Workflow tab** — SVG graph of the six workflows, a card per step, editable variables. Registry completed and checked both ways. 26 tests | **Delivered** |
| ~~W5~~ ✅ | **n8n / engine comparison**, with no model call. Two false disagreements found and fixed on real data. 24 tests, 2 verified by mutation | **Delivered** |
| ~~W6~~ ✅ | **Real wiring** — Postgres store, alert entry point carried by the console, Cloudflare tunnel | **Delivered** |

Three structural decisions, taken in W1, that hold up everything else:

1. **A node's identifier is the contract, not its name.** `id` is stable and
   never displayed, `label` is free and never read. Renaming becomes
   inconsequential — the only way to make a rename safe.
2. **No expression language.** The 168 `={{ … }}` become typed parameters. No
   `eval`, no `new Function`: in a security console that is one attack surface
   fewer, and it is what lets the Workflow tab offer a form rather than a code
   field.
3. **Writes are "at most once".** Each type declares its effect. `pure` and
   `read` replay freely; `write` **never** replays: the intention is logged
   before the call, and a resume that finds a call in flight marks the step
   `indeterminate` and raises it to a human. That is "never fill a gap with a
   default" applied to crash recovery.

A wait's `timeout` port is **distinct** from its main port: an expired approval
escalates, it does not execute. Silence is never consent, for the engine too.

**What W2 revealed by counting.** The "168 expressions" were a scarecrow: 15 ×
`$now.toISO()`, 15 × `$execution.id`, a few field reads and some constants. And
above all, **all 22 `if`/`switch` conditions test a boolean already computed**
by an upstream `code` node. Four reference forms (`const`, `input`, `node`,
`var`, `ctx`) therefore cover everything, and they all render as a form.

Four n8n traps became **impossible by construction**, each protected by a test:

| Trap | What makes it impossible |
|---|---|
| A Switch with no fallback output, which stopped while showing "success" | `fallbackPort` is a required field: the node refuses to run without it |
| `responseCode` buried in `options`, producing 200s on rejections | `status` is a first-class parameter, with no default |
| `mode: "once"` starting a sub-workflow with zero items | An empty input is refused, with the reason |
| Slack answering HTTP 200 with `ok: false` | The body is checked, not the HTTP code |

Two engine-specific defences, invisible on review and therefore tested: paths
**do not traverse the prototype** (`__proto__`, `constructor` refused — a
workflow definition is editable data), and numeric comparisons **refuse
strings** (`'10' > 9` is `true` in JavaScript; a confidence threshold compared
as a string would file a critical alert as a false positive, with no error).

Secrets **never** appear in a definition: a node names a credential, resolved at
call time. SQL is a constant and values travel separately — an alert contains,
by nature, text supplied by an attacker.

**What W3a simplified.** 54 n8n nodes become 36 with no functional loss: 6
`stickyNote` (documentation drawn on a canvas, now versioned with the code), 3
`noOp`, and above all **6 "Build Error Ctx" nodes with their calls to the error
handler** — they rebuilt by hand what the run log already knows: node id, port
taken, message, timestamp. The three enrichment normalizers, which were 3 × 20
rigorously identical lines, become one normalizer and three field tables.

**What W3a revealed — an engine defect.** Writing the definitions exposed a W1
mistake: `readyNode` started a node as soon as ONE incoming link was active.
The assembly node in 02 receives three sources; it would have worked on a third
of the data, **with no error, no trace, and a plausible result**. The engine now
sorts nodes topologically and runs a junction only once the fate of every
upstream is known — completed, or definitively discarded. Two tests cover both.

**W6 — real wiring (25 August 2026).** The engine is connected to Postgres and
to an alert entry point carried by the console.

| Element | Detail |
|---|---|
| `PgRunStore` | Implements `RunStore` on Postgres. Lock by conditional `UPDATE`, a wait settled exactly once by `WHERE resumed_at IS NULL` |
| Contract test | **The same suite for both stores.** It immediately found a divergence: the memory store created a duplicate step where Postgres avoided it |
| `POST /api/ingest/:source` | Closed by default. Three modes: `off`, `shadow` (relay to n8n **plus** replay by our engine), `primary` |
| Cloudflare tunnel | `npm run tunnel`. **Refuses to start** without a shared secret, and the token goes through the child process environment, never the command line |

**Three refusals, and none is optional.** Closed by default; no secret, no
endpoint; `primary` under condition of the green light **when an n8n is
configured**. Verified by mutation, then for real against the n8n instance: a
missing, wrong or truncated token answers 401, and the right token relays the
alert to n8n whose answer comes back intact — putting the console in front of
n8n changes nothing for the sender.

**An engine failure does not fail the ingestion.** Verified for real with the
database absent: n8n accepted the alert, and the `console_engine` block carries
the cause. Returning an error would make the sender replay, and the alert would
be handled **twice** by n8n.

**What W5 brings, and the decision that makes it useful.** We do NOT replay the
model call. A language model is not deterministic: two calls on the same alert
return `0.88` and `0.91`, and that divergence says nothing about the quality of
the port. We would be measuring the model's noise while believing we were
measuring the engine — and we would never dare cut over.

What is compared is the **deterministic** part, which is also exactly the part
just rewritten: our validator against what n8n emitted, our last barrier as a
fixed point, and the routing. Three comparisons, zero network calls, computed
from the already-cached snapshot.

**Two false disagreements found when wired to real data** — both would have
barred the cut-over for the wrong reasons:

| False disagreement | Cause |
|---|---|
| A test alert injected straight into 04 | Its decision is hand-made; 03 never saw it. We were blaming n8n for "accepting" a decision it never validated |
| Two **fallback** decisions | Written by the PIPELINE when the model is unreachable. Applying G10 to them — "every unavailable source must be named in the reasoning" — blames the pipeline for not citing its sources in a sentence that says it could analyse nothing |

After the fix: **100% agreement on 7 comparable cases, zero blocking
divergence** — and the cut-over stays refused for lack of volume (7 of 50
required). That is the intended behaviour.

**The green light requires TWO conditions.** Enough compared cases, AND zero
blocking divergence. A 99% rate with one blocking divergence is still a refusal:
the remaining percent may be the alert that isolates a machine. And
`not_comparable` cases **never** count towards the threshold — absorbing them
would clear the bar without having compared anything.

> **Since N7, the gate applies only when an n8n is configured.** With no n8n
> there is nothing to compare against, and refusing forever is a deadlock rather
> than caution: the built-in engine simply *is* the pipeline. See § 2 bis.

**What W4 brings.** The tab draws the definition **that runs**, not a copy — the
divergence between the editor and the engine was exactly n8n's defect. Each step
shows its **effect** (`pure` / `read` / `write`) before anything else, because
that is what decides what replays after a crash. Variables are editable and
apply to the next run, with no restart: that used to be `docker-compose`.

Deliberately **not** a drag-and-drop editor. The topology almost never changes;
what changes are thresholds and channels. A graph editor would have made
editable the one thing we do not want changed by accident — the path that leads
to executing an action.

Under 700 px an **ordered list** replaces the graph: 04 is 2648 px long,
technically scrollable on a phone and practically unreadable. Both are rendered,
one is hidden — a selection survives a rotation.

**What W3b fixed, and it was serious.** The shadow-mode counters lived in
`$getWorkflowStaticData('global')` — **n8n process memory**, back to zero on
every container restart. Yet those counters decide the exit from shadow mode at
50 alerts. A counter reset without anyone knowing does not postpone the
decision, it makes it **arbitrary**: "50 alerts" could mean 50 since the last
restart. The count now comes from a `GROUP BY` on `soc_audit_log`, append-only
and hash-chained.

**The guarantee W3b adds, which no unit test could give.** A test re-reads the
SHAPE of 04's graph and checks that the execution node is reachable only through
the `main` port of the human wait — and by no other path: not shadow mode, not
the timeout, not a failure to post the request. A link added by mistake would
break that guarantee without any function changing, so without any function
test flinching. The same test checks that shadow mode reaches **no** Slack node.

**What W3a preserved, and it matters.** Guardrails G6 to G11 are ported
identically and each has its test. `finalizeDecision` has one more, the most
important: an exhaustive sweep of 3 verdicts × 4 actions × 8 confidences
checking that **the final decision is never less cautious than the model's**.
And the shadow-mode fail-safe default no longer depends on a `$env` that threw:
absent, empty or unreadable means `true`; only the exact string "false" disables
it.

---

## 5. Autonomy under guardrails

The phase that decides whether the system moves from observer to actor. The
target model is **human-on-the-loop**: the agent handles the volume, the human
holds the door on irreversible actions.

| # | Feature | Entry condition |
|---|---|---|
| A1 | **Measure human disagreement over 50 alerts** | 50 observed decisions |
| A2 | **Gradual exit from shadow mode by risk class** — `auto_close` on false alarms above 0.95 confidence first, never isolation | A1 below a threshold decided by a human |
| A3 | **Feedback loop** — every disagreement feeds a prompt evaluation set | S1.2 (the notes carry the why of the disagreement) |
| A4 | **Versioned autonomy policy** — which action, which confidence, which criticality, who may change it | S2.3 |
| A5 | **Kill switch** — one button that puts the whole pipeline back into shadow mode | — |
| A6 | **Drift detection** — alert when the verdict distribution changes sharply | S1.4 |

> **Non-negotiable order:** A2 does not happen before A1. Leaving shadow mode on
> a hunch rather than on a measurement is exactly what `CLAUDE.md` has forbidden
> since day one.

---

## 6. Scale and integrations

| # | Feature |
|---|---|
| E1 | Additional connectors: GreyNoise, URLhaus, MISP, CrowdSec |
| E2 | Real ITSM integration (Jira or ServiceNow) instead of the mock |
| E3 | Real EDR for isolation (instead of the mock endpoint) |
| ~~E4~~ | ~~Multi-source ingestion (Wazuh, Splunk, Elastic) with upstream normalization~~ — **promoted to § 2 bis (N)**: this is the condition of "plug and play", not a question of scale |
| E5 | Batch processing and a queue for alert spikes |
| E6 | Multi-tenant |

---

## 7. Known technical debt

### The built-in engine writes French

Found while doing C0.28: one French divergence detail was on screen, and the
sweep behind it turned up **about ninety more** across `server/engine/`
(`routing.ts` 11, `values.ts` 10, `pg-store.ts` 9, `io.ts` 7, `registry.ts` 7,
`webhook.ts` 7, and a dozen files below that). They are the strings § 2 quater
lists as "not in any catalogue, because they are written in the engine" — and
that section asserts they are English.

Most are internal invariant errors nobody sees. Some are not, and those are the
ones that matter: `pg-store` explaining why a database refused the connection,
`io.ts` saying "no database configured — set it in Settings → Database", the
Slack and model failures that land on an incident card, the interrupted-step
note the Tracking tab prints. **They are the sentences you read at the worst
moment**, and they are in the wrong language.

Same cause as the report strings in C0.24: none of them renders without a
failure, a database, or an n8n, so a browser sweep never reached them. Not
fixed here — ninety edits inside the security engine is its own pass, with its
own test risk, and it is not a readability change.



Small, known, and written down so it is not rediscovered.

| Subject | Detail |
|---|---|
| Two icon sets | `src/components/Icon.tsx` (console) and `src/vulnpipe/components/Icon.tsx` (analysis) have two APIs and two class conventions. Mergeable, not urgent |
| Dead sections in the analysis dictionary | `t.app`, `t.glossary`, `t.severity` have not been read since the landing page went away |
| Flaw statuses in `localStorage` | See V2.5 |
| Coupling to n8n node names | Accepted and tested (the "console contract" diagnostic), but still fragile |
| 15 s snapshot cache | Enough today; to revisit with S1.4 |
| Bounded run window | The Tracking tab announces the truncation instead of hiding it, but beyond the window the console still knows nothing. Lifted by S1.4 |
| Probe ↔ error-handler correlation by time | The 06 triggered by the diagnostic probe is attached to it over a 10 s window. It only changes the RANK of the row, never its content — but it is a heuristic, not a proof |
| **French code comments** | Roughly 148 of 176 source files. Not user-facing, and the most valuable prose in the repository: they carry the reasoning. A deliberate pass, not a machine translation |

---

## 8. Principles that do not change

Whatever the phase, these rules outrank any feature:

1. **No irreversible action.** The catalogue is closed and stays closed. A human
   approval does not create the right to execute what is not implemented — and
   no tuning rule can reach it either.
2. **Silence is never consent.** An approval timeout executes nothing.
3. **Never fill a gap with a default.** Missing data = data shown as missing. A
   `committed: true` on a failed INSERT is worse than a visible error. Rejecting
   an alert because a field is absent is the same mistake in its harshest form:
   it replaces the alert with nothing.
4. **Shadow mode is the default.** Missing configuration cannot enable execution.
5. **Two false-positive rates, not one.** The verdict distribution is not a
   measure of correctness; only human disagreement is.
6. **Every failure logs or notifies, ideally both.**
7. **The user's vocabulary, not the pipeline's.** An internal identifier
   (`shadow_logged`, `needs_human`) is never shown raw; if it is not translated
   it is rendered as-is rather than invented.

---

## 9. Appendix — the testing defects, fixed

| Ref | Defect | Fix | Evidence |
|---|---|---|---|
| **B1** | The `Route` Switch in 06 with no fallback output: the error handler died silently while showing `success` | Fallback output on the 3 Switches that lacked one | 06 runs to the end and writes its notification attempt to the database |
| **B2** | `alwaysOutputData` + `onError: continueErrorOutput` sent both branches in parallel | Removed from the 20 nodes concerned | One HTTP response per run, verified on all 3 paths |
| **B3** | Blocked `$env` made the code fail **before** its fail-safe default | Defensive `envGet()` read in 03, 04 and 06 | `shadow_mode: true` applied with its trace, while the environment stays blocked |
| **B4** | `responseCode` outside `options`: everything answered 200 | Moved into `options` on the 4 Respond nodes | 400 / 202 / 200 emitted correctly |
| **B5** | 2 alerts → 40 runs | Consequence of B2 | 1 alert → 5 runs |
| **I1** | 05 sent `severity: "critical"`, outside the enum | → `high` | Contract aligned with 06 and the SQL constraint |

> **A wrong hypothesis, corrected by measurement.** B5 had been blamed on the
> `mode: "each"` setting of the Execute Workflow nodes, switched to `"once"`.
> That was wrong twice over: the amplification came from B2, and on this version
> of n8n **`mode: "once"` starts the sub-workflow with zero items** — 02 then 03
> finished in `success` having executed nothing (runs 55 and 59). All the nodes
> went back to `each`.

### State verified in testing

| Test | Result |
|---|---|
| Malformed payload | **HTTP 400**, context passed to 06 |
| Valid payload | **HTTP 202**, full 01→02→03→04→05 chain |
| Same `alert_id` sent again | **HTTP 200 `duplicate, skipped`** — deduplication works |
| Shadow mode | Shadow branch only, no Slack node and no action executed |
| Fail-safe shadow | `shadow_mode: true` applied despite blocked `$env` |
| Chained audit | `prev_hash` of row 2 = `integrity_hash` of row 1 |
| Volume | 5 runs per alert against ~20 before |

### State verified in the QA and stress pass

| Test | Result |
|---|---|
| Full chain, 1000 injections at 60 concurrent | **177/s, 1000/1000 accepted**, p99 486 ms |
| Rule engine, 200 active rules | Evaluation 3 ms p50; `GET /api/rules` 4 ms |
| Read endpoints (1000 req, c=40) | 3.9k–14.2k rps, **0 failures**, p99 ≤ 34 ms |
| Memory under load | 105 → 227 MiB, then **plateaued at 245** on an identical second round — heap growth, not a leak |
| **Audit hash chain, 2,644 rows** | `soc_audit_verify_chain` returns **0 discrepancies** after concurrent load |
| Nine test scenarios | Each takes a different path; malformed stops at 01, duplicate short-circuits to `respond-200` |

### The code-analysis QA and stress pass (V4.7)

`cd VulnPipe && npm run qa` — 36 checks, 10 areas, no network and no real model:
malformed input, path traversal, load, concurrency, restart, corruption,
retention, resources, unbounded growth, SSE hygiene.

**Eight defects found, all fixed.** Not one of them was visible to the unit
suite, because none of them is a rule about a function.

| # | Defect | Why it mattered |
|---|---|---|
| 1 | `POST /webhook` with a body of `null` threw | `JSON.parse("null")` is `null`, read as an object downstream. An uncaught exception on a trivial request |
| 2 | **No size limit on a request body** | Chunks accumulated without bound: one large POST grew the heap until it choked. The most ordinary denial of service there is against a JSON API |
| 3 | **`estimates` bounded by nothing** | Each pending estimate retains a full repo index — and a temp clone for a GitHub target. 60 requests held 60 of them (21 MB on a four-file fixture). No attacker needed: clicking "Estimate" again is enough |
| 4 | `emitters` bounded by nothing | A `StepEmitter` retains its whole run history. A burst of short scans accumulated them all |
| 5 | The emitter cap could evict a **queued** run | The queue runs jobs one at a time, so a burst leaves them all pending. Evicting "the oldest" took the emitter of the scan about to start, and the handler then marked a legitimate scan as failed |
| 6 | `recoverInterrupted` was **not idempotent** | It re-appended a terminal line on every boot: the journal grew forever, and the same scan was re-announced as interrupted months later |
| 7 | `sweep()` ran on every run creation | Read the directory and stat every file — 200 syscalls before a scan even started |
| 8 | **`shutdown()` never released pending estimates** | Their temp clones were left behind at every restart, with nothing left running to collect them. Found while chasing a slow test; the cause was a resource leak in production |

Two more, from re-reading rather than from the harness: an `fsync` on the run
header (paid on every launch, protecting almost nothing — kept only on the
terminal line, which protects the report that was paid for), and retry tests
that **actually slept**, which made them the first to fail on a loaded machine.
Making the sleep injectable took that file from 3.49 s to 130 ms.

---

## Sources

- [Best SOAR Tools for 2026 — Palo Alto Networks](https://www.paloaltonetworks.com/cyberpedia/soar-tools-comparison)
- [Top 5 SOAR Platforms 2026](https://guptadeepak.com/tools/top-5-soar-platforms-2026/)
- [SOAR Platforms: Key Features — Exabeam](https://www.exabeam.com/explainers/soar/soar-platforms-key-features-and-10-solutions-to-know/)
- [Security Case Management — D3 Smart SOAR](https://d3security.com/platform/soar-case-management/)
- [Cloud SOAR War Room — Sumo Logic](https://www.sumologic.com/blog/want-to-improve-collaboration-and-reduce-incident-response-time-try-cloud-soar-war-room)
- [Agentic AI and Hyperautomation in the SOC — Torq](https://torq.io/blog/agentic-ai-hyperautomation-soc/)
- [AI SOC Guardrails in 2026 — UnderDefense](https://underdefense.com/blog/ai-soc-guardrails/)
- [Poisoning the Watchtower — prompt injection against LLM-augmented SOCs](https://arxiv.org/abs/2605.24421)
- [LLM Prompt Injection Prevention — OWASP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [MCP vs Function Calling — Portkey](https://portkey.ai/blog/mcp-vs-function-calling/)
- [Function Calling vs MCP — Fast.io](https://fast.io/resources/function-calling-vs-mcp/)
- [MCP transports — Model Context Protocol specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [UX best practices for copilot design — UX for AI](https://www.uxforai.com/p/ux-best-practices-copilot-design)
- [Security Copilot in Microsoft Defender](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender)
