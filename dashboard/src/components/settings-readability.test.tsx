/**
 * @vitest-environment jsdom
 */
/**
 * Ce que la page de Reglages a le droit de replier, et ce qu'elle doit montrer.
 *
 * ============================================================================
 * POURQUOI CETTE PAGE EST UN CAS A PART
 *
 * Sur les Alertes ou le Code, on ARRIVE et on regarde. Sur les Reglages, on
 * VIENT CHERCHER quelque chose de precis. Deux consequences :
 *
 *   1. Une section qu'on ne voit pas n'existe pas. A 1280 px la barre de
 *      sous-navigation en montrait sept sur dix, sans rien dire qu'elle
 *      defilait — les moteurs d'analyse et l'ouverture MCP etaient
 *      introuvables pour qui ne pense pas a faire glisser une barre.
 *
 *   2. Une PROCEDURE n'est pas un reglage. Le script a lancer sur la machine
 *      source, le bloc a coller dans `ossec.conf` et la table de
 *      correspondance des champs occupaient les trois quarts de l'onglet
 *      Ingestion : on les suit une fois, ailleurs, et il fallait les depasser
 *      pour atteindre le reglage d'a cote.
 *
 * Les tests reclament donc la frontiere : le reglage et l'adresse restent en
 * clair, la procedure et la reference se replient, et rien n'est supprime.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { SectionTabs } from './SectionTabs.tsx';
import { SourcesPanel } from './SettingsSetup.tsx';
import { McpPanel } from './McpPanel.tsx';
import { api } from '../lib/api.ts';
import type { McpState } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ==========================================================================
 * La barre de sous-navigation
 * ========================================================================== */

describe('la sous-navigation survit a un navigateur sans ResizeObserver', () => {
  it('rend la barre meme quand l API de mesure manque', () => {
    // jsdom n'a pas `ResizeObserver`, et un navigateur ancien non plus. Le
    // degrade de bord est un CONFORT : s'il emportait le rendu de la barre,
    // il rendrait dix sections inatteignables pour en signaler trois.
    const saved = globalThis.ResizeObserver;
    // @ts-expect-error — on retire volontairement l'API pour le test.
    delete globalThis.ResizeObserver;
    try {
      const { container } = render(
        <SectionTabs
          items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]}
          active="a"
          onChange={() => {}}
          label="sections"
        />,
      );
      expect(screen.getByRole('tablist')).toBeTruthy();
      expect(container.querySelector('.soc-subnav-wrap')).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = saved;
    }
  });

  it('porte l etat des bords sur l enveloppe, pas sur la barre qui defile', () => {
    // Un degrade pose sur le conteneur qui defile partirait avec le contenu
    // au lieu de rester sur le bord : c'est pour ca qu'il y a deux elements.
    const { container } = render(
      <SectionTabs
        items={[{ id: 'a', label: 'A' }]}
        active="a"
        onChange={() => {}}
        label="sections"
      />,
    );
    expect(container.querySelector('.soc-subnav-wrap')!.hasAttribute('data-edges')).toBe(true);
  });
});

/* ==========================================================================
 * L'ingestion : le reglage devant, la procedure derriere
 * ========================================================================== */

const SOURCES = {
  sources: [
    {
      source: 'wazuh',
      label: 'Wazuh',
      endpoint: 'http://localhost:4400/api/ingest/wazuh',
      setup: {
        install: ['scp integrations/wazuh/custom-menater root@HOST:/var/ossec/', 'chmod 750 …'],
        configFile: '/var/ossec/etc/ossec.conf',
        config: '<integration>\n  <name>custom-menater</name>\n</integration>',
        verify: 'tail -f /var/ossec/logs/integrations.log',
      },
      fields: { alert_id: 'id', rule_name: 'rule.description', host: 'agent.name' },
    },
  ],
};

const foldOf = (el: Element | null): HTMLDetailsElement | null =>
  (el?.closest('details') as HTMLDetailsElement | null) ?? null;

