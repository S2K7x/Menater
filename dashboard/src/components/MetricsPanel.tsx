/**
 * Mesures d'exploitation.
 *
 * ============================================================================
 * DEUX TAUX, PAS UN — LA DISTINCTION QUI DECIDE DE LA SORTIE DU SHADOW MODE
 *
 * « Taux de faux positifs » est ambigu, et l'ambiguite coute cher ici :
 *
 *  - la PART DE VERDICTS « faux positif » mesure une distribution. Si le
 *    modele classe 80 % des alertes en faux positif, ca ne dit pas s'il a
 *    raison. C'est une mesure de comportement, pas de justesse.
 *
 *  - le TAUX DE DESACCORD HUMAIN mesure la justesse : la part des decisions
 *    reellement soumises a un humain que celui-ci a REJETEES. C'est le seul
 *    proxy de faux positif observable sans verite terrain.
 *
 * C'est le second qui conditionne le passage en mode reel. Afficher un seul
 * chiffre appele « taux de faux positifs » laisserait croire qu'on mesure la
 * fiabilite alors qu'on mesurerait une habitude.
 * ============================================================================
 */

import { memo } from 'react';
import type { Metrics } from '../lib/types.ts';
import { humanDuration } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Explain, Term } from './Guidance.tsx';
import { Icon } from './Icon.tsx';

function pct(v: number | null): string {
  return v === null ? '—' : `${v} %`;
}

/** Grand nombre d'une vignette. Extrait pour ne pas repeter six styles inline. */
function BigNumber({ children }: { children: React.ReactNode }) {
  return <strong className="soc-bignum">{children}</strong>;
}

/**
 * Une mesure : son nom, sa valeur, et ce qu'elle veut dire au clic.
 *
 * ============================================================================
 * POURQUOI LA PHRASE N'EST PLUS SOUS LE CHIFFRE
 *
 * Cet ecran existe pour repondre a UNE question — le modele est-il assez fiable
 * pour qu'on le laisse agir. Six vignettes, six grands nombres, et sous chacun
 * deux lignes de gris expliquant ce que le nombre compte : la moitie de la
 * surface disait ce qu'il faut comprendre plutot que ce qu'il y a a lire, et
 * les six chiffres — la seule chose qui change d'un jour a l'autre — se
 * retrouvaient noyes dans une prose qui, elle, ne change jamais.
 *
 * La definition est desormais a un clic du nom qu'elle definit. Elle reste
 * accessible depuis le meme endroit et cesse d'entrer en concurrence avec la
 * valeur : c'est exactement la separation entre ce qui RAPPORTE et ce qui
 * EXPLIQUE.
 * ============================================================================
 */
function Metric({
  label,
  help,
  children,
}: {
  /** Peut porter un `Term` : le nom lui-meme est parfois du jargon. */
  label: React.ReactNode;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="soc-health-item">
      <div className="soc-titled">
        <h3>{label}</h3>
        <Explain>{help}</Explain>
      </div>
      <BigNumber>{children}</BigNumber>
    </div>
  );
}

function StatBarImpl({ metrics }: { metrics: Metrics }) {
  const { c } = useI18n();
  const m = c.metrics.stat;
  return (
    <ul className="soc-statbar">
      <li className={metrics.awaiting_approval > 0 ? 'soc-stat-focus' : undefined}>
        <strong>{metrics.awaiting_approval}</strong>
        <span>{m.awaiting}</span>
      </li>
      <li>
        <strong>{metrics.alerts_total}</strong>
        <span>{m.alerts}</span>
      </li>
      <li className={metrics.failed > 0 ? 'soc-stat-alert' : undefined}>
        <strong>{metrics.failed}</strong>
        <span>{m.failed}</span>
      </li>
      <li>
        <strong>{metrics.actions_executed}</strong>
        <span>{m.executed}</span>
      </li>
      <li>
        <strong>{humanDuration(metrics.avg_dwell_ms)}</strong>
        <span>{m.avgDwell}</span>
      </li>
      <li className={metrics.alerts_shadow > 0 ? 'soc-stat-warn' : undefined}>
        <strong>{metrics.alerts_shadow}</strong>
        <span>
          <Term name="shadow">{m.shadow}</Term>
        </span>
      </li>
    </ul>
  );
}

export const StatBar = memo(StatBarImpl);

