/**
 * Catalogue of the Guide tab — the seventeen sections, their groups, and the
 * words its search uses.
 *
 * ============================================================================
 * WHY THE GUIDE HAS A CATALOGUE OF ITS OWN
 *
 * `console.ts` opens by explaining why there are two catalogues rather than
 * one: `dictionary.ts` carries the code-analysis vocabulary, `console.ts` the
 * operations-centre one, they move at different rates and are read by
 * different eyes, and folding them together would have made every review
 * harder without simplifying anything. This is a third one by that same rule
 * — a hundred-odd points of explanatory prose are revised by whoever is
 * explaining the product, not by whoever is changing a screen.
 *
 * AND IT IS ALSO WHAT TAKES THAT PROSE OFF THE FIRST PAINT. `console.ts` is
 * imported by `i18n/context.tsx`, i.e. by everything, so a string sitting in
 * it is in the chunk the browser must have before the alert queue can appear
 * — whatever the screen that reads it. Measured on this repository's own
 * build, the Guide's sections were 34,907 of the eager chunk's 488,613 bytes.
 * Here, read by `DocsPanel` alone and by nothing else, they travel with the
 * tab: see the header of `guide-boundary.test.ts` for the numbers and for the
 * two halves that each do nothing on their own.
 *
 * THE TYPED-CATALOGUE RULE IS UNCHANGED, which is the point of moving the
 * block rather than pushing the strings into the component: `GuideDictionary`
 * still describes every key, a key added on one side only still fails to
 * compile, and no user-facing sentence lives in a `.tsx` file.
 * ============================================================================
 */

import type { Locale } from './dictionary.ts';

/**
 * Ou une section du Guide se range.
 *
 * ============================================================================
 * POURQUOI QUINZE TITRES A PLAT NE SE PARCOURENT PLUS
 *
 * L'en-tete du composant parlait de HUIT sections. Il y en a quinze, et
 * personne n'a repense la liste en les ajoutant. Quinze titres numerotes,
 * tous de meme poids, se lisent un par un : c'est un cout de DECISION, et son
 * remede est la categorisation — exactement le raisonnement applique a la
 * barre d'onglets principale.
 *
 * Quatre groupes, et aucune section ne disparait.
 * ============================================================================
 */
export type DocGroup = 'start' | 'work' | 'check' | 'around';

/** Une section de documentation : un titre, une accroche, des points. */
export interface DocSection {
  id: string;
  group: DocGroup;
  title: string;
  lede: string;
  points: Array<{ term: string; text: string }>;
}

/** The Guide's own vocabulary: its page head, its sections, its search. */
export interface GuideDictionary {
  kicker: string;
  title: string;
  lede: string;
  /** Intitules des quatre groupes, dans l'ordre d'affichage. */
  groups: Record<DocGroup, string>;
  sections: DocSection[];
  /** La recherche dans le Guide. */
  search: string;
  searchLabel: string;
  /** « 3 des 10 points » sur une section filtree. */
  pointsShown: (shown: number, total: number) => string;
  /** Nombre de points d'une section repliee. */
  points: (n: number) => string;
  /** Entete du bloc de resultats venant du glossaire. */
  glossaryHits: string;
  noMatch: (query: string) => string;
  clear: string;
  matches: (sections: number, points: number) => string;
}

