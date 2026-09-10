# Journal des nuits

*Entries from 2026-09-07 onward are in English, per `NIGHTLY.md`: everything
written in this repository is English. The French entries below are kept as
they were — they are memory about live code, and rewriting them would lose it.*

## 2026-09-10 — Thursday · Bugs and technical debt

**Subject**: the engine's three outbound nodes (`http`, `notify`, `llm`)
reported a cause that was either absent or wrong. A transport failure reached
the incident card as the two words *"fetch failed"*; a model provider's
refusal reached it as *"The model answered with no content."*

**Result**: PR opened (branch `claude/nightly-2026-09-10-engine-transport-cause`).

**Why this subject**: the suite was green on the default branch first (993
passed, 1 skipped, typecheck clean), so the calendar rule did not preempt, and
no PR was open. Thursday's reservoir is ROADMAP § 7 plus what earlier nights
noted without fixing, and this item is in **both**: § 7's row *"Raw transport
errors inside the engine"*, written by the 2026-09-09 (second run) night, which
recorded "do not widen this into the engine" for that PR precisely so a later
one would take it. This is that later one.

**What I learned**:

- **The commissioned half was the smaller half.** § 7 described a wording
  problem — five call sites, one wrapper. Reading `makeLlm` to fix it turned up
  a real bug beside it: the node never looked at `res.status`. It went straight
  to `res.json()`, so a 401 (wrong key), a 402 (no credit) and a 429 all left
  `choices` undefined and fell through to `'The model answered with no
  content.'` **A wrong cause is worse than a missing one**: "fetch failed" at
  least looks like nothing, while that sentence sends someone to inspect the
  model, the prompt and the schema — everything except the field that is wrong.
- **The body-less refusal was worse than either.** Measured, not predicted: a
  429 with an empty body made `res.json()` throw `Unexpected end of JSON
  input`, which names neither the provider nor the status. That is the string
  the test caught first and it is what convinced me the second half belonged in
  this PR.
- **The rule is not "check `res.ok`", and it matters that it is not.** The
  neighbouring `notify` branches already check it, and `http` deliberately does
  NOT — a non-2xx there is data, routed to the error port, and that behaviour is
  tested. The rule that generalises is: *a fallback sentence must not be
  reachable from a state it does not describe.* "Answered with no content" is
  true of an empty 200 and of nothing else. There is now a test asserting it
  still fires for the empty 200 — the fix had to remove the wrong callers of
  that sentence, not the sentence.
- **A diagnostic string is an egress path.** The obvious `what` in `Could not
  reach ${what}` is the URL. For two of the five call sites the URL *is* the
  credential — a Slack or Discord webhook URL carries its own authorisation —
  and step errors are written to `soc_run_step`, replayed in Tracking and
  printed on the card. Hence words for the webhooks and `hostOf()` for the one
  configured endpoint. Two tests assert the secret does not appear.
- **One existing test had to change, and it is not a weakening.** `nodes.test.ts`'s
  "a Slack that never answers does not freeze the run" asserted
  `rejects.toThrow(/abort/i)` — it was matching the browser's raw `AbortError`
  word, i.e. the very thing this change replaces with a sentence. Its CLAIM
  (it rejects rather than hanging) is untouched; the assertion is now
  `/Slack.*deadline/is`, which pins two things where it pinned one.

**Found and NOT fixed**:

