/**
 * @vitest-environment jsdom
 */
/**
 * Tests du panneau « ce qui est déjà connu ».
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Depuis que les caches de verdicts survivent au redémarrage, trois choses
 * doivent rester vraies à l'écran, et chacune casse en silence :
 *
 *   - LA MÉMOIRE SE VOIT. Une mémoire qu'on ne voit pas est une mémoire qu'on
 *     ne pense pas à vider — et c'est le premier réflexe utile quand on
 *     soupçonne un verdict figé sur du code qu'on vient de corriger ;
 *   - L'OUBLI EXISTE. Redémarrer le service suffisait avant ; ce n'est plus
 *     vrai. Sans ce bouton, personne n'a de moyen de vérifier ;
 *   - UNE REPRISE RATÉE SE DIT. Un cache qu'on croit chargé et qui ne l'est
 *     pas transforme un scan censé être gratuit en scan facturé, sans que
 *     rien ne l'explique.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { api, type CacheState, type ScanSettingsResponse } from '../lib/api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cacheState = (overrides: Partial<CacheState> = {}): CacheState => ({
  persisted: true,
  restored: [
    { kind: 'verdicts', kept: 12, dropped: 0, why: null },
    { kind: 'arbitration', kept: 3, dropped: 0, why: null },
  ],
  detection: { entries: 12, hits: 7, misses: 5, expired: 0 },
  arbitration: { entries: 3, hits: 2, misses: 1, expired: 0 },
  ...overrides,
});

const settings = (cache: CacheState | undefined): ScanSettingsResponse => ({
  settings: { bypassClaudeForHighConfidence: false, detectionConcurrency: 4 },
  thresholds: { reject_below: 0.4, direct_alert_above: 0.7 },
  limits: { concurrency: { min: 1, max: 16 } },
  cache,
});

function mount(cache: CacheState | undefined = cacheState()) {
  vi.spyOn(api, 'getScanSettings').mockResolvedValue(settings(cache));
  return render(<SettingsPage providers={null} onProviderChange={async () => {}} busy={false} />);
}

describe('Panneau du cache', () => {
  it('montre ce qui est déjà connu plutôt que de le taire', async () => {
    mount();
    // Les chiffres viennent du serveur : les recopier en dur ici les ferait
    // mentir le jour où ils bougeraient.
    expect(await screen.findByText('12')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    // 7 + 2 : les réponses resservies des deux caches, additionnées.
    expect(screen.getByText('9')).toBeTruthy();
  });

  it('dit que la mémoire survit au redémarrage quand c est le cas', async () => {
    mount();
    expect(await screen.findByText(/survive a restart/i)).toBeTruthy();
  });

  it('dit AUSSI quand elle n y survit pas', async () => {
    // Croire que le cache persiste alors qu'il est en RAM, c'est s'étonner de
    // repayer chaque redémarrage sans comprendre pourquoi.
    mount(cacheState({ persisted: false }));
    expect(await screen.findByText(/a restart clears it/i)).toBeTruthy();
  });

  it('signale une reprise qui a échoué, avec sa raison', async () => {
    mount(
      cacheState({
        restored: [
          { kind: 'verdicts', kept: 0, dropped: 40, why: 'cache written by another format (v2)' },
        ],
      })
    );

    const warning = await screen.findByRole('status');
    expect(warning.textContent).toContain('verdicts');
    expect(warning.textContent).toContain('another format');
    // Et surtout : ce n'est PAS une panne. Le texte doit le dire, sinon on
    // cherche un problème là où il n'y en a pas.
    expect(warning.textContent).toContain('Nothing is broken');
  });

  it("ne signale rien quand la reprise s'est bien passée", async () => {
    mount();
    await screen.findByText('12');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offre l oubli, et affiche le nouvel état sans recharger la page', async () => {
    mount();
    const forget = vi
      .spyOn(api, 'forgetCache')
      .mockResolvedValue({
        cache: cacheState({
          detection: { entries: 0, hits: 7, misses: 5, expired: 0 },
          arbitration: { entries: 0, hits: 2, misses: 1, expired: 0 },
          restored: [],
        }),
      });

    const button = await screen.findByRole('button', { name: /forget everything/i });
    await userEvent.click(button);

    expect(forget).toHaveBeenCalledTimes(1);
    // L'écran suit : un bouton qui n'a l'air de rien faire se reclique.
    await waitFor(() => expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2));
  });

  it("n'affiche aucun panneau quand le service ne renvoie pas d'état", async () => {
    // Un service plus ancien que la console ne doit pas produire un panneau
    // vide rempli de zéros : ce serait affirmer « rien en mémoire » alors
    // qu'on n'en sait rien.
    mount(undefined);
    await waitFor(() => expect(screen.queryByText(/what is already known/i)).toBeNull());
  });
});
