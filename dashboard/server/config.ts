/**
 * MENATER's configuration store.
 *
 * ============================================================================
 * THREE RULES ABOUT SECRETS
 *
 *  1. A SECRET NEVER COMES BACK OUT. `publicView()` replaces every secret with
 *     a "set / not set" boolean. The browser can WRITE an API key, it can never
 *     READ it back — not even the legitimate user. That is what makes a tab
 *     left open, or a browser cache, harmless.
 *
 *  2. AN EMPTY SECRET FIELD CLEARS NOTHING. The form returns an empty string
 *     for a secret nobody retyped; reading that as "erase the key" would lose
 *     the configuration on every save. To erase, `null` must be sent
 *     explicitly.
 *
 *  3. THE FILE IS 0600 AND GITIGNORED. It holds database passwords.
 *
 * ============================================================================
 * PRECEDENCE: FILE > ENVIRONMENT > DEFAULT
 *
 * The environment bootstraps (containerised deployment, CI); the file is what
 * the interface edits. Without that order, a setting changed in the interface
 * would be overwritten at the next start by a forgotten variable — the kind of
 * inconsistency that takes an hour to understand.
 * ============================================================================
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPolicy, type IngestionPolicy } from './ingest/policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the configuration file lives.
 *
 * `MENATER_CONFIG` wins: in a container the configuration lives in a VOLUME,
 * not in the image. Without this variable it would be written to the
 * container's ephemeral layer and vanish on every redeployment — taking with
 * it the console password, the ingestion secret and the tunnel token.
 */
export const CONFIG_PATH = process.env.MENATER_CONFIG || join(HERE, '..', 'config.json');

export interface AppConfig {
  /**
   * Pipeline variables, read by the workflows ON EVERY execution.
   *
   * A value changed here applies to the NEXT execution, with no restart.
   * These used to be a container's environment variables, which meant editing
   * `docker-compose` and restarting to move a threshold.
   *
   * They will live in `soc_variable` once the database is wired in; this file
   * is their first home, not their final one.
   */
  variables: Record<string, string | number | boolean>;

  /**
   * The alert entry point, carried by the console.
   *
   * `mode` decides what the engine does with an alert it receives:
   *   `off` — the endpoint refuses. The default: we do not open a door by
   *           accident, least of all one exposed to the Internet.
   *   `on`  — the engine handles it. There is no third mode any more: the old
   *           `shadow` relayed to an n8n and returned ITS answer, which had
   *           meaning only while a migration was in progress.
   */
  webhook: {
    mode: 'off' | 'on';
    /**
     * Shared secret required in the `X-SOC-Token` header.
     *
     * MANDATORY as soon as the tunnel is up: an ingestion endpoint open to
     * the Internet accepts alerts from anyone, and an alert is what triggers
     * the isolation of a machine.
     */
    secret: string;
  };

  /**
   * N5 — how alerts get in: which transport carries which severity, and what
   * we poll.
   *
   * Separate from `webhook` on purpose. `webhook.mode` answers "is the door
   * open, and who answers the sender" — a security question. This answers
   * "which door should this alert have used" — a latency and load question.
   * Folding them into one setting would make opening the endpoint and
   * choosing an architecture the same click.
   *
   * The shape, the defaults and the validation live in `ingest/policy.ts`;
   * this file only stores it.
   */
  ingestion: IngestionPolicy;

  /**
   * Cloudflare tunnel: makes the webhook reachable from outside.
   *
   * The token carries the tunnel's identity — it is a secret in the same
   * sense as an API key, and it never leaves the server.
   */
  tunnel: { token: string; hostname: string };
  console: { refreshSeconds: number; executionWindow: number; forceDemo: boolean };
  auth: { enabled: boolean; salt: string; hash: string };
  database: {
    preset: 'local' | 'supabase' | 'custom';
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
  };
  /**
   * The in-console assistant.
   *
   * `enabled` is a switch an operator can throw; it is NOT what makes the
   * assistant safe. What makes it safe is that its tool catalogue contains no
   * write (`server/assistant/tools.ts`). The switch exists so an installation
   * that does not want a model reading its logs at all can say so once, rather
   * than relying on nobody setting a key.
   */
  assistant: {
    enabled: boolean;
    /**
     * `openrouter` | `anthropic` | `openai` | `google`.
     *
     * Kept as a plain string rather than a union: `providers.ts` owns the list,
     * and duplicating it here would let the two drift — with the type saying
     * one thing and the adapter table another.
     */
    provider: string;
    model: string;
    /** Reasoning steps before the loop is forced to answer in words. */
    maxSteps: number;
    /**
     * The MCP endpoint: the same read-only catalogue, for consumers outside the
     * console (Claude Desktop, an editor, another agent).
     *
     * OFF by default, and an empty token CLOSES the door rather than opening
     * it — the same rule as the ingestion secret. "No authentication
     * configured" must never read as "no authentication required" on a port a
     * container publishes.
     */
    mcpEnabled: boolean;
    mcpToken: string;
  };