- **`makeNotify`'s `slack-bot` branch still calls `res.json()` with no guard.**
  An HTML error page from a gateway in front of Slack throws a `SyntaxError`
  instead of naming the status. Slack's own API answers JSON even on `ok:
  false`, so it is reachable only through an intermediary — and that branch is
  the one whose success is READ from the body, with a test file that exists
  because it lied about success once. Added to § 7 as its own row rather than
  slipped into this PR.
- The `runDiagnostics` "not configured" branch is still unreachable from a
  fresh install (2026-09-09 entry below). Still a wording decision on a screen;
  still a Saturday.

**Do not redo**:

- **Do not put the dialled URL into a step error** to make the message more
  precise. See above: two of the five are secrets. If a future call site needs
  more than a host, it needs a reason and a test that the secret cannot reach
  the journal.
- **Do not give `http` a `res.ok` check to match `llm`.** Its non-2xx goes out
  of the error port on purpose, without throwing, so a wired error branch can
  catch it — `nodes.test.ts` pins that and it is the older, deliberate design.
- **Do not delete `'The model answered with no content.'`** It is correct for
  the state it names. The fix was to stop other states reaching it, and a test
  now holds it in place.
- **Ruled out: routing these through the i18n catalogue.** They are engine
  strings; CLAUDE.md says those live where they are produced and are English.
  Same reasoning `describePgError` and `describeFetchError` already follow.

**Verified**:
```
cd dashboard
npm run typecheck   # 0 errors
npm test            # 1003 passed | 1 skipped  (993 before; +10 new, nothing skipped)
npm run build       # dist built, 472.18 kB / 139.73 kB gzip (unchanged: server-side change)
```
Checked **RED** first: `io-failures.test.ts` was written before the fix and ran
**9 failed | 1 passed** of 10 — the five transport tests on `'fetch failed'`,
the two `llm` refusal tests on `'The model answered with no content.'` and
`'Unexpected end of JSON input'`, and the end-to-end one on `run.error` being
the literal string `'fetch failed'`. The one that passed is the empty-200
guard, which must pass both before and after. `VulnPipe/` untouched, its suite
not run. No model key and no database needed: every transport is simulated and
the run store is in memory.

**Note**: `npm install` rewrote `dashboard/package-lock.json` again, exactly as
the 2026-09-09 entry records (`@types/pg` moves between `dependencies` and
`devDependencies`). Reverted, not committed. Still pre-existing, still left
alone.

## 2026-09-09 (second run) — Wednesday · Tests and QA

**Subject**: every transport failure in the console reached the operator as the
two words *"fetch failed"*. `fetch` rejects with that message and puts the real
cause one level down in `err.cause`; three screens whose entire job is to name
what is wrong read `(err as Error).message` and printed it.

**Result**: PR opened (branch `claude/nightly-2026-09-09-fetch-failure-cause`).

**Why this subject**: the suite was green on the default branch first (969
passed, 1 skipped, typecheck clean), so the calendar rule did not preempt, and
no PR was open. Wednesday is the failure-path night. This is priority (2) — a
real, reproducible defect, demonstrated by four tests that fail before the fix —
carried by priority (4), since `runDiagnostics` had **no test file at all**.

**What I learned**:

- **`describePgError` could not be reused, and the reason is exact.** It keys on
  the message being EMPTY. `fetch`'s message is not empty, it is worthless — so
  handing it a fetch failure returns `"fetch failed"` unchanged. Two functions,
  because they detect two different kinds of silence.
- **Probing Node 22.22.2 changed the design twice.** (a) An `AbortController`
  abort is a `DOMException` with **no `cause` at all** — a helper that only
  unwrapped `cause` would have said nothing for a timeout. (b) `fetch` to port
  **1** does not produce `ECONNREFUSED`: undici refuses it as a *blocked port*,
  `cause.message: "bad port"`, **no code**. So the code table alone is
  insufficient, and my first `closedAddress()` helper was measuring the wrong
  failure. Bind a port and release it instead of picking a number.
- **No `AggregateError` was observed from `fetch`** on this host, unlike `pg`.
  Deliberately not special-cased: the generic fallback degrades to the
  constructor name rather than to `"fetch failed"`, and coding for a shape I
  could not reproduce is what NIGHTLY.md forbids.
- **`tcpProbe` in `probes.ts` had this table all along**, for the socket path
  (ECONNREFUSED / ENOTFOUND / EHOSTUNREACH / ETIMEDOUT → a sentence). The fetch
  path never got one. `describeFetchError` reuses its wording on purpose: the
  same refusal must not be described two ways depending on the button pressed.
- **The poller's transport rejection was its only untested failure path.**
  `poller.test.ts` covers non-2xx, oversized bodies, bad shapes, credentials,
  partial delivery — everything that comes back with a status to name. The one
  that comes back with nothing had no test, and it is the one that persists its
  string into the cursor file as `lastError`.
- **`runDiagnostics` reports a fresh install's database as `ECONNREFUSED
  127.0.0.1:5432`, never as "not configured".** Its `if (!conf.database.host ||
  !conf.database.database)` branch is **unreachable from a fresh install**: the
  defaults fill both fields (`host: '127.0.0.1'`, `database: 'menater'`), so
  only someone who clears the field by hand can reach it. Same family as the
  dead `refang()` regex in the traps table. **Not fixed** — the remedy shown is
  identical either way, so it is a wording decision on a screen, and
  `CLARITY.md` governs that, not a test night. Left for a Saturday.

**Do not redo**:

- **Do not test the MCP test button or the assistant chat route end to end.**
  Both catches are one line and both got the same fix, but neither is reachable
  with an injected `fetch`: the MCP button dials `127.0.0.1:${PORT}` (so the
  result depends on whether the developer's own console is running — a flaky
  test by construction), and the chat ROUTE calls `chat()` with the real global
  `fetch`, even though `chat()` itself accepts a `fetchImpl`. Same wall the
  2026-09-09 entry below records for `runtime.ts`. They are covered by
  `http.test.ts` on the helper, and that is stated in the PR rather than hidden.
- **Do not widen this into the engine.** `io.ts`'s `http` / `notify` / `llm`
  nodes have the same defect and it is the same one-line fix, but ROADMAP § 7
  already reserves a separate pass for the engine's strings. Noted there as
  debt instead; five nodes is test risk that does not belong in this PR.
- **Do not "simplify" `describeFetchError` into `describePgError`.** See above.
- **Do not make the helper rewrite messages it did not need to.** It passes an
  error that already explains itself through untouched, and a test pins that —
  it is the only reason it is safe on the two catches that see more than
  transport failures.

**Verified**:
```
cd dashboard
npm run typecheck   # 0 errors
npm test            # 993 passed | 1 skipped  (969 before; +24 new, nothing skipped or weakened)
npm run build       # dist built, 472.18 kB / 139.73 kB gzip (unchanged: server-side change)
```
Checked **RED** first, with both call-site fixes reverted: 4 tests fail — three
in `poller.test.ts` and one in `diagnostics.test.ts` — all with
`expected 'fetch failed' not to be 'fetch failed'`, and one with
`expected 'This operation was aborted' to match /deadline/i`. The nine tests
`http.test.ts` adds failed before the function existed. `VulnPipe/` untouched,
its suite not run. The one skipped test is the pre-existing
`store-contract.test.ts > contrat — postgres`, which needs a database.

**Note on the suite's health**: checked while looking for slow or flaky tests,
per the theme. Only one real sleep in the whole suite (`setTimeout(r, 5)` in
`poller.test.ts`), one `useFakeTimers` block, and 18.2 s total for 993 tests.
Nothing to fix there. The new `diagnostics.test.ts` deliberately points the
database at a **closed loopback port** rather than the default 5432, so it
cannot depend on whether the machine running the suite happens to have a
Postgres listening — the `vitest.config.ts` lesson, applied to a new file.

## 2026-09-09 — Wednesday · Tests and QA

**Subject**: the console's two injection buttons reported `ok: true, 202
accepted` for every run they managed to start, whatever the pipeline had
decided about the alert. The `malformed` scenario — which exists solely to show
what a refused sender is told — produced a green banner.

**Result**: PR opened (branch `claude/nightly-2026-09-09-injection-answer`).

**Why this subject**: Wednesday is the failure-path night, and its stated rule
is *a failure must never look like a success*. The suite was green on the
default branch first (957 passed, 1 skipped, typecheck clean), so the calendar
rule did not preempt it, and no PR was open. This is priority (2) — a real,
reproducible bug — not (4) coverage.

**What I learned**:

- **`Engine.responseOf` had exactly one caller.** It was written for the trap
  already in the table ("the entry point answered 202 for an alert the pipeline
  REFUSED") and wired into `webhook.ts` alone. `POST /api/simulate` and
  `POST /api/replay` both still did `engine.start(...)` then hard-coded
  `ok: true, status: 202`. Grepping for the other callers of a thing you just
  fixed is a two-minute habit that would have caught this a pass earlier.
- **The two buttons had no test because neither has a sender to disappoint.**
  The webhook's answer is a protocol, so it got tested; a console button's
  answer is "just a banner", so it did not. That is backwards — the banner is
  the only thing the operator sees.
- **The pipeline really does reach `respond-400` on the shipped scenario.** Not
  assumed: `injection.test.ts` assembles the real engine on `MemoryRunStore`,
  registers the real workflows and injects `SCENARIOS`. The `malformed`
  scenario needs almost nothing stubbed — validation fails before the `dedup`
  postgres node — so the harness is ~40 lines rather than the ~80 of
  `pipeline-to-case.test.ts`. I deliberately did NOT extract a shared harness:
  one duplicated fixture is cheaper than a shared file two suites fight over.
- **`replayRefused` was already in the catalogue and called from nowhere** —
  dead since the replay route stopped speaking HTTP to n8n. It went back to
  work with a `detail` argument added.
- **A duplicate is not a malfunction, and the wording had to say so.** The
  `burst` scenario and a `same_id` replay exist to demonstrate deduplication,
  so `ok: false` (correct: no chain started, so nothing to follow) is rendered
  with a red banner. I left the tone alone and changed the sentence instead —
  "already seen, so no second chain was started". A third banner tone is a
  CLARITY.md change, not this PR.

**Found and NOT fixed — a stale-vocabulary cluster around "published"** (a
future night's subject, same family as the n8n sweep):

- `console.ts` `diagLede` still describes the OLD diagnostic: *"checks access
  to the pipeline, that the six workflows exist and are published, how they
  chain, their credentials"*. `runDiagnostics` checks none of that any more —
  it checks database, schema, model key, the node contract, runs seen and the
  entry point. **Live on the Health tab**, and the Guide contradicts it two
  screens away ("There is no publish step, so there is nothing to forget").
- `console.ts` `published` / `unpublished` — **live**, rendered per workflow on
  the Health tab, where `workflowList()` hardcodes `active: true`. A badge that
  is always the same word, in the vocabulary of a product that left.
- `server/i18n.ts` `findingNothingPublished` and `webhookUnreachable` — both
  **dead** (no caller). The second says "Check that 01-Ingestion is published".
- I did not add a test forbidding "published" in user-facing strings, because
  it would have failed on those four and forced this PR to widen.

**Do not redo**:

- **Do not report a duplicate as `ok: true`.** It is tempting (nothing is
  broken), and it restarts `follow()` hunting a run deduplication deliberately
  did not create — the 45-second "no trace of that alert" this PR removes.
- **Do not borrow the webhook's fallback 202 when no `respond` node was
  reached.** HTTP obliges the webhook to send a status; a console button is not
  a protocol and can say `0` plus "the run broke before deciding". Inventing an
  acceptance is the defect, at one remove.
- **Ruled out: testing the routes through `handleRequest`.** `getEngine()` is
  module state keyed on the database config, with no injection point, and a
  `pg` pool is lazy — so the route would build an engine whose every write
  fails, which tests the failure of the store rather than the answer. The logic
  moved into `injection.ts` instead, where the real engine can be handed in.
  Making `runtime.ts` injectable for tests is a bigger change than this bug.
- **Ruled out: a shared test harness with `pipeline-to-case.test.ts`.** See
  above.

**Verified**:
```
cd dashboard
npm run typecheck   # 0 errors
npm test            # 969 passed | 1 skipped  (957 before; +12 new, nothing skipped or weakened)
npm run build       # dist built, 472 kB / 140 kB gzip
```
Checked **RED** first: with `injectAlert` reverted to the shipped behaviour
(`return { ok: true, status: 202, … }`, ignoring `responseOf`), the two
refusal tests fail — `expected true to be false` on the `malformed` and
duplicate paths. `VulnPipe/` untouched, its suite not run. No model key and no
database here, and neither is needed: the pipeline takes its fail-safe verdict
and the store is in memory.

**Note**: `npm install` rewrote `dashboard/package-lock.json` (npm version
churn — `libc` fields, `@types/pg` moved to `devDependencies`). Reverted, not
committed. Worth knowing: `package.json` lists `@types/pg` under
`devDependencies` while the committed lock has it under `dependencies`, so any
`npm install` on a recent npm produces that diff. Pre-existing, left alone.

## 2026-09-08 — Tuesday · Security

**Subject**: the assistant's fence covered the alert and not the enrichment.
Shodan / AbuseIPDB / VirusTotal text — which describes an address an attacker
chose — reached the model verbatim, through `menater://alert/{id}` as well as
the panel.

