/**
 * @vitest-environment jsdom
 */
/**
 * S1.3 — the audit chain verification, on screen.
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 *
 * The chain is the product's only tamper evidence, so this screen has exactly
 * two ways to be worse than useless: a green check over a table nobody looked
 * at, and a red one over a table that is fine. Both are states the server
 * genuinely answers — `empty`, `partial`, `unavailable` — and all three of
 * them have `broken === 0` in them.
 *
 * So what is claimed here is the TONE per outcome, because the tone is what an
 * operator reads before the sentence. `soc-banner-ok` is the green one and it
 * is reachable from exactly one outcome.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { api, ApiError, type ChainReport } from '../lib/api.ts';
import { HealthPanel } from './HealthPanel.tsx';
import { consoleDictionary } from '../i18n/console.ts';
import type { HealthReport } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const c = consoleDictionary('en');

const HEALTH: HealthReport = {
  mode: 'live',
  engine: { reachable: true, url: 'postgres://localhost:5432/menater', detail: 'Engine mounted.' },
  workflows: [],
  audit_db: { healthy: true, detail: 'No database error seen in recent runs' },
  blocking_findings: [],
  checked_at: '2026-10-05T00:00:00Z',
};

/** The live region a node sits in, or `null` if nothing would announce it. */
const announcer = (el: Element | null): Element | null =>
  el?.closest('[role="status"], [role="alert"], [aria-live]') ?? null;

/** The banner a sentence was printed in — the tone, which is read first. */
const bannerOf = (el: Element | null): Element | null =>
  el?.closest('.soc-banner') ?? null;

const report = (over: Partial<ChainReport> = {}): ChainReport => ({
  outcome: 'intact',
  response: 'Chain intact: 2,644 audit rows recomputed.',
  verification: {
    checked: 2644, broken: 0, total: 2644, from_id: 0, complete: true, sample: [],
  },
  ...over,
});

async function press(answer: ChainReport | Error) {
  vi.spyOn(api, 'scenarios').mockResolvedValue({ scenarios: [] });
  if (answer instanceof Error) vi.spyOn(api, 'verifyChain').mockRejectedValue(answer);
  else vi.spyOn(api, 'verifyChain').mockResolvedValue(answer);
  const mounted = render(<HealthPanel health={HEALTH} onRefresh={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: new RegExp(c.health.chainRun, 'i') }));
  return mounted;
}

describe('the tone follows the outcome, and green is reachable from one of them', () => {
  it('a whole chain with no mismatch is the green one', async () => {
    await press(report());
    const said = await screen.findByText(/Chain intact/);
    expect(bannerOf(said)!.className).toContain('soc-banner-ok');
  });

  /**
   * THE DEFECT THIS SCREEN EXISTS NOT TO HAVE. An empty table has
   * `broken === 0`, and `pg` sends that zero as the TRUTHY string `"0"`. A
   * green check here congratulates an install on an integrity guarantee it has
   * not yet had the chance to keep.
   */
  it('a table nobody has audited yet is not a verified chain', async () => {
    await press(report({
      outcome: 'empty',
      response: 'No decision has been audited yet, so there is no chain to verify.',
      verification: { checked: 0, broken: 0, total: 0, from_id: 0, complete: true, sample: [] },
    }));
    const said = await screen.findByText(/no chain to verify/);
    const banner = bannerOf(said)!;
    expect(banner.className).not.toContain('soc-banner-ok');
    // Nor red: nothing is wrong, nothing was determined. This screen's own
    // documented fourth state — ND — and the bare banner is its tone.
    expect(banner.className).not.toContain('soc-banner-error');
    expect(banner.className.trim()).toBe('soc-banner');
  });

  /** A bounded walk that found nothing has verified the TAIL, not the chain. */
  it('a clipped walk is a coverage warning, not a clean bill', async () => {
    await press(report({
      outcome: 'partial',
      response: 'No mismatch in the 50,000 most recent of 69,643 audit rows.',
      verification: {
        checked: 50_000, broken: 0, total: 69_643, from_id: 139_288, complete: false, sample: [],
      },
    }));
    const said = await screen.findByText(/50,000 most recent/);
    const banner = bannerOf(said)!;
    expect(banner.className).toContain('soc-banner-warn');
    expect(banner.className).not.toContain('soc-banner-ok');
  });

  it('a mismatch is red, and names the rows', async () => {
    await press(report({
      outcome: 'broken',
      response: '2 of the 2,643 audit rows walked no longer match the sealed chain.',
      verification: {
        checked: 2643,
        broken: 2,
        total: 2643,
        from_id: 0,
        complete: true,
        sample: [
          { id: 100102, alert_id: 'B-50', status: 'TAMPERED: the row content no longer matches its own hash' },
          { id: 100204, alert_id: 'B-101', status: 'BROKEN_LINK: prev_hash does not match the preceding link' },
        ],
      },
    }));
    const said = await screen.findByText(/no longer match the sealed chain/);
    expect(bannerOf(said)!.className).toContain('soc-banner-error');
    // The rows themselves, by id and by the alert they are about: a count
    // alone cannot be taken to an auditor.
    expect(screen.getByText('100102')).toBeTruthy();
    expect(screen.getByText('B-101')).toBeTruthy();
    expect(screen.getByText(/TAMPERED/)).toBeTruthy();
  });

  /**
   * "No database configured" says nothing about the chain. Red there would be
   * a false alarm on the one screen whose red has to stay worth believing —
   * the lesson this project paid for when `pg` returned a bigint as a string
   * and the Health tab announced 38 untraceable decisions over a healthy
   * database.
   */
  it('could-not-look is never dressed as could-not-verify', async () => {
    await press(report({
      outcome: 'unavailable',
      response: 'No database configured: there is no audit chain to verify. Settings → Database.',
      verification: null,
    }));
    const said = await screen.findByText(/no audit chain to verify/);
    expect(bannerOf(said)!.className.trim()).toBe('soc-banner');
  });
});

