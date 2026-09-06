/**
 * @vitest-environment jsdom
 */
/**
 * Ce que la passe de lisibilite a le droit de cacher, et ce qu'elle n'a pas.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EXISTE
 *
 * « Simplifier l'affichage » est la modification la plus dangereuse qu'on
 * puisse faire a une console de securite, parce qu'elle ne casse rien : elle
 * marche, elle est jolie, et un jour quelqu'un n'approuve pas une isolation
 * parce que la phrase qui l'y obligeait etait derriere un pli.
 *
 * La regle est donc ecrite ici, pas seulement dans les commentaires :
 *
 *   CE QUI EXPLIQUE peut se replier — une definition, un mode d'emploi, une
 *   reserve methodologique. On le lit une fois.
 *
 *   CE QUI RAPPORTE ne se replie jamais — un etat, un compte, une panne, un
 *   renseignement incomplet, une action a valider. On le lit a chaque fois,
 *   et le cacher reproduirait le defaut que l'onglet Suivi existe pour
 *   exposer : un echec qui s'affiche vert.
 *
 * ET RIEN N'EST SUPPRIME. Le texte replie est dans le DOM, atteignable au
 * clavier : « disponible en un clic » et « efface » se ressemblent sur une
 * capture d'ecran et n'ont rien a voir pour quelqu'un qui cherche.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render as rawRender, screen } from '@testing-library/react';

import { render } from '../vulnpipe/test-utils.tsx';
import { Explain, Fold } from './Guidance.tsx';
import { AlertQueue } from './AlertQueue.tsx';
import { CaseView } from './CaseView.tsx';
import { MetricsPanel } from './MetricsPanel.tsx';
import type { AlertCase, Metrics } from '../lib/types.ts';

afterEach(cleanup);

/** Le `<details>` qui contient un noeud, ou `null` s'il n'est pas replie. */
const foldAround = (el: Element | null): HTMLDetailsElement | null =>
  (el?.closest('details') as HTMLDetailsElement | null) ?? null;

describe('le « i » rend une explication disponible sans l\'ecrire', () => {
  it('garde le texte dans le DOM, replie', () => {
    render(<Explain label="Confidence">What the model thinks of its own answer.</Explain>);
    const text = screen.getByText('What the model thinks of its own answer.');
    const details = foldAround(text);
    expect(details).toBeTruthy();
    // Replie, donc absent du balayage — mais present, donc trouvable.
    expect(details!.open).toBe(false);
  });

  it('annonce ce que le bouton fait, pas la lettre qu\'il dessine', () => {
    // Le glyphe est un « i » : sans nom accessible, un lecteur d'ecran
    // annonce la lettre, ce qui ne dit rien de ce qu'il y a derriere.
    render(<Explain>Anything.</Explain>);
    expect(screen.getByLabelText('What is this? Read the explanation')).toBeTruthy();
  });
});

