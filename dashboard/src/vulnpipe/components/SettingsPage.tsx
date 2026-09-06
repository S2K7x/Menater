/**
 * Page de réglages.
 *
 * ============================================================================
 * DEUX NATURES DE RÉGLAGE, ANNONCÉES COMME TELLES
 *
 * L'écran mélangeait jusqu'ici un seul bloc — le choix des moteurs d'IA. En
 * ajoutant des préférences, on introduit une confusion possible : certains
 * réglages changent CE QUE FAIT la pipeline (donc ce qu'elle facture, pour
 * tout le monde), d'autres ne changent que CE QUE MOI je vois.
 *
 * Chaque section porte donc une étiquette explicite : « appliqué sur le
 * serveur » ou « gardé dans ce navigateur ». Sans ça, quelqu'un qui coupe
 * l'arbitrage croit régler son confort de lecture, et se retrouve avec un
 * rapport plus brut sans comprendre pourquoi.
 *
 * L'ordre suit le coût de l'erreur : moteurs et arbitrage d'abord (ils
 * engagent de l'argent), défauts du lanceur ensuite, confort de lecture après,
 * état du système à la fin.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type CacheState, type KeyStatus, type ScanSettings } from '../lib/api.ts';
import { usePreferences, type EditorTarget } from '../lib/preferences.ts';
import { useI18n } from '../../i18n/context.tsx';
import { Fold } from '../../components/Guidance.tsx';
import { Icon } from './Icon.tsx';
import { ProviderKeys } from './ProviderKeys.tsx';
import {
  ProviderSwitcher,
  type ProviderAvailability,
  type ProviderSettings,
} from './ProviderSwitcher.tsx';

export interface SettingsPageProps {
  providers: { settings: ProviderSettings; available: ProviderAvailability[] } | null;
  onProviderChange: (next: Partial<ProviderSettings>) => Promise<void>;
  /** État des clés de moteur, et de quoi le rafraîchir après une saisie. */
  keys?: KeyStatus[] | null;
  onKeysApplied?: (next: { keys: KeyStatus[]; available: ProviderAvailability[] }) => void;
  /** Un scan tourne : les réglages qui l'affecteraient en cours de route sont gelés. */
  busy?: boolean;
}

/** Interrupteur libellé, avec son explication sous le titre. */
function Toggle({
  id,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="vp-setting">
      <label className="vp-switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="vp-switch-track" aria-hidden="true">
          <span className="vp-switch-knob" />
        </span>
        <span className="vp-setting-text">
          <strong>{label}</strong>
          <span className="vp-field-help">{help}</span>
        </span>
      </label>
    </div>
  );
}

/** Étiquette de portée : serveur (engage tout le monde) ou navigateur (moi). */
function Scope({ kind }: { kind: 'server' | 'local' }) {
  const { t } = useI18n();
  return (
    <span className={`vp-scope vp-scope-${kind}`}>
      <Icon name={kind === 'server' ? 'server' : 'eye'} size={13} />
      {kind === 'server' ? t.settings.savedOnServer : t.settings.savedLocally}
    </span>
  );
}

