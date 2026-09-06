/**
 * Tests de l'extrait de code joint aux failles.
 *
 * L'enjeu n'est pas cosmétique : cet extrait est lu dans le dépôt ANALYSÉ,
 * c'est-à-dire dans de la donnée non fiable, et il finit dans un rapport et
 * dans un prompt destiné à un assistant IA. Les cas limites (chemin qui sort
 * de la racine, fichier absent, ligne hors du fichier) doivent renvoyer
 * `null`, jamais lever, jamais lire ailleurs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCodeExcerpt, CONTEXT_LINES, MAX_LINE_LENGTH } from './code-excerpt.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vulnpipe-excerpt-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'order.service.ts'),
    [
      'export class OrderService {', // 1
      '  async findById(id: string) {', // 2
      '    return this.db.orders.findOne({ id });', // 3
      '  }', // 4
      '}', // 5
    ].join('\n')
  );
  writeFileSync(join(root, 'src', 'long.ts'), `const x = "${'a'.repeat(500)}";`);
  writeFileSync(join(root, 'src', 'tabs.ts'), 'class A {\n\tmethod() {}\n}');
  // Fichier hors périmètre : sert de cible à la tentative d'évasion.
  writeFileSync(join(root, 'secret-hors-perimetre.txt'), 'CECI NE DOIT JAMAIS ETRE LU');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Extrait de code', () => {
  it('entoure la ligne en cause de son contexte', () => {
    const excerpt = readCodeExcerpt(root, 'src/order.service.ts', 3);
    expect(excerpt).not.toBeNull();
    expect(excerpt!.highlight_line).toBe(3);
    expect(excerpt!.start_line).toBe(1); // 3 - CONTEXT_LINES, borné à 1
    expect(excerpt!.lines).toHaveLength(5); // le fichier entier, il est court
    expect(excerpt!.lines[2]).toContain('findOne({ id })');
    expect(excerpt!.truncated).toBe(false);
  });

  it('ne dépasse jamais les bornes du fichier', () => {
    const first = readCodeExcerpt(root, 'src/order.service.ts', 1);
    expect(first!.start_line).toBe(1);
    expect(first!.lines[0]).toContain('export class OrderService');

    const last = readCodeExcerpt(root, 'src/order.service.ts', 5);
    expect(last!.start_line).toBe(Math.max(1, 5 - CONTEXT_LINES));
    expect(last!.lines[last!.lines.length - 1]).toBe('}');
  });

  it('REFUSE de lire un fichier hors de la racine indexée', () => {
    // Le chemin vient d'un dépôt analysé : on ne lui fait pas confiance.
    // Une remontée par `..` ne doit pas être suivie, même si le fichier
    // visé existe bel et bien.
    expect(readCodeExcerpt(join(root, 'src'), '../secret-hors-perimetre.txt', 1)).toBeNull();
    expect(readCodeExcerpt(join(root, 'src'), '../../../../etc/passwd', 1)).toBeNull();
  });

  it('renvoie null plutôt que de lever, sur un fichier ou une ligne absents', () => {
    expect(readCodeExcerpt(root, 'src/inexistant.ts', 1)).toBeNull();
    expect(readCodeExcerpt(root, 'src/order.service.ts', 9999)).toBeNull();
    expect(readCodeExcerpt(root, 'src/order.service.ts', null)).toBeNull();
    expect(readCodeExcerpt(root, 'src/order.service.ts', 0)).toBeNull();
    expect(readCodeExcerpt(root, 'src/order.service.ts', -3)).toBeNull();
  });

  it('tronque une ligne démesurée et le signale', () => {
    // Un fichier minifié ne doit pas faire gonfler le rapport ni le prompt.
    const excerpt = readCodeExcerpt(root, 'src/long.ts', 1);
    expect(excerpt!.truncated).toBe(true);
    expect(excerpt!.lines[0]!.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 1);
  });

  it('normalise les tabulations pour un affichage à largeur fixe', () => {
    const excerpt = readCodeExcerpt(root, 'src/tabs.ts', 2);
    expect(excerpt!.lines.some((l) => l.includes('\t'))).toBe(false);
    expect(excerpt!.lines[1]).toContain('  method()');
  });
});
