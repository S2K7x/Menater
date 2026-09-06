/**
 * File de triage — le poste de travail principal de l'analyste.
 *
 * ============================================================================
 * CE QUE CETTE TABLE MONTRE, ET DANS QUEL ORDRE
 *
 * Les SOAR a case management natif (Cortex XSOAR, D3) traitent la file comme
 * l'ecran ou l'analyste passe sa journee, pas comme un index. Trois choix en
 * decoulent ici :
 *
 *  1. L'ETAT AVANT LE VERDICT. La premiere question n'est pas « qu'a dit le
 *     modele » mais « est-ce que ca m'attend ». Les cas bloques sur une
 *     validation humaine portent l'accent vert et remontent en tete, quelle
 *     que soit leur date.
 *
 *  2. LA CONFIANCE EST UNE BARRE, PAS UN NOMBRE. `0.83` demande une lecture ;
 *     une barre se compare d'un coup d'oeil sur quarante lignes. Le nombre
 *     reste affiche a cote pour qui veut la valeur exacte.
 *
 *  3. LE MODE SHADOW EST VISIBLE SUR CHAQUE LIGNE. Une decision en shadow mode
 *     n'a declenche aucune action. Confondre les deux, c'est croire le systeme
 *     actif alors qu'il observe — l'erreur la plus couteuse de ce projet.
 *
 * ============================================================================
 * CINQ COLONNES POUR HUIT INFORMATIONS
 *
 * La table en posait huit de front. Les six colonnes etroites ne se coupent
 * pas, donc c'est LE NOM DE LA REGLE — la seule chose qui dit de quoi il
 * s'agit — qui se pliait sur quatre lignes : 120 px de hauteur pour cinq mots
 * utiles, et une colonne de pastilles de severite qui ondulait, donc ne se
 * comparait plus.
 *
 * Rien n'a ete retire. Trois colonnes ont ete repliees dans celle qui repond
 * a la MEME question :
 *
 *   severite  → dans « alerte »   : « c'est quoi » et « c'est grave » sont
 *                                    une seule question.
 *   confiance → dans « decision » : « 0.58 » ne veut rien dire sans le verdict
 *                                    qu'il qualifie, et le verdict sans elle
 *                                    se lit comme une certitude.
 *   duree     → sous « recu »     : deux faits de temps, un seul balayage.
 *
 * Deux consequences a tenir. Les mots « severite » et « confiance » ne sont
 * plus ecrits nulle part : leur definition passe par le disque « i » de
 * l'en-tete — et, pour la severite, par le `title` de la pastille, parce que
 * quarante `Term` ouvrables dans une table couteraient quarante `<details>`.
 * Et `readability.test.tsx` reclame les trois VALEURS, pas leurs en-tetes :
 * c'est la seule facon de distinguer un regroupement d'une suppression.
 * ============================================================================
 */

import { memo, useMemo, useState } from 'react';
import type { AlertCase, CaseState, Severity } from '../lib/types.ts';
import { humanDuration, timeAgo } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Explain, Term } from './Guidance.tsx';
import { Icon } from './Icon.tsx';

/** Ordre de tri : ce qui bloque un humain d'abord, puis ce qui a casse. */
const STATE_WEIGHT: Record<CaseState, number> = {
  awaiting_approval: 0,
  failed: 1,
  decided: 2,
  enriched: 3,
  ingested: 4,
  actioned: 5,
  closed: 6,
};

/**
 * Une alerte arrivee dans les DIX DERNIERES MINUTES est « fraiche ».
 *
 * ============================================================================
 * POURQUOI CE SEUIL EXISTE, ET CE QU'IL CORRIGE
 *
 * Le tri par etat est le bon tri pour travailler : ce qui attend un humain
 * passe devant. Il est le MAUVAIS tri pour verifier qu'une alerte est bien
 * arrivee — et c'est pourtant le geste le plus frequent quand on met le
 * pipeline au point.
 *
 * En shadow mode — le mode par defaut, et tout l'interet du projet — une
 * alerte traitee de bout en bout finit `closed`, poids 6, DERNIERE. Injecter
 * une alerte de test et la voir tomber en bas du tableau, sous des cas
 * vieux de deux jours, se lit comme « elle n'est jamais arrivee ». C'est
 * exactement ce qui s'est passe sur QA-1787511982500.
 *
 * Deux corrections, pas une : la ligne fraiche remonte en tete (juste apres
 * ce qui bloque quelqu'un, qui garde la priorite), et elle porte une pastille
 * qui dit pourquoi elle est la. Un tri qui change sans le dire est pire qu'un
 * mauvais tri.
 * ============================================================================
 */
const FRESH_MS = 10 * 60_000;

type SortMode = 'priority' | 'recent';

export function severityClass(s: Severity): string {
  return `soc-pill soc-pill-${s === 'critical' ? 'critical' : s}`;
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return <span className="soc-conf-value">—</span>;
  }
  const tone = value === 0 ? 'none' : value >= 0.85 ? 'strong' : value >= 0.7 ? '' : 'weak';
  return (
    <div className="soc-conf">
      <div className={`soc-conf-bar ${tone ? `soc-conf-${tone}` : ''}`}>
        <span style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="soc-conf-value">{value.toFixed(2)}</span>
    </div>
  );
}

