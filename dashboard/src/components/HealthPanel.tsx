/**
 * Sante du pipeline et diagnostic de connectivite.
 *
 * ============================================================================
 * POURQUOI LES DEFAUTS CONNUS SONT AFFICHES EN PERMANENCE
 *
 * La recette a laisse des defauts bloquants ouverts. Un defaut connu qu'on ne
 * voit plus est un defaut qui revient en production : il finit par etre range
 * dans « c'est normal ». Tant qu'ils ne sont pas corriges, ils occupent le haut
 * de cet ecran, et la console dit lesquels elle observe REELLEMENT dans les
 * donnees en cours plutot que de reciter une liste figee.
 *
 * ============================================================================
 * LE DIAGNOSTIC DISTINGUE QUATRE ETATS, PAS DEUX
 *
 * Un test qui ne saurait dire que « vert » ou « rouge » mentirait la moitie du
 * temps. Ici :
 *   OK   — verifie, ca marche.
 *   WARN — ca marche, mais quelque chose reduit la couverture.
 *   FAIL — casse, avec le geste correctif.
 *   ND   — NON DETERMINE : la console ne peut pas conclure (elle n'ouvre pas de
 *          connexion Postgres, par exemple). L'absence de signal n'est pas une
 *          preuve, et un vert affiche a sa place serait un mensonge utile.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import type { Check, Diagnostics, HealthReport } from '../lib/types.ts';
import { api, ApiError, humanDuration } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Explain, Fold } from './Guidance.tsx';
import { NoticeList } from './Notices.tsx';

/** Seuls la classe CSS et l'icone sont figees : le libelle vient du catalogue. */
const STATUS_META: Record<Check['status'], { cls: string; icon: IconName }> = {
  ok: { cls: 'soc-pill soc-pill-ok', icon: 'check' },
  warn: { cls: 'soc-pill soc-pill-warn', icon: 'alert' },
  fail: { cls: 'soc-pill soc-pill-failed', icon: 'cross' },
  skip: { cls: 'soc-pill soc-pill-neutral', icon: 'skip' },
};

const VERDICT_CLASS: Record<Diagnostics['verdict'], string> = {
  operational: 'soc-banner soc-banner-ok',
  degraded: 'soc-banner soc-banner-warn',
  broken: 'soc-banner soc-banner-error',
};

