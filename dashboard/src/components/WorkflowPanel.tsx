/**
 * Onglet Workflow : voir le pipeline, et régler ce qui se règle.
 *
 * ============================================================================
 * CE QUE CET ÉCRAN EST, ET CE QU'IL N'EST PAS
 *
 * IL N'EST PAS un éditeur par glisser-déposer. La topologie des six workflows
 * ne change presque jamais ; ce qui change souvent, ce sont les seuils, les
 * canaux, les délais. Un éditeur de graphe aurait coûté des semaines pour un
 * besoin que personne n'a, et il aurait rendu modifiable la seule chose qu'on
 * ne veut PAS voir modifiée par accident : le chemin qui mène à l'exécution
 * d'une action.
 *
 * IL EST la réponse à « qu'est-ce qui se passe exactement, et où puis-je
 * changer cette valeur ». Trois choses :
 *
 *   1. LE GRAPHE, dessiné depuis la définition qui s'exécute — pas depuis une
 *      copie. Une vue qui recomposerait le graphe pourrait diverger de ce qui
 *      tourne vraiment : c'est précisément ce que la console vivait avec
 *      l'éditeur n8n, où renommer un nœud la rendait aveugle.
 *
 *   2. LA FICHE D'UN NŒUD : son type, son effet sur le monde extérieur, sa
 *      note, et ses paramètres tels qu'ils sont réellement lus.
 *
 *   3. LES VARIABLES, éditables. C'était `docker-compose` et un redémarrage.
 *
 * ============================================================================
 * POURQUOI L'EFFET EST MONTRÉ AVANT TOUT LE RESTE
 *
 * `pure`, `read`, `write` ne sont pas une curiosité d'implémentation : ils
 * décident de ce qui se rejoue après une panne. Un nœud `write` ne se rejoue
 * JAMAIS — il devient « indéterminé » et remonte à un humain. Quelqu'un qui
 * regarde ce graphe pour comprendre un incident doit voir cette distinction
 * en premier, pas la chercher.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import { Icon } from './Icon.tsx';
import { Explain } from './Guidance.tsx';
import { SectionPanel, SectionTabs } from './SectionTabs.tsx';

export interface WfNode {
  id: string;
  type: string;
  label: string;
  note?: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  effect: 'pure' | 'read' | 'write';
  retry?: { attempts: number; backoffMs: number };
}
export interface WfEdge { from: string; fromPort: string; to: string }
export interface Wf { id: string; name: string; version: number; nodes: WfNode[]; edges: WfEdge[] }

export interface WorkflowsPayload {
  workflows: Wf[];
  variables: Record<string, string | number | boolean>;
}

/** Ports qui méritent d'être nommés sur le graphe. `main` va de soi. */
const PORT_TONE: Record<string, string> = {
  error: 'soc-wf-edge-error',
  timeout: 'soc-wf-edge-error',
  false: 'soc-wf-edge-alt',
};

/**
 * Variables whose value is a CHOICE, not free text.
 *
 * A pipeline variable is a string as far as the store is concerned, and a text
 * box is the honest default for one. But `slack.transport` accepts exactly two
 * words and `slack.minSeverity` exactly five — typing `Webhook` or `HIGH` into
 * a box would be accepted, saved, and then silently ignored by the engine,
 * which is the kind of setting that looks applied and is not.
 *
 * Listed here rather than inferred: the engine owns these vocabularies, and a
 * select that guessed them from the current value would offer one option.
 */
const VAR_CHOICES: Record<string, string[]> = {
  'notify.transport': ['slack-bot', 'slack-webhook', 'discord-webhook'],
  'notify.minSeverity': ['low', 'medium', 'high', 'critical', 'off'],
};

const NODE_W = 148;
const NODE_H = 46;
const PAD = 60;

/**
 * Le graphe, en SVG.
 *
 * Les positions viennent de la DÉFINITION — reprises des workflows n8n, jamais
 * recalculées. Un placement automatique aurait redessiné le graphe à chaque
 * modification, et personne ne reconnaît un schéma qui bouge.
 */
