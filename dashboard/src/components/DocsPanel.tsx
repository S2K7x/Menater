/**
 * Onglet Guide — la documentation de toutes les fonctionnalités.
 *
 * ============================================================================
 * POURQUOI UNE DOCUMENTATION DANS L'APPLICATION
 *
 * Un README dans un dépôt Git n'est lu que par ceux qui savent déjà où il est.
 * L'écran, lui, est ouvert par quelqu'un qui vient de tomber sur un mot qu'il
 * ne comprend pas — « shadow mode », « désaccord humain », « zone grise ». La
 * réponse doit être à un clic de l'endroit où la question s'est posée.
 *
 * ============================================================================
 * UN ACCORDÉON, ET LA PREMIÈRE SECTION OUVERTE
 *
 * Huit sections dépliées font un mur de texte que personne ne lit. Toutes
 * repliées, on ne sait pas à quoi s'attendre et on repart. La première est donc
 * ouverte : elle explique ce que fait l'application, et son contenu visible
 * donne le format des sept autres.
 *
 * `<details>` natif plutôt qu'un état React : le repli fonctionne sans
 * JavaScript, la recherche du navigateur (Ctrl+F) trouve le texte replié sur
 * les navigateurs récents, et le clavier marche sans qu'on écrive une seule
 * gestion de touche.
 *
 * ============================================================================
 * QUINZE SECTIONS, QUATRE-VINGT-DIX POINTS, ET AUCUN MOYEN DE CHERCHER
 *
 * Le commentaire ci-dessus parle de huit sections. Il y en a quinze : elles se
 * sont ajoutées une à une, et personne n'a rouvert la liste. Deux conséquences
 * qu'un accordéon ne corrige pas tout seul :
 *
 *   - QUINZE TITRES A PLAT NE SE PARCOURENT PLUS. Ils portent tous le même
 *     poids, donc on les lit un par un. Ils sont maintenant rangés en quatre
 *     groupes, et aucun ne disparaît.
 *
 *   - ON NE PEUT PAS CHERCHER. C'est la fonction principale d'une
 *     documentation de quatre-vingt-dix points : quelqu'un arrive avec un mot
 *     — « shadow », « approbation », « Wazuh » — pas avec un plan. Sans
 *     recherche, il faut deviner laquelle des quinze sections le contient, ou
 *     les ouvrir toutes.
 *
 * LA RECHERCHE NE MENT PAS SUR CE QU'ELLE MONTRE. Une section filtrée dit
 * « 3 des 10 points » : cacher les sept autres sans le dire ferait croire la
 * section plus courte qu'elle n'est, et on repartirait avec une idée fausse
 * de ce que le Guide contient.
 * ============================================================================
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/context.tsx';
import type { DocGroup, DocSection } from '../i18n/console.ts';
import { ArchitectureDiagram, ConfidenceZones, CostFunnel } from '../vulnpipe/components/Diagrams.tsx';
import { Icon } from './Icon.tsx';

/**
 * Les trois schémas de l'analyse de code.
 *
 * Ils viennent de l'ancienne page de présentation, qui a disparu avec la
 * fusion. Les jeter aurait été dommage : une pipeline en six boîtes et un axe
 * de confiance à trois zones se comprennent bien mieux dessinés qu'écrits.
 * Ils sont donc rattachés à la section du Guide qui parle de cet onglet, avec
 * leurs libellés pris dans le catalogue — la figure se lit dans les deux
 * langues sans être redessinée.
 */
function CodeDiagrams() {
  const { t } = useI18n();
  const l = t.landing;
  return (
    <div className="soc-doc-figures">
      <figure>
        <div className="soc-doc-scroll">
          <ArchitectureDiagram labels={l.diagram} />
        </div>
        <figcaption>{l.flowCaption}</figcaption>
      </figure>
      <figure>
        <div className="soc-doc-scroll">
          <ConfidenceZones zones={l.zones} />
        </div>
        <figcaption>{l.zonesLede}</figcaption>
      </figure>
      <figure>
        <div className="soc-doc-scroll">
          <CostFunnel steps={l.funnel} />
        </div>
        <figcaption>{l.costLede}</figcaption>
      </figure>
    </div>
  );
}

