/**
 * Sélecteur de fournisseur d'IA, à chaud.
 *
 * Fonctionnalité demandée, absente de PHASE_6. Jusqu'ici, changer de moteur
 * imposait de modifier `.env` et de relancer le serveur.
 *
 * Deux fournisseurs distincts sont exposés, conformément à `CLAUDE.md` §2 :
 * celui des détecteurs (appelé sur chaque route, donc le poste de coût) et
 * celui du master (appelé une fois, sur les cas ambigus).
 *
 * Un fournisseur sans clé est affiché DÉSACTIVÉ avec la raison, plutôt que
 * masqué : l'utilisateur doit comprendre qu'il existe et ce qui lui manque
 * pour s'en servir.
 */

import { useState } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import { Explain } from '../../components/Guidance.tsx';

export type ProviderName =
  | 'gemini'
  | 'ollama'
  | 'anthropic'
  | 'claude-subscription'
  | 'openai'
  | 'openrouter'
  | 'custom';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Niveaux proposés, du moins au plus consommateur.
 *
 * `''` = on ne force rien, le modèle applique son propre défaut. C'est le
 * premier choix de la liste parce que c'est le seul qui n'engage pas la
 * personne sur un arbitrage qu'elle n'a pas encore les moyens d'évaluer.
 */