describe('un pli dit ce qu\'il contient sans qu\'on l\'ouvre', () => {
  it('porte son indication sur le pli ferme', () => {
    render(
      <Fold title="Raw log" hint="412 characters">
        <pre>evidence</pre>
      </Fold>,
    );
    expect(screen.getByText('412 characters')).toBeTruthy();
    expect(foldAround(screen.getByText('evidence'))!.open).toBe(false);
  });

  it('OUVRE sur un signal, et ne referme jamais sur un signal', () => {
    /*
     * ======================================================================
     * `<details open={x}>` EN REACT EST A MOITIE CONTROLE
     *
     * React reecrit l'attribut des que la valeur change — y compris pour le
     * remettre a `false`. Ecrit ainsi, ce pli refermait sous les doigts ce
     * qu'on venait d'ouvrir des qu'une donnee arrivait, et le bloc « Etat »
     * des moteurs s'ouvrait au chargement puis se refermait tout seul.
     *
     * La regle : le signal ouvre, il ne ferme pas. L'etat appartient ensuite
     * a la personne qui clique.
     * ======================================================================
     */
    // `rawRender` : `Fold` ne lit aucun contexte, et le rendu enveloppe des
    // autres tests remplacerait la racine a chaque `rerender` — le pli serait
    // remonte a neuf, et le test passerait pour la mauvaise raison.
    const { rerender, container } = rawRender(
      <Fold title="Status" defaultOpen={false}>
        <p>body</p>
      </Fold>,
    );
    const el = container.querySelector('details')!;
    expect(el.open).toBe(false);

    // Le signal devient vrai : le pli s'ouvre.
    rerender(
      <Fold title="Status" defaultOpen>
        <p>body</p>
      </Fold>,
    );
    expect(el.open).toBe(true);

    // Il redevient faux : le pli RESTE ouvert.
    rerender(
      <Fold title="Status" defaultOpen={false}>
        <p>body</p>
      </Fold>,
    );
    expect(el.open).toBe(true);
  });

  it('ne rouvre pas ce que la personne a referme', () => {
    // Le prop initial est fige au montage : un rendu de plus, pour n'importe
    // quelle autre raison, ne doit pas rejouer l'ouverture d'origine.
    const { rerender, container } = rawRender(
      <Fold title="Raw log" hint="a" defaultOpen>
        <p>body</p>
      </Fold>,
    );
    const el = container.querySelector('details')!;
    el.open = false;
    rerender(
      <Fold title="Raw log" hint="b" defaultOpen>
        <p>body</p>
      </Fold>,
    );
    expect(el.open).toBe(false);
  });

  it('reste ouvert quand on le lui demande', () => {
    render(
      <Fold title="What happened" hint="5 steps" defaultOpen>
        <p>story</p>
      </Fold>,
    );
    expect(foldAround(screen.getByText('story'))!.open).toBe(true);
  });
});

describe("une bulle fermee ne doit exister nulle part, pas seulement pour l'oeil", () => {
  it("la retire du RENDU, donc du nom accessible de ce qui l'entoure", () => {
    /*
     * ========================================================================
     * LE DEFAUT QUE CE TEST FIGE, ET IL ETAIT INVISIBLE A L'ECRAN
     *
     * Rien ne masquait la bulle d'un `<details>` ferme : elle etait posee en
     * absolu, hors du flux, invisible A L'OEIL — et toujours dans l'arbre de
     * rendu. Donc dans l'arbre d'accessibilite. Donc DANS LE NOM du titre ou
     * de la cellule d'en-tete qui la contient.
     *
     * Le titre d'une vignette de mesure s'appelait « Human disagreementHuman
     * disagreementThe share of decisions put to a human that the human
     * declined… ». La navigation par titres est le premier moyen de parcourir
     * une page quand on ne voit pas l'ecran : chaque section y devenait un
     * paragraphe.
     *
     * jsdom n'applique pas de feuille de style : le test lit donc la REGLE,
     * comme celui de la vignette d'accent. Ce qui se verifie ici est qu'elle
     * existe et qu'elle vise les DEUX bulles.
     * ========================================================================
     */
    const css = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const rule = /\.soc-term:not\(\[open\]\) \.soc-term-bubble,\s*\.soc-info:not\(\[open\]\) \.soc-term-bubble\s*\{[^}]*display:\s*none/;
    expect(css).toMatch(rule);
  });

  it("garde l'explication atteignable une fois ouverte", () => {
    // Le pendant du test precedent : « retiree quand fermee » ne doit pas
    // devenir « supprimee ». Le contenu reste dans le DOM.
    render(<Explain label="Confidence">What the model thinks of its own answer.</Explain>);
    expect(screen.getByText('What the model thinks of its own answer.')).toBeTruthy();
  });
});

/* ==========================================================================
 * La carte d'incident : la frontiere passe ici
 * ========================================================================== */

