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
  /**
   * Politique de reprise sur échec.
   * Absente = pas de reprise : un nœud qui échoue arrête sa branche.
   */
  retry?: { attempts: number; backoffMs: number };
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

export interface StepRecord {
  runId: string;
  nodeId: string;
  /** Numéro de passage : un nœud dans une boucle en a plusieurs. */
  attempt: number;
  status: StepStatus;
  /** Sortie du nœud. `null` tant qu'il n'a pas abouti. */
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
  /** Charge utile d'entrée, conservée telle quelle pour permettre un rejeu. */
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
