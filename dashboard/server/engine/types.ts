/**
 * Modèle du moteur de workflow.
 *
 * ============================================================================
 * TROIS DÉCISIONS QUI TIENNENT TOUT LE RESTE
 *
 *  1. L'IDENTIFIANT D'UN NŒUD EST LE CONTRAT, PAS SON NOM.
 *
 *     Sous n8n, la console lisait des NOMS de nœuds exacts : renommer
 *     « Finalize Decision + shadow_mode » dans l'éditeur la rendait aveugle,
 *     sans erreur, sans avertissement. Ici `id` est stable et jamais affiché,
 *     `label` est libre et jamais lu par le code. Renommer devient sans
 *     conséquence — ce qui est la seule façon de rendre un renommage sûr.
 *
 *  2. IL N'Y A PAS DE LANGAGE D'EXPRESSION.
 *
 *     Les workflows n8n portaient 168 expressions `={{ ... }}` disséminées
 *     dans les `set`, `if`, `switch` et appels HTTP. Chacune est du code
 *     arbitraire évalué à l'exécution : impossible à typer, impossible à
 *     tester, impossible à éditer dans un formulaire sans rouvrir un éditeur
 *     de code — et une porte d'injection dans une console de sécurité.
 *
 *     À la place : des paramètres TYPÉS. Une condition n'est pas une chaîne,
 *     c'est `{ left, op, right }`. C'est ce qui permet à l'onglet Workflow de
 *     proposer un formulaire compréhensible au lieu d'un champ de code, et au
 *     compilateur de refuser un seuil mal branché.
 *
 *  3. LES EFFETS SONT DÉCLARÉS, ET LES ÉCRITURES SONT « AU PLUS UNE FOIS ».
 *
 *     C'est la décision la plus importante du fichier. Un moteur durable
 *     reprend une exécution interrompue ; la question est de savoir ce qu'il
 *     rejoue. Rejouer un calcul est gratuit. Rejouer un `isolate_host_temporary`
 *     isole une machine deux fois.
 *
 *     Chaque type de nœud déclare donc son effet. `pure` et `read` se
 *     rejouent librement. `write` ne se rejoue JAMAIS : l'intention est
 *     journalisée AVANT l'appel, et si la reprise retrouve un appel en cours,
 *     l'étape est marquée `indeterminate` et remontée à un humain.
 *
 *     C'est la règle du projet appliquée à la reprise : « ne jamais combler un
 *     trou par une valeur par défaut », et « le silence n'est jamais un
 *     accord ». Un moteur qui réessaie tout seul une action irréversible
 *     serait plus pratique et strictement inacceptable ici.
 * ============================================================================
 */

/** Types de nœuds du catalogue. Liste FERMÉE : voir `NODE_EFFECTS`. */
export type NodeType =
  // — déclencheurs
  | 'trigger.webhook'
  | 'trigger.subflow'
  | 'trigger.error'
  // — logique pure
  | 'transform'
  | 'set'
  | 'if'
  | 'switch'
  | 'merge'
  | 'noop'
  // — entrées/sorties
  | 'http'
  | 'postgres'
  // Not `slack`: it posts a chat notification, and Slack is one of three
  // transports it can use. Naming the node after one of them made the type a
  // lie the day Discord was added.
  | 'notify'
  | 'llm'
  | 'respond'
  // — orchestration
  | 'subflow'
  | 'wait';

/**
 * Ce qu'un nœud fait au monde extérieur. Décide de ce qui est rejouable.
 *
 *  - `pure`  : ne touche à rien. Rejouer est gratuit et sans conséquence.
 *  - `read`  : observe l'extérieur sans le modifier. Rejouer coûte un appel.
 *  - `write` : modifie l'extérieur. NE SE REJOUE JAMAIS automatiquement.
 */
export type Effect = 'pure' | 'read' | 'write';

/**
 * L'effet de chaque type, en un seul endroit.
 *
 * `postgres` est classé `write` sans nuance, et c'est délibéré : le moteur ne
 * lit pas le SQL pour deviner si c'est un SELECT. Se tromper dans ce sens
 * coûte une étape marquée « indéterminée » qu'un humain tranche ; se tromper
 * dans l'autre rejouerait un INSERT dans la table d'audit, dont la chaîne de
 * hachage est justement là pour prouver que ça n'arrive pas.
 */
export const NODE_EFFECTS: Record<NodeType, Effect> = {
  'trigger.webhook': 'pure',
  'trigger.subflow': 'pure',
  'trigger.error': 'pure',
  transform: 'pure',
  set: 'pure',
  if: 'pure',
  switch: 'pure',
  merge: 'pure',
  noop: 'pure',
  respond: 'pure',
  http: 'read',
  llm: 'read',
  postgres: 'write',
  notify: 'write',
  subflow: 'write',
  wait: 'write',
};

/** Un nœud du graphe. */
export interface NodeDef {
  /**
   * Identifiant stable. JAMAIS affiché, JAMAIS renommé.
   * C'est lui que le code, le journal d'exécution et les liens référencent.
   */
  id: string;
  type: NodeType;
  /** Libellé affiché. Librement modifiable : rien ne le lit. */
  label: string;
  /** Explication montrée dans l'onglet Workflow, au-dessus du formulaire. */
  note?: string;
  /** Paramètres typés selon `type`. Validés à la publication, pas à l'exécution. */
  params: Record<string, unknown>;
  /** Position dans le graphe. Reprise des workflows n8n, jamais recalculée. */
  position: { x: number; y: number };
  /*
   * NO PER-NODE RETRY POLICY, AND THE ABSENCE IS THE POINT.
   *
   * A `retry?: { attempts, backoffMs }` field lived here. It was declared on
   * five nodes, quoted by a comment in `nodes/io.ts` as the thing that waits
   * out a Discord 429, and PRINTED on the step card in the Ingestion tab — and
   * it was read by nothing. Measured: a node declaring `attempts: 3` is called
   * once, and the journal records `attempt: 1`.
   *
   * What the engine really does with a failure is `NODE_EFFECTS` above: the
   * node takes its `error` port on the first attempt, and a write whose
   * outcome is unknown is NEVER replayed. The field asked for the opposite of
   * that rule — all five nodes carrying it were `postgres`, i.e. `write`, so
   * the card said « NEVER replayed » and « Retries 2 times » one line apart.
   * Whether the engine should gain a real retry is ROADMAP § 7.
   */
}

