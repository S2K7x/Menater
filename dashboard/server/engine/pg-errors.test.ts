/**
 * Tests du message d'erreur Postgres.
 *
 * ============================================================================
 * LE DÉFAUT QU'ILS EMPÊCHENT DE REVENIR
 *
 * Sur une connexion refusée, `pg` lève une `AggregateError` dont `.message`
 * est LA CHAÎNE VIDE. Constaté à l'écran : le point d'entrée des alertes
 * répondait `"error": ""`. Une base injoignable devenait une panne sans cause,
 * sur le chemin où l'on a le moins de temps pour chercher.
 *
 * « Ne jamais throw une erreur silencieuse » : une erreur au message vide en
 * est une.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { describePgError } from './pg-store.ts';

describe('un message vide n’est jamais rendu tel quel', () => {
  it('va chercher le code quand le message est vide', () => {
    const err = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    const out = describePgError(err, 'Database (SELECT)');
    expect(out).toMatch(/refused the connection/);
    expect(out).toMatch(/ECONNREFUSED/);
  });

  it('va chercher le code DANS les erreurs agrégées', () => {
    // C'est la forme réelle : `pg` agrège une erreur par adresse tentée, et
    // seul l'enfant porte le code.
    const err = new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], '');
    expect(describePgError(err, 'x')).toMatch(/ECONNREFUSED/);
  });

  it('traduit les codes qu’un humain va rencontrer', () => {
    const cases: Array<[string, RegExp]> = [
      ['28P01', /password refused/],
      ['3D000', /does not exist/],
      ['42P01', /SQL schema was never applied/],
      ['ETIMEDOUT', /did not answer in time/],
    ];
    for (const [code, expected] of cases) {
      expect(describePgError({ message: '', code }, 'x'), code).toMatch(expected);
    }
  });

  it('rend le code brut pour un code inconnu, plutôt que rien', () => {
    expect(describePgError({ message: '', code: '99999' }, 'x')).toMatch(/error 99999/);
  });

  it('DIT qu’il n’y a ni message ni code, plutôt que de rendre le vide', () => {
    // Le pire cas : on nomme au moins le type de l'erreur, pour donner une
    // prise à celui qui cherche.
    const out = describePgError(new AggregateError([], ''), 'Database');
    expect(out).toMatch(/neither message nor code/);
    expect(out).toMatch(/AggregateError/);
  });
});

describe('un message existant est conservé', () => {
  it('ne le remplace pas par une traduction', () => {
    const out = describePgError({ message: 'relation "soc_run" does not exist' }, 'Base');
    expect(out).toBe('Base: relation "soc_run" does not exist');
  });

  it('situe l’erreur sans exposer la requête', () => {
    // Le premier mot du SQL suffit ; la requête complète noierait la cause,
    // et pourrait porter des valeurs d'alerte.
    expect(describePgError({ message: 'boom' }, 'Database (INSERT)'))
      .toMatch(/^Database \(INSERT\)/);
  });
});
