/**
 * @vitest-environment jsdom
 */
/**
 * The database block, on the install where the environment owns it.
 *
 * `server/config.ts`'s `DB_ENV` names six variables that WIN over `config.json`
 * for this block alone — and since the override now applies to a save too, a
 * field a variable owns cannot be changed from here at all. So the screen owes
 * the operator two things, and had neither: WHICH fields those are, and WHERE
 * to change them. `meta.from_env` was written by the server and read by
 * nothing.
 *
 * The rule being applied is the one `CredentialStatus.locked` already states in
 * its own type header: *offering an input that the server will refuse is worse
 * than offering none.* Same product, same screen, the other half of it.
 *
 * MOUNTED WITH DATA, per `CLARITY.md`: an empty screen shows none of its
 * defects, and the whole subject here is a state no default install is in.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { api } from '../lib/api.ts';
import type { SettingsPayload } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * What the server has: the coordinates the console will really dial.
 *
 * `preset: 'local'` on purpose — it is what lets one test press a preset whose
 * ONLY remaining effect is on locked fields, and check the save bar stays
 * quiet. The values are deliberately not the preset's own.
 */
const SERVED = {
  preset: 'local' as const,
  host: 'postgres',
  port: 6543,
  database: 'menater',
  user: 'menater',
  ssl: true,
  passwordSet: true,
};

const payload = (fromEnv: Record<string, string>): SettingsPayload =>
  ({
    settings: {
      webhook: { mode: 'off', secretSet: false },
      tunnel: { hostname: '', tokenSet: false },
      console: { refreshSeconds: 20, executionWindow: 120, forceDemo: false },
      auth: { enabled: false, passwordSet: false },
      database: SERVED,
      pipeline: {
        shadowMode: true,
        slackApproval: '', slackEscalation: '', slackWarnings: '', slackCritical: '',
        ticketEndpoint: '', isolationEndpoint: '',
        isolationTtlMinutes: 60,
        errorWindowMinutes: 60, errorSystemicThreshold: 5, errorSuppressMinutes: 30,
      },
      variables: {},
      ingestion: { sources: [], policy: { delivery: 'hybrid', fastLane: ['critical', 'high'] } },
      assistant: {
        enabled: true, provider: 'openrouter', model: '', maxSteps: 6,
        mcpEnabled: false, mcpTokenSet: false,
      },
      inventory: { entries: [] },
      meta: {
        config_path: '/tmp/config.json',
        config_exists: true,
        from_env: { database: fromEnv },
      },
    },
    connection_string: 'postgresql://menater:********@postgres:6543/menater',
  }) as unknown as SettingsPayload;

/** Renders Settings and opens the Database section. */
async function openDatabase(fromEnv: Record<string, string>) {
  vi.spyOn(api, 'settings').mockResolvedValue(payload(fromEnv));
  vi.spyOn(api, 'credentials').mockResolvedValue({ credentials: [] } as never);
  vi.spyOn(api, 'assistantProviders').mockResolvedValue({ providers: [] } as never);
  const save = vi.spyOn(api, 'saveSettings').mockResolvedValue(payload(fromEnv));
  const probe = vi.spyOn(api, 'testDatabase').mockResolvedValue({ ok: true } as never);

  const user = userEvent.setup();
  render(<SettingsPage onChanged={() => {}} />);
  await waitFor(() => expect(screen.getByRole('tab', { name: /Database/ })).toBeTruthy());
  await user.click(screen.getByRole('tab', { name: /Database/ }));
  return { user, save, probe };
}

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe('a database field the environment owns', () => {
  it('is shown read-only rather than as an input the server will refuse', async () => {
    await openDatabase({ host: 'MENATER_DB_HOST' });
    expect(field(/^Host/).disabled).toBe(true);
    expect(field(/^Host/).value).toBe('postgres');
  });

  /**
   * The operator has to be able to go and change it. A read-only field that
   * does not say where the value comes from is the state the comment on
   * `from_env` was written against: "someone rewrites it without understanding
   * why it keeps coming back".
   */
  it('names the variable to change, once for the block', async () => {
    await openDatabase({ host: 'MENATER_DB_HOST', password: 'MENATER_DB_PASSWORD' });
    const note = screen.getByText(/Read-only here/);
    expect(note.textContent).toContain('MENATER_DB_HOST');
    expect(note.textContent).toContain('MENATER_DB_PASSWORD');
    expect(note.textContent).toMatch(/will not override it/);
  });

  it('marks which field it is, on the field itself', async () => {
    await openDatabase({ ssl: 'MENATER_DB_SSL' });
    expect(screen.getByText(/Require TLS/).textContent).toContain('from the environment');
  });

  /**
   * THE BOUNDARY, and it passes before and after on purpose: locking the whole
   * block because one variable is set would be a different defect wearing this
   * fix. Only the fields a variable NAMES are read-only.
   */
  it('leaves every other field editable', async () => {
    await openDatabase({ host: 'MENATER_DB_HOST' });
    expect(field(/^Port/).disabled).toBe(false);
    expect(field(/^Database$/).disabled).toBe(false);
    expect(field(/^User/).disabled).toBe(false);
  });

  it('says nothing at all on an install where no variable is set', async () => {
    await openDatabase({});
    expect(screen.queryByText(/Read-only here/)).toBeNull();
    expect(field(/^Host/).disabled).toBe(false);
  });
});

