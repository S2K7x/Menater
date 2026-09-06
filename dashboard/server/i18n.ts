/**
 * Catalogue des messages produits par le SERVEUR de la console.
 *
 * ============================================================================
 * POURQUOI LE SERVEUR AUSSI
 *
 * Traduire seulement l'interface donne un écran à moitié anglais : les
 * libellés de colonnes changent de langue, mais « Node « Validate Alert Schema »
 * absent : la chaîne est rompue » reste en français, et c'est précisément la
 * phrase que quelqu'un doit comprendre pour réparer son installation.
 *
 * Le diagnostic, les notes de chaîne de traitement et le jeu de démonstration
 * sont donc rédigés ici, dans les deux langues, et rendus dans celle que le
 * client demande (`?locale=`).
 *
 * ============================================================================
 * TYPÉ, COMME LE CATALOGUE DE L'INTERFACE
 *
 * Une clé ajoutée d'un seul côté ne compile pas. C'est le seul garde-fou qui
 * tienne : personne ne relit deux fois mille lignes de messages d'erreur.
 * ============================================================================
 */

export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Normalise ce qui arrive de la requête. Tout le reste retombe sur le défaut. */
export function normalizeLocale(raw: unknown): Locale {
  return typeof raw === 'string' && (LOCALES as readonly string[]).includes(raw)
    ? (raw as Locale)
    : DEFAULT_LOCALE;
}

export interface ServerMessages {
  /** Refus d'écriture sur les variables de pipeline. */
  variables: {
    unknownKeys: (keys: string) => string;
    notANumber: (key: string, value: string) => string;
  };
  /** Groupes du diagnostic : ils servent de titres de section à l'écran. */
  groups: {
    access: string;
    workflows: string;
    contract: string;
    chain: string;
    credentials: string;
    executions: string;
    database: string;
    config: string;
    ingestion: string;
  };

  diag: {
    dbLabel: string;
    dbNotConfigured: string;
    dbReachable: (host: string, name: string) => string;
    dbRemedy: string;

    schemaLabel: string;
    schemaOk: (count: number) => string;
    schemaMissing: (tables: string) => string;
    schemaRemedy: string;

    modelKeyLabel: string;
    modelKeySet: (source: string) => string;
    modelKeyMissing: string;
    modelKeyRemedy: string;

    slackLabel: string;
    shodanLabel: string;
    abuseLabel: string;
    vtLabel: string;
    credSet: (source: string) => string;
    credMissing: string;

    contractLabel: (workflow: string) => string;
    contractOk: (count: number) => string;
    contractMissing: (nodes: string) => string;
    contractNoWorkflow: string;
    contractRemedy: string;

    execLabel: string;
    execSeen: (count: number) => string;
    execNone: string;
    execNoStore: string;

    webhookLabel: string;
    webhookSkipped: string;
    webhookClosed: string;
    webhookRemedy: string;
    webhookNoSecret: string;
    webhookSecretRemedy: string;
    webhookOk: string;
    webhookUnexpected: (status: number, reason: string) => string;
  };

  /** Notes de la chaîne de traitement, reconstruites depuis les exécutions. */
  stages: {
    received: string;
    rejected: (errors: string) => string;
    dedupUnavailable: (error: string) => string;
    sources: (ok: string, degraded: boolean) => string;
    noneLabel: string;
    /** Verdicts du modèle, en clair. Inconnu = rendu tel quel. */
    verdicts: Record<string, string>;
    decision: (verdict: string, confidence: number | null, fallback: boolean) => string;
    awaitingApproval: string;
    approved: (who: string) => string;
    /**
     * Issue du routage, en clair.
     *
     * Le pipeline produit des identifiants (`shadow_logged`, `auto_closed`).
     * Les afficher tels quels dans la chaîne de traitement demandait au
     * lecteur de deviner : la table ci-dessous les traduit, et tout ce qui
     * n'y figure pas est rendu tel quel — inventer serait pire.
     */
    outcomes: Record<string, string>;
    auditSealed: (row: number) => string;
    auditLost: (failure: string) => string;
    errorHandled: (code: string) => string;
    unknown: string;
  };

