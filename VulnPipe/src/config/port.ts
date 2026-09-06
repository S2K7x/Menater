/**
 * Port d'écoute du service d'analyse.
 *
 * ============================================================================
 * POURQUOI CE N'EST PAS UN `process.env.PORT ?? 4319` EN UNE LIGNE
 *
 * C'en était un, et il a coûté un diagnostic complet.
 *
 * `PORT` est la variable la plus générique qui soit : Heroku la pose, les
 * harnais de prévisualisation la posent, `npm` la propage aux processus
 * enfants. Le service se lançait donc sur le port de QUELQU'UN D'AUTRE —
 * observé : démarré sur 5174, celui de l'interface web, alors que la console
 * relayait vers 4319.
 *
 * ET RIEN NE LE DISAIT. Le service annonçait fièrement son port dans les logs,
 * la console répondait 503 avec « démarrer le service » — un conseil inutile
 * puisqu'il tournait déjà. La panne se lit comme un service absent alors que
 * c'est un service mal adressé.
 *
 * ============================================================================
 * L'ORDRE DE PRÉCÉDENCE, ET SA RAISON
 *
 *  1. `VULNPIPE_API_PORT` — le nom que la console et le lanceur emploient
 *     déjà. Explicite, propre à ce service : personne ne le pose par accident.
 *  2. `PORT` — conservé pour les hébergeurs qui n'offrent que celui-là.
 *  3. `4319` — le défaut documenté.
 *
 * Une valeur illisible est REFUSÉE plutôt que silencieusement remplacée par le
 * défaut : `PORT=abc` donnerait `NaN`, que Node interprète comme « n'importe
 * quel port libre » — le service démarrerait sur un port aléatoire, et on
 * serait exactement dans la panne qu'on vient de corriger.
 * ============================================================================
 */

export const DEFAULT_PORT = 4319;

export class PortError extends Error {}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.VULNPIPE_API_PORT;
  const generic = env.PORT;

  const [raw, name] = explicit !== undefined && explicit !== ''
    ? [explicit, 'VULNPIPE_API_PORT']
    : generic !== undefined && generic !== ''
      ? [generic, 'PORT']
      : [String(DEFAULT_PORT), 'défaut'];

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PortError(
      `${name}="${raw}" n'est pas un port valide (entier entre 1 et 65535).`
    );
  }
  return port;
}

/** D'où vient le port, pour que le log le dise au lieu de le laisser deviner. */
export function portSource(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VULNPIPE_API_PORT) return 'VULNPIPE_API_PORT';
  if (env.PORT) return 'PORT';
  return 'défaut';
}
