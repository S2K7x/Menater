/**
 * @vitest-environment jsdom
 */
/**
 * J0.3 — the service inventory, edited on the Settings page.
 *
 * WHY THE SCREEN IS MOUNTED WITH DATA. `CLARITY.md` is blunt about this: an
 * empty screen shows none of its defects. An inventory editor with no rows in
 * it is a heading and a button, and reviewing that proves nothing about the
 * only thing that can go wrong here — what the form SENDS.
 *
 * And what it sends is where the trap is. `config.json` merges one level of
 * sections, so the list travels wrapped in `{ entries: [...] }`: sent as a
 * bare array, a save that removed a machine would spread index by index and
 * leave the removed one behind. Deleting a service would silently not happen,
 * and the console would go on offering its repository from an incident card.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { api } from '../lib/api.ts';
import type { InventoryEntry, SettingsPayload } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ORDERS: InventoryEntry = {
  service: 'orders-api',
  identifiers: ['web-01', '10.12.4.31'],
  repository: '/srv/src/orders-api',
};
const BILLING: InventoryEntry = {
  service: 'billing-api',
  identifiers: ['bill-01'],
  repository: 'https://github.com/acme/billing',
};

const payload = (entries: InventoryEntry[]): SettingsPayload =>
  ({
    settings: {
      webhook: { mode: 'off', secretSet: false },
      tunnel: { hostname: '', tokenSet: false },
      console: { refreshSeconds: 20, executionWindow: 120, forceDemo: false },
      auth: { enabled: false, passwordSet: false },
      database: {
        preset: 'local', host: 'localhost', port: 5432, database: 'menater',
        user: 'n8n_soc', ssl: false, passwordSet: false,
      },
      pipeline: {
        shadowMode: true,
        slackApproval: '', slackEscalation: '', slackWarnings: '', slackCritical: '',
        ticketEndpoint: '', isolationEndpoint: '',
        isolationTtlMinutes: 60,
        errorWindowMinutes: 60, errorSystemicThreshold: 5, errorSuppressMinutes: 30,
      },
      assistant: {
        enabled: true, provider: 'openrouter', model: '', maxSteps: 6,
        mcpEnabled: false, mcpTokenSet: false,
      },
      inventory: { entries },
      meta: {
        config_path: '/tmp/config.json',
        config_exists: true,
        from_env: { db_host: false, db_password: false },
      },
    },
    connection_string: 'postgres://localhost:5432/menater',
  }) as unknown as SettingsPayload;

/** Renders Settings, waits for it to load, and opens the inventory section. */
async function openInventory(entries: InventoryEntry[]) {
  vi.spyOn(api, 'settings').mockResolvedValue(payload(entries));
  vi.spyOn(api, 'credentials').mockResolvedValue({ credentials: [] } as never);
  vi.spyOn(api, 'assistantProviders').mockResolvedValue({ providers: [] } as never);
  const save = vi.spyOn(api, 'saveSettings').mockImplementation(
    async (patch) => payload((patch as { inventory: { entries: InventoryEntry[] } }).inventory.entries),
  );

  const user = userEvent.setup();
  render(<SettingsPage onChanged={() => {}} />);
  await waitFor(() => expect(screen.getByRole('tab', { name: /Service inventory/ })).toBeTruthy());
  await user.click(screen.getByRole('tab', { name: /Service inventory/ }));
  return { user, save };
}

describe('the inventory editor, with rows in it', () => {
  it('shows each service, its identifiers one per line, and its target', async () => {
    await openInventory([ORDERS, BILLING]);
    expect((screen.getByDisplayValue('orders-api') as HTMLInputElement).value).toBe('orders-api');
    // One per line is what someone pastes out of a spreadsheet column, and it
    // is what the field promises in its help text.
    const ids = screen.getAllByLabelText('Hostnames and addresses')[0] as HTMLTextAreaElement;
    expect(ids.value).toBe('web-01\n10.12.4.31');
    expect(screen.getByDisplayValue('https://github.com/acme/billing')).toBeTruthy();
    expect(screen.getByText('2 services listed')).toBeTruthy();
  });

  it('states the exact-match rule in the clear, not behind a fold', async () => {
    // Someone who types an address range here and sees nothing happen
    // concludes the feature is broken. That sentence is the difference
    // between a limitation and a bug.
    await openInventory([ORDERS]);
    expect(screen.getByText(/Matching is exact/)).toBeTruthy();
  });

  it('says the table is empty rather than showing an empty frame', async () => {
    await openInventory([]);
    expect(screen.getByText(/Nothing listed yet/)).toBeTruthy();
  });

  it('SENDS the shorter list when an entry is removed', async () => {
    const { user, save } = await openInventory([ORDERS, BILLING]);
    await user.click(screen.getByRole('button', { name: 'Remove billing-api' }));
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({ inventory: { entries: [ORDERS] } });
  });

  /**
   * The field must not fight the typist.
   *
   * The first version of this form split the textarea on every keystroke and
   * joined the result back into it. An empty line was therefore dropped the
   * instant it was typed: pressing Enter did nothing, and a machine's SECOND
   * address could never be entered. The draft holds the raw text now, and the
   * split happens once on the way out.
   */
  it('accepts a second identifier typed on a new line', async () => {
    const { user, save } = await openInventory([
      { service: 'orders-api', identifiers: ['web-01'], repository: '/srv/src/orders-api' },
    ]);
    const ids = screen.getByLabelText('Hostnames and addresses');
    await user.click(ids);
    await user.keyboard('{End}\n10.12.4.31');
    expect((ids as HTMLTextAreaElement).value).toBe('web-01\n10.12.4.31');

    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      inventory: { entries: [{ identifiers: ['web-01', '10.12.4.31'] }] },
    });
  });

  it('does not treat a trailing blank line as an unsaved change', async () => {
    // Everyone finishes a list with a newline. Flagging it would light an
    // "unsaved changes" warning that never goes out, and a warning that is
    // always on stops being read.
    const { user } = await openInventory([ORDERS]);
    await user.click(screen.getByLabelText('Hostnames and addresses'));
    await user.keyboard('{End}\n');
    expect(screen.queryByText(/unsaved/i)).toBeNull();
  });

  it('sends a new entry wrapped, so the stored list is replaced and not merged', async () => {
    const { user, save } = await openInventory([ORDERS]);
    await user.click(screen.getByRole('button', { name: 'Add a service' }));
    await user.type(screen.getAllByLabelText('Service')[1], 'billing-api');
    await user.type(screen.getAllByLabelText('Hostnames and addresses')[1], 'bill-01');
    await user.type(screen.getAllByLabelText('Code to analyse')[1], '/srv/src/billing');
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      inventory: {
        entries: [
          ORDERS,
          { service: 'billing-api', identifiers: ['bill-01'], repository: '/srv/src/billing' },
        ],
      },
    });
  });
});