  /**
   * Jeu d'exemple.
   *
   * Ses phrases sont ici pour la même raison que les autres : quelqu'un qui
   * découvre l'outil en anglais tombe d'abord dessus, et un écran de
   * démonstration à moitié français ne démontre rien.
   */
  demo: {
    isolateIntent: (host: string, minutes: number) => string;
    isolateBlast: (host: string, minutes: number) => string;
    isolateRollback: (minutes: number) => string;
    fileServerBlast: (minutes: number, seats: number) => string;
    shortRollback: string;
    triggerContainment: (action: string) => string;
    triggerConfidence: (value: number) => string;
    triggerBelow: (value: number, floor: number) => string;
    triggerNeedsHuman: string;
    escalateIntent: string;
    escalateBlast: string;
    escalateRollback: string;
    approvedReason: string;
    cappedConfidence: (value: number, sources: string) => string;
    forcedNeedsHuman: (floor: number) => string;
    fallbackReasoning: string;
    modelUnavailable: (attempts: number) => string;
    auditWriteFailed: (attempts: number) => string;
  };

  /** Réponses des routes : tests de connexion, approbations, injection. */
  api: {
    authRequired: string;
    tooManyAttempts: (seconds: number) => string;
    wrongPassword: string;
    passwordFirst: string;
    urlMissing: string;
    keyMissing: string;
    keyRefused: string;
    answered: (status: number) => string;
    connected: (host: string) => string;
    hostMissing: string;
    portCaveat: string;
    caseNotFound: (id: string) => string;
    ruleNotFound: (id: string) => string;
    /** No database means the rules cannot be READ, which is not "no rules". */
    rulesNoDatabase: string;
    simulateNoEngine: string;
    simulateStarted: (scenario: string, status: string) => string;
    approverRequired: string;
    engineUnavailable: string;
    approvalUnknownToken: string;
    approvalFailed: (error: string) => string;
    approvalUnreachable: (error: string) => string;
    approvalSent: string;
    approvalRefused: (status: number) => string;
    webhookUnreachable: (error: string) => string;
    unknownRoute: string;
    replayUnknownCase: (id: string) => string;
    replayNoPayload: (id: string) => string;
    replaySent: (id: string) => string;
    replayRefused: (status: number) => string;
    replayUnreachable: (error: string) => string;
  };

  /** État lisible de la source de données, affiché dans l'onglet Santé. */
  health: {
    forcedDemo: string;
    noApiKey: string;
    noDatabase: string;
    auditLostRows: (n: number) => string;
    noRecentRuns: string;
    unreachable: (error: string) => string;
    casesRebuilt: (count: number) => string;
    auditOk: string;
    auditUnknownInDemo: string;
    /** Constats bloquants : ils restent affichés tant qu'ils sont observés. */
    findingNoAudit: string;
    findingModelUnavailable: string;
    findingReplay: string;
    findingNothingPublished: string;
    findingBrokenChains: (n: number) => string;
    findingStalledChains: (n: number) => string;
    findingOrphanRuns: (n: number) => string;
  };
}

/* ==========================================================================
 * FRANÇAIS
 * ========================================================================== */


/* ==========================================================================
 * ENGLISH
 * ========================================================================== */

