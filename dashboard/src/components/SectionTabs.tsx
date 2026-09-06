/**
 * Sous-navigation d'un onglet.
 *
 * ============================================================================
 * POURQUOI CE COMPOSANT EXISTE
 *
 * Les Réglages tenaient sur une page de 620 lignes : six blocs empilés, dont
 * quatre invisibles sans faire défiler. Chercher la cadence de rafraîchissement
 * demandait de traverser la base de données et les canaux Slack. Un écran qu'on
 * parcourt au lieu de le consulter finit par ne plus être consulté.
 *
 * ============================================================================
 * TROIS RÈGLES QUI DÉCIDENT SI CE COMPOSANT AIDE OU NUIT
 *
 *  1. RIEN NE SE CACHE DERRIÈRE UN ONGLET SANS LAISSER DE TRACE. Un compteur
 *     ou une pastille reste visible sur l'onglet fermé. Sans ça, une alarme
 *     rangée dans un tiroir cesse d'être une alarme — c'est exactement ce que
 *     l'onglet Suivi existe pour éviter.
 *
 *  2. LE CONTENU N'EST PAS DÉMONTÉ, il est masqué. Un champ à moitié rempli,
 *     une recherche en cours, une position de défilement : tout survit à un
 *     aller-retour entre deux sous-onglets. Démonter le remettrait à zéro,
 *     et l'utilisateur croirait avoir perdu sa saisie.
 *
 *  3. ON NE DÉCOUPE PAS CE QUI SE LIT D'UN SEUL TENANT. Santé et Mesures
 *     gardent leurs quatre blocs empilés : leur travail est de donner un état
 *     d'ensemble en un regard, et un état d'ensemble réparti sur quatre
 *     onglets n'est plus un état d'ensemble.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon, type IconName } from './Icon.tsx';

export interface SectionTabItem<Id extends string> {
  id: Id;
  label: string;
  icon?: IconName;
  /**
   * Nombre à porter sur l'onglet, visible même quand il n'est pas actif.
   * `0` et `undefined` n'affichent rien : une pastille « 0 » se lit comme une
   * alarme éteinte alors qu'elle ne dit rien.
   */
  count?: number;
  /** Colore le compteur en rouge : quelque chose demande une action. */
  alert?: boolean;
  /** Court complément affiché sous le libellé, sur les écrans larges. */
  hint?: string;
}

export function SectionTabs<Id extends string>({
  items,
  active,
  onChange,
  label,
}: {
  items: SectionTabItem<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  /** Nom du groupe pour les lecteurs d'écran. */
  label: string;
}) {
  const bar = useRef<HTMLDivElement>(null);

  /**
   * De quel cote la barre continue au-dela du cadre.
   *
   * ==========================================================================
   * LE DEFAUT QUE CECI CORRIGE
   *
   * A 1280 px, les Reglages ont dix sections et la barre en montre sept. Les
   * trois dernieres — dont les moteurs d'analyse et l'ouverture MCP — etaient
   * hors cadre SANS AUCUN SIGNE : la barre defile, mais rien ne disait qu'elle
   * defile. Une section qu'on ne sait pas chercher n'existe pas.
   *
   * C'est le meme defaut que la barre principale corrigeait autrement (les
   * groupes separes par un filet), et il coute plus cher ici : sur une page de
   * reglages, on VIENT chercher une section precise.
   *
   * Le degrade est le signe conventionnel, et il ne coute aucune hauteur — la
   * barre est collante, une seconde ligne permanente en aurait mange cent
   * pixels sur chaque ecran de reglages.
   * ==========================================================================
   */
  const [edges, setEdges] = useState<'none' | 'left' | 'right' | 'both'>('none');

  const measure = useCallback(() => {
    const el = bar.current;
    if (!el) return;
    // 2 px de tolerance : un defilement fractionnaire (zoom navigateur, ecran
    // a rapport non entier) laisserait sinon un degrade allume en permanence.
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none');
  }, []);

  useEffect(() => {
    const el = bar.current;
    if (!el) return undefined;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // `ResizeObserver` manque sous jsdom : son absence ne doit pas emporter le
    // rendu de la barre, qui reste utilisable sans le degrade.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [measure, items.length]);

  /**
   * L'onglet actif est ramené dans le champ de vision.
   *
   * LA BARRE DÉFILE HORIZONTALEMENT : sur un écran étroit — ou simplement
   * quand il y a sept sections — l'onglet sélectionné peut se trouver hors du
   * cadre. Quand la sélection vient d'AILLEURS que d'un clic sur la barre (la
   * liste de mise en route envoie directement sur « Crédentiales »), l'écran
   * changeait de contenu sans qu'aucun onglet ne paraisse actif : on ne savait
   * plus où on était.
   *
   * `nearest` et non `center` : on ne bouge la barre que si c'est nécessaire,
   * un défilement gratuit à chaque clic serait du bruit.
   */
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // `scrollIntoView` n'existe pas sous jsdom : appelé nu, il lève et emporte
    // le rendu du composant avec lui. Une commodité d'affichage ne doit jamais
    // pouvoir casser la barre elle-même.
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    // Deux elements : l'enveloppe porte le collant et les degrades, la barre
    // porte le defilement. Un seul ne peut pas faire les deux — un pseudo
    // element pose sur un conteneur qui defile part avec le contenu.
    //
    // `min-width: 0` est porté par la feuille de style : un élément flex refuse
    // sinon de devenir plus étroit que son contenu, et c'est la PAGE ENTIÈRE
    // qui défile horizontalement au lieu de la barre.
    <div className="soc-subnav-wrap" data-edges={edges}>
    <div className="soc-subnav" role="tablist" aria-label={label} ref={bar}>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`soc-subtab-${item.id}`}
            aria-selected={isActive}
            aria-controls={`soc-subpanel-${item.id}`}
            className={`soc-subtab ${isActive ? 'soc-subtab-active' : ''}`}
            onClick={() => onChange(item.id)}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : null}
            <span className="soc-subtab-text">
              <span className="soc-subtab-label">{item.label}</span>
              {item.hint ? <span className="soc-subtab-hint">{item.hint}</span> : null}
            </span>
            {item.count ? (
              <span className={`soc-subtab-count ${item.alert ? 'soc-subtab-count-alert' : ''}`}>
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
    </div>
  );
}

/**
 * Un panneau de sous-onglet.
 *
 * Masqué par `hidden` plutôt que retiré de l'arbre : voir la règle 2 ci-dessus.
 * `hidden` retire aussi le contenu de l'ordre de tabulation et des lecteurs
 * d'écran, ce qu'un simple `display: none` en CSS ne garantit pas partout.
 */
export function SectionPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`soc-subpanel-${id}`}
      aria-labelledby={`soc-subtab-${id}`}
      hidden={!active}
    >
      {children}
    </div>
  );
}
