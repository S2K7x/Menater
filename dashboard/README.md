# MENATER — Console

The SOAR console of the **AI SOC Mini** pipeline: triage queue, incident card,
human approval, operational metrics and a connectivity diagnostic — and, since
the merge, the **VulnPipe** code vulnerability analysis, on the same screen.

## This project runs in Docker

That is the normal way to install it. From the repository root:

```bash
cp .env.example .env && docker compose up -d --build
```

Then <http://localhost:4400>. See [the root README](../README.md).

In a container, **the API serves the interface itself** (`server/static.ts`):
one image, one origin, one access lock. An nginx alongside would have meant two
origins, so a lock protecting half the application — the question this project
already settled when it merged VulnPipe in.

---

## Development, with hot reload

```bash
npm install
npm run dev          # console API (4400) + analysis engine (4319) + interface (5174)
```

Then <http://localhost:5174>. Here **Vite** serves the interface and proxies
`/api` to the server: `dist/` does not exist, and the API answers its JSON 404
for any unknown route — the right behaviour for a malformed API call.

`npm run dev` starts all three processes. To run only one: `npm run serve`
(console API), `npm run serve:vulnpipe` (analysis engine), `npm run web`
(interface).

### A service already running is not a failure

Both services go through `scripts/start.ts`, which **probes the port before
starting** and distinguishes three situations:

| Situation | What happens |
|---|---|
| Nothing listening | Normal start |
| The **same** service already answers | Nothing is restarted, it is stated, `npm run dev` carries on and the interface attaches to it |
| **Something else** holds the port | Failure, with the port, the variable to change it, and the `lsof` command to see who has it |

Before, a forgotten `npm run serve` in another terminal killed `npm run dev`
with eight lines of `EADDRINUSE` — while everything worked. The probe queries a
health route and checks the shape of the answer: an open port does not prove it
is the right service.

---

## What the console is, and what it is not

It **has a database**, and that is where everything it shows comes from. While it only read another product's API it
had none: everything was rebuilt on the fly from runs. Since it carries its own
**workflow engine**, it needs a durable run log — a thirty-minute pending
approval has to survive a redeployment.

That reading is now the engine's own run journal. It will
go with it.

It **executes no security action without human approval**. The writes are
counted, and each one is deliberate:

| Route | Effect |
|---|---|
| `POST /api/approvals/:executionId/resume` | Relays an approval decision to the form holding the run |
| `POST /api/simulate` | Injects a test alert into **the console's own pipeline** — one of nine scenarios, **creates a real case** |
| `POST /api/diagnostics` | Probes the webhook with a deliberately invalid payload — **creates no case** |
| `POST /api/replay` | Replays an alert whose chain broke. **Refuses** if the original payload is unknown, rather than replaying a reconstructed alert |
| `PUT /api/settings` | Writes the console configuration to `config.json` |
| `PUT /api/credentials` | Writes the pipeline credentials to their own 0600 store. **Refuses** a key the real environment already sets |
| `PUT /api/workflows/variables` | Changes a pipeline variable. **Bounded to known keys**: an invented key would give the illusion of an applied setting |
| `POST` / `PUT` / `DELETE /api/rules` | Creates, changes or removes a tuning rule. Every write also appends to the rule history, in the same transaction |
| `POST /api/ingest/:source` | The alert entry point. **Closed by default**, and an empty shared secret closes it rather than opening it |
| `/api/vulnpipe/*` | Relayed as-is to the VulnPipe service — the console decides nothing, it carries |

No route isolates a host or closes an alert on its own initiative. A real action
must pass through a human approval, and the path there is checked by a test **on
the shape of the graph** — not only on the functions.

---

## Stitching runs into cases, which is the whole point

The engine thinks in **runs**: one record per workflow started. An analyst thinks in
**alerts**: one thing to settle, which crosses six workflows.

The two never coincide. In testing, two alerts produced **40 runs** — 25 of them
from the error handler alone. A console showing the raw trace would make the
analyst do that stitching in their head, forty times a day.