const EN: ServerMessages = {
  variables: {
    unknownKeys: (keys) =>
      `Unknown variable(s): ${keys}. A key no workflow reads would look like a setting that applies — and it would not.`,
    notANumber: (key, value) => `"${key}" expects a number, got "${value}".`,
  },
  groups: {
    access: 'Access',
    workflows: 'Workflows',
    contract: 'Console contract',
    chain: 'Chaining',
    credentials: 'Credentials',
    executions: 'Runs',
    database: 'Database',
    config: 'Configuration',
    ingestion: 'Pipeline entry point',
  },

  diag: {
    dbLabel: 'Database',
    dbNotConfigured:
      'No coordinates: the engine is not mounted, so every alert dies before it '
      + 'is triaged \u2014 and the failure shows only inside a webhook reply.',
    dbReachable: (host, name) => `Reachable \u2014 ${host}, database \u201c${name}\u201d.`,
    dbRemedy: 'Settings \u2192 Database, or MENATER_DB_* in the environment.',

    schemaLabel: 'SQL schema applied',
    schemaOk: (count) => `The ${count} tables the pipeline writes are present.`,
    schemaMissing: (tables) =>
      `Missing: ${tables}. Runs, audit or deduplication will fail at write time.`,
    schemaRemedy:
      'The sql/ files run on the database\u2019s FIRST start only. On an existing '
      + 'stack, apply them by hand with psql.',

    modelKeyLabel: 'Triage model key',
    modelKeySet: (source) => `Set (from the ${source}).`,
    modelKeyMissing:
      'Absent: every alert takes the fail-safe verdict \u2014 needs_human, '
      + 'confidence 0, escalate. The pipeline runs and nothing is triaged.',
    modelKeyRemedy: 'Settings \u2192 Credentials, or OPENROUTER_APIKEY in the environment.',

    slackLabel: 'Slack (approvals, escalation)',
    shodanLabel: 'Shodan (enrichment)',
    abuseLabel: 'AbuseIPDB (enrichment)',
    vtLabel: 'VirusTotal (enrichment)',
    credSet: (source) => `Set (from the ${source}).`,
    // A WARNING, never a failure: a pipeline with no threat-intelligence key
    // still triages, it just triages on less.
    credMissing: 'Absent: this source is never queried, and says so on the case.',

    contractLabel: (workflow) => `${workflow} \u2014 nodes the console reads`,
    contractOk: (count) => `The ${count} node outputs the console builds a case from are present.`,
    contractMissing: (nodes) =>
      `Missing: ${nodes}. The console would show cases with pieces absent rather than an error.`,
    contractNoWorkflow: 'Workflow not registered in the engine.',
    contractRemedy:
      'A node id was renamed in server/engine/workflows/ without updating '
      + 'NODE_CONTRACT in server/engine/cases.ts. The two must move together.',

    execLabel: 'History',
    execSeen: (count) => `${count} recent run(s) in the journal.`,
    execNone: 'No run yet: real health cannot be judged.',
    execNoStore: 'No database: the run journal cannot be read.',

    webhookLabel: 'Entry point /api/ingest',
    webhookSkipped: 'Probe disabled for this diagnostic.',
    webhookClosed: 'The entry point is closed: no alert can come in.',
    webhookRemedy: 'Settings \u2192 Ingestion, after setting a shared secret.',
    webhookNoSecret:
      'No shared secret: the entry point stays CLOSED rather than open to '
      + 'everyone. An alert is what triggers isolating a machine.',
    webhookSecretRemedy: 'Set a shared secret in Settings \u2192 Ingestion.',
    // 400 IS THE PASS: the probe is invalid on purpose, so a rejection proves
    // the route, the secret, the normalizer and the validator all work.
    webhookOk: 'The probe was rejected as invalid, which is the expected answer: the path works end to end.',
    webhookUnexpected: (status, reason) =>
      `Unexpected answer: HTTP ${status}${reason ? ` (${reason})` : ''}. `
      + 'An invalid probe should be refused with a 400.',
  },

  stages: {
    received: 'alert received and validated',
    rejected: (errors) => `rejected: ${errors}`,
    dedupUnavailable: (error) => `deduplication unavailable: ${error}`,
    sources: (ok, degraded) => `sources queried: ${ok}${degraded ? ' — incomplete intelligence' : ''}`,
    noneLabel: 'none',
    verdicts: {
      true_positive: 'real threat',
      false_positive: 'false alarm',
      needs_human: 'human decision required',
    },
    decision: (verdict, confidence, fallback) =>
      `${verdict}${confidence === null ? '' : ` (confidence ${confidence})`}${fallback ? ' — fallback verdict' : ''}`,
    awaitingApproval: 'waiting on a human approval',
    approved: (who) => `accepted by ${who}`,
    outcomes: {
      shadow_logged: 'decision logged, nothing was run (watch-only mode)',
      auto_closed: 'alert closed automatically: nothing to do',
      ticket_created: 'ticket raised for an analyst',
      timeout_escalated: 'expired with no answer: escalated, nothing was run',
      approved: 'approval accepted by a human',
      rejected: 'approval declined by a human',
      isolate_host_temporary: 'host cut off the network, temporarily',
      escalated: 'escalated to an analyst',
      // Nobody was asked, so nothing waited. Distinct on purpose from
      // `approval_request_failed`: "we chose not to ask" and "we could not
      // ask" call for different fixes.
      not_notified: 'below your notification threshold: no approval asked, nothing was run',
      approval_request_failed: 'approval request could not be posted: escalated, nothing was run',
    },
    auditSealed: (row) => `audit row #${row} sealed`,
    auditLost: (failure) => `audit write LOST: ${failure}`,
    errorHandled: (code) => `technical incident handled: ${code}`,
    unknown: 'step with no detail',
  },

  demo: {
    isolateIntent: (host, minutes) =>
      `Temporarily cut ${host} off the network for ${minutes} minutes (network quarantine: the machine stays powered on and reachable from the console).`,
    isolateBlast: (host, minutes) =>
      `${host} loses all network connectivity for ${minutes} min: user sessions dropped, hosted services unreachable, monitoring failing on that host. No other host affected. No data touched.`,
    isolateRollback: (minutes) =>
      `Automatic revert when the ${minutes} min timer expires, with no action needed. Immediate manual revert: POST /api/isolate/revert with the alert id (effective in under 30 s).`,
    fileServerBlast: (minutes, seats) =>
      `File server: shares unavailable to roughly ${seats} desks for ${minutes} min. No data deleted.`,
    shortRollback: 'Automatic revert when the timer expires. Immediate manual revert possible.',
    triggerContainment: (action) => `containment action proposed (${action})`,
    triggerConfidence: (value) => `confidence ${value} after capping`,
    triggerBelow: (value, floor) => `confidence ${value} below the ${floor} threshold`,
    triggerNeedsHuman: '“human decision” verdict',
    escalateIntent: 'Escalate the alert to a senior analyst, with the full context.',
    escalateBlast: 'No technical impact. Costs analyst time.',
    escalateRollback: 'Close the escalation. No side effect.',
    approvedReason:
      'Confirmed with the workstation: the file was indeed executed. Isolating for the duration of the clean-up.',
    cappedConfidence: (value, sources) =>
      `confidence capped at ${value} (incomplete intelligence: ${sources})`,
    forcedNeedsHuman: (floor) => `verdict forced to “human decision” (confidence < ${floor})`,
    fallbackReasoning:
      'Verdict forced by the pipeline: the model is unreachable or erroring. No analysis available for this alert.',
    modelUnavailable: (attempts) =>
      `Model unreachable after ${attempts} attempts — fallback “human decision” verdict issued.`,
    auditWriteFailed: (attempts) =>
      `AUDIT WRITE LOST after ${attempts} attempts. The decision was made with no trace: a compliance incident, to be replayed.`,
  },

  api: {
    authRequired: 'Authentication required.',
    tooManyAttempts: (seconds) => `Too many attempts. Try again in ${seconds} s.`,
    wrongPassword: 'Wrong password.',
    passwordFirst: 'Set a password before turning the lock on, or the console becomes unreachable.',
    urlMissing: 'Instance address missing.',
    keyMissing: 'Access key missing.',
    keyRefused: 'Access key refused (401).',
    answered: (status) => `The pipeline answered ${status}.`,
    connected: (host) => `Connected to ${host}.`,
    hostMissing: 'Host missing.',
    portCaveat:
      'The port answers. That verifies neither the credentials nor that the tables exist \u2014 run the connectivity test on the Health tab for that.',
    caseNotFound: (id) => `Case ${id} not found.`,
    ruleNotFound: (id) => `Rule ${id} not found.`,
    rulesNoDatabase:
      'No database configured: the rules cannot be read. An empty list would read '
      + 'as "no rules", which is not the same thing.',
    simulateNoEngine:
      'No database configured: the built-in engine is not mounted, so the test alert '
      + 'has nowhere to go. Settings → Database.',
    simulateStarted: (scenario, status) =>
      `Scenario "${scenario}" injected into the console pipeline (${status}).`,
    approverRequired: 'Your identifier is required: it is logged with the decision.',
    engineUnavailable:
      'The engine is not started: no database is configured, so there is no run to answer.',
    approvalUnknownToken:
      'That approval is not open any more \u2014 it was already answered, or it '
      + 'timed out. The first answer stands; nothing was lost.',
    approvalFailed: (error) =>
      `The decision could not be recorded: ${error}. Without it the run will time `
      + 'out and the alert will be escalated.',
    approvalUnreachable: (error) =>
      `Could not reach the pipeline to relay the decision (${error}). Open the form directly to answer — otherwise the request expires and the alert is escalated with no action.`,
    approvalSent: 'Decision relayed to the pipeline.',
    approvalRefused: (status) =>
      `The pipeline refused the submission (HTTP ${status}). Open the form directly to answer.`,
    webhookUnreachable: (error) =>
      `Entry point unreachable: ${error}. Check that 01-Ingestion is published and the instance answers.`,
    unknownRoute: 'Unknown route.',
    replayUnknownCase: (id) =>
      `Case ${id} is outside the execution window: the console does not hold its original payload.`,
    replayNoPayload: (id) =>
      `Case ${id} never went through ingestion: its original payload is unknown, and the console will not replay an alert reconstructed from memory.`,
    replaySent: (id) => `Alert replayed under id ${id}.`,
    replayRefused: (status) => `The entry point refused the replay (${status}).`,
    replayUnreachable: (error) =>
      `The entry point did not answer: ${error}. Nothing was replayed.`,
  },

  health: {
    forcedDemo: 'Sample data forced in the settings.',
    noApiKey: 'No access key: set one in the Settings tab.',
    noDatabase:
      'No database configured: the engine is not mounted, so the console has no '
      + 'runs to read. Set the coordinates in Settings \u2192 Database. The sample '
      + 'set below is there so the screens are legible \u2014 none of it is yours.',
    auditLostRows: (n) =>
      `${n} case${n === 1 ? '' : 's'} with no committed audit row: `
      + `${n === 1 ? 'that decision is' : 'those decisions are'} not traceable.`,
    noRecentRuns: 'The pipeline answers, but no recent run carries an alert.',
    unreachable: (error) => `Pipeline unreachable: ${error}`,
    casesRebuilt: (count) => `${count} case(s) rebuilt`,
    auditOk: 'No database error seen in recent runs',
    auditUnknownInDemo: 'Unknown on sample data',
    findingNoAudit:
      'At least one case was handled with no audit row: a decision made without a trace, to be replayed.',
    findingModelUnavailable:
      'The model was unreachable on at least one case: a fallback verdict was issued, with no real analysis.',
    findingReplay:
      'Replay required — traces were lost. The Tracking tab lists them and replays them without opening the database.',
    findingNothingPublished:
      'No workflow published: the pipeline processes nothing until all six are activated.',
    findingBrokenChains: (n) =>
      `${n} broken chain(s): a step finished as "success" without handing over. See the Tracking tab.`,
    findingStalledChains: (n) =>
      `${n} chain(s) with no news for over five minutes, and not waiting for an approval. See the Tracking tab.`,
    findingOrphanRuns: (n) =>
      `${n} run(s) attached to no alert: they appear in no case at all. See the Tracking tab.`,
  },
};

const CATALOGUE: Record<Locale, ServerMessages> = { en: EN };

export function messages(locale: Locale): ServerMessages {
  return CATALOGUE[locale] ?? EN;
}