**Result**: PR opened (branch `claude/nightly-2026-09-08-fence-enrichment`).

**Why this subject**: Tuesday's first listed area is prompt injection on the
paths that hand a log to a model. The suite was green on the default branch
first, so the calendar rule did not preempt it, and no PR was open.

**What I learned**:

- **`ROADMAP.md` X2 already asserted enrichment free text was fenced.** It was
  not. The documentation is what kept the hole invisible: anyone auditing the
  fencing would have read that row and stopped. This is the project's own
  "documentation describing an unimplemented intention is worse than no
  documentation", turned on a security guarantee.
- **The untrusted text people forget is the text that does not look like a
  log.** Enrichment reads as reference data — a score, a country, an ISP. But
  Shodan's `hostnames` is the reverse DNS of the attacking address, a PTR
  record its owner sets; `org`/`isp` are WHOIS on that same address;
  VirusTotal's `meaningful_name` is the file name whoever submitted the sample
  chose. Checked in `transforms/enrichment.ts`: a failed lookup's `reason` is
  `clip(e.message ?? e.description ?? …)` — the provider's own prose, forwarded.
- **A list of field names was the wrong shape here, and the reason is
  structural.** `UNTRUSTED_ALERT_FIELDS` can be a list because an alert has a
  contract in `domain.ts`. `EnrichmentSource` is `{ status, source, [key:
  string]: unknown }` — an open bag — so a name list would go stale *silently*
  the day a mapper gains a field or a fourth source arrives. The rule is
  inverted: fence everything except the two fields whose vocabulary is ours and
  closed. Numbers and booleans stay bare, because they carry no instruction and
  the model has to keep reasoning about a score as a score.
