/**
 * @vitest-environment jsdom
 */
/**
 * Tests de la saisie des clés de moteur.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Trois comportements qui, s'ils cassent, cassent en silence :
 *
 *   - UN CHAMP VIDE N'EST PAS ENVOYÉ. Le champ revient toujours vide (on
 *     n'affiche jamais une clé enregistrée) ; s'il partait quand même, chaque
 *     enregistrement effacerait les clés auxquelles on n'a pas touché ;
 *   - UNE CLÉ POSÉE PAR L'ENVIRONNEMENT NE SE SAISIT PAS. Le serveur la
 *     refuserait : laisser le champ actif ferait taper une valeur pour rien ;
 *   - AUCUNE VALEUR NE S'AFFICHE. Un secret rendu à l'écran est un secret
 *     partagé avec la personne derrière l'épaule.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../test-utils.tsx';
import { ProviderKeys } from './ProviderKeys.tsx';
import { api, type KeyStatus } from '../lib/api.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const key = (partial: Partial<KeyStatus> & Pick<KeyStatus, 'name'>): KeyStatus => ({
  set: false,
  source: 'none',
  locked: false,
  ...partial,
});

const KEYS: KeyStatus[] = [
  key({ name: 'GEMINI_API_KEY' }),
  key({ name: 'OPENROUTER_API_KEY', set: true, source: 'store' }),
  key({ name: 'ANTHROPIC_API_KEY', set: true, source: 'environment', locked: true }),
];

function setup(keys = KEYS) {
  const sent = vi.spyOn(api, 'setProviderKeys').mockResolvedValue({ keys, available: [] } as never);
  const onApplied = vi.fn();
  render(<ProviderKeys keys={keys} onApplied={onApplied} />);
  return { sent, onApplied };
}

describe('saisie des clés', () => {
  it('n’envoie que les champs réellement remplis', async () => {
    const { sent } = setup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Google Gemini/i), 'g-new');
    await user.click(screen.getByRole('button', { name: /Save keys/i }));

    expect(sent).toHaveBeenCalledWith({ GEMINI_API_KEY: 'g-new' });
  });

  it('garde le bouton inactif tant que rien n’est saisi', () => {
    setup();
    expect((screen.getByRole('button', { name: /Save keys/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rend le champ inactif quand la clé vient de l’environnement, et dit pourquoi', () => {
    setup();
    expect((screen.getByLabelText(/Anthropic Claude/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/comes from the machine running the analysis service/i)).toBeTruthy();
  });

  it('n’offre « retirer » que pour une clé que ce magasin gère', () => {
    setup();
    // Une seule des trois clés vient du magasin.
    expect(screen.getAllByRole('button', { name: /Remove/i })).toHaveLength(1);
  });

  it('n’affiche jamais de valeur : les champs sont des champs de secret, vides', () => {
    setup();
    for (const name of ['Google Gemini', 'OpenRouter', 'Anthropic Claude']) {
      const field = screen.getByLabelText(new RegExp(name, 'i')) as HTMLInputElement;
      expect(field.type).toBe('password');
      expect(field.value).toBe('');
    }
  });

  it('vide le brouillon après un enregistrement réussi', async () => {
    const { onApplied } = setup();
    const user = userEvent.setup();

    const field = screen.getByLabelText(/Google Gemini/i) as HTMLInputElement;
    await user.type(field, 'g-new');
    await user.click(screen.getByRole('button', { name: /Save keys/i }));

    expect(onApplied).toHaveBeenCalled();
    expect(field.value).toBe('');
  });
});
