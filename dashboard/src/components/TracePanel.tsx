/**
 * Onglet Suivi — la vue NON RÉDUITE du pipeline.
 *
 * ============================================================================
 * POURQUOI CET ONGLET EXISTE
 *
 * La file d'alertes recolle les exécutions par `alert_id` pour montrer des
 * CAS. Ce recollement est ce qui rend la console lisible, et c'est aussi ce
 * qui l'aveugle sur deux choses :
 *
 *  1. Une exécution sans identifiant d'alerte lisible n'apparaît NULLE PART.
 *     Sur cette instance, il y en avait 26 sur 114 — dont huit démarrages de
 *     04 à vide, la signature du `mode: "once"`.
 *
 *  2. Une chaîne qui s'arrête au milieu ressemble à un cas normal, juste plus
 *     court. Rien ne distingue « close après audit » de « n'est jamais arrivé
 *     jusqu'à l'audit » quand on ne regarde qu'une ligne de tableau.
 *
 * Les deux pannes ont la même signature dans n8n : tout est vert. C'est
 * exactement pour ça qu'il faut un écran qui les cherche.
 *
 * ============================================================================
 * TROIS PARTIS PRIS
 *
 *  1. TROIS SECTIONS, DE LA CONCLUSION VERS LA MATIÈRE. Les chaînes rompues
 *     d'abord, les orphelines ensuite, le journal brut en dernier. Qui ouvre
 *     cet onglet a une question précise ; le journal complet est le dernier
 *     recours, pas la porte d'entrée.
 *
 *  2. LE JOURNAL EST CHERCHABLE PAR IDENTIFIANT D'ALERTE. Coller
 *     `QA-1787511982500` donne en une fois les cinq exécutions qui l'ont
 *     touchée, avec un lien direct vers chacune dans n8n. C'est le geste qui
 *     répond à « où est passée mon alerte ».
 *
 *  3. AUCUN TROU N'EST COMBLÉ. Une étape jamais exécutée s'affiche « n'a
 *     jamais tourné », pas « en attente ». Une exécution dont le détail n'est
 *     pas revenu s'affiche comme illisible, pas comme vide.
 * ============================================================================
 */

import { useMemo, useState } from 'react';

import { api, ApiError, clock, humanDuration, timeAgo } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Icon } from './Icon.tsx';
import { Explain } from './Guidance.tsx';
import { SectionPanel, SectionTabs, type SectionTabItem } from './SectionTabs.tsx';
import type {
  ChainVerdict, OrphanReason, TraceChain, TraceExecution, TraceReport,
} from '../lib/types.ts';
import { UNEXPECTED_ORPHANS } from '../lib/types.ts';

/** Un verdict de chaîne se lit à sa couleur avant de se lire à son mot. */
const VERDICT_TONE: Record<ChainVerdict, string> = {
  broken: 'soc-pill-critical',
  stalled: 'soc-pill-warn',
  failed: 'soc-pill-high',
  awaiting: 'soc-pill-neutral',
  running: 'soc-pill-neutral',
  complete: 'soc-pill-ok',
};

const ORPHAN_TONE: Record<OrphanReason, string> = {
  empty_input: 'soc-pill-critical',
  no_alert_id: 'soc-pill-high',
  no_data: 'soc-pill-warn',
  diagnostic_probe: 'soc-pill-neutral',
  foreign_workflow: 'soc-pill-neutral',
};

function statusTone(status: string): string {
  if (status === 'error' || status === 'crashed') return 'soc-pill-critical';
  if (status === 'waiting') return 'soc-pill-warn';
  if (status === 'running' || status === 'new') return 'soc-pill-neutral';
  if (status === 'success') return 'soc-pill-ok';
  return 'soc-pill-neutral';
}

/**
 * Une chaîne, dessinée comme une chaîne : cinq maillons dans l'ordre, et le
 * maillon qui manque reste à sa place, en creux. Le montrer VIDE plutôt que
 * l'omettre est la différence entre « il manque quelque chose » et « c'était
 * plus court », qu'un tableau de cinq colonnes ne fait pas voir.
 */