- **One call site covers both surfaces.** `readResource` in `mcp.ts` calls
  `runTool('get_alert')`, so the MCP resource and the docked panel are the same
  path. Verified by reading it, not assumed.
- **The demo snapshot is a real offline test fixture.** With no database
  `snapshot()` falls back to `demoCases`, whose enrichment carries actual free
  text (`org: 'Bulletproof Hosting Ltd'`, `popular_threat_label`). So the
  end-to-end test drives the real tool with no mocking at all.

**Do not redo**:

- **Do not fence `enrichment_meta`.** Its source lists are our own names,
  `file_hash` is a hex match our own regex made, the rest are booleans and a
  timestamp. Marking it too would dilute the mark — the rule `fenceFields`
  already states.
- **Do not fence the numbers.** `abuse_confidence_score: 100` inside a fence is
  a string the model has to unwrap before it can compare it, bought for nothing:
  a number cannot carry an instruction.
- **Ruled out: fencing `approval.human_reasoning` and `approver.slack_username`
  in the same PR.** They are also unfenced and they are also not ours, but they
  are typed by someone holding the console password — a different threat model
  and a different argument, and it did not belong in a PR about third-party
  text. Noted here so the next security night has it. Same for `list_rules`'s
  `conditions`, which is operator-authored.
- **Ruled out: touching `alertRow`'s `host` / `source_ip`.** They are unfenced
  by an existing deliberate choice, and reopening it is an architecture
  decision, not a night's fix.