`server/engine/cases.ts` therefore groups runs by `alert_id` into a **case**, with its
timestamped processing chain. Repeated runs are folded into one line carrying
their count (`×8`): the amplification fault stays visible without cluttering the
reading.

---

## Connectivity diagnostic

**Health → Test connectivity**. About thirty checks:

| Group | What is checked |
|---|---|
| Access | Database reachability, SQL schema applied |
| Workflows | The six exist and are published |
| **Console contract** | The nodes whose output the console reads still exist |
| Chaining | Each `Execute Workflow` points at the right id; error workflow declared |
| Credentials | Postgres, Slack and authenticated HTTP nodes without an attached credential |
| Runs | Recent failure rate |
| Database | Missing table detected in traces |
| Configuration | Refused access to `$env` detected |
| Ingestion | The webhook answers and does reject an invalid payload |

### The node contract, and why this test is the most important

The console reads **exact node names** (`Finalize Decision + shadow_mode`,
`Assemble Enriched Payload`…). It is a fragile coupling, and an accepted one:
the node ids the console reads are a contract between `workflows/` and `cases.ts`.

The risk is real: someone renames a node in the editor, and the console goes
**blind without saying so** — it would show cases with no decision rather than
an error. That is the worst failure mode for a security tool.

The diagnostic turns that risk into a visible finding, and names the missing
node. **Run it after any workflow change.**

### Four states, not two

A test that could only say "green" or "red" would lie half the time.

- **OK** — verified, it works.
- **Watch** — it works, but something reduces coverage.
- **Failing** — broken, with the fix.
- **Undetermined** — the console cannot conclude. It opens no Postgres
  connection: it cannot *confirm* the schema is applied, only detect that it is
  not. A green shown there would be a useful lie.

---

## Not getting lost

The application does two jobs across ten tabs. Four objects hold the
orientation, from general to particular:

| Object | Where | What it settles |
|---|---|---|
| **Tab header** | Every tab | What you are looking at, what it is for, and a **"How does it work?"** link that opens the Guide **on the right section** |
| **Welcome card** | First visit | Three clickable ways in instead of a silent table. Dismissed on click, for good |
| **Waiting line** | Top of Alerts | "3 alerts are waiting for your approval" or "Nothing is waiting for you" — the question you came to ask, answered in words |
| **Glossary tooltip** | On the word | "Observation mode", "confidence", "human disagreement" explain themselves **in place**. Sending someone to the Guide to understand a word loses the page they were reading |

And one vocabulary rule, held everywhere: **a pipeline identifier is never shown
raw**. `shadow_logged` becomes "decision logged, nothing was executed",
`isolate_host_temporary` becomes "isolate the machine (temporarily)". A value
outside the catalogue is shown as-is — inventing would be worse than not
translating.

---

## Ten tabs, one application

| Tab | What you do there |
|---|---|
| **Alerts** | The triage queue and the incident card. What awaits a human decision rises to the top |
| **Code** | Run a vulnerability analysis on a folder, a file or a repository, and read the report |
| **Workflow** | The pipeline **as it runs**: the graph of the six workflows, the effect of each step, and the editable variables |
| **Rules** | The team's own tuning: what is normal here, and what should stop reaching a human |
| **Tracking** | The unreduced view — broken chains, runs attached to no alert, searchable log, replay |
| **Metrics** | The two rates that gate the switch to real mode |
| **Health** | The end-to-end connectivity test, and injecting a test alert |
| **Lookup** | Ask every threat-intel source you hold a key for about one IP, domain, URL, file hash or email address — and check a password against the breach corpora without it leaving your browser |
| **Guide** | Documentation of every feature, as an accordion |
| **Settings** | Every setting — pipeline, access, database, display, **credentials**, **log sources** and the code-analysis engines |

### Code analysis is no longer a separate product

What was called VulnPipe became a feature. There is no logo, no landing page,
no internal tab bar, no separate settings page:

- the **presentation** became a Guide section, with its three diagrams
  (pipeline, confidence zones, cost funnel);
- the **settings** (AI engines, arbitration, launcher defaults) are a block of
  the Settings tab.