  pipeline: {
    shadowMode: boolean;
    slackApproval: string;
    slackEscalation: string;
    slackWarnings: string;
    slackCritical: string;
    ticketEndpoint: string;
    isolationEndpoint: string;
    isolationTtlMinutes: number;
    errorWindowMinutes: number;
    errorSystemicThreshold: number;
    errorSuppressMinutes: number;
  };
}

/** Paths of the fields that must never be sent back to the browser. */
const SECRET_PATHS = [
  'database.password', 'auth.salt', 'auth.hash',
  'webhook.secret', 'tunnel.token',
  // The MCP bearer token. It is the ONLY thing between a published port and
  // this installation's alert data, so it obeys the same three rules as the
  // rest: never returned, an empty field keeps it, `null` erases it.
  'assistant.mcpToken',
] as const;

const env = (...names: string[]): string | undefined => {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
};

function defaults(): AppConfig {
  return {
    // The defaults ARE the fail-safe configuration: `pipeline.shadowMode` set
    // to `true` is part of that. A fresh install executes nothing.
    variables: {
      'pipeline.shadowMode': true,
      'approval.timeoutMinutes': 30,
      'isolation.ttlMinutes': 60,
      'shadow.exitThreshold': 50,
      'errors.windowMinutes': 60,
      'errors.systemicThreshold': 5,
      'errors.suppressMinutes': 30,
      /*
        WHERE NOTIFICATIONS GO, and by which transport.

          `slack-bot`       the bot token. The only one that can route to a
                            different channel per purpose, so the four channel
                            settings below mean something.
          `slack-webhook`   one incoming-webhook URL. Slack locks it to a single
                            channel; the channel settings stop applying.
          `discord-webhook` one Discord webhook URL. Same single-channel rule,
                            and a different payload — Discord speaks `content`
                            and `embeds`, not `text` and `blocks`.

        Not `slack.transport` any more: naming the setting after one of three
        destinations made it a lie the day Discord was added.
      */
      'notify.transport': 'slack-bot',
      /*
        THE LOWEST ALERT SEVERITY THAT REACHES A CHAT NOTIFICATION.

        `low` is the default and means "notify me about everything", which is
        what the pipeline did before this setting existed — a new knob must not
        change behaviour on an install that never touches it.

        `off` sends nothing at all. The consequence is deliberate and stated on
        the settings screen: an approval request that is not posted is a
        question nobody was asked, so the alert is NOT left waiting thirty
        minutes for an answer that cannot come. It escalates immediately, the
        case says why, and no action is ever executed on it. Silence stays a
        refusal, never a consent.
      */
      'notify.minSeverity': 'low',
      'slack.approvalChannel': '#soc-approvals',
      'slack.escalationChannel': '#soc-escalation',
      'slack.warningsChannel': '#soc-automation-warnings',
      'slack.criticalChannel': '#soc-automation-critical',
      'endpoint.isolation': '',
      'endpoint.ticket': '',
      'llm.model': 'anthropic/claude-sonnet-4.5',
    },
    // `off` by default: we do not open an ingestion door by accident.
    webhook: { mode: 'off', secret: '' },
    // Hybrid: push for what must be contained in seconds, pull for the rest.
    // See the header of `ingest/policy.ts` for why that is the default and
    // not a compromise.
    ingestion: defaultPolicy(),
    tunnel: { token: env('CLOUDFLARE_TUNNEL_TOKEN') ?? '', hostname: '' },
    console: { refreshSeconds: 20, executionWindow: 120, forceDemo: false },
    auth: { enabled: false, salt: '', hash: '' },
    // The database coordinates come from the environment when it supplies
    // them. WITHOUT THIS THE ENGINE CONNECTS TO NOTHING IN A CONTAINER: the
    // `localhost` default points at the console's own container, where nobody
    // is listening, and the failure shows only inside the `console_engine`
    // block of a webhook reply — which is to say, never.
    database: {
      preset: env('MENATER_DB_HOST') ? 'custom' : 'local',
      host: env('MENATER_DB_HOST') ?? 'localhost',
      port: Number(env('MENATER_DB_PORT') ?? 5432),
      // `menater`, not `n8n`: the default database name was a leftover from
      // when the pipeline lived in one. Docker sets this explicitly; a manual
      // install would otherwise look for a database nobody creates any more.
      database: env('MENATER_DB_NAME') ?? 'menater',
      user: env('MENATER_DB_USER') ?? 'n8n_soc',
      password: env('MENATER_DB_PASSWORD') ?? '',
      ssl: env('MENATER_DB_SSL') === 'true',
    },
    // Enabled by default, and inert by default: with no key set the panel
    // says which key is missing instead of appearing broken. The switch is
    // for installations that decide against it, not for the absence of setup.
    assistant: {
      enabled: true,
      provider: env('ASSISTANT_PROVIDER') ?? 'openrouter',
      model: env('ASSISTANT_MODEL') ?? '',
      maxSteps: 6,
      mcpEnabled: false,
      mcpToken: env('MENATER_MCP_TOKEN') ?? '',
    },
    pipeline: {
      shadowMode: true,
      slackApproval: '#soc-approvals',
      slackEscalation: '#soc-escalation',
      slackWarnings: '#soc-automation-warnings',
      slackCritical: '#soc-automation-critical',
      ticketEndpoint: '',
      isolationEndpoint: '',
      isolationTtlMinutes: 60,
      errorWindowMinutes: 60,
      errorSystemicThreshold: 5,
      errorSuppressMinutes: 30,
    },
  };
}

