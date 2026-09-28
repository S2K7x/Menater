/**
 * J0.4 — one system, and everything that threatens it.
 *
 * ============================================================================
 * THE QUESTION THIS SCREEN ANSWERS
 *
 * The triage queue answers *what do I work on next*. The scan report answers
 * *what is wrong with this code*. Neither answers the one somebody actually
 * asks about an estate — **what threatens this machine** — and answering it
 * meant reading forty rows and remembering which named `web-01`.
 *
 * So this is the same data, re-cut by system: the alerts raised against a
 * machine, and the flaws promoted out of the code the inventory says runs on
 * it, in one block. The grouping is `lib/systems.ts`; this file only renders
 * it.
 *
 * ============================================================================
 * IT SHOWS WHAT IT KNOWS, AND SAYS WHAT IT DOES NOT
 *
 * Three sentences on this screen exist because an overview is a claim about
 * coverage, and this product refuses a reassuring one:
 *
 *  - the **scope** line says the flaw half is read out of the QUEUE, so an
 *    empty list means nobody promoted a finding — never that the code is
 *    clean. Same rule as `clean` requiring a source that answered;
 *  - the **unattributed** count says how many cases name neither a machine of
 *    ours nor any code. They stay in the queue; an overview that dropped them
 *    silently would be the failure that shows green;
 *  - an empty half is grey and worded, never a green check. Green is earned.
 *
 * All three REPORT, so none of them folds. What folds is the method note
 * behind the disc, which is read once.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No live region. Everything here is standing state re-rendered on every poll,
 * and a permanent announcement is the permanent alarm this console refuses —
 * regions are for what appeared because somebody acted.
 *
 * And it resolves; it never acts. The one button opens the Code tab with the
 * target filled in, which is J0.3's jump; nothing is estimated and nothing is
 * scanned until a human launches it.
 * ============================================================================
 */

import { memo, useMemo } from 'react';

import type { AlertCase } from '../lib/types.ts';
import { groupBySystem, type SystemThreats } from '../lib/systems.ts';
import { timeAgo } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Explain } from './Guidance.tsx';
import { Icon } from './Icon.tsx';
import { severityClass } from './AlertQueue.tsx';

/** One case, as a row you can open. */
function CaseRow({ kase, onSelect }: { kase: AlertCase; onSelect: (id: string) => void }) {
  const { c } = useI18n();
  return (
    <li>
      {/*
        A button, not a clickable row: the queue's table rows carry their own
        `tabIndex` and key handling because they are `<tr>`s, and a list has no
        reason to re-implement what a button already does. The visible text is
        the accessible name, and it names the alert — so twenty of these do not
        all announce the same thing.
      */}
      <button type="button" className="soc-sys-row" onClick={() => onSelect(kase.alert_id)}>
        <span className={severityClass(kase.severity)}>{kase.severity}</span>
        <span className="soc-sys-row-name">{kase.rule_name}</span>
        <span className="soc-sys-row-state">{c.queue.states[kase.state]}</span>
        <span className="soc-sys-row-when">
          <Icon name="clock" size={12} /> {timeAgo(kase.received_at)}
        </span>
      </button>
    </li>
  );
}