export const EFFORT_CHOICES: (EffortLevel | '')[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ProviderSettings {
  nodeProvider: ProviderName;
  nodeModel?: string;
  nodeEffort?: EffortLevel;
  masterProvider: ProviderName;
  masterModel?: string;
  masterEffort?: EffortLevel;
}

export interface ProviderAvailability {
  id: ProviderName;
  available: boolean;
  why: string | null;
}

export interface ProviderSwitcherProps {
  settings: ProviderSettings;
  available: ProviderAvailability[];
  onChange: (next: Partial<ProviderSettings>) => Promise<void> | void;
  disabled?: boolean;
}


/**
 * Modèles conseillés, ordonnés du MOINS au PLUS consommateur.
 *
 * L'ordre porte l'information : le premier de la liste est celui qui coûte le
 * moins de jetons, le dernier celui qui en consomme le plus mais raisonne le
 * mieux. On ne parle jamais de « gratuit » ou de « payant » — ce que la
 * personne doit comprendre, c'est vers quel modèle partent ses jetons et
 * pourquoi, pas seulement si sa carte est débitée.
 */
const SUGGESTED_MODELS: Partial<Record<ProviderName, string[]>> = {
  gemini: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash'],
  openrouter: ['openrouter/free', 'openai/gpt-oss-20b:free', 'z-ai/glm-5.2:free'],
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
  // « default » = le modèle de la session Claude Code, sans rien forcer.
  'claude-subscription': ['default', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
  ollama: ['qwen3.5:9b'],
};

function ProviderSelect({
  id,
  label,
  description,
  value,
  model,
  effort,
  available,
  disabled,
  onProvider,
  onModel,
  onEffort,
}: {
  id: string;
  label: string;
  description: string;
  value: ProviderName;
  model?: string;
  effort?: EffortLevel;
  available: ProviderAvailability[];
  disabled?: boolean;
  onProvider: (next: ProviderName) => void;
  onModel: (next: string) => void;
  onEffort: (next: EffortLevel | undefined) => void;
}) {
  const { t } = useI18n();
  const current = available.find((entry) => entry.id === value);
  const suggestions = SUGGESTED_MODELS[value] ?? [];

  return (
    <div className="vp-provider-block">
      <label htmlFor={id}>
        <strong>{label}</strong>
        <span className="vp-provider-desc">{description}</span>
      </label>

      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onProvider(event.target.value as ProviderName)}
      >
        {available.map((entry) => (
          <option key={entry.id} value={entry.id} disabled={!entry.available}>
            {t.providers.names[entry.id] ?? entry.id}
            {entry.available ? '' : t.providers.keyMissing}
          </option>
        ))}
      </select>

      <p className="vp-provider-hint">{t.providers.descriptions[value]}</p>

      {current && !current.available && (
        <p className="vp-provider-warning" role="alert">
          {t.providers.cannotUse(current.why ?? '')}
        </p>
      )}

      {/*
        L'AIDE PASSE DERRIERE LE DISQUE, ET LA RAISON EST LA DUPLICATION.
        Ce formulaire est rendu DEUX FOIS sur la page — une par role, detection
        et arbitrage — donc les deux memes paragraphes de trois lignes
        s'affichaient deux fois chacun. Six lignes de prose identique autour de
        quatre champs : ce n'est plus de l'aide au choix, c'est du decor qui
        separe les champs qu'on compare.

        Le disque, lui, est rendu deux fois aussi et ne coute rien : il ouvre
        la meme phrase, lue depuis le meme catalogue, au moment ou on hesite.
      */}
      <div className="vp-label-row">
        <label htmlFor={`${id}-model`} className="vp-provider-model-label">
          {t.providers.model}
        </label>
        <Explain label={t.providers.model}>{t.providers.modelHint}</Explain>
      </div>
      <input
        id={`${id}-model`}
        list={`${id}-suggestions`}
        value={model ?? ''}
        placeholder={t.providers.modelPlaceholder}
        disabled={disabled}
        onChange={(event) => onModel(event.target.value)}
      />
      <datalist id={`${id}-suggestions`}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
      {/* Profondeur de réflexion — le levier le plus direct sur la
          consommation, donc celui qu'il faut expliquer et non juste offrir. */}
      <div className="vp-label-row">
        <label htmlFor={`${id}-effort`} className="vp-provider-model-label">
          {t.providers.effortLabel}
        </label>
        <Explain label={t.providers.effortLabel}>{t.providers.effortHint}</Explain>
      </div>
      <select
        id={`${id}-effort`}
        value={effort ?? ''}
        disabled={disabled}
        onChange={(event) =>
          onEffort(event.target.value === '' ? undefined : (event.target.value as EffortLevel))
        }
      >
        {EFFORT_CHOICES.map((level) => (
          <option key={level || 'default'} value={level}>
            {t.providers.effortNames[level || 'default']}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ProviderSwitcher({ settings, available, onChange, disabled }: ProviderSwitcherProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ProviderSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      await onChange(draft);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="vp-providers" aria-label={t.providers.heading}>
      <h3>{t.providers.heading}</h3>
      <p className="vp-field-help">{t.providers.intro}</p>

      <ProviderSelect
        id="vp-node-provider"
        label={t.providers.detectionRole}
        description={t.providers.detectionHelp}
        value={draft.nodeProvider}
        model={draft.nodeModel}
        effort={draft.nodeEffort}
        available={available}
        disabled={disabled || saving}
        onProvider={(nodeProvider) => setDraft((d) => ({ ...d, nodeProvider, nodeModel: undefined }))}
        onModel={(nodeModel) => setDraft((d) => ({ ...d, nodeModel: nodeModel || undefined }))}
        onEffort={(nodeEffort) => setDraft((d) => ({ ...d, nodeEffort }))}
      />

      <ProviderSelect
        id="vp-master-provider"
        label={t.providers.arbitrationRole}
        description={t.providers.arbitrationHelp}
        value={draft.masterProvider}
        model={draft.masterModel}
        effort={draft.masterEffort}
        available={available}
        disabled={disabled || saving}
        onProvider={(masterProvider) =>
          setDraft((d) => ({ ...d, masterProvider, masterModel: undefined }))
        }
        onModel={(masterModel) => setDraft((d) => ({ ...d, masterModel: masterModel || undefined }))}
        onEffort={(masterEffort) => setDraft((d) => ({ ...d, masterEffort }))}
      />

      {error && (
        <p className="vp-provider-warning" role="alert">
          {error}
        </p>
      )}

      <button type="button" onClick={apply} disabled={!dirty || saving || disabled}>
        {saving ? t.providers.applying : t.providers.apply}
      </button>
      {disabled && <p className="vp-provider-hint">{t.providers.lockedDuringScan}</p>}
    </section>
  );
}
