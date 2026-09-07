/**
 * Modele de donnees de la console.
 *
 * ============================================================================
 * POURQUOI UN « CAS » ET PAS UNE « EXECUTION »
 *
 * n8n raisonne en executions : un enregistrement par workflow lance. Un
 * analyste SOC raisonne en alertes : une chose a trancher, qui traverse six
 * workflows. Les deux ne coincident jamais — on a mesure jusqu'a 8 executions
 * de 04 et 25 de 06 pour deux alertes.
 *
 * La console recolle donc les executions par `alert_id` pour reconstituer un
 * CAS. C'est ce que font les SOAR a case management natif (Cortex XSOAR, D3) :
 * l'unite de travail est l'incident, pas la trace technique. Les plateformes
 * qui exposent la trace brute obligent l'analyste a faire ce recollement de
 * tete, a chaque alerte.
 * ============================================================================
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Verdict = 'false_positive' | 'true_positive' | 'needs_human';
export type RecommendedAction = 'auto_close' | 'escalate' | 'isolate_host_temporary' | 'ticket';

/**
 * Etat du cas dans la chaine de traitement. C'est la colonne que l'analyste
 * lit en premier : elle dit ou en est le dossier, pas ce qu'il contient.
 */
export type CaseState =
  | 'ingested' // recu, pas encore enrichi
  | 'enriched' // enrichissement termine
  | 'decided' // le modele a tranche
  | 'awaiting_approval' // en attente d'un humain — le seul etat qui bloque
  | 'actioned' // une action a ete executee
  | 'closed' // clos sans action (faux positif, shadow mode)
  | 'failed'; // une erreur technique a interrompu la chaine

export type SourceStatus = 'ok' | 'skipped' | 'unavailable' | 'absent';

export interface EnrichmentSource {
  status: SourceStatus;
  source: string;
  /** Champs specifiques a la source, affiches tels quels dans la fiche. */
  [key: string]: unknown;
}

export interface Enrichment {
  shodan: EnrichmentSource;
  abuseipdb: EnrichmentSource;
  vt: EnrichmentSource;
}

export interface EnrichmentMeta {
  enriched_at?: string;
  file_hash?: string | null;
  file_hash_type?: string | null;
  source_ip_is_private?: boolean;
  sources_ok: string[];
  sources_skipped: string[];
  sources_unavailable: string[];
  degraded: boolean;
}