export function SettingsPage({
  providers,
  onProviderChange,
  keys = null,
  onKeysApplied,
  busy,
}: SettingsPageProps) {
  const { t } = useI18n();
  const s = t.settings;
  const { preferences, update, reset } = usePreferences();

  const [scan, setScan] = useState<ScanSettings | null>(null);
  const [thresholds, setThresholds] = useState<{ reject_below: number; direct_alert_above: number }>({
    reject_below: 0.4,
    direct_alert_above: 0.7,
  });
  const [limits, setLimits] = useState<{ min: number; max: number }>({ min: 1, max: 16 });
  const [cache, setCache] = useState<CacheState | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [resetDone, setResetDone] = useState(false);

  /**
   * Un seul appel sert deux choses : lire les réglages ET savoir si le serveur
   * répond. Pinguer séparément ajouterait une requête pour une information
   * qu'on obtient déjà.
   */
  const load = useCallback(() => {
    setHealth('checking');
    api
      .getScanSettings()
      .then((response) => {
        setScan(response.settings);
        setThresholds(response.thresholds);
        if (response.limits) setLimits(response.limits.concurrency);
        setCache(response.cache ?? null);
        setScanError(null);
        setHealth('online');
      })
      .catch((error) => {
        setHealth('offline');
        setScanError(error instanceof ApiError ? error.friendly : (error as Error).message);
      });
  }, []);

  useEffect(load, [load]);

  const applyScan = async (next: Partial<ScanSettings>) => {
    // Optimiste : l'interrupteur bascule tout de suite, et revient en arrière
    // si le serveur refuse. Un interrupteur qui met une seconde à bouger donne
    // l'impression de ne pas avoir été cliqué.
    const previous = scan;
    setScan((current) => (current ? { ...current, ...next } : current));
    try {
      const response = await api.setScanSettings(next);
      setScan(response.settings);
      setThresholds(response.thresholds);
      if (response.limits) setLimits(response.limits.concurrency);
      setCache(response.cache ?? null);
      setScanError(null);
    } catch (error) {
      setScan(previous);
      setScanError(error instanceof ApiError ? error.friendly : (error as Error).message);
    }
  };

  const forgetCache = async () => {
    setForgetting(true);
    try {
      setCache((await api.forgetCache()).cache);
      setScanError(null);
    } catch (error) {
      setScanError(error instanceof ApiError ? error.friendly : (error as Error).message);
    } finally {
      setForgetting(false);
    }
  };

  const amount = preferences.autoConfirmUnderUsd;

  return (
    // Pas d'en-tete ici : la section hote de l'onglet Reglages porte deja le
    // titre. Deux titres empiles feraient croire a deux pages differentes.
    <div className="vp-settings vp-embed">
      {/* --- Moteurs d'IA ---------------------------------------------------- */}
      <section className="vp-settings-block">
        <Scope kind="server" />
        {providers && (
          <ProviderSwitcher
            settings={providers.settings}
            available={providers.available}
            disabled={busy}
            onChange={onProviderChange}
          />
        )}
      </section>

      {/* --- Arbitrage -------------------------------------------------------- */}
      <section className="vp-settings-block">
        <Fold title={s.arbitrationTitle} hint={<Scope kind="server" />}>
        <p className="vp-field-help">{s.arbitrationLede}</p>

        <Toggle
          id="vp-bypass"
          label={s.bypassLabel}
          help={s.bypassHelp}
          checked={scan?.bypassClaudeForHighConfidence ?? false}
          disabled={busy || scan === null}
          onChange={(next) => void applyScan({ bypassClaudeForHighConfidence: next })}
        />
        {scan?.bypassClaudeForHighConfidence && (
          <p className="vp-provider-warning" role="status">
            <Icon name="warning" size={15} />
            {s.bypassWarning}
          </p>
        )}
        {scanError && (
          <p className="vp-provider-warning" role="alert">
            {scanError}
          </p>
        )}

        {/* Vitesse d'analyse. Rangé ici, à côté du contournement d'arbitrage,
            parce que c'est le même genre d'arbitrage : ce que la pipeline FAIT
            et ce qu'elle facture, pas la façon dont l'écran l'affiche. */}
        <h4 className="vp-settings-subhead">{s.concurrencyTitle}</h4>
        <div className="vp-setting">
          <label htmlFor="vp-concurrency">
            <strong>{s.concurrencyLabel}</strong>
            <span className="vp-field-help">{s.concurrencyHelp(limits.min, limits.max)}</span>
          </label>
          <input
            id="vp-concurrency"
            type="number"
            min={limits.min}
            max={limits.max}
            step={1}
            value={scan?.detectionConcurrency ?? ''}
            disabled={busy || scan === null}
            onChange={(event) => {
              const next = Number(event.target.value);
              // On n'envoie que ce que le serveur accepterait : un champ
              // numérique passe par des états intermédiaires (vide, hors
              // bornes le temps de la frappe) qui produiraient une cascade
              // de 400 sans rien apprendre à personne.
              if (!Number.isInteger(next) || next < limits.min || next > limits.max) return;
              void applyScan({ detectionConcurrency: next });
            }}
          />
        </div>
        {scan !== null && scan.detectionConcurrency > 8 && (
          <p className="vp-provider-warning" role="status">
            <Icon name="warning" size={15} />
            {s.concurrencyWarning}
          </p>
        )}

        {/* Les seuils viennent du serveur : les recopier en dur ici les ferait
            mentir le jour où ils bougeraient. */}
        <h4 className="vp-settings-subhead">{s.thresholdsTitle}</h4>
        <p className="vp-field-help">{s.thresholdsLede}</p>
        <ul className="vp-threshold-list">
          <li className="vp-tone-green">
            <code>0.0 – {thresholds.reject_below.toFixed(1)}</code>
            <span>{t.landing.zones[0]!.title}</span>
          </li>
          <li className="vp-tone-orange">
            <code>
              {thresholds.reject_below.toFixed(1)} – {thresholds.direct_alert_above.toFixed(1)}
            </code>
            <span>{t.landing.zones[1]!.title}</span>
          </li>
          <li className="vp-tone-red">
            <code>{thresholds.direct_alert_above.toFixed(1)} – 1.0</code>
            <span>{t.landing.zones[2]!.title}</span>
          </li>
        </ul>
        </Fold>
      </section>

      {/* --- Ce qui est déjà connu --------------------------------------------
           Rendu VISIBLE à dessein. Une mémoire qu'on ne voit pas est une
           mémoire qu'on ne pense pas à vider — et c'est le premier réflexe
           quand on soupçonne un verdict figé sur du code qu'on vient de
           corriger. Tant que ces caches vivaient en RAM, redémarrer le service
           suffisait ; depuis qu'ils survivent au redémarrage, ce bouton EST
           l'échappatoire. */}
      {cache && (
        <section className="vp-settings-block">
          <Fold title={s.cacheTitle} hint={<Scope kind="server" />}>
          <p className="vp-field-help">
            {cache.persisted ? s.cachePersisted : s.cacheMemoryOnly}
          </p>

          <ul className="vp-threshold-list">
            <li>
              <code>{cache.detection.entries}</code>
              <span>{s.cacheDetection}</span>
            </li>
            <li>
              <code>{cache.arbitration.entries}</code>
              <span>{s.cacheArbitration}</span>
            </li>
            <li>
              <code>{cache.detection.hits + cache.arbitration.hits}</code>
              <span>{s.cacheHits}</span>
            </li>
          </ul>

          {/* Une reprise qui a échoué se dit. Sinon un scan « censé être
              gratuit » facture tout, et rien ne l'explique. */}
          {cache.restored
            .filter((entry) => entry.why !== null)
            .map((entry) => (
              <p key={entry.kind} className="vp-provider-warning" role="status">
                <Icon name="warning" size={15} />
                {s.cacheRestoreFailed(entry.kind, entry.why ?? '')}
              </p>
            ))}

          <p className="vp-field-help">{s.cacheForgetHelp}</p>
          <button
            type="button"
            className="vp-cache-forget"
            disabled={forgetting || busy}
            onClick={() => void forgetCache()}
          >
            {forgetting ? s.cacheForgetting : s.cacheForget}
          </button>
          </Fold>
        </section>
      )}

      {/* --- Défauts du lanceur ------------------------------------------------ */}
      <section className="vp-settings-block">
        <Fold title={s.scanTitle} hint={<Scope kind="local" />}>
        <p className="vp-field-help">{s.scanLede}</p>

        <div className="vp-setting">
          <label htmlFor="vp-default-kind">
            <strong>{s.defaultKindLabel}</strong>
            <span className="vp-field-help">{s.defaultKindHelp}</span>
          </label>
          <select
            id="vp-default-kind"
            value={preferences.defaultKind}
            onChange={(event) => update({ defaultKind: event.target.value as never })}
          >
            <option value="directory">{t.launcher.tabs.directory}</option>
            <option value="file">{t.launcher.tabs.file}</option>
            <option value="github">{t.launcher.tabs.github}</option>
          </select>
        </div>

        <div className="vp-setting">
          <label htmlFor="vp-default-mode">
            <strong>{s.defaultModeLabel}</strong>
            <span className="vp-field-help">{s.defaultModeHelp}</span>
          </label>
          <select
            id="vp-default-mode"
            value={preferences.defaultMode}
            onChange={(event) => update({ defaultMode: event.target.value as never })}
          >
            <option value="full_scan">{t.launcher.fullTitle}</option>
            <option value="incremental_scan">{t.launcher.incrementalTitle}</option>
          </select>
        </div>

        <Toggle
          id="vp-remember-target"
          label={s.rememberTargetLabel}
          help={s.rememberTargetHelp}
          checked={preferences.rememberTarget}
          onChange={(next) => update({ rememberTarget: next })}
        />
        {preferences.rememberTarget && (
          <p className="vp-remembered">
            <Icon name={preferences.lastTarget ? 'folder' : 'dot'} size={15} />
            <code>{preferences.lastTarget || s.rememberedTargetNone}</code>
            {preferences.lastTarget && (
              <button type="button" className="vp-link" onClick={() => update({ lastTarget: '' })}>
                {s.forgetTarget}
              </button>
            )}
          </p>
        )}

        <div className="vp-setting">
          <label htmlFor="vp-auto-confirm">
            <strong>{s.autoConfirmLabel}</strong>
            <span className="vp-field-help">{s.autoConfirmHelp}</span>
          </label>
          <div className="vp-inline-field">
            <input
              id="vp-auto-confirm"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={amount}
              onChange={(event) => update({ autoConfirmUnderUsd: Number(event.target.value) })}
            />
            <span className="vp-unit">$</span>
          </div>
          <p className={amount > 0 ? 'vp-field-help vp-field-note' : 'vp-field-help'}>
            {amount > 0 ? s.autoConfirmOn(`${amount.toFixed(2)} $`) : s.autoConfirmOff}
          </p>
        </div>
        </Fold>
      </section>

      {/* --- Confort de lecture ------------------------------------------------ */}
      <section className="vp-settings-block">
        <Fold title={s.displayTitle} hint={<Scope kind="local" />}>
        <p className="vp-field-help">{s.displayLede}</p>

        <Toggle
          id="vp-technical-default"
          label={s.technicalByDefaultLabel}
          help={s.technicalByDefaultHelp}
          checked={preferences.technicalByDefault}
          onChange={(next) => update({ technicalByDefault: next })}
        />
        <Toggle
          id="vp-explanations-default"
          label={s.explanationsLabel}
          help={s.explanationsHelp}
          checked={preferences.explanationsByDefault}
          onChange={(next) => update({ explanationsByDefault: next })}
        />

        <div className="vp-setting">
          <span className="vp-setting-text">
            <strong>{s.editorLabel}</strong>
            <span className="vp-field-help">{s.editorHelp}</span>
          </span>
          <select
            className="vp-select"
            aria-label={s.editorLabel}
            value={preferences.editor}
            onChange={(e) => update({ editor: e.target.value as EditorTarget })}
          >
            <option value="vscode">VS Code</option>
            <option value="cursor">Cursor</option>
            <option value="windsurf">Windsurf</option>
          </select>
        </div>

        </Fold>
      </section>

      {/* --- État du système ---------------------------------------------------- */}
      <section className="vp-settings-block">
        {/*
          L'ETAT DU SYSTEME S'OUVRE TOUT SEUL QUAND IL N'EST PAS BON.
          C'est la regle que le reste de ce produit applique deja : un pli
          porte son contenu, et ce qui n'est pas normal ne se range pas
          derriere un pli silencieux. Un moteur injoignable replie, sur la
          page ou l'on vient justement regler les moteurs, serait une panne
          qui s'affiche verte — le defaut que l'onglet Suivi existe pour
          exposer, reproduit dans les Reglages.
        */}
        {/*
          `=== 'offline'`, et non `!== 'online'`.
          Pendant la verification l'etat est « checking » : NON DETERMINE, ce
          qui n'est pas une panne. Cette console distingue quatre etats
          precisement pour ne pas confondre les deux, et ouvrir le bloc sur un
          diagnostic pas encore rendu annoncait un probleme qui n'existait
          peut-etre pas — puis se refermait quand la reponse arrivait.
        */}
        <Fold title={s.systemTitle} defaultOpen={health === 'offline'}>
        <p className="vp-field-help">{s.systemLede}</p>

        <p className={`vp-health vp-health-${health}`}>
          <Icon
            name={health === 'online' ? 'check' : health === 'offline' ? 'warning' : 'clock'}
            size={16}
          />
          <strong>{s.serverLabel}</strong>
          <span>
            {health === 'online' ? s.serverOnline : health === 'offline' ? s.serverOffline : s.serverChecking}
          </span>
          <button type="button" className="vp-link" onClick={load}>
            {s.recheck}
          </button>
        </p>

        <h4 className="vp-settings-subhead">{s.keysTitle}</h4>
        <p className="vp-field-help">{s.keysLede}</p>
        <ul className="vp-key-list">
          {(providers?.available ?? []).map((entry) => (
            <li key={entry.id} className={entry.available ? 'vp-key-ready' : undefined}>
              <Icon name={entry.available ? 'key' : 'lock'} size={15} />
              <strong>{t.providers.names[entry.id] ?? entry.id}</strong>
              <span>{entry.available ? s.keyReady : (entry.why ?? s.keyMissing)}</span>
            </li>
          ))}
        </ul>

        {/* Le champ de saisie est COLLE a la liste ci-dessus : celle-ci nomme
            ce qui manque, celui-la permet de le combler. Les separer renverrait
            chercher un terminal pour reparer ce qu'on vient de lire. */}
        {onKeysApplied && (
          <ProviderKeys keys={keys} onApplied={onKeysApplied} disabled={busy} />
        )}

        <h4 className="vp-settings-subhead">{s.resetTitle}</h4>
        <p className="vp-field-help">{s.resetHelp}</p>
        <button
          type="button"
          className="vp-secondary"
          onClick={() => {
            reset();
            setResetDone(true);
          }}
        >
          <Icon name="reset" size={15} />
          {s.reset}
        </button>
        {resetDone && (
          <p className="vp-field-help vp-field-note" role="status">
            {s.resetDone}
          </p>
        )}
        </Fold>
      </section>
    </div>
  );
}

