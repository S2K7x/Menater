/**
 * Page Reglages.
 *
 * ============================================================================
 * TROIS CATEGORIES, ET L'INTERFACE LES SEPARE VISIBLEMENT
 *
 * Le piege classique d'une page de reglages, c'est de tout presenter pareil :
 * l'utilisateur enregistre, rien ne change, et il ne sait pas pourquoi. Ici
 * chaque section porte une etiquette d'effet :
 *
 *   IMMEDIAT       — applique des l'enregistrement (connexion n8n, affichage,
 *                    verrou d'acces).
 *   REDEMARRAGE    — ecrit ici pour memoire, mais lu par le CONTENEUR n8n : il
 *                    faut coller le bloc genere dans docker-compose et
 *                    redemarrer. La console ne peut pas le faire a votre place.
 *   MANUEL         — a reporter dans une credential n8n (base de donnees).
 *
 * ============================================================================
 * LES SECRETS NE REVIENNENT JAMAIS DU SERVEUR
 *
 * Un champ secret affiche « ●●●●●● renseigne » et reste vide. Le laisser vide
 * conserve la valeur ; il faut taper quelque chose pour la remplacer. Le
 * navigateur peut donc ECRIRE une cle d'API, jamais la RELIRE — ce qui rend
 * inoffensif un onglet oublie ou un cache.
 * ============================================================================
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { Settings, SettingsPayload, TestResult } from '../lib/types.ts';
import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Icon } from './Icon.tsx';
import { Fold } from './Guidance.tsx';
import { SectionPanel, SectionTabs, type SectionTabItem } from './SectionTabs.tsx';
import type { AssistantProvider } from '../lib/types.ts';
import { McpPanel } from './McpPanel.tsx';
import { ThemePicker } from '../theme/ThemePicker.tsx';
import {
  CredentialsPanel, SetupChecklist, checklistOf,
} from './SettingsSetup.tsx';
import type { CredentialStatus, InventoryEntry } from '../lib/types.ts';

type Draft = {
  authEnabled: boolean;
  authPassword: string;
  db: Settings['database'] & { password: string };
  webhookMode: Settings['webhook']['mode'];
  webhookSecret: string;
  tunnelToken: string;
  tunnelHostname: string;
  pipeline: Settings['pipeline'];
  cons: Settings['console'];
  /**
   * NOT `Settings['assistant']`: that carries `mcpTokenSet`, a DISPLAY flag.
   * Sent back in a save it would be merged into config.json as a permanent
   * junk field that looks like a setting. The token itself is separate, for
   * the same reason every other secret is.
   */
  assistant: { enabled: boolean; provider: string; model: string; maxSteps: number; mcpEnabled: boolean };
  /** J0.3 — the service ↔ repository table, edited as a whole and saved whole. */
  inventory: InventoryDraft[];
};

/**
 * Prereglages de base : seule la TRANSFORMATION vit ici. Le libelle et
 * l'explication sont dans le catalogue, sinon la page reste francaise quand on
 * bascule en anglais.
 */
const DB_PRESETS: Record<'local' | 'supabase' | 'custom', (d: Draft['db']) => Draft['db']> = {
  local: (d) => ({ ...d, preset: 'local', host: 'localhost', port: 5432, ssl: false }),
  supabase: (d) => ({ ...d, preset: 'supabase', port: 5432, ssl: true, user: d.user || 'postgres' }),
  custom: (d) => ({ ...d, preset: 'custom' }),
};

const EFFECT_CLASS: Record<'immediate' | 'restart' | 'manual', string> = {
  immediate: 'soc-pill soc-pill-ok',
  restart: 'soc-pill soc-pill-warn',
  manual: 'soc-pill soc-pill-info',
};

function Effect({ kind }: { kind: 'immediate' | 'restart' | 'manual' }) {
  const { c } = useI18n();
  return <span className={EFFECT_CLASS[kind]}>{c.settings.effects[kind]}</span>;
}

/**
 * Case a cocher avec son explication.
 *
 * Le motif etait repete cinq fois avec le meme paquet de styles inline. Le
 * factoriser evite qu'une sixieme copie derive, et donne un seul endroit ou
 * regler la taille de cible tactile sur mobile.
 */