export interface Decision {
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  recommended_action: RecommendedAction;
  data_lineage: string[];
  /** Confiance avant les clamps deterministes de 03. L'ecart est un signal. */
  raw_confidence?: number;
  decision_source?: string;
  model?: string | null;
  attempts?: number | null;
  is_fallback?: boolean;
  /** Ce que le code a corrige apres coup dans la sortie du modele. */
  guardrails_applied?: string[];
  validator_violations?: string[] | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

export interface Approver {
  slack_username: string | null;
  slack_user_id: string | null;
  responded_at: string | null;
  /** `n8n_form_self_declared` = identite non authentifiee. Affiche comme tel. */
  identity_source?: string;
  signature_verified?: boolean;
}

export interface Approval {
  requested_action: RecommendedAction;
  intent: string;
  blast_radius: string;
  rollback_plan: string;
  triggers: string[];
  outcome: 'approved' | 'rejected' | 'timeout_escalated' | 'pending';
  approver: Approver | null;
  human_reasoning: string | null;
  timeout_minutes: number;
  requested_at?: string | null;
  execution_id?: string | null;
}

/**
 * Un passage dans un workflow. C'est la « chaine de possession » du SOAR :
 * qui a touche l'alerte, quand, combien de temps, avec quel resultat.
 */
export interface StageEvent {
  workflow: string;
  execution_id: string;
  status: 'success' | 'error' | 'waiting' | 'running';
  started_at: string;
  duration_ms: number | null;
  /** Resume lisible de ce que l'etape a produit ou echoue a produire. */
  note: string;
  /**
   * Nombre d'executions identiques repliees sur cette ligne. Le pipeline
   * amplifie : 2 alertes ont produit 25 executions de 06 en recette. Afficher
   * les 25 noierait la fiche ; les cacher masquerait le defaut. On replie en
   * affichant le compte.
   */
  repeat?: number;
}

export interface AuditRecord {
  committed: boolean;
  row_id: number | null;
  integrity_hash: string | null;
  prev_hash: string | null;
  /** Renseigne quand l'ecriture a echoue : le cas est alors non tracable. */
  failure: string | null;
}

export interface AttackTag {
  id: string;
  technique: string;
  tactic: string;
}

export interface ErrorEvent {
  workflow: string;
  error_code: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  at: string;
  requires_replay: boolean;
}

export interface AlertCase {
  alert_id: string;
  received_at: string;
  state: CaseState;
  severity: Severity;
  rule_name: string;
  source_ip: string;
  dest_ip: string;
  /**
   * The machine the alert is about. `null` when the detection did not name one.
   *
   * NOT an em dash like the two addresses above: those carry a display value
   * for "unknown", and that display value then has to be stripped every time
   * the field travels as data. `host` decides whether an isolation has a
   * target at all — `isolationTarget()` falls back to it when there is no
   * destination address, which is MOST real detections — so it stays a value
   * or nothing.
   */
  host: string | null;
  raw_log: string;
  /**
   * Vendor fields the mapping had no canonical home for, kept whole.
   *
   * THE CONTRACT SAYS THEY TRAVEL "ON THE CASE AND IN THE AUDIT ROW", and for
   * a long time only the second half was true: `extensions` reached the audit
   * payload and the run input, and the case object had no field for it at all.
   * So a source's own fields — the ones somebody added a source in order to
   * see — were unreachable from the incident card.
   *
   * `null` when the source sent nothing beyond the canonical shape.
   */
  extensions: Record<string, unknown> | null;
  shadow_mode: boolean;
  executed: boolean;
  routing_outcome: string | null;
  action_taken: string | null;
  enrichment: Enrichment | null;
  enrichment_meta: EnrichmentMeta | null;
  decision: Decision | null;
  approval: Approval | null;
  audit: AuditRecord | null;
  stages: StageEvent[];
  errors: ErrorEvent[];
  attack: AttackTag[];
  /** Temps entre la reception et la derniere etape connue. Le MTTR du cas. */
  dwell_ms: number | null;
  /**
   * J0.3 — the code that runs on the machine this alert is about, when the
   * service inventory names it.
   *
   * `null` means the inventory says nothing about this machine — NOT that the
   * machine runs no code. The card prints the first and must never print the
   * second. Resolved by the console from a table an operator filled in, never
   * guessed from an address: see `server/inventory.ts`.
   */
  repository: CaseRepository | null;
}

/**
 * One machine, or one service, and the code it runs.
 *
 * Declared here rather than beside the resolver because both halves read it:
 * the server validates and matches (`server/inventory.ts`), the Settings page
 * edits it. The console's convention is that a shared shape lives in
 * `src/lib/types.ts` and the server imports it.
 */
export interface InventoryEntry {
  /** What the team calls it. Shown on the incident card. */
  service: string;
  /** The exact hostnames and addresses it answers on. Compared, never parsed. */
  identifiers: string[];
  /** What to hand the code analysis: a folder, a file, or a repository URL. */
  repository: string;
}

/** What the inventory answered for a case, and what made it answer. */
export interface CaseRepository {
  service: string;
  repository: string;
  /**
   * Which observable matched. Always shown: "this alert is about repository X"
   * is only checkable when it also says which value produced the match.
   */
  matched_on: 'host' | 'dest_ip' | 'source_ip';
  matched_value: string;
}

export interface Metrics {
  window_label: string;
  alerts_total: number;
  alerts_shadow: number;
  alerts_live: number;
  actions_executed: number;
  awaiting_approval: number;
  failed: number;
  by_verdict: Record<string, number>;
  by_severity: Record<string, number>;
  avg_confidence: number | null;
  avg_dwell_ms: number | null;
  p95_dwell_ms: number | null;
  tokens_total: number;
  fallback_rate_pct: number | null;
  degraded_rate_pct: number | null;
  human_disagreement_rate_pct: number | null;
  shadow_baseline: { decisions: number; threshold: number; reached: boolean };
}

export interface HealthReport {
  /** `demo` = aucune source live, la console montre un jeu de demonstration. */
  mode: 'live' | 'demo';
  /**
   * The pipeline's own engine: is it mounted, and what did it last say.
   *
   * It was `n8n: { reachable, url, detail }` — the console's health used to be
   * a report about somebody else's server. `url` is kept as the DATABASE
   * coordinates, because "can the engine work" is now exactly "can it reach
   * its store".
   */
  engine: { reachable: boolean; url: string; detail: string };
  workflows: { id: string; name: string; active: boolean }[];
  /** Deduit des erreurs d'execution : on ne se connecte pas a Postgres ici. */
  audit_db: { healthy: boolean; detail: string };
  blocking_findings: string[];
  checked_at: string;
}

/**
 * Resultat d'une verification unitaire du diagnostic de connectivite.
 * `skip` signifie NON DETERMINE, pas « ignore » : la console ne peut pas
 * conclure, et le dire vaut mieux qu'un vert de complaisance.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Le geste correctif. Absent quand il n'y a rien a faire. */
  remedy?: string;
}

