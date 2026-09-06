/**
 * Setup: the checklist, the pipeline credentials, and the log sources.
 *
 * ============================================================================
 * WHY A CHECKLIST IS THE FIRST THING SETTINGS SHOWS
 *
 * A new install answers every screen truthfully and still does nothing, and
 * the reasons are spread across three tabs: the endpoint is closed, there is
 * no shared secret, there is no model key. Each of those is a field the
 * operator has to already know matters.
 *
 * The checklist inverts that. It states what is still missing before an alert
 * can be triaged, and each line says WHAT HAPPENS while it is missing —
 * "every alert takes the fail-safe verdict" is actionable in a way that
 * "OPENROUTER_APIKEY: absent" is not.
 *
 * It disappears when everything is in place. A permanent banner stops being
 * read, and this one has nothing left to say once the pipeline can decide.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import type {
  CredentialStatus, IngestSourcesPayload, Settings,
} from '../lib/types.ts';
import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Fold } from './Guidance.tsx';
import { Icon } from './Icon.tsx';

// --- Checklist ---------------------------------------------------------------

export interface ChecklistState {
  secret: boolean;
  mode: boolean;
  model: boolean;
  source: boolean;
}

/**
 * The four conditions, computed from what the server actually reports.
 *
 * `source` is the only one the console cannot verify: nothing tells us a Wazuh
 * manager is configured until it sends something. It is satisfied by the
 * endpoint being reachable and open — the rest is on the other machine, and
 * the sources panel is what gets the operator there.
 */
export function checklistOf(
  s: Settings,
  credentials: CredentialStatus[],
  alertsSeen: boolean,
): ChecklistState {
  return {
    secret: s.webhook.secretSet,
    mode: s.webhook.mode !== 'off',
    model: credentials.some((k) => k.required && k.set),
    source: alertsSeen,
  };
}

