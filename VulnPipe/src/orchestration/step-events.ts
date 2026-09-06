/**
 * Événements de progression publiés par chaque étape de la pipeline.
 *
 * C'est ce que l'UI consomme pour afficher la timeline « Vibe Coder Mode ».
 *
 * ============================================================================
 * AJOUTS PAR RAPPORT À LA SPEC
 *
 * L'exemple donné par PHASE_6 est :
 *   { step: "indexing", status: "running" | "done", plain_language: "..." }
 *
 * Trois manques rendent une vraie timeline impossible :
 *
 *  1. Pas de statut d'ÉCHEC. Avec `running | done` seulement, une étape qui
 *     plante reste éternellement « en cours » ou saute directement à
 *     « terminé ». C'est le même mode de défaillance rencontré en Phase 4 et 5 :
 *     une panne qui ressemble à un succès. `failed` est indispensable.
 *  2. Pas d'horodatage ni d'ordre. Une file de messages ne garantit pas
 *     l'ordre d'arrivée ; sans `seq`, l'UI affiche la timeline dans le
 *     désordre dès que deux nodes tournent en parallèle.
 *  3. Pas d'identifiant de run. Deux scans simultanés mélangeraient leurs
 *     événements dans la même interface.
 * ============================================================================
 */

export type StepStatus = 'running' | 'done' | 'failed' | 'skipped';

/** Étapes de la pipeline, dans l'ordre de CLAUDE.md §2. */
export type StepName =
  | 'received'
  | 'indexing'
  | 'context_server'
  | 'detection'
  | 'aggregation'
  | 'master_review'
  | 'report';

export interface StepEvent {
  run_id: string;
  /** Numéro d'ordre monotone : l'UI trie dessus, pas sur l'heure d'arrivée. */
  seq: number;
  step: StepName;
  status: StepStatus;
  /** Texte destiné à l'utilisateur. Jamais de nom de composant technique. */
  plain_language: string;
  /** ISO 8601. */
  at: string;
  /** Détail facultatif : nom du node, route en cours, message d'erreur. */
  detail?: string;
  /** Progression fine quand l'étape traite plusieurs éléments. */
  progress?: { done: number; total: number };
  /**
   * Adresse concernée par cet événement.
   *
   * AJOUT : sans elle, la phase de détection n'est qu'une barre qui avance.
   * L'utilisateur voit « 7 sur 34 » sans savoir CE QUI est en train d'être
   * vérifié — or c'est précisément ce qui rend l'attente supportable et le
   * produit crédible : on lui montre le travail, pas juste sa durée.
   */
  route?: { http_method: string; route: string };
  /** Verdict rendu sur cette adresse, dès qu'il est connu. */
  verdict?: {
    vulnerability: string;
    confidence_score: number;
    /** Zone de décision (CLAUDE.md §3), déjà traduite côté serveur. */
    zone: 'sain' | 'a_verifier' | 'alerte';
    /** true si rien n'a été facturé pour ce verdict. */
    free: boolean;
    /**
     * true si la gratuité vient du CACHE — verdict déjà rendu sur exactement
     * ce code — et non du scanner déterministe.
     *
     * Deux gratuités, deux phrases différentes à l'écran : « tranché sans
     * modèle » et « déjà connu » ne racontent pas la même chose de la
     * couverture réelle du détecteur déterministe.
     */
    cached?: boolean;
    plain_language_summary: string;
  };
  /** Consommation cumulée à l'instant de l'événement. */
  usage?: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cost_usd: number | null;
    elapsed_ms: number;
  };
}

/** Traduit un score en zone de décision (CLAUDE.md §3). */
export function zoneOf(score: number): 'sain' | 'a_verifier' | 'alerte' {
  if (score < 0.4) return 'sain';
  if (score <= 0.7) return 'a_verifier';
  return 'alerte';
}

export type StepListener = (event: StepEvent) => void;

/**
 * Émetteur d'événements avec numérotation garantie.
 *
 * Volontairement sans dépendance : `EventEmitter` de Node ne garantit pas
 * l'ordre entre producteurs concurrents, et c'est précisément ce qu'il faut
 * ici quand plusieurs nodes de détection publient en parallèle.
 */
export class StepEmitter {
  readonly runId: string;
  private seq = 0;
  private readonly listeners: StepListener[] = [];
  private readonly history: StepEvent[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  on(listener: StepListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  emit(
    step: StepName,
    status: StepStatus,
    plainLanguage: string,
    extra: Omit<StepEvent, 'run_id' | 'seq' | 'step' | 'status' | 'plain_language' | 'at'> = {}
  ): StepEvent {
    const event: StepEvent = {
      run_id: this.runId,
      seq: this.seq++,
      step,
      status,
      plain_language: plainLanguage,
      at: new Date().toISOString(),
      ...extra,
    };
    this.history.push(event);
    // Un listener qui plante ne doit jamais interrompre le scan.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignoré volontairement
      }
    }
    return event;
  }

  /** Rejouable : un client qui se connecte en cours de scan récupère le passé. */
  getHistory(): StepEvent[] {
    return [...this.history];
  }
}
