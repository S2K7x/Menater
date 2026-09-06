/**
 * Onglet « Code » — l'analyse de vulnérabilités de la console.
 *
 * ============================================================================
 * CE QUI RESTE ICI, ET CE QUI EST PARTI AILLEURS
 *
 * L'écran ne fait plus qu'UNE chose : lancer une analyse et en montrer le
 * résultat. C'est le seul geste pour lequel on vient ici.
 *
 *   - la page de présentation du produit → onglet Guide, avec la
 *     documentation de toutes les autres fonctionnalités. Une plaquette
 *     commerciale au milieu d'une console d'exploitation n'avait plus de sens
 *     une fois l'outil intégré : personne n'a besoin d'être convaincu deux
 *     fois ;
 *   - les réglages (moteurs d'IA, défauts du lanceur) → onglet Réglages, avec
 *     tous les autres réglages. Deux pages de réglages dans une application,
 *     c'est une page de trop et une chance sur deux de chercher au mauvais
 *     endroit ;
 *   - le sélecteur de langue → en-tête, où il vaut pour l'écran entier.
 *
 * Il ne reste donc aucune barre d'onglets interne. Un onglet dans un onglet
 * est exactement le genre de structure qui fait perdre quelqu'un qui découvre
 * l'outil.
 *
 * ============================================================================
 * LE RAIL D'ÉTAPES N'EST PAS UNE DÉCORATION
 *
 * Il affiche la pipeline réelle et surligne l'étape en cours pendant un scan.
 * C'est le même objet qui sert de promesse avant le lancement et de repère
 * pendant l'attente : quelqu'un qui a lu « 03 — Seconde relecture » en
 * arrivant sait où il en est quand la vignette s'allume vingt secondes plus
 * tard.
 * ============================================================================
 */

import { useEffect } from 'react';

import { ScanLauncher } from './components/ScanLauncher.tsx';
import { EstimatePanel } from './components/EstimatePanel.tsx';
import { LiveActivity } from './components/LiveActivity.tsx';
import { ScanTimeline } from './components/ScanTimeline.tsx';
import { ReportView } from './components/ReportView.tsx';
import { UsagePanel } from './components/UsagePanel.tsx';
import { PipelineExplainer } from './components/PipelineExplainer.tsx';
import { useScan } from './lib/useScan.ts';
import { usePreferences } from './lib/preferences.ts';
import { Icon } from './components/Icon.tsx';
import { useI18n } from '../i18n/context.tsx';
import { stepTranslations, STEP_ORDER, type StepName } from './lib/step_translations.ts';

/**
 * Rail des étapes de la pipeline.
 *
 * Les quatre étapes montrées sont celles qui parlent à quelqu'un qui ne code
 * pas ; les sept de la timeline restent disponibles plus bas.
 */
function StepRail({ currentStep }: { currentStep: StepName | null }) {
  const { locale } = useI18n();
  const translations = stepTranslations(locale);
  const shown: StepName[] = ['indexing', 'detection', 'master_review', 'report'];
  const currentIndex = currentStep ? STEP_ORDER.indexOf(currentStep) : -1;

  return (
    <div className="vp-steprail">
      {shown.map((step, index) => {
        const isCurrent = currentStep === step;
        const isDone = currentIndex > STEP_ORDER.indexOf(step);
        return (
          <div
            key={step}
            className={`vp-steprail-item${isCurrent ? ' vp-current' : ''}${isDone ? ' vp-done' : ''}`}
          >
            <span className="vp-steprail-icon">
              <Icon name={translations[step].icon} size={18} />
            </span>
            <span className="vp-steprail-label">{translations[step].label}</span>
            <span className="vp-steprail-num">{String(index + 1).padStart(2, '0')}</span>
          </div>
        );
      })}
    </div>
  );
}

