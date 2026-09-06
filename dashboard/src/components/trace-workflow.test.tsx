/**
 * @vitest-environment jsdom
 */
/**
 * Suivi et Workflow : ce que la reduction n'a pas le droit d'emporter.
 *
 * ============================================================================
 * TROIS CONSTATS, TROUVES EN MONTANT CES ECRANS AVEC DES DONNEES
 *
 * Ces deux onglets etaient VIDES sur l'installation de test — pas de base, pas
 * de n8n — et un ecran vide ne montre aucun de ses defauts. Montes avec des
 * donnees de la bonne forme, ils en ont montre trois :
 *
 *   1. Le journal des executions affichait une pastille ERROR rouge et taisait
 *      la RAISON, alors que la donnee la porte. Sur l'ecran dont le travail
 *      est de repondre « pourquoi » quand tout le reste a reduit.
 *
 *   2. Une valeur hors catalogue s'affichait « undefined », en toutes lettres,
 *      a cote du nom d'une etape.
 *
 *   3. Le bloc de comparaison annoncait « bascule refusee, N divergences
 *      bloquantes » sur une installation qui ne migre depuis rien.
 * ============================================================================
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { TracePanel } from './TracePanel.tsx';
import type { TraceExecution, TraceReport, TraceStep } from '../lib/types.ts';

afterEach(cleanup);

const exec = (over: Partial<TraceExecution> = {}): TraceExecution => ({
  execution_id: '206', workflow_id: 'nvCl9', workflow: '03-AI-Decision', status: 'error',
  started_at: '2026-09-04T09:00:00Z', duration_ms: 180, alert_id: 'ALT-1',
  orphan_reason: null, note: null, handoff: 'items', ...over,
});

const step = (over: Partial<TraceStep> = {}): TraceStep => ({
  workflow: '01-Ingestion', execution_id: '100', status: 'success', handoff: 'items',
  started_at: '2026-09-04T09:00:00Z', duration_ms: 210, ...over,
});

const trace = (over: Partial<TraceReport> = {}): TraceReport => ({
  generated_at: '2026-09-04T09:05:00Z',
  window: { limit: 120, inspected: 3, attached: 3, oldest_at: null, newest_at: null, truncated: false },
  stall_after_ms: 300000,
  chains: [],
  orphans: [],
  executions: [],
  counts: { broken: 0, stalled: 0, failed: 0, awaiting: 0, running: 0, complete: 0, orphans: 0, attention: 0 },
  ...over,
});

describe('le journal dit POURQUOI une execution est rouge', () => {
  it('affiche le code d erreur a cote du statut', () => {
    // Une pastille ERROR sans raison, sur l'ecran de dernier recours, oblige
    // a rouvrir n8n pour apprendre ce que la console avait deja sous la main.
    render(
      <TracePanel
        trace={trace({ executions: [exec({ note: 'E_LLM_TIMEOUT' })] })}
        onOpenCase={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText('E_LLM_TIMEOUT')).toBeTruthy();
  });

  it('n affiche rien quand il n y a rien a dire', () => {
    const { container } = render(
      <TracePanel trace={trace({ executions: [exec({ status: 'success', note: null })] })} onOpenCase={() => {}} onRefresh={() => {}} />,
    );
    expect(container.querySelector('.soc-trace-log-note')).toBeNull();
  });
});

describe('une valeur hors catalogue se rend telle quelle, jamais « undefined »', () => {
  it('affiche le statut brut que le moteur a envoye', () => {
    /*
     * La regle du produit : un identifiant de pipeline inconnu s'affiche TEL
     * QUEL plutot que d'etre invente. « undefined » n'est ni l'un ni l'autre —
     * c'est un mot qui ne veut rien dire, pose sur un ecran de diagnostic. Le
     * moteur peut gagner un statut sans que la console se mette a mentir.
     */
    render(
      <TracePanel
        trace={trace({
          chains: [{
            alert_id: 'ALT-1', received_at: '2026-09-04T08:55:00Z',
            last_activity_at: '2026-09-04T09:00:00Z', idle_ms: 1000,
            verdict: 'complete', missing: [], terminal_reason: null, break_at: null, payload: null,
            steps: [step({ status: 'quarantined' as never, handoff: 'deferred' as never })],
          }] as never,
        })}
        onOpenCase={() => {}}
        onRefresh={() => {}}
      />,
    );
    const cell = screen.getByText(/quarantined/);
    expect(cell.textContent).toContain('deferred');
    expect(cell.textContent).not.toContain('undefined');
  });
});
