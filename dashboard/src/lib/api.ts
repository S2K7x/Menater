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
  CredentialsPayload, IngestSourcesPayload, RuleTemplate, RuleTestResult,
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

export class ApiError extends Error {}
/** Distincte d'ApiError : elle declenche l'ecran de connexion, pas un bandeau. */
export class AuthRequiredError extends ApiError {}

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
  // 502/503/504 viennent du proxy Vite quand l'API n'ecoute pas : le corps
  // n'est pas du JSON et le code de statut ne dirait rien a un analyste.
  if (res.status === 401) {
    // Le verrou de la console : traite a part pour que l'interface puisse
    // afficher l'ecran de connexion au lieu d'un message d'erreur.
    throw new AuthRequiredError(t().errors.authRequired);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ApiError(t().errors.apiNotResponding);
  }

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(t().errors.unreadable);
  }
  if (!res.ok) {
    throw new ApiError(body?.error ?? t().errors.noExplanation(res.status));
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
