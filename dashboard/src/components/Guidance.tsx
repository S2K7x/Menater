/**
 * Les trois objets qui empêchent de se perdre dans la console.
 *
 * ============================================================================
 * LE PROBLÈME
 *
 * L'application fait deux métiers très différents — trier des alertes, relire
 * du code — et six onglets. Quelqu'un qui arrive tombait directement sur un
 * tableau de huit colonnes rempli de mots qu'il n'a jamais vus : « shadow »,
 * « faux positif », « confiance 0.83 ». Rien ne disait ce qu'on regardait, ni
 * ce qu'on était censé en faire.
 *
 * Cinq réponses, du général au particulier :
 *
 *   PageHead  — chaque onglet dit ce qu'il montre et à quoi ça sert, avec un
 *               lien direct vers la section du Guide qui le détaille.
 *   FirstRun  — à la première visite, trois portes d'entrée cliquables plutôt
 *               qu'un tableau muet.
 *   Term      — le mot difficile s'explique SUR PLACE, dans une bulle. Renvoyer
 *               au Guide pour comprendre un mot fait perdre la page qu'on
 *               lisait, et on n'y revient pas.
 *   Explain   — le « i » entouré : l'explication d'une SECTION, disponible en
 *               un clic au lieu d'être écrite en permanence sous son titre.
 *   Fold      — le repli : une pièce qu'on consulte parfois — un log brut, deux
 *               empreintes — annonce sa taille et sort du balayage.
 *
 * ============================================================================
 * LA FRONTIÈRE, ET ELLE EST TESTÉE
 *
 * `Explain` et `Fold` ne servent QU'À ce qui explique. Un état, un compte, une
 * panne, une action à valider ne se replient jamais : ranger un échec derrière
 * un pli silencieux reproduirait exactement le défaut que l'onglet Suivi existe
 * pour exposer. Voir `readability.test.tsx`.
 * ============================================================================
 */

