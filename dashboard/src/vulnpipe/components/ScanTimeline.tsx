/**
 * Timeline de progression, en langage humain.
 *
 * Aucune chaîne technique n'est affichée : tout passe par
 * `step_translations.ts`. Le détail brut (nom de node, message d'erreur) n'est
 * visible que derrière un dépliant explicitement libellé.
 */

import { useMemo, useState } from 'react';

import {
  STEP_ORDER,
  stepTranslations,
  translateStep,
  type StepName,
  type StepStatus,
} from '../lib/step_translations.ts';
import { useI18n } from '../../i18n/context.tsx';
import { StepExplanationToggle } from './PipelineExplainer.tsx';
import { Icon, type IconName } from './Icon.tsx';

export interface StepEvent {
  run_id: string;
  seq: number;
  step: StepName;
  status: StepStatus;
  plain_language: string;
  at: string;
  detail?: string;
  progress?: { done: number; total: number };
  /** Adresse concernée, quand l'événement en vise une. */
  route?: { http_method: string; route: string };
  /** Verdict rendu sur cette adresse. */
  verdict?: {
    vulnerability: string;
    confidence_score: number;
    zone: 'sain' | 'a_verifier' | 'alerte';
    /** true si rien n'a été facturé pour ce verdict. */
    free: boolean;
    /**
     * true si la gratuité vient du cache — verdict déjà rendu sur exactement
     * ce code — et non des règles déterministes. Deux gratuités, deux
     * phrases : les confondre ferait croire à une couverture qu'on n'a pas.
     */
    cached?: boolean;
    plain_language_summary: string;
  };
  /** Consommation cumulée à l'instant de l'événement. */
  usage?: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cost_usd: number | null;
    elapsed_ms: number;
  };
}

export interface ScanTimelineProps {
  events: StepEvent[];
  /** Affiche le détail technique (repliable). Faux par défaut. */
  showTechnicalDetail?: boolean;
  /**
   * Ajoute sous chaque étape un « à quoi ça sert ? » replié.
   *
   * C'est ce qui distingue une barre de progression d'une explication : sans
   * ça, un utilisateur non technique voit défiler des étiquettes sans savoir
   * ce qui est vérifié ni pourquoi.
   */
  showExplanations?: boolean;
  /** Déplie d'emblée ces explications (préférence de lecture). */
  openExplanations?: boolean;
  /** Étape en cours, mise en avant visuellement. */
  currentStep?: StepName | null;
}

interface StepState {
  step: StepName;
  status: StepStatus | 'pending';
  message: string;
  progress?: { done: number; total: number };
  details: string[];
}

/**
 * Réduit le flux d'événements à un état par étape.
 *
 * Trié sur `seq`, jamais sur l'ordre d'arrivée : les nodes publient en
 * parallèle et rien ne garantit que la file les livre dans l'ordre.
 *
 * Un `failed` ne peut jamais être écrasé par un `done` ultérieur — sinon une
 * étape partiellement en échec s'afficherait comme réussie, et l'utilisateur
 * croirait à une couverture complète.
 */
export function reduceEvents(events: StepEvent[]): StepState[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const byStep = new Map<StepName, StepState>();

  for (const event of ordered) {
    const current = byStep.get(event.step);
    const failedBefore = current?.status === 'failed';

    // Les verdicts par adresse et les compteurs de consommation passent en
    // continu : les laisser écraser le message d'étape ferait clignoter la
    // timeline au rythme du réseau. Leur place est dans le suivi en direct.
    if ((event.verdict || event.usage) && current) {
      byStep.set(event.step, { ...current, progress: event.progress ?? current.progress });
      continue;
    }

    byStep.set(event.step, {
      step: event.step,
      status: failedBefore && event.status === 'done' ? 'failed' : event.status,
      message: failedBefore && event.status === 'done' ? current!.message : event.plain_language,
      progress: event.progress ?? current?.progress,
      details: event.detail ? [...(current?.details ?? []), event.detail] : (current?.details ?? []),
    });
  }

  return STEP_ORDER.filter((step) => byStep.has(step)).map((step) => byStep.get(step)!);
}

/**
 * Pastille d'état d'une étape.
 *
 * C'est le seul endroit de la timeline où l'icône porte l'information SEULE :
 * le libellé à côté nomme l'étape, pas son issue. Elle est donc annoncée
 * (`title`), contrairement aux icônes décoratives du reste de l'écran.
 */
function StatusIcon({ status }: { status: StepState['status'] }) {
  const { t } = useI18n();
  const map: Record<string, { icon: IconName; label: string }> = {
    running: { icon: 'clock', label: t.timeline.statusRunning },
    done: { icon: 'check', label: t.timeline.statusDone },
    failed: { icon: 'warning', label: t.timeline.statusFailed },
    skipped: { icon: 'skip', label: t.timeline.statusSkipped },
    pending: { icon: 'dot', label: t.timeline.statusPending },
  };
  const entry = map[status] ?? map.pending!;
  return (
    <span className="vp-status">
      <Icon name={entry.icon} size={17} title={entry.label} />
    </span>
  );
}

export function ScanTimeline({
  events,
  showTechnicalDetail = false,
  showExplanations = false,
  openExplanations = false,
  currentStep = null,
}: ScanTimelineProps) {
  const { locale, t } = useI18n();
  const translations = stepTranslations(locale);
  const steps = useMemo(() => reduceEvents(events), [events]);
  const [openDetails, setOpenDetails] = useState<Set<StepName>>(new Set());

  if (steps.length === 0) return <p className="vp-timeline-empty">{t.timeline.empty}</p>;

  const toggle = (step: StepName) => {
    setOpenDetails((previous) => {
      const next = new Set(previous);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  };

  return (
    <ol className="vp-timeline" aria-label={t.timeline.heading}>
      {steps.map((state) => {
        const translation = translations[state.step];
        const isOpen = openDetails.has(state.step);
        const isCurrent = currentStep === state.step;
        return (
          <li
            key={state.step}
            className={`vp-timeline-step vp-${state.status}${isCurrent ? ' vp-current' : ''}`}
          >
            <div className="vp-timeline-head">
              <StatusIcon status={state.status} />
              <span className="vp-step-icon">
                <Icon name={translation.icon} size={17} />
              </span>
              <strong className="vp-step-label">{translation.label}</strong>
            </div>

            {/* Le message du serveur prime ; la table de traduction sert de
                repli si un événement arrive sans texte. */}
            <p className="vp-step-message">
              {state.message || translateStep(state.step, state.status as StepStatus, locale)}
            </p>

            {state.progress && state.progress.total > 0 && (
              <div className="vp-progress">
                <progress value={state.progress.done} max={state.progress.total} />
                <span>
                  {t.timeline.of(state.progress.done, state.progress.total)}
                </span>
              </div>
            )}

            {showExplanations && (
              <StepExplanationToggle step={state.step} defaultOpen={openExplanations} />
            )}

            {showTechnicalDetail && state.details.length > 0 && (
              <div className="vp-step-details">
                <button type="button" onClick={() => toggle(state.step)} aria-expanded={isOpen}>
                  {isOpen ? t.timeline.hideDetail : t.timeline.showDetail}
                </button>
                {isOpen && (
                  <ul>
                    {state.details.map((detail, index) => (
                      <li key={index}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