export function SetupChecklist({
  state,
  onGoTo,
}: {
  state: ChecklistState;
  onGoTo: (section: 'ingestion' | 'credentials') => void;
}) {
  const { c } = useI18n();
  const t = c.settings.checklist;

  const rows = [
    { key: 'secret', ok: state.secret, label: t.items.secret, hint: t.items.secretHint, go: 'ingestion' },
    { key: 'mode', ok: state.mode, label: t.items.mode, hint: t.items.modeHint, go: 'ingestion' },
    { key: 'model', ok: state.model, label: t.items.model, hint: t.items.modelHint, go: 'credentials' },
    { key: 'source', ok: state.source, label: t.items.source, hint: t.items.sourceHint, go: 'ingestion' },
  ] as const;

  const missing = rows.filter((r) => !r.ok);

  // Nothing left to say. A banner that is always on screen stops being read.
  if (missing.length === 0) {
    return (
      <section className="soc-panel soc-setup soc-setup-ready">
        <div className="soc-setup-row">
          <Icon name="check" size={16} />
          <div>
            <b>{t.ready}</b>
            <p className="soc-muted" style={{ margin: '2px 0 0' }}>{t.readyHint}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="soc-panel soc-setup">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{t.title}</span>
          <h3 style={{ margin: '2px 0 0' }}>{t.blocked(missing.length)}</h3>
        </div>
      </div>
      <ul className="soc-setup-list">
        {rows.map((r) => (
          <li key={r.key} className={r.ok ? 'soc-setup-done' : undefined}>
            <Icon name={r.ok ? 'check' : 'alert'} size={15} />
            <div className="soc-setup-text">
              <b>{r.label}</b>
              {/* The consequence, not the field name. That is the part that
                  tells an operator whether to care right now. */}
              {r.ok ? null : <span className="soc-setup-hint">{r.hint}</span>}
            </div>
            {r.ok ? null : (
              <button type="button" className="soc-secondary" onClick={() => onGoTo(r.go)}>
                {t.goto}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Credentials -------------------------------------------------------------

/**
 * The engine's keys, settable without a restart.
 *
 * Saved through their OWN endpoint, not with the rest of Settings: they live
 * in a separate 0600 store, and a key must not be rewritten by someone saving
 * a refresh interval. That is also why this panel has its own save button —
 * pretending it shares the page's draft would be a lie about what happens.
 */
export function CredentialsPanel({
  credentials,
  onSaved,
}: {
  credentials: CredentialStatus[];
  onSaved: (next: CredentialStatus[]) => void;
}) {
  const { c } = useI18n();
  const t = c.settings.credentials;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = Object.values(draft).some((v) => v !== '');
  const modelMissing = credentials.some((k) => k.required && !k.set);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Empty fields are NOT sent: empty means keep, and sending them would
      // make the server decide that for us on every save.
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(draft)) if (v !== '') patch[k] = v;
      const res = await api.saveCredentials(patch);
      onSaved(res.credentials);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="soc-panel">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{t.kicker}</span>
          <h2>{t.title}</h2>
        </div>
        <span className="soc-pill soc-pill-ok">{c.settings.effects.immediate}</span>
      </div>
      <p className="soc-muted">{t.lede}</p>

      {modelMissing ? (
        <div className="soc-banner soc-banner-warn">
          <Icon name="alert" size={16} />
          <p>{t.missingModel}</p>
        </div>
      ) : null}

      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}
      {saved ? (
        <div className="soc-banner soc-banner-ok">
          <Icon name="check" size={16} />
          <p>{t.saved}</p>
        </div>
      ) : null}

      {credentials.map((k) => (
        <label className="soc-field" key={k.env}>
          {/* `.soc-field span` is `display: block` — a descendant selector that
              dresses EVERY span under a field. A pill nested in here rendered
              as a full-width bar that looked like a second input. Prefixing
              our own class beats touching the shared rule. */}
          <span className="soc-cred-label">
            <span className="soc-cred-name">
              {k.label}{' '}
              <b style={{ color: k.set ? 'var(--green)' : k.required ? 'var(--orange)' : 'var(--faint)' }}>
                {k.set ? c.settings.secretSet : c.settings.secretEmpty}
              </b>
            </span>
            <span className={k.required ? 'soc-pill soc-pill-warn' : 'soc-pill soc-pill-info'}>
              {k.required ? t.required : t.optional}
            </span>
          </span>
          <input
            type="password"
            // READ-ONLY WHEN THE ENVIRONMENT OWNS IT. Offering an input the
            // server will refuse is worse than offering none at all.
            disabled={k.locked}
            value={draft[k.env] ?? ''}
            onChange={(e) => setDraft({ ...draft, [k.env]: e.target.value })}
            placeholder={
              k.locked ? t.lockedTitle : k.set ? c.settings.secretKeep : c.settings.secretNone
            }
            autoComplete="new-password"
          />
          <span className="soc-faint soc-help">
            {k.locked
              ? t.locked(k.env)
              : k.source === 'store'
                ? `${k.credential} — ${t.fromStore}`
                : k.credential}
          </span>
        </label>
      ))}

      <button type="button" onClick={save} disabled={busy || !dirty}>
        {busy ? c.common.loading : t.save}
      </button>
    </section>
  );
}

// --- Log sources -------------------------------------------------------------

/**
 * How to point a source at this console, generated by the server.
 *
 * The endpoint carries the address the operator reached us on, so a Wazuh
 * manager on another machine is not handed `localhost`. Retyping a URL from a
 * README is how integrations fail on a typo.
 */
export function SourcesPanel() {
  const { c } = useI18n();
  const t = c.settings.sources;
  const [data, setData] = useState<IngestSourcesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    api
      .ingestSources()
      .then((d) => {
        setData(d);
        // Whichever source needs setup, rather than the passthrough one that
        // needs none: `generic` first would open on the least useful panel.
        setPicked(d.sources.find((s) => s.source !== 'generic')?.source ?? d.sources[0]?.source ?? null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="soc-banner soc-banner-error">
        <Icon name="alert" size={16} />
        <p>{error}</p>
      </div>
    );
  }
  if (!data) return <p className="soc-empty">{c.common.loading}</p>;

  const source = data.sources.find((s) => s.source === picked) ?? data.sources[0];
  if (!source) return null;

  // NOT `.soc-sources` — that class is the enrichment grid in CaseView and
  // carries `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))`.
  // Reusing the name laid this panel out in five 257 px columns, with the
  // ossec.conf block and the mapping table shredded across them.
  return (
    <div className="soc-ingest-sources">
      <h4 className="soc-wf-subhead">{t.title}</h4>
      <p className="soc-muted">{t.lede}</p>

      <div className="soc-field">
        <span>{t.pick}</span>
        <div className="soc-lang soc-lang-wide" role="group" aria-label={t.pick}>
          {data.sources.map((s) => (
            <button
              key={s.source}
              type="button"
              onClick={() => setPicked(s.source)}
              aria-pressed={s.source === source.source}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* L'adresse reste EN CLAIR : c'est la seule chose de ce bloc qu'on
          vient chercher plusieurs fois, et c'est elle qu'on colle. */}
      <CopyLine label={t.endpoint} text={source.endpoint} />

      {/*
        La PROCEDURE se replie. Ce sont des commandes qu'on execute une fois,
        sur une AUTRE machine — pas un reglage de cette console. Depliees, le
        script d'installation et le bloc de configuration occupaient a eux
        deux plus de hauteur que tous les reglages d'ingestion reunis, et il
        fallait les depasser pour atteindre le tunnel.
      */}
      {source.setup && source.setup.install.length > 0 ? (
        <Fold title={t.install} hint={t.lines(source.setup.install.length)}>
          <CopyLine text={source.setup.install.join('\n')} />
        </Fold>
      ) : null}

      {source.setup ? (
        <Fold
          title={source.setup.configFile ? t.config(source.setup.configFile) : t.configNoFile}
          hint={t.lines(source.setup.config.split('\n').length)}
        >
          <CopyLine text={source.setup.config} />
          {source.setup.verify ? (
            <p className="soc-faint soc-help">
              <b>{t.verify}: </b>{source.setup.verify}
            </p>
          ) : null}
        </Fold>
      ) : null}

      {/*
        La table de correspondance est de la REFERENCE : douze lignes qu'on
        consulte quand un champ manque, jamais en reglant l'ingestion. Le pli
        annonce leur nombre, donc « cette source ne mappe que trois champs »
        se voit sans l'ouvrir.
      */}
      <Fold title={t.mapping} hint={t.fieldCount(Object.keys(source.fields).length)}>
        <p className="soc-muted">{t.mappingLede}</p>
        <div className="soc-table-wrap">
          <table className="soc-table soc-table-compact">
            <thead>
              <tr><th>{t.canonical}</th><th>{t.readFrom}</th></tr>
            </thead>
            <tbody>
              {Object.entries(source.fields).map(([canonical, from]) => (
                <tr key={canonical}>
                  <td data-label={t.canonical}><code>{canonical}</code></td>
                  <td data-label={t.readFrom}><code className="soc-faint">{from}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>
    </div>
  );
}

/**
 * Same copy affordance as the rest of Settings, without the import cycle.
 *
 * `label` is optional: inside a fold, the summary already carries it, and
 * printing it twice would make the fold look like it contains a second thing.
 */
function CopyLine({ label, text }: { label?: string; text: string }) {
  const { c } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="soc-panel-head" style={{ marginBottom: 8 }}>
        {label ? <span className="soc-kicker" style={{ margin: 0 }}>{label}</span> : <span />}
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