import { Component, useEffect, useRef, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/context.tsx';
import type { ConsoleDictionary } from '../i18n/console.ts';
import { Icon, type IconName } from './Icon.tsx';

/* ==========================================================================
 * En-tête d'onglet
 * ========================================================================== */

export function PageHead({
  kicker,
  title,
  lede,
  onGuide,
  children,
}: {
  kicker: string;
  title: string;
  lede: string;
  /** Ouvre la section du Guide qui explique cet onglet. */
  onGuide?: () => void;
  children?: ReactNode;
}) {
  const { c } = useI18n();
  return (
    <section className="soc-panel soc-page-head">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{kicker}</span>
          <h2>{title}</h2>
        </div>
        {onGuide ? (
          <button type="button" className="soc-secondary soc-guide-link" onClick={onGuide}>
            <Icon name="book" size={14} />
            {c.guideLink}
          </button>
        ) : null}
      </div>
      <p className="soc-muted" style={{ margin: 0 }}>
        {lede}
      </p>
      {children}
    </section>
  );
}

/* ==========================================================================
 * Bulles : le glossaire, et l'explication au clic
 * ========================================================================== */

/**
 * Positionnement partage par les deux bulles de ce fichier.
 *
 * `<details>` natif : ouverture au clavier, fermeture par Echap, et aucun etat
 * React a faire redescendre dans une table de quarante lignes. Le hook n'ajoute
 * que ce que le natif ne sait pas faire — se retourner au bord de l'ecran, et
 * se refermer quand on clique ailleurs.
 */
function useBubble() {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  // La bulle s'ancre a gauche par defaut. Sur une colonne de droite, elle
  // sortait de l'ecran et poussait une barre de defilement horizontale sur
  // toute la page — on mesure a l'ouverture et on la bascule a droite.
  const [flip, setFlip] = useState(false);

  /*
   * Un clic ailleurs referme la bulle. Sans ca, on se retrouve avec trois
   * definitions ouvertes qui recouvrent la ligne qu'on voulait lire.
   *
   * L'ecouteur n'existe QUE pendant que la bulle est ouverte. Pose au montage,
   * il y en avait un par bulle presente a l'ecran — six sur les mesures, deux
   * par en-tete de colonne — tous appeles a chaque clic de la page pour que
   * cinq d'entre eux constatent qu'ils sont fermes. Ici il y en a au plus un.
   */
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      const el = ref.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const onToggle = () => {
    const el = ref.current;
    setOpen(Boolean(el?.open));
    if (!el?.open) return;
    const bubble = el.querySelector('.soc-term-bubble');
    if (!(bubble instanceof HTMLElement)) return;
    // Mesure non basculee : on repart toujours de l'ancrage gauche, sinon deux
    // ouvertures successives se renvoient la bulle d'un bord a l'autre.
    setFlip(false);
    requestAnimationFrame(() => {
      const box = bubble.getBoundingClientRect();
      setFlip(box.right > document.documentElement.clientWidth - 8);
    });
  };

  return { ref, flip, onToggle };
}

/**
 * Un mot difficile, explique au clic.
 *
 * Le `<summary>` porte le mot lui-meme — souligne en pointille, la convention
 * que tout le monde reconnait pour « il y a quelque chose derriere ».
 */
export function Term({
  name,
  children,
}: {
  name: keyof ConsoleDictionary['glossary'];
  /** Texte affiché, si différent du terme du glossaire. */
  children?: ReactNode;
}) {
  const { c } = useI18n();
  const entry = c.glossary[name];
  const { ref, flip, onToggle } = useBubble();

  return (
    <details className="soc-term" ref={ref} onToggle={onToggle}>
      <summary title={c.glossaryOpen}>{children ?? entry.term}</summary>
      <span className={`soc-term-bubble${flip ? ' soc-term-bubble-flip' : ''}`} role="note">
        <strong>{entry.term}</strong>
        {entry.text}
      </span>
    </details>
  );
}

/**
 * Le « i » entoure : l'explication d'une section, disponible sans etre ecrite.
 *
 * ============================================================================
 * CE QU'IL REMPLACE, ET POURQUOI
 *
 * Chaque panneau de cette console ouvrait sur une phrase qui explique ce qu'il
 * montre. Prise une par une, chacune est utile ; empilees, elles font que la
 * moitie d'un ecran de supervision est de la prose — et une prose qu'on a lue
 * une fois, qu'on ne relira jamais, et qui occupe pour toujours la place ou
 * les chiffres devraient se voir.
 *
 * L'explication ne disparait pas : elle passe DERRIERE un point d'entree d'un
 * seizieme de pouce, a cote du titre qu'elle explique. C'est de la divulgation
 * progressive au sens strict — le detail reste a un clic, il quitte le balayage.
 *
 * TROIS REGLES POUR SAVOIR CE QUI Y ENTRE
 *
 *  1. Ce qui EXPLIQUE va dans le « i ». Ce qui RAPPORTE reste a l'ecran. Un
 *     etat, un compte, une panne ne se cachent jamais derriere un clic.
 *  2. Une explication cachee doit rester vraie hors contexte : elle est lue
 *     seule, sans la phrase qui la precedait.
 *  3. Il s'attache a un titre, jamais a une valeur — pour une valeur, c'est
 *     `Term` qui souligne le mot lui-meme.
 * ============================================================================
 */
/**
 * Deux formes, jamais melangees.
 *
 * `term` sert quand le mot a expliquer N'EST PAS ECRIT — un en-tete de colonne
 * fusionnee, une pastille sans libelle. `Term` souligne un mot present ; ici
 * il n'y en a pas a souligner, donc l'affordance devient un disque. Les deux
 * lisent le MEME catalogue : une definition n'existe qu'une fois.
 */
type ExplainProps =
  | { term: keyof ConsoleDictionary['glossary']; children?: never; label?: never }
  | {
      term?: never;
      /** L'explication. Elle doit se tenir seule : personne ne lit ce qui l'entoure. */
      children: ReactNode;
      /** Titre de la bulle. Absent = la bulle n'affiche que le texte. */
      label?: string;
    };

export function Explain(props: ExplainProps) {
  const { c } = useI18n();
  const { ref, flip, onToggle } = useBubble();

  // Une entree de glossaire porte deja son titre et son texte : les recopier
  // dans l'appel creerait une seconde version de la meme definition, et deux
  // versions d'une definition divergent toujours.
  const entry = props.term ? c.glossary[props.term] : null;
  const label = entry ? entry.term : props.label;
  const body = entry ? entry.text : props.children;

  return (
    <details className="soc-info" ref={ref} onToggle={onToggle}>
      {/*
        `aria-label` et pas seulement `title` : le glyphe est un « i », que
        certains lecteurs d'ecran annoncent comme la lettre. La phrase dit ce
        que le bouton FAIT, pas ce qu'il montre.
      */}
      <summary title={c.explain.open} aria-label={c.explain.open}>
        i
      </summary>
      <span className={`soc-term-bubble${flip ? ' soc-term-bubble-flip' : ''}`} role="note">
        {label ? <strong>{label}</strong> : null}
        {body}
      </span>
    </details>
  );
}

/* ==========================================================================
 * Repli
 * ========================================================================== */

/**
 * Une section repliee, avec ce qu'elle contient annonce sur le pli.
 *
 * ============================================================================
 * CE QUI A LE DROIT D'ETRE REPLIE
 *
 * Les PIECES : un log brut, deux empreintes d'audit, la liste des workflows
 * publies. On les consulte quand on doute, pas quand on travaille — et elles
 * occupaient, a chaque ouverture d'un cas, plus de hauteur que la decision
 * qu'on venait lire.
 *
 * CE QUI N'EN A PAS LE DROIT : ce qui bloque quelqu'un, ce qui a echoue, ce
 * qu'on vient valider. Ranger une panne derriere un pli silencieux
 * reproduirait exactement le defaut que l'onglet Suivi existe pour exposer —
 * un echec qui s'affiche vert. C'est pourquoi le pli PORTE son contenu :
 * `hint` dit combien il y a dedans, et `tone` le colore quand ce qui est
 * dedans n'est pas normal.
 * ============================================================================
 */
export function Fold({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  /** Ce qu'il y a dedans, lisible sans ouvrir : « 5 etapes », « 412 octets ». */
  hint?: ReactNode;
  /**
   * Ouvre le pli — a l'affichage, et a chaque fois que la valeur DEVIENT vraie.
   *
   * ========================================================================
   * IL OUVRE, IL NE FERME JAMAIS
   *
   * `<details open={x}>` en React est un composant a moitie controle : React
   * reecrit l'attribut des que la valeur change, y compris pour le remettre a
   * `false`. Ecrit ainsi, ce pli refermait sous les doigts ce que quelqu'un
   * venait d'ouvrir — il suffisait qu'une donnee arrive.
   *
   * Le defaut vu a l'ecran : le bloc « Etat » des moteurs recevait
   * `health !== 'online'`, donc `true` pendant la verification. Il s'ouvrait
   * au chargement puis se refermait tout seul une seconde plus tard.
   *
   * La regle tient en une ligne, et elle couvre tous les appels : le signal
   * OUVRE quand il devient vrai, et ne fait RIEN quand il devient faux. La
   * valeur initiale est figee au montage, donc React ne la rejoue jamais.
   * L'etat du pli appartient ensuite a la personne qui clique.
   * ========================================================================
   */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Figee au montage : le prop passe a React ne change donc jamais, et React
  // ne peut pas revenir ecraser ce que l'utilisateur a choisi.
  const initial = useRef(defaultOpen).current;

  useEffect(() => {
    if (defaultOpen && ref.current) ref.current.open = true;
  }, [defaultOpen]);

  return (
    <details className="soc-fold" ref={ref} open={initial}>
      <summary>
        <span className="soc-fold-chevron" aria-hidden="true" />
        {title}
        {hint ? <span className="soc-fold-hint">{hint}</span> : null}
      </summary>
      <div className="soc-fold-body">{children}</div>
    </details>
  );
}

/* ==========================================================================
 * Carte de bienvenue
 * ========================================================================== */

const SEEN_KEY = 'menater.firstRun.seen';

function seen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // Stockage indisponible (navigation privée stricte) : on montre la carte.
    // La revoir une fois de trop est moins grave que de ne jamais la voir.
    return false;
  }
}

