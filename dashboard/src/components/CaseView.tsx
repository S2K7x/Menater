/**
 * Fiche d'incident — l'ecran d'investigation.
 *
 * ============================================================================
 * CE QU'ON A REPRIS AUX SOAR, ET POURQUOI
 *
 *  - CHAINE DE POSSESSION (D3 Smart SOAR). Chaque passage dans un workflow est
 *    horodate, avec sa duree et son resultat. Un audit qui dit « approuve »
 *    sans dire quand, par qui et apres quoi ne vaut rien devant un auditeur.
 *
 *  - INTENT / BLAST RADIUS / ROLLBACK avant validation (challenge-and-response).
 *    L'humain a qui l'on demande d'approuver voit ce que ca fait, sur quoi, et
 *    comment revenir en arriere. Un bouton « Approuver » sans ces trois champs
 *    transforme la validation humaine en formalite.
 *
 *  - DATA LINEAGE (tracabilite de la decision). Le modele doit citer les champs
 *    d'enrichissement sur lesquels il s'est appuye. C'est ce qui permet de
 *    contester un verdict au lieu de le subir.
 *
 * ET UNE CHOSE QU'AUCUN SOAR N'AFFICHE, PARCE QU'ELLE EST PROPRE A CE PIPELINE
 *
 *  - LES GARDE-FOUS APPLIQUES APRES COUP. Quand le code a corrige la sortie du
 *    modele — confiance plafonnee, verdict force a `needs_human` — c'est
 *    ecrit. Un systeme qui corrige silencieusement son IA finit par ne plus
 *    savoir laquelle des deux il observe.
 * ============================================================================
 */

import { useState } from 'react';
import type { AlertCase, EnrichmentSource } from '../lib/types.ts';
import { api, ApiError, clock, humanDuration } from '../lib/api.ts';
import { Icon } from './Icon.tsx';
import { useI18n } from '../i18n/context.tsx';
import { Confidence, severityClass } from './AlertQueue.tsx';
import { Explain, Fold, Term } from './Guidance.tsx';

const SOURCE_LABEL: Record<string, string> = {
  shodan: 'Shodan',
  abuseipdb: 'AbuseIPDB',
  vt: 'VirusTotal',
};

/** Champs volontairement masques : ils dupliquent l'en-tete de la carte. */
const HIDDEN_KEYS = new Set(['status', 'source']);

