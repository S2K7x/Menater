/**
 * Rendu de test enveloppé dans le fournisseur de langue.
 *
 * Sans lui, chaque composant lève « useI18n must be used inside
 * <I18nProvider> » — ce qui est le comportement voulu en production, mais fait
 * échouer tous les tests d'affichage pour une raison sans rapport avec ce
 * qu'ils vérifient.
 *
 * `renderIn('fr', ...)` permet en plus de tester la version française : c'est
 * la seule façon de prouver que le basculement agit réellement sur l'écran, et
 * pas seulement sur un objet en mémoire.
 */

import { render as baseRender, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { I18nProvider } from '../i18n/context.tsx';
import { DEFAULT_LOCALE, type Locale } from '../i18n/dictionary.ts';
import { ThemeProvider, type ThemeId } from '../theme/context.tsx';

/** Rend dans la langue demandée (anglais par défaut, comme le produit). */
export function renderIn(locale: Locale, ui: ReactElement, theme?: ThemeId): RenderResult {
  return baseRender(
    // Même empilement qu'en production : le thème enveloppe la langue. Un
    // composant qui appelle `useTheme` lèverait sinon une erreur sans rapport
    // avec ce que son test vérifie.
    <ThemeProvider initialTheme={theme}>
      <I18nProvider initialLocale={locale}>{ui}</I18nProvider>
    </ThemeProvider>
  );
}

export function render(ui: ReactElement): RenderResult {
  return renderIn(DEFAULT_LOCALE, ui);
}

export * from '@testing-library/react';
// Notre `render` doit gagner sur celui réexporté juste au-dessus.
export { render as default };
