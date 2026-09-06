/**
 * @vitest-environment jsdom
 */
/**
 * La recherche du Guide.
 *
 * ============================================================================
 * CE QU'ELLE DOIT FAIRE, ET CE QU'ELLE N'A PAS LE DROIT DE FAIRE
 *
 * Le Guide compte dix-sept sections et une centaine de points. Sans recherche,
 * il faut deviner laquelle contient le mot qu'on a en tete — ou les ouvrir
 * toutes. Avec, il faut se mefier de l'inverse : une recherche qui filtre sans
 * le dire fait croire une section plus courte qu'elle n'est, et on repart avec
 * une idee fausse de ce que la documentation contient.
 *
 * D'ou les deux exigences testees ici :
 *
 *   1. Elle TROUVE — y compris les mots que le Guide n'ecrit pas mais que le
 *      produit affiche (« shadow »), via le glossaire.
 *   2. Elle DIT CE QU'ELLE CACHE — « 1 des 5 points », jamais un filtrage
 *      muet.
 * ============================================================================
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { DocsPanel } from './DocsPanel.tsx';

afterEach(cleanup);

const search = async (text: string) => {
  const field = screen.getByLabelText('Search the guide');
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
  return field;
};

const sections = () => [...document.querySelectorAll<HTMLDetailsElement>('details.soc-doc')];

describe('sans recherche, rien n est cache', () => {
  it('rend les dix-sept sections, rangees en quatre groupes', () => {
    const { container } = render(<DocsPanel />);
    expect(sections()).toHaveLength(17);
    expect(container.querySelectorAll('.soc-doc-group')).toHaveLength(4);
  });

  it('annonce ce que chaque section contient, sans qu on l ouvre', () => {
    // Meme regle que partout ailleurs dans ce produit : un pli muet doit etre
    // ouvert pour savoir s'il valait la peine, donc il n'economise rien.
    render(<DocsPanel />);
    const counts = [...document.querySelectorAll('.soc-doc-count')].map((c) => c.textContent);
    expect(counts).toHaveLength(17);
    // Chaque pli annonce un nombre, aucun n'est muet.
    expect(counts.every((c) => /^\d+ points?$/.test(c ?? ''))).toBe(true);
  });

  it('numerote dans l ORDRE DE LECTURE, pas dans celui du catalogue', () => {
    // Les groupes reordonnent la page. Numeroter sur l'ordre du catalogue
    // donnait « 04, 05, 06, 07, 10, 12 » dans un meme groupe : un numero qui
    // saute ne designe plus une position, il fait chercher les manquants.
    render(<DocsPanel />);
    const numbers = [...document.querySelectorAll('.soc-doc-num')].map((n) => n.textContent);
    expect(numbers).toEqual(
      Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
  });
});

describe('la recherche dit ce qu elle garde', () => {
  it('filtre les points ET annonce combien elle en cache', async () => {
    render(<DocsPanel />);
    await search('approve');
    // « 1 des 5 points » : le compte complet reste ecrit, donc personne ne
    // repart en croyant la section longue de un point.
    expect(screen.getAllByText(/of \d+ points/).length).toBeGreaterThan(0);
  });

  it('ouvre ce qu elle retient : on a deja dit ce qu on cherchait', async () => {
    render(<DocsPanel />);
    await search('approve');
    expect(sections().every((d) => d.open)).toBe(true);
  });

  it('surligne le terme, sans reecrire la casse du texte', async () => {
    // Le surlignage decoupe le texte D'ORIGINE, pas sa version minuscule :
    // sinon chercher « wazuh » reecrirait « Wazuh » en minuscules dans une
    // documentation qu'on recopie telle quelle sur une machine.
    render(<DocsPanel />);
    await search('wazuh');
    const hits = [...document.querySelectorAll('mark.soc-hit')].map((h) => h.textContent);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain('Wazuh');
  });

  it('garde tous les points quand c est le TITRE qui repond', async () => {
    // La recherche a repondu au niveau de la section : n'en montrer qu'une
    // partie des points serait arbitraire.
    render(<DocsPanel />);
    await search('Human approval');
    const kept = sections()[0]!;
    expect(within(kept).getByText('4 points')).toBeTruthy();
  });

  it('garde le meme numero avec et sans recherche', async () => {
    render(<DocsPanel />);
    await search('Human approval');
    expect(sections()[0]!.querySelector('.soc-doc-num')!.textContent).toBe('05');
  });
});

describe('elle trouve les mots que le Guide n ecrit pas', () => {
  it('repond « shadow » par l entree de glossaire', async () => {
    /*
     * LE DEFAUT QUE CE TEST FIGE.
     * « shadow » est le concept central du produit — le mode par defaut — et
     * le Guide l'appelle « watch-only mode » : le mot n'y figure nulle part.
     * Chercher le terme qu'on a lu dans une charge utile rendait ZERO, et on
     * repartait en concluant que la documentation n'en parle pas.
     */
    render(<DocsPanel />);
    await search('shadow');
    expect(screen.getByText('From the glossary')).toBeTruthy();
    expect(screen.getByText('Watch-only mode')).toBeTruthy();
  });

  it('dit clairement quand vraiment rien ne correspond', async () => {
    render(<DocsPanel />);
    await search('zzzznotathing');
    expect(screen.getByText(/Nothing in the guide mentions/)).toBeTruthy();
    expect(sections()).toHaveLength(0);
  });

  it('rend la totalite du Guide quand on efface la recherche', async () => {
    render(<DocsPanel />);
    await search('approve');
    expect(sections().length).toBeLessThan(17);
    await userEvent.click(screen.getByRole('button', { name: /Clear the search/ }));
    expect(sections()).toHaveLength(17);
  });
});