function DiagnosticsResult({ diag }: { diag: Diagnostics }) {
  const h = useI18n().c.health;
  const groups = diag.checks.reduce<Record<string, Check[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div style={{ marginTop: 18 }}>
      <div className={VERDICT_CLASS[diag.verdict]}>
        <Icon name={diag.verdict === 'operational' ? 'check' : 'alert'} size={16} />
        <p>
          <strong>{h.verdicts[diag.verdict]}</strong>
          {h.summary(
            diag.summary.ok,
            diag.summary.warn,
            diag.summary.fail,
            diag.summary.skip,
            humanDuration(diag.duration_ms),
          )}
        </p>
      </div>

      {Object.entries(groups).map(([group, checks]) => (
        <div key={group} className="soc-block">
          <span className="soc-kicker">{group}</span>
          <ul className="soc-check-list">
            {checks.map((c) => {
              const m = STATUS_META[c.status];
              return (
                <li key={c.id} className={`soc-check soc-check-${c.status}`}>
                  <div className="soc-check-head">
                    <Icon name={m.icon} size={14} />
                    <span className="soc-check-label">{c.label}</span>
                    <span className={m.cls}>{h.status[c.status]}</span>
                  </div>
                  <p className="soc-check-detail">{c.detail}</p>
                  {c.remedy ? (
                    <p className="soc-check-remedy">
                      <b>{h.todo}</b> {c.remedy}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function HealthPanel({
  health,
  onRefresh,
  onOpenCase,
}: {
  health: HealthReport;
  onRefresh: () => void;
  /** Ouvre le cas dans la file. Absent = le bouton ne s'affiche pas. */
  onOpenCase?: (alertId: string) => void;
}) {
  const h = useI18n().c.health;
  const [busy, setBusy] = useState(false);
  const [scenarios, setScenarios] = useState<Array<{ id: string; title: string; purpose: string }>>([]);

  useEffect(() => {
    // From the server, so the buttons cannot drift from the catalogue that
    // actually builds the alerts.
    api.scenarios().then((r) => setScenarios(r.scenarios)).catch(() => setScenarios([]));
  }, []);

  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Etape en cours de l'alerte injectee, et son identifiant une fois le suivi
  // termine : le bouton « ouvrir dans la file » n'a de sens qu'apres.
  const [following, setFollowing] = useState<string | null>(null);
  const [lastInjected, setLastInjected] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  async function runDiagnostics() {
    setDiagBusy(true);
    setDiagError(null);
    try {
      const d = await api.diagnostics();
      setDiag(d);
      // Le diagnostic vient de relire l'instance : la vue doit suivre.
      onRefresh();
    } catch (err) {
      setDiagError(err instanceof ApiError ? err.message : h.diagFailed);
    } finally {
      setDiagBusy(false);
    }
  }

  /**
   * Injection d'une alerte de test, puis SUIVI de cette alerte.
   *
   * ========================================================================
   * POURQUOI UN SUIVI ET PAS UN `setTimeout`
   *
   * L'ancienne version rafraichissait une fois, trois secondes apres l'envoi.
   * La chaine complete met une quinzaine de secondes (l'appel au modele de
   * l'etape 03) : a +3 s on voyait l'ingestion, et plus rien ensuite — la
   * cadence de rafraichissement de la console peut etre reglee jusqu'a une
   * heure. L'alerte arrivait bien, l'ecran ne le montrait jamais.
   *
   * On interroge donc jusqu'a ce que la chaine se termine, ou jusqu'a la fin
   * du budget. ET SI ELLE N'ARRIVE PAS, ON LE DIT : « aucune etape en 45 s »
   * est une reponse, « rien ne s'affiche » n'en est pas une.
   * ========================================================================
   */
  const FOLLOW_BUDGET_MS = 45_000;
  const FOLLOW_EVERY_MS = 3_000;

  async function follow(alertId: string) {
    const deadline = Date.now() + FOLLOW_BUDGET_MS;
    let lastStep: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, FOLLOW_EVERY_MS));
      let snap;
      try {
        snap = await api.snapshot(true);
      } catch {
        continue; // une lecture ratee n'annule pas le suivi
      }
      onRefresh();
      const chain = snap.trace.chains.find((c) => c.alert_id === alertId);
      const done = chain?.steps.filter((s) => s.status !== 'missing') ?? [];
      if (chain && (chain.verdict === 'complete' || chain.verdict === 'failed')) {
        setFollowing(null);
        setMessage({ ok: chain.verdict === 'complete', text: h.followDone(alertId) });
        setLastInjected(alertId);
        return;
      }
      const step = done[done.length - 1]?.workflow ?? null;
      if (step && step !== lastStep) {
        lastStep = step;
        setFollowing(h.followSeen(alertId, step));
      }
    }
    setFollowing(null);
    setMessage({
      ok: false,
      text: lastStep
        ? h.followSeen(alertId, lastStep)
        : h.followLost(alertId, Math.round(FOLLOW_BUDGET_MS / 1000)),
    });
    setLastInjected(alertId);
  }

  async function simulate(scenario?: string) {
    setBusy(true);
    setMessage(null);
    setFollowing(null);
    setLastInjected(null);
    try {
      const r = await api.simulate(scenario ? { scenario } : {});
      if (!r.ok) {
        setMessage({ ok: false, text: h.injectKo(r.status, r.response.slice(0, 200)) });
        return;
      }
      setMessage({ ok: true, text: h.injectOk(r.alert_id) });
      setFollowing(h.followWaiting(r.alert_id));
      void follow(r.alert_id);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : h.injectFailed });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{h.diagKicker}</span>
            {/* Ce que le test verifie exactement tient en quatre lignes qu'on
                lit UNE fois. Au-dessus d'un bouton qu'on presse cent fois,
                elles occupaient la place ou le resultat s'affiche. */}
            <div className="soc-titled">
              <h2>{h.diagTitle}</h2>
              <Explain label={h.diagTitle}>{h.diagLede}</Explain>
            </div>
          </div>
          <button type="button" className="soc-primary" onClick={runDiagnostics} disabled={diagBusy}>
            <Icon name="activity" size={15} />
            {diagBusy ? h.running : h.run}
          </button>
        </div>

        {diagError ? (
          <div className="soc-banner soc-banner-error" style={{ marginTop: 14 }}>
            <Icon name="alert" size={16} />
            <p>{diagError}</p>
          </div>
        ) : null}

        {diag ? <DiagnosticsResult diag={diag} /> : null}
      </section>

      {health.blocking_findings.length > 0 ? (
        <section className="soc-panel">
          <span className="soc-kicker">{h.findingsKicker}</span>
          <h2>{h.findingsTitle}</h2>
          {/* Acknowledgeable, because these repeat on every refresh until the
              underlying cause is fixed — which can be days. Acknowledging
              collapses the REPETITION; the finding itself stays counted, and
              a reworded one comes back unread. */}
          <NoticeList
            notices={health.blocking_findings.map((f) => ({
              scope: 'health.finding',
              tone: 'error' as const,
              text: f,
            }))}
          />
        </section>
      ) : null}

      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{h.sourceKicker}</span>
            <h2>{h.stateTitle}</h2>
          </div>
          <span className={health.mode === 'live' ? 'soc-pill soc-pill-ok' : 'soc-pill soc-pill-warn'}>
            {health.mode === 'live' ? h.realData : h.demoData}
          </span>
        </div>

        <div className="soc-health-grid">
          <div className="soc-health-item">
            <h3>
              <Icon name="activity" size={14} /> {h.engineTitle}
            </h3>
            <p className="soc-muted" style={{ margin: 0 }}>
              {health.engine.reachable ? h.reachable : h.unreachable} — <code>{health.engine.url}</code>
            </p>
            <p className="soc-faint" style={{ margin: '6px 0 0' }}>
              {health.engine.detail}
            </p>
          </div>

          <div className="soc-health-item">
            <div className="soc-titled">
              <h3>
                <Icon name="database" size={14} /> {h.auditDb}
              </h3>
              <Explain label={h.auditDb}>{h.auditNote}</Explain>
            </div>
            <p className="soc-muted" style={{ margin: 0 }}>
              {health.audit_db.healthy ? h.auditOk : h.auditKo}
            </p>
            <p className="soc-faint" style={{ margin: '6px 0 0' }}>
              {health.audit_db.detail}
            </p>
          </div>

          <div className="soc-health-item">
            <div className="soc-titled">
              <h3>
                <Icon name="play" size={14} /> {h.injectTitle}
              </h3>
              <Explain label={h.injectTitle}>
                {h.injectLede} {h.scenarioHelp}
              </Explain>
            </div>

            {/* ONE BUTTON PER PATH, not one button. The injector used to send a
                single hard-coded alert, so everything the pipeline does
                differently — no destination, a hash, a rejection, a duplicate —
                was unreachable without waiting for a real alert shaped that
                way. The list comes from the server so it cannot drift. */}
            <div className="soc-field">
              <span>{h.scenario}</span>
              <div className="soc-scenarios">
                {scenarios.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    className="soc-secondary soc-scenario"
                    title={sc.purpose}
                    disabled={busy}
                    onClick={() => simulate(sc.id)}
                  >
                    <Icon name="play" size={13} />
                    <span>{sc.title}</span>
                  </button>
                ))}
              </div>
            </div>
            {message ? (
              <div className={`soc-banner ${message.ok ? 'soc-banner-ok' : 'soc-banner-error'}`} style={{ marginTop: 12 }}>
                <Icon name={message.ok ? 'check' : 'alert'} size={16} />
                <p>{message.text}</p>
              </div>
            ) : null}
            {following ? (
              <div className="soc-banner soc-banner-warn" style={{ marginTop: 12 }}>
                <Icon name="clock" size={16} />
                <p>{following}</p>
              </div>
            ) : null}
            {lastInjected && onOpenCase ? (
              <button
                type="button"
                className="soc-secondary"
                style={{ marginTop: 12 }}
                onClick={() => onOpenCase(lastInjected)}
              >
                <Icon name="queue" size={14} />
                {h.followOpen}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {/*
        Repliee : la liste des workflows publies est une PIECE. On l'ouvre
        quand le diagnostic a nomme un workflow, jamais en arrivant — et
        pliee, elle annonce quand meme son compte, donc « aucun workflow
        trouve » reste visible sans ouvrir quoi que ce soit.
      */}
      <section className="soc-panel">
        <Fold
          title={h.workflowsTitle}
          hint={health.workflows.length === 0 ? h.workflowsEmpty : String(health.workflows.length)}
        >
        {health.workflows.length === 0 ? (
          <p className="soc-faint">{h.workflowsEmpty}</p>
        ) : (
          <ul className="soc-wf-list">
            {health.workflows
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((w) => (
                <li key={w.id}>
                  <span>{w.name}</span>
                  <span className={w.active ? 'soc-pill soc-pill-ok' : 'soc-pill soc-pill-neutral'}>
                    {w.active ? h.published : h.unpublished}
                  </span>
                </li>
              ))}
          </ul>
        )}
        </Fold>
      </section>
    </>
  );
}