A tab inside a tab loses someone discovering the tool, and doubles the places to
look for a setting.

### What is merged, and what is not

**Merged: the interface.** One web application, one origin, one access lock, one
build. The section lives in `src/vulnpipe/` and mounts on the tab's first visit —
then stays mounted: changing tab during a scan does not cut it. It is **loaded on
demand** (`React.lazy`): someone who only triages never downloads those 56 kB.

**Not merged: the engines.** The analyser indexes code with tree-sitter and calls
LLMs; the console API has no dependency at all. The two services run side by
side, and `server/vulnpipe.ts` relays `/api/vulnpipe/*` to the second. If the
analysis service is not running, the section shows **503 with the command to
run** — not an `ECONNREFUSED`.

### Three traps met at the merge

| Trap | What happened |
|---|---|
| **`keep-alive` on the relay** | A scan's SSE stream is cut when you leave the page; the socket returned to the pool poisoned the next request — an empty-bodied `400` **right after a successful scan**, shown as a failure. The relay now opens a fresh socket per request |
| **Class `.vp-scope` already taken** | The analyser uses it for an absolutely-positioned badge. The section container is called `.vp-embed` |
| **Two stylesheets stacked** | Both defined `:root`, `body`, `h1`… at different sizes. The analyser sheet no longer carries tokens or globals, and its bare element selectors are scoped under `.vp-embed` |

---

## English only

The console was bilingual. It is now English, and the **catalogue machinery was
kept**: user-facing strings live in `src/i18n/console.ts`, `src/i18n/dictionary.ts`
and `server/i18n.ts` rather than inside components. That is worth having with one
language as much as with two — a string in a catalogue is a string someone can
review, and a typed catalogue refuses a key added on one side only.

---

## Mobile

An on-call analyst looks at their phone first. Three things broke under 760 px,
and are fixed:

- the tab bar **scrolls horizontally**, it alone — not the page;
- the eight-column triage table becomes a **stack of cards**, each cell carrying
  its heading (`data-label`);
- touch targets go to **44 px**, and fields to `16px` font (below that, iOS
  zooms on focus by itself).

Under 520 px, action-button labels give way to the icon alone — the tabs keep
their text: a bar of bare icons would be a guessing game.

---

## What comes from the SOAR market

| Trait taken | Source | Where to see it |
|---|---|---|
| The queue as the main workstation | Cortex XSOAR | Triage tab, sorted by what blocks a human |
| Timestamped chain of custody | D3 Smart SOAR | "Processing chain" block on the card |
| MITRE ATT&CK tagging | Swimlane, D3 | "Techniques" block — heuristic, **stated as such** |
| Intent / blast radius / rollback before approval | challenge-and-response | Approval panel |
| Decision traceability (data lineage) | — | Fields cited by the model |

And one trait no SOAR displays because it is specific to this pipeline: the
**guardrails applied afterwards**. When the code corrected the model's output —
confidence capped, verdict forced to `needs_human` — it is written down, with
the original raw confidence. A system that silently corrects its AI ends up not
knowing which of the two it is observing.

Full roadmap: [../ROADMAP.md](../ROADMAP.md).

---

## Two rates, not one

The Metrics tab shows them separately:

- **"False positive" verdicts** — how many alerts the model classes that way.
  That is a *distribution* measure. It does not say whether it is right.
- **Human disagreement** — the share of decisions actually put to a human that
  they **rejected**. It is the only false-positive proxy observable without
  ground truth, and **it is the one** that gates leaving shadow mode.

Showing a single number called "false positive rate" would suggest reliability
was being measured when a habit was.

---

## LIVE / DEMO mode

The banner in the top right is permanent. Without `MENATER_N8N_API_KEY`, or if
the database does not answer, the console falls back to a demonstration set **and says
so** — an orange banner at the top of the page. The two never mix.

The demonstration cases deliberately cover the hard outcomes: fallback verdict,
degraded enrichment, expired approval, lost audit. A demo that only shows the
happy path proves nothing.

---

## Settings

The classic trap of a configuration page is presenting everything the same way:
the user saves, nothing changes, and they do not know why. Each section
therefore carries an effect label.