function SourceCard({ name, data }: { name: string; data: EnrichmentSource | undefined }) {
  const { c } = useI18n();
  const status = data?.status ?? 'absent';
  const entries = Object.entries(data ?? {}).filter(
    ([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && v !== undefined && v !== '',
  );
  return (
    <div className={`soc-source soc-src-${status}`}>
      <div className="soc-source-head">
        <span className="soc-source-name">{SOURCE_LABEL[name] ?? name}</span>
        <span
          className={
            status === 'ok'
              ? 'soc-pill soc-pill-ok'
              : status === 'unavailable'
                ? 'soc-pill soc-pill-warn'
                : 'soc-pill soc-pill-neutral'
          }
        >
          {status}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="soc-faint" style={{ margin: 0 }}>
          {c.caseView.noSourceData}
        </p>
      ) : (
        <dl className="soc-kv">
          {entries.slice(0, 8).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Panneau de validation humaine.
 *
 * Le nom de l'approbateur est obligatoire cote serveur : une decision anonyme
 * ne serait pas une validation, juste un clic. On affiche aussi, sans le
 * cacher, que cette identite est DECLARATIVE et non authentifiee — c'est le
 * compromis assume du passage au formulaire n8n.
 */
function ApprovalPanel({ alertCase, onDone }: { alertCase: AlertCase; onDone: () => void }) {
  const { c } = useI18n();
  const a = c.caseView.approval;
  const approval = alertCase.approval!;
  const [approver, setApprover] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const execId = approval.execution_id;
  const canSubmit = approver.trim().length > 0 && Boolean(execId) && !busy;

  async function submit(decision: 'approve' | 'reject') {
    if (!execId) return;
    if (decision === 'reject' && !reason.trim()) {
      setResult({ ok: false, message: a.rejectNeedsReason });
      return;
    }
    setBusy(decision);
    setResult(null);
    try {
      const r = await api.resume(execId, { decision, approver: approver.trim(), reason: reason.trim() });
      setResult({ ok: r.ok, message: r.detail });
      if (r.ok) onDone();
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : a.sendFailed });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="soc-approval">
      <div className="soc-panel-head">
        <h3>
          <Icon name="lock" size={15} /> {a.title}
        </h3>
        <span className="soc-pill soc-pill-accent">
          {c.queue.actions[approval.requested_action] ?? approval.requested_action}
        </span>
      </div>

      <div className="soc-approval-field">
        <h4>{a.intent}</h4>
        <p>{approval.intent}</p>
      </div>
      <div className="soc-approval-field">
        <h4>{a.blast}</h4>
        <p>{approval.blast_radius}</p>
      </div>
      <div className="soc-approval-field">
        <h4>{a.rollback}</h4>
        <p>{approval.rollback_plan}</p>
      </div>
      {approval.triggers.length > 0 ? (
        <div className="soc-approval-field">
          <h4>{a.why}</h4>
          <p className="soc-muted">{approval.triggers.join(' ; ')}</p>
        </div>
      ) : null}

      {approval.outcome === 'pending' ? (
        <>
          <label className="soc-field">
            <span>{a.approver}</span>
            <input
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
              placeholder={a.approverPlaceholder}
              autoComplete="off"
            />
          </label>
          <label className="soc-field">
            <span>{a.reason}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={a.reasonPlaceholder}
            />
          </label>

          <div className="soc-actions">
            <button type="button" className="soc-primary" disabled={!canSubmit} onClick={() => submit('approve')}>
              <Icon name="check" size={15} />
              {busy === 'approve' ? a.sending : a.approve}
            </button>
            <button type="button" className="soc-secondary" disabled={!canSubmit} onClick={() => submit('reject')}>
              <Icon name="cross" size={15} />
              {busy === 'reject' ? a.sending : a.reject}
            </button>
          </div>

          <p className="soc-danger-note">{a.declarative(approval.timeout_minutes)}</p>
        </>
      ) : (
        <div className={`soc-banner ${approval.outcome === 'approved' ? 'soc-banner-ok' : 'soc-banner-warn'}`}>
          <Icon name={approval.outcome === 'approved' ? 'check' : 'alert'} size={16} />
          <p>
            <strong>
              {approval.outcome === 'approved'
                ? a.approvedBy(approval.approver?.slack_username ?? c.common.unknown)
                : approval.outcome === 'rejected'
                  ? a.rejectedBy(approval.approver?.slack_username ?? c.common.unknown)
                  : a.expired}
            </strong>
            {approval.human_reasoning ?? a.noReason}
          </p>
        </div>
      )}

      {result ? (
        <div className={`soc-banner ${result.ok ? 'soc-banner-ok' : 'soc-banner-error'}`} style={{ marginTop: 14 }}>
          <Icon name={result.ok ? 'check' : 'alert'} size={16} />
          <p>
            {result.message}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One observable, with a button that carries it to the Lookup tab.
 *
 * The value is shown whether or not it is there — `—` for absent, never a
 * hidden row: an observable a detection did not record is a fact about the
 * detection, and hiding the line would read as "this field does not exist".
 * The button only appears when there IS something to look up.
 */
function Observable({
  label, value, onLookUp,
}: { label: string; value: string | null; onLookUp?: (v: string) => void }) {
  const { c } = useI18n();
  return (
    <span>
      <b>{label}</b> {value ?? '—'}
      {value && onLookUp ? (
        <button
          type="button"
          className="soc-intel-jump"
          onClick={() => onLookUp(value)}
          title={c.intel.title}
          aria-label={`${c.intel.title}: ${value}`}
        >
          <Icon name="search" size={12} />
        </button>
      ) : null}
    </span>
  );
}

export function CaseView({
  alertCase, onRefresh, onLookUp,
}: {
  alertCase: AlertCase;
  onRefresh: () => void;
  /** Absent in tests and anywhere the Lookup tab is not reachable. */
  onLookUp?: (observable: string) => void;
}) {
  const { c: dict } = useI18n();
  const v = dict.caseView;
  const c = alertCase;
  const d = c.decision;

  return (
    <div className="soc-case-layout">
      <div>
        <section className="soc-panel">
          <div className="soc-case-head">
            <div className="soc-case-title">
              <span className={severityClass(c.severity)}>{c.severity}</span>
              <h2 style={{ margin: 0 }}>{c.rule_name}</h2>
              {c.shadow_mode ? (
                <span className="soc-shadow-badge">
                  <Term name="shadow">{dict.queue.filters.shadow}</Term>
                </span>
              ) : null}
            </div>
            <div className="soc-case-meta">
              <span>
                <b>{v.id}</b> {c.alert_id}
              </span>
              <Observable label={v.source} value={c.source_ip} onLookUp={onLookUp} />
              <Observable label={v.destination} value={c.dest_ip} onLookUp={onLookUp} />
              {/*
                Toujours affiché, tiret compris : c'est l'hôte qui désigne la
                machine qu'une isolation viserait quand l'alerte ne porte pas
                d'adresse de destination — le cas le plus courant. Masquer la
                ligne quand il est absent laisserait croire que le champ
                n'existe pas, au lieu de montrer qu'il est vide.
              */}
              <Observable label={v.host} value={c.host ?? null} onLookUp={onLookUp} />
              <span>
                <b>{v.state}</b> {dict.queue.states[c.state]}
              </span>
              <span>
                <b>{v.dwell}</b> {humanDuration(c.dwell_ms)}
              </span>
            </div>
          </div>

          {c.attack.length > 0 ? (
            <div className="soc-block">
              {/* Les techniques restent visibles : elles orientent la lecture
                  du log juste dessous. La reserve sur leur fiabilite — vraie,
                  et vraie une fois pour toutes — passe derriere le « i ». */}
              <div className="soc-titled">
                <h3>{v.attack}</h3>
                <Explain label={v.attack}>{v.attackNote}</Explain>
              </div>
              <ul className="soc-attack">
                {c.attack.map((t) => (
                  <li key={t.id}>
                    <b>{t.id}</b>
                    {t.technique}
                    <span> · {t.tactic}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            Repli ferme. Le log brut est la PIECE : on l'ouvre quand on doute
            du verdict, pas a chaque ouverture d'un cas — et deroule, il
            poussait la decision et le panneau d'approbation sous la ligne de
            flottaison. Le pli annonce sa taille, donc « aucun log recu » se
            voit sans l'ouvrir.
          */}
          <Fold
            title={v.rawLog}
            hint={c.raw_log ? v.foldBytes(c.raw_log.length) : v.noLog}
          >
            <pre className="soc-log">{c.raw_log || v.noLog}</pre>
          </Fold>

          {/*
            LES CHAMPS QUE LA CORRESPONDANCE N'A PAS SU PLACER.
            Rien n'est jete a l'ingestion — c'est la matiere premiere d'une
            decision auditee — mais ils n'atteignaient pas la fiche : le cas
            n'avait tout simplement pas de champ pour les porter. Quelqu'un qui
            branche une source le fait souvent POUR ces champs-la.

            Replie, et le pli annonce combien il y en a : c'est de la reference,
            on ne l'ouvre que quand on cherche quelque chose de precis.
          */}
          {c.extensions && Object.keys(c.extensions).length > 0 ? (
            <Fold
              title={v.extensions}
              hint={v.extensionsCount(Object.keys(c.extensions).length)}
            >
              <pre className="soc-log">{JSON.stringify(c.extensions, null, 2)}</pre>
            </Fold>
          ) : null}

          {/*
            Ouvert par defaut, et repliable : c'est le recit de ce qui s'est
            passe, donc la premiere chose qu'on lit quand quelque chose cloche
            — mais sur un cas normal on l'a deja lu, et il tient la moitie de
            la colonne.
          */}
          <Fold title={v.chain} hint={v.foldSteps(c.stages.length)} defaultOpen>
            <ul className="soc-chain">
              {c.stages.map((s) => (
                <li key={s.execution_id} className={`soc-step-${s.status}`}>
                  <div className="soc-chain-head">
                    <span className="soc-chain-wf">{s.workflow}</span>
                    <span className="soc-chain-time">
                      {clock(s.started_at)} · {humanDuration(s.duration_ms)} · exec {s.execution_id}
                    </span>
                    {s.repeat && s.repeat > 1 ? (
                      <span className="soc-pill soc-pill-warn" title={v.repeated}>
                        ×{s.repeat}
                      </span>
                    ) : null}
                  </div>
                  <p className="soc-chain-note">{s.note}</p>
                </li>
              ))}
              {c.stages.length === 0 ? <p className="soc-empty">{v.chainEmpty}</p> : null}
            </ul>
          </Fold>

          {c.enrichment ? (
            <div className="soc-block">
              {/*
                Le bandeau « renseignement incomplet » reste DEHORS, jamais
                dans le pli : c'est un constat qui limite ce que la decision
                vaut. Ce qui se replie, ce sont les fiches des sources.
              */}
              {c.enrichment_meta?.degraded ? (
                <div className="soc-banner soc-banner-warn">
                  <Icon name="alert" size={16} />
                  <p>
                    <strong>
                      <Term name="degraded">{v.degradedTitle}</Term>
                    </strong>
                    {v.degradedText(c.enrichment_meta.sources_unavailable.join(', ') || '—')}
                  </p>
                </div>
              ) : null}
              <Fold title={v.enrichment} hint={v.foldSources(3)} defaultOpen>
                <div className="soc-sources">
                  <SourceCard name="shodan" data={c.enrichment.shodan} />
                  <SourceCard name="abuseipdb" data={c.enrichment.abuseipdb} />
                  <SourceCard name="vt" data={c.enrichment.vt} />
                </div>
              </Fold>
            </div>
          ) : null}

          {c.errors.length > 0 ? (
            <div className="soc-block">
              <h3>{v.incidents}</h3>
              {c.errors.map((e, i) => (
                <div key={i} className={`soc-banner ${e.severity === 'high' ? 'soc-banner-error' : 'soc-banner-warn'}`}>
                  <Icon name="alert" size={16} />
                  <p>
                    <strong>
                      {e.error_code} · {e.workflow}
                    </strong>
                    {e.message}
                    {e.requires_replay ? <em> {v.replayRequired}</em> : null}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <div>
        {d ? (
          <section className="soc-panel">
            <span className="soc-kicker">{v.decision}</span>
            <div className="soc-verdict">
              <div className="soc-verdict-head">
                <span
                  className={
                    d.verdict === 'true_positive'
                      ? 'soc-pill soc-pill-high'
                      : d.verdict === 'false_positive'
                        ? 'soc-pill soc-pill-ok'
                        : 'soc-pill soc-pill-warn'
                  }
                >
                  {dict.queue.verdicts[d.verdict as keyof typeof dict.queue.verdicts] ?? d.verdict}
                </span>
                <Confidence value={d.confidence} />
              </div>

              <p className="soc-reasoning">{d.reasoning}</p>

              {d.data_lineage.length > 0 ? (
                <>
                  <span className="soc-kicker" style={{ marginBottom: 6 }}>
                    {v.fieldsUsed}
                  </span>
                  <ul className="soc-lineage">
                    {d.data_lineage.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="soc-faint">{v.noFields}</p>
              )}

              {d.guardrails_applied && d.guardrails_applied.length > 0 ? (
                <div className="soc-guardrail">
                  <b>{v.guardrails}</b> {d.guardrails_applied.join(' ; ')}
                  {typeof d.raw_confidence === 'number' && d.raw_confidence !== d.confidence ? (
                    <>{v.rawConfidence(d.raw_confidence.toFixed(2))}</>
                  ) : null}
                </div>
              ) : null}

              {d.is_fallback ? (
                <div className="soc-banner soc-banner-error" style={{ marginTop: 12 }}>
                  <Icon name="alert" size={16} />
                  <p>
                    <strong>
                      <Term name="fallback">{v.fallbackTitle}</Term>
                    </strong>
                    {v.fallbackText(d.decision_source || dict.common.unknown)}
                  </p>
                </div>
              ) : null}

              <div className="soc-case-meta" style={{ marginTop: 14 }}>
                <span>
                  <b>{v.engine}</b> {d.model ?? '—'}
                </span>
                <span>
                  <b>{v.attempts}</b> {d.attempts ?? '—'}
                </span>
                <span>
                  <b>{v.tokens}</b>{' '}
                  {d.usage ? (d.usage.input_tokens ?? 0) + (d.usage.output_tokens ?? 0) : '—'}
                </span>
                <span>
                  <b>{v.proposedAction}</b>{' '}
                  {dict.queue.actions[d.recommended_action] ?? d.recommended_action}
                </span>
              </div>
            </div>
          </section>
        ) : null}

        {c.approval ? (
          <section className="soc-panel">
            <ApprovalPanel alertCase={c} onDone={onRefresh} />
          </section>
        ) : null}

        <section className="soc-panel">
          <span className="soc-kicker">{v.audit}</span>
          <h3>
            <Icon name="chain" size={15} /> {v.integrity}
          </h3>
          {c.audit ? (
            c.audit.committed ? (
              <>
                <div className="soc-banner soc-banner-ok">
                  <Icon name="check" size={16} />
                  <p>
                    <strong>{v.sealedTitle(c.audit.row_id === null ? '—' : `#${c.audit.row_id}`)}</strong>
                    {v.sealedText}
                  </p>
                </div>
                {/*
                  Les deux empreintes etaient les pixels les moins rentables
                  de l'ecran : cent-vingt-huit caracteres hexadecimaux que
                  personne ne lit, et que personne ne PEUT lire — on les
                  compare, avec une machine. Le constat qui compte (« scellee »
                  ou non) reste au-dessus, en clair ; les empreintes se
                  deplient pour qui va effectivement les copier.
                */}
                <Fold title={v.hashes} hint={v.foldHashes}>
                  <span className="soc-kicker" style={{ marginBottom: 6 }}>
                    integrity_hash
                  </span>
                  <p className="soc-hash">{c.audit.integrity_hash}</p>
                  <span className="soc-kicker" style={{ margin: '10px 0 6px' }}>
                    prev_hash
                  </span>
                  <p className="soc-hash">{c.audit.prev_hash}</p>
                </Fold>
              </>
            ) : (
              <div className="soc-banner soc-banner-error">
                <Icon name="alert" size={16} />
                <p>
                  <strong>{v.noAuditTitle}</strong>
                  {c.audit.failure ? `${c.audit.failure} ` : ''}
                  {v.noAuditText}
                </p>
              </div>
            )
          ) : (
            <p className="soc-faint">{v.auditPending}</p>
          )}
        </section>
      </div>
    </div>
  );
}
