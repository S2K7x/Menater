/**
 * État d'un scan : estimation, lancement, suivi en direct, rapport final.
 *
 * Isolé des composants pour être testable sans DOM.
 *
 * ============================================================================
 * LE PARCOURS EN DEUX TEMPS
 *
 * Avant : « je clique, ça part, je découvre la facture après ».
 * Maintenant : `idle -> estimating -> estimated -> running -> done`.
 *
 * L'étape `estimated` est un point d'arrêt volontaire. Elle coûte quelques
 * secondes et zéro centime — le devis rejoue la pipeline jusqu'au dernier pas
 * gratuit — et c'est le seul moment où l'utilisateur peut encore dire non en
 * connaissance de cause.
 * ============================================================================
 */

import { useCallback, useRef, useState } from 'react';

import { api, ApiError, type RunSnapshot, type ScanTarget } from './api.ts';
import type { StepEvent } from '../components/ScanTimeline.tsx';
import type { ScanEstimate } from '../components/EstimatePanel.tsx';
import type { StepName } from './step_translations.ts';
import { getCurrentLocale } from '../../i18n/context.tsx';
import { dictionary } from '../../i18n/dictionary.ts';

export type ScanPhase =
  | 'idle'
  | 'estimating'
  | 'estimated'
  | 'running'
  | 'done'
  | 'failed'
  /** Le service s'est arrêté pendant le scan. Voir `RunSnapshot.status`. */
  | 'interrupted';

export interface ScanState {
  phase: ScanPhase;
  runId: string | null;
  events: StepEvent[];
  snapshot: RunSnapshot | null;
  /** Devis en attente d'acceptation, puis conservé pendant le scan. */
  estimate: ScanEstimate | null;
  estimateId: string | null;
  /** Message déjà rédigé pour un non-développeur. */
  error: string | null;
  /** Remarques du serveur (repli de fournisseur, etc.). */
  notes: string[];
  /** Étape en cours, pour surligner l'explication correspondante. */
  currentStep: StepName | null;
}

const INITIAL: ScanState = {
  phase: 'idle',
  runId: null,
  events: [],
  snapshot: null,
  estimate: null,
  estimateId: null,
  error: null,
  notes: [],
  currentStep: null,
};

export interface LaunchInput {
  target: string;
  commitSha?: string;
  mode: 'full_scan' | 'incremental_scan';
}

const friendly = (error: unknown): string =>
  error instanceof ApiError ? error.friendly : (error as Error).message;

export function useScan() {
  const [state, setState] = useState<ScanState>(INITIAL);
  const closeStream = useRef<(() => void) | null>(null);
  const pending = useRef<ScanTarget | null>(null);

  const reset = useCallback(() => {
    closeStream.current?.();
    closeStream.current = null;
    pending.current = null;
    setState(INITIAL);
  }, []);

  /** Étape 1 : chiffrer. Rien n'est dépensé ici. */
  const estimate = useCallback(async (input: LaunchInput) => {
    closeStream.current?.();
    setState({ ...INITIAL, phase: 'estimating' });

    const request: ScanTarget = {
      target: input.target,
      commit_sha: input.commitSha || undefined,
      mode: input.mode,
    };
    pending.current = request;

    try {
      const response = await api.estimateScan(request);
      setState({
        ...INITIAL,
        phase: 'estimated',
        estimate: response.estimate,
        estimateId: response.estimate_id,
        notes: response.notes ?? [],
      });
    } catch (error) {
      pending.current = null;
      setState({ ...INITIAL, phase: 'failed', error: friendly(error) });
    }
  }, []);

  /** Étape 2 : lancer pour de vrai, sur la base du devis accepté. */
  const confirm = useCallback(async () => {
    const request = pending.current;
    if (!request) return;

    const accepted = { estimate: null as ScanEstimate | null, estimateId: null as string | null };
    setState((previous) => {
      accepted.estimate = previous.estimate;
      accepted.estimateId = previous.estimateId;
      return { ...previous, phase: 'running', events: [], error: null };
    });

    let launched;
    try {
      launched = await api.launchScan({
        ...request,
        estimate_id: accepted.estimateId ?? undefined,
      });
    } catch (error) {
      setState((previous) => ({ ...previous, phase: 'failed', error: friendly(error) }));
      return;
    }

    setState((previous) => ({
      ...previous,
      runId: launched.run_id,
      estimate: launched.estimate ?? previous.estimate,
      notes: launched.notes ?? previous.notes,
    }));

    const finish = async () => {
      try {
        const snapshot = await api.getRun(launched.run_id);
        setState((previous) => ({
          ...previous,
          snapshot,
          // Un scan techniquement « terminé » mais sans rapport reste un échec
          // du point de vue de l'utilisateur : on ne l'affiche pas comme réussi.
          phase:
            snapshot.status === 'interrupted'
              ? 'interrupted'
              : snapshot.status === 'failed' || !snapshot.report
                ? 'failed'
                : 'done',
          // Le serveur explique DÉJÀ l'interruption en langage courant : la
          // remplacer par un message générique perdrait ce qu'elle dit.
          // Sans elle, un scan coupé s'affichait « échec » sans un mot.
          error:
            snapshot.status === 'interrupted'
              ? (snapshot.error ?? dictionary(getCurrentLocale()).errors.scanInterrupted)
              : snapshot.status === 'failed'
                ? dictionary(getCurrentLocale()).errors.scanInterrupted
                : previous.error,
        }));
      } catch (error) {
        setState((previous) => ({ ...previous, phase: 'failed', error: friendly(error) }));
      }
    };

    closeStream.current = api.streamEvents(launched.run_id, {
      onEvent: (event) =>
        setState((previous) => ({
          ...previous,
          events: [...previous.events, event],
          currentStep: event.status === 'running' ? (event.step as StepName) : previous.currentStep,
        })),
      onEnd: () => void finish(),
      onError: (message) => {
        // Le flux peut tomber alors que le scan continue côté serveur : on
        // récupère quand même l'état final plutôt que de rester bloqué.
        setState((previous) => ({ ...previous, error: message }));
        void finish();
      },
    });
  }, []);

  /** Abandonner le devis et revenir au choix de la cible. */
  const cancelEstimate = useCallback(() => {
    pending.current = null;
    setState(INITIAL);
  }, []);

  return { state, estimate, confirm, cancelEstimate, reset };
}
