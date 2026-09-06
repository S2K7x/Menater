/**
 * Thème de la console : une seule source de vérité pour tout l'écran.
 *
 * ============================================================================
 * QUATRE CHOIX QUI COMPTENT
 *
 *  1. LE THÈME EST UN RÉGLAGE DE NAVIGATEUR, PAS DE SERVEUR. Il ne change ni
 *     ce que fait le pipeline, ni ce que voient les autres. Le poser dans
 *     `config.json` l'aurait imposé à tous les postes — et la console n'a que
 *     deux écritures serveur, toutes deux à l'initiative d'un humain sur une
 *     décision de sécurité. Une couleur n'en est pas une.
 *
 *  2. LE CHOIX EST APPLIQUÉ AVANT LE PREMIER PEINT. Un script court dans
 *     `index.html` lit `localStorage` et pose `data-theme` sur `<html>` avant
 *     que React ne démarre. Sans lui, la page s'afficherait en gris ardoise
 *     puis basculerait — un clignotement franchement visible sur le thème
 *     clair.
 *
 *  3. AUCUNE DÉTECTION AUTOMATIQUE. `prefers-color-scheme` n'est pas consulté :
 *     quatre de ces six thèmes ne sont ni « clair » ni « sombre » mais des
 *     partis pris colorés, et deviner lequel quelqu'un veut à partir d'un
 *     réglage système binaire donnerait un écran qu'on ne comprend pas avoir
 *     choisi. Même position que pour la langue.
 *
 *  4. UN THÈME INCONNU RETOMBE SUR LE DÉFAUT, SANS RIEN CASSER. Un
 *     `localStorage` rempli par une version plus récente, une valeur bricolée
 *     à la main : on revient à `grayed` plutôt que de servir une page sans
 *     palette, où tout serait noir sur noir.
 * ============================================================================
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { applyFavicon } from './favicon.ts';

/** Identifiants des thèmes. L'ordre est celui du sélecteur. */
export const THEMES = ['grayed', 'punk', 'blued', 'attck', 'acme', 'dark'] as const;
export type ThemeId = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeId = 'grayed';

/**
 * Clé partagée avec le script d'amorçage de `index.html`.
 *
 * ELLE EST ÉCRITE DEUX FOIS, ici et là-bas, et c'est volontaire : le script
 * doit s'exécuter avant tout module, donc il ne peut rien importer. Les
 * changer séparément casserait la mémorisation en silence — un test le
 * vérifie.
 */
export const THEME_STORAGE_KEY = 'menater.theme';

const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value);

export function readStoredTheme(fallback: ThemeId = DEFAULT_THEME): ThemeId {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : fallback;
  } catch {
    // `localStorage` peut être indisponible (navigation privée stricte, iframe
    // cloisonnée) : une préférence illisible retombe sur le défaut, elle ne
    // casse jamais l'écran.
    return fallback;
  }
}

interface ThemeValue {
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: ReactNode;
  /**
   * Thème imposé au premier rendu. Sert aux tests, qui doivent pouvoir
   * vérifier chaque palette sans dépendre d'un `localStorage` que
   * l'environnement de test ne fournit pas toujours.
   */
  initialTheme?: ThemeId;
}) {
  const [theme, setThemeState] = useState<ThemeId>(() => initialTheme ?? readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // idem : un stockage indisponible ne doit rien casser.
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemeId) => {
    // Appliqué TOUT DE SUITE, pas seulement dans l'effet ci-dessus.
    //
    // Même leçon que le sélecteur de langue : les effets des composants
    // enfants s'exécutent avant ceux du fournisseur. Un enfant qui lirait la
    // palette au moment du clic obtiendrait celle qu'on vient de quitter.
    applyTheme(next);
    setThemeState(next);
  }, []);

  const value = useMemo<ThemeValue>(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Pose le thème sur `<html>`.
 *
 * `color-scheme` suit : c'est lui qui décide de la couleur des barres de
 * défilement natives et des champs de formulaire du navigateur. Sans lui, le
 * thème clair garde des ascenseurs sombres et des menus déroulants noirs —
 * les seules zones de l'écran que le CSS ne peint pas.
 */
export function applyTheme(theme: ThemeId): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme === 'acme' ? 'light' : 'dark';
  // The tab icon follows too. Everything inside the page takes its colour from
  // the tokens for free; the tab is the one surface CSS cannot reach, so it is
  // repainted here rather than left on the slate palette under a cream theme.
  applyFavicon(theme);
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme doit être utilisé sous <ThemeProvider>.');
  return value;
}