export interface Diagnostics {
  ran_at: string;
  duration_ms: number;
  summary: { ok: number; warn: number; fail: number; skip: number };
  verdict: 'operational' | 'degraded' | 'broken';
  checks: Check[];
}

/**
 * Vue publique des reglages. Aucun secret n'y figure : `apiKeySet` et
 * `passwordSet` disent seulement si une valeur existe. Le navigateur peut
 * ECRIRE un secret, jamais le RELIRE.
 */
export interface Settings {
  /**
   * Point d'entrée des alertes porté par la console, et son exposition.
   * Ni le secret partagé ni le jeton de tunnel ne ressortent du serveur :
   * « renseigné » ou « vide », jamais la valeur.
   */
  webhook: { mode: 'off' | 'on'; secretSet: boolean };
  tunnel: { hostname: string; tokenSet: boolean };
  console: { refreshSeconds: number; executionWindow: number; forceDemo: boolean };
  auth: { enabled: boolean; passwordSet: boolean };
  database: {
    preset: 'local' | 'supabase' | 'custom';
    host: string; port: number; database: string; user: string;
    ssl: boolean; passwordSet: boolean;
  };
  pipeline: {
    shadowMode: boolean;
    slackApproval: string; slackEscalation: string;
    slackWarnings: string; slackCritical: string;
    ticketEndpoint: string; isolationEndpoint: string;
    isolationTtlMinutes: number;
    errorWindowMinutes: number; errorSystemicThreshold: number; errorSuppressMinutes: number;
  };
  /**
   * The in-console assistant. `enabled` is an operator's switch, NOT what
   * makes it safe — that is the read-only tool catalogue on the server. It
   * exists so an installation that does not want a model reading its logs can
   * say so once, instead of relying on nobody setting a key.
   */
  assistant: {
    enabled: boolean;
    provider: string;
    model: string;
    maxSteps: number;
    /** The MCP endpoint. Off by default; the token never comes back out. */
    mcpEnabled: boolean;
    mcpTokenSet: boolean;
  };
  /**
   * J0.3 — the service ↔ repository table. No secret in it: a folder path and
   * a repository URL are what an operator types into the launcher by hand, and
   * the incident card has to show them or its match cannot be checked.
   */
  inventory: { entries: InventoryEntry[] };
  meta: {
    config_path: string;
    config_exists: boolean;
    from_env: { db_host: boolean; db_password: boolean };
  };
}

export interface SettingsPayload {
  settings: Settings;
  connection_string: string;
}

/**
 * A pipeline credential, as the console is allowed to see it.
 *
 * NEVER THE VALUE — `set` and `source` only, the same discipline as every
 * other secret in this console. `locked` means the value comes from the real
 * environment (shell, Docker, CI), and the field must be shown read-only:
 * offering an input that the server will refuse is worse than offering none.
 */
export interface CredentialStatus {
  env: string;
  credential: string;
  label: string;
  required: boolean;
  set: boolean;
  source: 'environment' | 'store' | 'none';
  locked: boolean;
}

export interface CredentialsPayload {
  credentials: CredentialStatus[];
}

/** How to point one log source at this console, generated by the server. */
export interface SourceSetup {
  install: string[];
  configFile: string;
  config: string;
  verify: string;
}

export interface IngestSource {
  source: string;
  label: string;
  endpoint: string;
  /** Canonical field -> the vendor paths it is read from, in order. */
  fields: Record<string, string>;
  setup: SourceSetup | null;
}

