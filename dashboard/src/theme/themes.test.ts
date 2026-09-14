/**
 * Tests des thèmes.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT — TROIS DUPLICATIONS QUI DÉRIVENT EN SILENCE
 *
 * La palette est écrite à quatre endroits, et chacun a une raison d'exister :
 *
 *   - `themes.css` : la vérité, appliquée avant le premier peint ;
 *   - `ThemePicker.tsx` : l'aperçu, qui doit montrer un thème NON appliqué et
 *     ne peut donc pas lire les jetons courants ;
 *   - `index.html` : le script d'amorçage, qui s'exécute avant tout module et
 *     ne peut donc rien importer ;
 *   - `site/shared.css` : le site de présentation, hors du paquet, qui rejoue
 *     les six palettes jeton pour jeton et n'a aucune suite à lui.
 *
 * Aucune de ces copies ne casse bruyamment quand elle diverge. Un jeton
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

/**
 * La QUATRIÈME copie de la palette : le site de présentation.
 *
 * `site/shared.css` réécrit les six palettes jeton pour jeton, et son propre
 * commentaire dit pourquoi : « cette palette est celle de la console, jeton
 * pour jeton — en retirer un ici les ferait diverger ». Rien ne vérifiait cette
 * phrase. Elle est vérifiée ici, parce que le site est hors du paquet et n'a
 * donc aucune suite à lui : un jeton ajouté d'un seul côté est exactement la
 * dérive silencieuse que ce fichier existe pour attraper.
 */
const siteCss = readFileSync(join(root, '..', 'site', 'shared.css'), 'utf8');

/** Every sheet that draws a focus indicator: both halves, and the site. */
const SHEETS = [
  ['src/styles.css', readFileSync(join(root, 'src', 'styles.css'), 'utf8')],
  ['src/vulnpipe/styles.css', readFileSync(join(root, 'src', 'vulnpipe', 'styles.css'), 'utf8')],
  ['site/shared.css', siteCss],
] as const;

/** Les jetons de couleur qu'un thème DOIT définir, tous sans exception. */
const REQUIRED_TOKENS = [
  '--bg', '--surface', '--surface-2', '--panel', '--hero',
  '--fg', '--muted', '--faint',
  '--line', '--line-strong',
  '--accent', '--accent-dim', '--accent-fg',
  // The focus ring. Its own token because it is NOT the accent: on two themes
  // the accent cannot be seen where a ring is drawn. See the contrast test.
  '--focus',
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

describe('le site de présentation porte la MÊME palette', () => {
  /** Les déclarations d'une palette du site (`[data-palette='x']`). */
  function siteTokensOf(theme: ThemeId): Map<string, string> {
    const selector = theme === DEFAULT_THEME
      ? String.raw`:root,\s*\[data-palette='grayed'\]`
      : String.raw`\[data-palette='${theme}'\]`;
    const match = siteCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`aucune palette « ${theme} » dans site/shared.css`);
    const out = new Map<string, string>();
    for (const m of match[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      out.set(m[1], m[2].trim());
    }
    return out;
  }

  it.each(THEMES)('%s : jeton pour jeton', (theme) => {
    const site = siteTokensOf(theme);
    for (const token of REQUIRED_TOKENS) {
      // Comparaison sur la VALEUR, pas sur la frappe : `--shadow` s'écrit
      // `rgba(0,0,0,.55)` ici et `rgba(0, 0, 0, 0.55)` là. Espaces retirés,
      // zéro de tête d'une décimale retiré — deux façons d'écrire la même
      // couleur ne sont pas une dérive de palette.
      const strip = (v: string | undefined) =>
        v?.replace(/\s+/g, '').replace(/\b0\./g, '.').toLowerCase();
      expect(strip(site.get(token)), `${token} dans « ${theme} »`)
        .toBe(strip(tokensOf(theme).get(token)));
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

/** Luminance relative WCAG d'une couleur `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapport de contraste WCAG entre deux couleurs `#rrggbb`. */
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('lisibilité', () => {
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

/* ==========================================================================
 * L'ANNEAU DE MISE AU POINT
 * ========================================================================== */

/**
 * Le seul repère de quelqu'un qui navigue au clavier, et la seule couleur du
 * produit dont personne ne mesurait le contraste.
 *
 * ============================================================================
 * LE DÉFAUT QUE CECI CORRIGE
 *
 * Les treize règles qui dessinent une mise au point — les quatre champs de la
 * console, les cinq `<summary>`, les contrôles de VulnPipe — la dessinaient
 * toutes en `var(--accent)`. Mesuré sur les six palettes, l'accent passe sous
 * le plancher WCAG 1.4.11 (3:1 pour un élément d'interface) sur DEUX d'entre
 * elles :
 *
 *   punk : 1,24:1 contre `--line`, 1,61 sur `--surface`, 2,58 sur `--hero`
 *   dark : 2,75:1 contre `--line`, 2,91 sur `--surface-2`
 *
 * Sur punk, l'accent est un rouge sombre (#c31f1b) posé sur du kaki : tabuler
 * dans un champ ne changeait rien de visible — et les quatre champs de la
 * console SUPPRIMENT en plus l'anneau du navigateur (`outline: none`), donc il
 * n'y avait pas de repli.
 *
 * `--focus` est un RÔLE, comme `--accent-fg` : sa valeur suit le contraste des
 * surfaces sur lesquelles l'anneau est dessiné, pas l'identité du thème. Quatre
 * thèmes gardent leur accent, qui mesure bien ; punk et dark prennent leur
 * couleur de texte.
 * ============================================================================
 */
describe('l’anneau de mise au point se voit sur les six palettes', () => {
  // Les surfaces sur lesquelles un anneau peut atterrir, plus la bordure qu'il
  // remplace sur les champs de saisie : c'est CE CHANGEMENT qui doit se voir.
  const BEHIND = ['--bg', '--surface', '--surface-2', '--panel', '--hero', '--line'] as const;

  it.each(THEMES)('%s : `--focus` tient le seuil des éléments d’interface', (theme) => {
    const t = tokensOf(theme);
    for (const behind of BEHIND) {
      // 3:1 — WCAG 1.4.11, le seuil des éléments non textuels. Un anneau est
      // exactement ça : une information portée par la seule couleur.
      expect(ratio(t.get('--focus')!, t.get(behind)!), `--focus sur ${behind}`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  /**
   * Et la règle est écrite ici, pas seulement appliquée : l'accent est réservé
   * à « quelque chose attend un humain » (règle 4 de `styles.css`), et sur deux
   * thèmes il ne se voit pas. Une quatorzième règle écrite en `var(--accent)`
   * repasserait sous le plancher sans que rien ne casse.
   */
  it('aucune règle de mise au point ne dessine en `var(--accent)`', () => {
    const offenders: string[] = [];
    for (const [name, sheet] of SHEETS) {
      // Chaque bloc `sélecteur { déclarations }` de la feuille.
      for (const m of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selector = m[1];
        if (!selector.includes(':focus')) continue;
        if (!m[2].includes('var(--accent)')) continue;
        offenders.push(`${name} — ${selector.trim().split('\n').pop()!.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
