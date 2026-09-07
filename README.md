# MENATER

A security console in two halves, in one web application:

- the **SOC** handles what *has already happened* — an alert is already an incident;
- **VulnPipe** handles what *is about to happen* — a flaw in the code, before it ships.

**→ [menater.vercel.app](https://menater.vercel.app)** — what the product is, what
it refuses to do, and what it does not do yet, with screenshots of a running
install. Read that first if you are here to find out what this is.

---

## This project is built to run in Docker

That is the **normal** way to install it, not a deployment option. Three
commands, on any host:

```bash
cp .env.example .env          # fill in the two passwords
docker compose up -d --build
```

Then <http://localhost:4400>.

**Nothing else is required.** No Node to install, no Postgres to configure, no
SQL schema to apply by hand, no workflow engine to install, no third machine.
The stack is
self-contained and behaves the same on a Mac, on Linux, or on a Raspberry Pi.

### Three services

| Service | Role | Port |
|---|---|---|
| `console` | Interface, API, and the workflow engine | 4400 |
| `postgres` | Run log, audit, deduplication, variables, tuning rules | internal |
| `vulnpipe` | Code vulnerability analysis | internal |

**One port is published.** The database and the analyser are reachable only
from the compose network: the console relays `/api/vulnpipe/*` to the second,
and nobody talks to the database directly. One origin, one lock — a second
entry point would be a lock protecting half the application.

---

## After `up`: the four things to set

The stack comes up in three minutes and triages nothing. That is not a fault —
each of these is a choice the console refuses to make for you. **The checklist
at the top of Settings tracks all four**, and disappears when they are done.

| # | What | Where | If you skip it |
|---|---|---|---|
| 1 | **Shared secret** | Settings → Ingestion | The endpoint stays **closed** whatever mode you pick |
| 2 | **Open the door** — mode `Primary` | Settings → Ingestion | Every alert is refused |
| 3 | **Model key** (OpenRouter) | Settings → Credentials | **Every** alert takes the fail-safe verdict: `needs_human`, confidence 0. Nothing is lost, but nothing is triaged |
| 4 | **A log source** | Settings → Ingestion → Sources | No alerts arrive |

Slack and the enrichment keys (Shodan, AbuseIPDB, VirusTotal) are optional. A
missing enrichment source is shown as *unavailable* rather than filled in, and
the model has to name it in its reasoning.

> **On the ingestion mode.** There are two: `Closed`, the default, which
> refuses everything, and `Open`, where the built-in engine handles alerts. A
> shared secret is required either way — an empty one keeps the door closed
> rather than opening it to everyone.

---

## Connecting a log source

Alerts arrive at `POST /api/ingest/<source>`. **The route decides which mapping
applies** — never the payload, so a sender cannot claim to be something else.
Settings → Ingestion generates the endpoint, the install commands and the
config block, using the address you reached the console on.

### Wazuh

One file to copy, one block to paste — see
[integrations/wazuh/README.md](integrations/wazuh/README.md).

```bash
scp integrations/wazuh/custom-menater root@wazuh-manager:/var/ossec/integrations/
chmod 750 /var/ossec/integrations/custom-menater
chown root:wazuh /var/ossec/integrations/custom-menater
systemctl restart wazuh-manager
```

The script **maps nothing**: it forwards the alert exactly as Wazuh wrote it,
and the console does the translation. An integrator that maps fields turns "add
a log source" into "maintain a parser on a production security appliance",
unversioned and invisible from the console.

### What an alert must carry

| Tier | Fields | Rule |
|---|---|---|
| **Identity** | `alert_id`, `rule_name`, `severity`, `timestamp`, `raw_log` | Required. Missing means rejected, and the rejection names them |
| **Observables** | `source_ip`, `dest_ip`, `user`, `host`, `process`, `file_path`, `url` | Optional. Absent stays absent — never invented, never an empty string |
| **Extensions** | everything else | Kept whole. Nothing your tool sends is discarded |

Most real detections have no destination address. That is why `dest_ip` is
optional: rejecting the alert over it would replace it with nothing.

---

## Tuning rules

The **Rules** tab is where a team teaches the console what is normal *here* —
the authorised scanner, the backup window, the deployment account. Without it
an honest console alerts on everything, and one that alerts on everything stops
being read.

A rule can **close** an alert as known, **suppress** it temporarily, **change
its severity**, or **demand a human**. It can never trigger an action: no rule
effect reaches the action catalogue.

Three things the console refuses, each matching an exception shape that is
known to go wrong:

- a permanent `allow` keyed on **one identity field** alone — attackers use
  legitimate addresses and accounts, so that is a hole shaped like an intrusion;
- a `suppress` with **no expiry** — it is temporary by definition;
- a rule with **no owner or no reason** — an exception nobody owns is one
  nobody dares remove later.

Eight templates ship **disabled and unowned**, all written as conjunctions. The
dry-run panel answers *which rule would match this alert* without touching the
pipeline.

---

## Testing it

**Settings → Health → inject a test alert** offers nine scenarios, one per
*path* rather than per story: no destination, with a hash, low severity,
malformed, duplicate, and so on. Each creates a real case; the malformed one is
rejected on purpose, and the duplicate one exercises deduplication.

---

## One profile, off by default

```bash
docker compose --profile tunnel up -d   # exposure to the Internet
```

`tunnel` opens a Cloudflare tunnel to the alert endpoint. **Only enable it
after setting a shared secret** in Settings → Ingestion: without one the
endpoint stays closed, but the tunnel would already be open.

They are off by default because a service you do not know you started is a
service you are not watching — and one of the two opens a door to the Internet.

### What the stack does for itself on first start

- creates the database and the application role;
- applies the files in `sql/` in order — audit with hash chaining, error log,
  engine run log, deduplication, metrics function, tuning rules;
- starts the three services, each with its health probe.

Data lives in named volumes: it survives `docker compose down` and
`up --build`. To start over — **including the database**: `docker compose down -v`.

---

## Development

Docker is still the normal mode. To work on the code with hot reload:

```bash
cd dashboard && npm install
npm run dev     # API (4400) + code analysis (4319) + Vite interface (5174)
npm test        # 953 tests
```

See [dashboard/README.md](dashboard/README.md).

The Postgres store tests are **skipped** without a database — and say so. To
run them against the Docker stack:

```bash
MENATER_TEST_PG=postgres://menater:<password>@localhost:5432/menater_test npm test
```

---

## The presentation site

[`site/`](site/) is a static page describing the project, deployed on Vercel at
**[menater.vercel.app](https://menater.vercel.app)**. It is not part of the
console and the Docker stack does not serve it: nothing in `docker-compose.yml`
knows it exists.

| File | Holds |
|---|---|
| `site/page.src.html` | **The source**, English in the clear. `<!--SHOT:name-->` marks where a screenshot goes, `data-i18n="key"` what translates |
| `site/i18n/fr.json` | The French, against the same keys |
| `site/shots/` | Seven screenshots of a running install, and `captions.json` beside them |
| `site/index.html` · `site/fr/index.html` | Generated — what Vercel serves at `/` and `/fr`. HTML plus seven cached PNGs |
| `site/page.html` · `site/page.fr.html` | Generated — the same pages with the images inlined, for hosts that block external images |
| `site/build.sh` | Writes the four outputs from the one source |

```bash
cd site && ./build.sh     # after editing page.src.html, a caption or a catalogue
```

**Two languages, and the URL is the whole state.** `/` is English, `/fr` is
French, each with its own `lang` attribute and `hreflang` pair; the switcher is
two links that carry your anchor across. No cookie, no header sniffing, no
redirect — a link somebody shares opens in the language they shared it in, and
the page never arrives in one language and repaints in another. **A key present
on one side only fails the build**, naming it: the typed-catalogue rule the
console applies to `console.ts`, applied to a page.

### Deploying it

**Root Directory is `site`, and that is the only setting.** Vercel's importer
scans the repository for a framework, finds `dashboard/` — a Vite app — and
offers to build the console instead, pre-filling seventeen environment
variables from the root `.env.example` along the way. Pointing it at `site/`
removes the question: that folder has no `package.json` and no `.env.example`,
so there is nothing to detect and nothing to ask for.

| Setting | Value |
|---|---|
| Root Directory | **`site`** |
| Framework Preset | **Other** |
| Build / Install Command | leave empty |
| Environment Variables | **none** — the page is static and reads nothing |

`site/vercel.json` carries the rest: long-lived caching on the screenshots,
which never change under their own name, and the three headers a public page
should not be without. `site/.vercelignore` keeps the generator and the inlined
variant off the public host.

**Every screenshot is a real screen**, taken against `docker compose up` with
alerts injected through the real pipeline — no mockups, and none of them is a
console with nothing in it. The captions say what state the install was in,
including that no model key was configured, which is why every verdict on them
reads `fallback verdict`. A page about a product that refuses to fill a gap with
a default cannot itself show an invented one.

---

## Where to look next

| File | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Architecture, design rules, and the traps that cost time |
| [ROADMAP.md](ROADMAP.md) | What is delivered, what is coming, and why — one list for both halves |
| [dashboard/README.md](dashboard/README.md) | The console in detail |
| [integrations/wazuh/README.md](integrations/wazuh/README.md) | Connecting Wazuh, end to end |
| [VulnPipe/README.md](VulnPipe/README.md) | The code analysis engine |

The **Guide** tab documents every feature from inside the application, which is
where the question usually gets asked.

---

## Two rules that explain the rest

**No irreversible action without explicit human approval.** The action
catalogue is closed: `isolate_host_temporary` (with a TTL and automatic
revert), `ticket`, `escalate`, `auto_close`. Nothing else is implementable,
not even behind an approval — and no tuning rule can reach it.

**Silence is never consent.** An approval that expires executes nothing: it
escalates. And missing configuration cannot enable execution — shadow mode is
on by default, and only the exact string `false` turns it off.
