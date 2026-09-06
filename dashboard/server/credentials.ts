/**
 * Pipeline credentials, settable from the console.
 *
 * ============================================================================
 * THE PROBLEM IT SOLVES
 *
 * The built-in engine reads its credentials from `process.env` and nowhere
 * else, and Settings has no field for any of them. So the only way to give the
 * pipeline a model key was: edit `.env`, rebuild, restart the container.
 *
 * Until that is done EVERY alert takes the fallback — `needs_human`,
 * confidence 0, escalate. That is not an automated SOC, it is a queue that
 * escalates 100% of its traffic, and nothing on screen says the cause is one
 * missing key.
 *
 * This is the same machinery VulnPipe already uses for its engine keys
 * (`VulnPipe/src/config/keystore.ts`), applied to the SOC half. The decisions
 * below are its decisions, repeated rather than shared because the two halves
 * are separate processes.
 *
 * ============================================================================
 * THREE DECISIONS THAT DO NOT GUESS THEMSELVES
 *
 *  1. A KEY SET HERE TAKES EFFECT IMMEDIATELY, no restart. `secretFor()` in
 *     `api.ts` reads `process.env` AT CALL TIME, so writing into `process.env`
 *     is enough — the next alert uses the new key.
 *
 *  2. THE REAL ENVIRONMENT WINS, AND WE SAY SO. A variable set by the shell,
 *     Docker or CI is a deployment decision; a file on disk does not get to
 *     overwrite it silently. When that happens the typed key is REFUSED with
 *     the reason rather than accepted and ignored. Accepting a value that will
 *     never be used is the worse of the two answers.
 *     Precedence: real environment > this store > `.env`.
 *
 *  3. A VALUE NEVER COMES BACK OUT. `describeCredentials()` returns "set" or
 *     "absent" and where it came from, never the key itself — the same
 *     discipline as `publicView()`.
 * ============================================================================
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The variables the console may write.
 *
 * CLOSED LIST, DELIBERATELY. Accepting an arbitrary name would turn this into
 * a way to inject any environment variable into the process — `PATH` included.
 * Anything not on this list is refused.
 *
 * The names are what `secretFor()` derives from the credential names the
 * workflows ask for: `openrouter.apiKey` becomes `OPENROUTER_APIKEY`.
 */
export const MANAGED_CREDENTIALS = [
  { env: 'OPENROUTER_APIKEY', credential: 'openrouter.apiKey', label: 'OpenRouter (triage model)', required: true },
  // Separate from the triage key ON PURPOSE. The triage model decides whether
  // a machine is isolated; the assistant answers an operator's questions. They
  // deserve separate budgets, separate models and separate blast radius — and
  // an installation that wants one key for both simply leaves this one empty,
  // which is what `assistantKey()` falls back on.
  { env: 'ASSISTANT_APIKEY', credential: 'assistant.apiKey', label: 'OpenRouter (console assistant)', required: false },
  // The assistant's other providers. One name per provider, because the store
  // is a CLOSED list — accepting an arbitrary name would turn the settings
  // endpoint into a way to inject any variable into the process. Adding a
  // provider therefore means adding it here as well as in `providers.ts`, and
  // that friction is the point.
  { env: 'ANTHROPIC_APIKEY', credential: 'anthropic.apiKey', label: 'Anthropic (console assistant)', required: false },
  { env: 'OPENAI_APIKEY', credential: 'openai.apiKey', label: 'OpenAI (console assistant)', required: false },
  { env: 'GEMINI_APIKEY', credential: 'gemini.apiKey', label: 'Google Gemini (console assistant)', required: false },
  { env: 'SLACK_BOTTOKEN', credential: 'slack.botToken', label: 'Slack bot token (approvals, escalation)', required: false },
  // The incoming-webhook URL. A SECRET in the same sense as a token: anyone
  // holding it can post into that channel, and it carries its own
  // authorisation — which is exactly why Slack calls it a secret URL and why it
  // belongs in the 0600 store rather than in `config.json`.
  //
  // It is an ALTERNATIVE to the token above, not a companion. See
  // `notify.transport`: a webhook is locked to one channel, a token can route.
  { env: 'SLACK_WEBHOOKURL', credential: 'slack.webhookUrl', label: 'Slack incoming webhook (simplest setup)', required: false },
  // Discord's equivalent, and a secret for the same reason: the URL carries its
  // own authorisation, so anyone holding it can post into that channel.
  { env: 'DISCORD_WEBHOOKURL', credential: 'discord.webhookUrl', label: 'Discord incoming webhook', required: false },
  { env: 'SHODAN_APIKEY', credential: 'shodan.apiKey', label: 'Shodan (enrichment)', required: false },
  { env: 'ABUSEIPDB_APIKEY', credential: 'abuseipdb.apiKey', label: 'AbuseIPDB (enrichment)', required: false },
  { env: 'VIRUSTOTAL_APIKEY', credential: 'virustotal.apiKey', label: 'VirusTotal (enrichment, manual lookup)', required: false },
  // Manual lookup only. The pipeline never asks it anything: an alert carries
  // observables an attacker chose, and an email address in a log is not
  // evidence that address's owner did anything — checking it automatically
  // would spend a per-key quota on someone else's exposure.
  { env: 'HIBP_APIKEY', credential: 'hibp.apiKey', label: 'Have I Been Pwned (manual lookup)', required: false },
] as const;