**Verified**:
```
cd dashboard
npm run typecheck   # 0 errors
npm test            # 957 passed | 1 skipped  (953 before; +4 new, nothing skipped or weakened)
npm run build       # dist built
```
The end-to-end test was checked **RED** first: with `fenceEnrichment` removed
from the call site it fails with `expected 'Bulletproof Hosting Ltd' to contain
'<nonce>'`. Size measured on all seven demo cases before and after: `get_alert`
grows by 169–815 characters, worst reply 5,123 against the 12,000-character
`capResult` cap — so no reply is pushed into truncation by the fencing.
`VulnPipe/` untouched, its suite not run.

## 2026-09-07 — Monday · Feature

**Subject**: J0.3, the service ↔ repository inventory — the table that says
which code runs on the machine an alert is about, plus the one consumer that
makes it real: the incident card names it and hands it to the Code tab.

**Result**: PR opened (branch `claude/nightly-2026-09-07-service-inventory`).

**Why this subject**: Monday is the feature night and the roadmap says J0
outranks everything, with J0.3 explicitly ordered before J0.1 and J0.2. The
suite was green on the default branch first (913 tests, typecheck clean), so
the calendar rule did not preempt it. No nightly PR was open.

**What I learned**:

- **`config.json`'s `merge()` cannot hold a list.** It walks the sections of
  the default config and does `{ ...base[section], ...patch[section] }`.
  `typeof [] === 'object'`, so an array section is spread INDEX BY INDEX.
  Measured on the real function before writing a line of the feature:
  saving `[a]` over `[a, b]` yields `{"0":a,"1":b}` — the deleted entry
  survives and the section stops being an array. The inventory is therefore
  `{ entries: [...] }`, one level down, where the spread replaces the key. The
  test that proves it is the one that REMOVES an entry; a test that only adds
  passes either way. Any future list-shaped setting owes the same wrapper.
- **A jump into a tab that is never unmounted needs a key, not an effect.** The
  Code tab stays mounted once opened (unmounting would cut a running scan) and
  `ScanLauncher` takes its target as an INITIAL value, owning the field
  afterwards. So a second alert handing it a second repository changed nothing:
  the tab opened with the previous alert's path in the box, silently and
  plausibly. `key={prefill?.n}` fixes it; an effect writing into the field
  would have re-run the child-before-provider ordering trap this codebase
  already has in its table. Verified by removing the key and watching the test
  go red.
- **A controlled field must not normalise on every keystroke.** The first draft
  of the identifiers textarea split on `\n` and joined the list back into
  `value`. Splitting drops blank lines, which is right on the way out and fatal
  while typing: the newline vanished the instant it was typed, so a machine's
  SECOND address could never be entered — the field silently refused the only
  thing it exists for. Found by re-reading my own diff, not by a test; the test
  came after and was verified red against the old handler. The draft holds raw
  text now and converts once, on save. The dirty check compares the CONVERTED
  value, otherwise a trailing newline would light a permanent "unsaved changes".
- **Rendering the Settings screen with rows in it found the bug above.** An
  inventory editor with no entries is a heading and a button. `CLARITY.md` is
  right about this and it cost nothing to obey: the fixture test that mounts it
  with two services is the same test that now pins the save payload.
- **`AlertCase.source_ip` / `dest_ip` carry `—` for "not recorded"** while
  `host` carries `null`. Anything matching on those three has to treat the dash
  as absent, or one inventory entry named `—` becomes a wildcard for every
  alert with no address.

**Do not redo**:

