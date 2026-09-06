/**
 * @vitest-environment jsdom
 */
/**
 * Tests de l'onglet Workflow.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Cet écran a une responsabilité inhabituelle : il doit montrer le pipeline
 * SANS mentir. Deux façons de mentir, et aucune ne lève d'erreur :
 *
 *   - afficher un graphe recomposé, qui pourrait diverger de celui qui
 *     s'exécute — c'est exactement ce que la console vivait avec l'éditeur
 *     n8n, où renommer un nœud la rendait aveugle ;
 *   - masquer l'effet d'une étape sur le monde extérieur, alors que c'est lui
 *     qui décide de ce qui se rejoue après une panne.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { WorkflowPanel, type WorkflowsPayload } from './WorkflowPanel.tsx';
import { api } from '../lib/api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const payload = (): WorkflowsPayload => ({
  workflows: [
    {
      id: '01-ingestion',
      name: 'Ingestion',
      version: 1,
      nodes: [
        {
          id: 'webhook', type: 'trigger.webhook', label: 'POST /soc/alert',
          params: {}, position: { x: 0, y: 0 }, effect: 'pure',
        },
        {
          id: 'dedup', type: 'postgres', label: 'Deduplication',
          note: 'CTE et INSERT dans la même transaction.',
          params: { sql: 'SELECT 1' }, position: { x: 200, y: 0 },
          effect: 'write', retry: { attempts: 2, backoffMs: 400 },
        },
      ],
      edges: [{ from: 'webhook', fromPort: 'main', to: 'dedup' }],
    },
  ],
  variables: {
    'pipeline.shadowMode': true,
    'approval.timeoutMinutes': 30,
    'slack.approvalChannel': '#soc-approvals',
  },
});

/**
 * Ouvre la fiche d'une étape.
 *
 * Le graphe ET la liste portent tous deux `role="button"` — c'est voulu, les
 * deux sont rendus. On choisit ici la ligne de liste (un vrai `<button>`) ;
 * un test dédié vérifie que le graphe mène au même endroit.
 */
async function openNode(label: RegExp) {
  const candidates = await screen.findAllByRole('button', { name: label });
  const row = candidates.find((el) => el.tagName === 'BUTTON');
  await userEvent.click(row ?? candidates[0]);
}

function mount(over: Partial<WorkflowsPayload> = {}) {
  vi.spyOn(api, 'workflows').mockResolvedValue({ ...payload(), ...over });
  // Rendu en FRANÇAIS : c'est la langue par défaut de la console (le
  // fournisseur pose `fallbackLocale="fr"`), et celle des libellés vérifiés
  // ici. Le catalogue anglais est couvert par le test de complétude des
  // catalogues, qui refuse une clé ajoutée d'un seul côté.
  render(<WorkflowPanel />);
  // « Ingestion » apparaît deux fois : sur le sous-onglet et sur le titre du
  // bloc. On attend simplement que l'écran soit monté.
  return screen.findAllByText('Ingestion');
}

describe('le graphe vient de la définition qui s’exécute', () => {
  it('dessine un nœud par étape, avec son type', async () => {
    await mount();
    // Le TYPE est affiché sur le nœud : c'est lui qui dit ce que l'étape fait
    // vraiment, indépendamment de l'étiquette qu'on lui a donnée.
    // Chaque étape apparaît deux fois : sur le graphe et sur la liste, qui
    // sont tous deux rendus — l'un est masqué par la largeur de l'écran, pas
    // démonté. Une sélection survit donc à une rotation de téléphone.
    expect((await screen.findAllByText('trigger.webhook')).length).toBe(2);
    expect(screen.getAllByText('postgres').length).toBe(2);
  });

  it('le graphe et la liste ouvrent la MÊME fiche', async () => {
    await mount();
    const candidates = await screen.findAllByRole('button', { name: /Deduplication/ });
    const graphNode = candidates.find((el) => el.tagName !== 'BUTTON')!;
    await userEvent.click(graphNode);
    expect(await screen.findByText('dedup')).toBeTruthy();
  });

  it('affiche l’identifiant, qui est le VRAI contrat', async () => {
    await mount();
    await openNode(/Deduplication/);
    // Renommer l'étiquette ne casse rien ; c'est l'identifiant que le journal
    // d'exécution référence.
    expect(await screen.findByText('dedup')).toBeTruthy();
  });
});