export interface IngestSourcesPayload {
  base_url: string;
  secret_set: boolean;
  mode: 'off' | 'on';
  sources: IngestSource[];
}

export type RuleAction = 'allow' | 'suppress' | 'severity' | 'escalate';

export type RuleOperator =
  | 'equals' | 'not_equals' | 'contains' | 'starts_with' | 'ends_with'
  | 'regex' | 'cidr' | 'in_list' | 'exists' | 'not_exists';

export interface RuleCondition {
  field: string;
  op: RuleOperator;
  values: string[];
}

export interface TuningRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: RuleCondition[];
  action: RuleAction;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  /** Governance. Required by the server, not by convention. */
  owner: string;
  reason: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  /** Measurement: a rule that has matched nothing in a year is dead weight. */
  match_count: number;
  last_matched_at: string | null;
}

export interface RuleProblem {
  field: string;
  detail: string;
}

export interface RuleTemplate {
  id: string;
  title: string;
  description: string;
  category: string;
  action: RuleAction;
  severity: TuningRule['severity'];
  conditions: RuleCondition[];
  /** Fields the operator MUST replace before the template means anything. */
  placeholders: string[];
  expiresInDays: number | null;
}

export interface RuleTestResult {
  matched: { id: string; name: string } | null;
  action: RuleAction | null;
  severity: string;
  note: string | null;
  expired: string[];
  evaluated: Array<{ id: string; name: string; enabled: boolean; matched: boolean }>;
}

export interface AuthStatus {
  enabled: boolean;
  password_set: boolean;
  authenticated: boolean;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  caveat?: string;
}

export interface ConsoleSnapshot {
  cases: AlertCase[];
  metrics: Metrics;
  health: HealthReport;
  /**
   * Vue non reduite du meme lot d'executions. Elle voyage AVEC le snapshot,
   * pas sur une route a part : reconstituer les cas coute une requete par
   * execution, et la tracabilite se lit sur exactement le meme lot. Deux
   * routes auraient double la charge sur n8n pour montrer deux verites
   * legerement decalees dans le temps.
   */
  trace: TraceReport;
  /** Cadence de rafraichissement decidee dans les reglages. */
  refresh_seconds?: number;
}

/* ==========================================================================
 * TRAÇABILITÉ — retrouver une exécution qui n'a pas produit de cas
 *
 * La console recolle les executions par `alert_id` pour montrer des CAS. Ce
 * recollement est une reduction : une execution qui ne porte aucun alert_id
 * lisible disparait de l'ecran, et une chaine qui s'arrete au milieu ressemble
 * a un cas normal, juste un peu plus court.
 *
 * Les deux sont des pannes, et ce sont exactement celles que ce pipeline
 * produit (voir CLAUDE.md, « Pieges constates ») : un Switch sans sortie de
 * repli sort ZERO item en affichant `success`, un `mode: "once"` demarre le
 * sous-workflow avec zero item et se termine en `success`. Rien n'echoue,
 * rien n'apparait.
 *
 * Ces types portent la vue NON REDUITE : une ligne par execution, une ligne
 * par chaine, et le point exact ou la chaine se casse.
 * ========================================================================== */

/** Nom canonique des cinq etapes de la chaine nominale, dans l'ordre. */
export const CHAIN_STEPS = [
  '01-Ingestion',
  '02-Enrichment',
  '03-AI-Decision',
  '04-Action-Routing',
  '05-Audit-Log',
] as const;

export type ChainStep = (typeof CHAIN_STEPS)[number];

/**
 * Etat de la passation vers l'etape suivante.
 *
 * `empty` est LE cas qui coute des heures : le node `Execute Sub-workflow` a
 * bien tourne, n8n affiche `success`, et il a passe zero item. Le distinguer
 * de `absent` (le node n'a jamais tourne) dit tout de suite s'il faut regarder
 * le branchement ou le node lui-meme.
 */
export type Handoff = 'items' | 'empty' | 'absent' | 'n/a';

export interface TraceStep {
  workflow: ChainStep;
  /** `null` = cette etape n'a jamais tourne pour ce cas. */
  execution_id: string | null;
  status: 'success' | 'error' | 'waiting' | 'running' | 'missing';
  handoff: Handoff;
  started_at: string | null;
  duration_ms: number | null;
}