const kase = (over: Partial<AlertCase> = {}): AlertCase =>
  ({
    alert_id: 'ALT-2026-0823-0412',
    received_at: '2026-08-23T11:54:07.000Z',
    state: 'awaiting_approval',
    severity: 'high',
    rule_name: 'Multiple failed SSH logins followed by successful auth',
    source_ip: '185.220.101.47',
    dest_ip: '10.12.4.31',
    host: 'srv-bastion-01',
    raw_log: 'Aug 23 11:54:07 web01 sshd[2211]: Accepted password for root',
    shadow_mode: false,
    executed: false,
    routing_outcome: null,
    enrichment: null,
    enrichment_meta: null,
    decision: null,
    approval: null,
    audit: null,
    stages: [],
    errors: [],
    attack: [],
    dwell_ms: null,
    ...over,
  }) as unknown as AlertCase;

describe('la carte replie les pieces, jamais les constats', () => {
  it('range le log brut derriere un pli ferme, sans le perdre', () => {
    render(<CaseView alertCase={kase()} onRefresh={() => {}} />);
    const log = screen.getByText(/Accepted password for root/);
    expect(foldAround(log)!.open).toBe(false);
  });

  it('laisse « renseignement incomplet » EN CLAIR, hors de tout pli', () => {
    // Ce bandeau limite ce que la decision vaut : quelqu'un qui approuve une
    // isolation doit le lire sans avoir a chercher.
    render(
      <CaseView
        alertCase={kase({
          enrichment: { shodan: undefined, abuseipdb: undefined, vt: undefined },
          enrichment_meta: { degraded: true, sources_unavailable: ['abuseipdb'] },
        } as unknown as Partial<AlertCase>)}
        onRefresh={() => {}}
      />,
    );
    const banner = screen.getByText(/Unavailable source/);
    const fold = foldAround(banner);
    // Soit aucun pli, soit un pli ouvert : dans les deux cas c'est lisible.
    expect(fold === null || fold.open).toBe(true);
  });

  it('laisse un incident technique en clair', () => {
    render(
      <CaseView
        alertCase={kase({
          errors: [
            {
              error_code: 'E_DB',
              workflow: '05-Audit-Log',
              message: 'permission denied for table soc_run',
              severity: 'high',
              requires_replay: true,
            },
          ],
        } as unknown as Partial<AlertCase>)}
        onRefresh={() => {}}
      />,
    );
    const fold = foldAround(screen.getByText(/permission denied/));
    expect(fold === null || fold.open).toBe(true);
  });
});

/* ==========================================================================
 * Les mesures
 * ========================================================================== */

const metrics = (): Metrics =>
  ({
    alerts_total: 7,
    alerts_shadow: 2,
    awaiting_approval: 1,
    failed: 1,
    actions_executed: 2,
    avg_dwell_ms: 277000,
    avg_confidence: 0.78,
    tokens_total: 2185,
    human_disagreement_rate_pct: 12,
    fallback_rate_pct: 14,
    degraded_rate_pct: 28,
    by_verdict: { false_positive: 2 },
    by_severity: { high: 3, low: 4 },
    by_action: {},
    window_label: 'last 7 days',
    shadow_baseline: { decisions: 7, threshold: 50, reached: false },
  }) as unknown as Metrics;

describe('les mesures montrent des chiffres, pas leur mode d\'emploi', () => {
  it('garde la valeur en clair et la definition derriere le « i »', () => {
    render(<MetricsPanel metrics={metrics()} />);
    // La valeur : lisible immediatement, hors de tout pli.
    expect(foldAround(screen.getByText('12 %'))).toBe(null);
    // Sa definition : presente, mais repliee.
    const help = screen.getByText(/only number that says/i);
    expect(foldAround(help)!.open).toBe(false);
  });
});

/* ==========================================================================
 * Le garde-fou CSS
 * ========================================================================== */

