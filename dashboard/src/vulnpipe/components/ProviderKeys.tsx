/**
 * Saisie des clés de moteur.
 *
 * ============================================================================
 * POURQUOI CE BLOC EST COLLÉ À LA LISTE « ACCÈS AUX MOTEURS »
 *
 * Cette liste nommait déjà le problème — « GEMINI_API_KEY absente » — sans
 * offrir de le résoudre. Diagnostiquer sans réparer envoie faire un
 * aller-retour par un terminal et un redémarrage, à chaque fois. Les deux
 * choses se lisent donc au même endroit : ce qui manque, et le champ pour le
 * combler.
 *
 * ============================================================================
 * TROIS RÈGLES QUI SE VOIENT À L'ÉCRAN
 *
 *  1. VIDE = CONSERVE. Un champ de secret revient toujours vide : on n'affiche
 *     jamais une clé enregistrée. L'interpréter comme « efface » viderait la
 *     configuration de quiconque enregistre sans y toucher. Effacer se fait
 *     par un bouton distinct, avec confirmation.
 *
 *  2. UNE CLÉ POSÉE PAR L'ENVIRONNEMENT EST EN LECTURE SEULE, ET ON DIT
 *     POURQUOI. Le service refuse de l'écraser ; laisser le champ actif
 *     ferait saisir une valeur qui ne servirait jamais.
 *
 *  3. L'EFFET EST IMMÉDIAT. Le serveur renvoie la disponibilité recalculée :
 *     le sélecteur de moteur, juste au-dessus, cesse d'afficher « clé absente »
 *     dans la seconde. Sans cette remontée, il aurait fallu recharger la page
 *     pour croire que ça avait marché.
 * ============================================================================
 */

import { useState } from 'react';

import { api, ApiError, type KeyStatus, type ManagedKey } from '../lib/api.ts';
import { useI18n } from '../../i18n/context.tsx';
import { Icon } from './Icon.tsx';
import type { ProviderAvailability } from './ProviderSwitcher.tsx';

export function ProviderKeys({
  keys,
  onApplied,
  disabled,
}: {
  keys: KeyStatus[] | null;
  /** Remonte les clés ET la disponibilité recalculée par le serveur. */
  onApplied: (next: { keys: KeyStatus[]; available: ProviderAvailability[] }) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const s = t.settings;

  const [draft, setDraft] = useState<Partial<Record<ManagedKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!keys) return null;

  /**
   * L'adresse d'un serveur n'est PAS un secret.
   *
   * La masquer et l'annoncer comme « la clé actuelle » empêcherait de relire
   * ce qu'on vient de taper — sur une URL, c'est exactement ce qu'on veut
   * vérifier. Elle reste donc un champ texte ordinaire.
   */
  const isSecret = (name: ManagedKey) => name !== 'VULNPIPE_LLM_BASE_URL';

  const filled = Object.entries(draft).filter(([, v]) => v.trim() !== '');

  const send = async (patch: Partial<Record<ManagedKey, string | null>>) => {
    setBusy(true);
    setDone(null);
    setError(null);
    try {
      const next = await api.setProviderKeys(patch);
      onApplied(next);
      // Le brouillon est vidé : les champs redeviennent vides, comme il se
      // doit pour un secret, et la pastille passe à « renseignée ».
      setDraft({});
      setDone(s.keysSaved);
    } catch (err) {
      setError(err instanceof ApiError ? err.friendly : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (filled.length === 0) {
      setError(s.keysNothingToSave);
      setDone(null);
      return;
    }
    void send(Object.fromEntries(filled) as Partial<Record<ManagedKey, string>>);
  };

  const clear = (name: ManagedKey) => {
    const label = s.keyLabel[name] ?? name;
    // eslint-disable-next-line no-alert
    if (!window.confirm(s.keyClearConfirm(label))) return;
    void send({ [name]: null } as Partial<Record<ManagedKey, string | null>>);
  };

  return (
    <div className="vp-key-editor">
      <h4 className="vp-settings-subhead">{s.keysEditTitle}</h4>
      <p className="vp-field-help">{s.keysEditLede}</p>

      {keys.map((key) => {
        const id = `vp-key-${key.name}`;
        const label = s.keyLabel[key.name] ?? key.name;
        const state = !key.set
          ? s.keyEmpty
          : key.source === 'environment'
            ? s.keyFromEnv
            : key.source === 'dotenv'
              ? s.keyFromDotenv
              : s.keySet;

        return (
          <div className="vp-key-row" key={key.name}>
            <label htmlFor={id}>
              {label}
              <code className="vp-key-var">{key.name}</code>
              <span className={key.set ? 'vp-badge vp-badge-ok' : 'vp-badge'}>{state}</span>
            </label>

            <div className="vp-key-input">
              <input
                id={id}
                type={isSecret(key.name) ? 'password' : 'text'}
                autoComplete="new-password"
                spellCheck={false}
                disabled={disabled || busy || key.locked}
                placeholder={
                  key.locked
                    ? ''
                    : !isSecret(key.name)
                      ? s.keyPlaceholderUrl
                      : key.set
                        ? s.keyPlaceholderKeep
                        : s.keyPlaceholder
                }
                value={draft[key.name] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [key.name]: e.target.value }))}
                aria-describedby={`${id}-help`}
              />
              {/* Effacer n'a de sens que sur une clé que ce magasin gère. */}
              {key.set && key.source === 'store' && (
                <button
                  type="button"
                  className="vp-link"
                  disabled={disabled || busy}
                  onClick={() => clear(key.name)}
                >
                  {s.keyClear}
                </button>
              )}
            </div>

            <p className="vp-field-help" id={`${id}-help`}>
              {key.locked ? s.keyFromEnvHelp : (s.keyHelp[key.name] ?? '')}
            </p>
          </div>
        );
      })}

      <div className="vp-key-actions">
        <button
          type="button"
          className="vp-primary"
          onClick={save}
          disabled={disabled || busy || filled.length === 0}
        >
          <Icon name="check" size={15} />
          {busy ? s.keysSaving : s.keysSave}
        </button>
        <span className="vp-field-help">{s.keysEffect}</span>
      </div>

      {error && (
        <p className="vp-field-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="vp-field-help vp-field-note" role="status">
          {done}
        </p>
      )}
    </div>
  );
}