/**
 * Verdict d'une chaine. Trois d'entre eux sont normaux, trois sont des pannes.
 *
 *  - `complete`  : l'audit a ete atteint, ou l'arret est prevu (schema refuse,
 *                  doublon) ;
 *  - `awaiting`  : 04 attend un humain — une pause voulue, pas un blocage ;
 *  - `running`   : la chaine avance, la derniere etape est recente ;
 *  - `broken`    : on peut MONTRER la passation qui n'a rien passe ;
 *  - `stalled`   : aucune preuve de casse, mais plus aucune nouvelle ;
 *  - `failed`    : une etape a echoue, ou 06 a journalise une erreur grave.
 */
export type ChainVerdict = 'complete' | 'awaiting' | 'running' | 'broken' | 'stalled' | 'failed';

/** Raison LEGITIME d'un arret avant l'audit. Une chaine courte n'est pas cassee. */
export type TerminalReason = 'schema_rejected' | 'duplicate' | 'dedup_down';

export interface TraceChain {
  alert_id: string;
  received_at: string;
  last_activity_at: string;
  /** Temps ecoule depuis la derniere etape connue. C'est lui qui declenche `stalled`. */
  idle_ms: number;
  verdict: ChainVerdict;
  steps: TraceStep[];
  missing: ChainStep[];
  terminal_reason: TerminalReason | null;
  /** L'etape ou la chaine s'arrete sans raison. Renseigne pour `broken`. */
  break_at: ChainStep | null;
  /**
   * Charge utile d'origine, relue depuis le webhook de 01. Absente quand le
   * cas n'est jamais passe par 01 : on ne rejoue alors rien, plutot que de
   * rejouer une alerte reconstituee de memoire.
   */
  payload: {
    source_ip: string;
    dest_ip: string;
    rule_name: string;
    severity: Severity;
    raw_log: string;
  } | null;
}

/**
 * Pourquoi une execution n'a pas pu etre rattachee a un cas.
 *
 * Les deux dernieres sont ATTENDUES et ne comptent pas comme anomalie : la
 * sonde du diagnostic de connectivite envoie expres une alerte invalide, et un
 * workflow etranger n'a jamais eu vocation a produire un cas. Les melanger aux
 * vraies orphelines remplirait l'onglet de bruit permanent.
 *
 * `empty_input` est la plus grave : le sous-workflow a bien demarre, avec ZERO
 * donnee. C'est la signature du `mode: "once"` sur un Execute Sub-workflow.
 */
export type OrphanReason =
  | 'empty_input'
  | 'no_alert_id'
  | 'no_data'
  | 'diagnostic_probe'
  | 'foreign_workflow';

/** Les orphelines qui meritent qu'on les regarde. Les autres sont normales. */
export const UNEXPECTED_ORPHANS: readonly OrphanReason[] = ['empty_input', 'no_alert_id', 'no_data'];

export interface TraceExecution {
  execution_id: string;
  workflow_id: string;
  /** `null` = workflow hors des six du pipeline. */
  workflow: string | null;
  status: string;
  started_at: string;
  duration_ms: number | null;
  alert_id: string | null;
  orphan_reason: OrphanReason | null;
  /** Precision courte : code d'erreur, node vide. Absente quand il n'y a rien a dire. */
  note: string | null;
  handoff: Handoff;
}

export interface TraceReport {
  generated_at: string;
  /**
   * Ce que la fenetre a REELLEMENT couvert. `truncated` dit que la limite a
   * ete atteinte : au-dela, la console ne sait pas, et doit le dire plutot que
   * de laisser croire que tout est la.
   */
  window: {
    limit: number;
    inspected: number;
    attached: number;
    oldest_at: string | null;
    newest_at: string | null;
    truncated: boolean;
  };
  /** Seuil au-dela duquel une chaine sans nouvelle est declaree `stalled`. */
  stall_after_ms: number;
  chains: TraceChain[];
  orphans: TraceExecution[];
  executions: TraceExecution[];
  counts: {
    broken: number;
    stalled: number;
    failed: number;
    awaiting: number;
    running: number;
    complete: number;
    /** Orphelines INATTENDUES seulement. La sonde de diagnostic n'en est pas une. */
    orphans: number;
    /** `broken + stalled + orphans` : le chiffre qui merite qu'on ouvre l'onglet. */
    attention: number;
  };
}