const EN: GuideDictionary = {
  kicker: 'Documentation',
  groups: {
    start: 'Start here',
    work: 'Doing the work',
    check: 'Checking the system',
    around: 'Around the console',
  },
  search: 'Search the guide…',
  searchLabel: 'Search the guide',
  pointsShown: (shown, total) => `${shown} of ${total} points`,
  points: (n) => (n === 1 ? '1 point' : `${n} points`),
  glossaryHits: 'From the glossary',
  noMatch: (query) => `Nothing in the guide mentions “${query}”.`,
  clear: 'Clear the search',
  matches: (sections, points) =>
    `${points === 1 ? '1 point' : `${points} points`} in ${sections === 1 ? '1 section' : `${sections} sections`}`,
  title: 'How it works',
  lede:
    'Everything this application does, explained without jargon. Each section unfolds; start with the first one if the tool is new to you.',
  sections: [
    {
      id: 'overview',
      group: 'start',
      title: 'What the application does',
      lede:
        'MENATER watches two very different things on one screen, because they answer the same question: what threatens this system?',
      points: [
        {
          term: 'Alerts',
          text: 'What already happened. A security appliance reports something odd, an AI triages it, and a human approves any action that would not be harmless.',
        },
        {
          term: 'Code',
          text: 'What is about to happen. We read your code before it ships and show you the flaws it holds.',
        },
        {
          term: 'The rule that never moves',
          text: 'Nothing irreversible starts from this screen. The console shows, relays a human decision, and the pipeline is what acts.',
        },
        {
          term: 'Who does the work \u2014 no third party',
          text:
            'MENATER runs its own pipeline. Six workflows \u2014 receive, enrich, decide, route, audit, and an error handler \u2014 are compiled into the console itself and executed by its own engine, with its own database. There is no workflow platform to install, no external orchestrator to keep running, and no second product that has to be reachable for an alert to be triaged. What you deploy is three containers: the database, the console, and the code analysis.',
        },
        {
          term: 'What is written, and where',
          text:
            'Every decision produces a hash-chained audit row: you can verify afterwards that none was altered or removed. Alerts closed by a rule get one too — closing is not dropping.',
        },
      ],
    },
    {
      id: 'tabs',
      group: 'start',
      title: 'The ten tabs, and what each one is for',
      lede:
        'In the order the bar at the top puts them. Two of them — Alerts and Tracking — carry a '
        + 'counter when something needs you; the rest are places you go when you have a question.',
      points: [
        { term: 'Alerts', text: 'The triage queue and the incident card. What awaits a human decision rises to the top, and the counter on the tab is how many.' },
        { term: 'Code', text: 'Run a vulnerability analysis on a folder, a file or a repository, and read the report. It keeps running while you are on another tab.' },
        { term: 'Ingestion', text: 'How alerts get in \u2014 and what happens once they do. Three sections: the delivery architecture (webhook, polling, or the recommended hybrid of the two), the sources on each transport, and the pipeline as it runs: the graph of the five stages, the effect of each step, and the variables you can edit. It replaced the tab called \u201cWorkflow\u201d, which named the machinery instead of the question.' },
        { term: 'Tracking', text: 'The unreduced view. The queue shows CASES; this shows the RUNS behind them, including the ones that produced no case at all — broken chains, runs attached to nothing, replay.' },
        { term: 'Metrics', text: 'The two rates that decide whether the AI may act on its own. They do not say the same thing and are never mixed up.' },
        { term: 'Rules', text: 'Your own tuning: what is normal here, and what should stop reaching a human. A rule closes an alert; it never makes one act.' },
        { term: 'Health', text: 'The end-to-end connectivity test, and injecting a test alert through one of nine scenarios.' },
        { term: 'Lookup', text: 'Ask every threat-intelligence source you hold a key for about one IP address, domain, URL, file hash or email address — and check a password against the breach corpora without it leaving your browser. It reads; it writes nothing.' },
        { term: 'Guide', text: 'This page. Every feature explained without jargon, including what the application does not do.' },
        { term: 'Settings', text: 'Every setting, in sub-tabs: pipeline, access, database, display, credentials, log sources, MCP and the code-analysis engines. The checklist at the top names what is still missing.' },
        { term: 'Sharing a screen', text: 'The address bar names the tab you are on — #/alerts, #/health, #/code — so a copied link opens on that screen, and the browser\u2019s Back button walks back through the tabs you came from. It carries the tab and nothing else: a link does not reopen the incident you had open.' },
      ],
    },
    {
      id: 'start',
      group: 'start',
      title: 'Getting started: the four things to set',
      lede:
        "A fresh install is up in three minutes and triages nothing. That is not a fault: each of these four is a choice the console refuses to make for you. The checklist at the top of Settings tracks them.",
      points: [
        {
          term: '1. A shared secret',
          text:
            "Settings → Ingestion. Without it the front door stays CLOSED whatever mode you pick. That is deliberately the opposite of the usual habit: \u201cno authentication configured\u201d reads far too often as \u201cno authentication required\u201d, and an open endpoint accepts alerts from anyone — and an alert can lead to a machine being isolated.",
        },
        {
          term: '2. Open the door',
          text:
            "There are two: \u201cOpen\u201d has the built-in engine handle every alert that arrives, and \u201cClosed\u201d, the default, refuses everything. A shared secret is required either way \u2014 an empty one keeps the door closed rather than opening it to everyone.",
        },
        {
          term: '3. The model key',
          text:
            "Settings → Credentials. The only one whose absence changes EVERY decision: without it each alert takes the fail-safe verdict — needs_human, confidence 0, escalate. Nothing is lost, but nothing is triaged either, and you get a queue that sends 100% of its traffic to a human. It takes effect on the next alert, with no restart.",
        },
        {
          term: '4. A log source',
          text:
            "Settings → Ingestion → Sources. Pick your source and copy the generated configuration onto the machine that emits the alerts. Nothing to write on your side: normalization happens here.",
        },
        {
          term: 'Optional: Slack and enrichment',
          text:
            "With no Slack token, approval requests have nowhere to be posted — the pipeline carries on and says so. With no Shodan / AbuseIPDB / VirusTotal keys, those sources are shown as \u201cunavailable\u201d rather than filled in, and the model has to name them in its reasoning.",
        },
      ],
    },
    {
      id: 'queue',
      group: 'work',
      title: 'The Alerts tab',
      lede: 'The list is sorted by what blocks somebody, not by date.',
      points: [
        {
          term: 'Waiting on you comes first',
          text: 'An alert that has been waiting on your approval for twenty minutes goes above one closed thirty seconds ago. You never hunt for what needs you.',
        },
        {
          term: 'The confidence bar',
          text: '0.83 asks to be read; a bar is compared at a glance across forty rows. The number stays written beside it.',
        },
        {
          term: 'The “watch only” tag',
          text: 'A decision made in watch-only mode triggered nothing. Confusing the two means believing the system is acting when it is only looking.',
        },
        {
          term: 'The case sheet',
          text: 'One click opens the detail: what happened step by step, the intelligence gathered, the model’s decision and the facts it cites.',
        },
        {
          term: 'By system',
          text: 'The second view of this tab stacks, for one machine, the alerts raised against it and the flaws somebody promoted out of the code the service inventory says runs on it. It groups what is already in the queue and guesses nothing: an alert naming no machine of yours is counted apart rather than filed under a likely one, and an empty flaw list means none was promoted — never that the code is clean.',
        },
      ],
    },
    {
      id: 'approval',
      group: 'work',
      title: 'Human approval',
      lede: 'When the pipeline wants to act on your system, it stops and asks you.',
      points: [
        {
          term: 'Three things before you say yes',
          text: 'What the system proposes, what it touches, and how to undo it. An “Approve” button on its own would turn approval into a formality.',
        },
        {
          term: 'Silence is never consent',
          text: 'With no answer within the shown delay, nothing runs and the alert is escalated to a human.',
        },
        {
          term: 'Declining needs a reason',
          text: 'The reason is logged with the decision: it is what lets you understand later why the model got it wrong.',
        },
        {
          term: 'Your identifier is declarative',
          text: 'It is logged as typed, with no verification. The console password guards access; it identifies nobody.',
        },
      ],
    },
    {
      id: 'rules',
      group: 'work',
      title: 'The Rules tab',
      lede:
        "This is where your team teaches the console what is normal HERE: the authorised scanner, the backup window, the deployment account. Without that tuning an honest console alerts on everything, and a console that alerts on everything stops being read.",
      points: [
        {
          term: 'What a rule can do',
          text:
            "Four effects, and nothing else. Close an alert as known. Suppress it temporarily. Change its severity. Or demand a human whatever the model concludes. A rule can NEVER trigger an action: no effect reaches the action catalogue, and a text field is not where a machine gets cut off the network.",
        },
        {
          term: 'Closed is not dropped',
          text:
            "An alert closed by a rule still gets its audit row, with the rule name, its reason and its owner. It is simply handled without costing three enrichment calls and a model call. An alert nobody can find afterwards would be indistinguishable from one never received.",
        },
        {
          term: 'Why you are asked for TWO conditions',
          text:
            "\u201cIgnore this IP\u201d is the exception that gets abused: attackers use legitimate addresses and accounts, and a permanent allow on a single identity is a hole shaped like an intrusion. So the console refuses a permanent close that hangs on one address, user or host alone. Name the expected ACTIVITY as well — the scanner may trigger the port-scan rule; it may not exfiltrate data unnoticed.",
        },
        {
          term: 'Owner, reason, end date',
          text:
            "Required, and not paperwork. An exception nobody owns and nobody can justify is debt: in six months no one remembers why the console stopped looking, so no one dares remove it. \u201cSuppress\u201d additionally requires an end date — it is temporary by definition, and one with no end is an allow that has not admitted what it is.",
        },
        {
          term: 'First matching rule wins',
          text:
            "Rules are evaluated in priority order, lowest first, and evaluation stops at the first match. That is what lets \u201cwhy was this alert closed?\u201d be answered with ONE rule name: an engine combining them all would give an answer that changes as soon as an unrelated rule is added.",
        },
        {
          term: 'Try it before you trust it',
          text:
            "The panel at the bottom takes an alert as JSON and says which rule would answer it, without sending anything into the pipeline. The real question is never \u201cis my regex valid\u201d but \u201cwhy was this alert closed\u201d — and that one gets asked afterwards.",
        },
        {
          term: 'The templates',
          text:
            "Eight starting points, all arriving DISABLED and unowned: a starter pack that begins silencing alerts on install has decided something on your behalf. They are written as conjunctions, which is exactly the habit they exist to pass on.",
        },
        {
          term: 'An expired rule says so',
          text:
            "It stops applying but stays listed, at the top, marked. An exception that switches off in silence looks exactly like a rule that never worked. The list also surfaces rules that have never triggered — often the sign of one written for a problem that no longer exists.",
        },
      ],
    },
    {
      id: 'sources',
      group: 'work',
      title: 'Connecting a log source, and how alerts reach us',
      lede:
        "Wazuh, Splunk, Elastic, your own script: each writes alerts its own way. The console translates them into one shape, and it does that work — not you, and not the source.",
      points: [
        {
          term: 'Two transports, and they fail differently',
          text:
            "PUSH: the source calls our webhook the instant it detects something \u2014 one network hop, and you are as reliable as that source\u2019s own retry policy. PULL: we ask the source on our own clock, starting from a cursor we hold \u2014 about half a polling interval of delay, and nothing is lost to a call that never arrived. Neither is better; they cost different things.",
        },
        {
          term: 'Why hybrid is the default',
          text:
            "Because the cost of a delay is not the same for every alert. A critical alert contained four minutes late was not contained; a low alert triaged four minutes late is a low alert. So P1/P2 take the webhook and P3/P4 are polled, which also smooths the load: a source that emits a thousand alerts in a burst is read in batches you size instead of opening a thousand requests at us. Change it in Ingestion \u2192 Delivery; it applies to the next alert.",
        },
        {
          term: 'Nothing is refused for taking the wrong transport',
          text:
            "A P4 that arrives on the webhook is accepted and triaged like any other. The reply says which transport the policy expected, so you can re-point that source on purpose \u2014 dropping a detection over a routing preference would be the same mistake as rejecting an alert for a missing field.",
        },
        {
          term: 'A poll that finds nothing does not move the cursor',
          text:
            "A source that is down, slow or rate-limiting us returns nothing, exactly like a source where nothing happened. Advancing the cursor on the first case skips whatever it was holding, permanently. The cursor only ever moves to a timestamp read off an alert we actually received \u2014 and each poll reaches slightly further back than the cursor, because a source that timestamps at detection and indexes a second later would otherwise lose that second. Deduplication throws the repeats away.",
        },
        {
          term: 'One endpoint per source',
          text:
            "POST /api/ingest/wazuh, /api/ingest/generic… The ROUTE decides which mapping table applies, never the payload: a sender does not get to be taken for something else.",
        },
        {
          term: 'Wazuh in particular',
          text:
            "One file to copy into /var/ossec/integrations/, one block to paste into ossec.conf, done. The script translates NOTHING: it forwards the alert exactly as Wazuh wrote it. An integrator that maps fields turns \u201cadd a source\u201d into \u201cmaintain a parser on a production security appliance\u201d, invisible from the console and never tested.",
        },
        {
          term: 'What is required, and what is not',
          text:
            "Required: an id, a rule name, a severity, a date, the raw log. Optional: source address, destination, user, host, process, file, URL. Most real detections have NO destination — rejecting the alert over that would replace it with nothing, which is the harshest possible way to fill a gap.",
        },
        {
          term: 'An absent field stays absent',
          text:
            "It is never invented, nor replaced by an empty value that would look like data. It shows as absent on screen and is declared absent to the model. Direct consequence: an isolation cannot be proposed when no host is named.",
        },
        {
          term: 'Nothing is discarded',
          text:
            "Fields specific to your tool that the mapping cannot place travel intact in \u201cextensions\u201d. They are on the case and in the audit row — this is the raw material of a decision, and the last place where losing something is acceptable.",
        },
        {
          term: 'Severity is a policy',
          text:
            "Wazuh grades 0 to 15, the console in four steps. The default: 0-3 low, 4-7 medium, 8-11 high, 12-15 critical. \u201cLevel 8 is high\u201d is a judgement, not a fact — the full mapping is shown in Settings, beside the block to copy.",
        },
      ],
    },
    {
      id: 'engine',
      group: 'work',
      title: 'The pipeline, and who runs it',
      lede:
        'Every stage an alert goes through runs inside MENATER itself. There is no workflow platform behind it and nothing external has to be reachable for an alert to be triaged.',
      points: [
        {
          term: 'Six workflows, compiled in',
          text:
            '01-Ingestion receives and deduplicates, 02-Enrichment queries the intelligence sources, 03-AI-Decision asks the model and applies the guardrails, 04-Action-Routing decides what needs a human, 05-Audit-Log seals the record. 06-Error-Handler is called from the error branch of any of them and never sits in the normal sequence. They are TypeScript definitions in the console\u2019s own process, executed by its own engine.',
        },
        {
          term: 'There is no publish step, so there is nothing to forget',
          text:
            'The workflows cannot be half-deployed, renamed in an editor, or left unpublished, because there is no editor and no deployment. That removes a whole family of failures the console used to have to detect and report on \u2014 and it is why the connectivity test now checks the things that can still go wrong: the database, the schema, the model key, and the entry point.',
        },
        {
          term: 'The console reads its own journal',
          text:
            'Every run and every step is written to the database, and the triage queue, the metrics and the Tracking tab are built from exactly that. What you see on screen is the work this installation actually did \u2014 not a report about another product\u2019s state.',
        },
        {
          term: 'A step that writes is never replayed',
          text:
            'If the process dies mid-way through a call that changed the world \u2014 a Slack approval, a ticket, an audit row \u2014 the engine does NOT retry it on restart. The step becomes “undetermined” and rises to a human. Replaying it might send the same approval twice; guessing which happened is worse than asking.',
        },
        {
          term: 'The answer you get is the pipeline\u2019s own',
          text:
            'When you post an alert, the status code comes from the workflow: 202 accepted, 400 with the fields that were missing, 200 for a duplicate already seen, 500 when the deduplication store is unreachable. The entry point does not summarise \u2014 it hands back what the pipeline decided, so a sender whose alert was refused learns it, and learns why.',
        },
        {
          term: 'Deduplication is decided by the database',
          text:
            'The same alert sent many times at the same instant produces exactly one case: the uniqueness is enforced by the index itself, not by a check-then-insert that two simultaneous senders can both pass. Measured under load \u2014 twelve simultaneous copies give one acceptance and eleven “already seen”.',
        },
        {
          term: 'What it was measured at',
          text:
            '400 alerts injected at 50 at a time were all accepted, at roughly 120 alerts per second, and every chain finished. The audit hash chain was verified afterwards across the whole table: no fork, no altered row, and nothing left running.',
        },
      ],
    },
    {
      id: 'notify',
      group: 'work',
      title: 'Chat notifications, and how loud you want them',
      lede:
        'Three ways to connect a chat channel \u2014 two for Slack, one for Discord \u2014 and one setting that decides which alerts reach it. The second one has a consequence worth knowing before you change it.',
      points: [
        {
          term: 'The quick way: a webhook, Slack or Discord',
          text:
            'Create an incoming webhook \u2014 in Slack, or in a Discord channel under Edit Channel \u2192 Integrations \u2192 Webhooks \u2014 paste the URL into Settings \u2192 Credentials, and set the transport to "slack-webhook" or "discord-webhook". No app to install, no scopes to grant. Both platforms tie the URL to the one channel you chose when creating it, so everything the pipeline sends \u2014 approvals, escalations, incidents \u2014 arrives there. Treat the URL like a password: anyone holding it can post into that channel.',
        },
        {
          term: 'The flexible way: a Slack bot token',
          text:
            'A Slack app with a bot token can post to a different channel per purpose, which is what the four channel settings are for: approvals in one place, escalations in another, technical incidents in a third. It costs an app install and a scope, and it is the only transport that can route. This is the default, and nothing changes for an installation already using it.',
        },
        {
          term: 'Choosing the level you get notified at',
          text:
            '"Lowest severity that reaches your chat" does what it says: set it to high and only high and critical alerts are announced. Set it to off and the channel goes silent entirely. The default is low, meaning you hear about everything. It applies whichever transport you picked.',
        },
        {
          term: 'What raising it actually costs',
          text:
            'Most of what the pipeline sends is an approval REQUEST \u2014 a question. Below your threshold that question is not asked, and because nobody was asked, the alert is not left waiting thirty minutes for an answer that cannot come: it is escalated straight away and no action is executed on it. So raising the threshold does not only quieten Slack, it also means nothing at that severity gets approved. That is deliberate, and it is the safe direction.',
        },
        {
          term: 'Nothing disappears from the console',
          text:
            'A suppressed alert is still received, still triaged, still audited, and still in your queue with its verdict. Slack and Discord are notification channels; this screen is the record. The card says "below your threshold: no approval asked, nothing was run", so you can tell it apart from an alert the chat platform refused to accept.',
        },
        {
          term: 'Failing and being skipped are different things',
          text:
            'If the chat platform refuses a message \u2014 a bad token, a revoked webhook, a rate limit \u2014 the case says the request could not be posted, and names which. If your threshold suppressed it, the case says so instead. "We could not ask" and "we chose not to ask" need different fixes, so they are never merged into one sentence.',
        },
      ],
    },
    {
      id: 'metrics',
      group: 'check',
      title: 'The Metrics tab',
      lede: 'Two rates, never mixed up — the most important distinction in the whole project.',
      points: [
        {
          term: 'Human disagreement',
          text: 'The share of decisions put to a human that the human declined. It is the only figure that says whether the model is right, and it is what authorises going live.',
        },
        {
          term: '“False alarm” verdicts',
          text: 'How many alerts the model files that way. It describes what it does, not whether it is right. Showing that number alone and calling it an “error rate” would be a comfortable lie.',
        },
        {
          term: 'Fallback verdicts',
          text: 'Cases where the model produced nothing and the pipeline forced “human decision”. A rising rate announces a failure, not caution.',
        },
        {
          term: 'The 50-decision threshold',
          text: 'Below it, an error rate means nothing statistically. The pipeline stays in watch-only mode.',
        },
      ],
    },
    {
      id: 'health',
      group: 'check',
      title: 'The Health tab',
      lede: 'An end-to-end test, with four possible answers instead of two.',
      points: [
        {
          term: 'Four states',
          text: 'OK: verified. To watch: it works, but coverage is reduced. Failing: broken, with the fix. Undetermined: the console cannot conclude — and it says so rather than showing a reassuring green.',
        },
        {
          term: 'The most important check',
          text: 'The console reads exact step names inside the workflows. If someone renames one, it goes blind without saying so. The test catches that and names the missing step — run it after any workflow change.',
        },
        {
          term: 'Inject a test alert',
          text: 'Nine scenarios, one per PATH rather than per story: no destination, with a hash, low severity, malformed, duplicate… Each creates a real case in the list — unlike the connectivity probe, which is rejected before it enters. The alert goes into the console\u2019s own pipeline without passing through the front door: this is an identified human testing their own installation, not an appliance on the network.',
        },
      ],
    },
    {
      id: 'intel',
      group: 'work',
      title: 'The Lookup tab',
      lede:
        'The Lookup tab answers the question an alert leaves you with. The pipeline enriches '
        + 'automatically, but only what an alert happened to carry; this is where you ask about '
        + 'anything else — a value from a mail, a ticket, a colleague\'s message.',
      points: [
        {
          term: 'One field, five kinds',
          text:
            'Paste an IPv4 or IPv6 address, a domain, a URL, a file hash (MD5, SHA-1 or SHA-256) '
            + 'or an email address. The console works out which it is and asks only the sources '
            + 'that answer about that kind. If it reads it wrong, force the kind — auto-detection '
            + 'you cannot override is a wall the first time it is wrong.',
        },
        {
          term: 'Defanged values are welcome',
          text:
            'Indicators are written down neutralised so nobody clicks them: hxxp://, 1.2.3[.]4, '
            + 'evil(.)com, user[at]corp.com. Paste them as they are. The result always shows both '
            + 'what you typed and what was actually queried.',
        },
        {
          term: 'Three states, never two',
          text:
            'Every source reports Answered, Not asked, or Failed — the same three the enrichment '
            + 'step uses. A source with no key is Not asked, and that is not a hole in what is '
            + 'known: it is a question nobody put.',
        },
        {
          term: 'Why it will not say "clean" on its own',
          text:
            'The verdict is only Nothing against it when at least one source actually answered. '
            + 'With no keys configured every source skips, and the panel says No answer rather '
            + 'than printing reassurance over a value nobody looked at.',
        },
        {
          term: 'Flagged needs more than one engine',
          text:
            'A single VirusTotal detection out of seventy is the most common false positive there '
            + 'is, so it shows as Worth a look, not Flagged. Three engines, a named threat label, '
            + 'an AbuseIPDB confidence of 75% or more, a breach that leaked passwords, or an '
            + 'infostealer capture — those flag.',
        },
        {
          term: 'Private addresses are not sent anywhere',
          text:
            'A 10.x, 192.168.x, 127.x or link-local address is not on the Internet. Asking a '
            + 'reputation service about it would get an answer about somebody else\'s machine, so '
            + 'it is skipped and the card says why.',
        },
        {
          term: 'Have I Been Pwned, for an address',
          text:
            'With a HIBP key, an email address is checked against the breach corpora, the paste '
            + 'sites and — on a subscription that includes it — the infostealer logs. A 404 from '
            + 'that API means "in no breach", which is good news, and it is reported as an answer '
            + 'rather than as an outage.',
        },
        {
          term: 'Have I Been Pwned, for a password',
          text:
            'The password panel needs no key and is free. Your password is hashed in this browser; '
            + 'only the first five characters of the hash are sent, a few hundred candidates come '
            + 'back, and the comparison happens on the page. Nobody — this console included — '
            + 'learns what you typed. That is the k-anonymity model the API was designed around.',
        },
        {
          term: 'It spends your quota, so it remembers',
          text:
            'An answer is kept in the server\'s memory for one to twelve hours depending on the '
            + 'source, and a cached card says so with its age. "Ask again now" bypasses it. '
            + 'A rate limit is obeyed rather than retried: the card names the wait.',
        },
        {
          term: 'It writes nothing',
          text:
            'No case, no rule, no audit row, nothing on disk. A lookup is a read. The session '
            + 'history lives in this browser tab and disappears with it.',
        },
      ],
    },
    {
      id: 'trace',
      group: 'check',
      title: 'The Tracking tab',
      lede:
        'It answers one question: "I sent an alert, where did it go?" It shows runs, not cases.',
      points: [
        {
          term: 'Why an alert can look lost',
          text: 'The queue stitches runs together by alert id to display cases. A run with no readable id then shows up nowhere, and a chain that stops halfway looks like a normal case, only shorter. In the run journal both of them read as a success.',
        },
        {
          term: 'Broken chain',
          text: 'A step finished as "success" without passing anything to the next one. This is the worst case: nothing failed, and nothing happened. The screen names the exact step where it stops.',
        },
        {
          term: 'Stalled chain',
          text: 'No news for over five minutes, and not waiting for an approval. A human approval in progress is never counted here: that is a deliberate pause.',
        },
        {
          term: 'Runs attached to nothing',
          text: 'They ran and appear in no case. "Started empty" is the worst: the sub-workflow did start, with zero data. The connectivity probe produces some too — those are kept apart, as expected ones.',
        },
        {
          term: 'Finding one specific alert',
          text: 'Paste its id into the log search: you get every run that touched it at once, with its workflow, its status and the reason when it failed.',
        },
        {
          term: 'Replay',
          text: 'Sends the original payload back into the entry point. It repairs nothing and changes no workflow: it creates a new run. If the console does not hold the original payload, it refuses rather than replaying a reconstructed alert.',
        },
      ],
    },
    {
      id: 'code',
      group: 'work',
      title: 'The Code tab',
      lede: 'A security review of your code, explained for someone who is not a security expert.',
      points: [
        {
          term: 'What we look for',
          text: 'The most frequent and most costly flaws: reading other people’s data by changing a number in the address, injection into a database, script injection into a page, configuration left open.',
        },
        {
          term: 'A quote before launching',
          text: 'Before spending anything, the screen states how many places will be checked, how long it takes and what it costs. Nothing starts without your go-ahead.',
        },
        {
          term: 'Two passes, to avoid overpaying',
          text: 'A fast model reads all the code first. Only the doubtful cases — 10 to 15% — are reviewed by a more capable, more expensive model.',
        },
        {
          term: 'Three confidence zones',
          text: 'Below the first threshold it is dropped. Above the second it is reported directly. In between lies the grey zone, and that is what gets reviewed.',
        },
        {
          term: 'Full or incremental',
          text: 'The first time, everything is read. After that, only what changed since the last commit is re-analysed — the cheap everyday mode.',
        },
        {
          term: 'What is never billed twice',
          text: 'Two things cost nothing, and the screen tells them apart. "Settled without the AI" means plain rules were enough to conclude. "Already known" means a previous scan answered that exact question on that exact code — change one line and the question is asked again.',
        },
        {
          term: 'That memory survives a restart',
          text: 'What has already been answered is kept on disk, so restarting the service does not make you pay for it all over again. It can never apply to code that has moved: the answer is filed under the code it was given for. Settings shows how much is stored and offers a "Forget everything" button, which costs you one scan at full price and nothing else.',
        },
        {
          term: 'Several addresses at once',
          text: 'Addresses are checked a few at a time rather than one after another, which shortens the wait without changing what is found or what it costs. The number is in Settings; raising it too far only makes a free AI engine start refusing calls.',
        },
        {
          term: 'The report',
          text: 'Every finding is explained in plain language: what can happen, and which direction to fix it. The technical detail stays available, folded away.',
        },
        {
          term: 'An alert can fill the target in for you',
          text: 'If the service inventory in Settings says which repository runs on the machine an alert is about, the incident card carries a link here with the target already filled in. It only fills the box: nothing is estimated and nothing is scanned until you launch it.',
        },
      ],
    },
    {
      id: 'settings',
      group: 'around',
      title: 'The Settings tab',
      lede: 'Every block announces what happens when you save.',
      points: [
        {
          term: 'Applied immediately',
          text: 'Pipeline connection, password, refresh rate, language, code-analysis engines.',
        },
        {
          term: 'Pipeline credentials',
          text:
            'A sub-tab of its own, and its own place on disk: the model key, the Slack token, the enrichment keys. They take effect on the next alert, with no restart. A key already set by Docker or the shell is shown read-only with the reason — that is a deployment decision, and the console will not overwrite it silently.',
        },
        {
          term: 'Log sources',
          text:
            'The Ingestion sub-tab. The endpoint, the install commands and the configuration block are GENERATED from the address you reached the console on — not retyped from a README, where you copy \u201clocalhost\u201d onto another machine and then debug it for an hour.',
        },
        {
          term: 'Service inventory',
          text:
            'Which repository runs on which machine. An alert about a machine listed there carries a link to its code, so an incident and the defect behind it can be read side by side. Matching is exact — a hostname or an address, spelled as your alerts spell it. Nothing is guessed from a resemblance or an address range: a guessed repository would send you to read the wrong code while an incident is open.',
        },
        {
          term: 'Applies to the next alert',
          text: 'Notification channels, service addresses, TTLs and thresholds are pipeline variables: the engine reads them on every run, so a change reaches the next alert with nothing to restart. That is what separates them from the console settings, which take effect the moment you save.',
        },
        {
          term: 'Secrets never come back',
          text: 'A secret field shows “set” or “empty”, never the value. Leaving it empty keeps what exists. The browser can write a key, never read it back.',
        },
      ],
    },
    {
      id: 'assistant',
      group: 'around',
      title: 'The assistant',
      lede:
        'The chat bubble in the corner. It answers questions about THIS installation, it reads '
        + 'everything the screens read, and it can change nothing at all.',
      points: [
        {
          term: 'Ask it about what you are looking at',
          text:
            'Open an alert, then ask \u201cexplain this alert simply\u201d or \u201cwhat is the actual danger '
            + 'here?\u201d. It knows which alert is on your screen, so you never paste an identifier. '
            + 'With nothing open it answers about the queue: what is waiting, why nothing is being '
            + 'triaged, what is left to configure.',
        },
        {
          term: 'It reads live data, not its memory',
          text:
            'Every answer about this installation comes through a lookup, and the lookups reach what '
            + 'these screens reach: the queue, any alert in it and a search over them, other alerts like '
            + 'a given one, the chain behind one and the window as a timeline, why a verdict came out as '
            + 'it did, the tuning rules and what they would do to an alert, the metrics, the health '
            + 'report, the setup state, and the glossary of the words this console uses. Each answer '
            + 'says WHICH ones it used \u2014 \u201cLooked up: get_alert\u201d \u2014 so you can check it against the '
            + 'same screen.',
        },
        {
          term: 'It cannot do anything',
          text:
            'Not \u201cit asks first\u201d: there is no tool to approve, reject, isolate, close, replay, edit a '
            + 'rule or change a setting. It can tell you a case is waiting for you; it cannot answer for '
            + 'you. Every irreversible act in this product stays a deliberate click of yours.',
        },
        {
          term: 'Why it is deliberately powerless',
          text:
            'When you ask about an alert, you are asking about a log an ATTACKER composed \u2014 the URL, the '
            + 'user agent, the attempted username were all chosen by them before we stored them. Text '
            + 'like that reaches the assistant fenced and labelled as evidence, with a marker that '
            + 'changes on every question so no stored log can forge it. But the fencing is the second '
            + 'line: the first is that an instruction smuggled through a log arrives at something with '
            + 'no button to press.',
        },
        {
          term: 'If it says it did not look, believe it',
          text:
            'It is told to answer from what a lookup returned and to say when a field was not observed '
            + '\u2014 most real detections carry no destination address. \u201cThe detection did not record one\u201d '
            + 'is the correct answer; an invented address would be the same mistake the pipeline refuses '
            + 'to make. An answer that names no lookup is general knowledge, not a statement about your '
            + 'installation.',
        },
        {
          term: 'Your key, your provider',
          text:
            'Settings \u2192 In-console assistant. OpenRouter, Anthropic, OpenAI or Google, each reading its '
            + 'own key, set on that same screen. Leave the model empty to use the provider\u2019s default. '
            + 'Until a key is set the panel says which one is missing rather than failing at the first '
            + 'question, and switching it off removes the panel entirely.',
        },
        {
          term: 'What it costs, and where it stops',
          text:
            'Each question is capped: a number of lookups, a number of reasoning steps, and a time '
            + 'limit. When a cap is reached you still get an answer, and it SAYS it was capped \u2014 ask a '
            + 'narrower question rather than trusting a partial one. Nothing is stored on the server: '
            + 'closing the console ends the conversation.',
        },
      ],
    },
    {
      id: 'limits',
      group: 'around',
      title: 'What the console does not do',
      lede: 'The limits are written here rather than discovered at the wrong moment.',
      points: [
        {
          term: 'It runs no security action',
          text: 'This screen cuts nothing off the network, deletes nothing, and opens no ticket by itself. It shows, it relays a human decision, and the pipeline is what acts — under approval whenever the action is not harmless.',
        },
        {
          term: 'A rule cannot trigger an action',
          text: 'Not even one you wrote, not even an approved one. A tuning rule closes, softens, raises or demands a human. Nothing in that catalogue leads to a machine being isolated.',
        },
        {
          term: 'It does not fill in the blanks',
          text: 'Missing data is shown as missing — “no audit trail”, “fallback verdict”. A dashboard that fills gaps with defaults teaches you to trust it at the wrong moment.',
        },
        {
          term: 'The two halves do not talk yet',
          text: 'A code scan creates no alert, and an alert triggers no scan. That is the next piece of work.',
        },
      ],
    },
  ],
};

const CATALOGUE: Record<Locale, GuideDictionary> = { en: EN };

export function guideCatalogue(locale: Locale): GuideDictionary {
  return CATALOGUE[locale] ?? EN;
}