function MetricsPanelImpl({ metrics }: { metrics: Metrics }) {
  const { c } = useI18n();
  const m = c.metrics;
  const baseline = metrics.shadow_baseline;
  const progress = Math.min(100, Math.round((baseline.decisions / baseline.threshold) * 100));

  return (
    <>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{m.baselineKicker}</span>
            <h2>{m.baselineTitle}</h2>
          </div>
          <span className={baseline.reached ? 'soc-pill soc-pill-ok' : 'soc-pill soc-pill-warn'}>
            {baseline.decisions} / {baseline.threshold}
          </span>
        </div>
        <div className="soc-conf" style={{ marginBottom: 12 }}>
          <div className={`soc-conf-bar ${baseline.reached ? 'soc-conf-strong' : 'soc-conf-weak'}`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <span className="soc-conf-value">{progress} %</span>
        </div>
        <p className="soc-muted" style={{ margin: 0 }}>
          {baseline.reached ? m.baselineReached : m.baselineRemaining(baseline.threshold - baseline.decisions)}
        </p>
      </section>

      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{m.qualityKicker}</span>
            <h2>{m.qualityTitle}</h2>
          </div>
          <span className="soc-faint">{metrics.window_label}</span>
        </div>

        <div className="soc-health-grid">
          <Metric label={<><Term name="disagreement">{m.disagreement}</Term></>} help={m.disagreementHelp}>
            {pct(metrics.human_disagreement_rate_pct)}
          </Metric>

          <Metric label={<>{m.falsePositive}</>} help={m.falsePositiveHelp}>
            {metrics.by_verdict.false_positive ?? 0}
          </Metric>

          <Metric label={<><Term name="fallback">{m.fallback}</Term></>} help={m.fallbackHelp}>
            {pct(metrics.fallback_rate_pct)}
          </Metric>

          <Metric label={<><Term name="degraded">{m.degraded}</Term></>} help={m.degradedHelp}>
            {pct(metrics.degraded_rate_pct)}
          </Metric>

          <Metric label={<>{m.avgConfidence}</>} help={m.avgConfidenceHelp}>
            {metrics.avg_confidence ?? '—'}
          </Metric>

          <Metric label={<>{m.tokens}</>} help={m.tokensHelp}>
            {metrics.tokens_total.toLocaleString('en-US')}
          </Metric>
        </div>
      </section>

      <section className="soc-panel">
        <span className="soc-kicker">{m.splitKicker}</span>
        <h2>{m.splitTitle}</h2>
        <div className="soc-health-grid">
          <div className="soc-health-item">
            <h3>
              <Icon name="brain" size={14} /> {m.byVerdict}
            </h3>
            <ul className="soc-wf-list">
              {Object.entries(metrics.by_verdict).length === 0 ? (
                <li className="soc-faint">{m.noDecision}</li>
              ) : (
                Object.entries(metrics.by_verdict).map(([k, v]) => (
                  <li key={k}>
                    {/* Les cles brutes (`false_positive`) sont celles du
                        pipeline : elles ne doivent pas remonter telles quelles
                        a l'ecran d'un lecteur non technique. */}
                    <span>{c.queue.verdicts[k as keyof typeof c.queue.verdicts] ?? k}</span>
                    <b>{v}</b>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="soc-health-item">
            <h3>
              <Icon name="shield" size={14} /> {m.bySeverity}
            </h3>
            <ul className="soc-wf-list">
              {Object.entries(metrics.by_severity).map(([k, v]) => (
                <li key={k}>
                  <span>{k}</span>
                  <b>{v}</b>
                </li>
              ))}
            </ul>
          </div>
          <div className="soc-health-item">
            <h3>
              <Icon name="clock" size={14} /> {m.dwell}
            </h3>
            <ul className="soc-wf-list">
              <li>
                <span>{m.average}</span>
                <b>{humanDuration(metrics.avg_dwell_ms)}</b>
              </li>
              <li>
                <span>{m.p95}</span>
                <b>{humanDuration(metrics.p95_dwell_ms)}</b>
              </li>
              <li>
                <span>{m.liveShadow}</span>
                <b>
                  {metrics.alerts_live} / {metrics.alerts_shadow}
                </b>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * Memoise : le panneau est lourd (dix-huit vignettes) et le snapshot arrive
 * toutes les vingt secondes, souvent identique.
 */
export const MetricsPanel = memo(MetricsPanelImpl);
