/**
 * Contexte de langue : une seule source de vérité pour tout l'écran.
 *
 * ============================================================================
 * TROIS CHOIX QUI COMPTENT
 *
 *  1. LE CHOIX EST MÉMORISÉ (`localStorage`). Redemander sa langue à quelqu'un
 *     à chaque visite est la façon la plus sûre de lui faire croire que le
 *     sélecteur ne marche pas.
 *
 *  2. LA LANGUE PART AVEC CHAQUE REQUÊTE. Le serveur rédige les résumés
 *     d'étapes et le rapport ; s'il ne connaît pas la langue, on obtient un
 *     écran français dont tout le contenu utile est anglais. Le sélecteur
 *     serait alors purement décoratif.
 *
 *  3. `<html lang>` SUIT. Ce n'est pas cosmétique : c'est ce qui dit aux
 *     lecteurs d'écran quelle prononciation employer, et aux navigateurs quoi
 *     proposer à la traduction.
 *
 * Aucune détection automatique depuis la langue du navigateur : l'anglais est
 * le défaut affiché, et le basculement est un geste explicite. Une détection
 * silencieuse donne un écran dont on ne comprend pas pourquoi il a changé.
 * ============================================================================
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { DEFAULT_LOCALE, dictionary, LOCALES, type Dictionary, type Locale } from './dictionary.ts';
import { consoleDictionary, type ConsoleDictionary } from './console.ts';

const STORAGE_KEY = 'vulnpipe.locale';

/**
 * Langue courante, lisible hors composant React.
 *
 * Le client HTTP n'est pas un composant : il ne peut pas appeler un hook, mais
 * il doit envoyer la langue au serveur. On la publie donc ici, tenue à jour
 * par le fournisseur ci-dessous.
 */
let currentLocale: Locale = readStoredLocaleSafely();

function readStoredLocaleSafely(fallback: Locale = DEFAULT_LOCALE): Locale {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && (LOCALES as readonly string[]).includes(stored)
      ? (stored as Locale)
      : fallback;
  } catch {
    return fallback;
  }
}

export function setCurrentLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getCurrentLocale(): Locale {
  return currentLocale;
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Vocabulaire de l'analyse de code. */
  t: Dictionary;
  /** Vocabulaire de la console : alertes, validation, mesures, sante, guide. */
  c: ConsoleDictionary;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  children,
  initialLocale,
  fallbackLocale,
}: {
  children: ReactNode;
  /**
   * Langue imposée au premier rendu.
   *
   * Sert aux tests, qui doivent pouvoir vérifier les deux langues sans
   * dépendre d'un `localStorage` que l'environnement de test ne fournit pas
   * toujours. En production, la langue mémorisée fait foi.
   */
  initialLocale?: Locale;
  /**
   * Langue de PREMIERE OUVERTURE, quand rien n'a encore ete choisi.
   *
   * Distincte de `initialLocale`, qui impose la langue a chaque rendu : ici le
   * choix memorise garde la priorite. C'est ce qui permet a la console
   * d'ouvrir la section en francais sans confisquer le selecteur a quelqu'un
   * qui a deja demande l'anglais.
   */
  fallbackLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? readStoredLocaleSafely(fallbackLocale)
  );

  useEffect(() => {
    // La langue vaut desormais pour TOUTE l'application : `<html lang>` doit
    // suivre. Ce n'est pas cosmetique — c'est ce qui dit au lecteur d'ecran
    // quelle prononciation employer et au navigateur quoi proposer a la
    // traduction. (Tant que seule la section d'analyse etait traduite, on le
    // posait sur son conteneur ; ce n'est plus le cas.)
    document.documentElement.lang = locale;
    setCurrentLocale(locale);
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // idem : un stockage indisponible ne doit rien casser.
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    // Publiee TOUT DE SUITE, pas dans l'effet ci-dessus.
    //
    // Les effets des composants enfants s'executent AVANT ceux du parent :
    // l'ecran declenchait son rechargement de donnees avec l'ancienne langue,
    // et le serveur repondait dans la langue qu'on venait de quitter. Poser la
    // valeur ici, de facon synchrone, supprime la course.
    setCurrentLocale(next);
    setLocaleState(next);
  }, []);

  // Les deux catalogues sont des objets constants : les recalculer a chaque
  // rendu ferait changer l'identite du contexte et rendrait inutile tout
  // `memo` place sous le fournisseur.
  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: dictionary(locale), c: consoleDictionary(locale) }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    // Sans le fournisseur, tout l'écran s'afficherait dans une langue figée
    // sans que personne ne comprenne pourquoi le sélecteur n'a aucun effet.
    throw new Error('useI18n must be used inside <I18nProvider>.');
  }
  return value;
}
