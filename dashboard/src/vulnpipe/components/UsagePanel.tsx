/**
 * Panneau de consommation : tokens, coût, latence.
 *
 * Fonctionnalité demandée, absente de PHASE_6. Elle sert directement la
 * promesse n°1 de `CLAUDE.md` — le low-cost : un utilisateur qui ne voit pas
 * ce que son scan consomme ne peut pas savoir si la promesse est tenue.
 *
 * Deux principes de présentation :
 *  - Le résumé est en langage courant ; le tableau technique est REPLIÉ, comme
 *    pour les findings.
 *  - Un coût non communiqué par le fournisseur est affiché comme inconnu, pas
 *    estimé. Un chiffre inventé à partir d'une grille tarifaire codée en dur
 *    serait faux au premier changement de prix — et l'utilisateur y croirait.
 */

import { useState } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import type { Dictionary } from '../../i18n/dictionary.ts';

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cost_usd: number | null;
  cost_partial: boolean;
  latency_ms: number;
}

export interface UsageReport {
  totals: UsageTotals;
  by_stage: Record<string, UsageTotals>;
  by_model: Record<string, UsageTotals>;
  plain_language_summary: string;
}


export function formatCost(totals: UsageTotals, t: Dictionary): string {
  // Jamais « 0 $ » pour un coût non communiqué : ce serait présenter une
  // absence d'information comme une gratuité.
  if (totals.cost_usd === null) return t.usage.notReported;
  if (totals.cost_usd === 0) return t.usage.free;
  const amount = totals.cost_usd < 0.01 ? totals.cost_usd.toFixed(4) : totals.cost_usd.toFixed(2);
  return totals.cost_partial ? `$${amount} (${t.usage.partial})` : `$${amount}`;
}

export function UsagePanel({ usage }: { usage: UsageReport }) {
  const { t } = useI18n();
  const [showDetail, setShowDetail] = useState(false);
  const { totals } = usage;

  return (
    <section className="vp-usage" aria-label={t.usage.heading}>
      {/* h2 et pas h3 : cette section est la soeur du rapport et du lanceur,
          pas un bloc a l'interieur de l'un d'eux. Le niveau du titre decide de
          sa taille ET du plan du document lu par un lecteur d'ecran. */}
      <h2>{t.usage.heading}</h2>
      <p className="vp-usage-summary">{usage.plain_language_summary}</p>

      <ul className="vp-usage-highlights">
        <li>
          <span className="vp-usage-value">{totals.calls}</span>
          <span className="vp-usage-label">{t.usage.calls}</span>
        </li>
        <li>
          <span className="vp-usage-value">{formatCost(totals, t)}</span>
          <span className="vp-usage-label">{t.usage.cost}</span>
        </li>
        <li>
          <span className="vp-usage-value">{Math.round(totals.latency_ms / 1000)} s</span>
          <span className="vp-usage-label">{t.usage.compute}</span>
        </li>
      </ul>

      <button type="button" onClick={() => setShowDetail((open) => !open)} aria-expanded={showDetail}>
        {showDetail ? t.usage.hideDetail : t.usage.showDetail}
      </button>

      {showDetail && (
        <div className="vp-usage-detail">
          <table>
            <caption>{t.usage.byStage}</caption>
            <thead>
              <tr>
                <th scope="col">{t.usage.stage}</th>
                <th scope="col">{t.usage.callsColumn}</th>
                <th scope="col">{t.usage.input}</th>
                <th scope="col">{t.usage.output}</th>
                <th scope="col">{t.usage.thinking}</th>
                <th scope="col">{t.usage.costColumn}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(usage.by_stage).map(([stage, stageTotals]) => (
                <tr key={stage}>
                  <th scope="row">{t.usage.stages[stage] ?? stage}</th>
                  <td>{stageTotals.calls}</td>
                  <td>{stageTotals.input_tokens}</td>
                  <td>{stageTotals.output_tokens}</td>
                  <td>{stageTotals.thinking_tokens}</td>
                  <td>{formatCost(stageTotals, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table>
            <caption>{t.usage.byModel}</caption>
            <thead>
              <tr>
                <th scope="col">{t.usage.model}</th>
                <th scope="col">{t.usage.callsColumn}</th>
                <th scope="col">{t.usage.costColumn}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(usage.by_model).map(([model, modelTotals]) => (
                <tr key={model}>
                  <th scope="row">{model}</th>
                  <td>{modelTotals.calls}</td>
                  <td>{formatCost(modelTotals, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Le raisonnement interne est le poste le moins visible : on
              l'explique plutôt que de laisser un chiffre nu. */}
          {totals.thinking_tokens > 0 && (
            <p className="vp-usage-note">{t.usage.thinkingNote}</p>
          )}
        </div>
      )}
    </section>
  );
}
