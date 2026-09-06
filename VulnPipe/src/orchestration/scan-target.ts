/**
 * Ce qu'on analyse : un dossier, un fichier seul, ou un dépôt GitHub.
 *
 * ============================================================================
 * POURQUOI
 *
 * Le webhook n'acceptait qu'un `repo_path` : un chemin absolu vers un dossier
 * déjà présent sur la machine. Ça couvre le cas « je scanne mon projet en
 * local » et rien d'autre. Or les trois usages naturels sont :
 *
 *   - un dossier          : « vérifie tout mon projet »
 *   - un fichier seul     : « je viens d'écrire ce contrôleur, il est bon ? »
 *   - un dépôt GitHub     : « vérifie ce repo », sans l'avoir cloné à la main
 *
 * Le fichier seul n'est PAS un dossier à un élément : il faut indexer le
 * projet autour pour résoudre les services appelés, mais n'auditer que les
 * routes du fichier visé. Les deux notions sont donc séparées ci-dessous :
 *   `indexRoot`  = ce qu'on lit pour comprendre
 *   `focusFiles` = ce qu'on audite réellement
 *
 * Sans cette séparation, scanner un contrôleur seul donnerait « contexte
 * introuvable » sur chaque appel de service — un faux « missing_context » sur
 * toute la ligne.
 * ============================================================================
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';

const run = promisify(execFile);

export type TargetKind = 'directory' | 'file' | 'github';

export interface TargetDescriptor {
  kind: TargetKind;
  /** Entrée brute, telle que tapée. */
  raw: string;
  /** Pour un dépôt : URL de clonage. Sinon : chemin absolu. */
  location: string;
  owner?: string;
  repo?: string;
  ref?: string;
  /** Libellé court, affichable tel quel dans l'interface. */
  label: string;
}

export interface ResolvedTarget extends TargetDescriptor {
  /** Racine à indexer, pour que la résolution des appels ait du contexte. */
  indexRoot: string;
  /**
   * Restriction de l'audit, en chemins relatifs à `indexRoot`.
   * `null` = tout le contenu de `indexRoot`.
   */
  focusFiles: string[] | null;
  /** À appeler quand le scan est fini (supprime un clone temporaire). */
  cleanup: () => Promise<void>;
  plain_language_summary: string;
  warnings: string[];
}

