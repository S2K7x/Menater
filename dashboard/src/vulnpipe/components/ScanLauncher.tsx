/**
 * Formulaire de lancement d'un scan.
 *
 * Écrit pour quelqu'un qui ne code pas : pas de `repo_path`, pas de
 * `commit_sha`, pas de `full_scan`. Des questions en français, et le
 * vocabulaire technique traduit dans l'aide de chaque champ.
 *
 * ============================================================================
 * TROIS CIBLES, UN SEUL CHAMP
 *
 * On ne demande plus « le dossier de ton projet » mais « ce que tu veux
 * vérifier », avec trois formes acceptées : un dossier, un fichier seul, ou
 * l'adresse d'un dépôt GitHub.
 *
 * Le choix de la forme se fait par des onglets plutôt que par une détection
 * silencieuse : c'est le même champ texte derrière, mais l'utilisateur voit
 * qu'il A LE DROIT de coller un lien GitHub. Une capacité que rien n'annonce
 * n'existe pas pour celui qui l'ignore.
 *
 * Le serveur, lui, reconnaît la forme tout seul (`scan-target.ts`) : les
 * onglets n'ajoutent aucune contrainte, ils ne font qu'adapter l'exemple et
 * l'aide affichés.
 * ============================================================================
 */

import { useState } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import { Icon, type IconName } from './Icon.tsx';

export type TargetKind = 'directory' | 'file' | 'github';

const TARGET_KINDS: TargetKind[] = ['directory', 'file', 'github'];
const TARGET_ICONS: Record<TargetKind, IconName> = {
  directory: 'folder',
  file: 'file',
  github: 'globe',
};

export interface ScanLauncherProps {
  onLaunch: (input: {
    target: string;
    commitSha?: string;
    mode: 'full_scan' | 'incremental_scan';
  }) => void;
  busy?: boolean;
  /** Chemin proposé par défaut (dernière cible mémorisée, ou exemple). */
  defaultPath?: string;
  /** Onglet de cible présélectionné, depuis les réglages. */
  defaultKind?: TargetKind;
  /** Étendue présélectionnée, depuis les réglages. */
  defaultMode?: 'full_scan' | 'incremental_scan';
}


export function ScanLauncher({
  onLaunch,
  busy,
  defaultPath = '',
  defaultKind = 'directory',
  defaultMode = 'full_scan',
}: ScanLauncherProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<TargetKind>(defaultKind);
  const [target, setTarget] = useState(defaultPath);
  const [mode, setMode] = useState<'full_scan' | 'incremental_scan'>(defaultMode);
  const [commitSha, setCommitSha] = useState('');
  const [touched, setTouched] = useState(false);

  const invalid = touched && target.trim().length === 0;

  return (
    <form
      className="vp-launcher"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        setTouched(true);
        if (target.trim().length === 0) return;
        onLaunch({ target: target.trim(), commitSha: commitSha.trim() || undefined, mode });
      }}
    >
      <span className="vp-kicker">{t.launcher.kicker}</span>
      <h2>{t.launcher.title}</h2>

      <div className="vp-target-tabs" role="tablist" aria-label={t.launcher.title}>
        {TARGET_KINDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={kind === id}
            className={kind === id ? 'vp-target-tab vp-target-tab-active' : 'vp-target-tab'}
            onClick={() => setKind(id)}
            disabled={busy}
          >
            <Icon name={TARGET_ICONS[id]} size={16} />
            {t.launcher.tabs[id]}
          </button>
        ))}
      </div>

      <label htmlFor="vp-target">
        <strong>{t.launcher.question[kind]}</strong>
        <span className="vp-field-help">{t.launcher.help[kind]}</span>
      </label>
      <input
        id="vp-target"
        value={target}
        placeholder={t.launcher.placeholder[kind]}
        onChange={(changeEvent) => setTarget(changeEvent.target.value)}
        onBlur={() => setTouched(true)}
        disabled={busy}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'vp-target-error' : undefined}
      />
      {invalid && (
        <p id="vp-target-error" className="vp-field-error" role="alert">
          {t.launcher.missingTarget}
        </p>
      )}

      {/* Le choix de l'étendue n'a de sens que sur un projet versionné : sur un
          fichier seul, il n'y a rien à comparer. */}
      {kind !== 'file' && (
        <fieldset className="vp-mode">
          <legend>{t.launcher.scopeLegend}</legend>

          <label className="vp-radio">
            <input
              type="radio"
              name="mode"
              checked={mode === 'full_scan'}
              onChange={() => setMode('full_scan')}
              disabled={busy}
            />
            <span>
              <strong>{t.launcher.fullTitle}</strong>
              <span className="vp-field-help">{t.launcher.fullHelp}</span>
            </span>
          </label>

          <label className="vp-radio">
            <input
              type="radio"
              name="mode"
              checked={mode === 'incremental_scan'}
              onChange={() => setMode('incremental_scan')}
              disabled={busy}
            />
            <span>
              <strong>{t.launcher.incrementalTitle}</strong>
              <span className="vp-field-help">{t.launcher.incrementalHelp}</span>
            </span>
          </label>
        </fieldset>
      )}

      {mode === 'incremental_scan' && kind !== 'file' && (
        <>
          <label htmlFor="vp-commit">
            <strong>{t.launcher.commitLabel}</strong>
            <span className="vp-field-help">{t.launcher.commitHelp}</span>
          </label>
          <input
            id="vp-commit"
            value={commitSha}
            placeholder={t.launcher.commitPlaceholder}
            onChange={(changeEvent) => setCommitSha(changeEvent.target.value)}
            disabled={busy}
          />
        </>
      )}

      <button type="submit" className="vp-primary" disabled={busy}>
        {busy ? t.launcher.submitBusy : t.launcher.submit}
      </button>
      <p className="vp-field-help">{t.launcher.reassurance}</p>
    </form>
  );
}