| Effect | Contents |
|---|---|
| **Applied immediately** | Access lock, refresh rate, run window, forced demo mode, **pipeline credentials**, code-analysis engines, ingestion |
| **Next execution** | Slack channels, endpoints, TTLs, thresholds. Pipeline variables, read on every run: a change applies to the next alert with nothing to restart |
| **To copy elsewhere** | Database: local Postgres / Supabase / other presets, reachability test, connection string and ready-to-copy `psql` commands |

**A setup checklist heads the page**: the four things still missing before an
alert can be triaged, each stated with its consequence, and gone once they are
done. A permanently lit banner stops being read.

### Pipeline credentials

Their own sub-tab and their own file, separate from `config.json`: the model
key, the Slack token, the enrichment keys. They take effect **on the next alert,
with no restart** — the engine reads `process.env` at call time.

Precedence is **real environment > this store > nothing**. A key already set by
Docker or the shell is shown read-only with the reason: that is a deployment
decision, and accepting a value that would never be used is the worse of the two
answers.

### Manual lookup — the Lookup tab

One field. Paste an IPv4 or IPv6 address, a domain, a URL, a file hash or an
email address; the console works out which it is, asks only the sources that
answer about that kind, and shows each of them in the enrichment pipeline's own
three states — **Answered**, **Not asked**, **Failed**.

Three things it refuses to do:

- **It will not say "clean" because nobody looked.** The verdict is only
  *Nothing against it* when at least one source actually answered; with no keys
  configured it says *No answer*, and the count of sources that answered sits
  next to the verdict on every result.
- **It will not flag on one engine.** A single VirusTotal detection out of
  seventy is the most common false positive there is, so it reads *Worth a
  look*. Three engines, a named threat label, an AbuseIPDB confidence of 75 % or
  more, a breach that leaked passwords, or an infostealer capture — those flag.
- **It will not send your password anywhere.** The Pwned Passwords panel hashes
  it in the browser with SHA-1, sends the first five characters of that hash,
  gets several hundred candidates back and does the comparison on the page.
  Free, no key, and asserted by a test on the actual request.

Defanged values are welcome — `hxxp://`, `1.2.3[.]4`, `evil(.)com`,
`user[at]corp.com` — and the result always shows both what you typed and what
was queried. Private addresses are skipped with the reason: `10.0.0.5` is not on
the Internet, and a reputation service would answer about someone else's
machine.

Answers are kept in the server's memory for one to twelve hours depending on the
source, because each one spends somebody's quota; a cached card says so with its
age, and **Ask again now** bypasses it. Nothing is written to disk, no case is
created, no audit row is added. Every observable on an incident card carries a
jump straight into this tab.

**Keys**: VirusTotal, AbuseIPDB and Shodan reuse the enrichment keys.
`HIBP_APIKEY` is the one this tab adds, and only the email lookups need it —
Shodan's InternetDB and the password check work with no key at all.

### Log sources

The Ingestion sub-tab lists the sources the console can normalize, and for each
one the endpoint, the install commands, the config block and the field mapping.
All of it is **generated from the address you reached the console on** — not
retyped from a README, where you copy `localhost` onto another machine and debug
it for an hour.

### Secrets never come back from the server

A secret field shows "set" or "empty", never the value. Leaving it empty
**keeps** the value; you must type something to replace it. The browser can
therefore write an API key, never read it back — which makes a forgotten tab or
a cache harmless.

`config.json` is written with `0600` permissions and excluded from Git.

### Access lock

A single password, scrypt-derived, a 12 h in-memory session, 8 failed attempts
then a 5-minute block per address. Enabling the lock without having set a
password is refused — otherwise the console would become unreachable.

> **This password protects access, it identifies nobody.** The approver's
> identity stays self-declared, and the interface keeps saying so. Confusing the
> two would give a false named audit trail.

### Database reachability test

The button opens a TCP connection to the host and port. It proves the port
answers — **and nothing more**: the console has no Postgres driver of its own
here, so it can check neither the credentials nor the existence of the tables.
The result says so explicitly rather than implying a full test.

