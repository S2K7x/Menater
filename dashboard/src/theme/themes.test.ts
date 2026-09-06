/**
 * Tests des thèmes.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT — TROIS DUPLICATIONS QUI DÉRIVENT EN SILENCE
 *
 * La palette est écrite à trois endroits, et chacun a une raison d'exister :
 *
 *   - `themes.css` : la vérité, appliquée avant le premier peint ;
 *   - `ThemePicker.tsx` : l'aperçu, qui doit montrer un thème NON appliqué et
 *     ne peut donc pas lire les jetons courants ;
 *   - `index.html` : le script d'amorçage, qui s'exécute avant tout module et
 *     ne peut donc rien importer.
 *
 * Aucune de ces trois copies ne casse bruyamment quand elle diverge. Un jeton
 * oublié dans un thème donne du texte gris clair sur fond crème — illisible,
 * mais uniquement sur l'écran concerné. Un aperçu périmé ment sans erreur. Une
 * clé de stockage désaccordée fait « oublier » le thème à chaque visite, ce
 * qui se lit comme un sélecteur cassé.
 *
 * D'où ces tests : ils comparent les trois copies entre elles.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY, type ThemeId } from './context.tsx';
import { THEME_SWATCHES } from './ThemePicker.tsx';

const root = join(import.meta.dirname, '..', '..');
const css = readFileSync(join(root, 'src', 'theme', 'themes.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** Les jetons de couleur qu'un thème DOIT définir, tous sans exception. */
const REQUIRED_TOKENS = [
  '--bg', '--surface', '--surface-2', '--panel', '--hero',
  '--fg', '--muted', '--faint',
  '--line', '--line-strong',
  '--accent', '--accent-dim', '--accent-fg',
  '--red', '--red-bg', '--orange', '--orange-bg',
  '--green', '--green-bg', '--blue', '--blue-bg', '--grey',
  '--shadow',
];

/** Extrait le bloc de déclarations d'un thème depuis la feuille de style. */
function blockFor(theme: ThemeId): string {
  // Le thème par défaut partage son bloc avec `:root`.
  const selector = theme === DEFAULT_THEME
    ? String.raw`:root,\s*\[data-theme='grayed'\]`
    : String.raw`\[data-theme='${theme}'\]`;
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`aucun bloc pour le thème « ${theme} » dans themes.css`);
  return match[1];
}

function tokensOf(theme: ThemeId): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of blockFor(theme).split('\n')) {
    const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/i);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

describe('chaque thème définit la palette entière', () => {
  it.each(THEMES)('%s', (theme) => {
    const tokens = tokensOf(theme);
    const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t));
    // Hériter un jeton du thème gris produit un accident invisible : un
    // `--faint` sombre resté sur le fond crème d'Acme, par exemple.
    expect(missing, `jetons manquants dans « ${theme} »`).toEqual([]);
  });

  it('aucun thème ne définit de jeton hors de la liste connue', () => {
    for (const theme of THEMES) {
      const extra = [...tokensOf(theme).keys()].filter((t) => !REQUIRED_TOKENS.includes(t));
      expect(extra, `jetons inattendus dans « ${theme} »`).toEqual([]);
    }
  });
});

describe('l’aperçu du sélecteur ne ment pas', () => {
  it.each(THEMES)('%s : les trois couleurs viennent bien de themes.css', (theme) => {
    const tokens = tokensOf(theme);
    const swatch = THEME_SWATCHES[theme];
    expect(swatch.bg.toLowerCase()).toBe(tokens.get('--bg'));
    expect(swatch.accent.toLowerCase()).toBe(tokens.get('--accent'));
    expect(swatch.fg.toLowerCase()).toBe(tokens.get('--fg'));
  });

  it('couvre exactement les thèmes existants, ni plus ni moins', () => {
    expect(Object.keys(THEME_SWATCHES).sort()).toEqual([...THEMES].sort());
  });
});

