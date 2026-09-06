/**
 * Jeu d'icones de la console.
 *
 * Meme regle que VulnPipe : des traces SVG monochromes, jamais d'emoji. Un
 * emoji est dessine par le systeme d'exploitation, importe ses propres
 * couleurs hors palette, et se fait lire a voix haute sous un nom qui n'a rien
 * a voir avec sa fonction. Sur une console ou le code couleur porte le tri du
 * risque, laisser un glyphe importer son propre orange n'est pas envisageable.
 *
 * Les traces prennent `currentColor` : c'est le CSS qui decide si une icone est
 * verte, rouge ou grise. Par defaut elles sont decoratives (`aria-hidden`), le
 * libelle etant porte par le texte voisin ; passer `title` les rend annoncees.
 */

import type { ReactElement } from 'react';

export type IconName =
  | 'queue' | 'shield' | 'clock' | 'check' | 'cross' | 'alert' | 'chain'
  | 'database' | 'activity' | 'search' | 'play' | 'external' | 'refresh'
  | 'lock' | 'skip' | 'brain' | 'sliders' | 'code' | 'chevron' | 'book' | 'menu'
  | 'palette' | 'chip' | 'chat' | 'send' | 'plus';

const PATHS: Record<IconName, ReactElement> = {
  queue: <><path d="M3 5h18M3 12h18M3 19h12" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  check: <><path d="M4.5 12.5l5 5 10-11" /></>,
  cross: <><path d="M6 6l12 12M18 6L6 18" /></>,
  alert: <><path d="M12 4l9 16H3l9-16z" /><path d="M12 10v4.5M12 17.4v.1" /></>,
  chain: <><path d="M10 13.5a4 4 0 005.7 0l2.6-2.6a4 4 0 10-5.7-5.7L11.4 6.4" /><path d="M14 10.5a4 4 0 00-5.7 0l-2.6 2.6a4 4 0 105.7 5.7l1.2-1.2" /></>,
  database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  activity: <><path d="M3 12h4l3 8 4-16 3 8h4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  play: <><path d="M7 4.5l12 7.5-12 7.5z" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5" /></>,
  refresh: <><path d="M20 12a8 8 0 10-2.6 5.9" /><path d="M20 5v6h-6" /></>,
  lock: <><rect x="4.5" y="10.5" width="15" height="10" rx="1.5" /><path d="M8 10.5V7.5a4 4 0 018 0v3" /></>,
  skip: <><path d="M6 6l7 6-7 6z" /><path d="M17 6v12" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h13M21 17h-1" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="19" cy="17" r="2" /></>,
  // Les chevrons d'un editeur : c'est le signe le plus lisible pour « du code
  // source », et il ne reprend pas le bouclier, deja pris par la sante du
  // pipeline et par le triage.
  code: <><path d="M9 7l-5 5 5 5" /><path d="M15 7l5 5-5 5" /></>,
  // Le chevron tourne en CSS quand un <details> s'ouvre : un seul trace suffit.
  chevron: <><path d="M6 9l6 6 6-6" /></>,
  book: <><path d="M5 4.5A1.5 1.5 0 016.5 3H19v15H6.5A1.5 1.5 0 005 19.5z" /><path d="M5 19.5A1.5 1.5 0 016.5 18H19v3H6.5A1.5 1.5 0 015 19.5z" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  // Une palette de peintre : c'est le seul pictogramme que tout le monde lit
  // comme « couleurs » sans legende.
  // Une puce : le pipeline vu comme un circuit, pas comme un organigramme.
  chip: <><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3" /></>,
  palette: <><path d="M12 3a9 9 0 000 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-.9.8-1.7 1.7-1.7H16a5 5 0 005-5c0-4-4-7.3-9-7.3z" /><circle cx="7.5" cy="11" r="1.1" /><circle cx="10.5" cy="7" r="1.1" /><circle cx="15" cy="7.6" r="1.1" /></>,
  // A speech bubble: the assistant is recognised by its shape before its
  // label, and it is the only floating element in the application.
  chat: <><path d="M4.5 6.5A2 2 0 016.5 4.5h11a2 2 0 012 2v7a2 2 0 01-2 2H10l-4 3.5v-3.5h-1.5v-9z" /></>,
  send: <><path d="M5 12l14-6-6 14-2.2-5.8z" /></>,
  brain: <><path d="M9 4.5a3 3 0 00-3 3 3 3 0 00-1.5 5.6A3 3 0 006 18a3 3 0 003 3V4.5z" /><path d="M15 4.5a3 3 0 013 3 3 3 0 011.5 5.6A3 3 0 0118 18a3 3 0 01-3 3V4.5z" /></>,
};

export function Icon({
  name,
  size = 16,
  title,
}: {
  name: IconName;
  size?: number;
  title?: string;
}) {
  return (
    <span className="soc-icon">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        role={title ? 'img' : undefined}
        aria-hidden={title ? undefined : true}
        aria-label={title}
      >
        {title ? <title>{title}</title> : null}
        {PATHS[name]}
      </svg>
    </span>
  );
}
