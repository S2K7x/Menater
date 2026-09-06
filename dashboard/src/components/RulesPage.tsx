/**
 * Rules — where a team teaches its own SOC what is normal here.
 *
 * ============================================================================
 * THE SCREEN ENFORCES WHAT THE ENGINE ENFORCES
 *
 * The server refuses a rule with no owner, a suppression with no end date, and
 * a permanent allow keyed on one identity field. This page does not merely
 * pass those refusals through — it explains them where the choice is made, so
 * that a rule which would be a hole is hard to write rather than merely
 * rejected afterwards.
 *
 * The list leads with what needs attention: expired rules first, then ones
 * that have never matched. A rule that has silently matched nothing for a year
 * is not tuning, it is debt nobody remembers taking on.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';

import type {
  RuleCondition, RuleOperator, RuleProblem, RuleTemplate, RuleTestResult, TuningRule,
} from '../lib/types.ts';
import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Fold } from './Guidance.tsx';
import { Icon } from './Icon.tsx';

const OPERATORS: RuleOperator[] = [
  'equals', 'not_equals', 'contains', 'starts_with', 'ends_with',
  'regex', 'cidr', 'in_list', 'exists', 'not_exists',
];

/** The canonical fields, plus the escape hatch for vendor data. */
const FIELDS = [
  'rule_name', 'severity', 'source', 'source_ip', 'dest_ip',
  'user', 'host', 'process', 'file_path', 'url', 'raw_log', 'alert_id',
];

const NO_VALUES: RuleOperator[] = ['exists', 'not_exists'];

const blankRule = (): Partial<TuningRule> => ({
  name: '',
  enabled: false,
  priority: 100,
  conditions: [{ field: 'rule_name', op: 'contains', values: [''] }],
  action: 'allow',
  severity: null,
  owner: '',
  reason: '',
  expires_at: null,
});

const daysUntil = (iso: string): number =>
  Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