type Filter = 'all' | 'blocked' | 'live' | 'shadow' | 'failed';

function AlertQueueImpl({
  cases,
  selectedId,
  onSelect,
}: {
  cases: AlertCase[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // On evite de nommer une variable `c` ici : les lignes de la table sont, par
  // habitude du fichier, iterees sous ce nom.
  const dict = useI18n().c;
  const q = dict.queue;
  // Lu une fois, pas par ligne : le meme texte que le disque de l'en-tete.
  const severityHelp = dict.glossary.severity.text;
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortMode>('priority');
  const [query, setQuery] = useState('');

  // Recalcule a chaque rendu, pas fige a l'ouverture : une alerte cesse d'etre
  // fraiche toute seule, au rafraichissement suivant.
  const freshAfter = Date.now() - FRESH_MS;
  const isFresh = (c: AlertCase) => new Date(c.received_at).getTime() >= freshAfter;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cases
      .filter((c) => {
        if (filter === 'blocked' && c.state !== 'awaiting_approval') return false;
        if (filter === 'failed' && c.state !== 'failed') return false;
        if (filter === 'live' && c.shadow_mode) return false;
        if (filter === 'shadow' && !c.shadow_mode) return false;
        if (!needle) return true;
        return (
          c.alert_id.toLowerCase().includes(needle) ||
          c.rule_name.toLowerCase().includes(needle) ||
          c.source_ip.toLowerCase().includes(needle) ||
          c.dest_ip.toLowerCase().includes(needle) ||
          c.attack.some(
            (t) => t.id.toLowerCase().includes(needle) || t.technique.toLowerCase().includes(needle),
          )
        );
      })
      .sort((a, b) => {
        const recency = new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
        if (sort === 'recent') return recency;
        // Ce qui bloque un humain garde la priorite absolue : une alerte
        // fraiche ne doit pas passer devant une validation qui attend.
        const blocking = (c: AlertCase) => (c.state === 'awaiting_approval' ? 0 : 1);
        const b0 = blocking(a) - blocking(b);
        if (b0 !== 0) return b0;
        const f = Number(isFresh(b)) - Number(isFresh(a));
        if (f !== 0) return f;
        const w = STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state];
        if (w !== 0) return w;
        return recency;
      });
    // `freshAfter` est volontairement dans les dependances : il change a chaque
    // rendu, donc le tri suit le temps qui passe au lieu de figer l'ordre du
    // premier affichage.
  }, [cases, filter, query, sort, freshAfter]);

  const counts = useMemo(
    () => ({
      blocked: cases.filter((c) => c.state === 'awaiting_approval').length,
      failed: cases.filter((c) => c.state === 'failed').length,
    }),
    [cases],
  );

  return (
    <section className="soc-panel">
      <div className="soc-panel-head">
        <div>
          {/*
            La section porte le nom de ce qu'elle EST — « file de triage » —
            et non celui de l'onglet. L'en-tete de page dit deja « Alertes »
            trente pixels plus haut : le meme mot deux fois dans la meme
            colonne ne nomme rien, il oblige a verifier que ce sont bien deux
            choses differentes.
          */}
          <div className="soc-titled">
            <h2>{q.kicker}</h2>
            <Explain label={q.title}>{q.lede}</Explain>
          </div>
        </div>
        <span className="soc-faint">{q.shown(rows.length, cases.length)}</span>
      </div>

      {/*
        L'ordre de la liste n'a rien d'evident, et l'ignorer fait croire
        l'ecran casse : quelqu'un qui cherche « la derniere alerte » en haut
        ne la trouve pas. La phrase qui le dit n'a pas disparu — elle est
        passee derriere le « i » du titre, ET le selecteur de tri, lui, reste
        visible : il AFFICHE l'ordre en cours (« ce qui vous attend »), ce
        qu'un paragraphe lu une fois ne fait pas.
      */}
      <div className="soc-filters">
        {(
          [
            ['all', q.filters.all],
            ['blocked', `${q.filters.blocked}${counts.blocked ? ` (${counts.blocked})` : ''}`],
            ['failed', `${q.filters.failed}${counts.failed ? ` (${counts.failed})` : ''}`],
            ['live', q.filters.live],
            ['shadow', q.filters.shadow],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="soc-chip"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <input
          className="soc-search"
          type="search"
          placeholder={q.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={q.searchLabel}
        />
        {/* Le tri est un CHOIX, pas une constante cachee : « ce qui vous
            attend » est le bon ordre pour travailler, « ordre d'arrivee » est
            le bon ordre pour verifier qu'une alerte est bien arrivee. */}
        <label className="soc-sort">
          <span>{q.sortLabel}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
            <option value="priority">{q.sortPriority}</option>
            <option value="recent">{q.sortRecent}</option>
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="soc-empty">{cases.length === 0 ? q.emptyAll : q.empty}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="soc-queue">
            <thead>
              <tr>
                <th>{q.columns.state}</th>
                {/* La severite vit DANS cette cellule : son mot n'est plus
                    ecrit nulle part, donc l'affordance devient un disque —
                    `Term` souligne un mot present, il n'y en a plus. La
                    definition, elle, est la meme, lue dans le meme
                    catalogue. */}
                <th className="soc-col-alert">
                  {q.columns.alert} <Explain term="severity" />
                </th>
                <th>
                  {q.columns.decision} <Explain term="confidence" />
                </th>
                <th>{q.columns.action}</th>
                <th>{q.columns.received}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.alert_id}
                  aria-selected={c.alert_id === selectedId}
                  className={
                    c.state === 'awaiting_approval'
                      ? 'soc-row-blocked'
                      : isFresh(c)
                        ? 'soc-row-fresh'
                        : undefined
                  }
                  onClick={() => onSelect(c.alert_id)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(c.alert_id);
                    }
                  }}
                >
                  <td data-label={q.columns.state}>
                    <span
                      className={
                        c.state === 'awaiting_approval'
                          ? 'soc-pill soc-pill-accent'
                          : c.state === 'failed'
                            ? 'soc-pill soc-pill-failed'
                            : c.state === 'actioned'
                              ? 'soc-pill soc-pill-info'
                              : 'soc-pill soc-pill-neutral'
                      }
                    >
                      {q.states[c.state]}
                    </span>
                  </td>
                  <td data-label={q.columns.alert} className="soc-col-alert">
                    <div className="soc-row-rule">
                      {/*
                        La severite ouvre la ligne. Elle occupait une colonne
                        entiere pour cinq caracteres, et surtout elle repond a
                        la MEME question que la regle : « c'est quoi, et c'est
                        grave ? ». Deux reponses a une question se lisent
                        ensemble ou pas du tout.

                        `title` porte la definition du glossaire : quarante
                        `Term` ouvrables dans une table couteraient quarante
                        `<details>`, la ou le survol suffit — le disque de
                        l'en-tete reste la pour le clavier.
                      */}
                      <span className={severityClass(c.severity)} title={severityHelp}>
                        {c.severity}
                      </span>
                      {/* La pastille dit POURQUOI la ligne est remontee. Un
                          ordre qui change sans explication se lit comme un
                          bug. */}
                      {isFresh(c) ? (
                        <span className="soc-fresh" title={q.freshTitle}>{q.fresh}</span>
                      ) : null}
                      <span className="soc-row-name">{c.rule_name}</span>
                    </div>
                    <div className="soc-row-sub">
                      {c.alert_id} · {c.source_ip} → {c.dest_ip}
                    </div>
                  </td>
                  {/*
                    Le verdict et la confiance etaient deux colonnes, et c'est
                    une seule information : « 0.58 » ne veut rien dire sans le
                    verdict qu'il qualifie, et le verdict sans elle se lit
                    comme une certitude. Cote a cote a deux colonnes d'ecart,
                    l'oeil devait faire l'appariement lui-meme, quarante fois.
                  */}
                  <td data-label={q.columns.decision}>
                    {c.decision ? (
                      <div className="soc-cell-decision">
                        <div>{q.verdicts[c.decision.verdict as keyof typeof q.verdicts] ?? c.decision.verdict}</div>
                        {c.decision.is_fallback ? (
                          <div className="soc-row-sub" style={{ color: 'var(--orange)' }}>
                            <Term name="fallback">{q.fallbackVerdict}</Term>
                          </div>
                        ) : null}
                        <Confidence value={c.decision.confidence} />
                      </div>
                    ) : (
                      <span className="soc-faint">{q.pending}</span>
                    )}
                  </td>
                  <td data-label={q.columns.action}>
                    {c.executed ? (
                      <span className="soc-pill soc-pill-info">
                        {(c.action_taken && q.actions[c.action_taken]) ?? c.action_taken}
                      </span>
                    ) : (
                      <span className="soc-faint">{q.noAction}</span>
                    )}
                    {c.shadow_mode ? (
                      <div style={{ marginTop: 4 }}>
                        <span className="soc-shadow-badge">{q.filters.shadow}</span>
                      </div>
                    ) : null}
                  </td>
                  {/*
                    « Recu » est ce qu'on balaye ; « temps de traitement » est
                    une mesure de performance qu'on lit quand on enquete. La
                    seconde passe sous la premiere, et GARDE SON LIBELLE : une
                    duree nue a cote d'une autre duree ne dit pas de quoi elle
                    est la duree.
                  */}
                  <td className="soc-row-sub" data-label={q.columns.received}>
                    <div>
                      <Icon name="clock" size={12} /> {timeAgo(c.received_at)}
                    </div>
                    <div className="soc-cell-dwell">
                      <span>{q.columns.dwell}</span> {humanDuration(c.dwell_ms)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * La table est memoisee : elle re-rend quarante lignes, et le snapshot arrive
 * toutes les vingt secondes. Sans `memo`, ouvrir un menu ailleurs dans l'ecran
 * la reconstruisait entierement.
 */
export const AlertQueue = memo(AlertQueueImpl);
