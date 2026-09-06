/**
 * Schémas de la page de présentation.
 *
 * ============================================================================
 * POURQUOI DU SVG ÉCRIT À LA MAIN, ET PAS UNE IMAGE
 *
 * Un schéma d'architecture exporté en PNG est mort trois fois : il ne suit pas
 * la langue de l'interface, il ne suit pas la palette, et il est illisible
 * pour un lecteur d'écran. Ces trois-là sont dessinés en SVG, avec leurs
 * libellés passés en props depuis le dictionnaire : la même figure se lit en
 * anglais ou en français, prend les couleurs du thème via `currentColor` et
 * les variables CSS, et porte un titre annoncé.
 *
 * Le découpage suit la promesse du produit plutôt que la beauté du dessin :
 *  - `ArchitectureDiagram` montre OÙ passe le code, et surtout où se trouve
 *    la frontière entre le gratuit (local) et le payant (une seule boîte).
 *  - `ConfidenceZones` montre les trois zones du score sur un axe unique :
 *    c'est la décision centrale de l'outil, elle mérite une figure.
 *  - `CostFunnel` montre l'entonnoir en barres proportionnelles — dire
 *    « 10-15 % » en toutes lettres n'a pas la même force qu'une barre qui
 *    fait un dixième de la première.
 * ============================================================================
 */

import type { Dictionary } from '../../i18n/dictionary.ts';

type DiagramLabels = Dictionary['landing']['diagram'];

/** Boîte de la chaîne de traitement : un titre, une ligne d'explication. */
function Node({
  x,
  y,
  w,
  title,
  note,
  tone = 'local',
}: {
  x: number;
  y: number;
  w: number;
  title: string;
  note: string;
  tone?: 'local' | 'paid' | 'input' | 'output';
}) {
  return (
    <g className={`vp-dgm-node vp-dgm-${tone}`}>
      <rect x={x} y={y} width={w} height={62} rx={4} />
      <text x={x + 14} y={y + 25} className="vp-dgm-title">
        {title}
      </text>
      <text x={x + 14} y={y + 44} className="vp-dgm-note">
        {note}
      </text>
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line className="vp-dgm-arrow" x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#vp-arrow)" />;
}

/**
 * La pipeline, de gauche à droite.
 *
 * La colonne de droite est isolée par un liseré : c'est la seule qui coûte de
 * l'argent, et c'est l'information que quelqu'un qui hésite à essayer cherche
 * en premier.
 */
export function ArchitectureDiagram({ labels }: { labels: DiagramLabels }) {
  return (
    <svg
      className="vp-diagram"
      viewBox="0 0 920 430"
      role="img"
      aria-label={`${labels.commit} → ${labels.indexer} → ${labels.nodes} → ${labels.aggregator} → ${labels.master} → ${labels.report}`}
    >
      <defs>
        <marker id="vp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 10 5 0 10z" fill="currentColor" />
        </marker>
      </defs>

      {/* Frontière gratuit / payant : un cadre, pas une couleur de fond, pour
          ne pas voler l'accent réservé au reste de la page. */}
      <rect className="vp-dgm-zone" x={10} y={44} width={606} height={340} rx={6} />
      <rect className="vp-dgm-zone vp-dgm-zone-paid" x={630} y={44} width={280} height={340} rx={6} />
      <text className="vp-dgm-zonelabel" x={26} y={32}>
        {labels.localLabel}
      </text>
      <text className="vp-dgm-zonelabel vp-dgm-zonelabel-paid" x={646} y={32}>
        {labels.cloudLabel}
      </text>

      <Node x={34} y={70} w={230} title={labels.commit} note={labels.commitNote} tone="input" />
      <Arrow x1={149} y1={132} x2={149} y2={160} />

      <Node x={34} y={166} w={230} title={labels.indexer} note={labels.indexerNote} />
      <Arrow x1={264} y1={197} x2={330} y2={197} />

      <Node x={336} y={166} w={252} title={labels.mcp} note={labels.mcpNote} />
      <Arrow x1={462} y1={228} x2={462} y2={256} />

      <Node x={336} y={262} w={252} title={labels.nodes} note={labels.nodesNote} />
      <Arrow x1={336} y1={293} x2={278} y2={293} />

      <Node x={34} y={262} w={230} title={labels.aggregator} note={labels.aggregatorNote} />

      {/* Deux sorties du filtre : ce qui meurt là, et ce qui passe. */}
      <Arrow x1={149} y1={324} x2={149} y2={352} />
      <text className="vp-dgm-edge vp-dgm-edge-muted" x={162} y={356}>
        {labels.dropped}
      </text>

      <path className="vp-dgm-arrow" d="M264 293 H300 V150 H660" markerEnd="url(#vp-arrow)" fill="none" />
      <text className="vp-dgm-edge vp-dgm-edge-paid" x={476} y={142}>
        {labels.billed}
      </text>

      <Node x={660} y={166} w={222} title={labels.master} note={labels.masterNote} tone="paid" />
      <Arrow x1={771} y1={228} x2={771} y2={256} />

      <Node x={660} y={262} w={222} title={labels.report} note={labels.reportNote} tone="output" />
    </svg>
  );
}

/** L'axe de confiance et ses trois zones, du sain à l'alerte. */
export function ConfidenceZones({
  zones,
}: {
  zones: Dictionary['landing']['zones'];
}) {
  const width = 900;
  // Les bornes 0.4 et 0.7 de CLAUDE.md, transposées en pourcentage de largeur.
  const stops = [0, 0.35, 0.72, 1];
  return (
    <svg className="vp-diagram vp-diagram-zones" viewBox={`0 0 ${width} 132`} role="img" aria-label={zones.map((z) => `${z.range} ${z.title}`).join(' · ')}>
      {zones.map((zone, index) => {
        const x = stops[index]! * width;
        const w = (stops[index + 1]! - stops[index]!) * width - 8;
        return (
          <g key={zone.range} className={`vp-dgm-zoneband vp-tone-${zone.tone}`}>
            <rect x={x + 4} y={40} width={w} height={26} rx={3} />
            <text className="vp-dgm-range" x={x + 4} y={30}>
              {zone.range}
            </text>
            <text className="vp-dgm-title" x={x + 4} y={92}>
              {zone.title}
            </text>
          </g>
        );
      })}
      <line className="vp-dgm-axis" x1={4} y1={78} x2={width - 4} y2={78} />
      <text className="vp-dgm-note" x={4} y={118}>
        0.0
      </text>
      <text className="vp-dgm-note" x={width - 30} y={118}>
        1.0
      </text>
    </svg>
  );
}

/**
 * Entonnoir de coût.
 *
 * Rendu en HTML plutôt qu'en SVG : ce sont des barres proportionnelles avec du
 * texte à côté, et le HTML se met à la ligne tout seul sur un écran étroit là
 * où un SVG à largeur fixe écraserait les libellés.
 */
export function CostFunnel({ steps }: { steps: Dictionary['landing']['funnel'] }) {
  return (
    <ol className="vp-funnel">
      {steps.map((step, index) => (
        <li key={step.label} className={index === steps.length - 1 ? 'vp-funnel-last' : undefined}>
          <div className="vp-funnel-bar" style={{ width: `${step.share}%` }} aria-hidden="true" />
          <div className="vp-funnel-text">
            <strong>{step.label}</strong>
            <span>{step.note}</span>
          </div>
          <span className="vp-funnel-share">{step.share}%</span>
        </li>
      ))}
    </ol>
  );
}