---

## Configuration

Copy `.env.example` to `.env` (bootstrap; the Settings page takes over after
that):

```
MENATER_N8N_URL=http://10.100.102.100:5678
MENATER_API_PORT=4400
VULNPIPE_API_PORT=4319
```

The older `SOC_*` names are still accepted as a fallback, so an existing `.env`
does not break. `VULNPIPE_API_URL` replaces the analysis service host if it does
not run locally.

### The database coordinates

`MENATER_DB_HOST`, `MENATER_DB_PORT`, `MENATER_DB_NAME`, `MENATER_DB_USER` and
`MENATER_DB_PASSWORD`. **In Docker, compose sets them for you** — only the
password comes from `.env`. You set them by hand for a manual install.

**They come from the environment and win over the file.** A `config.json`
written once with the `localhost` default would otherwise mask them forever,
and the engine would keep looking for a database inside its own container —
which is exactly the defect the QA pass found: every ingested alert lost its run
to `ECONNREFUSED`, and nothing in the interface said so.

---

## Code architecture

```
server/
  api.ts           HTTP server with no dependency
  vulnpipe.ts      relay /api/vulnpipe/* to the code analysis service
  config.ts        configuration store, secret masking, scrypt
  credentials.ts   pipeline credentials, 0600, environment wins
  rules-store.ts   tuning rules, with append-only history
  scenarios.ts     the nine test alerts, one per path
  auth.ts          sessions, HttpOnly cookie, attempt throttling
  engine/cases.ts  collector: runs → cases + trace
  engine/attack.ts ATT&CK tagging
  diagnostics.ts   the ~30 connectivity checks
  demo.ts          demonstration set
  i18n.ts          server catalogue (diagnostic, chain, sample set)
  engine/          the workflow engine: graph, nodes, transforms, Postgres store
    transforms/
      tuning.ts        the rule matcher: operators, CIDR, validation
      normalize.ts     one mapping table per log source
src/
  App.tsx          ten tabs, refresh, mode banner
  components/      AlertQueue, CaseView, MetricsPanel, HealthPanel, SettingsPage,
                   SettingsSetup, RulesPage, Notices, DocsPanel, Icon
  i18n/            language context + console.ts and dictionary.ts catalogues
  lib/             shared server/client types, HTTP client
  styles.css       visual system, and all the responsive rules
  vulnpipe/        the code analysis section
    VulnPipeSection.tsx  the launcher and the report; also exports its settings
    components/          launcher, estimate, live activity, report, diagrams
    lib/                 HTTP client (/api/vulnpipe prefix), scan state
    styles.css           `vp-*` classes, scoped under `.vp-embed`
```

`npm test` runs 620 tests. The interface tests came from the analyser and
followed it in.

Roadmap: **[../ROADMAP.md](../ROADMAP.md)**, one list for the whole product.

The CSS prefix stays `soc-`: it describes the domain (security operations
centre), not the brand, and renaming it would have changed nothing for the user.

---

## Known limits

- **The approver's identity is self-declared.** The form does not authenticate
  it; the card says so explicitly (`identity_source: console_self_declared`).
- **Database health is inferred**, not measured, in the diagnostic: it opens no
  Postgres connection there.
- **ATT&CK tagging is heuristic** — pattern matching on the rule name and the
  raw log, shown as such.
- **No distinct roles**: the lock is a single shared password. Reading, analysis
  and approval are not separated.
- Rebuilding cases is two queries; a 15 s cache keeps ten open tabs off the database.
  That is the reason for the slight delay after an injection.
- History is limited to the **last 120 runs**.
- **The two halves do not talk yet.** A VulnPipe scan creates no case in the
  triage queue, and a SOC alert triggers no scan. The merge is the interface's;
  bringing the two flows together remains to be done.
- **VulnPipe keeps its state in memory.** Restarting the service loses past
  scans: the section has no history, only the scan in progress.
- **Without a model key, every alert takes the fail-safe verdict.** The pipeline
  runs, nothing is lost, and nothing is triaged either. The setup checklist says
  so, and so does the console at startup.