function ChainSteps({ chain }: { chain: TraceChain }) {
  const t = useI18n().c.trace;
  return (
    <ol className="soc-trace-steps">
      {chain.steps.map((s, i) => {
        const missing = s.status === 'missing';
        const emptyHandoff = s.handoff === 'empty';
        const cls = missing
          ? 'soc-trace-step soc-trace-step-missing'
          : s.status === 'error'
            ? 'soc-trace-step soc-trace-step-error'
            : emptyHandoff
              ? 'soc-trace-step soc-trace-step-empty'
              : 'soc-trace-step';
        return (
          <li key={s.workflow} className={cls}>
            <span className="soc-trace-step-index">{String(i + 1).padStart(2, '0')}</span>
            <span className="soc-trace-step-name">{s.workflow.replace(/^\d+-/, '')}</span>
            {/*
              `?? s.status` et `?? s.handoff` : une valeur hors catalogue
              s'affichait `undefined`, EN TOUTES LETTRES, a cote du nom de
              l'etape. La regle du produit est qu'un identifiant de pipeline
              inconnu se rend TEL QUEL plutot que d'etre invente — « undefined »
              n'est ni l'un ni l'autre, c'est un mot qui ne veut rien dire pose
              sur un ecran de diagnostic. Le moteur peut gagner un statut ou un
              type de passage de main sans que la console mente.
            */}
            <span className="soc-trace-step-state">
              {t.stepStatus[s.status] ?? s.status}
              {!missing && s.handoff !== 'n/a' ? ` · ${t.handoff[s.handoff] ?? s.handoff}` : ''}
            </span>
            {s.execution_id ? (
              <span className="soc-trace-step-link">#{s.execution_id}</span>
            ) : (
              <span className="soc-trace-step-link soc-faint">—</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Bouton de rejeu, avec la case qui change ce qui part réellement. */
function ReplayBox({ chain, onDone }: { chain: TraceChain; onDone: () => void }) {
  const t = useI18n().c.trace;
  const [sameId, setSameId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!chain.payload) {
    return <p className="soc-faint soc-trace-noreplay">{t.replayNoPayload}</p>;
  }

  async function replay() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.replay(chain.alert_id, sameId);
      setResult({ ok: r.ok, text: r.detail });
      // Le rejeu vient de créer une exécution : la vue doit la montrer, pas
      // attendre la prochaine cadence pour révéler ce qu'on vient de faire.
      if (r.ok) onDone();
    } catch (err) {
      setResult({ ok: false, text: err instanceof ApiError ? err.message : t.replayFailed });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="soc-trace-replay">
      {/*
        CE QUE LE REJEU FAIT est stable ; ce que la case a cocher change ne
        l'est pas. Le premier est ecrit une fois pour toutes et se repete a
        l'identique dans CHAQUE chaine ouverte — il passe derriere le disque.
        Le second suit l'etat de la case, c'est un constat, et il reste.
      */}
      <label className="soc-trace-check">
        <input type="checkbox" checked={sameId} onChange={(e) => setSameId(e.target.checked)} />
        <span>{t.replaySameId}</span>
      </label>
      <p className="soc-faint" style={{ margin: '4px 0 10px' }}>
        {sameId ? t.replaySameIdHelp : t.replayNewIdHelp}
      </p>
      <button type="button" className="soc-secondary" onClick={replay} disabled={busy}>
        <Icon name="refresh" size={14} />
        {busy ? t.replaying : t.replay}
      </button>{' '}
      <Explain label={t.replay}>{t.replayLede}</Explain>
      {result ? (
        <div
          className={`soc-banner ${result.ok ? 'soc-banner-ok' : 'soc-banner-error'}`}
          style={{ marginTop: 10 }}
        >
          <Icon name={result.ok ? 'check' : 'alert'} size={16} />
          <p>{result.text}</p>
        </div>
      ) : null}
    </div>
  );
}

function ChainCard({
  chain,
  onOpenCase,
  onRefresh,
}: {
  chain: TraceChain;
  onOpenCase: (id: string) => void;
  onRefresh: () => void;
}) {
  const t = useI18n().c.trace;
  // Une chaîne saine n'a pas besoin d'être dépliée ; une chaîne cassée si.
  const broken = chain.verdict === 'broken' || chain.verdict === 'stalled' || chain.verdict === 'failed';

  return (
    <details className="soc-trace-chain" open={broken}>
      <summary>
        <span className={`soc-pill ${VERDICT_TONE[chain.verdict]}`}>{t.verdicts[chain.verdict]}</span>
        <code className="soc-trace-chain-id">{chain.alert_id}</code>
        <span className="soc-faint">{timeAgo(chain.received_at)}</span>
        <Icon name="chevron" size={14} />
      </summary>

      <p className="soc-muted soc-trace-verdict-help">{t.verdictHelp[chain.verdict]}</p>

      {chain.break_at ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{t.breakAt(chain.break_at)}</p>
        </div>
      ) : null}
      {chain.terminal_reason ? (
        <p className="soc-faint">{t.terminalReasons[chain.terminal_reason]}</p>
      ) : null}
      {chain.steps.some((s) => s.handoff === 'empty') ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{t.handoffEmptyWarning}</p>
        </div>
      ) : null}

      <ChainSteps chain={chain} />

      <p className="soc-faint">
        {t.idleFor(humanDuration(chain.idle_ms))}
        {chain.missing.length ? ` ${t.missingSteps(chain.missing.join(', '))}` : ''}
      </p>

      <div className="soc-trace-chain-actions">
        <button type="button" className="soc-secondary" onClick={() => onOpenCase(chain.alert_id)}>
          <Icon name="queue" size={14} />
          {t.openCase}
        </button>
      </div>

      {broken ? <ReplayBox chain={chain} onDone={onRefresh} /> : null}
    </details>
  );
}

function OrphanRow({ run }: { run: TraceExecution }) {
  const t = useI18n().c.trace;
  const reason = run.orphan_reason!;
  return (
    <li className="soc-trace-orphan">
      <div className="soc-trace-orphan-head">
        <span className={`soc-pill ${ORPHAN_TONE[reason]}`}>{t.orphanReasons[reason]}</span>
        <span className="soc-trace-exec">#{run.execution_id}</span>
        <span className="soc-faint">
          {run.workflow ?? t.outsidePipeline} · {timeAgo(run.started_at)}
        </span>
      </div>
      <p className="soc-faint">{t.orphanHelp[reason]}</p>
      {run.note ? <p className="soc-faint"><code>{run.note}</code></p> : null}
    </li>
  );
}

/** Journal brut, cherchable. Le dernier recours, et celui qui répond toujours. */
function RunLog({ runs }: { runs: TraceExecution[] }) {
  const t = useI18n().c.trace;
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter(
      (r) =>
        r.execution_id.includes(needle) ||
        (r.alert_id ?? '').toLowerCase().includes(needle) ||
        (r.workflow ?? '').toLowerCase().includes(needle) ||
        r.workflow_id.toLowerCase().includes(needle) ||
        r.status.toLowerCase().includes(needle),
    );
  }, [runs, query]);

  return (
    <section className="soc-panel">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{t.logKicker}</span>
          <div className="soc-titled">
            <h2>{t.logTitle}</h2>
            <Explain label={t.logTitle}>{t.logLede}</Explain>
          </div>
        </div>
        <span className="soc-faint">{t.logShown(rows.length, runs.length)}</span>
      </div>


      <div className="soc-filters">
        <input
          className="soc-search"
          type="search"
          value={query}
          placeholder={t.logSearch}
          aria-label={t.logSearchLabel}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <p className="soc-empty">{t.logEmpty}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          {/* `soc-queue` porte le repliement en cartes sous 720 px : les
              `data-label` de chaque cellule en dependent. */}
          <table className="soc-queue soc-trace-table">
            <thead>
              <tr>
                <th>{t.columns.execution}</th>
                <th>{t.columns.workflow}</th>
                <th>{t.columns.status}</th>
                <th>{t.columns.alert}</th>
                <th>{t.columns.handoff}</th>
                <th>{t.columns.started}</th>
                <th>{t.columns.duration}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.execution_id}>
                  <td data-label={t.columns.execution}>
                    <span className="soc-trace-exec">#{r.execution_id}</span>
                  </td>
                  <td data-label={t.columns.workflow}>
                    {r.workflow ?? <span className="soc-faint">{t.outsidePipeline}</span>}
                  </td>
                  <td data-label={t.columns.status}>
                    <span className={`soc-pill ${statusTone(r.status)}`}>{r.status}</span>
                    {/*
                      LA RAISON, SOUS LE STATUT.
                      `note` porte le code d'erreur, ou « noeud vide ». La
                      liste des orphelines l'affichait ; ce journal, non — il
                      montrait une pastille ERROR rouge et taisait pourquoi,
                      sur l'ecran dont le travail est precisement de repondre
                      « pourquoi » quand tout le reste a reduit l'information.
                      Elle n'apparait que lorsqu'il y a quelque chose a dire.
                    */}
                    {r.note ? (
                      <div className="soc-row-sub soc-trace-log-note">{r.note}</div>
                    ) : null}
                  </td>
                  <td data-label={t.columns.alert}>
                    {r.alert_id
                      ? <code>{r.alert_id}</code>
                      : <span className="soc-faint">{t.unattached}</span>}
                  </td>
                  <td data-label={t.columns.handoff}>
                    <span className={r.handoff === 'empty' ? 'soc-trace-warn' : undefined}>
                      {t.handoff[r.handoff] ?? r.handoff}
                    </span>
                  </td>
                  <td data-label={t.columns.started}>{clock(r.started_at)}</td>
                  <td data-label={t.columns.duration}>{humanDuration(r.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Les trois vues de l'onglet Suivi, du plus actionnable au plus brut. */
type TraceSection = 'chains' | 'orphans' | 'log';

export function TracePanel({
  trace,
  onOpenCase,
  onRefresh,
}: {
  trace: TraceReport;
  onOpenCase: (id: string) => void;
  onRefresh: () => void;
}) {
  const t = useI18n().c.trace;
  const [showExpected, setShowExpected] = useState(false);
  /**
   * Sous-onglet ouvert. Par défaut les chaînes : c'est ce qui bloque un
   * humain. Le journal brut est le dernier recours, pas le premier écran.
   */
  const [section, setSection] = useState<TraceSection>('chains');

  const unexpected = trace.orphans.filter((o) => UNEXPECTED_ORPHANS.includes(o.orphan_reason!));
  const expected = trace.orphans.filter((o) => !UNEXPECTED_ORPHANS.includes(o.orphan_reason!));

  /**
   * Les compteurs voyagent SUR les onglets, y compris fermés.
   *
   * C'est la condition pour avoir le droit de découper cet onglet : sa raison
   * d'être est de montrer ce que le recollement cache. Ranger une chaîne
   * rompue derrière un onglet muet aurait reproduit exactement le défaut qu'il
   * dénonce — une panne qui s'affiche en vert.
   */
  const sections: SectionTabItem<TraceSection>[] = [
    {
      id: 'chains',
      label: t.chainsTitle,
      icon: 'chain',
      count: trace.chains.length,
      alert: trace.chains.length > 0,
    },
    {
      id: 'orphans',
      label: t.orphansTitle,
      icon: 'skip',
      count: unexpected.length,
      alert: unexpected.length > 0,
    },
    { id: 'log', label: t.logTitle, icon: 'search', count: trace.executions.length },
  ];

  return (
    <>
      {/* HORS SOUS-ONGLETS, volontairement : ce bloc porte le verdict
          d'ensemble (« tout est clair » ou « N cas demandent une action »).
          Le ranger dans un onglet obligerait à cliquer pour savoir s'il y a
          quelque chose à savoir. */}
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{t.windowTitle}</span>
            {/* Le verdict RESTE ecrit en toutes lettres — c'est un rapport,
                et un rapport ne se replie pas. Ce qui passe derriere le « i »,
                c'est la phrase qui explique ce qu'on regarde : on la lit une
                fois, et elle occupait autant de hauteur que le verdict. */}
            <div className="soc-titled">
              <h2>
                {trace.counts.attention === 0 ? t.allClear : t.attention(trace.counts.attention)}
              </h2>
              <Explain label={t.windowTitle}>
                {trace.counts.attention === 0 ? t.allClearLede : t.lede}
              </Explain>
            </div>
          </div>
          <span className="soc-faint">{t.refreshedAt(clock(trace.generated_at))}</span>
        </div>


        {trace.window.inspected === 0 ? (
          <p className="soc-faint">{t.windowEmpty}</p>
        ) : (
          <>
            <p className="soc-faint" style={{ margin: 0 }}>
              {t.windowSummary(trace.window.inspected, trace.window.attached)}{' '}
              {trace.window.oldest_at && trace.window.newest_at
                ? t.windowSpan(timeAgo(trace.window.oldest_at), timeAgo(trace.window.newest_at))
                : null}
            </p>
            {/* Une fenêtre pleine ne prouve pas que rien n'a disparu : elle
                prouve seulement qu'on n'a pas regardé plus loin. */}
            {trace.window.truncated ? (
              <div className="soc-banner soc-banner-warn" style={{ marginTop: 12 }}>
                <Icon name="alert" size={16} />
                <p>{t.windowTruncated(trace.window.limit)}</p>
              </div>
            ) : null}
          </>
        )}
      </section>

      <SectionTabs items={sections} active={section} onChange={setSection} label={t.sectionsLabel} />

      <SectionPanel id="chains" active={section === 'chains'}>
      <section className="soc-panel">
        <span className="soc-kicker">{t.chainsKicker}</span>
        <div className="soc-titled">
          <h2>{t.chainsTitle}</h2>
          <Explain label={t.chainsTitle}>{t.chainsLede}</Explain>
        </div>
        {trace.chains.length === 0 ? (
          <p className="soc-quiet soc-quiet-ok">
            <Icon name="check" size={15} /> {t.chainsEmpty}
          </p>
        ) : (
          <div className="soc-trace-chains">
            {trace.chains.map((c) => (
              <ChainCard
                key={c.alert_id}
                chain={c}
                onOpenCase={onOpenCase}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        )}
      </section>

      </SectionPanel>

      <SectionPanel id="orphans" active={section === 'orphans'}>
      <section className="soc-panel">
        <span className="soc-kicker">{t.orphansKicker}</span>
        <div className="soc-titled">
          <h2>{t.orphansTitle}</h2>
          <Explain label={t.orphansTitle}>{t.orphansLede}</Explain>
        </div>
        {unexpected.length === 0 ? (
          <p className="soc-quiet soc-quiet-ok">
            <Icon name="check" size={15} /> {t.orphansEmpty}
          </p>
        ) : (
          <ul className="soc-trace-orphans">
            {unexpected.map((o) => <OrphanRow key={o.execution_id} run={o} />)}
          </ul>
        )}

        {/* Les orphelines ATTENDUES (sonde du diagnostic, workflow étranger)
            restent consultables mais repliées : les afficher au même rang que
            les vraies ferait clignoter cet onglet après chaque test de
            connectivité, et une alarme permanente ne se lit plus. */}
        {expected.length > 0 ? (
          <>
            <button
              type="button"
              className="soc-link-button"
              onClick={() => setShowExpected((v) => !v)}
            >
              {showExpected ? t.hideExpected : t.showExpected(expected.length)}
            </button>
            {showExpected ? (
              <ul className="soc-trace-orphans">
                {expected.map((o) => <OrphanRow key={o.execution_id} run={o} />)}
              </ul>
            ) : null}
          </>
        ) : null}
      </section>

      </SectionPanel>

      <SectionPanel id="log" active={section === 'log'}>
        <RunLog runs={trace.executions} />
      </SectionPanel>
    </>
  );
}