export interface ReplayResult {
  ok: boolean;
  status: number;
  /** Identifiant REELLEMENT envoye : derive par defaut, d'origine sur demande. */
  alert_id: string;
  source_alert_id: string;
  response: string;
  detail: string;
}

/* ==========================================================================
 * THE IN-CONSOLE ASSISTANT
 *
 * A chat panel that reads the pipeline through a closed, read-only tool
 * catalogue (`server/assistant/tools.ts`). Three things it is worth knowing
 * from the client side:
 *
 *  - Nothing is stored server side. The whole transcript travels with every
 *    turn, so a thread lives exactly as long as the browser session.
 *  - `tools` on a reply is the trace of what was actually looked up. It is
 *    shown, not hidden: an answer an operator cannot check is an answer that
 *    gets believed for the wrong reasons.
 *  - `capped` says a budget ended the run. A capped answer is still an
 *    answer, and it says so rather than looking complete.
 * ========================================================================== */

export interface AssistantPage {
  tab?: string;
  /** The incident open on screen. Anchors "this alert" with no identifier typed. */
  alert_id?: string;
  filter?: string;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantToolTrace {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface AssistantReply {
  reply: string;
  tools: AssistantToolTrace[];
  steps: number;
  capped: 'steps' | 'tool_calls' | 'deadline' | null;
  usage: { input_tokens: number | null; output_tokens: number | null };
}

/** One model provider the assistant can run on. Served, never hard-coded here. */
export interface AssistantProvider {
  id: string;
  label: string;
  /** The credential name it reads. Shown so the operator knows which field to fill. */
  key_env: string;
  default_model: string;
  key_url: string;
  model_hint: string;
}

/** What the MCP setup page draws itself from. Never carries the token. */
export interface McpState {
  enabled: boolean;
  token_set: boolean;
  /** Both must be true. Either alone is a door that does not open. */
  live: boolean;
  path: string;
  tools: string[];
  prompts: Array<{ name: string; title: string }>;
  resources: string[];
  protocol_versions: string[];
}

export interface AssistantState {
  enabled: boolean;
  ready: boolean;
  /** Which key it runs on: the provider's own, or the triage key OpenRouter falls back to. */
  key_source: 'provider' | 'triage' | null;
  key_locked: boolean;
  provider: string;
  provider_label: string;
  /** The model actually used — the provider's default when the field is empty. */
  model: string;
  max_steps: number;
  suggestions: string[];
  tools: string[];
  /** The named reason it cannot answer yet. `null` when it can. */
  blocking: string | null;
}

/* ==========================================================================
 * MANUAL LOOKUP
 * ========================================================================== */

export type ObservableKind = 'ipv4' | 'ipv6' | 'domain' | 'url' | 'hash' | 'email' | 'unknown';

/** What the server made of what was typed. Both forms travel: typed, queried. */
export interface Observable {
  input: string;
  value: string;
  kind: ObservableKind;
  hash_kind: 'md5' | 'sha1' | 'sha256' | null;
  /** Three states, as everywhere: `null` means the question does not apply. */
  private_address: boolean | null;
  refanged: boolean;
  reason: string | null;
}

export interface IntelSignal {
  weight: 'strong' | 'weak' | 'context';
  text: string;
  /** Which source said it. An unattributed claim is one nobody can check. */
  provider?: string;
}

/** One source's answer. Same three states as the enrichment pipeline. */
export interface IntelSource {
  provider: string;
  label: string;
  status: 'ok' | 'skipped' | 'unavailable';
  fields: Record<string, unknown> | null;
  reason: string | null;
  http_status: number | null;
  ms: number | null;
  signals: IntelSignal[];
  permalink: string | null;
  cached: boolean;
}

export interface IntelResult {
  observable: Observable;
  verdict: 'flagged' | 'watch' | 'clean' | 'unknown';
  headline: string;
  signals: IntelSignal[];
  sources: IntelSource[];
  /** The number `clean` depends on: sources that actually answered. */
  answered: number;
  queried_at: string;
  ms: number;
}

export interface IntelProvider {
  id: string;
  label: string;
  kinds: ObservableKind[];
  env: string | null;
  configured: boolean;
  signup: string;
  purpose: string;
  ttl_hours: number;
}

export interface IntelProvidersPayload {
  providers: IntelProvider[];
  kinds: ObservableKind[];
}