- **Do not add CIDR ranges, suffix rules or "looks close enough" matching**
  without reopening the reasoning in `server/inventory.ts`'s header. A guessed
  repository sends an analyst to read the wrong code while an incident is open.
  A range is still a declaration rather than a resemblance, so it is the one
  extension worth considering — but it needs its own ambiguity rule (two
  overlapping ranges), which is exactly what exact matching avoids having to
  solve.
- **Do not make the resolver pick between two entries claiming one machine.**
  The save is refused naming the identifier instead, so the store cannot hold
  the ambiguity and the resolver never needs a tie-break.
- **Ruled out: making the card say "not in the inventory" when there is no
  match.** It is true, and it would put a line nobody can act on at the top of
  every incident on an install that has not filled the table in. Absence is
  shown by showing nothing here, because the absence is a fact about our
  configuration and not about the detection — unlike the observables above it,
  which keep their dash.
- **Ruled out for tonight: exposing the field to the assistant and the MCP
  catalogue.** `alertRow` / `alertDetail` pick their fields explicitly, so
  nothing leaked by accident; adding it is a one-line follow-up that touches
  the fenced surface, and it did not belong in a PR that already spans server,
  settings and two tabs.
- **Ruled out: a Postgres table for the inventory.** `sql/` only runs on a
  database's first start, so a new table means a manual `psql` on every
  existing stack — and this is operator-declared configuration, not pipeline
  evidence: it decides nothing irreversible and needs no audit history.

