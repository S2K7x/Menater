/**
 * @vitest-environment jsdom
 */
/**
 * Le scan interrompu, vu de l'interface.
 *
 * ============================================================================
 * CE QU'IL PROTÈGE
 *
 * Depuis que l'état des runs survit au redémarrage, le service peut répondre
 * un quatrième statut : `interrupted`. Il ne veut dire ni « réussi » ni
 * « échoué » — il veut dire « le service s'est arrêté pendant ce scan ».
 *
 * Deux façons de le rater, et les deux étaient réelles avant ce test :
 *
 *   - LE TRAITER COMME UN ÉCHEC MUET. `status === 'failed'` était la seule
 *     branche qui posait un message ; un run interrompu tombait dans « pas de
 *     rapport » et s'affichait en échec SANS un mot d'explication, alors que
 *     le serveur en fournit une, écrite en langage courant.
 *   - LE TRAITER COMME « EN COURS ». Ce serait le pire : une attente devant un
 *     scan que plus personne n'exécute.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

import { useScan } from './useScan.ts';
import { api, type RunSnapshot } from './api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const INTERRUPTED_MESSAGE =
  'This scan was interrupted before it finished — the service stopped while it was running. Run it again to get one.';

function snapshot(overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    run_id: 'run-1',
    status: 'done',
    events: [],
    error: null,
    report: null,
    usage: null,
    estimate: null,
    target: null,
    effective_mode: null,
    routes_analyzed: null,
    routes_failed: null,
    ...overrides,
  };
}

/** Lance un scan et laisse le flux se terminer tout de suite. */
async function runWith(state: RunSnapshot) {
  vi.spyOn(api, 'estimateScan').mockResolvedValue({
    estimate_id: 'est-1',
    estimate: { plain_language_summary: 'ok' } as never,
  } as never);
  vi.spyOn(api, 'launchScan').mockResolvedValue({ run_id: 'run-1', notes: [] } as never);
  vi.spyOn(api, 'getRun').mockResolvedValue(state);
  vi.spyOn(api, 'streamEvents').mockImplementation((_id, handlers) => {
    // Le flux se ferme immédiatement : c'est ce qui arrive quand le serveur a
    // déjà répondu que le run est terminal.
    queueMicrotask(() => handlers.onEnd());
    return () => {};
  });

  const hook = renderHook(() => useScan());
  await act(async () => {
    await hook.result.current.estimate({ target: '/tmp/projet', mode: 'full_scan' });
  });
  await act(async () => {
    await hook.result.current.confirm();
  });
  return hook;
}

describe('Un scan interrompu', () => {
  it("n'est ni « en cours » ni « réussi »", async () => {
    const hook = await runWith(snapshot({ status: 'interrupted', error: INTERRUPTED_MESSAGE }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('interrupted'));
    expect(hook.result.current.state.phase).not.toBe('running');
    expect(hook.result.current.state.phase).not.toBe('done');
  });

  it("garde l'explication du serveur au lieu d'un message générique", async () => {
    // Le serveur écrit déjà cette phrase pour un non-développeur. La
    // remplacer par « l'analyse a été interrompue » perdrait le seul conseil
    // utile : relancer.
    const hook = await runWith(snapshot({ status: 'interrupted', error: INTERRUPTED_MESSAGE }));

    await waitFor(() => expect(hook.result.current.state.error).toBe(INTERRUPTED_MESSAGE));
    expect(hook.result.current.state.error).toContain('Run it again');
  });

  it('retombe sur un message générique si le serveur n en donne aucun', async () => {
    // Jamais d'écran muet : l'absence de raison ne doit pas produire l'absence
    // de message.
    const hook = await runWith(snapshot({ status: 'interrupted', error: null }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('interrupted'));
    expect(hook.result.current.state.error).toBeTruthy();
  });

  it('un scan réussi reste réussi', async () => {
    const hook = await runWith(snapshot({ status: 'done', report: { scan_summary: {} } as never }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('done'));
    expect(hook.result.current.state.error).toBeNull();
  });

  it('un échec franc reste un échec', async () => {
    const hook = await runWith(snapshot({ status: 'failed', error: 'le modèle a refusé' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('failed'));
    expect(hook.result.current.state.error).toBeTruthy();
  });

  it("un « terminé » sans rapport n'est pas présenté comme une réussite", async () => {
    // Comportement d'origine, conservé : techniquement terminé, mais rien à
    // montrer, donc rien à célébrer.
    const hook = await runWith(snapshot({ status: 'done', report: null }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('failed'));
  });
});
