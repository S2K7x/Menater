/**
 * Résolution de la cible : dossier, fichier seul, dépôt GitHub.
 *
 * Le clone réel n'est jamais fait ici — sauf sur un dépôt local créé pour
 * l'occasion. Un test qui dépend du réseau échoue dans le train.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyTarget, cloneRepository, findProjectRoot, resolveTarget, TargetError } from './scan-target.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vulnpipe-target-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('classifyTarget', () => {
  it('reconnaît un dossier existant', () => {
    const dir = tempDir();
    expect(classifyTarget(dir).kind).toBe('directory');
  });

  it('reconnaît un fichier existant', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
    expect(classifyTarget(join(dir, 'a.ts')).kind).toBe('file');
  });

  it.each([
    ['https://github.com/moi/projet', 'moi', 'projet', undefined],
    ['https://github.com/moi/projet.git', 'moi', 'projet', undefined],
    ['github.com/moi/projet', 'moi', 'projet', undefined],
    ['https://github.com/moi/projet/tree/dev', 'moi', 'projet', 'dev'],
    ['git@github.com:moi/projet.git', 'moi', 'projet', undefined],
    ['moi/projet#dev', 'moi', 'projet', 'dev'],
  ])('reconnaît %s comme un dépôt GitHub', (input, owner, repo, ref) => {
    const descriptor = classifyTarget(input);
    expect(descriptor.kind).toBe('github');
    expect(descriptor.owner).toBe(owner);
    expect(descriptor.repo).toBe(repo);
    expect(descriptor.ref).toBe(ref);
  });

  it('préfère le disque à la forme owner/repo', () => {
    // `src/api` ressemble exactement à un dépôt GitHub. S'il existe sur le
    // disque, c'est lui que l'utilisateur veut — pas un clone au hasard.
    const dir = tempDir();
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    expect(classifyTarget('src/api', dir).kind).toBe('directory');
  });

  it("explique en français ce qu'il n'a pas compris", () => {
    try {
      classifyTarget('chemin/qui/nexiste/pas/du/tout');
      expect.unreachable('aurait dû lever');
    } catch (error) {
      expect(error).toBeInstanceOf(TargetError);
      expect((error as TargetError).plainLanguageSummary).toContain('GitHub');
      expect((error as TargetError).plainLanguageSummary).not.toContain('ENOENT');
    }
  });

  it('refuse une cible vide en expliquant les formes acceptées', () => {
    expect(() => classifyTarget('   ')).toThrow(TargetError);
  });
});

describe('findProjectRoot', () => {
  it('remonte jusqu\'au marqueur de projet', () => {
    const root = tempDir();
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'src', 'modules'), { recursive: true });
    expect(findProjectRoot(join(root, 'src', 'modules'))).toBe(root);
  });

  it("s'arrête au bout de quelques niveaux plutôt que d'indexer le disque", () => {
    const root = tempDir();
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    // Aucun marqueur nulle part : on ne remonte pas jusqu'à la racine du disque.
    expect(findProjectRoot(deep, 2)).toBe(deep);
  });
});

describe('resolveTarget', () => {
  it("sur un fichier seul, indexe le projet mais n'audite que ce fichier", async () => {
    const root = tempDir();
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'orders.controller.ts'), 'export class A {}');

    const resolved = await resolveTarget(join(root, 'src', 'orders.controller.ts'));

    expect(resolved.kind).toBe('file');
    expect(resolved.indexRoot).toBe(root);
    expect(resolved.focusFiles).toEqual(['src/orders.controller.ts']);
    // Le contexte élargi doit être annoncé : sinon l'utilisateur croit qu'on a
    // audité tout ce qu'on a lu.
    expect(resolved.warnings.join(' ')).toContain('audited');
  });

  it('sur un dossier, audite tout et ne nettoie rien', async () => {
    const dir = tempDir();
    const resolved = await resolveTarget(dir);
    expect(resolved.focusFiles).toBeNull();
    await resolved.cleanup();
    expect(existsSync(dir)).toBe(true);
  });

  it('clone un dépôt et supprime la copie au nettoyage', async () => {
    // Dépôt git local : on exerce le vrai chemin de clonage, sans réseau.
    const source = tempDir();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source });
    writeFileSync(join(source, 'a.ts'), 'export const a = 1;');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: source,
    });

    const resolved = await resolveTarget('https://github.com/moi/projet', {
      clone: async (descriptor) => cloneRepository({ ...descriptor, location: source }),
    });

    expect(resolved.kind).toBe('github');
    expect(existsSync(join(resolved.indexRoot, 'a.ts'))).toBe(true);

    const cloneDir = resolved.indexRoot;
    await resolved.cleanup();
    // Un clone qui survit à chaque scan remplit le disque en silence.
    expect(existsSync(cloneDir)).toBe(false);
  });

  it("explique en français qu'un dépôt privé n'est pas accessible", async () => {
    await expect(
      resolveTarget('https://github.com/moi/depot-qui-nexiste-pas-du-tout-12345', {
        clone: async () => {
          throw new TargetError(
            'clone impossible',
            "On n'a pas réussi à récupérer le dépôt. S'il est privé, VulnPipe n'y a pas accès."
          );
        },
      })
    ).rejects.toThrow(TargetError);
  });
});