/** Deep merge, one level of sections: enough for this shape. */
function merge(base: AppConfig, patch: any): AppConfig {
  const out: any = { ...base };
  for (const section of Object.keys(base) as (keyof AppConfig)[]) {
    if (patch && typeof patch[section] === 'object' && patch[section] !== null) {
      out[section] = { ...base[section], ...patch[section] };
    }
  }
  return out as AppConfig;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  let stored: any = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      // A corrupt file must not stop the console from starting: we fall back
      // to the defaults and say so in the logs.
      console.error(`[menater] ${CONFIG_PATH} unreadable — using the default configuration.`);
      stored = {};
    }
  }
  cached = applyEnvOverrides(migrateVariables(merge(defaults(), stored)));
  return cached;
}

/**
 * The environment wins over the file, for the database coordinates.
 *
 * SAME PRECEDENCE AS THE ANALYSIS ENGINES' KEYS: a value set by Docker, the
 * shell or CI is a deployment decision, and a `config.json` written once must
 * not mask it forever. Without this, the volume's file — laid down at first
 * start with the `localhost` default — survives every correction to the stack,
 * and the engine keeps looking for a database inside its own container.
 *
 * Concerns the database ONLY: the other settings are operational choices made
 * from the Settings page, and the environment has no business freezing them.
 */
/**
 * Carries forward variables that were renamed.
 *
 * `merge` keeps whatever a stored `config.json` holds, so a renamed variable
 * would leave the OLD key sitting in the list — editable, saved, and read by
 * nothing. A setting that looks applied and is not is the exact failure this
 * product refuses everywhere else, so the rename is completed here rather than
 * left for someone to notice.
 *
 * The value is carried over, not reset: somebody who chose a threshold keeps it.
 */
const RENAMED_VARIABLES: Record<string, string> = {
  'slack.transport': 'notify.transport',
  'slack.minSeverity': 'notify.minSeverity',
};

/** The values the transport setting used to take, and what they are now. */
const RENAMED_VALUES: Record<string, Record<string, string>> = {
  'notify.transport': { bot: 'slack-bot', webhook: 'slack-webhook' },
};

function migrateVariables(c: AppConfig): AppConfig {
  for (const [before, after] of Object.entries(RENAMED_VARIABLES)) {
    if (!(before in c.variables)) continue;
    if (!(after in c.variables) || c.variables[after] === undefined) {
      c.variables[after] = c.variables[before];
    }
    delete c.variables[before];
  }
  for (const [key, table] of Object.entries(RENAMED_VALUES)) {
    const current = c.variables[key];
    if (typeof current === 'string' && table[current]) c.variables[key] = table[current];
  }
  return c;
}

function applyEnvOverrides(c: AppConfig): AppConfig {
  const host = env('MENATER_DB_HOST');
  const port = env('MENATER_DB_PORT');
  const name = env('MENATER_DB_NAME');
  const user = env('MENATER_DB_USER');
  const password = env('MENATER_DB_PASSWORD');
  const ssl = env('MENATER_DB_SSL');
  if (host !== undefined) c.database.host = host;
  if (port !== undefined) c.database.port = Number(port) || c.database.port;
  if (name !== undefined) c.database.database = name;
  if (user !== undefined) c.database.user = user;
  if (password !== undefined) c.database.password = password;
  if (ssl !== undefined) c.database.ssl = ssl === 'true';
  return c;
}

