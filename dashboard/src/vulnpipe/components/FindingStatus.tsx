/**
 * Marquer une faille : corrigée, risque accepté, fausse alerte.
 *
 * La logique et les règles vivent dans `lib/finding-status.ts` ; ce fichier
 * n'est que l'écran. Deux comportements y sont néanmoins visibles et
 * volontaires :
 *
 *  - une faille écartée n'est JAMAIS retirée de la page, seulement estompée ;
 *  - une faille marquée « corrigée » que le scan détecte encore porte un
 *    avertissement. L'outil regarde le code, la case coche une intention :
 *    quand les deux se contredisent, on le dit.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import { Icon } from './Icon.tsx';
import {
  STATUSES_NEEDING_NOTE,
  findingKey,
  getStatuses,
  setStatus,
  statusOf,
  subscribeToStatuses,
  type FindingStatus as Status,
} from '../lib/finding-status.ts';

const CHOICES: Status[] = ['open', 'fixed', 'accepted', 'false_positive'];

/** Abonnement au magasin de statuts, pour que tout l'écran suive une décision. */
export function useStatuses(): ReturnType<typeof getStatuses> {
  return useSyncExternalStore(subscribeToStatuses, getStatuses, getStatuses);
}

export function FindingStatusControl({
  finding,
}: {
  finding: { vulnerability: string; http_method: string; route: string; file: string };
}) {
  const { t } = useI18n();
  const key = findingKey(finding);
  useStatuses(); // re-rend quand une décision est prise ailleurs
  const entry = statusOf(key);

  // Saisie en cours pour un statut qui exige une justification.
  const [pending, setPending] = useState<Status | null>(null);
  const [note, setNote] = useState('');
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    setNote('');
    setRefused(false);
  }, [pending]);

  const choose = (next: Status): void => {
    if (STATUSES_NEEDING_NOTE.includes(next)) {
      setPending(next);
      return;
    }
    setStatus(key, next);
    setPending(null);
  };

  const confirm = (): void => {
    if (pending === null) return;
    // `setStatus` refuse une justification vide : on affiche le refus au lieu
    // de laisser le bouton sans effet.
    if (setStatus(key, pending, note)) setPending(null);
    else setRefused(true);
  };

  const label = (status: Status): string => t.status.labels[status];

  return (
    <div className="vp-status">
      <span className="vp-status-current">
        {t.status.heading} <strong>{label(entry.status)}</strong>
      </span>

      <div className="vp-status-choices" role="group" aria-label={t.status.heading}>
        {CHOICES.filter((choice) => choice !== entry.status).map((choice) => (
          <button
            key={choice}
            type="button"
            className="vp-status-choice"
            onClick={() => choose(choice)}
          >
            {label(choice)}
          </button>
        ))}
      </div>

      {entry.status !== 'open' && entry.note.length > 0 && (
        <p className="vp-status-note">
          <Icon name="book" />
          {entry.note}
        </p>
      )}

      {pending !== null && (
        <div className="vp-status-form">
          <label htmlFor={`note-${key}`}>{t.status.noteLabel(label(pending))}</label>
          <textarea
            id={`note-${key}`}
            className="vp-status-textarea"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.status.notePlaceholder}
          />
          <div className="vp-status-form-actions">
            <button type="button" className="vp-action" onClick={confirm}>
              {t.status.confirm}
            </button>
            <button type="button" className="vp-toggle" onClick={() => setPending(null)}>
              {t.status.cancel}
            </button>
          </div>
          {refused && (
            <p className="vp-code-note" role="alert">
              {t.status.noteRequired}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Avertissement : marquée corrigée, mais le scan la voit toujours. */
export function StaleStatusNotice({
  finding,
}: {
  finding: { vulnerability: string; http_method: string; route: string; file: string };
}) {
  const { t } = useI18n();
  useStatuses();
  const entry = statusOf(findingKey(finding));
  if (entry.status !== 'fixed') return null;

  return (
    <p className="vp-banner vp-banner-error vp-status-stale" role="alert">
      {t.status.staleWarning}
    </p>
  );
}
