/**
 * Client HTTP de la console.
 *
 * Toute erreur est traduite en francais : l'analyste ne doit jamais voir un
 * code de statut nu. Un message technique dans une file de triage, c'est une
 * seconde perdue par ligne, et il y en a quarante.
 */

import { consoleDictionary } from '../i18n/console.ts';
import { getCurrentLocale } from '../i18n/context.tsx';
import type { Locale } from '../i18n/dictionary.ts';
import type {
  AlertCase, AuthStatus, ConsoleSnapshot, Diagnostics, ReplayResult,
  CredentialsPayload, IngestSourcesPayload, RuleProblem, RuleTemplate, RuleTestResult,
  SettingsPayload, TestResult, TuningRule,
} from './types.ts';
import type {
  IntelProvidersPayload, IntelResult, ObservableKind,
} from './types.ts';
import type {
  AssistantPage, AssistantProvider, AssistantReply, AssistantState, AssistantTurn, McpState,
} from './types.ts';
import type { WorkflowsPayload } from '../components/WorkflowPanel.tsx';
import type {
  IngestionPayload, IngestionPolicy, PollOutcome,
} from './ingestion.ts';

const BASE = import.meta.env?.VITE_API_URL ?? '';

/**
 * Le client HTTP n'est pas un composant : il ne peut pas appeler un hook, mais
 * il doit ecrire ses erreurs dans la bonne langue ET annoncer celle-ci au
 * serveur, qui redige lui aussi des phrases (diagnostic, notes de chaine, jeu
 * d'exemple).
 *
 * La langue vient du fournisseur, qui la publie de facon SYNCHRONE au moment
 * du clic. La lire sur `<html lang>` semblait plus simple, mais cet attribut
 * est pose par un effet du fournisseur, donc APRES les effets des composants
 * enfants : l'ecran rechargeait ses donnees dans la langue qu'on venait de
 * quitter.
 */
function locale(): Locale {
  return getCurrentLocale();
}

const t = () => consoleDictionary(locale());

