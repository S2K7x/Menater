/**
 * Sélecteur de thème.
 *
 * ============================================================================
 * POURQUOI DES PASTILLES ET PAS UNE LISTE DÉROULANTE
 *
 * « Punk », « Attck », « Acme » ne décrivent rien : ce sont des noms propres.
 * Une liste déroulante de six noms propres oblige à tous les essayer pour
 * savoir lequel on veut. Chaque option montre donc sa palette — fond, accent,
 * texte — et le nom redevient une étiquette plutôt qu'une devinette.
 *
 * ============================================================================
 * LES COULEURS D'APERÇU SONT ÉCRITES ICI, ET C'EST ASSUMÉ
 *
 * C'est le SEUL endroit de l'application où une couleur est écrite en dur, et
 * pour une raison précise : un aperçu doit montrer le thème qu'on N'A PAS
 * encore appliqué. Il ne peut donc pas lire les jetons CSS, qui ne décrivent
 * que le thème courant.
 *
 * Ces trois valeurs par thème sont un extrait de `themes.css` — un test
 * vérifie qu'elles n'en divergent pas, sinon l'aperçu finirait par mentir.
 * ============================================================================
 */

import { useI18n } from '../i18n/context.tsx';
import { Icon } from '../components/Icon.tsx';
import { THEMES, useTheme } from './context.tsx';
import { THEME_SWATCHES } from './swatches.ts';

/**
 * Re-exported for the callers that already import it from here. The values
 * themselves live in `swatches.ts` — see that file for why.
 */
export { THEME_SWATCHES } from './swatches.ts';

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const { c } = useI18n();
  const t = c.theme;

  return (
    <div className="soc-field">
      <span>{t.label}</span>
      <div className="soc-theme-grid" role="radiogroup" aria-label={t.label}>
        {THEMES.map((id) => {
          const swatch = THEME_SWATCHES[id];
          const isActive = id === theme;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={isActive}
              className={`soc-theme-card ${isActive ? 'soc-theme-card-active' : ''}`}
              onClick={() => setTheme(id)}
            >
              {/* L'aperçu ne dépend PAS des jetons courants : il montre une
                  palette qu'on n'a pas encore appliquée. */}
              <span
                className="soc-theme-swatch"
                style={{ background: swatch.bg, borderColor: swatch.accent }}
                aria-hidden="true"
              >
                <span className="soc-theme-dot" style={{ background: swatch.accent }} />
                <span className="soc-theme-bar" style={{ background: swatch.fg }} />
                <span className="soc-theme-bar soc-theme-bar-short" style={{ background: swatch.fg }} />
              </span>
              <span className="soc-theme-text">
                <span className="soc-theme-name">{t.names[id]}</span>
                <span className="soc-theme-hint">{t.hints[id]}</span>
              </span>
              {isActive ? (
                <span className="soc-theme-check" aria-hidden="true">
                  <Icon name="check" size={13} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
        {t.help}
      </span>
    </div>
  );
}
