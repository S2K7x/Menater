/**
 * The Ingestion tab — how alerts get in.
 *
 * ============================================================================
 * WHY THIS TAB REPLACED « WORKFLOW »
 *
 * « Workflow » named the machinery, not the question. On this product the word
 * already means three different things — the n8n editor, the six sub-workflows,
 * and the built-in engine — so someone looking for « how do my alerts reach
 * this console » had no reason to click it, and someone who did click it found
 * a graph rather than an answer.
 *
 * A tab name is the only navigation help anyone gets before clicking. This one
 * names the question. The graph and the pipeline variables are NOT deleted:
 * they are the tab's third section, which is where they belong — « what
 * happens after an alert arrives » is the same story, one step later.
 *
 * ============================================================================
 * THREE SECTIONS, IN THE ORDER SOMEONE ACTUALLY NEEDS THEM
 *
 *   Delivery — which transport carries which alert, and why. The choice.
 *   Sources  — where alerts come from, and the snippet to point each at us.
 *   Pipeline — what runs once one arrives. The graph, unchanged.
 *
 * ============================================================================
 * THE ONE THING THIS SCREEN MUST NOT DO
 *
 * It must not make the recommended architecture look like the only one. The
 * hybrid is the default because of a trade-off — push is fast and loses what
 * the sender fails to retry, pull is late and loses nothing — and a screen that
 * hid that trade-off would leave someone unable to tell whether their install
 * is one of the ones where it does not hold. Each option carries the sentence
 * that would make somebody choose it, and the sentence that would make them
 * not.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Icon } from './Icon.tsx';
import { Explain, Fold, PageHead } from './Guidance.tsx';
import { SectionPanel, SectionTabs } from './SectionTabs.tsx';
import { SourcesPanel } from './SettingsSetup.tsx';
import { WorkflowPanel } from './WorkflowPanel.tsx';
import {
  PRIORITY_LABEL, SEVERITY_ORDER,
  type Cursor, type DeliveryMode, type IngestionPayload, type PollOutcome,
  type PullSource, type Severity,
} from '../lib/ingestion.ts';

type Section = 'delivery' | 'sources' | 'pipeline';

/**
 * A field that saves when you LEAVE it, not while you type in it.
 *
 * ============================================================================
 * THE DEFECT THIS EXISTS FOR
 *
 * Every field on this screen wrote straight to `onChange`, and this screen
 * saves on change by design — there is no draft, because the lane table below
 * must never describe a policy that is not the one running. Both halves were
 * defensible; together they meant:
 *
 *   - typing `120` into the interval field sent THREE saves, and each save
 *     restarted the poller and fired an immediate poll. Three real requests to
 *     somebody's SIEM in under a second, from typing a number;
 *   - the server clamps the interval to a 15 s floor, so the `1` you typed
 *     came back as `15` and fought your cursor mid-word;
 *   - typing a URL sent one save per character, and each response re-rendered
 *     the input from the server's copy.
 *
 * The poller no longer polls on every re-sync (see `sync()` in `poller.ts`).
 * This is the other half: the value is local while the field has focus, and is
 * committed on blur or on Enter. Escape restores what was there.
 *
 * IT STILL SAVES IMMEDIATELY, on commit. This is not a draft creeping back in
 * — there is no save button, nothing is held pending, and leaving the field is
 * an unambiguous "I am done with this one".
 * ============================================================================
 */
function CommittedInput({
  value, onCommit, type = 'text', placeholder, min, max, disabled,
}: {
  value: string | number;
  onCommit: (next: string) => void;
  type?: 'text' | 'number';
  placeholder?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // ESCAPE HAS TO SURVIVE THE BLUR IT CAUSES, and state does not.
  //
  // Written as `setDraft(null); blur()`, Escape saved anyway: React had not
  // re-rendered by the time `onBlur` ran, so `commit` closed over the value
  // the user had just abandoned and sent it. A ref is read at the instant
  // `onBlur` executes, which is the instant that matters.
  const abandoned = useRef(false);
  const shown = draft ?? String(value);

  const commit = () => {
    if (abandoned.current) { abandoned.current = false; return; }
    if (draft === null) return;
    setDraft(null);
    // Unchanged means no request. A save that writes the same bytes still
    // costs a round trip and a re-render, and on this screen it also touches
    // the poller.
    if (draft !== String(value)) onCommit(draft);
  };

  return (
    <input
      type={type}
      value={shown}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        // Escape abandons the edit. Without it the only way out of a
        // half-typed value is to finish typing something valid.
        if (e.key === 'Escape') { abandoned.current = true; setDraft(null); e.currentTarget.blur(); }
      }}
    />
  );
}

