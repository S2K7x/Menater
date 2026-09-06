/**
 * Le devis : ce que l'analyse va coûter, AVANT de la lancer.
 *
 * ============================================================================
 * POURQUOI CET ÉCRAN EXISTE
 *
 * Lancer un scan était un chèque en blanc. Rien, dans l'interface, ne disait
 * si on s'engageait pour dix secondes gratuites ou vingt minutes facturées —
 * alors que `CLAUDE.md` §1 promet « abordable financièrement ». Une promesse
 * de prix qu'on ne peut vérifier qu'une fois payée n'en est pas une.
 *
 * Trois règles de présentation :
 *
 *  1. Le chiffre le plus important est le TEMPS, pas le prix. Sur un scan
 *     local gratuit, le prix est zéro et n'apprend rien ; c'est l'attente qui
 *     décide si on lance maintenant ou plus tard.
 *  2. Un prix inconnu s'affiche comme inconnu. Jamais « 0 $ » par défaut :
 *     l'utilisateur croirait le scan gratuit et découvrirait la facture après.
 *  3. Les hypothèses sont visibles, pas enfouies. Une estimation dont on ne
 *     voit pas les hypothèses ressemble à une garantie — et se retourne contre
 *     nous à la première fourchette dépassée.
 * ============================================================================
 */

import { useState } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import type { Dictionary } from '../../i18n/dictionary.ts';

export interface EstimateRange {
  low: number;
  high: number;
}

export interface ScanEstimate {
  target: { kind: 'directory' | 'file' | 'github'; label: string; files_indexed: number; routes_found: number };
  mode: 'full_scan' | 'incremental_scan';
  routes_selected: number;
  routes_free: number;
  routes_billed: number;
  llm_calls: { detection: number; arbitration: EstimateRange; total: EstimateRange };
  tokens: { input: number; output: EstimateRange; total: EstimateRange };
  duration_s: EstimateRange;
  cost: {
    usd: EstimateRange | null;
    free: boolean;
    unknown_reason: string | null;
  };
  sampled: boolean;
  sample_size: number;
  assumptions: string[];
  warnings: string[];
  plain_language_summary: string;
}


/**
 * Durée compacte pour une carte de chiffre.
 *
 * Volontairement plus courte que celle du serveur : « 25 s – 50 s » tient dans
 * une carte, « 25 seconds to 50 seconds » non. Les unités abrégées sont
 * identiques dans les deux langues, la fonction n'a donc pas à être traduite.
 */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(Math.round(seconds), 1)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes > 0 ? `${hours} h ${minutes}` : `${hours} h`;
}

function formatUsd(value: number, t: Dictionary): string {
  if (value === 0) return '$0';
  if (value < 0.01) return `< ${t.estimate.lessThanCent}`;
  return `$${value.toFixed(2)}`;
}

function costLine(cost: ScanEstimate['cost'], t: Dictionary): { value: string; hint: string } {
  if (cost.free) return { value: t.estimate.costFree, hint: '' };
  // Un tarif inconnu s'affiche comme inconnu : jamais « 0 $ » par défaut,
  // qui ferait croire à la gratuité quelqu'un qui va payer.
  if (!cost.usd) return { value: t.estimate.costUnknown, hint: t.estimate.costUnknownHint };
  const { low, high } = cost.usd;
  return {
    value:
      low === high
        ? formatUsd(high, t)
        : `${formatUsd(low, t)} – ${formatUsd(high, t)}`,
    hint: t.estimate.costHint,
  };
}

export interface EstimatePanelProps {
  estimate: ScanEstimate;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function EstimatePanel({ estimate, onConfirm, onCancel, busy }: EstimatePanelProps) {
  const { t } = useI18n();
  const [showDetail, setShowDetail] = useState(false);
  const cost = costLine(estimate.cost, t);
  const nothingToDo = estimate.routes_selected === 0;

  return (
    <section className="vp-estimate" aria-label={t.estimate.title}>
      <span className="vp-kicker">{t.estimate.kicker}</span>
      <h2>{t.estimate.title}</h2>

      <p className="vp-estimate-summary">{estimate.plain_language_summary}</p>

      <dl className="vp-estimate-figures">
        <div className="vp-figure vp-figure-primary">
          <dt>{t.estimate.time}</dt>
          <dd>
            {humanDuration(estimate.duration_s.low)} – {humanDuration(estimate.duration_s.high)}
          </dd>
        </div>
        <div className="vp-figure">
          <dt>{t.estimate.cost}</dt>
          <dd className={estimate.cost.usd || estimate.cost.free ? undefined : 'vp-unknown'}>
            {cost.value}
          </dd>
          <span className="vp-figure-hint">{cost.hint}</span>
        </div>
        <div className="vp-figure">
          <dt>{t.estimate.routes}</dt>
          <dd>{estimate.routes_selected}</dd>
          <span className="vp-figure-hint">
            {t.estimate.routesHint(estimate.routes_free, estimate.routes_billed)}
          </span>
        </div>
        <div className="vp-figure">
          <dt>{t.estimate.calls}</dt>
          <dd>
            {estimate.llm_calls.total.low === estimate.llm_calls.total.high
              ? estimate.llm_calls.total.high
              : `${estimate.llm_calls.total.low} – ${estimate.llm_calls.total.high}`}
          </dd>
          <span className="vp-figure-hint">{t.estimate.callsHint}</span>
        </div>
      </dl>

      <p className="vp-estimate-target">
        <strong>{t.estimate.targetKind[estimate.target.kind]}</strong> · {estimate.target.label} ·{' '}
        {t.estimate.targetLine(estimate.target.files_indexed, estimate.target.routes_found)}
        {estimate.mode === 'incremental_scan' && ` · ${t.estimate.incrementalNote}`}
      </p>

      {estimate.cost.unknown_reason && (
        <p className="vp-banner vp-banner-info">{estimate.cost.unknown_reason}</p>
      )}

      {estimate.warnings.map((warning, index) => (
        <p key={index} className="vp-banner vp-banner-warn" role="status">
          {warning}
        </p>
      ))}

      <div className="vp-estimate-detail">
        <button type="button" onClick={() => setShowDetail(!showDetail)} aria-expanded={showDetail}>
          {showDetail ? t.estimate.detailHide : t.estimate.detailShow}
        </button>
        {showDetail && (
          <div>
            <p className="vp-field-help">
              {t.estimate.detailIntro}
              {estimate.sampled && t.estimate.detailSampled(estimate.sample_size)}
            </p>
            <ul className="vp-assumptions">
              {estimate.assumptions.map((assumption, index) => (
                <li key={index}>{assumption}</li>
              ))}
              <li>{t.estimate.volume(Math.round(estimate.tokens.total.high / 1000))}</li>
            </ul>
          </div>
        )}
      </div>

      <div className="vp-estimate-actions">
        <button type="button" className="vp-primary" onClick={onConfirm} disabled={busy || nothingToDo}>
          {nothingToDo
            ? t.estimate.nothingToScan
            : busy
              ? t.estimate.confirmBusy
              : t.estimate.confirm}
        </button>
        <button type="button" className="vp-secondary" onClick={onCancel} disabled={busy}>
          {t.estimate.cancel}
        </button>
      </div>
    </section>
  );
}