describe('l’effet est montré avant tout le reste', () => {
  it('nomme l’effet de l’étape sélectionnée', async () => {
    await mount();
    await openNode(/Deduplication/);
    // Restreint à la FICHE : « Écriture externe » figure aussi dans la
    // légende du graphe, où il n'apprend rien sur l'étape choisie.
    const card = document.querySelector('.soc-wf-inspector') as HTMLElement;
    expect(within(card).getByText(/External write/i)).toBeTruthy();
  });

  it('explique CE QUE ÇA CHANGE en cas de panne', async () => {
    // C'est le point qui compte : un `write` ne se rejoue jamais. Quelqu'un
    // qui regarde ce graphe pour comprendre un incident doit le lire ici.
    await mount();
    await openNode(/Deduplication/);
    expect(await screen.findByText(/NEVER replayed/i)).toBeTruthy();
  });

  it('montre la politique de réessai quand il y en a une', async () => {
    await mount();
    await openNode(/Deduplication/);
    expect(await screen.findByText(/Retries 2 times, 400 ms apart/i)).toBeTruthy();
  });

  it('affiche la note du nœud — ce qui remplace les pense-bêtes du canevas', async () => {
    await mount();
    await openNode(/Deduplication/);
    expect(await screen.findByText(/même transaction/i)).toBeTruthy();
  });
});

describe('les variables', () => {
  it('rend un interrupteur pour un booléen et un champ pour le reste', async () => {
    await mount();
    // Un booléen saisi dans un champ texte deviendrait la chaîne « false »,
    // qui est VRAIE en JavaScript.
    expect(await screen.findByText('pipeline.shadowMode')).toBeTruthy();
    // The toggle sits inside a <label>, so its accessible name is computed from
    // the label, not from its own text. Assert on the control itself.
    const toggle = document.querySelector('.soc-toggle');
    expect(toggle?.textContent).toBe('On');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByDisplayValue('30') as HTMLInputElement).type).toBe('number');
  });

  it('AVERTIT quand le shadow mode est désactivé', async () => {
    // C'est la seule variable qui décide si le monde réel est touché.
    const p = payload();
    p.variables['pipeline.shadowMode'] = false;
    await mount({ variables: p.variables });
    expect(await screen.findByText(/Shadow mode OFF/i)).toBeTruthy();
  });

  it('n’enregistre pas tant que rien n’a changé', async () => {
    await mount();
    const save = await screen.findByRole('button', { name: /Enregistrer|Save/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('n’envoie que ce qui est connu, et remonte le refus du serveur', async () => {
    const sent = vi.spyOn(api, 'saveVariables')
      .mockRejectedValue(new Error('Variable(s) inconnue(s) : x'));
    await mount();

    const field = await screen.findByDisplayValue('30');
    await userEvent.clear(field);
    await userEvent.type(field, '45');
    await userEvent.click(screen.getByRole('button', { name: /Enregistrer|Save/i }));

    await waitFor(() => expect(sent).toHaveBeenCalled());
    expect(await screen.findByText(/inconnue/i)).toBeTruthy();
  });
});

describe('l’écran reste consultable quand le reste est en panne', () => {
  it('n’a pas besoin du snapshot du pipeline', async () => {
    // Il décrit le pipeline, pas ce qu'il a produit : c'est précisément quand
    // n8n ou la base sont injoignables qu'on veut comprendre le câblage.
    const spy = vi.spyOn(api, 'snapshot');
    await mount();
    expect(spy).not.toHaveBeenCalled();
  });

  it('affiche l’erreur au lieu d’une page vide', async () => {
    vi.spyOn(api, 'workflows').mockRejectedValue(new Error('API unreachable'));
    render(<WorkflowPanel />);
    expect(await screen.findByText(/unreachable/i)).toBeTruthy();
  });
});