/**
 * A duration between now and `iso`, in the console's usual words.
 *
 * Unsigned on purpose: it is used both for "3 min ago" and for "in 3 min", and
 * the direction is carried by the sentence around it rather than by a sign
 * nobody reads. `null` stays « never ».
 */
function ago(iso: string | null, never: string): string {
  if (!iso) return never;
  const ms = Math.abs(Date.now() - Date.parse(iso));
  if (!Number.isFinite(ms)) return never;
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/**
 * One of the three architectures, as a card you can pick.
 *
 * The COST line is not optional decoration. A card that listed only benefits
 * would be an advertisement for whichever option we wrote first, and the whole
 * reason this screen exists is that the right answer depends on the install.
 */
function DeliveryCard({
  mode, active, onPick, title, when, cost, recommended,
}: {
  mode: DeliveryMode;
  active: boolean;
  onPick: (m: DeliveryMode) => void;
  title: string;
  when: string;
  cost: string;
  recommended: boolean;
}) {
  const { c } = useI18n();
  return (
    <button
      type="button"
      className="soc-ing-card"
      aria-pressed={active}
      onClick={() => onPick(mode)}
    >
      <span className="soc-ing-card-head">
        <Icon name={active ? 'check' : 'chip'} size={15} />
        <strong>{title}</strong>
        {recommended ? <em className="soc-ing-reco">{c.ingestion.recommended}</em> : null}
      </span>
      <span className="soc-ing-card-when">{when}</span>
      {/* The trade-off, in the clear and never behind a fold. A cost you have
          to open something to read is a cost nobody reads. */}
      <span className="soc-ing-card-cost">{cost}</span>
    </button>
  );
}

/** The lane table: one row per priority, the transport it takes, and why. */
function LaneTable({ data }: { data: IngestionPayload }) {
  const { c } = useI18n();
  const t = c.ingestion;
  return (
    <div className="soc-table-wrap">
      <table className="soc-table soc-table-compact">
        <thead>
          <tr>
            <th>{t.lanes.priority}</th>
            <th>{t.lanes.severity}</th>
            <th>
              {t.lanes.transport} <Explain term="transport" />
            </th>
            <th>{t.lanes.latency}</th>
          </tr>
        </thead>
        <tbody>
          {SEVERITY_ORDER.map((sev) => {
            const lane = data.lanes[sev];
            return (
              <tr key={sev}>
                <td data-label={t.lanes.priority}><strong>{PRIORITY_LABEL[sev]}</strong></td>
                <td data-label={t.lanes.severity}>{t.severity[sev]}</td>
                <td data-label={t.lanes.transport}>
                  {lane === 'fast' ? t.push.transport : t.pull.transport}
                </td>
                {/* THE NUMBER IS HALF THE INTERVAL, not the interval. Quoting
                    the interval would overstate the delay by a factor of two,
                    and this number is the one someone weighs a P1 against. */}
                <td data-label={t.lanes.latency}>
                  {lane === 'fast'
                    ? t.lanes.seconds
                    : t.lanes.averageDelay(Math.round(data.policy.pull.intervalSeconds / 2))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One polled source: its address, its credential, and what its last poll did. */
function PullSourceRow({
  src, cursor, outcome, onChange, onRemove,
}: {
  src: PullSource;
  cursor: Cursor | undefined;
  outcome: PollOutcome | undefined;
  onChange: (next: PullSource) => void;
  onRemove: () => void;
}) {
  const { c } = useI18n();
  const t = c.ingestion;
  const error = outcome?.error ?? cursor?.lastError ?? null;
  const nextAt = outcome?.nextAttemptAt ?? cursor?.nextAttemptAt ?? null;
  // Only while it is still in the future: a stale instant would read as a
  // source being held back when the next tick will in fact try it.
  const waitingUntil = nextAt && Date.parse(nextAt) > Date.now() ? nextAt : null;
  return (
    <div className="soc-ing-source">
      <div className="soc-ing-source-head">
        <label className="soc-field soc-ing-source-name">
          <span>{t.pull.sourceName}</span>
          <CommittedInput
            value={src.source}
            onCommit={(v) => onChange({ ...src, source: v })}
            placeholder="wazuh"
          />
          <span className="soc-help">{t.pull.sourceNameHelp}</span>
        </label>
        <label className="soc-ing-toggle">
          <input
            type="checkbox"
            checked={src.enabled}
            onChange={(e) => onChange({ ...src, enabled: e.target.checked })}
          />
          <span>{t.pull.enabled}</span>
        </label>
        <button type="button" className="soc-secondary" onClick={onRemove}>
          <Icon name="cross" size={14} /> {t.pull.remove}
        </button>
      </div>

      <label className="soc-field">
        <span>{t.pull.url}</span>
        <CommittedInput
          value={src.url}
          onCommit={(v) => onChange({ ...src, url: v })}
          placeholder="https://siem.example.com/api/alerts"
        />
        <span className="soc-help">{t.pull.urlHelp(src.cursorParam || 'since')}</span>
      </label>

      {/* FOLDED, because these four have a working default and the address does
          not. A first source is one field; a source with an unusual shape opens
          the fold. `hint` says what is inside, per the fold rule. */}
      <Fold title={t.pull.advanced} hint={t.pull.advancedHint}>
        <label className="soc-field">
          <span>{t.pull.cursorParam}</span>
          <CommittedInput
            value={src.cursorParam}
            onCommit={(v) => onChange({ ...src, cursorParam: v })}
            placeholder="since"
          />
          <span className="soc-help">{t.pull.cursorParamHelp}</span>
        </label>
        <label className="soc-field">
          <span>{t.pull.itemsPath}</span>
          <CommittedInput
            value={src.itemsPath}
            onCommit={(v) => onChange({ ...src, itemsPath: v })}
            placeholder="data.alerts"
          />
          <span className="soc-help">{t.pull.itemsPathHelp}</span>
        </label>
        <label className="soc-field">
          <span>{t.pull.authHeader}</span>
          <CommittedInput
            value={src.authHeader}
            onCommit={(v) => onChange({ ...src, authHeader: v })}
            placeholder="Authorization"
          />
        </label>
        <label className="soc-field">
          <span>{t.pull.authCredential}</span>
          <CommittedInput
            value={src.authCredential}
            onCommit={(v) => onChange({ ...src, authCredential: v })}
            placeholder="SHODAN_APIKEY"
          />
          {/* THE NAME, NEVER THE VALUE. Same rule as everywhere else in this
              product: a secret does not travel to the browser, and it does not
              travel back out of a form either. */}
          <span className="soc-help">{t.pull.authCredentialHelp}</span>
        </label>
      </Fold>

      {/* THE STATE STAYS ON SCREEN. A source that has never answered, or that
          has been refusing us for an hour, is exactly the failure the Tracking
          tab exists to expose — filing it behind a fold would rebuild that
          defect here. */}
      <div className={error ? 'soc-banner soc-banner-error' : 'soc-quiet soc-quiet-ok'}>
        <Icon name={error ? 'alert' : 'check'} size={15} />
        <p>
          {error
            ? t.pull.lastError(error)
            : t.pull.lastOk(cursor?.received ?? 0, ago(cursor?.lastPollAt ?? null, t.pull.never))}
          {/* THE BACKOFF IS SAID, NOT JUST APPLIED. A source the poller has
              decided to skip for eight minutes, with nothing on screen to say
              so, is indistinguishable from a poller that has stopped working —
              and someone would sit watching a row that will not move. It sits
              INSIDE the error banner because it is part of the same fact. */}
          {waitingUntil ? ` ${t.pull.backingOff(ago(waitingUntil, t.pull.never))}` : ''}
        </p>
      </div>
      {outcome && outcome.unusable > 0 ? (
        <p className="soc-muted">{t.pull.unusable(outcome.unusable)}</p>
      ) : null}
    </div>
  );
}

export function IngestionPanel({ onGuide }: { onGuide?: () => void }) {
  const { c } = useI18n();
  const t = c.ingestion;
  const [section, setSection] = useState<Section>('delivery');
  const [data, setData] = useState<IngestionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.ingestionPolicy());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Saves immediately, and re-reads what the server actually kept.
   *
   * NO DRAFT AND NO SAVE BAR HERE, unlike Settings. Every control on this
   * screen is a single decision with a visible consequence — a mode, a
   * checkbox, an interval — and the server bounds what it accepts. Holding
   * them in a draft would mean the lane table on screen described a policy
   * that is not the one running, which is the one thing this tab cannot do.
   */
  const save = useCallback(async (patch: Parameters<typeof api.saveIngestionPolicy>[0]) => {
    setBusy(true);
    try {
      await api.saveIngestionPolicy(patch);
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const pollNow = useCallback(async () => {
    setPolling(true);
    try {
      await api.pollNow();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  }, [load]);

  const policy = data?.policy;
  const sources = policy?.pull.sources ?? [];
  const cursors = data?.state.cursors ?? {};
  const outcomes = new Map((data?.state.last ?? []).map((o) => [o.source, o]));
  const failing = sources.filter(
    (s) => s.enabled && (outcomes.get(s.source)?.error ?? cursors[s.source]?.lastError),
  ).length;

  return (
    <>
      <PageHead kicker={t.kicker} title={t.title} lede={t.lede} onGuide={onGuide} />

      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}

      <SectionTabs
        label={c.nav.sections}
        active={section}
        onChange={setSection}
        items={[
          { id: 'delivery', label: t.sections.delivery, icon: 'chain', hint: t.sections.deliveryHint },
          {
            id: 'sources',
            label: t.sections.sources,
            icon: 'chip',
            hint: t.sections.sourcesHint,
            // THE COUNTER STAYS ON THE CLOSED TAB. A source that stopped
            // answering, hidden behind a tab that looks calm, is a failure
            // showing green.
            count: failing,
            alert: failing > 0,
          },
          { id: 'pipeline', label: t.sections.pipeline, icon: 'book', hint: t.sections.pipelineHint },
        ]}
      />

      {/* --------------------------- Delivery --------------------------- */}
      <SectionPanel id="delivery" active={section === 'delivery'}>
        <section className="soc-panel">
          <h2>{t.choose}</h2>
          <p className="soc-muted">{t.chooseLede}</p>

          <div className="soc-ing-cards">
            <DeliveryCard
              mode="hybrid"
              recommended
              active={policy?.delivery === 'hybrid'}
              onPick={(m) => void save({ delivery: m })}
              title={t.hybrid.title}
              when={t.hybrid.when}
              cost={t.hybrid.cost}
            />
            <DeliveryCard
              mode="push"
              recommended={false}
              active={policy?.delivery === 'push'}
              onPick={(m) => void save({ delivery: m })}
              title={t.push.title}
              when={t.push.when}
              cost={t.push.cost}
            />
            <DeliveryCard
              mode="pull"
              recommended={false}
              active={policy?.delivery === 'pull'}
              onPick={(m) => void save({ delivery: m })}
              title={t.pull.title}
              when={t.pull.when}
              cost={t.pull.cost}
            />
          </div>

          {data ? <LaneTable data={data} /> : <p className="soc-muted">{c.common.loading}</p>}

          {/* NOTHING IS EVER REFUSED FOR BEING ON THE WRONG LANE. Said here
              because the table above reads like a routing rule, and someone
              would reasonably fear that pointing a P4 source at the webhook
              silently drops it. */}
          <div className="soc-quiet soc-quiet-ok">
            <Icon name="check" size={15} />
            <p>{t.neverDropped}</p>
          </div>

          {policy?.delivery === 'hybrid' ? (
            <div className="soc-field">
              <span>{t.fastLaneLabel}</span>
              <div className="soc-lang soc-lang-wide" role="group" aria-label={t.fastLaneLabel}>
                {SEVERITY_ORDER.map((sev) => {
                  const on = policy.fastLane.includes(sev);
                  return (
                    <button
                      key={sev}
                      type="button"
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() => void save({
                        fastLane: on
                          ? policy.fastLane.filter((s) => s !== sev)
                          : ([...policy.fastLane, sev] as Severity[]),
                      })}
                    >
                      {PRIORITY_LABEL[sev]} · {t.severity[sev]}
                    </button>
                  );
                })}
              </div>
              <span className="soc-help">{t.fastLaneHelp}</span>
            </div>
          ) : null}
        </section>
      </SectionPanel>

      {/* --------------------------- Sources ---------------------------- */}
      <SectionPanel id="sources" active={section === 'sources'}>
        <section className="soc-panel">
          <h2>{t.pushSources}</h2>
          <p className="soc-muted">{t.pushSourcesLede}</p>
          {/* MOVED HERE FROM SETTINGS, not copied. It generates the endpoint
              and the install snippet from the address the browser reached us
              on, and it belongs beside the transport it configures. */}
          <SourcesPanel />
        </section>

        <section className="soc-panel">
          <div className="soc-panel-head">
            <div><h2>{t.pullSources}</h2></div>
            <button
              type="button"
              className="soc-secondary"
              onClick={() => void pollNow()}
              disabled={polling || sources.filter((s) => s.enabled).length === 0}
            >
              <Icon name="refresh" size={15} /> {polling ? t.pull.polling : t.pull.pollNow}
            </button>
          </div>
          <p className="soc-muted">{t.pullSourcesLede}</p>

          {policy ? (
            <>
              <label className="soc-ing-toggle">
                <input
                  type="checkbox"
                  checked={policy.pull.enabled}
                  disabled={busy}
                  onChange={(e) => void save({
                    pull: { ...policy.pull, enabled: e.target.checked },
                  })}
                />
                <span>{t.pull.enablePolling}</span>
              </label>

              {/* SAID AT THE POINT OF CHOICE, like the shadow-mode warning on
                  the ingestion settings: polling that is on with nothing to
                  poll is a timer reaching nothing, reported as healthy. */}
              {policy.pull.enabled && sources.filter((s) => s.enabled).length === 0 ? (
                <div className="soc-banner soc-banner-warn">
                  <Icon name="alert" size={16} />
                  <p>{t.pull.noSource}</p>
                </div>
              ) : null}

              <div className="soc-ing-numbers">
                <label className="soc-field">
                  <span>{t.pull.interval}</span>
                  <CommittedInput
                    type="number"
                    min={15}
                    max={3600}
                    value={policy.pull.intervalSeconds}
                    onCommit={(v) => void save({
                      pull: { ...policy.pull, intervalSeconds: Number(v) },
                    })}
                  />
                  <span className="soc-help">
                    {t.pull.intervalHelp(Math.round(policy.pull.intervalSeconds / 2))}
                  </span>
                </label>
                <label className="soc-field">
                  <span>{t.pull.batch}</span>
                  <CommittedInput
                    type="number"
                    min={1}
                    max={1000}
                    value={policy.pull.batchSize}
                    onCommit={(v) => void save({
                      pull: { ...policy.pull, batchSize: Number(v) },
                    })}
                  />
                  <span className="soc-help">{t.pull.batchHelp}</span>
                </label>
                <label className="soc-field">
                  <span>{t.pull.overlap}</span>
                  <CommittedInput
                    type="number"
                    min={0}
                    max={3600}
                    value={policy.pull.overlapSeconds}
                    onCommit={(v) => void save({
                      pull: { ...policy.pull, overlapSeconds: Number(v) },
                    })}
                  />
                  <span className="soc-help">{t.pull.overlapHelp}</span>
                </label>
              </div>

              {sources.length === 0 ? (
                <p className="soc-muted">{t.pull.empty}</p>
              ) : (
                sources.map((src, i) => (
                  <PullSourceRow
                    key={`${src.source}-${i}`}
                    src={src}
                    cursor={cursors[src.source]}
                    outcome={outcomes.get(src.source)}
                    onChange={(next) => void save({
                      pull: {
                        ...policy.pull,
                        sources: sources.map((s, j) => (j === i ? next : s)),
                      },
                    })}
                    onRemove={() => void save({
                      pull: { ...policy.pull, sources: sources.filter((_, j) => j !== i) },
                    })}
                  />
                ))
              )}

              <button
                type="button"
                className="soc-secondary"
                disabled={busy}
                onClick={() => void save({
                  pull: {
                    ...policy.pull,
                    sources: [...sources, {
                      source: 'generic', enabled: false, url: '',
                      cursorParam: 'since', authHeader: '', authCredential: '', itemsPath: '',
                    }],
                  },
                })}
              >
                <Icon name="plus" size={15} /> {t.pull.add}
              </button>
            </>
          ) : null}
        </section>
      </SectionPanel>

      {/* --------------------------- Pipeline --------------------------- */}
      {/* HIDDEN, NOT UNMOUNTED — the section-tabs rule. The graph holds a
          selected node and a scroll position, and a round trip through the
          other two sections must not reset them. */}
      <SectionPanel id="pipeline" active={section === 'pipeline'}>
        <p className="soc-muted">{t.sections.pipelineLede}</p>
        <WorkflowPanel />
      </SectionPanel>
    </>
  );
}
