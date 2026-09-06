/**
 * Index repo-wide — la couche que la spec de la Phase 2 suppose acquise mais
 * qui n'existait pas.
 *
 * La Phase 1 indexait un fichier à la fois, et uniquement les classes décorées
 * `@Controller`. La `symbol_table` qu'elle produit liste des SITES D'APPEL
 * (« quelqu'un appelle OrderService::findById »), jamais des DÉFINITIONS.
 * Pour résoudre `findById`, il faut d'abord avoir lu `order.service.ts`.
 *
 * Ce module parcourt un dossier, indexe tous les `.ts`, et construit les deux
 * tables dont le resolver a besoin :
 *   - `classes`   : nom de classe -> définitions (plusieurs = collision réelle)
 *   - `endpoints` : (méthode HTTP, route) -> endpoint + contrôleur porteur
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { indexFile, type ClassDefinition, type ControllerIndex, type Endpoint } from '../indexer/indexer.ts';

/** Dossiers qu'on ne parcourt jamais : ni du code applicatif, ni du code à scanner. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

/** Fichiers de test : hors surface d'attaque, et ils polluent la résolution de noms. */
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

export interface IndexedEndpoint {
  endpoint: Endpoint;
  controller: ControllerIndex;
}

export interface RepoIndex {
  root: string;
  files: string[];
  /** Nom de classe -> définitions. Longueur > 1 = ambiguïté réelle à signaler. */
  classes: Map<string, ClassDefinition[]>;
  endpoints: IndexedEndpoint[];
  warnings: string[];
}

/** Liste récursivement les `.ts` indexables sous `root`. */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry)) walk(fullPath);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.endsWith('.d.ts')) continue;
      if (TEST_FILE_PATTERN.test(entry)) continue;
      found.push(fullPath);
    }
  };

  walk(root);
  return found.sort();
}

/**
 * Clé canonique d'un endpoint.
 *
 * CORRECTION DE LA SPEC : `get_context(route)` prend la route seule, mais une
 * route N'EST PAS unique — `GET /orders/:id` et `DELETE /orders/:id` sont deux
 * endpoints différents avec des surfaces de risque différentes. Chercher par
 * route seule renverrait silencieusement le premier trouvé, et le node de
 * détection auditerait le mauvais handler.
 */
export function endpointKey(httpMethod: string, route: string): string {
  return `${httpMethod.toUpperCase()} ${route}`;
}

/** Construit l'index complet d'un dossier. */
export function buildRepoIndex(root: string): RepoIndex {
  const files = listSourceFiles(root);
  const classes = new Map<string, ClassDefinition[]>();
  const endpoints: IndexedEndpoint[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join('/');
    let fileIndex;
    try {
      fileIndex = indexFile(file);
    } catch (error) {
      warnings.push(`Fichier ignoré (${relativePath}) : ${(error as Error).message}`);
      continue;
    }

    for (const definition of fileIndex.classes) {
      const withRelativePath: ClassDefinition = { ...definition, file: relativePath };
      const existing = classes.get(definition.name);
      if (existing) existing.push(withRelativePath);
      else classes.set(definition.name, [withRelativePath]);
    }

    for (const controller of fileIndex.controllers) {
      for (const endpoint of controller.endpoints) {
        endpoints.push({
          endpoint: { ...endpoint, source: { ...endpoint.source, file: relativePath } },
          controller,
        });
      }
    }
  }

  // Deux classes de même nom : le resolver ne pourra pas trancher tout seul.
  // On le dit ici plutôt que de laisser le resolver deviner.
  for (const [name, definitions] of classes) {
    if (definitions.length > 1) {
      warnings.push(
        `Classe "${name}" définie ${definitions.length} fois (${definitions
          .map((d) => d.file)
          .join(', ')}) : les appels vers cette classe seront marqués resolution_status="ambiguous".`
      );
    }
  }

  return { root, files, classes, endpoints, warnings };
}

/**
 * Retrouve un endpoint. `httpMethod` optionnel : s'il est omis et que
 * plusieurs verbes partagent la route, on renvoie la liste des collisions
 * plutôt que d'en choisir un au hasard.
 */
export function findEndpoint(
  index: RepoIndex,
  route: string,
  httpMethod?: string
): { match: IndexedEndpoint | null; collisions: IndexedEndpoint[] } {
  const onRoute = index.endpoints.filter((e) => e.endpoint.route === route);

  if (!httpMethod) {
    return onRoute.length === 1
      ? { match: onRoute[0]!, collisions: [] }
      : { match: null, collisions: onRoute };
  }

  const wanted = endpointKey(httpMethod, route);
  const exact = onRoute.filter((e) => endpointKey(e.endpoint.http_method, e.endpoint.route) === wanted);
  return exact.length === 1 ? { match: exact[0]!, collisions: [] } : { match: null, collisions: onRoute };
}