/**
 * Enveloppe autonome des réglages d'analyse de code.
 *
 * Elle charge elle-même la liste des moteurs et leur disponibilité. La faire
 * dépendre d'un état tenu par l'onglet Code aurait obligé à ouvrir cet onglet
 * pour pouvoir changer de moteur — exactement le genre de dépendance
 * invisible qui fait croire à un réglage cassé.
 */
export function VulnPipeSettings() {
  const { locale } = useI18n();
  const [providers, setProviders] = useState<{
    settings: ProviderSettings;
    available: ProviderAvailability[];
  } | null>(null);
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rechargé quand la langue change : les motifs d'indisponibilité
  // (« clé absente ») sont rédigés côté serveur, ils doivent suivre.
  useEffect(() => {
    let alive = true;
    api
      .getProviders()
      .then((next) => {
        if (alive) setProviders(next);
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.friendly : (err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [locale]);

  // L'état des clés ne dépend PAS de la langue : ce sont des booléens et des
  // provenances, aucune phrase. Chargé une fois, il n'a pas à être relu à
  // chaque bascule de langue.
  useEffect(() => {
    let alive = true;
    api
      .getProviderKeys()
      .then((next) => {
        if (alive) setKeys(next.keys);
      })
      .catch(() => {
        // Un service d'analyse absent est déjà signalé par le bloc au-dessus :
        // un second bandeau pour la même panne ne dit rien de plus. La section
        // de saisie reste simplement masquée.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      {error && (
        <p className="vp-banner vp-banner-error" role="alert">
          {error}
        </p>
      )}
      <SettingsPage
        providers={providers}
        keys={keys}
        onKeysApplied={(next) => {
          setKeys(next.keys);
          // La disponibilité recalculée remonte jusqu'au sélecteur de moteur :
          // « clé absente » disparaît sans qu'on ait rechargé la page.
          setProviders((current) => (current ? { ...current, available: next.available } : current));
        }}
        onProviderChange={async (next) => {
          try {
            setProviders(await api.setProviders(next));
            setError(null);
          } catch (err) {
            // L'erreur remonte au composant, qui l'affiche à côté du réglage
            // fautif plutôt qu'en haut de page.
            throw new Error(err instanceof ApiError ? err.friendly : (err as Error).message);
          }
        }}
      />
    </>
  );
}