function CheckField({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="soc-field soc-check-field">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function SecretField({
  label,
  isSet,
  value,
  onChange,
  help,
}: {
  label: string;
  isSet: boolean;
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  const { c } = useI18n();
  return (
    <label className="soc-field">
      <span>
        {label}{' '}
        {isSet ? (
          <b style={{ color: 'var(--green)' }}>{c.settings.secretSet}</b>
        ) : (
          <b style={{ color: 'var(--orange)' }}>{c.settings.secretEmpty}</b>
        )}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isSet ? c.settings.secretKeep : c.settings.secretNone}
        autoComplete="new-password"
      />
      {help ? <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>{help}</span> : null}
    </label>
  );
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const { c } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="soc-panel-head" style={{ marginBottom: 8 }}>
        <span className="soc-kicker" style={{ margin: 0 }}>{label}</span>
        <button
          type="button"
          className="soc-secondary"
          style={{ padding: '5px 10px', fontSize: '0.72rem' }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? c.common.copied : c.common.copy}
        </button>
      </div>
      <pre className="soc-log">{text}</pre>
    </div>
  );
}

function TestButton({
  label,
  run,
}: {
  label: string;
  run: () => Promise<TestResult>;
}) {
  const { c } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  return (
    <div>
      <button
        type="button"
        className="soc-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          try {
            setResult(await run());
          } catch (err) {
            setResult({ ok: false, detail: err instanceof ApiError ? err.message : c.settings.testFailed });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="activity" size={14} />
        {busy ? c.settings.testing : label}
      </button>
      {result ? (
        <div className={`soc-banner ${result.ok ? 'soc-banner-ok' : 'soc-banner-error'}`} style={{ marginTop: 10 }}>
          <Icon name={result.ok ? 'check' : 'alert'} size={16} />
          <p>
            {result.detail}
            {result.caveat ? <><br /><span className="soc-faint">{result.caveat}</span></> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Les six domaines des Réglages.
 *
 * L'ORDRE SUIT LE COÛT DE L'ERREUR, pas l'ordre alphabétique : la connexion
 * d'abord (sans elle rien ne s'affiche), le pipeline avant la console (l'un
 * engage des actions de sécurité, l'autre le confort de lecture).
 */
type SettingsSection = 'access' | 'database' | 'pipeline' | 'console' | 'ingestion' | 'inventory' | 'credentials' | 'assistant' | 'mcp' | 'code';

/**
 * J0.3 — one row of the service inventory, as the form holds it.
 *
 * The identifiers are edited as TEXT, one per line: a list of inputs with its
 * own add and remove buttons, nested inside a list that already has them, is
 * two levels of the same widget for something people paste out of a
 * spreadsheet column.
 *
 * AND THE TEXT IS WHAT THE DRAFT STORES, not the split list. Splitting on
 * every keystroke and joining the result back into the textarea makes the
 * field fight the typist: an empty line is dropped the instant it is typed, so
 * pressing Enter does nothing and a second identifier can never be added. The
 * conversion happens once, on the way out.
 */
type InventoryDraft = { service: string; identifiers: string; repository: string };

const toInventoryDraft = (e: InventoryEntry): InventoryDraft =>
  ({ service: e.service, identifiers: e.identifiers.join('\n'), repository: e.repository });

/** Blank lines are dropped HERE and only here — everyone ends a list with one. */
const fromInventoryDraft = (d: InventoryDraft): InventoryEntry => ({
  service: d.service.trim(),
  identifiers: d.identifiers.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
  repository: d.repository.trim(),
});

function InventoryRow({
  entry, index, onChange, onRemove,
}: {
  entry: InventoryDraft;
  index: number;
  onChange: (next: InventoryDraft) => void;
  onRemove: () => void;
}) {
  const { c } = useI18n();
  const iv = c.settings.inventory;
  const id = (field: string) => `soc-inv-${index}-${field}`;
  return (
    <div className="soc-inv-row">
      <div className="soc-field">
        <label htmlFor={id('service')}>{iv.service}</label>
        <input
          id={id('service')}
          value={entry.service}
          onChange={(e) => onChange({ ...entry, service: e.target.value })}
        />
        {/* `.soc-field span` is (0,1,1): a bare class never beats it, and this
            project has paid for that four times. Name the element. */}
        <span className="soc-help">{iv.serviceHelp}</span>
      </div>
      <div className="soc-field">
        <label htmlFor={id('ids')}>{iv.identifiers}</label>
        <textarea
          id={id('ids')}
          rows={3}
          value={entry.identifiers}
          placeholder={iv.identifiersPlaceholder}
          onChange={(e) => onChange({ ...entry, identifiers: e.target.value })}
        />
        <span className="soc-help">{iv.identifiersHelp}</span>
      </div>
      <div className="soc-field">
        <label htmlFor={id('repo')}>{iv.repository}</label>
        <input
          id={id('repo')}
          value={entry.repository}
          onChange={(e) => onChange({ ...entry, repository: e.target.value })}
        />
        <span className="soc-help">{iv.repositoryHelp}</span>
      </div>
      <button type="button" className="soc-secondary soc-inv-remove" onClick={onRemove}>
        {iv.remove(entry.service)}
      </button>
    </div>
  );
}

export function SettingsPage({
  onChanged,
  codeSection,
  alertsSeen = false,
}: {
  onChanged: () => void;
  codeSection?: ReactNode;
  /** Whether a real (non-demo) alert has ever reached the console. */
  alertsSeen?: boolean;
}) {
  const { c } = useI18n();
  const st = c.settings;
  const [section, setSection] = useState<SettingsSection>('access');
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Credentials live in their own store and load on their own. `null` means
   * "not known yet" — distinct from "none set", which would make the checklist
   * accuse the operator of a missing key before it had looked.
   */
  const [credentials, setCredentials] = useState<CredentialStatus[] | null>(null);
  /**
   * The assistant's providers, and the key typed for the current one.
   *
   * The key is NOT part of `draft`: the save bar writes `config.json`, and a
   * credential goes to its own 0600 store through its own endpoint. Mixing
   * them would put a secret one wrong button away from not being saved — the
   * reason the save bar is already hidden on the Credentials section.
   */
  const [providers, setProviders] = useState<AssistantProvider[]>([]);
  const [assistantKeyDraft, setAssistantKeyDraft] = useState('');
  const [assistantKeyBusy, setAssistantKeyBusy] = useState(false);
  const [assistantKeyNote, setAssistantKeyNote] = useState<string | null>(null);

  function hydrate(p: SettingsPayload) {
    setPayload(p);
    setDraft({
      authEnabled: p.settings.auth.enabled,
      authPassword: '',
      db: { ...p.settings.database, password: '' },
      pipeline: { ...p.settings.pipeline },
      cons: { ...p.settings.console },
      assistant: {
        enabled: p.settings.assistant.enabled,
        provider: p.settings.assistant.provider,
        model: p.settings.assistant.model,
        maxSteps: p.settings.assistant.maxSteps,
        mcpEnabled: p.settings.assistant.mcpEnabled,
      },
      inventory: p.settings.inventory.entries.map(toInventoryDraft),
      webhookMode: p.settings.webhook.mode,
      webhookSecret: '',
      tunnelToken: '',
      tunnelHostname: p.settings.tunnel.hostname,
    });
  }

  useEffect(() => {
    api
      .settings()
      .then(hydrate)
      .catch((err) => setError(err instanceof ApiError ? err.message : st.loadFailed));
    // Its own request: a credential store that cannot be read must not stop
    // the rest of Settings from rendering.
    api.credentials().then((r) => setCredentials(r.credentials)).catch(() => setCredentials([]));
    // Same reasoning: the provider catalogue failing to load must not take the
    // rest of Settings down. An empty list hides the assistant's fields, which
    // is honest — we do not know what to offer.
    api.assistantProviders().then((r) => setProviders(r.providers)).catch(() => setProviders([]));
    // `st` est un objet constant par langue : le relire ne doit pas relancer la
    // requete, sinon changer de langue rechargerait les reglages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const p = await api.saveSettings({
        console: draft.cons,
        assistant: draft.assistant,
        auth: { enabled: draft.authEnabled, password: draft.authPassword },
        database: { ...draft.db, password: draft.db.password },
        pipeline: draft.pipeline,
        webhook: { mode: draft.webhookMode, secret: draft.webhookSecret },
        tunnel: { token: draft.tunnelToken, hostname: draft.tunnelHostname },
        // Wrapped, and not sent as a bare array: `config.json`'s merge spreads
        // a section, so a list stored directly would keep the entries a save
        // removed. See `server/inventory.ts`.
        inventory: { entries: draft.inventory.map(fromInventoryDraft) },
      });
      hydrate(p);
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : st.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Writes the assistant key, and only it.
   *
   * Separate from `save()` on purpose — see the state declaration above. The
   * statuses are refreshed from the response rather than re-fetched: the
   * endpoint already answers with them, and a second request would show a
   * stale "not set" for as long as it took to arrive.
   */
  async function saveAssistantKey() {
    if (!draft || !activeProvider) return;
    setAssistantKeyBusy(true);
    setAssistantKeyNote(null);
    try {
      const r = await api.saveCredentials({ [activeProvider.key_env]: assistantKeyDraft });
      setCredentials(r.credentials);
      setAssistantKeyDraft('');
      setAssistantKeyNote(st.assistantSection.keySaved);
    } catch (err) {
      setAssistantKeyNote(err instanceof ApiError ? err.message : st.saveFailed);
    } finally {
      setAssistantKeyBusy(false);
    }
  }

  if (error && !draft) {
    return (
      <section className="soc-panel">
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      </section>
    );
  }
  if (!draft || !payload) return <p className="soc-empty">{c.common.loading}</p>;

  const s = payload.settings;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  // Le commentaire du bloc a copier suit la langue : c'est du texte lu, pas
  // une commande.
  const psql = [
    'psql -f sql/05-audit-log.sql',
    'psql -f sql/06-error-log.sql',
    '# + the deduplication DDL documented in the Sticky Note of 01-Ingestion',
  ].join('\n');

  /**
   * Le brouillon diffère-t-il de ce que le serveur a renvoyé ?
   *
   * Les secrets ne comptent PAS dans la comparaison quand ils sont vides :
   * un champ de secret revient toujours vide, et le traiter comme une
   * différence aurait affiché « modifications non enregistrées » en
   * permanence — un avertissement toujours allumé ne se lit plus.
   */
  const dirty =
    draft.authEnabled !== s.auth.enabled ||
    draft.authPassword !== '' ||
    draft.db.password !== '' ||
    JSON.stringify({ ...draft.db, password: undefined }) !==
      JSON.stringify({ ...s.database, password: undefined }) ||
    JSON.stringify(draft.pipeline) !== JSON.stringify(s.pipeline) ||
    JSON.stringify(draft.cons) !== JSON.stringify(s.console) ||
    draft.assistant.enabled !== s.assistant.enabled ||
    draft.assistant.provider !== s.assistant.provider ||
    draft.assistant.model !== s.assistant.model ||
    draft.assistant.maxSteps !== s.assistant.maxSteps ||
    draft.assistant.mcpEnabled !== s.assistant.mcpEnabled ||
    // Compared on what a save would SEND: a trailing newline in the textarea
    // is not an unsaved change, and flagging it as one lights a warning that
    // never goes out.
    JSON.stringify(draft.inventory.map(fromInventoryDraft)) !== JSON.stringify(s.inventory.entries);

  /**
   * The provider currently selected, resolved against the SERVER's catalogue.
   *
   * Falls back to the first entry rather than to nothing: a `config.json`
   * naming a provider this build does not have would otherwise hide the whole
   * section, including the field that would let someone fix it.
   */
  const activeProvider = providers.find((p) => p.id === draft.assistant.provider) ?? providers[0];

  const sections: SectionTabItem<SettingsSection>[] = [
    { id: 'access', label: st.auth.title, icon: 'lock', hint: st.effects.immediate },
    { id: 'database', label: st.database.title, icon: 'database', hint: st.effects.manual },
    { id: 'pipeline', label: st.pipeline.title, icon: 'shield', hint: st.effects.restart },
    { id: 'console', label: st.console.title, icon: 'sliders', hint: st.effects.immediate },
    { id: 'ingestion', label: st.ingestion.title, icon: 'chain', hint: st.effects.immediate },
    // Next to Ingestion, and before the keys: both answer "what does this
    // console know about my estate", and this one is read the moment an alert
    // lands rather than at install time.
    { id: 'inventory', label: st.inventory.title, icon: 'code', hint: st.effects.immediate },
    { id: 'credentials', label: st.credentials.title, icon: 'lock', hint: st.effects.immediate },
    { id: 'assistant', label: st.assistantSection.title, icon: 'chat', hint: st.effects.immediate },
    { id: 'mcp', label: c.mcp.title, icon: 'chain', hint: st.effects.immediate },
  ];
  // La section d'analyse de code n'existe que si l'onglet la fournit : afficher
  // un onglet qui ouvre le vide vaut moins que ne pas l'afficher.
  if (codeSection) {
    sections.push({ id: 'code', label: st.code.title, icon: 'code', hint: st.effects.immediate });
  }

  return (
    <>
      <section className="soc-panel soc-page-head">
        <span className="soc-kicker">{c.nav.settings}</span>
        <h2>{st.title}</h2>
        <p className="soc-muted" style={{ margin: 0 }}>{st.lede}</p>
      </section>

      {/* WHAT IS STILL MISSING, before anything else on the page. The reasons
          a fresh install does nothing are spread across three tabs, and each
          is a field you have to already know matters. This states them once,
          with their consequence, and disappears when there is nothing left to
          say. */}
      {credentials === null ? null : (
        <SetupChecklist
          state={checklistOf(s, credentials, alertsSeen)}
          onGoTo={setSection}
        />
      )}

      {/* Le complément de chaque onglet annonce CE QUI SE PASSE À
          L'ENREGISTREMENT. C'était l'information principale de l'ancienne page
          d'un seul tenant : la perdre en découpant aurait fait régresser
          l'écran, on l'a donc remontée sur la navigation elle-même. */}
      <SectionTabs
        items={sections}
        active={section}
        onChange={setSection}
        label={st.sectionsLabel}
      />

      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}
      {saved ? (
        <div className="soc-banner soc-banner-ok">
          <Icon name="check" size={16} />
          <p>{st.savedNote}</p>
        </div>
      ) : null}

      {/* ---------------- Accès ---------------- */}
      <SectionPanel id="access" active={section === 'access'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.auth.kicker}</span>
            <h2>{st.auth.title}</h2>
          </div>
          <Effect kind="immediate" />
        </div>
        <p className="soc-muted">{st.auth.lede}</p>
        <div className="soc-banner soc-banner-warn">
          <Icon name="alert" size={16} />
          <p>
            <strong>{st.auth.warnTitle}</strong>
            {st.auth.warnText}
          </p>
        </div>

        <CheckField checked={draft.authEnabled} onChange={(v) => set({ authEnabled: v })}>
          {st.auth.enable}
        </CheckField>
        <SecretField
          label={st.auth.password}
          isSet={s.auth.passwordSet}
          value={draft.authPassword}
          onChange={(v) => set({ authPassword: v })}
          help={st.auth.passwordHelp}
        />
      </section>

      </SectionPanel>

      {/* ---------------- Base de données ---------------- */}
      <SectionPanel id="database" active={section === 'database'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.database.kicker}</span>
            <h2>{st.database.title}</h2>
          </div>
          <Effect kind="manual" />
        </div>
        <p className="soc-muted">{st.database.lede}</p>

        <div className="soc-filters" style={{ marginBottom: 14 }}>
          {(Object.keys(DB_PRESETS) as Array<keyof typeof DB_PRESETS>).map((key) => (
            <button
              key={key}
              type="button"
              className="soc-chip"
              aria-pressed={draft.db.preset === key}
              onClick={() => set({ db: DB_PRESETS[key]({ ...draft.db, preset: key }) })}
            >
              {st.database.presets[key].label}
            </button>
          ))}
        </div>
        <p className="soc-faint" style={{ marginTop: -6 }}>{st.database.presets[draft.db.preset].hint}</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0 14px' }}>
          <label className="soc-field">
            <span>{st.database.host}</span>
            <input value={draft.db.host} onChange={(e) => set({ db: { ...draft.db, host: e.target.value } })} />
          </label>
          <label className="soc-field">
            <span>{st.database.port}</span>
            <input
              type="number"
              value={draft.db.port}
              onChange={(e) => set({ db: { ...draft.db, port: Number(e.target.value) } })}
            />
          </label>
          <label className="soc-field">
            <span>{st.database.name}</span>
            <input value={draft.db.database} onChange={(e) => set({ db: { ...draft.db, database: e.target.value } })} />
          </label>
          <label className="soc-field">
            <span>{st.database.user}</span>
            <input value={draft.db.user} onChange={(e) => set({ db: { ...draft.db, user: e.target.value } })} />
          </label>
        </div>

        <SecretField
          label={st.database.password}
          isSet={s.database.passwordSet}
          value={draft.db.password}
          onChange={(v) => set({ db: { ...draft.db, password: v } })}
        />

        <CheckField checked={draft.db.ssl} onChange={(v) => set({ db: { ...draft.db, ssl: v } })}>
          {st.database.ssl}
        </CheckField>

        <TestButton
          label={st.database.test}
          run={() => api.testDatabase({ host: draft.db.host, port: draft.db.port })}
        />

        <div style={{ marginTop: 18 }}>
          <CopyBlock label={st.database.connectionString} text={payload.connection_string} />
        </div>
        <div style={{ marginTop: 14 }}>
          <CopyBlock label={st.database.applySchema} text={psql} />
        </div>
      </section>

      </SectionPanel>

      {/* ---------------- Pipeline ---------------- */}
      <SectionPanel id="pipeline" active={section === 'pipeline'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.pipeline.kicker}</span>
            <h2>{st.pipeline.title}</h2>
          </div>
          <Effect kind="restart" />
        </div>
        <CheckField
          checked={draft.pipeline.shadowMode}
          onChange={(v) => set({ pipeline: { ...draft.pipeline, shadowMode: v } })}
        >
          <b>{st.pipeline.shadowLabel}</b> — {st.pipeline.shadowHelp}
        </CheckField>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0 14px' }}>
          {([
            ['slackApproval', st.pipeline.slackApproval],
            ['slackEscalation', st.pipeline.slackEscalation],
            ['slackWarnings', st.pipeline.slackWarnings],
            ['slackCritical', st.pipeline.slackCritical],
          ] as const).map(([key, label]) => (
            <label className="soc-field" key={key}>
              <span>{label}</span>
              <input
                value={draft.pipeline[key]}
                onChange={(e) => set({ pipeline: { ...draft.pipeline, [key]: e.target.value } })}
              />
            </label>
          ))}
          <label className="soc-field">
            <span>{st.pipeline.ticketEndpoint}</span>
            <input
              value={draft.pipeline.ticketEndpoint}
              onChange={(e) => set({ pipeline: { ...draft.pipeline, ticketEndpoint: e.target.value } })}
              placeholder="http://mock/api/ticket"
            />
          </label>
          <label className="soc-field">
            <span>{st.pipeline.isolationEndpoint}</span>
            <input
              value={draft.pipeline.isolationEndpoint}
              onChange={(e) => set({ pipeline: { ...draft.pipeline, isolationEndpoint: e.target.value } })}
              placeholder="http://mock/api/isolate"
            />
          </label>
          <label className="soc-field">
            <span>{st.pipeline.isolationTtl}</span>
            <input
              type="number"
              value={draft.pipeline.isolationTtlMinutes}
              onChange={(e) => set({ pipeline: { ...draft.pipeline, isolationTtlMinutes: Number(e.target.value) } })}
            />
          </label>
          <label className="soc-field">
            <span>{st.pipeline.errorWindow}</span>
            <input
              type="number"
              value={draft.pipeline.errorWindowMinutes}
              onChange={(e) => set({ pipeline: { ...draft.pipeline, errorWindowMinutes: Number(e.target.value) } })}
            />
          </label>
          <label className="soc-field">
            <span>{st.pipeline.errorThreshold}</span>
            <input
              type="number"
              value={draft.pipeline.errorSystemicThreshold}
              onChange={(e) => set({ pipeline: { ...draft.pipeline, errorSystemicThreshold: Number(e.target.value) } })}
            />
          </label>
          <label className="soc-field">
            <span>{st.pipeline.errorSuppress}</span>
            <input
              type="number"
              value={draft.pipeline.errorSuppressMinutes}
              onChange={(e) => set({ pipeline: { ...draft.pipeline, errorSuppressMinutes: Number(e.target.value) } })}
            />
          </label>
        </div>

      </section>

      </SectionPanel>

      {/* ---------------- Console ---------------- */}
      <SectionPanel id="console" active={section === 'console'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.console.kicker}</span>
            <h2>{st.console.title}</h2>
          </div>
          <Effect kind="immediate" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0 14px' }}>
          <label className="soc-field">
            <span>{st.console.refresh}</span>
            <input
              type="number"
              value={draft.cons.refreshSeconds}
              onChange={(e) => set({ cons: { ...draft.cons, refreshSeconds: Number(e.target.value) } })}
            />
            <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {st.console.refreshHelp}
            </span>
            {/* Une cadence longue est un reglage legitime — mais elle explique
                a elle seule « j'ai injecte une alerte et je ne vois rien ».
                Autant le dire ici plutot que de le laisser deviner. */}
            {draft.cons.refreshSeconds > 120 ? (
              <span className="soc-warn-note">
                {st.console.refreshSlow(Math.round(draft.cons.refreshSeconds / 60))}
              </span>
            ) : null}
          </label>
          <label className="soc-field">
            <span>{st.console.window}</span>
            <input
              type="number"
              value={draft.cons.executionWindow}
              onChange={(e) => set({ cons: { ...draft.cons, executionWindow: Number(e.target.value) } })}
            />
            <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {st.console.windowHelp}
            </span>
          </label>
        </div>
        <CheckField
          checked={draft.cons.forceDemo}
          onChange={(v) => set({ cons: { ...draft.cons, forceDemo: v } })}
        >
          {st.console.forceDemo}
        </CheckField>

        {/* A browser preference, and the only one left on this screen: the
            interface is English-only, so there is no language selector to sit
            beside it any more. */}
        <ThemePicker />
      </section>

      </SectionPanel>

      {/* ---------------- Ingestion ---------------- */}
      <SectionPanel id="credentials" active={section === 'credentials'}>
        {credentials === null ? (
          <p className="soc-empty">{c.common.loading}</p>
        ) : (
          <CredentialsPanel credentials={credentials} onSaved={setCredentials} />
        )}
      </SectionPanel>

      <SectionPanel id="assistant" active={section === 'assistant'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.assistantSection.kicker}</span>
            <h2>{st.assistantSection.title}</h2>
          </div>
          <Effect kind="immediate" />
        </div>
        <p className="soc-muted">{st.assistantSection.lede}</p>

        <CheckField
          checked={draft.assistant.enabled}
          onChange={(v) => set({ assistant: { ...draft.assistant, enabled: v } })}
        >
          {st.assistantSection.enable}
        </CheckField>
        <p className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {st.assistantSection.enableHelp}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0 14px' }}>
          <label className="soc-field">
            <span>{st.assistantSection.provider}</span>
            {/* The list comes from the server. Restating it here would let the
                two drift, and a provider the interface offers but the adapter
                table does not know silently falls back to OpenRouter. */}
            <select
              value={draft.assistant.provider}
              onChange={(e) =>
                set({
                  assistant: {
                    ...draft.assistant,
                    provider: e.target.value,
                    // The model is CLEARED on a provider change, deliberately.
                    // `anthropic/claude-sonnet-4.5` is an OpenRouter name and
                    // means nothing to Anthropic; carrying it over produces a
                    // 404 that reads like a broken key. Empty means "this
                    // provider's default".
                    model: '',
                  },
                })
              }
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {st.assistantSection.providerHelp}
            </span>
          </label>

          <label className="soc-field">
            <span>{st.assistantSection.model}</span>
            <input
              value={draft.assistant.model}
              onChange={(e) => set({ assistant: { ...draft.assistant, model: e.target.value } })}
              placeholder={activeProvider?.default_model ?? ''}
            />
            <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {draft.assistant.model.trim() === '' && activeProvider
                ? st.assistantSection.modelDefault(activeProvider.default_model)
                : activeProvider?.model_hint ?? st.assistantSection.modelHelp}
            </span>
          </label>

          <label className="soc-field">
            <span>{st.assistantSection.steps}</span>
            <input
              type="number"
              value={draft.assistant.maxSteps}
              onChange={(e) => set({ assistant: { ...draft.assistant, maxSteps: Number(e.target.value) } })}
            />
            <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {st.assistantSection.stepsHelp}
            </span>
          </label>
        </div>

        {/* THE KEY LIVES ON THIS SCREEN, next to the provider it belongs to.
            It is still written to the credential store through the credentials
            endpoint — not to config.json — so the save bar below does not touch
            it, and this field has its own button saying so. Sending someone to
            another tab to fill the one field that decides whether the feature
            works at all is how a setup gets abandoned halfway. */}
        {activeProvider ? (
          <>
            <SecretField
              label={st.assistantSection.key(activeProvider.key_env)}
              isSet={
                credentials?.find((x) => x.env === activeProvider.key_env)?.set ?? false
              }
              value={assistantKeyDraft}
              onChange={setAssistantKeyDraft}
              help={st.assistantSection.keyHelp(activeProvider.label)}
            />
            {credentials?.find((x) => x.env === activeProvider.key_env)?.locked ? (
              <p className="soc-warn-note">{st.assistantSection.keyLocked}</p>
            ) : (
              <div className="soc-actions">
                <button
                  type="button"
                  className="soc-secondary"
                  onClick={saveAssistantKey}
                  disabled={assistantKeyBusy || assistantKeyDraft.trim() === ''}
                >
                  <Icon name="lock" size={15} />
                  {assistantKeyBusy ? c.common.saving : c.common.save}
                </button>
                <a
                  className="soc-secondary"
                  href={activeProvider.key_url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <Icon name="external" size={15} /> {st.assistantSection.keyGet}
                </a>
              </div>
            )}
            {assistantKeyNote ? <p className="soc-faint">{assistantKeyNote}</p> : null}
          </>
        ) : null}

        {/* WHICH KEY IT RUNS ON, said on this screen rather than left to be
            discovered when an answer fails. Only OpenRouter falls back to the
            triage key — an Anthropic key is not an OpenRouter key — and an
            operator who wanted the two budgets separated has to be able to SEE
            that they are not. */}
        {activeProvider && credentials !== null ? (
          <p
            className={
              credentials.find((x) => x.env === activeProvider.key_env)?.set
                ? 'soc-faint'
                : 'soc-warn-note'
            }
            style={{ textTransform: 'none', letterSpacing: 0 }}
          >
            {credentials.find((x) => x.env === activeProvider.key_env)?.set
              ? st.assistantSection.keyNote('provider')
              : activeProvider.id === 'openrouter'
                && credentials.find((x) => x.env === 'OPENROUTER_APIKEY')?.set
                ? st.assistantSection.keyNote('triage')
                : st.assistantSection.keyMissing(activeProvider.key_env)}
          </p>
        ) : null}

        {/* The catalogue, in the operator's words. An assistant whose limits
            are undocumented gets trusted past them — and this one reads text
            an attacker wrote. */}
        <p className="soc-muted">{st.assistantSection.reads}</p>
        <p className="soc-muted">{st.assistantSection.cannot}</p>
        <p className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {st.assistantSection.oauthNote}
        </p>
      </section>

      </SectionPanel>

      <SectionPanel id="mcp" active={section === 'mcp'}>
        {/* Its own sub-tab, not a block under the assistant. The assistant is a
            panel in this console; MCP opens the console to OTHER tools. Filing
            the second under the first hid an integration behind a feature
            nobody would think to open to find it — and it is the screen someone
            installing MENATER elsewhere needs most. */}
        <McpPanel
          settings={draft.assistant}
          onToggle={(enabled) => set({ assistant: { ...draft.assistant, mcpEnabled: enabled } })}
          busy={busy}
        />
      </SectionPanel>

      <SectionPanel id="ingestion" active={section === 'ingestion'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.ingestion.kicker}</span>
            <h2>{st.ingestion.title}</h2>
          </div>
          <Effect kind="immediate" />
        </div>
        <p className="soc-muted">{st.ingestion.lede}</p>

        {/* LE MODE D'ABORD : c'est lui qui décide si la porte est ouverte. */}
        <div className="soc-field">
          <span>{st.ingestion.mode}</span>
          <div className="soc-lang soc-lang-wide" role="group" aria-label={st.ingestion.mode}>
            {(['off', 'on'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => set({ webhookMode: m })}
                aria-pressed={draft.webhookMode === m}
              >
                {st.ingestion.modes[m]}
              </button>
            ))}
          </div>
          <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {st.ingestion.modeHelp[draft.webhookMode]}
          </span>
        </div>

        {/* Un mode ouvert sans secret est un refus, pas une ouverture : le
            dire ici plutôt que de le laisser découvrir sur un 503. */}
        {draft.webhookMode !== 'off' && !s.webhook.secretSet && draft.webhookSecret === '' ? (
          <div className="soc-banner soc-banner-warn">
            <Icon name="alert" size={16} />
            <p>{st.ingestion.noSecret}</p>
          </div>
        ) : null}

        <SecretField
          label={st.ingestion.secret}
          isSet={s.webhook.secretSet}
          value={draft.webhookSecret}
          onChange={(v) => set({ webhookSecret: v })}
          help={st.ingestion.secretHelp}
        />

        {/* THE SOURCE CATALOGUE MOVED to the Ingestion tab, and this is a
            pointer rather than a second copy of it. The same help printed
            twice is invisible in the code — one component, one string — and
            obvious on screen; and a catalogue rendered in two places is two
            places to look for the endpoint. What stays here is what this page
            SAVES: the mode, the secret and the tunnel. */}
        <p className="soc-muted">{st.ingestion.catalogueMoved}</p>

        {/*
          Le tunnel est OPTIONNEL, et il l'etait deja dans son texte : il sert
          a recevoir des alertes depuis l'exterieur du reseau. Deplie en
          permanence, il ajoutait un troisieme sujet a un ecran qui en portait
          deja deux — et il est celui qu'on ouvre le moins souvent.

          Il reste OUVERT quand un jeton est deja pose : un tunnel configure
          est un tunnel dont on veut voir l'adresse publique, et le replier
          reviendrait a cacher une porte ouverte sur Internet.
        */}
        <Fold
          title={st.ingestion.tunnelTitle}
          hint={st.ingestion.tunnelOptional}
          defaultOpen={s.tunnel.tokenSet}
        >
          <p className="soc-muted">{st.ingestion.tunnelLede}</p>

          <SecretField
            label={st.ingestion.tunnelToken}
            isSet={s.tunnel.tokenSet}
            value={draft.tunnelToken}
            onChange={(v) => set({ tunnelToken: v })}
            help={st.ingestion.tunnelTokenHelp}
          />

          <label className="soc-field">
            <span>{st.ingestion.hostname}</span>
            <input
              value={draft.tunnelHostname}
              placeholder="https://soc.exemple.com"
              onChange={(e) => set({ tunnelHostname: e.target.value })}
            />
            <span className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {st.ingestion.hostnameHelp}
            </span>
          </label>

          <CopyBlock label={st.ingestion.launch} text="npm run tunnel" />
        </Fold>
      </section>
      </SectionPanel>

      {/* ---------------- Service inventory (J0.3) ---------------- */}
      <SectionPanel id="inventory" active={section === 'inventory'}>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{st.inventory.kicker}</span>
            <h2>{st.inventory.title}</h2>
          </div>
          <Effect kind="immediate" />
        </div>
        <p className="soc-muted">{st.inventory.lede}</p>

        {/* THE EXACT-MATCH RULE STAYS IN THE CLEAR, not behind the circled
            "i". Someone who types a CIDR range here and sees nothing happen
            concludes the feature is broken; that sentence is the difference
            between a limitation and a bug. */}
        <div className="soc-banner soc-banner-info">
          <Icon name="alert" size={16} />
          <p>{st.inventory.exactOnly}</p>
        </div>

        {draft.inventory.length === 0 ? (
          <p className="soc-empty">{st.inventory.empty}</p>
        ) : (
          <>
            <p className="soc-faint">{st.inventory.count(draft.inventory.length)}</p>
            {draft.inventory.map((row, i) => (
              <InventoryRow
                // Positional key, deliberately: an entry has no id, and the
                // service name is exactly what someone is editing when they
                // type — keying on it would remount the field on every
                // keystroke and take the caret with it.
                key={i}
                entry={row}
                index={i}
                onChange={(next) => set({
                  inventory: draft.inventory.map((e, j) => (j === i ? next : e)),
                })}
                onRemove={() => set({
                  inventory: draft.inventory.filter((_, j) => j !== i),
                })}
              />
            ))}
          </>
        )}

        <div className="soc-actions">
          <button
            type="button"
            className="soc-secondary"
            onClick={() => set({
              inventory: [...draft.inventory, { service: '', identifiers: '', repository: '' }],
            })}
          >
            {st.inventory.add}
          </button>
        </div>
      </section>
      </SectionPanel>

      {/* ---------------- Analyse de code (ex-VulnPipe) ---------------- */}
      <SectionPanel id="code" active={section === 'code'}>
      {codeSection ? (
        <section className="soc-panel">
          <div className="soc-panel-head">
            <div>
              <span className="soc-kicker">{st.code.kicker}</span>
              <h2>{st.code.title}</h2>
            </div>
            <Effect kind="immediate" />
          </div>
          <p className="soc-muted">{st.code.lede}</p>
          {codeSection}
        </section>
      ) : null}
      </SectionPanel>

      {/* Collée en bas, et non reléguée sous le dernier bloc.
          DÉCOUPER LA PAGE A CRÉÉ CE BESOIN : le brouillon est commun aux six
          sections, donc une modification faite dans « Pipeline » s'enregistre
          depuis « Console ». Un bouton qui vivrait au fond d'une seule section
          laisserait croire qu'il n'enregistre que celle-là — ou pire, se
          laisserait oublier. */}
      {/* HIDDEN ON THE SECTIONS THIS BAR DOES NOT SAVE.
          It writes `config.json`, and says so. Credentials go to their own
          0600 store through their own endpoint, and the code section is
          VulnPipe's own. Showing a second, larger, primary-coloured "Save"
          that writes somewhere else — right under a panel that has its own —
          is how someone types a key, presses the wrong button, and watches it
          not be saved. */}
      <section
        className="soc-panel soc-savebar"
        hidden={section === 'credentials' || section === 'code'}
      >
        <div className="soc-actions" style={{ marginTop: 0 }}>
          <button type="button" className="soc-primary" onClick={save} disabled={busy}>
            <Icon name="check" size={15} />
            {busy ? c.common.saving : c.common.save}
          </button>
          <button type="button" className="soc-secondary" onClick={() => hydrate(payload)} disabled={busy}>
            <Icon name="refresh" size={15} /> {st.revert}
          </button>
          {/* Un brouillon modifié se perd si on quitte l'onglet Réglages : le
              dire vaut mieux que de le laisser découvrir. */}
          {dirty ? <span className="soc-savebar-dirty">{st.unsaved}</span> : null}
        </div>
        <p className="soc-faint" style={{ marginTop: 12 }}>{st.writtenTo(s.meta.config_path)}</p>
      </section>
    </>
  );
}