describe('what the preset buttons can still do', () => {
  /**
   * A preset rewrites the WHOLE block into the draft, so it does not take a
   * keystroke to put a refused value on screen — and the draft is what the old
   * code displayed, tested and sent. All three now read the effective block.
   */
  it('cannot make a locked field show a value the server has refused', async () => {
    const { user } = await openDatabase({ host: 'MENATER_DB_HOST' });
    await user.click(screen.getByRole('button', { name: 'Local Postgres' }));
    // The preset asks for `localhost`; the variable owns the field.
    expect(field(/^Host/).value).toBe('postgres');
  });

  /**
   * And it is not an unsaved change either. The `local` preset writes host,
   * port and ssl, and the served `preset` is already `local` — so with those
   * three owned by variables the press has nothing left it may change, and a
   * save bar that lights for it is a warning that never goes out. Same rule
   * the inventory's own dirty check already applies: compare what a save would
   * SEND.
   */
  it('does not light the save bar for a change it cannot make', async () => {
    const { user } = await openDatabase({
      host: 'MENATER_DB_HOST', port: 'MENATER_DB_PORT', ssl: 'MENATER_DB_SSL',
    });
    await user.click(screen.getByRole('button', { name: 'Local Postgres' }));
    expect(screen.queryByText(/Unsaved changes/i)).toBeNull();
  });

  it('still applies to the fields no variable owns', async () => {
    const { user } = await openDatabase({ host: 'MENATER_DB_HOST' });
    await user.click(screen.getByRole('button', { name: 'Supabase' }));
    // `supabase` writes port 5432 and TLS on; the served port was 6543.
    expect(field(/^Port/).value).toBe('5432');
    expect(field(/^Host/).value).toBe('postgres');
    expect(screen.getByText(/Unsaved changes/i)).toBeTruthy();
  });

  it('SENDS the effective block, never the refused value', async () => {
    const { user, save } = await openDatabase({ host: 'MENATER_DB_HOST' });
    await user.click(screen.getByRole('button', { name: 'Local Postgres' }));
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect((save.mock.calls[0][0] as { database: { host: string } }).database.host).toBe('postgres');
  });
});

describe('the connectivity probe', () => {
  /**
   * "A diagnostic that answered about a port it had not dialled", one field
   * over: the button read the DRAFT, so on a locked install it could probe a
   * host the console will never connect to and report it either way.
   */
  it('probes the coordinates the console will really dial', async () => {
    const { user, probe } = await openDatabase({ host: 'MENATER_DB_HOST' });
    await user.click(screen.getByRole('button', { name: 'Local Postgres' }));
    await user.click(screen.getByRole('button', { name: /Test/i }));
    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(probe.mock.calls[0][0]).toEqual({ host: 'postgres', port: 5432 });
  });
});