/**
 * Un lien entre deux nœuds.
 *
 * `fromPort` nomme la SORTIE empruntée : `main` par défaut, `error` pour la
 * branche d'échec, `true`/`false` pour un `if`, un nom de cas pour un
 * `switch`. Nommer les ports plutôt que les numéroter évite le piège n8n où
 * une sortie insérée décalait silencieusement toutes les suivantes.
 */
export interface Edge {
  from: string;
  fromPort: string;
  to: string;
}

export interface WorkflowDef {
  id: string;
  name: string;
  /** Incrémentée à chaque publication. Une exécution garde SA version. */
  version: number;
  nodes: NodeDef[];
  edges: Edge[];
}

// --- Exécution ---------------------------------------------------------------

/**
 * État d'une exécution.
 *
 * `waiting` est distinct de `running` pour une raison précise : l'onglet Suivi
 * déclare une chaîne « à l'arrêt » après 5 minutes sans nouvelle, HORS attente
 * d'approbation. Confondre les deux ferait sonner l'alarme à chaque validation
 * humaine, et une alarme qui sonne toujours ne se lit plus.
 */
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/**
 * État d'une étape.
 *
 * `indeterminate` n'existe dans aucun moteur grand public, et c'est le plus
 * important d'entre eux : il dit « un appel modifiant le monde était en cours
 * quand le processus s'est arrêté, et NOUS NE SAVONS PAS s'il a abouti ».
 * L'inventer dans un sens ou dans l'autre serait combler un trou par une
 * valeur par défaut.
 */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'indeterminate';

/**
 * The step's output was not fetched, because the caller said it would not read it.
 *
 * ============================================================================
 * WHY THIS IS NOT `null`, AND WHY IT IS NOT A STRING EITHER
 *
 * `null` on this field already MEANS something: the node ran and produced
 * nothing. That is the fact `cases.ts` reads to tell a handoff that passed
 * zero items (`empty`) from one that never ran (`absent`) — the detection the
 * Tracking tab exists for. A window that read "not fetched" as `null` would
 * therefore report every chain `broken`, over healthy data, on the one screen
 * whose red must be trustworthy.
 *
 * A symbol, because an output is arbitrary JSON: any string, number or object
 * sentinel is a value some node could legitimately produce one day, and this
 * one cannot be. It never crosses a wire — step outputs are read by the case
 * builder and nothing else serialises them.
 * ============================================================================
 */
export const OUTPUT_NOT_READ: unique symbol = Symbol('step output not read');

/**
 * The run's input was not fetched, because the caller said it would not read it.
 *
 * ============================================================================
 * THE SAME ARGUMENT AS `OUTPUT_NOT_READ`, AND A DIFFERENT FACT UNDERNEATH
 *
 * `soc_run.input` is `jsonb NOT NULL`, which does not make `null` impossible:
 * `createRun` writes `JSON.stringify(run.input ?? null)`, so a run started with
 * nothing holds JSON `null` and comes back as JavaScript `null`. That is the
 * `empty_input` signature the Tracking tab exists to show — a sub-workflow
 * trigger that ran without receiving anything.
 *
 * So `null` here means *this run received nothing*, and a window that reported
 * *not fetched* the same way would turn the diagnostic probe into an
 * `no_alert_id` anomaly after every connectivity test: `cases.ts` recognises
 * the probe by a marker INSIDE the input, and `undefined` on that read is
 * indistinguishable from a payload that does not carry it.
 *
 * A symbol, for the reason the constant above gives: an input is arbitrary
 * JSON, so any string or object sentinel is a payload some source could send.
 * It never crosses a wire — `cases.ts` reads it and nothing serialises it.
 * ============================================================================
 */
export const INPUT_NOT_READ: unique symbol = Symbol('run input not read');

export interface StepRecord {
  runId: string;
  nodeId: string;
  /** Numéro de passage : un nœud dans une boucle en a plusieurs. */
  attempt: number;
  status: StepStatus;
  /**
   * Sortie du nœud. `null` tant qu'il n'a pas abouti — et `OUTPUT_NOT_READ`
   * quand le lecteur a déclaré ne pas la lire (voir `StepReadOptions`).
   */
  output: unknown;
  /** Port emprunté en sortie, qui décide de la suite. */
  port: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  /** Corrélation métier. C'est par lui que la console recolle les cas. */
  alertId: string | null;
  /**
   * Charge utile d'entrée, conservée telle quelle pour permettre un rejeu.
   *
   * `INPUT_NOT_READ` quand le lecteur a déclaré ne pas la lire (voir
   * `RunReadOptions`).
   */
  input: unknown;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

/** Une reprise en attente : approbation humaine, ou simple délai. */
export interface WaitRecord {
  runId: string;
  nodeId: string;
  /** Jeton opaque porté par l'URL de reprise. */
  token: string;
  /** Au-delà, l'attente expire. L'expiration N'EST PAS un accord. */
  deadline: string;
  resumedAt: string | null;
  /** Ce qui a été transmis à la reprise. `null` si expirée. */
  payload: unknown;
}
