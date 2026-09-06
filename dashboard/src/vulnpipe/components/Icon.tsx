/**
 * Jeu d'icônes de l'interface.
 *
 * ============================================================================
 * POURQUOI DES TRACÉS SVG ET PLUS DES EMOJI
 *
 * L'interface affichait jusqu'ici des emoji (📥, ✅, 🔴...). Trois problèmes,
 * dans l'ordre de gravité :
 *
 *  1. LE RENDU N'EST PAS LE NÔTRE. Un emoji est dessiné par le système
 *     d'exploitation : le même écran est plat et gris sur Windows, bombé et
 *     coloré sur macOS, autre chose encore sur Android. Un produit de sécurité
 *     qui change d'allure selon la machine perd en crédibilité avant même
 *     d'avoir rendu un verdict.
 *
 *  2. LA COULEUR ÉCHAPPE À LA CHARTE. `styles.css` pose une règle explicite :
 *     le rouge et l'orange ne servent QU'AUX verdicts de sécurité. Un 🟠 ou un
 *     ✅ importe ses propres couleurs, hors palette, et dilue précisément le
 *     code couleur qui doit rester lisible.
 *
 *  3. CE SONT DES CARACTÈRES DE TEXTE. Ils héritent de la graisse, se
 *     désalignent sur la ligne de base et sont lus à voix haute par les
 *     lecteurs d'écran sous un nom qui n'a rien à voir avec la fonction
 *     (« visage rouge », « presse-papiers »).
 *
 * Les tracés ci-dessous sont monochromes et prennent la couleur du texte
 * environnant (`currentColor`) : c'est le CSS qui décide si une icône est
 * verte, rouge ou grise, jamais la police du système.
 *
 * Par défaut une icône est décorative (`aria-hidden`) : le libellé est
 * toujours à côté. Passer `title` la rend annoncée — à réserver aux cas où
 * l'icône porte seule l'information, comme le statut d'une étape.
 * ============================================================================
 */

export type IconName =
  // Étapes de la pipeline
  | 'inbox'
  | 'book'
  | 'link'
  | 'search'
  | 'filter'
  | 'scale'
  | 'document'
  // Statuts
  | 'check'
  | 'warning'
  | 'skip'
  | 'clock'
  | 'dot'
  // Verdicts de sécurité
  | 'shield-check'
  | 'shield-alert'
  | 'shield-question'
  // Cibles d'analyse
  | 'folder'
  | 'file'
  | 'globe'
  // Divers
  | 'bulb'
  | 'sliders'
  | 'chip'
  | 'key'
  | 'coins'
  | 'gauge'
  | 'reset'
  | 'arrow-right'
  | 'arrow-down'
  | 'eye'
  | 'lock'
  | 'code'
  | 'server'
  | 'users'
  | 'plug';

/**
 * Tracés, dans une grille 24×24.
 *
 * Contrainte tenue sur tout le jeu : trait seul, jamais de remplissage, pour
 * que deux icônes côte à côte aient le même poids visuel. Le seul `fill` du
 * fichier est le point de l'état « en attente », qui n'a pas de contour.
 */
const PATHS: Record<IconName, string> = {
  inbox: 'M3 13h4l2 3h6l2-3h4M5 5h14l2 8v6H3v-6z',
  book: 'M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM6 19h12M8 7h7M8 10h7',
  link: 'M10 13a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.4 1.4M14 11a4 4 0 0 0-5.7-.4l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.4-1.4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  scale: 'M12 4v16M7 20h10M12 6 5 9m7-3 7 3M2 15a3 3 0 0 0 6 0L5 9zm14 0a3 3 0 0 0 6 0l-3-6z',
  document: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  check: 'M4 12.5 9.5 18 20 6.5',
  warning: 'M12 3.5 22 20H2zM12 10v4.5M12 17.2v.1',
  skip: 'M5 5l9 7-9 7zM18 5v14',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5.5l3.5 2',
  dot: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  'shield-check': 'M12 3 4 6v6c0 4.5 3.3 7.7 8 9 4.7-1.3 8-4.5 8-9V6zM8.5 12l2.5 2.5 4.5-5',
  'shield-alert': 'M12 3 4 6v6c0 4.5 3.3 7.7 8 9 4.7-1.3 8-4.5 8-9V6zM12 8v4.5M12 15.6v.1',
  'shield-question': 'M12 3 4 6v6c0 4.5 3.3 7.7 8 9 4.7-1.3 8-4.5 8-9V6zM10 10a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.5M12 16.2v.1',
  folder: 'M3 6h6l2 2.5h10V19H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6v.5h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 4.5v5M8 14.5v5',
  chip: 'M7 7h10v10H7zM4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3',
  key: 'M14.5 4a5.5 5.5 0 1 0-4.3 8.9L3 20v1h4v-2h2v-2h1.6l1.6-1.6A5.5 5.5 0 0 0 14.5 4zM16 8.5v.1',
  coins: 'M12 5c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  gauge: 'M4 18a9 9 0 1 1 16 0M12 14l4-4',
  reset: 'M4 11a8 8 0 1 1 2.3 6.3M4 5v6h6',
  'arrow-right': 'M4 12h15M13 6l6 6-6 6',
  'arrow-down': 'M12 4v15M6 13l6 6 6-6',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  code: 'M9 8l-5 4 5 4M15 8l5 4-5 4',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM7.5 7v.1M7.5 17v.1',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 4.4a3.5 3.5 0 0 1 0 6.7M17.5 14.9c2.1.7 3.5 2.4 3.5 5.1',
  plug: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3',
};

export interface IconProps {
  name: IconName;
  /** Taille du carré, en pixels. 18 par défaut : aligné sur le texte courant. */
  size?: number;
  /**
   * Nom lu par les lecteurs d'écran.
   *
   * Absent, l'icône est marquée décorative — ce qui est le bon défaut : dans
   * la quasi-totalité des cas, le libellé est écrit juste à côté et l'annoncer
   * deux fois n'apporte rien.
   */
  title?: string;
  className?: string;
}

export function Icon({ name, size = 18, title, className }: IconProps) {
  const path = PATHS[name];
  return (
    <svg
      className={className ? `vp-icon ${className}` : 'vp-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={path} fill={name === 'dot' ? 'currentColor' : 'none'} />
    </svg>
  );
}