export function RulesPage() {
  const { c, locale } = useI18n();
  const t = c.rules;

  const [rules, setRules] = useState<TuningRule[] | null>(null);
  const [templates, setTemplates] = useState<RuleTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<TuningRule> | null>(null);
  const [problems, setProblems] = useState<RuleProblem[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.rules()
      .then((r) => { setRules(r.rules); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : t.loadFailed));
  };

  useEffect(() => {
    load();
    api.ruleTemplates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Attention first: expired, then never-triggered, then the rest.
   *
   * Ordering by priority would mirror the ENGINE, which is not what this
   * screen is for — nobody opens it to replay evaluation order, they open it
   * because something needs looking at.
   */
  const sorted = useMemo(() => {
    if (!rules) return [];
    const rank = (r: TuningRule) => {
      if (r.expires_at && daysUntil(r.expires_at) <= 0) return 0;
      if (r.enabled && r.match_count === 0) return 1;
      if (r.expires_at && daysUntil(r.expires_at) <= 7) return 2;
      return 3;
    };
    return [...rules].sort((a, b) => rank(a) - rank(b) || a.priority - b.priority);
  }, [rules]);

  const needsReview = sorted.filter(
    (r) => (r.expires_at && daysUntil(r.expires_at) <= 7) || (r.enabled && r.match_count === 0),
  ).length;

  async function save() {
    if (!editing) return;
    setBusy(true);
    setProblems([]);
    try {
      if (editing.id) await api.updateRule(editing.id, editing);
      else await api.createRule(editing);
      setEditing(null);
      load();
    } catch (e) {
      // The server answers 400 with a list naming each field AND what goes
      // wrong if it stands. Showing "invalid" instead would throw that away.
      const body = (e as { problems?: RuleProblem[] })?.problems;
      if (Array.isArray(body)) setProblems(body);
      else setProblems([{ field: '', detail: e instanceof ApiError ? e.message : t.saveFailed }]);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: TuningRule) {
    await api.updateRule(rule.id, { ...rule, enabled: !rule.enabled }).catch(() => {});
    load();
  }

  async function remove(rule: TuningRule) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t.confirmRemove)) return;
    await api.deleteRule(rule.id).catch(() => {});
    load();
  }

  if (error) {
    return (
      <section className="soc-panel">
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      </section>
    );
  }
  if (!rules) return <p className="soc-empty">{c.common.loading}</p>;

  return (
    <>
      <section className="soc-panel soc-page-head">
        <span className="soc-kicker">{t.kicker}</span>
        <h2>{t.title}</h2>
        <p className="soc-muted" style={{ margin: 0 }}>{t.lede}</p>
      </section>

      {needsReview > 0 ? (
        <section className="soc-panel soc-setup">
          <span className="soc-kicker">{t.reviewTitle}</span>
          <p className="soc-muted" style={{ margin: '4px 0 0' }}>{t.reviewLede}</p>
        </section>
      ) : null}

      <section className="soc-panel">
        <div className="soc-actions" style={{ marginTop: 0 }}>
          <button type="button" className="soc-primary" onClick={() => { setEditing(blankRule()); setProblems([]); }}>
            <Icon name="check" size={15} /> {t.add}
          </button>
          <button type="button" className="soc-secondary" onClick={() => setShowTemplates(!showTemplates)}>
            <Icon name="book" size={15} /> {t.fromTemplate}
          </button>
        </div>

        {showTemplates ? (
          <div className="soc-rule-templates">
            <h4 className="soc-wf-subhead">{t.templatesTitle}</h4>
            <p className="soc-muted">{t.templatesLede}</p>
            {templates.map((tpl) => (
              <div className="soc-rule-template" key={tpl.id}>
                <div>
                  <b>{tpl.title}</b>
                  <p className="soc-muted" style={{ margin: '3px 0 0' }}>{tpl.description}</p>
                  {tpl.placeholders.length > 0 ? (
                    <p className="soc-faint soc-help" style={{ margin: '4px 0 0' }}>
                      {t.placeholderWarn(tpl.placeholders.join(', '))}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="soc-secondary"
                  onClick={() => {
                    setShowTemplates(false);
                    setProblems([]);
                    setEditing({
                      ...blankRule(),
                      name: tpl.title,
                      reason: tpl.description,
                      action: tpl.action,
                      severity: tpl.severity,
                      conditions: tpl.conditions.map((x) => ({ ...x, values: [...x.values] })),
                      expires_at: tpl.expiresInDays === null
                        ? null
                        : new Date(Date.now() + tpl.expiresInDays * 86_400_000).toISOString().slice(0, 10),
                    });
                  }}
                >
                  {t.use}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {editing ? (
        <RuleEditor
          rule={editing}
          problems={problems}
          busy={busy}
          onChange={setEditing}
          onSave={save}
          onCancel={() => { setEditing(null); setProblems([]); }}
        />
      ) : null}

      <section className="soc-panel">
        {sorted.length === 0 ? (
          <>
            <p className="soc-empty">{t.empty}</p>
            <p className="soc-muted">{t.emptyHint}</p>
          </>
        ) : (
          <ul className="soc-rule-list">
            {sorted.map((r) => {
              const expired = r.expires_at !== null && daysUntil(r.expires_at) <= 0;
              const soon = r.expires_at !== null && !expired && daysUntil(r.expires_at) <= 7;
              return (
                <li key={r.id} className={expired ? 'soc-rule-expired' : undefined}>
                  <div className="soc-rule-main">
                    <div className="soc-rule-head">
                      <b>{r.name}</b>
                      <span className={`soc-pill soc-pill-${r.action === 'escalate' ? 'warn' : 'info'}`}>
                        {t.actions[r.action]}
                      </span>
                      {expired ? <span className="soc-pill soc-pill-failed">{t.expired}</span> : null}
                      {soon ? <span className="soc-pill soc-pill-warn">{t.expiringSoon(daysUntil(r.expires_at!))}</span> : null}
                      {!r.enabled ? <span className="soc-pill soc-pill-info">{t.disabled}</span> : null}
                    </div>
                    <p className="soc-muted" style={{ margin: '2px 0 0' }}>{r.reason}</p>
                    <p className="soc-faint soc-help" style={{ margin: '3px 0 0' }}>
                      {r.owner} · {r.match_count === 0 ? t.neverMatched : t.matches(r.match_count)}
                      {r.last_matched_at ? ` · ${t.lastMatch(new Date(r.last_matched_at).toLocaleDateString(locale))}` : ''}
                      {r.expires_at ? ` · ${t.expires} ${new Date(r.expires_at).toLocaleDateString(locale)}` : ` · ${t.expiresNever}`}
                    </p>
                    <div className="soc-rule-conds">
                      {r.conditions.map((cond, i) => (
                        <code key={i}>
                          {cond.field} {t.operators[cond.op] ?? cond.op}{' '}
                          {NO_VALUES.includes(cond.op) ? '' : cond.values.join(' | ')}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div className="soc-rule-actions">
                    {/* An ACTION, not a state. `{r.enabled ? t.disabled : ...}`
                        put the word "Disabled" on an enabled rule, which reads
                        as a status label and leaves you guessing whether the
                        button describes or acts. */}
                    <button type="button" className="soc-secondary" onClick={() => toggle(r)}>
                      {r.enabled ? t.disable : t.enable}
                    </button>
                    <button
                      type="button"
                      className="soc-secondary"
                      onClick={() => {
                        setProblems([]);
                        setEditing({ ...r, expires_at: r.expires_at ? r.expires_at.slice(0, 10) : null });
                      }}
                    >
                      <Icon name="sliders" size={14} />
                    </button>
                    <button type="button" className="soc-secondary" onClick={() => remove(r)}>
                      <Icon name="cross" size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Le compte des regles ACTIVES, pas de toutes : une regle desactivee
          ou expiree ne sera pas confrontee, et l'annoncer autrement ferait
          attendre un resultat qui ne peut pas venir. */}
      <RuleTester activeRules={rules.filter((r) => r.enabled).length} />
    </>
  );
}

// --- Editor -------------------------------------------------------------------

function RuleEditor({
  rule, problems, busy, onChange, onSave, onCancel,
}: {
  rule: Partial<TuningRule>;
  problems: RuleProblem[];
  busy: boolean;
  onChange: (r: Partial<TuningRule>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { c } = useI18n();
  const t = c.rules;
  const conditions = rule.conditions ?? [];
  const set = (patch: Partial<TuningRule>) => onChange({ ...rule, ...patch });

  const setCondition = (i: number, patch: Partial<RuleCondition>) => {
    const next = conditions.map((cond, j) => (i === j ? { ...cond, ...patch } : cond));
    set({ conditions: next });
  };

  return (
    <section className="soc-panel">
      <h3 style={{ marginTop: 0 }}>{rule.id ? rule.name : t.add}</h3>

      {problems.length > 0 ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>
            {/* Each problem names its field AND what goes wrong if it stands.
                A bare "invalid" would throw the useful half away. */}
            {problems.map((p, i) => <span key={i} style={{ display: 'block' }}>{p.detail}</span>)}
          </p>
        </div>
      ) : null}

      <label className="soc-field">
        <span>{t.name}</span>
        <input value={rule.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
      </label>

      <div className="soc-rule-row">
        <label className="soc-field">
          <span>{t.owner}</span>
          <input value={rule.owner ?? ''} onChange={(e) => set({ owner: e.target.value })} />
          <span className="soc-faint soc-help">{t.ownerHelp}</span>
        </label>
        <label className="soc-field">
          <span>{t.priority}</span>
          <input
            type="number"
            value={rule.priority ?? 100}
            onChange={(e) => set({ priority: Number(e.target.value) })}
          />
          <span className="soc-faint soc-help">{t.priorityHelp}</span>
        </label>
      </div>

      <label className="soc-field">
        <span>{t.reason}</span>
        <textarea rows={2} value={rule.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} />
        <span className="soc-faint soc-help">{t.reasonHelp}</span>
      </label>

      <div className="soc-field">
        <span>{t.action}</span>
        <div className="soc-lang soc-lang-wide" role="group" aria-label={t.action}>
          {(['allow', 'suppress', 'severity', 'escalate'] as const).map((a) => (
            <button key={a} type="button" onClick={() => set({ action: a })} aria-pressed={rule.action === a}>
              {t.actions[a]}
            </button>
          ))}
        </div>
        <span className="soc-faint soc-help">{t.actionHelp[rule.action ?? 'allow']}</span>
      </div>

      {rule.action === 'severity' ? (
        <div className="soc-field">
          <span>{t.severity}</span>
          <div className="soc-lang soc-lang-wide" role="group" aria-label={t.severity}>
            {(['low', 'medium', 'high', 'critical'] as const).map((sv) => (
              <button key={sv} type="button" onClick={() => set({ severity: sv })} aria-pressed={rule.severity === sv}>
                {sv}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <label className="soc-field">
        <span>{t.expires}</span>
        <input
          type="date"
          value={rule.expires_at ? String(rule.expires_at).slice(0, 10) : ''}
          onChange={(e) => set({ expires_at: e.target.value === '' ? null : e.target.value })}
        />
        <span className="soc-faint soc-help">{t.expiresHelp}</span>
      </label>

      <h4 className="soc-wf-subhead">{t.conditions}</h4>
      <p className="soc-muted">{t.conditionsHelp}</p>

      {conditions.map((cond, i) => (
        <div className="soc-rule-cond" key={i}>
          <label className="soc-field">
            <span>{t.field}</span>
            <input
              list="soc-rule-fields"
              value={cond.field}
              onChange={(e) => setCondition(i, { field: e.target.value })}
            />
          </label>
          <label className="soc-field">
            <span>{t.operator}</span>
            <select value={cond.op} onChange={(e) => setCondition(i, { op: e.target.value as RuleOperator })}>
              {OPERATORS.map((op) => <option key={op} value={op}>{t.operators[op] ?? op}</option>)}
            </select>
          </label>
          <label className="soc-field">
            <span>{t.values}</span>
            <textarea
              rows={2}
              disabled={NO_VALUES.includes(cond.op)}
              value={(cond.values ?? []).join('\n')}
              onChange={(e) => setCondition(i, { values: e.target.value.split('\n') })}
            />
            <span className="soc-faint soc-help">{t.valuesHelp}</span>
          </label>
          <button
            type="button"
            className="soc-secondary"
            onClick={() => set({ conditions: conditions.filter((_, j) => j !== i) })}
          >
            {t.removeCondition}
          </button>
        </div>
      ))}

      <datalist id="soc-rule-fields">
        {FIELDS.map((f) => <option key={f} value={f} />)}
      </datalist>

      <div className="soc-actions">
        <button
          type="button"
          className="soc-secondary"
          onClick={() => set({ conditions: [...conditions, { field: 'host', op: 'equals', values: [''] }] })}
        >
          {t.addCondition}
        </button>
      </div>

      <div className="soc-actions">
        <button type="button" className="soc-primary" onClick={onSave} disabled={busy}>
          <Icon name="check" size={15} /> {busy ? c.common.saving : t.save}
        </button>
        <button type="button" className="soc-secondary" onClick={onCancel}>{t.cancel}</button>
      </div>
    </section>
  );
}

// --- Dry run ------------------------------------------------------------------

const SAMPLE = {
  alert_id: 'A-1',
  rule_name: 'sshd: port scan detected',
  severity: 'high',
  source_ip: '10.0.0.9',
  host: 'web-prod-01',
  raw_log: 'nmap scan from 10.0.0.9',
};

function RuleTester({ activeRules }: { activeRules: number }) {
  const { c } = useI18n();
  const t = c.rules;
  const [text, setText] = useState(JSON.stringify(SAMPLE, null, 2));
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('JSON');
      return;
    }
    try {
      setResult(await api.testRules(parsed));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.saveFailed);
    }
  }

  return (
    <section className="soc-panel">
      {/*
        LE BANC D'ESSAI EST UN OUTIL, PAS UN REGLAGE.
        Il occupait quatre cents pixels en permanence, sous la liste des
        regles : un champ JSON de huit lignes qu'on remplit quand on DOUTE
        d'une regle, jamais en venant en ecrire une. Replie, et le pli dit
        contre combien de regles actives l'alerte sera confrontee — un banc
        d'essai sans regle active ne prouve rien, et ca se voit avant de
        l'ouvrir.
      */}
      <Fold title={t.testTitle} hint={t.testAgainst(activeRules)}>
      <p className="soc-muted">{t.testLede}</p>

      <label className="soc-field">
        <span>{t.testAlert}</span>
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </label>

      <div className="soc-actions">
        <button type="button" className="soc-secondary" onClick={run}>
          <Icon name="play" size={15} /> {t.testRun}
        </button>
      </div>

      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} /><p>{error}</p>
        </div>
      ) : null}

      {result ? (
        <div className={`soc-banner ${result.matched ? 'soc-banner-warn' : 'soc-banner-ok'}`}>
          <Icon name={result.matched ? 'alert' : 'check'} size={16} />
          <p>
            {result.matched ? t.testMatched(result.matched.name) : t.testNoMatch}
            {result.note ? <span style={{ display: 'block' }}>{result.note}</span> : null}
            {result.expired.length > 0 ? (
              <span style={{ display: 'block' }}>{t.expired}: {result.expired.join(', ')}</span>
            ) : null}
          </p>
        </div>
      ) : null}
      </Fold>
    </section>
  );
}