export type ManagedCredential = (typeof MANAGED_CREDENTIALS)[number]['env'];

const ENV_NAMES: readonly string[] = MANAGED_CREDENTIALS.map((c) => c.env);

export const isManagedCredential = (name: string): name is ManagedCredential =>
  ENV_NAMES.includes(name);

export type CredentialSource = 'environment' | 'store' | 'none';

export interface CredentialStatus {
  env: string;
  credential: string;
  label: string;
  required: boolean;
  set: boolean;
  source: CredentialSource;
  /**
   * `true` when the value comes from the shell or Docker: the console shows
   * the field read-only rather than accepting a key that would be refused.
   */
  locked: boolean;
}

function storePath(): string {
  const configPath = process.env.MENATER_CONFIG ?? join(process.cwd(), 'config.json');
  return process.env.MENATER_CREDENTIALS ?? join(dirname(configPath), 'credentials.json');
}

/**
 * Names seen in the environment BEFORE any file was loaded.
 *
 * Frozen on first call: once we have written into `process.env` we can no
 * longer tell what came from the shell from what we put there ourselves.
 */
let realEnvNames: Set<string> | null = null;

export function snapshotRealEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (realEnvNames) return;
  realEnvNames = new Set(ENV_NAMES.filter((n) => env[n] !== undefined && env[n] !== ''));
}

export const fromRealEnvironment = (name: string): boolean =>
  Boolean(realEnvNames?.has(name));

function readStore(): Record<string, string> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const out: Record<string, string> = {};
    for (const name of ENV_NAMES) {
      const v = raw?.[name];
      if (typeof v === 'string' && v !== '') out[name] = v;
    }
    return out;
  } catch {
    // An unreadable store must not stop the console from starting: start from
    // nothing and say so, exactly as `getConfig()` does with `config.json`.
    console.error(`[menater] ${path} unreadable — pipeline credentials ignored.`);
    return {};
  }
}

function writeStore(values: Record<string, string>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(values, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* filesystem without POSIX permissions: not a reason to fail */
  }
}

/**
 * Applies the store to `process.env`. Call once at startup.
 *
 * The store beats `.env` — a key typed in the interface is a more recent and
 * more deliberate act than a shared `.env` — but never the real environment.
 */
export function applyCredentialStore(env: NodeJS.ProcessEnv = process.env): string[] {
  snapshotRealEnv(env);
  const stored = readStore();
  const touched: string[] = [];
  for (const name of ENV_NAMES) {
    const value = stored[name];
    if (value === undefined) continue;
    if (fromRealEnvironment(name)) continue;
    env[name] = value;
    touched.push(name);
  }
  return touched;
}

/** Status of every managed credential. Never returns a value. */
export function describeCredentials(env: NodeJS.ProcessEnv = process.env): CredentialStatus[] {
  snapshotRealEnv(env);
  const stored = readStore();
  return MANAGED_CREDENTIALS.map((c) => {
    const locked = fromRealEnvironment(c.env);
    const set = env[c.env] !== undefined && env[c.env] !== '';
    const source: CredentialSource = locked
      ? 'environment'
      : stored[c.env] !== undefined
        ? 'store'
        : set ? 'environment' : 'none';
    return {
      env: c.env, credential: c.credential, label: c.label,
      required: c.required, set, source, locked,
    };
  });
}

export class CredentialError extends Error {
  // Explicit field, NOT a parameter property. The service runs under
  // `node --experimental-strip-types`, which strips types without compiling
  // and rejects that syntax; `erasableSyntaxOnly` refuses it at typecheck.
  readonly key: string;

  constructor(message: string, key: string) {
    super(message);
    this.key = key;
  }
}

/**
 * Writes credentials and applies them to the process immediately.
 *
 * Empty means KEEP, matching the rest of the console: a secret field always
 * comes back empty on screen, so reading that as "erase" would delete the key
 * of anyone who saves Settings without touching it. `null` erases.
 */
export function saveCredentials(
  updates: Record<string, string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): CredentialStatus[] {
  snapshotRealEnv(env);
  const stored = readStore();

  for (const [name, value] of Object.entries(updates)) {
    if (!isManagedCredential(name)) {
      throw new CredentialError(`"${name}" is not a credential this console manages.`, name);
    }
    if (fromRealEnvironment(name)) {
      throw new CredentialError(
        `${name} is set in this process's environment (shell, Docker or CI). That is a `
        + 'deployment decision and the console will not override it: change it where it is '
        + 'defined, or unset it there first.',
        name,
      );
    }
    if (value === null) {
      delete stored[name];
      delete env[name];
      continue;
    }
    if (value === undefined || value === '') continue;
    stored[name] = value;
    env[name] = value;
  }

  writeStore(stored);
  return describeCredentials(env);
}