/**
 * Trois portes d'entrée, à la première visite seulement.
 *
 * Elle s'écarte définitivement au clic — pas au bout de N secondes, pas à la
 * navigation : quelqu'un qui n'a pas fini de lire ne doit pas voir sa carte
 * disparaître sous ses yeux.
 */
export function FirstRun({ onGo }: { onGo: (target: 'queue' | 'code' | 'docs') => void }) {
  const { c } = useI18n();
  const [hidden, setHidden] = useState(seen);
  if (hidden) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* le refus du stockage ne doit pas empêcher de fermer la carte */
    }
    setHidden(true);
  };

  const targets: Array<{ id: 'queue' | 'code' | 'docs'; icon: IconName }> = [
    { id: 'queue', icon: 'queue' },
    { id: 'code', icon: 'code' },
    { id: 'docs', icon: 'book' },
  ];

  return (
    <section className="soc-panel soc-firstrun">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{c.firstRun.kicker}</span>
          <h2>{c.firstRun.title}</h2>
        </div>
        <button type="button" className="soc-secondary" onClick={dismiss}>
          <Icon name="check" size={14} /> {c.firstRun.dismiss}
        </button>
      </div>
      <p className="soc-muted">{c.firstRun.lede}</p>
      <ul className="soc-firstrun-grid">
        {c.firstRun.steps.map((step, index) => {
          const target = targets[index]!;
          return (
            <li key={step.label}>
              <span className="soc-firstrun-icon">
                <Icon name={target.icon} size={18} />
              </span>
              <h3>{step.label}</h3>
              <p>{step.text}</p>
              <button type="button" className="soc-secondary" onClick={() => onGo(target.id)}>
                {step.action}
                <Icon name="external" size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ==========================================================================
 * Filet des sections chargées à la demande
 * ========================================================================== */

/**
 * Rattrape l'échec de chargement d'un morceau d'interface.
 *
 * ============================================================================
 * POURQUOI CE FILET EXISTE
 *
 * L'analyse de code est chargée à la demande (`React.lazy`). Si son fichier
 * n'arrive pas — coupure réseau, serveur redémarré pendant qu'on cliquait,
 * empreinte de fichier périmée après une mise à jour — React remonte
 * l'exception jusqu'à la racine et DÉMONTE TOUTE L'APPLICATION. L'écran
 * devient blanc, sans un mot, alors que la file d'alertes fonctionnait très
 * bien une seconde plus tôt.
 *
 * Le filet garde la panne dans l'onglet concerné, l'écrit en clair, et propose
 * le seul geste qui remette les choses d'aplomb.
 * ============================================================================
 */
export class SectionBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // La console du navigateur reste la seule trace exploitable : la garder
    // permet de distinguer un fichier manquant d'un vrai bug de rendu.
    console.error('[menater] section non chargée —', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <SectionFailure />;
  }
}

function SectionFailure() {
  const { c } = useI18n();
  return (
    <section className="soc-panel">
      <div className="soc-banner soc-banner-error">
        <Icon name="alert" size={16} />
        <p>
          <strong>{c.errors.chunkTitle}</strong>
          {c.errors.chunkLede}
        </p>
      </div>
      <button type="button" className="soc-primary" onClick={() => window.location.reload()}>
        <Icon name="refresh" size={15} /> {c.errors.reload}
      </button>
    </section>
  );
}