const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?\/?(?:[?#].*)?$/i;
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i;
const GITHUB_SHORT = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([^/\s]+))?$/;

/**
 * Devine la nature de la cible sans rien lire sur le réseau.
 *
 * Ordre volontaire : on teste le disque AVANT la forme `owner/repo`. Un
 * dossier relatif nommé `src/api` ressemble exactement à un dépôt GitHub ;
 * s'il existe sur le disque, c'est lui que l'utilisateur veut, pas un clone.
 */
export function classifyTarget(
  input: string,
  cwd: string = process.cwd(),
  locale: Locale = DEFAULT_LOCALE
): TargetDescriptor {
  const t = messages(locale).target;
  const raw = input.trim();
  if (raw.length === 0) {
    throw new TargetError('empty target', t.empty);
  }

  const asPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (existsSync(asPath)) {
    const stats = statSync(asPath);
    if (stats.isDirectory()) {
      return { kind: 'directory', raw, location: asPath, label: shortLabel(asPath) };
    }
    return { kind: 'file', raw, location: asPath, label: shortLabel(asPath) };
  }

  for (const pattern of [GITHUB_URL, GITHUB_SSH]) {
    const match = pattern.exec(raw);
    if (match) return githubDescriptor(raw, match[1]!, match[2]!, match[3]);
  }

  // Forme courte `owner/repo` : acceptée seulement si elle ne contient pas de
  // marqueur de chemin, pour ne jamais transformer une faute de frappe dans un
  // chemin local en requête réseau silencieuse.
  if (!raw.includes('\\') && !raw.startsWith('.') && !raw.startsWith('/')) {
    const match = GITHUB_SHORT.exec(raw);
    if (match) return githubDescriptor(raw, match[1]!, match[2]!, match[3]);
  }

  throw new TargetError(`target not found: ${raw}`, t.notFound(raw));
}

function githubDescriptor(raw: string, owner: string, repo: string, ref?: string): TargetDescriptor {
  return {
    kind: 'github',
    raw,
    location: `https://github.com/${owner}/${repo}.git`,
    owner,
    repo,
    ref,
    label: `${owner}/${repo}${ref ? ` (${ref})` : ''}`,
  };
}

function shortLabel(path: string): string {
  const parts = path.split(sep).filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

/** Erreur portant un message déjà lisible par un non-développeur. */
export class TargetError extends Error {
  readonly plainLanguageSummary: string;
  constructor(message: string, plainLanguageSummary: string) {
    super(message);
    this.name = 'TargetError';
    this.plainLanguageSummary = plainLanguageSummary;
  }
}

const NO_CLEANUP = async (): Promise<void> => {};

/**
 * Prépare la cible : clone si besoin, détermine racine et périmètre d'audit.
 *
 * `cleanup()` DOIT être appelé à la fin du scan — sinon chaque scan d'un dépôt
 * GitHub laisse un clone complet dans le dossier temporaire.
 */
export async function resolveTarget(
  input: string,
  options: { cwd?: string; clone?: typeof cloneRepository; locale?: Locale } = {}
): Promise<ResolvedTarget> {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const t = messages(locale).target;
  const descriptor = classifyTarget(input, options.cwd, locale);
  const warnings: string[] = [];

  if (descriptor.kind === 'directory') {
    return {
      ...descriptor,
      indexRoot: descriptor.location,
      focusFiles: null,
      cleanup: NO_CLEANUP,
      warnings,
      plain_language_summary: t.directory(descriptor.label),
    };
  }

  if (descriptor.kind === 'file') {
    // On remonte à la racine du projet pour l'indexation : sans elle, les
    // services appelés par le fichier resteraient introuvables et chaque
    // route ressortirait en « il manque du contexte ».
    const indexRoot = findProjectRoot(dirname(descriptor.location));
    const focus = relative(indexRoot, descriptor.location).split(sep).join('/');

    if (indexRoot !== dirname(descriptor.location)) {
      warnings.push(t.fileContextWarning(shortLabel(indexRoot), focus));
    }

    return {
      ...descriptor,
      indexRoot,
      focusFiles: [focus],
      cleanup: NO_CLEANUP,
      warnings,
      plain_language_summary: t.file(focus),
    };
  }

  // --- Dépôt GitHub --------------------------------------------------------
  const clone = options.clone ?? cloneRepository;
  const directory = await clone(descriptor, locale);

  return {
    ...descriptor,
    indexRoot: directory,
    focusFiles: null,
    cleanup: async () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Un clone temporaire non supprimé ne doit jamais faire échouer un
        // scan qui a, lui, réussi.
      }
    },
    warnings,
    plain_language_summary: t.github(descriptor.label),
  };
}

/**
 * Racine probable du projet contenant `start`.
 *
 * Heuristique volontairement simple : on remonte jusqu'au premier dossier
 * portant un marqueur de projet, sans jamais dépasser huit niveaux — pour ne
 * pas se retrouver à indexer tout le disque à partir d'un fichier posé dans
 * le dossier personnel.
 */
export function findProjectRoot(start: string, maxLevels = 8): string {
  const MARKERS = ['package.json', 'tsconfig.json', '.git', 'go.mod', 'pyproject.toml'];
  let current = start;

  for (let level = 0; level < maxLevels; level++) {
    if (MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

/**
 * Clone superficiel d'un dépôt public.
 *
 * `--depth 1` : on analyse un état, jamais un historique. Cloner l'historique
 * complet d'un gros dépôt pour lire ses fichiers actuels serait plusieurs
 * centaines de mégaoctets pour rien.
 */
export async function cloneRepository(
  descriptor: TargetDescriptor,
  locale: Locale = DEFAULT_LOCALE
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpipe-clone-'));
  const args = ['clone', '--depth', '1', '--single-branch', '--quiet'];
  if (descriptor.ref) args.push('--branch', descriptor.ref);
  args.push(descriptor.location, directory);

  try {
    await run('git', args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message).trim();
    throw new TargetError(
      `clone failed (${descriptor.location}): ${detail}`,
      messages(locale).target.cloneFailed(descriptor.label)
    );
  }

  return directory;
}