export function saveConfig(patch: any): AppConfig {
  const current = getConfig();
  const next = merge(current, patch);

  // Rule 2: a secret missing or empty in the patch keeps its current value.
  for (const path of SECRET_PATHS) {
    const [sec, key] = path.split('.') as [keyof AppConfig, string];
    const incoming = patch?.[sec]?.[key];
    if (incoming === undefined || incoming === '') {
      (next[sec] as any)[key] = (current[sec] as any)[key];
    } else if (incoming === null) {
      (next[sec] as any)[key] = '';
    }
  }

  // Bounds: an absurd value typed into the interface must not make the console
  // unusable until someone edits the file by hand.
  next.console.refreshSeconds = Math.min(3600, Math.max(5, Number(next.console.refreshSeconds) || 20));
  next.console.executionWindow = Math.min(500, Math.max(20, Number(next.console.executionWindow) || 120));
  next.database.port = Math.min(65535, Math.max(1, Number(next.database.port) || 5432));
  next.pipeline.isolationTtlMinutes = Math.max(1, Number(next.pipeline.isolationTtlMinutes) || 60);
  next.pipeline.errorWindowMinutes = Math.max(1, Number(next.pipeline.errorWindowMinutes) || 60);
  next.pipeline.errorSystemicThreshold = Math.max(1, Number(next.pipeline.errorSystemicThreshold) || 5);
  next.pipeline.errorSuppressMinutes = Math.max(0, Number(next.pipeline.errorSuppressMinutes) || 30);
  // A step cap of 40 is not a power user's choice, it is a runaway bill. A cap
  // of 0 is an assistant that can never look anything up, which reads as
  // "the assistant is broken".
  next.assistant.maxSteps = Math.min(12, Math.max(1, Number(next.assistant.maxSteps) || 6));
  // An EMPTY model is legitimate and means "this provider's default", which is
  // what makes switching provider a one-field change: the model that belonged
  // to the old provider must not survive as a name the new one has never heard
  // of. `chat.ts` substitutes `provider.defaultModel` when this is empty.
  next.assistant.model = String(next.assistant.model ?? '').trim();
  next.assistant.provider = String(next.assistant.provider || '').trim() || 'openrouter';

  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* filesystem without POSIX permissions: not a reason to stop */
  }
  cached = next;
  return next;
}

/**
 * The view meant for the browser. Secrets are replaced by a boolean, and we
 * say which settings come from the environment — the user has to be able to
 * understand why a field is already filled in.
 */
export function publicView() {
  const c = getConfig();
  return {
    webhook: { mode: c.webhook.mode, secretSet: c.webhook.secret !== '' },
    // No secret in here: a pull source names the CREDENTIAL it uses, never
    // holds the value. Rule 1 applies to outbound calls too.
    ingestion: c.ingestion,
    tunnel: { hostname: c.tunnel.hostname, tokenSet: c.tunnel.token !== '' },
    console: c.console,
    auth: { enabled: c.auth.enabled, passwordSet: c.auth.hash !== '' },
    database: { ...c.database, password: undefined, passwordSet: c.database.password !== '' },
    pipeline: c.pipeline,
    assistant: {
      enabled: c.assistant.enabled,
      provider: c.assistant.provider,
      model: c.assistant.model,
      maxSteps: c.assistant.maxSteps,
      mcpEnabled: c.assistant.mcpEnabled,
      // Rule 1, again: the browser can WRITE this token, never read it back.
      mcpTokenSet: c.assistant.mcpToken !== '',
    },
    meta: {
      config_path: CONFIG_PATH,
      config_exists: existsSync(CONFIG_PATH),
      from_env: {
        // A field that is already filled must say
        // where it came from, or someone rewrites it without understanding why
        // it keeps coming back.
        db_host: env('MENATER_DB_HOST') !== undefined,
        db_password: env('MENATER_DB_PASSWORD') !== undefined,
      },
    },
  };
}

// --- Password ---------------------------------------------------------------

/**
 * scrypt rather than SHA-256: a fast hash falls to brute force on a short
 * password, and a SOC console password will be one.
 */
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string): boolean {
  const { salt, hash } = getConfig().auth;
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  // Constant-time comparison: a naive one leaks the length of the correct
  // prefix and makes the password guessable byte by byte.
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * Postgres connection string, for display and copying. The password is
 * replaced by a placeholder: this string ends up in a clipboard, a ticket or
 * a screenshot.
 */
export function connectionString(masked = true): string {
  const d = getConfig().database;
  const pwd = masked ? '********' : encodeURIComponent(d.password);
  const ssl = d.ssl ? '?sslmode=require' : '';
  return `postgresql://${encodeURIComponent(d.user)}:${pwd}@${d.host}:${d.port}/${d.database}${ssl}`;
}
