/**
 * Explication de la pipeline, pour quelqu'un qui ne code pas.
 *
 * C'est la pièce qui manquait : la timeline dit CE QUI se passe, pas POURQUOI.
 * Un utilisateur non technique qui voit défiler « Mise en relation » sans
 * comprendre à quoi ça sert n'a aucune raison de faire confiance au verdict
 * final. Chaque étape est donc accompagnée de son utilité et d'une analogie
 * du quotidien.
 *
 * Deux usages :
 *  - `variant="overview"` : avant le scan, pour montrer le déroulé complet.
 *  - `variant="inline"`   : pendant le scan, replié sous l'étape en cours.
 */

import { useState } from 'react';

import { STEP_ORDER, stepTranslations, type StepName } from '../lib/step_translations.ts';
import { useI18n } from '../../i18n/context.tsx';
import { Fold } from '../../components/Guidance.tsx';
import { Icon } from './Icon.tsx';

export function StepExplanation({ step }: { step: StepName }) {
  const { locale } = useI18n();
  const translation = stepTranslations(locale)[step];
  if (!translation) return null;
  return (
    <div className="vp-explain">
      <p className="vp-explain-why">{translation.why}</p>
      <p className="vp-explain-analogy">
        <Icon name="bulb" size={15} />
        {translation.analogy}
      </p>
    </div>
  );
}

/**
 * Bouton « à quoi ça sert ? » replié, à glisser sous une étape.
 *
 * `defaultOpen` sert la préférence de lecture : quelqu'un qui a demandé dans
 * les réglages à voir les explications les voit d'emblée, sans avoir à
 * déplier sept fois à chaque scan.
 */
export function StepExplanationToggle({ step, defaultOpen = false }: { step: StepName; defaultOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="vp-explain-inline">
      <button type="button" className="vp-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? t.explainer.hide : t.explainer.show}
      </button>
      {open && <StepExplanation step={step} />}
    </div>
  );
}

/**
 * Les sept etapes, repliees.
 *
 * ============================================================================
 * CE QUE CE REPLI CORRIGE
 *
 * Les sept explications etaient toutes ouvertes : sous le lanceur — la seule
 * chose pour laquelle on vient sur cet ecran — s'etendaient QUATORZE
 * paragraphes, sept « a quoi ca sert » et sept analogies. Mille quatre cents
 * pixels de texte qu'on lit une fois dans sa vie, entre le bouton qu'on vient
 * cliquer et le rapport qu'on vient lire.
 *
 * Le titre de chaque etape reste ecrit : c'est LUI la promesse — « on lit
 * votre code, on cherche des trous, une seconde intelligence relit ». Ce qui
 * se replie, c'est la justification de chacune. Sept lignes au lieu de
 * quatorze paragraphes, et rien de supprime.
 *
 * ET PENDANT UN SCAN, L'ETAPE EN COURS S'OUVRE TOUTE SEULE. C'est le moment
 * exact ou l'explication sert : quelqu'un qui regarde « Mise en relation »
 * defiler sans savoir a quoi ca sert n'a aucune raison de croire le verdict
 * qui arrivera apres.
 * ============================================================================
 */
export function PipelineExplainer({ currentStep }: { currentStep?: StepName }) {
  const { locale, t } = useI18n();
  return (
    <section className="vp-pipeline-explainer" aria-label={t.explainer.title}>
      <h2>{t.explainer.intro}</h2>
      <p className="vp-pipeline-intro">{t.explainer.lede}</p>

      <ol className="vp-pipeline-steps">
        {STEP_ORDER.map((step, index) => {
          const translation = stepTranslations(locale)[step];
          const isCurrent = currentStep === step;
          return (
            <li key={step} className={isCurrent ? 'vp-pipeline-step vp-current' : 'vp-pipeline-step'}>
              <Fold
                defaultOpen={isCurrent}
                hint={isCurrent ? undefined : t.explainer.show}
                title={
                  <span className="vp-pipeline-head">
                    <span className="vp-pipeline-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="vp-step-icon">
                      <Icon name={translation.icon} size={18} />
                    </span>
                    <strong>{translation.label}</strong>
                    {isCurrent && <span className="vp-pipeline-now">{t.explainer.now}</span>}
                  </span>
                }
              >
                <StepExplanation step={step} />
              </Fold>
            </li>
          );
        })}
      </ol>

      {/*
        Le modele economique : c'est la promesse n°1 du produit, elle merite
        d'etre dite a l'utilisateur, pas seulement codee. Le TITRE la dit en
        entier — « pourquoi ca ne coute presque rien » — et c'est lui qui
        reste a l'ecran ; le paragraphe qui la justifie se deplie pour qui
        veut verifier qu'elle tient.
      */}
      <aside className="vp-pipeline-cost">
        <Fold title={t.explainer.costTitle}>
          <p>{t.explainer.costBody}</p>
        </Fold>
      </aside>
    </section>
  );
}