export function VulnPipeSection() {
  const { state, estimate, confirm, cancelEstimate, reset } = useScan();
  const { t, c } = useI18n();
  const { preferences, update } = usePreferences();

  /**
   * Acceptation automatique d'un devis négligeable.
   *
   * Seulement si l'utilisateur a lui-même posé un plafond dans les réglages
   * (0 par défaut, donc désactivé), et seulement quand le coût HAUT de la
   * fourchette passe sous ce plafond : accepter sur l'estimation basse
   * reviendrait à dépenser plus que le montant annoncé comme négligeable.
   *
   * Un devis non chiffrable n'est jamais accepté tout seul : « inconnu » ne
   * veut pas dire « petit ».
   */
  useEffect(() => {
    if (state.phase !== 'estimated' || !state.estimate) return;
    const ceiling = preferences.autoConfirmUnderUsd;
    if (ceiling <= 0) return;
    const { usd, free } = state.estimate.cost;
    const high = free ? 0 : usd?.high;
    if (high === undefined || high === null) return;
    if (high < ceiling) void confirm();
  }, [state.phase, state.estimate, preferences.autoConfirmUnderUsd, confirm]);

  const running = state.phase === 'running';
  const busy = running || state.phase === 'estimating';
  const report = state.snapshot?.report ?? null;
  const usage = state.snapshot?.usage ?? null;
  // `interrupted` est terminal au même titre que `done` et `failed` : l'omettre
  // laisserait la timeline masquée et aucun bouton pour relancer — un écran
  // figé sur un scan que plus personne n'exécute.
  const settled = state.phase === 'done' || state.phase === 'failed' || state.phase === 'interrupted';
  const showLive = running || settled;

  return (
    <div className="vp-embed">
      {/* Le titre et l'explication sont portes par l'en-tete d'onglet, commun a
          toute la console : les repeter ici donnait deux titres empiles. Ne
          reste que le rail, qui n'est pas decoratif — il sert de promesse avant
          le lancement et de reperage pendant. */}
      <section className="vp-hero vp-hero-rail">
        <StepRail currentStep={state.currentStep} />
      </section>

      {(state.phase === 'idle' || state.phase === 'estimating') && (
        <>
          <ScanLauncher
            onLaunch={(input) => {
              if (preferences.rememberTarget) update({ lastTarget: input.target });
              estimate(input);
            }}
            busy={busy}
            defaultPath={preferences.rememberTarget ? preferences.lastTarget : ''}
            defaultKind={preferences.defaultKind}
            defaultMode={preferences.defaultMode}
          />
          {state.phase === 'estimating' && (
            <p className="vp-banner vp-banner-info" role="status">
              {t.estimate.estimating}
            </p>
          )}
          <PipelineExplainer />
          <p className="vp-section-note">
            {c.code.docsHint} · {c.code.settingsHint}
          </p>
        </>
      )}

      {state.error && (
        <p className="vp-banner vp-banner-error" role="alert">
          {state.error}
        </p>
      )}

      {state.phase === 'estimated' && state.estimate && (
        <EstimatePanel
          estimate={state.estimate}
          onConfirm={() => void confirm()}
          onCancel={cancelEstimate}
        />
      )}

      {showLive && state.runId && (
        <>
          <LiveActivity
            events={state.events}
            currentStep={state.currentStep}
            running={running}
            expectedRoutes={state.estimate?.routes_selected ?? null}
          />
          <section className="vp-progress-section">
            {/* Le sur-titre affichait EXACTEMENT la meme chaine que le titre
                pendant un scan — « les grandes etapes » deux fois, l'une
                au-dessus de l'autre. Un mot repete ne nomme rien, il oblige a
                verifier que ce sont bien deux choses differentes. */}
            <h2>{running ? t.timeline.heading : t.timeline.headingDone}</h2>
            <ScanTimeline
              events={state.events}
              showTechnicalDetail
              showExplanations
              openExplanations={preferences.explanationsByDefault}
              currentStep={state.currentStep}
            />
          </section>
        </>
      )}

      {running && <PipelineExplainer currentStep={state.currentStep ?? undefined} />}

      {report && (
        <ReportView
          report={report}
          target={state.snapshot?.target ?? null}
          /*
            La couverture vient du snapshot, pas du rapport : c'est le moteur
            qui sait combien d'adresses il a lues et combien lui ont echappe.
            Chaque champ reste nullable jusqu'ici — un scan qui n'a pas dit ce
            qu'il a couvert ne doit pas se voir attribuer une couverture.
          */
          coverage={{
            mode: state.snapshot?.effective_mode ?? null,
            filesIndexed: state.snapshot?.estimate?.target.files_indexed ?? null,
            routesFound: state.snapshot?.estimate?.target.routes_found ?? null,
            routesAnalyzed: state.snapshot?.routes_analyzed ?? null,
            routesFailed: state.snapshot?.routes_failed ?? null,
          }}
        />
      )}
      {usage && <UsagePanel usage={usage} />}

      {settled && (
        <button type="button" className="vp-secondary" onClick={reset}>
          {t.restart}
        </button>
      )}
    </div>
  );
}

/**
 * Les réglages de l'analyse de code, montés dans l'onglet Réglages.
 *
 * Ils chargent eux-mêmes la liste des moteurs disponibles : les faire
 * descendre depuis l'onglet Code aurait obligé à monter cet onglet pour
 * pouvoir régler quoi que ce soit.
 */
export { VulnPipeSettings } from './components/SettingsPage.tsx';