describe('la vignette qui porte l\'accent le porte vraiment', () => {
  it('nomme les deux classes, sinon `.soc-statbar li` gagne', () => {
    /*
     * `.soc-statbar li` est (0,1,1) et `.soc-stat-focus` (0,1,0) : ecrite
     * seule, la regle perdait, la vignette gardait le fond du panneau et
     * prenait quand meme `--accent-fg` — blanc sur creme, 1.05:1, sur le
     * SEUL chiffre qui dit qu'on attend quelque chose de vous. Meme famille
     * que le piege `--hero`. Le test lit la feuille plutot que le rendu :
     * jsdom n'applique pas la cascade.
     */
    const css = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.soc-statbar li\.soc-stat-focus\s*\{[^}]*background:\s*var\(--accent\)/);
    expect(css).not.toMatch(/^\.soc-stat-focus\s*\{\s*background/m);
  });
});

/* ==========================================================================
 * La table de triage : cinq colonnes, huit informations
 * ========================================================================== */

describe('fusionner des colonnes ne supprime aucune donnee', () => {
  /*
   * ========================================================================
   * LE TEST QUI COMPTE DANS CETTE PASSE
   *
   * Passer de huit colonnes a cinq est la modification qui ressemble le plus
   * a une amelioration tout en pouvant etre une perte : trois en-tetes ont
   * disparu de l'ecran, et rien dans le rendu ne dit si la VALEUR qu'ils
   * nommaient est partie avec eux.
   *
   * Chacune des trois est donc reclamee ici par sa valeur, pas par son
   * en-tete. Si un jour quelqu'un simplifie encore, il faudra qu'il le fasse
   * expres.
   * ========================================================================
   */
  const row = (): AlertCase =>
    ({
      ...kase({ state: 'closed' }),
      severity: 'critical',
      dwell_ms: 240,
      decision: {
        verdict: 'true_positive',
        confidence: 0.96,
        reasoning: '',
        data_lineage: [],
        guardrails_applied: [],
        is_fallback: false,
        recommended_action: 'escalate',
        model: null,
        attempts: null,
        usage: null,
        decision_source: null,
        raw_confidence: null,
      },
    }) as unknown as AlertCase;

  it('garde la severite, la confiance et le temps de traitement', () => {
    render(<AlertQueue cases={[row()]} selectedId={null} onSelect={() => {}} />);

    // La severite : elle a quitte sa colonne pour la cellule de l'alerte.
    expect(screen.getByText('critical')).toBeTruthy();
    // La confiance : elle a rejoint le verdict qu'elle qualifie.
    expect(screen.getByText('0.96')).toBeTruthy();
    // Le temps de traitement : il est passe sous l'heure de reception, AVEC
    // son libelle — une duree nue sous une autre duree ne dit pas de quoi
    // elle est la duree.
    expect(screen.getByText('Time taken')).toBeTruthy();
    expect(screen.getByText(/240 ms/)).toBeTruthy();
  });

  it('nomme la severite pour qui survole la pastille', () => {
    // Le mot « severite » n'est plus ecrit dans l'en-tete : sans ce titre, la
    // seule facon de savoir que HIGH vient de l'appliance et non de l'IA
    // serait d'avoir lu le Guide.
    render(<AlertQueue cases={[row()]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('critical').getAttribute('title')).toMatch(/appliance/i);
  });

  it('montre cinq en-tetes, et pas huit', () => {
    const { container } = render(
      <AlertQueue cases={[row()]} selectedId={null} onSelect={() => {}} />,
    );
    expect(container.querySelectorAll('.soc-queue thead th')).toHaveLength(5);
  });
});

describe('le disque lit le glossaire, il ne le recopie pas', () => {
  it('affiche le terme et le texte du catalogue', () => {
    // Deux exemplaires d'une definition divergent toujours : celui qu'on
    // corrige et celui qu'on oublie.
    render(<Explain term="severity" />);
    expect(screen.getByText('Severity')).toBeTruthy();
    expect(screen.getByText(/comes from that appliance/i)).toBeTruthy();
  });
});