function Graph({
  workflow,
  selected,
  onSelect,
}: {
  workflow: Wf;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { c } = useI18n();
  const box = useMemo(() => {
    const xs = workflow.nodes.map((n) => n.position.x);
    const ys = workflow.nodes.map((n) => n.position.y);
    const minX = Math.min(...xs) - PAD;
    const minY = Math.min(...ys) - PAD;
    return {
      minX, minY,
      width: Math.max(...xs) - minX + NODE_W + PAD,
      height: Math.max(...ys) - minY + NODE_H + PAD,
    };
  }, [workflow]);

  const at = (id: string) => workflow.nodes.find((n) => n.id === id)?.position ?? { x: 0, y: 0 };

  return (
    <div className="soc-wf-canvas">
      {/* Taille NATURELLE, et le conteneur défile.
          Laisser le SVG se réduire pour tenir dans la colonne rendait les
          libellés illisibles sur les graphes larges — 04 fait 2500 px de long.
          Un schéma qu'on ne peut pas lire ne sert à rien ; un schéma qui
          défile, si. */}
      <svg
        viewBox={`${box.minX} ${box.minY} ${box.width} ${box.height}`}
        width={box.width}
        height={box.height}
        className="soc-wf-svg"
        role="img"
        aria-label={c.workflow.graphLabel(workflow.name)}
      >
        <defs>
          <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
          </marker>
        </defs>

        {workflow.edges.map((e, i) => {
          const a = at(e.from);
          const b = at(e.to);
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = x1 + (x2 - x1) / 2;
          return (
            <g key={i} className={`soc-wf-edge ${PORT_TONE[e.fromPort] ?? ''}`}>
              <path
                d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
                fill="none"
                markerEnd="url(#wf-arrow)"
              />
              {/* Seuls les ports NON évidents sont écrits : un graphe couvert
                  d'étiquettes « main » ne se lit plus. */}
              {e.fromPort !== 'main' ? (
                <text x={mid} y={(y1 + y2) / 2 - 5} textAnchor="middle" className="soc-wf-port">
                  {e.fromPort}
                </text>
              ) : null}
            </g>
          );
        })}

        {workflow.nodes.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.position.x} ${n.position.y})`}
            className={`soc-wf-node soc-wf-${n.effect} ${selected === n.id ? 'soc-wf-selected' : ''}`}
            onClick={() => onSelect(n.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') onSelect(n.id); }}
          >
            <rect width={NODE_W} height={NODE_H} rx="3" />
            <text x="10" y="19" className="soc-wf-node-type">{n.type}</text>
            <text x="10" y="34" className="soc-wf-node-label">
              {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Fiche d'un nœud : ce qu'il fait, et ce qu'il lit vraiment. */
function NodeCard({ node }: { node: WfNode }) {
  const { c } = useI18n();
  const t = c.workflow;

  return (
    <div className="soc-wf-inspector">
      <span className="soc-kicker">{node.type}</span>
      <h3>{node.label}</h3>
      <p className="soc-faint soc-wf-id">
        {t.nodeId}&nbsp;<code>{node.id}</code>
      </p>

      <p className={`soc-pill soc-wf-effect-${node.effect}`}>{t.effects[node.effect]}</p>
      <p className="soc-muted soc-wf-effect-help">{t.effectHelp[node.effect]}</p>

      {node.note ? <p className="soc-wf-note">{node.note}</p> : null}

      {node.retry ? (
        <p className="soc-faint">{t.retry(node.retry.attempts, node.retry.backoffMs)}</p>
      ) : null}

      <h4 className="soc-wf-subhead">{t.params}</h4>
      {Object.keys(node.params).length === 0 ? (
        <p className="soc-faint">{t.noParams}</p>
      ) : (
        <pre className="soc-wf-params">{JSON.stringify(node.params, null, 2)}</pre>
      )}
    </div>
  );
}

/**
 * Les variables du pipeline.
 *
 * C'EST LE VRAI SUJET DE CET ÉCRAN. Le graphe explique, les variables règlent.
 * Chaque champ est typé d'après la valeur existante : un seuil reste un
 * nombre, un shadow mode reste un booléen. Accepter « 30 » là où un nombre est
 * attendu ferait échouer un nœud à l'exécution, loin d'ici.
 */
function Variables({
  values,
  onSaved,
}: {
  values: Record<string, string | number | boolean>;
  onSaved: (next: Record<string, string | number | boolean>) => void;
}) {
  const { c } = useI18n();
  const t = c.workflow;
  const [draft, setDraft] = useState(values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(values), [values]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(values);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveVariables(draft);
      onSaved(next.variables);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="soc-panel">
      <span className="soc-kicker">{t.varsKicker}</span>
      <div className="soc-titled">
        <h2>{t.varsTitle}</h2>
        <Explain label={t.varsTitle}>{t.varsLede}</Explain>
      </div>

      {/* Le shadow mode d'abord, et signalé : c'est la seule variable qui
          décide si le monde réel est touché. */}
      {draft['pipeline.shadowMode'] === false ? (
        <div className="soc-banner soc-banner-warn">
          <Icon name="alert" size={16} />
          <p>{t.shadowOff}</p>
        </div>
      ) : null}

      {/* SAID AT THE POINT OF CHOICE, like the shadow-mode warning above it.
          Raising the threshold does not only quieten Slack: below it no
          approval is requested, so nothing at that severity can ever be
          approved. That is a fail-safe consequence, and it is exactly the kind
          somebody should meet while choosing rather than discover later. */}
      {draft['notify.minSeverity'] === 'off' ? (
        <div className="soc-banner soc-banner-warn">
          <Icon name="alert" size={16} />
          <p>{t.notifyOff}</p>
        </div>
      ) : draft['notify.minSeverity'] && draft['notify.minSeverity'] !== 'low' ? (
        <div className="soc-banner soc-banner-warn">
          <Icon name="alert" size={16} />
          <p>{t.notifyThreshold(String(draft['notify.minSeverity']))}</p>
        </div>
      ) : null}

      {/* A webhook is bound to one channel by Slack. Four channel settings
          that no longer do anything, with nothing saying so, is a screen that
          lies quietly. */}
      {draft['notify.transport'] === 'slack-webhook'
        || draft['notify.transport'] === 'discord-webhook' ? (
          <div className="soc-quiet">
            <Icon name="chain" size={15} />
            <p>{t.webhookOneChannel}</p>
          </div>
        ) : null}

      <div className="soc-wf-vars">
        {Object.entries(draft).map(([key, value]) => (
          <label className="soc-field soc-wf-var" key={key}>
            <span>{key}</span>
            {typeof value === 'boolean' ? (
              <button
                type="button"
                className={`soc-toggle ${value ? 'soc-toggle-on' : ''}`}
                aria-pressed={value}
                onClick={() => setDraft({ ...draft, [key]: !value })}
              >
                {value ? t.on : t.off}
              </button>
            ) : VAR_CHOICES[key] ? (
              <select
                value={String(value)}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              >
                {VAR_CHOICES[key].map((choice) => (
                  <option key={choice} value={choice}>{choice}</option>
                ))}
              </select>
            ) : (
              <input
                type={typeof value === 'number' ? 'number' : 'text'}
                value={String(value)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: typeof value === 'number' ? Number(e.target.value) : e.target.value,
                  })
                }
              />
            )}
            <span className="soc-faint soc-wf-var-help">{t.varHelp[key] ?? ''}</span>
          </label>
        ))}
      </div>

      {error ? (
        <div className="soc-banner soc-banner-error"><Icon name="alert" size={16} /><p>{error}</p></div>
      ) : null}

      <div className="soc-actions">
        <button type="button" className="soc-primary" onClick={save} disabled={busy || !dirty}>
          <Icon name="check" size={15} />
          {busy ? c.common.saving : c.common.save}
        </button>
        <button type="button" className="soc-secondary" onClick={() => setDraft(values)} disabled={busy || !dirty}>
          <Icon name="refresh" size={15} /> {c.common.retry}
        </button>
        {saved ? <span className="soc-wf-saved">{t.varsSaved}</span> : null}
      </div>
    </section>
  );
}

export function WorkflowPanel() {
  const { c, locale } = useI18n();
  const t = c.workflow;
  const [payload, setPayload] = useState<WorkflowsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string>('01-ingestion');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.workflows()
      .then(setPayload)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [locale]);

  if (error) {
    return (
      <section className="soc-panel">
        <div className="soc-banner soc-banner-error"><Icon name="alert" size={16} /><p>{error}</p></div>
      </section>
    );
  }
  if (!payload) return <p className="soc-empty">{c.common.loading}</p>;

  // AN EMPTY LIST IS A STATE, NOT AN IMPOSSIBILITY. `payload.workflows[0]` was
  // read straight into `.nodes`, so a 200 carrying no workflow threw a
  // TypeError — and since this panel became a section of the Ingestion tab
  // rather than a tab of its own, that throw takes the delivery policy and the
  // source catalogue down with it. `SectionBoundary` would keep the failure
  // inside the tab; it would still be the whole tab. Found by a test, not in
  // production, which is the only reason it costs nothing.
  const workflow = payload.workflows.find((w) => w.id === active) ?? payload.workflows[0];
  if (!workflow) {
    return (
      <section className="soc-panel">
        <h2>{t.title}</h2>
        <p className="soc-muted">{t.noWorkflows}</p>
      </section>
    );
  }
  const node = workflow.nodes.find((n) => n.id === selected) ?? null;

  return (
    <>
      {/* A SECTION HEADING, NOT A PAGE TITLE. This panel used to be a tab of
          its own and opened with `.soc-page-head`; it is now the third section
          of the Ingestion tab, which already carries the page title. Two page
          titles on one screen is the flattened hierarchy the readability pass
          removed — `h2` here is level two of three, which is what it is. */}
      <section className="soc-panel">
        <h2>{t.title}</h2>
        <p className="soc-muted" style={{ margin: 0 }}>{t.lede}</p>
      </section>

      {/* ONE REGION, SIX TABS. These tabs do not select between panels: they
          choose which workflow the single frame below them describes. So every
          tab points at that one region (`panelId`) and the region is named by
          whichever tab is selected (`labelledBy`). The alternative — six
          panels of which five are empty — would be inventing content to
          satisfy a pattern, and the one this replaces was worse than both:
          six `aria-controls` pointing at elements that do not exist. */}
      <SectionTabs
        items={payload.workflows.map((w) => ({ id: w.id, label: w.name, hint: `v${w.version}` }))}
        active={workflow.id}
        onChange={(id) => { setActive(id); setSelected(null); }}
        label={t.sectionsLabel}
        panelId="workflow"
      />

      <SectionPanel id="workflow" labelledBy={workflow.id} active>
      <section className="soc-panel">
        <div className="soc-panel-head">
          <div>
            <span className="soc-kicker">{t.graphKicker}</span>
            <h2>{workflow.name}</h2>
          </div>
          <span className="soc-faint">{t.nodeCount(workflow.nodes.length, workflow.edges.length)}</span>
        </div>

        {/* La légende des effets, avant le graphe : sans elle, les trois
            couleurs ne veulent rien dire. */}
        <div className="soc-wf-legend">
          {(['pure', 'read', 'write'] as const).map((effect) => (
            <span key={effect} className={`soc-wf-legend-item soc-wf-effect-${effect}`}>
              <span className="soc-wf-swatch" aria-hidden="true" />
              {t.effects[effect]}
            </span>
          ))}
        </div>

        <div className="soc-wf-split">
          <div className="soc-wf-view">
            <Graph workflow={workflow} selected={selected} onSelect={setSelected} />
            {/* SOUS 700 px, LA LISTE REMPLACE LE GRAPHE.
                04 fait 2648 px de long : sur un téléphone, il reste
                techniquement défilable et pratiquement inutilisable — on ne
                voit jamais deux étapes voisines en même temps. La liste garde
                l'ordre d'exécution, l'effet de chaque étape, et ouvre la même
                fiche. Les deux sont RENDUS, l'un est masqué : une sélection
                survit au changement de largeur. */}
            <ol className="soc-wf-list">
              {workflow.nodes.map((n, i) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`soc-wf-row soc-wf-effect-${n.effect} ${selected === n.id ? 'soc-wf-row-active' : ''}`}
                    onClick={() => setSelected(n.id)}
                  >
                    <span className="soc-wf-row-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="soc-wf-row-text">
                      <span className="soc-wf-row-label">{n.label}</span>
                      <span className="soc-wf-row-type">{n.type}</span>
                    </span>
                    <span className="soc-wf-swatch" aria-label={t.effects[n.effect]} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
          {node ? <NodeCard node={node} /> : <p className="soc-empty soc-wf-hint">{t.pickNode}</p>}
        </div>
      </section>
      </SectionPanel>

      {/* OUTSIDE the panel, deliberately: the pipeline variables are read on
          every run of every workflow. Inside, they would announce themselves
          as belonging to whichever workflow happens to be selected. */}
      <Variables
        values={payload.variables}
        onSaved={(variables) => setPayload({ ...payload, variables })}
      />

      {/* La comparaison APRÈS les variables : le seuil de bascule est l'une
          d'elles, et on veut pouvoir le lire juste au-dessus du verdict. */}
    </>
  );
}