/**
 * Le terme cherche, surligne dans le texte.
 *
 * Sans lui, une section s'ouvre sur un paragraphe de six lignes et il faut
 * relire pour trouver le mot : la recherche aurait rapproche la reponse sans
 * la designer. `<mark>` est l'element prevu pour ca — il porte le sens, pas
 * seulement la couleur, et un lecteur d'ecran l'annonce.
 *
 * La comparaison est INSENSIBLE A LA CASSE et le decoupage se fait sur le
 * texte d'origine, jamais sur sa version minuscule : rendre la minuscule
 * reecrirait « Wazuh » en « wazuh » dans une documentation qu'on recopie.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark className="soc-hit" key={`${at}`}>
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (out.length === 0) return <>{text}</>;
  out.push(text.slice(from));
  return <>{out}</>;
}

/** Ordre d'affichage des groupes. Ferme : un groupe absent d'ici ne s'affiche pas. */
const GROUP_ORDER: DocGroup[] = ['start', 'work', 'check', 'around'];

export function DocsPanel({ openSection }: { openSection?: string | null }) {
  const { c } = useI18n();
  const d = c.docs;
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  // Ouverture ciblee : on arrive ici depuis « Comment ca marche ? » d'un autre
  // onglet. Deplier la bonne section ET l'amener sous les yeux — atterrir en
  // haut d'une page de quinze sections repliees revient a ne pas repondre.
  useEffect(() => {
    if (!openSection) return;
    const el = document.getElementById(`doc-${openSection}`);
    if (!(el instanceof HTMLDetailsElement)) return;
    el.open = true;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [openSection]);

  /**
   * Ce que la recherche retient.
   *
   * Une section est retenue si son TITRE, son accroche ou l'un de ses points
   * porte le terme. Les points sont filtres — mais la section dit combien elle
   * en garde sur combien, sinon on repartirait avec une idee fausse de ce
   * qu'elle contient.
   *
   * Un titre qui correspond garde TOUS ses points : la recherche a repondu au
   * niveau de la section, et n'en montrer qu'une partie serait arbitraire.
   */
  const found = useMemo(() => {
    const all = d.sections.map((section) => ({ section, points: section.points, whole: true }));
    if (!needle) return all;
    const has = (text: string) => text.toLowerCase().includes(needle);
    return d.sections
      .map((section) => {
        const whole = has(section.title) || has(section.lede);
        const points = whole
          ? section.points
          : section.points.filter((p) => has(p.term) || has(p.text));
        return { section, points, whole };
      })
      .filter((entry) => entry.whole || entry.points.length > 0);
  }, [d.sections, needle]);

  /**
   * Les entrees de glossaire qui portent le terme.
   *
   * ========================================================================
   * CE QUE CE BLOC CORRIGE, ET IL A ETE TROUVE PAR LA RECHERCHE ELLE-MEME
   *
   * Chercher « shadow » dans le Guide ne rendait RIEN. C'est le concept
   * central du produit — le mode par defaut, celui dont depend tout l'interet
   * du projet — mais le Guide l'appelle « watch-only mode », et le mot
   * « shadow » n'y figure nulle part. Quelqu'un qui a lu `shadow_mode` dans
   * une charge utile, ou entendu le mot dans son equipe, repartait avec
   * « cette documentation ne parle pas de ca ».
   *
   * Le glossaire, lui, connait le mot : c'est sa CLE. On cherche donc aussi
   * dedans — cle, terme et definition — et une correspondance s'affiche comme
   * une reponse a part entiere, avant les sections.
   *
   * Rien n'est invente pour autant : pas de liste de synonymes ecrite a la
   * main a cote du texte, qui divergerait du texte des le premier mot change.
   * Le glossaire est deja la reponse du produit a « ca veut dire quoi », et
   * c'est celle-la qui est servie.
   * ========================================================================
   */
  const glossaryHits = useMemo(() => {
    if (!needle) return [];
    return Object.entries(c.glossary).filter(
      ([key, entry]) =>
        key.toLowerCase().includes(needle) ||
        entry.term.toLowerCase().includes(needle) ||
        entry.text.toLowerCase().includes(needle),
    );
  }, [c.glossary, needle]);

  const pointCount = found.reduce((total, entry) => total + entry.points.length, 0);

  /**
   * Le numero suit l'ORDRE DE LECTURE, pas celui du catalogue.
   *
   * Les groupes reordonnent la page ; numeroter sur l'ordre du catalogue
   * donnait « 04, 05, 06, 07, 10, 12 » dans le meme groupe. Un numero qui
   * saute ne designe plus une position, il fait chercher les manquants.
   *
   * Il est calcule sur la liste COMPLETE, jamais sur le resultat filtre :
   * « 07 » doit designer la meme section avec et sans recherche, sinon le
   * numero ne sert a rien.
   */
  const numbers = useMemo(() => {
    const order = new Map<string, number>();
    let n = 0;
    for (const group of GROUP_ORDER) {
      for (const section of d.sections) {
        if (section.group === group) order.set(section.id, ++n);
      }
    }
    return order;
  }, [d.sections]);
  const numberOf = (section: DocSection) => numbers.get(section.id) ?? 0;

  return (
    <>
      <section className="soc-panel soc-page-head">
        <span className="soc-kicker">{d.kicker}</span>
        <h2>{d.title}</h2>
        <p className="soc-muted" style={{ margin: '0 0 14px' }}>
          {d.lede}
        </p>

        {/*
          LA RECHERCHE EST DANS L'EN-TETE, PAS SOUS LES SECTIONS.
          C'est le premier geste de quelqu'un qui arrive avec un mot plutot
          qu'avec un plan — et c'est le cas le plus frequent sur une
          documentation de quatre-vingt-dix points.
        */}
        <div className="soc-doc-search">
          <input
            className="soc-search"
            type="search"
            value={query}
            placeholder={d.search}
            aria-label={d.searchLabel}
            onChange={(e) => setQuery(e.target.value)}
          />
          {needle ? (
            <>
              <span className="soc-faint">{d.matches(found.length, pointCount)}</span>
              <button type="button" className="soc-secondary" onClick={() => setQuery('')}>
                <Icon name="cross" size={13} /> {d.clear}
              </button>
            </>
          ) : null}
        </div>
      </section>

      {glossaryHits.length > 0 ? (
        <section className="soc-panel soc-doc-glossary">
          <span className="soc-kicker">{d.glossaryHits}</span>
          <dl className="soc-doc-list">
            {glossaryHits.map(([key, entry]) => (
              <div key={key} className="soc-doc-point">
                <dt>
                  <Highlight text={entry.term} query={needle} />
                </dt>
                <dd>
                  <Highlight text={entry.text} query={needle} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {needle && found.length === 0 && glossaryHits.length === 0 ? (
        <section className="soc-panel">
          <p className="soc-quiet">
            <Icon name="search" size={15} /> {d.noMatch(query.trim())}
          </p>
        </section>
      ) : null}

      {GROUP_ORDER.map((group) => {
        const inGroup = found.filter((entry) => entry.section.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group} className="soc-doc-group">
            {/* Le groupe nomme ce qu'on va trouver dessous. Il ne se replie
                pas : ce serait un troisieme niveau a ouvrir avant de lire. */}
            <span className="soc-kicker soc-doc-group-label">{d.groups[group]}</span>
            {inGroup.map(({ section, points, whole }) => (
              <details
                key={section.id}
                className="soc-doc"
                /* Pendant une recherche, tout ce qui reste est ouvert : on a
                   deja dit ce qu'on cherchait, redemander un clic par section
                   annulerait le service rendu. */
                open={needle ? true : numberOf(section) === 1}
                id={`doc-${section.id}`}
              >
                <summary>
                  <span className="soc-doc-num">{String(numberOf(section)).padStart(2, '0')}</span>
                  <span className="soc-doc-title">
                    <Highlight text={section.title} query={needle} />
                  </span>
                  {/* Ce que la section contient, annonce sur le pli — et, en
                      recherche, ce qu'elle en garde. Une section repliee muette
                      oblige a l'ouvrir pour savoir si elle valait la peine. */}
                  <span className="soc-doc-count">
                    {needle && !whole
                      ? d.pointsShown(points.length, section.points.length)
                      : d.points(section.points.length)}
                  </span>
                  <Icon name="chevron" size={16} />
                </summary>
                <div className="soc-doc-body">
                  <p className="soc-doc-lede">
                    <Highlight text={section.lede} query={needle} />
                  </p>
                  <dl className="soc-doc-list">
                    {points.map((point) => (
                      <div key={point.term} className="soc-doc-point">
                        <dt>
                          <Highlight text={point.term} query={needle} />
                        </dt>
                        <dd>
                          <Highlight text={point.text} query={needle} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {section.id === 'code' ? <CodeDiagrams /> : null}
                </div>
              </details>
            ))}
          </div>
        );
      })}
    </>
  );
}