describe('l ingestion montre le reglage et replie la procedure', () => {
  it('laisse l adresse d envoi EN CLAIR', async () => {
    // C'est la seule chose de ce bloc qu'on revient chercher, et c'est elle
    // qu'on colle sur la machine source.
    vi.spyOn(api, 'ingestSources').mockResolvedValue(SOURCES as never);
    render(<SourcesPanel />);
    const endpoint = await screen.findByText('http://localhost:4400/api/ingest/wazuh');
    expect(foldOf(endpoint)).toBeNull();
  });

  it('replie le script et le bloc de configuration, en disant leur taille', async () => {
    vi.spyOn(api, 'ingestSources').mockResolvedValue(SOURCES as never);
    render(<SourcesPanel />);
    // Un pli muet oblige a l'ouvrir pour savoir s'il valait la peine.
    expect(await screen.findByText('2 lines')).toBeTruthy();
    expect(screen.getByText('3 lines')).toBeTruthy();

    const install = screen.getByText(/custom-menater root@HOST/);
    expect(foldOf(install)!.open).toBe(false);
  });

  it('replie la table de correspondance en annoncant son nombre de champs', async () => {
    vi.spyOn(api, 'ingestSources').mockResolvedValue(SOURCES as never);
    render(<SourcesPanel />);
    expect(await screen.findByText('3 fields')).toBeTruthy();
    expect(foldOf(screen.getByText('rule.description'))!.open).toBe(false);
  });

  it('ne SUPPRIME rien : tout reste atteignable au clic', async () => {
    vi.spyOn(api, 'ingestSources').mockResolvedValue(SOURCES as never);
    render(<SourcesPanel />);
    const summary = (await screen.findByText('3 fields')).closest('summary')!;
    await userEvent.click(summary);
    await waitFor(() => expect(foldOf(screen.getByText('rule.description'))!.open).toBe(true));
  });
});

/* ==========================================================================
 * MCP : quatre clients, un a la fois
 * ========================================================================== */

const MCP: McpState = {
  enabled: true,
  token_set: true,
  live: true,
  path: '/api/mcp',
  tools: ['list_alerts', 'get_alert'],
  prompts: [{ name: 'explain-alert', title: 'Explain an alert' }],
  resources: ['menater://queue'],
  protocol_versions: ['2025-06-18'],
};

describe('la page MCP montre la configuration d UN client', () => {
  /*
   * ========================================================================
   * LA REGLE QUI N'A PAS BOUGE
   *
   * Les quatre clients gardent chacun leur forme complete : « n'en proposer
   * qu'un et dire que les autres sont similaires » transforme cinq minutes en
   * apres-midi, et c'est toujours interdit. Ce qui change, c'est qu'on
   * n'en affiche qu'un a la fois — on installe sur un seul client, et les
   * trois autres blocs poussaient le bouton de test hors de l'ecran.
   *
   * Le test reclame donc les DEUX moities de la regle : un seul visible, et
   * les quatre atteignables.
   * ========================================================================
   */
  it('affiche un seul bloc de configuration a la fois', async () => {
    vi.spyOn(api, 'mcpState').mockResolvedValue(MCP);
    render(<McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />);
    await screen.findByText('Claude Desktop', { selector: '.soc-kicker' });
    // `mcpServers` n'existe que dans le JSON de Claude Desktop ; `claude mcp
    // add` que dans la commande de Claude Code. Les deux a l'ecran en meme
    // temps voudrait dire que rien n'a ete selectionne.
    expect(screen.getByText(/mcpServers/)).toBeTruthy();
    expect(screen.queryByText(/claude mcp add/)).toBeNull();
  });

  it('donne acces aux quatre, chacun dans sa forme complete', async () => {
    vi.spyOn(api, 'mcpState').mockResolvedValue(MCP);
    render(<McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />);
    const picker = await screen.findByRole('group', { name: 'Your client' });
    const buttons = [...picker.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Claude Desktop',
      'Claude Code (one command)',
      'Cursor — .cursor/mcp.json',
      'VS Code — .vscode/mcp.json',
    ]);

    await userEvent.click(buttons[1]!);
    // La commande complete, pas un renvoi vers la documentation.
    expect(screen.getByText(/claude mcp add --transport http menater/)).toBeTruthy();
    expect(screen.queryByText(/mcpServers/)).toBeNull();
  });

  it('ne montre le chemin du fichier que pour le client qui en a un', async () => {
    // Affiche sous les trois autres, il envoyait editer un fichier qui
    // n'existe pas sur la machine.
    vi.spyOn(api, 'mcpState').mockResolvedValue(MCP);
    render(<McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />);
    const picker = await screen.findByRole('group', { name: 'Your client' });
    expect(screen.getByText(/claude_desktop_config\.json/)).toBeTruthy();
    await userEvent.click([...picker.querySelectorAll('button')][2]!);
    expect(screen.queryByText(/claude_desktop_config\.json/)).toBeNull();
  });
});