**Verified**:
```
cd dashboard
npm run typecheck   # 0 errors
npm test            # 953 passed | 1 skipped (913 before, +40 new; nothing skipped or weakened)
npm run build       # dist built, 472 kB / 140 kB gzip
```
Two of the new tests were checked RED before the fix they cover: the Code-tab
prefill (key removed → "is REPLACED when a second alert sends another one"
fails) and the identifiers textarea (collapsing handler restored → "accepts a
second identifier typed on a new line" fails). `VulnPipe/` was not touched, so
its suite was not run. No model key and no database in this environment, and
nothing here needs either: the resolver is pure, and the route tests drive
`handleRequest` against a scratch `config.json`.

## 2026-08-19

**Sujet** : le scanner IDOR déterministe pouvait encore classer une route
vulnérable comme "saine" sans jamais consulter le LLM — cette fois à cause
d'une liste de noms de méthode exacts qui ratait les conventions ORM
composées.

**Résultat** : PR ouverte (branche `claude/exciting-volta-x4wscq`).

**Ce que j'ai appris** :
- `isDataAccess()` (`src/nodes/idor/scanner.ts`) comparait le nom de chaque
  appel à une liste FIGÉE de noms exacts (`findone`, `findbyid`, `getbyid`...).
  Un nom de méthode réel mais absent de la liste — `findOneBy` (TypeORM),
  `findByIdAndUpdate` (Mongoose), et toute variante composée du même genre —
  n'était pas reconnu comme un accès aux données : `collectDataAccessSites`
  le voyait bien, mais la boucle principale de `scanForIdor` l'ignorait
  purement et simplement (`if (!isDataAccess(...)) continue;`).
- Conséquence : si la MÊME méthode contient à la fois un appel reconnu et
  filtré (ex. `this.db.logs.findOne({ userId })`, pour un log d'accès) et un
  appel non reconnu et NON filtré (ex. `this.db.orders.findOneBy({ id })`,
  la vraie lecture de la ressource), le scanner ne voit que le premier. Le
  garde-fou `scoped && !unscoped && !hasUnresolvedGuard` conclut alors
  `decisive_score: 0.1` ("sain", coût nul) alors que la route est réellement
  vulnérable. Exactement la même famille de faux négatif silencieux que le
  bug corrigé hier soir (voir entrée du 2026-08-18) — cette fois sur le nom
  de la méthode plutôt que sur la fenêtre de recherche du filtre.
- Corrigé en remplaçant la comparaison par égalité exacte par une
  comparaison de PRÉFIXE sur le même jeu de verbes (`find`, `get`, `query`,
  `select`, `fetch`, `load`, `update`, `delete`, `remove`, `destroy`, `save`).
  Tous les noms de la fixture (`findById`, `findOne`) commencent déjà par un
  de ces verbes : aucune régression sur les cas existants, vérifié par les
  283 tests déjà en place plus le nouveau.
- Un faux positif introduit par le préfixe (un nom métier qui commence par
  "get" sans être une requête base) ne peut plus produire un verdict "sain"
  à tort : au pire il ajoute un site "non reconnu comme filtré" qui pousse la
  route en zone grise (coût LLM en plus), jamais l'inverse. C'est la
  direction sûre déjà retenue hier soir.

**À ne pas refaire** :
- Ne pas revenir à une liste de noms exacts "pour plus de précision" sans
  rouvrir ce raisonnement : c'est précisément ce qui a permis à `findOneBy`
  de passer inaperçu.
- Je n'ai PAS tenté d'énumérer davantage de noms ORM exacts (`findBy`,
  `updateOne`, `deleteMany`, méthodes d'agrégation...) : une liste, même
  élargie, reste un jeu au chat et à la souris avec les conventions de nommage
  réelles. Le préfixe couvre la famille au lieu d'un nom précis, mais reste
  heuristique par construction — un verbe métier qui ne commence par aucun de
  ces préfixes (rare mais possible) resterait invisible. Le vrai correctif de
  fond, déjà noté dans `ROADMAP.md`, est un suivi de flux de données plutôt
  qu'un filtre sur le nom de la méthode ; hors de portée d'un changement d'une
  nuit.

**Vérifications exécutées** :
```
npm run typecheck   # 0 erreur
npm test             # 284/284 verts (283 avant + 1 nouveau test, aucun ignoré/affaibli)
npm run build         # web/dist généré, 293 kB / 91 kB gzip
```
Aucun script consommant du quota LLM n'a été lancé (bench/measure/report/e2e) :
le changement est entièrement couvert par les tests hors-ligne (`FakeLlmClient`)
et par un test unitaire du scanner qui n'appelle aucun modèle.

## 2026-08-19

**Sujet** : en mode `incremental_scan`, un commit qui ne touchait qu'un service
ne faisait réanalyser aucune route — VulnPipe répondait « rien à revérifier »
sur le commit qui venait justement d'introduire la faille.

**Résultat** : PR ouverte (branche `nightly/2026-08-19-incremental-service-deps`).

**Ce que j'ai appris** :
- La condition de rattachement dans `selectRoutes` (`src/orchestration/pipeline.ts`)
  était `fichier.includes(route.controller)`. `route.controller` est le NOM DE
  CLASSE (`OrderController`), le fichier est un CHEMIN (`src/order.controller.ts`) :
  la condition ne pouvait jamais être vraie. Ce n'était pas une heuristique
  faible, c'était du code mort — et son commentaire affirmait le contraire
  (« un service modifié rend vulnérables les routes qui l'appellent »). Un
  commentaire qui décrit une intention non implémentée est pire qu'une absence
  de commentaire : il empêche de relire la ligne.
- Le mode incrémental n'avait AUCUN test sur son chemin nominal. Les trois
  tests existants couvraient uniquement les replis (pas de commit, diff
  incalculable), c'est-à-dire les cas où la fonction ne sélectionne rien. Le
  seul endroit capable de produire un faux négatif — décider ce qu'on
  n'analyse PAS — n'était vérifié nulle part. Leçon générale : un test sur les
  branches d'échec d'une fonction de filtrage ne dit rien de son filtre.
- Créer un vrai dépôt git jetable dans un test est bon marché : `git init` +
  deux commits, hors ligne, ~40 ms pour cinq dépôts. Pas besoin de simuler
  `git diff` — c'est justement l'accord entre la forme réelle de sa sortie et
  nos chemins qui cassait.
- `git diff --name-only` renvoie des chemins relatifs à la RACINE DU DÉPÔT,
  pas au `cwd` passé à `execFileSync`. Nos `route.file` sont relatifs à la
  racine INDEXÉE. Sur un monorepo dont on n'indexe qu'un paquet, plus rien ne
  correspondait — deuxième faux négatif, silencieux lui aussi. `--relative`
  aligne les deux et exclut au passage ce qui est hors du dossier indexé.
- `injection_map` (indexeur, Phase 1) suffit à relier une route à ses services,
  transitivement, sans aucun appel LLM ni relecture du disque. Le contexte
  nécessaire existait déjà dans l'index ; il n'était pas consulté.

**À ne pas refaire** :
- Ne pas rétablir de rattachement par ressemblance de noms (chemin contre nom
  de classe, ou `order` contre `OrderController`). C'est ce qui a masqué le
  bug : ça a l'air d'un lien, ça n'en est pas un. L'index sait qui appelle
  qui — il faut le lui demander.
- Piste écartée : traiter un fichier modifié non rattaché à une route comme
  « sans effet » et rester en incrémental. Moins coûteux, mais c'est
  exactement le raisonnement « dans le doute, tout va bien » que ce produit
  ne peut pas se permettre. J'ai pris le repli en scan complet, annoncé par
  un message. Contrepartie assumée et notée dans le ROADMAP : sur un dépôt
  réel, l'incrémental retombera probablement souvent en complet. Il faut le
  MESURER sur un vrai dépôt avant d'affiner — pas le deviner.

**Vérifications exécutées** :
```
npm run typecheck   # 0 erreur
npm test            # 289/289 verts (284 avant + 5 nouveaux, aucun ignoré/affaibli)
npm run build       # web/dist généré, 293 kB / 91 kB gzip
```
Aucun script consommant du quota LLM n'a été lancé (bench/measure/report/e2e) :
la sélection de routes est purement déterministe et se teste hors ligne.

**Note de rebase** : la branche a été rebasée sur `main` après l'arrivée des
PR #2 (page de présentation, réglages) et #3 (préfixes ORM du scanner). Seul
`NIGHTLY_LOG.md` était en conflit — deux nuits datées du même jour, les deux
entrées ont été conservées. Les chiffres ci-dessus sont ceux d'APRÈS rebase ;
les fichiers de code se sont fusionnés sans conflit (les modifications de
`pipeline.ts` par la PR #3 portent sur l'agrégation, pas sur `selectRoutes`).

## 2026-08-18

**Sujet** : le scanner IDOR déterministe pouvait classer une route vulnérable
comme "saine" sans jamais consulter le LLM, à cause d'une vérification de
filtre trop large.

**Résultat** : PR ouverte (branche `claude/exciting-volta-u9ijhz`).

**Ce que j'ai appris** :
- `mentionsUserScope()` (`src/nodes/idor/scanner.ts`) cherchait un champ
  d'identité (`userId`, `ownerId`, ...) dans **tout le corps de la méthode
  englobante** de l'appel base de données, pas seulement près de cet appel.
  Un paramètre `userId` reçu dans la signature mais jamais branché sur le
  filtre — un oubli très courant chez un vibe coder qui a commencé à câbler
  l'ownership check et ne l'a jamais terminé — suffisait à faire matcher le
  texte et à classer `findOne({ id })` comme protégé.
- C'est plus grave qu'un simple faux négatif de LLM : `decisive_score`
  est le chemin qui **court-circuite le LLM**. Un faux positif sur "scoped"
  ici produit une route vulnérable classée saine à coût nul, jamais revue
  par personne — humain ou modèle. C'est exactement le défaut que
  `CLAUDE.md` §3/§4 et le ROADMAP désignent comme le pire possible pour ce
  produit.
- Le test existant ("ne se laisse pas berner par un `req.user.id` utilisé
  seulement pour un log") ne couvrait PAS ce cas : il passait par accident,
  parce que la fixture avait un DEUXIÈME site d'accès (l'appel imbriqué
  `this.db.orders.findOne({ id })` dans `OrderService.findById`) qui restait
  correctement classé "non filtré" et suffisait à empêcher le verdict
  décisif, indépendamment de la mauvaise classification du site parent. Un
  scénario avec un SEUL site d'accès dans la méthode qui reçoit le paramètre
  inutilisé n'était testé nulle part — c'est celui que j'ai ajouté.
- Piste explorée et écartée : faire regarder la fenêtre aussi quelques lignes
  **avant** l'appel (pour reconnaître un `if (!owns) throw` juste au-dessus).
  Abandonné : dans une méthode courte (la majorité des cas réels et de nos
  fixtures), une fenêtre arrière retomberait sur la ligne de signature et
  réintroduirait exactement le bug que je corrige (le paramètre `userId`
  inutilisé redeviendrait visible). Direction retenue : fenêtre strictement
  vers l'avant. Conséquence assumée et documentée dans le ROADMAP — un
  contrôle d'accès écrit en amont de l'appel n'est plus reconnu par le
  scanner déterministe et pousse la route en zone grise (coût LLM) au lieu
  d'un verdict "sain" à coût nul. C'est la direction sûre : dans le doute, on
  demande, on ne conclut jamais à tort qu'une route est protégée.

**À ne pas refaire** :
- Ne pas élargir à nouveau `mentionsUserScope` pour regarder tout le corps de
  la méthode "pour réduire le taux de zone grise" sans re-belier le
  raisonnement ci-dessus : c'est précisément ce qui a causé ce bug.
- Le vrai correctif de fond (suivi de flux de données au lieu d'un
  pattern-matching textuel) n'a pas été tenté cette nuit — hors scope d'un
  changement d'une nuit, nécessiterait de repenser l'indexeur/resolver pour
  exposer les arguments réels d'un appel plutôt qu'un simple nom de méthode
  et une ligne.

**Vérifications exécutées** :
```
npm run typecheck   # 0 erreur
npm test             # 187/187 verts (186 avant + 1 nouveau test, aucun ignoré/affaibli)
npm run build         # web/dist généré, 217 kB / 69 kB gzip
```
Aucun script consommant du quota LLM n'a été lancé (bench/measure/report/e2e) :
le changement est entièrement couvert par les tests hors-ligne (`FakeLlmClient`).