describe('what the screen owes the person who pressed', () => {
  it('announces the answer, politely, in a region that already existed', async () => {
    const { container } = await press(report());
    // Claimed on the PRESS, but the region has to pre-exist its sentence: one
    // created in the same breath as its first message is announced by some
    // screen readers and missed by others.
    const said = await screen.findByText(/Chain intact/);
    const region = announcer(said);
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('status');
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
  });

  it('has a live region before anything is pressed', async () => {
    vi.spyOn(api, 'scenarios').mockResolvedValue({ scenarios: [] });
    const { container } = render(<HealthPanel health={HEALTH} onRefresh={() => {}} />);
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
  });

  it('reports a client-side refusal in the same slot, not a second one', async () => {
    await press(new ApiError('Authentication required.'));
    const said = await screen.findByText(/Authentication required/);
    expect(announcer(said)).not.toBeNull();
  });

  /**
   * It EXPLAINS, so it folds: one benign cause of a mismatch exists (rows
   * sealed before the id-inside-the-lock fix), and it is read once. The count
   * and the rows REPORT, and they are in the clear — CLARITY § 3.
   */
  it('files the one benign explanation behind the disc, and nothing else', async () => {
    await press(report({
      outcome: 'broken',
      response: '1 of the 2,644 audit rows walked no longer match the sealed chain.',
      verification: {
        checked: 2644,
        broken: 1,
        total: 2644,
        from_id: 0,
        complete: true,
        sample: [{ id: 12, alert_id: 'A-6', status: 'TAMPERED: …' }],
      },
    }));
    const note = await screen.findByText(/allocated OUTSIDE/);
    expect(note.closest('details')).toBeTruthy();
    expect((note.closest('details') as HTMLDetailsElement).open).toBe(false);
    // The rows are NOT behind it.
    expect(screen.getByText('12').closest('details')).toBeNull();
  });

  /** Nothing is listed when nothing mismatched: no empty "rows" heading. */
  it('shows no mismatch list on an intact chain', async () => {
    await press(report());
    await screen.findByText(/Chain intact/);
    expect(screen.queryByText(c.health.chainBreaksTitle)).toBeNull();
  });

  /**
   * The walk is read-only, so the console has nothing to re-read afterwards —
   * and `snapshot.ts` calls its rebuild the most expensive thing this console
   * does. The diagnostic beside it refreshes BECAUSE it re-read the instance.
   */
  it('does not refresh the console over a read-only query', async () => {
    vi.spyOn(api, 'scenarios').mockResolvedValue({ scenarios: [] });
    vi.spyOn(api, 'verifyChain').mockResolvedValue(report());
    const onRefresh = vi.fn();
    render(<HealthPanel health={HEALTH} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(c.health.chainRun, 'i') }));
    await screen.findByText(/Chain intact/);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