/** Half of a system's stack — the alerts, or the flaws. */
function Stack({
  label, cases, empty, onSelect,
}: {
  label: string;
  cases: AlertCase[];
  empty: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="soc-sys-stack">
      {/*
        A label and not a heading: the page title is level 1, the section
        level 2 and the system level 3, and a fourth level would mean this
        screen is doing two jobs. CLARITY § 2.
      */}
      <p className="soc-sys-stack-label">{label}</p>
      {cases.length === 0 ? (
        // Grey, and no check mark. "Nothing here" is not good news until
        // somebody has looked, and on the flaw half nobody necessarily has.
        <p className="soc-quiet">{empty}</p>
      ) : (
        <ul className="soc-sys-cases">
          {cases.map((kase) => (
            <CaseRow key={kase.alert_id} kase={kase} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  );
}

function System({
  system, onSelect, onAnalyse,
}: {
  system: SystemThreats;
  onSelect: (id: string) => void;
  onAnalyse?: (repository: string) => void;
}) {
  const { c } = useI18n();
  const t = c.systems;

  /**
   * Whether the heading is a NAME somebody gave or a VALUE read off the data.
   *
   * It decides two things. A hostname or a repository path is set in the
   * console's display capitals like any other heading, and a path is
   * case-sensitive: `HTTPS://GITHUB…/CHECKOUT-SERVICE-BACKEND` is not the
   * string the launcher would receive. And the meta line below must not
   * repeat what the heading already says — one fact dressed as two, the same
   * reason a case opened from a scan does not print its target twice.
   */
  const named = system.services.length > 0;
  const showMachines = system.machines.length > 0
    && (named || system.machines.length > 1 || system.machines[0] !== system.label);
  const showCode = system.repository !== null
    && (named || system.repository !== system.label);
  /** Nothing left to say once the heading has said it: no empty line, then. */
  const hasMeta = showMachines || system.repository !== null;

  return (
    <article className="soc-sys">
      <div className="soc-sys-head">
        <h3 className={named ? undefined : 'soc-sys-name-literal'}>{system.label}</h3>
        <span className="soc-sys-counts">
          <span className={severityClass(system.worst)}>{system.worst}</span>
          {/* The accent is reserved for something waiting on a human — rule 4
              of `styles.css` — so it is on this pill and on nothing else. */}
          {system.awaiting > 0 ? (
            <span className="soc-pill soc-pill-accent">{t.awaiting(system.awaiting)}</span>
          ) : null}
          {system.failed > 0 ? (
            <span className="soc-pill soc-pill-failed">{t.failed(system.failed)}</span>
          ) : null}
        </span>
      </div>

      {hasMeta ? (
      <p className="soc-sys-meta">
        {showMachines ? (
          <>
            <b>{t.machines}</b>
            <span className="soc-sys-machines">{system.machines.join(', ')}</span>
          </>
        ) : null}
        {/*
          The code is shown only when something named it, the same rule the
          incident card obeys: printing "no repository declared" on every
          system of an install that has not filled the inventory in would put a
          line nobody can act on at the top of every block.
        */}
        {system.repository !== null ? (
          <>
            {showCode ? (
              <>
                <b>{t.code}</b>
                <code className="soc-sys-target">{system.repository}</code>
              </>
            ) : null}
            {onAnalyse ? (
              <button
                type="button"
                className="soc-inv-jump"
                // The label names the system: the button repeats once per
                // block, and twenty identical "Analyse this code" buttons name
                // nothing.
                aria-label={t.analyseLabel(system.label)}
                title={c.caseView.repository.analyseHint}
                onClick={() => onAnalyse(system.repository!)}
              >
                <Icon name="code" size={12} />
                {c.caseView.repository.analyse}
              </button>
            ) : null}
          </>
        ) : null}
      </p>
      ) : null}

      <div className="soc-sys-stacks">
        <Stack
          label={t.alertsLabel(system.alerts.length)}
          cases={system.alerts}
          empty={t.noAlerts}
          onSelect={onSelect}
        />
        <Stack
          label={t.flawsLabel(system.flaws.length)}
          cases={system.flaws}
          // Two different facts, two sentences: "nobody promoted one" and "we
          // could not have listed one, because nothing maps this machine to
          // any code". The second is the state an install with an empty
          // inventory is in, and it says what would change it.
          empty={system.repository === null ? t.noCodeMapped : t.noFlaws}
          onSelect={onSelect}
        />
      </div>
    </article>
  );
}

function SystemPanelImpl({
  cases, onSelect, onAnalyse,
}: {
  cases: AlertCase[];
  onSelect: (id: string) => void;
  /** Absent in a context with no Code tab to jump to. */
  onAnalyse?: (repository: string) => void;
}) {
  const { c } = useI18n();
  const t = c.systems;
  const { systems, unattributed } = useMemo(() => groupBySystem(cases), [cases]);

  return (
    <section className="soc-panel">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{t.kicker}</span>
          <div className="soc-titled">
            <h2>{t.title}</h2>
            <Explain label={t.title}>{t.lede}</Explain>
          </div>
        </div>
        <span className="soc-faint">{t.shown(systems.length)}</span>
      </div>

      {/* Coverage, both halves of it, before the list rather than under it. */}
      <p className="soc-sys-scope">{t.scope}</p>
      {unattributed > 0 ? (
        <p className="soc-sys-scope">{t.unattributed(unattributed)}</p>
      ) : null}

      {systems.length === 0 ? (
        <p className="soc-empty">{t.empty}</p>
      ) : (
        <div className="soc-sys-list">
          {systems.map((system) => (
            <System
              key={system.key}
              system={system}
              onSelect={onSelect}
              onAnalyse={onAnalyse}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Memoised for the same reason the queue is: the snapshot arrives every twenty
 * seconds and this walks every case in the window.
 */
export const SystemPanel = memo(SystemPanelImpl);
