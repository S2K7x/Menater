/**
 * Langues de l'application.
 *
 * ============================================================================
 * LA LIGNE DE PARTAGE
 *
 * Tout ce que VulnPipe écrit se range dans deux catégories, et une seule est
 * traduite :
 *
 *  1. LE TEXTE DESTINÉ À L'UTILISATEUR — résumés en langage courant, messages
 *     d'étape, libellés d'interface, motifs de refus. Il passe par ce
 *     catalogue et existe en anglais et en français.
 *
 *  2. LE TEXTE TECHNIQUE — `error.message`, journaux serveur, détails repliés
 *     derrière « voir le détail technique ». Il reste en anglais, une seule
 *     version. Traduire un message d'erreur d'API ne rend service à personne :
 *     il finit copié-collé dans un moteur de recherche, où la version anglaise
 *     est celle qui trouve des réponses.
 *
 * L'anglais est la langue par défaut, y compris quand aucune langue n'est
 * demandée : c'est le choix qui rend l'outil utilisable par le plus de monde.
 * ============================================================================
 */

// English only. The catalogue machinery stays — it is what keeps user-facing
// strings out of the code — but there is one locale in it.
export const LOCALES = ['en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Ramène n'importe quelle entrée à une langue connue.
 *
 * Tolérant volontairement : `fr-FR`, `FR`, `fr_CA` désignent tous le français.
 * Une valeur inconnue retombe sur l'anglais plutôt que de faire échouer la
 * requête — une langue non prise en charge n'est pas une erreur, c'est un
 * défaut.
 */
export function normalizeLocale(input: unknown): Locale {
  if (typeof input !== 'string') return DEFAULT_LOCALE;
  const base = input.trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base ?? '') ? (base as Locale) : DEFAULT_LOCALE;
}

/** Accord singulier/pluriel, sans dépendance ni `Intl.PluralRules`. */
export function plural(count: number, one: string, many: string): string {
  return count > 1 ? many : one;
}