/** Ajoute `locale` a une adresse, en respectant une eventuelle query existante. */
function withLocale(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}locale=${locale()}`;
}

export class ApiError extends Error {
  /**
   * The per-field refusals, when the server named them one by one.
   *
   * `RulesPage` renders one line per entry and has read this since it was
   * written; until `namedReason` existed it always received `undefined`.
   *
   * Declared then assigned rather than taken as a constructor parameter
   * property: `erasableSyntaxOnly` refuses that syntax here.
   */
  problems?: RuleProblem[];
}
/** Distincte d'ApiError : elle declenche l'ecran de connexion, pas un bandeau. */
export class AuthRequiredError extends ApiError {}

/** A reason is a non-empty string. Anything else is not one. */
function saying(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The reason the SERVER wrote, in the shapes this API actually answers.
 *
 * `error` is the common key, and it was the only one read — so the other two
 * left the client as "the console server answered 400 with no explanation",
 * over a body that explained it in full:
 *
 * - `problems`, one `{ field, detail }` per thing wrong with a tuning rule,
 *   from `POST /api/rules` and `PUT /api/rules/:id`;
 * - `detail`, from `POST /api/approvals/:token/resume` and the database probe —
 *   the approval one naming the cause AND that the alert will be escalated.
 *
 * `error` wins when both are present: the settings route composes a sentence
 * for a human out of the same list, and a raw join must not displace it.
 *
 * The string test is not decoration. `POST /api/mcp` answers a JSON-RPC
 * envelope whose `error` is an OBJECT, and the previous `body?.error ??` would
 * have put `[object Object]` on screen; a blank `error` put an empty banner
 * there, which says less than the generic sentence does. That guard existed on
 * the 5xx branch below and nowhere else — hence one reader for both.
 */
function namedReason(body: unknown): { message: string; problems?: RuleProblem[] } | null {
  const b = body as Record<string, unknown> | null | undefined;
  const problems = (Array.isArray(b?.problems) ? b.problems : [])
    .filter((p): p is RuleProblem => saying((p as RuleProblem | null)?.detail) !== null)
    .map((p) => ({ field: saying(p.field) ?? '', detail: p.detail }));

  // `field: detail` is the spelling `inventoryRefused` already uses server
  // side; a second one here is how two spellings of one sentence start to
  // disagree.
  const listed = problems.length > 0
    ? problems.map((p) => (p.field ? `${p.field}: ${p.detail}` : p.detail)).join('; ')
    : null;

  const message = saying(b?.error) ?? listed ?? saying(b?.detail);
  if (!message) return null;
  return problems.length > 0 ? { message, problems } : { message };
}

function refused(fallback: string, named: ReturnType<typeof namedReason>): ApiError {
  const err = new ApiError(named?.message ?? fallback);
  if (named?.problems) err.problems = named.problems;
  return err;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(t().errors.apiUnreachable);
  }
  if (res.status === 401) {
    // Le verrou de la console : traite a part pour que l'interface puisse
    // afficher l'ecran de connexion au lieu d'un message d'erreur.
    throw new AuthRequiredError(t().errors.authRequired);
  }

  const text = await res.text();
  let body: any = null;
  let parsed = false;
  try {
    body = text ? JSON.parse(text) : null;
    parsed = true;
  } catch {
    // Handled below: on a 502/503/504 an unparseable body is the signature of
    // the case the generic sentence describes, so it is not an error on its own.
  }

  /**
   * 502/503/504 come from the Vite dev proxy when the API is not listening:
   * measured on Vite 8.2.1 against a dead upstream, it answers 502 with an
   * EMPTY `text/plain` body. Nothing named a reason, so the status code alone
   * would tell an analyst nothing and the generic sentence is what to say.
   *
   * BUT THE CONSOLE ANSWERS 503 TOO, and never for that reason: no database
   * configured, the engine therefore not mounted, a configured database
   * refusing the connection. Each of those carries a sentence the server
   * WROTE, naming what an operator has to go and fix — and replacing it with
   * "start the console server" sent them to restart a server that had just
   * answered them. `pwnedRange` below already reads its own errors this way,
   * for the one route that cannot use `call()`; this is the same rule on the
   * twenty that can.
   */
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw refused(t().errors.apiNotResponding, parsed ? namedReason(body) : null);
  }

  if (!parsed) throw new ApiError(t().errors.unreadable);
  if (!res.ok) {
    // EVERY key a route names a reason under, not the one that was remembered.
    // Read the header of `api-named-failures.test.ts` for what each of them
    // cost on screen.
    throw refused(t().errors.noExplanation(res.status), namedReason(body));
  }
  return body as T;
}

export interface ResumeResult {
  ok: boolean;
  status: number;
  detail: string;
}

export interface SimulateResult {
  ok: boolean;
  status: number;
  alert_id: string;
  response: string;
}

export const api = {
  snapshot: (force = false) => call<ConsoleSnapshot>(withLocale(`/api/snapshot${force ? '?force=1' : ''}`)),
  case: (id: string) => call<AlertCase>(withLocale(`/api/cases/${encodeURIComponent(id)}`)),
  resume: (executionId: string, payload: { decision: 'approve' | 'reject'; approver: string; reason: string }) =>
    call<ResumeResult>(`/api/approvals/${encodeURIComponent(executionId)}/resume`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /**
   * Diagnostic de connectivite. Long par nature (il interroge n8n workflow par
   * workflow puis sonde le webhook) : le client ne pose pas de timeout court.
   */
  diagnostics: (probeWebhook = true) =>
    call<Diagnostics>(withLocale('/api/diagnostics'), {
      method: 'POST',
      body: JSON.stringify({ probeWebhook }),
    }),
  /** The catalogue of test alerts, so the console does not hard-code it. */
  scenarios: () =>
    call<{ scenarios: Array<{ id: string; title: string; purpose: string }> }>(
      '/api/simulate/scenarios',
    ),

  simulate: (payload: Record<string, unknown> = {}) =>
    call<SimulateResult>('/api/simulate', { method: 'POST', body: JSON.stringify(payload) }),
  /**
   * Rejeu d'une alerte dont la chaine s'est cassee. `sameId` reposte sous
   * l'identifiant d'origine : la deduplication l'ecartera, ce qui n'a de sens
   * que pour tester la deduplication elle-meme.
   */
  replay: (alertId: string, sameId = false) =>
    call<ReplayResult>(withLocale('/api/replay'), {
      method: 'POST',
      body: JSON.stringify({ alert_id: alertId, same_id: sameId }),
    }),

  /** Les six workflows tels que le moteur les exécute, plus les variables. */
  workflows: () => call<WorkflowsPayload>('/api/workflows'),
  /**
   * Troisième — et dernière — écriture du serveur. Bornée aux clés connues :
   * une clé inventée donnerait l'illusion d'un réglage appliqué.
   */
  saveVariables: (patch: Record<string, unknown>) =>
    call<{ variables: Record<string, string | number | boolean> }>(
      withLocale('/api/workflows/variables'),
      { method: 'PUT', body: JSON.stringify(patch) },
    ),

  // --- N5 — how alerts get in ----------------------------------------------
  /**
   * The delivery policy, the lane each severity takes, and the poller's state.
   *
   * ITS OWN ENDPOINT, not part of `settings`. The Ingestion tab reads it on
   * every visit and the Settings save bar must never rewrite it: choosing an
   * architecture and changing a refresh interval are not the same act, and
   * `config.json` holding both is not a reason to submit both together.
   */
  ingestionPolicy: () => call<IngestionPayload>('/api/ingestion/policy'),
  saveIngestionPolicy: (policy: Partial<IngestionPolicy>) =>
    call<{ policy: IngestionPolicy }>('/api/ingestion/policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    }),
  /** Poll every enabled source once, now. The real poll, not a simplified one. */
  pollNow: () => call<{ outcomes: PollOutcome[] }>('/api/ingestion/poll', { method: 'POST' }),
  // --- Reglages et acces ----------------------------------------------------
  settings: () => call<SettingsPayload>('/api/settings'),
  saveSettings: (patch: Record<string, unknown>) =>
    call<SettingsPayload>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  testDatabase: (payload: { host?: string; port?: number }) =>
    call<TestResult>('/api/settings/test/database', { method: 'POST', body: JSON.stringify(payload) }),
  /**
   * Pipeline credentials. Separate from `settings` on purpose: they live in
   * their own 0600 store, not in `config.json`, so that saving a refresh
   * interval cannot rewrite an API key.
   */
  /** Tuning rules. Their own endpoints: they live in the database, not in config.json. */
  rules: () => call<{ rules: TuningRule[] }>('/api/rules'),
  ruleTemplates: () =>
    call<{ templates: RuleTemplate[]; drafts: Array<{ id: string; draft: Omit<TuningRule, 'id'> }> }>(
      '/api/rules/templates',
    ),
  createRule: (rule: Partial<TuningRule>) =>
    call<{ rule: TuningRule }>('/api/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateRule: (id: string, rule: Partial<TuningRule>) =>
    call<{ rule: TuningRule }>(`/api/rules/${id}`, { method: 'PUT', body: JSON.stringify(rule) }),
  deleteRule: (id: string) =>
    call<{ ok: boolean }>(`/api/rules/${id}`, { method: 'DELETE' }),
  /** Dry run: which rule would match this alert, without touching the pipeline. */
  testRules: (alert: Record<string, unknown>, rules?: Partial<TuningRule>[]) =>
    call<RuleTestResult>('/api/rules/test', {
      method: 'POST',
      body: JSON.stringify({ alert, ...(rules ? { rules } : {}) }),
    }),

  credentials: () => call<CredentialsPayload>('/api/credentials'),
  saveCredentials: (patch: Record<string, string | null>) =>
    call<CredentialsPayload>('/api/credentials', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  /** Log sources this console can normalize, with ready-to-paste setup. */
  ingestSources: () => call<IngestSourcesPayload>('/api/ingest/sources'),

  /**
   * The in-console assistant.
   *
   * The whole conversation travels with every turn: nothing is stored server
   * side. A thread is a browser session — persisting it would create a fourth
   * copy of alert content, outside the audit chain, with no retention policy.
   */
  assistantState: (page: AssistantPage) =>
    call<AssistantState>(
      `/api/assistant/state?tab=${encodeURIComponent(page.tab ?? '')}`
      + `&alert_id=${encodeURIComponent(page.alert_id ?? '')}`,
    ),
  /** The MCP endpoint: status and what it exposes. Never the token. */
  mcpState: () => call<McpState>('/api/assistant/mcp'),
  /**
   * Generates the bearer token and returns it ONCE. The only place in this
   * client that ever receives a secret from the server — see the route for why
   * that is a different thing from reading a stored one back.
   */
  mcpGenerateToken: () =>
    call<{ token: string; shown_once: string }>('/api/assistant/mcp-token', { method: 'POST' }),
  /** Server-side self-test: a browser cannot test it, the Origin guard refuses browsers. */
  mcpTest: () =>
    call<{ ok: boolean; detail: string }>('/api/assistant/mcp-test', { method: 'POST' }),

  /** The provider catalogue lives on the server: Settings must not restate it. */
  assistantProviders: () =>
    call<{ providers: AssistantProvider[] }>('/api/assistant/providers'),
  assistantChat: (messages: AssistantTurn[], page: AssistantPage) =>
    call<AssistantReply>(withLocale('/api/assistant/chat'), {
      method: 'POST',
      body: JSON.stringify({ messages, page }),
    }),

  /* --- Manual lookup --------------------------------------------------- */

  intelProviders: () => call<IntelProvidersPayload>('/api/intel/providers'),
  /**
   * One value, optionally a forced kind. NEVER a URL: the server's provider
   * catalogue decides every address that is dialled, and the browser has no
   * say in it.
   */
  intelLookup: (value: string, kind?: ObservableKind | null, opts?: { fresh?: boolean; only?: string[] }) =>
    call<IntelResult>('/api/intel/lookup', {
      method: 'POST',
      body: JSON.stringify({ value, kind: kind ?? undefined, fresh: opts?.fresh === true, only: opts?.only ?? [] }),
    }),

  /**
   * The Pwned Passwords relay. Plain text, so it cannot go through `call()`.
   *
   * It still goes through THIS file, and that is the point: the password panel
   * used to `fetch('/api/…')` directly, which ignored `VITE_API_URL` — so on a
   * console served from another origin the check was the one feature that
   * silently pointed at the wrong host — and turned an expired session into
   * "the check could not be completed" instead of the login screen.
   *
   * `prefix` is five hex characters. It is re-checked here as well as on the
   * server: the guarantee this feature makes is worth two locks.
   */
  pwnedRange: async (prefix: string): Promise<string> => {
    if (!/^[0-9A-Fa-f]{5}$/.test(prefix)) throw new ApiError(t().errors.unreadable);
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/intel/pwned-range/${prefix.toUpperCase()}`);
    } catch {
      throw new ApiError(t().errors.apiUnreachable);
    }
    if (res.status === 401) throw new AuthRequiredError(t().errors.authRequired);
    const body = await res.text();
    if (!res.ok) throw new ApiError(t().errors.noExplanation(res.status));
    // The route answers JSON when the relay itself failed, and one
    // `SUFFIX:COUNT` per line when it did not. A JSON body here carries the
    // named reason, and throwing it away for a generic sentence would lose the
    // only useful half of the answer.
    if (body.startsWith('{')) {
      try {
        throw new ApiError(String(JSON.parse(body).error ?? t().errors.unreadable));
      } catch (err) {
        throw err instanceof ApiError ? err : new ApiError(t().errors.unreadable);
      }
    }
    return body;
  },

  authStatus: () => call<AuthStatus>('/api/auth/status'),
  login: (password: string) =>
    call<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => call<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
};

/** Duree lisible : « 4 s », « 2 min 10 », « 1 h 05 ». */
export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}

/**
 * Horodatage relatif court, sans dependance a une librairie de dates.
 *
 * `Intl.RelativeTimeFormat` fait le travail dans les deux langues, et le fait
 * correctement : « il y a 1 j » cote francais, « 1 day ago » cote anglais,
 * avec les pluriels de chaque langue. Une table de suffixes maison aurait
 * fini par ecrire « il y a 1 jours ».
 */
export function timeAgo(iso: string, locale: string = currentLocale()): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return rtf.format(0, 'minute');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.floor(hours / 24), 'day');
}

export function clock(iso: string, locale: string = currentLocale()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Langue courante pour le formatage des dates.
 *
 * Ces fonctions sont appelees depuis des tables de plusieurs dizaines de
 * lignes ; leur passer la langue en parametre depuis chaque cellule aurait
 * alourdi tous les appelants pour une information deja globale.
 */
function currentLocale(): string {
  return getCurrentLocale();
}