describe('le script d’amorçage reste accordé au module', () => {
  it('utilise la même clé de stockage', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('connaît exactement la même liste de thèmes', () => {
    const list = html.match(/\[((?:\s*'[a-z]+',?)+)\]\.indexOf\(t\)/);
    expect(list, 'liste des thèmes introuvable dans le script d’amorçage').toBeTruthy();
    const parsed = [...list![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(parsed).toEqual([...THEMES]);
  });

  it('retombe sur le thème par défaut, pas sur une valeur inventée', () => {
    expect(html).toContain(`t = '${DEFAULT_THEME}'`);
  });
});

describe('lisibilité', () => {
  /** Luminance relative WCAG d'une couleur `#rrggbb`. */
  function luminance(hex: string): number {
    const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each(THEMES)('%s : le texte reste lisible sur le fond', (theme) => {
    const t = tokensOf(theme);
    // 4.5 est le seuil WCAG AA pour du texte courant.
    expect(ratio(t.get('--fg')!, t.get('--bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t.get('--fg')!, t.get('--surface')!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s : le texte reste lisible sur la surface EN CREUX', (theme) => {
    const t = tokensOf(theme);
    // DÉFAUT RÉEL, ATTRAPÉ TROP TARD. `--hero` était décrit comme « le fond le
    // plus contrasté », donc posé en quasi-noir sur le thème clair — où il
    // valait exactement `--fg`. Contraste 1,00:1, à huit endroits de
    // l'application, tous invisibles à la relecture du CSS.
    expect(ratio(t.get('--fg')!, t.get('--hero')!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s : le texte posé sur l’accent reste lisible', (theme) => {
    const t = tokensOf(theme);
    // C'EST LE PIÈGE DES THÈMES : `--accent-fg` suit le contraste de l'accent,
    // pas celui du fond. Un accent jaune vif avec un `--accent-fg` blanc hérité
    // du thème sombre donne un bouton dont on ne lit plus le libellé.
    // 4.5 aussi : ces libellés sont de petites capitales, pas des titres.
    expect(ratio(t.get('--accent-fg')!, t.get('--accent')!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s : la palette de RISQUE reste lisible sur les panneaux', (theme) => {
    const t = tokensOf(theme);
    // LE TEST LE PLUS IMPORTANT DU FICHIER.
    //
    // Le rouge dit « critique ou échec », l'orange « à regarder », le vert
    // « traité ». Un analyste qui balaie quarante lignes se fie à la couleur
    // avant de lire le texte. Une palette transposée telle quelle depuis une
    // affiche donne des pastels ravissants et illisibles : le rouge d'échec
    // d'Attck était tombé à 2,5:1 sur son propre fond de panneau — sur
    // l'écran qui en dépend le plus.
    for (const role of ['--red', '--orange', '--green', '--blue'] as const) {
      expect(ratio(t.get(role)!, t.get('--surface')!), `${role} sur --surface`)
        .toBeGreaterThanOrEqual(4.5);
      // Chaque couleur sert aussi de texte DANS sa propre pastille.
      expect(ratio(t.get(role)!, t.get(`${role}-bg`)!), `${role} sur ${role}-bg`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s : le texte secondaire reste lisible sur les panneaux', (theme) => {
    const t = tokensOf(theme);
    expect(ratio(t.get('--muted')!, t.get('--surface')!)).toBeGreaterThanOrEqual(4.5);
    // `--grey` et `--faint` portent des mentions accessoires : seuil des
    // grands textes, 3:1. En dessous, l'information cesse d'être consultable.
    expect(ratio(t.get('--grey')!, t.get('--surface')!)).toBeGreaterThanOrEqual(3);
    expect(ratio(t.get('--faint')!, t.get('--surface')!)).toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES)('%s : le texte discret reste au-dessus du seuil des grands textes', (theme) => {
    const t = tokensOf(theme);
    // `--faint` sert aux mentions secondaires. 3:1 est le seuil AA des textes
    // de grande taille ; en dessous, l'information cesse d'être consultable
    // pour une partie des utilisateurs.
    expect(ratio(t.get('--faint')!, t.get('--bg')!)).toBeGreaterThanOrEqual(3);
  });
});
