/**
 * Persistance de l'état des runs.
 *
 * ============================================================================
 * CE QUE ÇA RÈGLE
 *
 * L'état d'un scan vivait dans deux `Map` en mémoire (`runs`, `emitters`).
 * Deux conséquences, et la seconde est un défaut, pas une limitation :
 *
 *  1. Redémarrer le service effaçait le rapport qu'on était en train de lire.
 *     Pour un produit dont chaque scan coûte de l'argent, perdre le résultat
 *     payé parce qu'un conteneur a redémarré est une perte sèche.
 *
 *  2. **Ces `Map` n'étaient jamais vidées.** Chaque scan y ajoutait ses deux
 *     ou trois cents événements et son rapport complet, définitivement. Un
 *     service qui tourne des semaines les accumulait tous — une fuite mémoire
 *     franche, invisible tant qu'on ne lance que quelques scans à la main.
 *     La persistance la referme : la mémoire ne garde qu'une fenêtre récente,
 *     le disque garde le reste.
 *
 * ============================================================================
 * POURQUOI DU JSONL, UN FICHIER PAR RUN
 *
 * Un run est un JOURNAL : un en-tête, puis des événements qui ne font que
 * s'ajouter, puis une ligne finale. C'est la forme même d'un log append-only,
 * et c'est ce qui le rend sûr en cas de coupure — une écriture interrompue
 * abîme la DERNIÈRE ligne, jamais les précédentes. À la lecture, une ligne
 * illisible est écartée et tout ce qui la précède reste bon.
 *
 * L'alternative — un instantané global réécrit à chaque événement — était
 * exclue par deux fois : elle réécrit tout l'historique à chaque pas (coût en
 * n²), et `writeFileSync` tronque le fichier avant d'écrire, donc une coupure
 * au mauvais moment ne perd pas un événement mais TOUT.
 *
 * ============================================================================
 * LE RUN INTERROMPU — LE POINT LE PLUS IMPORTANT DE CE FICHIER
 *
 * Un run dont le fichier n'a pas de ligne finale n'est pas « en cours » : il
 * est INTERROMPU. Le processus qui l'exécutait n'existe plus, personne ne le
 * reprendra, et son fichier resterait sinon marqué `running` pour toujours.
 *
 * L'afficher comme actif serait exactement le défaut que ce produit passe son
 * temps à traquer : une panne qui montre vert. On le relit donc en
 * `interrupted`, avec la raison, et on le DIT — parce que la seule chose pire
 * qu'un scan interrompu est un scan interrompu qu'on croit encore en train de
 * tourner.
 *
 * On ne prétend pas le reprendre. La pipeline n'est pas jalonnée pas à pas :
 * il n'y a pas d'état intermédiaire à partir duquel repartir, et faire semblant
 * de reprendre relancerait tout en le présentant comme une continuation.
 * ============================================================================
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { cacheDirectory } from '../shared/persistent-cache.ts';
import type { StepEvent } from './step-events.ts';
import type { ScanEstimate } from './estimator.ts';
import type { ScanResult } from './pipeline.ts';

/**
 * Statuts d'un run.
 *
 * `interrupted` n'existait pas tant que rien ne survivait au redémarrage : la
 * question ne se posait pas. Voir l'en-tête.
 */
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';

export interface RunState {
  run_id: string;
  status: RunStatus;
  events: StepEvent[];
  result: ScanResult | null;
  error: string | null;
  /** Devis accepté au lancement, pour comparer promesse et réalité. */
  estimate: ScanEstimate | null;
  /** Date de lancement, ISO 8601. Sert au tri et à la purge. */
  started_at?: string;
}

/** Résumé d'un run, sans ses événements ni son rapport. */
export interface RunSummary {
  run_id: string;
  status: RunStatus;
  started_at: string | null;
  target: string | null;
  findings: number | null;
  error: string | null;
}

/**
 * Format d'un run rangé sur le disque.
 *
 * À INCRÉMENTER quand la forme d'une ligne change. Un fichier d'une autre
 * version est ignoré plutôt que lu de travers — même règle que le cache.
 */
export const RUN_FORMAT_VERSION = 1;

/** Runs gardés sur le disque. Au-delà, les plus anciens sont effacés. */
export const DEFAULT_MAX_RUNS = 200;

/** Runs gardés EN MÉMOIRE. C'est la borne qui referme la fuite. */
export const DEFAULT_MAX_IN_MEMORY = 20;

/**
 * Créations entre deux purges du disque.
 *
 * Le nombre de journaux peut donc dépasser la borne de dix au plus, le temps
 * qu'une purge arrive — un dépassement borné et connu, contre 95 % d'appels
 * système en moins au lancement d'un scan.
 */
export const SWEEP_EVERY_CREATES = 10;

/** Âge maximal d'un run sur le disque : 90 jours. */
export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Un identifiant de run acceptable.
 *
 * ============================================================================
 * CE N'EST PAS UNE FORMALITÉ : C'EST UNE TRAVERSÉE DE RÉPERTOIRE.
 *
 * Les identifiants sont produits par le serveur, mais ils REVIENNENT par
 * l'URL (`GET /runs/:id`). Tant que l'état vivait dans une `Map`, un
 * identifiant biscornu ne faisait qu'échouer la recherche. Depuis qu'il sert à
 * composer un chemin de fichier, `GET /runs/..%2F..%2F..%2Fetc%2Fpasswd`
 * deviendrait une lecture arbitraire du disque.
 *
 * D'où une liste blanche stricte, appliquée AVANT toute composition de chemin :
 * on décrit ce qui est permis, jamais ce qui est interdit. Une liste noire de
 * motifs (`..`, `/`) rate toujours un encodage.
 * ============================================================================
 */
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidRunId(runId: string): boolean {
  return RUN_ID.test(runId);
}

interface HeaderLine {
  t: 'run';
  v: number;
  run_id: string;
  started_at: string;
  estimate: ScanEstimate | null;
}

interface EventLine {
  t: 'event';
  e: StepEvent;
}

interface EndLine {
  t: 'end';
  status: RunStatus;
  error: string | null;
  result: ScanResult | null;
}

type Line = HeaderLine | EventLine | EndLine;

export interface RunStoreOptions {
  /** Dossier des runs. Absent = `<dossier d'état>/runs`. */
  directory?: string;
  maxRuns?: number;
  maxInMemory?: number;
  maxAgeMs?: number;
  /** `false` = tout reste en mémoire, rien n'est lu ni écrit. */
  persist?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function runsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.VULNPIPE_RUNS_DIR ?? join(cacheDirectory(env), 'runs');
}

/**
 * Écrit et referme, en forçant la synchronisation disque.
 *
 * ============================================================================
 * OÙ ELLE EST JUSTIFIÉE, ET OÙ ELLE NE L'EST PAS — MESURÉ
 *
 * `appendFileSync` rend la main dès que le noyau a pris les octets, pas quand
 * ils sont sur le support. `fsync` attend le support. Sur macOS c'est un vrai
 * vidage de cache disque : mesuré ici, il faisait osciller la durée de la
 * suite entre 3,5 s et 32 s pour les mêmes tests — dix fois, et de façon
 * imprévisible. Et il est SYNCHRONE : pendant qu'il attend, la boucle
 * d'événements du service entier est bloquée, scans concurrents compris.
 *
 * Il n'est donc pas gratuit, et il ne se met pas partout « par prudence ». La
 * question à poser à chaque ligne est : que perd-on si une coupure de courant
 * survient dans les quelques millisecondes qui suivent ?
 *
 *   - L'EN-TÊTE : on perdrait le fait qu'un run a commencé. Mais une coupure
 *     de courant a de toute façon tué ce run, et l'utilisateur le relancera.
 *     Un journal absent est même plus clair qu'un journal « interrompu ».
 *     Valeur faible, coût payé au LANCEMENT de chaque scan, donc sur le
 *     chemin où l'utilisateur attend. → PAS de fsync. (Il en avait un ; le
 *     retirer est ce qui a rendu la suite stable.)
 *   - LA LIGNE FINALE : on perdrait le RAPPORT, c'est-à-dire ce qui vient
 *     d'être payé, et le run serait relu « interrompu » alors qu'il a réussi.
 *     Valeur élevée, coût payé une fois par scan, à un moment où plus
 *     personne n'attend. → fsync.
 *
 * Autrement dit : on synchronise ce qui a coûté de l'argent, pas ce qui a
 * coûté une intention.
 * ============================================================================
 */
function appendSynced(file: string, body: string): void {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class RunStore {
  private readonly memory = new Map<string, RunState>();
  private readonly directory: string;
  private readonly maxRuns: number;
  private readonly maxInMemory: number;
  private readonly maxAgeMs: number;
  private readonly persist: boolean;
  /** Événements en attente d'écriture, par run. */
  private readonly pending = new Map<string, string[]>();

  constructor(options: RunStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.persist = options.persist ?? env.VULNPIPE_CACHE_PERSIST !== 'false';
    this.directory = options.directory ?? runsDirectory(env);
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.maxInMemory = options.maxInMemory ?? DEFAULT_MAX_IN_MEMORY;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  private fileFor(runId: string): string | null {
    // Barrière unique : tout chemin passe par ici, et rien ne sort d'ici sans
    // avoir été validé. Un appelant qui oublierait de valider ne peut pas
    // fabriquer de chemin.
    if (!isValidRunId(runId)) return null;
    return join(this.directory, `${runId}.jsonl`);
  }

  /** Enregistre un run qui démarre. */
  create(state: RunState): void {
    const started = state.started_at ?? new Date().toISOString();
    const complete: RunState = { ...state, started_at: started };
    this.memory.set(state.run_id, complete);
    this.trimMemory();

    if (!this.persist) return;
    const file = this.fileFor(state.run_id);
    if (!file) return;

    const header: HeaderLine = {
      t: 'run',
      v: RUN_FORMAT_VERSION,
      run_id: state.run_id,
      started_at: started,
      estimate: state.estimate,
    };
    try {
      mkdirSync(this.directory, { recursive: true });
      // Écriture ORDINAIRE, sans synchronisation forcée : voir `appendSynced`.
      // Elle est sur le chemin du lancement, là où quelqu'un attend, et ce
      // qu'elle protégerait ne vaut pas ce qu'elle coûterait.
      appendFileSync(file, `${JSON.stringify(header)}\n`);
    } catch {
      // Un disque qui refuse ne doit pas empêcher le scan : on continue en
      // mémoire seule. C'est la seule dégradation acceptable.
    }
    this.sweep();
  }

  /** Ajoute un événement. Groupé : deux cents événements ≠ deux cents écritures. */
  appendEvent(runId: string, event: StepEvent): void {
    const state = this.memory.get(runId);
    if (state) state.events.push(event);
    if (!this.persist) return;

    const line: EventLine = { t: 'event', e: event };
    const queue = this.pending.get(runId) ?? [];
    queue.push(`${JSON.stringify(line)}\n`);
    this.pending.set(runId, queue);
    // Regroupé par paquets : une écriture par événement mettrait du disque sur
    // le chemin critique d'un appel réseau, pour un journal dont personne ne
    // lit la dernière ligne en direct (le direct passe par le flux SSE).
    if (queue.length >= 25) this.flushEvents(runId);
  }

  private flushEvents(runId: string): void {
    const queue = this.pending.get(runId);
    if (!queue || queue.length === 0) return;
    this.pending.delete(runId);
    const file = this.fileFor(runId);
    if (!file) return;
    try {
      // Pas de `fsync` ici : perdre les derniers événements d'un journal de
      // progression est sans conséquence — le rapport, lui, est écrit
      // synchronisé par `finish`.
      appendFileSync(file, queue.join(''));
    } catch {
      // idem : le scan prime sur son journal
    }
  }

  /** Clôt un run : statut définitif, rapport, erreur. */
  finish(runId: string, patch: { status: RunStatus; error?: string | null; result?: ScanResult | null }): void {
    const state = this.memory.get(runId);
    if (state) {
      state.status = patch.status;
      if (patch.error !== undefined) state.error = patch.error;
      if (patch.result !== undefined) state.result = patch.result;
    }
    if (!this.persist) return;

    this.flushEvents(runId);
    const file = this.fileFor(runId);
    if (!file) return;

    const end: EndLine = {
      t: 'end',
      status: patch.status,
      error: patch.error ?? state?.error ?? null,
      result: patch.result ?? state?.result ?? null,
    };
    try {
      // Synchronisé : c'est CETTE ligne qui distingue un run terminé d'un run
      // interrompu. La perdre ferait afficher « interrompu » sur un scan qui a
      // parfaitement réussi — et refacturer, si on relançait.
      appendSynced(file, `${JSON.stringify(end)}\n`);
    } catch {
      // le résultat reste en mémoire pour cette session
    }
  }

  /** Met à jour le statut sans clore (queued -> running). */
  setStatus(runId: string, status: RunStatus): void {
    const state = this.memory.get(runId);
    if (state) state.status = status;
  }

  /** Lit un run : mémoire d'abord, disque ensuite. */
  get(runId: string): RunState | null {
    const live = this.memory.get(runId);
    if (live) return live;
    if (!this.persist) return null;
    return this.readFromDisk(runId)?.state ?? null;
  }

  /**
   * Relit un run depuis son journal.
   *
   * Une ligne illisible est ÉCARTÉE, jamais fatale : c'est toute la raison
   * d'être du format ligne à ligne. En pratique il n'y en a qu'une, la
   * dernière, quand une écriture a été coupée.
   */
  private readFromDisk(runId: string): { state: RunState; sealed: boolean } | null {
    const file = this.fileFor(runId);
    if (!file || !existsSync(file)) return null;

    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }

    const state: RunState = {
      run_id: runId,
      status: 'interrupted',
      events: [],
      result: null,
      error: null,
      estimate: null,
      started_at: undefined,
    };
    let sawHeader = false;
    let sawEnd = false;

    for (const raw_line of raw.split('\n')) {
      if (!raw_line) continue;
      let line: Line;
      try {
        line = JSON.parse(raw_line) as Line;
      } catch {
        // Écriture coupée : on garde tout ce qui précède.
        continue;
      }
      if (line.t === 'run') {
        if (line.v !== RUN_FORMAT_VERSION) return null;
        sawHeader = true;
        state.started_at = line.started_at;
        state.estimate = line.estimate;
      } else if (line.t === 'event') {
        state.events.push(line.e);
      } else if (line.t === 'end') {
        sawEnd = true;
        state.status = line.status;
        state.error = line.error;
        state.result = line.result;
      }
    }

    if (!sawHeader) return null;

    if (!sawEnd) {
      // PAS DE LIGNE FINALE = INTERROMPU. Le processus qui l'exécutait
      // n'existe plus. Le laisser en `running` serait une panne qui montre
      // vert ; prétendre le reprendre serait pire encore.
      state.status = 'interrupted';
      state.error =
        state.error ??
        'This scan was interrupted before it finished — the service stopped while it was running. Nothing it had already reported is lost, but it never reached a report. Run it again to get one.';
    }

    // `sealed` = le journal porte une ligne finale ÉCRITE. Sans cette
    // distinction, `recoverInterrupted` ne peut pas savoir si un run
    // interrompu a déjà été gravé, et le regrave à chaque démarrage : le
    // fichier grossit sans fin, et le même scan est réannoncé comme
    // « interrompu » des mois après que la personne l'a su.
    return { state, sealed: sawEnd };
  }

  /**
   * Runs connus, du plus récent au plus ancien.
   *
   * Lit les en-têtes et les lignes finales, pas les événements : lister deux
   * cents runs ne doit pas charger deux cents rapports complets en mémoire.
   */
  list(limit = 50): RunSummary[] {
    const seen = new Map<string, RunSummary>();

    for (const [runId, state] of this.memory) {
      seen.set(runId, this.summarize(state));
    }

    if (this.persist) {
      for (const runId of this.diskRunIds()) {
        if (seen.has(runId)) continue;
        const read = this.readFromDisk(runId);
        if (read) seen.set(runId, this.summarize(read.state));
      }
    }

    return [...seen.values()]
      .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
      .slice(0, Math.max(0, limit));
  }

  private summarize(state: RunState): RunSummary {
    return {
      run_id: state.run_id,
      status: state.status,
      started_at: state.started_at ?? null,
      target: state.result?.target.label ?? null,
      findings: state.result?.report.scan_summary.total_findings ?? null,
      error: state.error,
    };
  }

  private diskRunIds(): string[] {
    try {
      return readdirSync(this.directory)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -'.jsonl'.length))
        .filter(isValidRunId);
    } catch {
      return [];
    }
  }

  /**
   * Ferme les runs restés ouverts par un arrêt du service.
   *
   * Appelé au démarrage. Écrit une ligne finale `interrupted` dans chaque
   * journal sans fin, pour que la relecture suivante n'ait plus à le déduire —
   * et surtout pour que le fait soit ÉCRIT, pas recalculé à chaque lecture.
   *
   * Renvoie les identifiants concernés : le service les annonce au démarrage.
   * Un scan qui a disparu dans un redémarrage sans que rien ne le dise, c'est
   * la personne qui attend un rapport qui n'arrivera jamais.
   */
  recoverInterrupted(): string[] {
    if (!this.persist) return [];
    const recovered: string[] = [];

    for (const runId of this.diskRunIds()) {
      const read = this.readFromDisk(runId);
      // `sealed` : la ligne finale est déjà écrite, donc ce run a déjà été
      // repris. Le regraver ferait grossir son journal à chaque démarrage et
      // le ferait réannoncer indéfiniment.
      if (!read || read.sealed || read.state.status !== 'interrupted') continue;
      const file = this.fileFor(runId);
      if (!file) continue;
      try {
        appendSynced(
          file,
          `${JSON.stringify({ t: 'end', status: 'interrupted', error: read.state.error, result: null } satisfies EndLine)}\n`
        );
        recovered.push(runId);
      } catch {
        // Rien à faire : la relecture le redéduira de toute façon.
      }
    }

    return recovered;
  }

  /** Garde en mémoire une fenêtre récente : c'est ce qui referme la fuite. */
  private trimMemory(): void {
    while (this.memory.size > this.maxInMemory) {
      const oldest = this.memory.keys().next();
      if (oldest.done === true) break;
      // Les événements en attente de ce run partent sur le disque avant qu'il
      // quitte la mémoire, sinon ils seraient perdus sans jamais être écrits.
      this.flushEvents(oldest.value);
      this.memory.delete(oldest.value);
    }
  }

  /**
   * Purge le disque : trop de runs, ou trop vieux.
   *
   * ESPACÉE. Elle était appelée à CHAQUE création de run, et elle lit le
   * dossier puis interroge chaque fichier : avec deux cents journaux
   * conservés, lancer un scan coûtait deux cents appels système avant même
   * d'avoir commencé. Sur une rafale, des dizaines de milliers pour rien.
   *
   * ESPACÉE PAR LE TRAVAIL, PAS SEULEMENT PAR LE TEMPS. Une première version
   * n'espaçait que dans le temps (trente secondes) — et la rétention cessait
   * de tenir : vingt runs créés en une seconde laissaient vingt fichiers pour
   * une borne de cinq. Une purge qu'on repousse assez longtemps est une purge
   * qui n'a pas lieu. Le compteur de créations garantit qu'elle arrive, le
   * minuteur qu'elle ne coûte rien sur un service au repos ; le nombre de
   * fichiers ne dépasse donc jamais la borne de plus d'un intervalle.
   */
  private lastSweep = 0;
  private createsSinceSweep = 0;

  private sweep(): void {
    if (!this.persist) return;
    this.createsSinceSweep += 1;
    const now = Date.now();
    if (this.createsSinceSweep < SWEEP_EVERY_CREATES && now - this.lastSweep < 30_000) return;
    this.lastSweep = now;
    this.createsSinceSweep = 0;
    let files: Array<{ path: string; mtime: number }>;
    try {
      files = this.diskRunIds()
        .map((runId) => join(this.directory, `${runId}.jsonl`))
        .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return;
    }

    const doomed = files.filter((file, index) => index >= this.maxRuns || now - file.mtime > this.maxAgeMs);
    for (const file of doomed) {
      try {
        rmSync(file.path, { force: true });
      } catch {
        // un fichier qu'on n'arrive pas à effacer n'est pas une panne
      }
    }
  }

  /** Écrit ce qui reste en attente. À appeler à l'arrêt. */
  flushAll(): void {
    for (const runId of [...this.pending.keys()]) this.flushEvents(runId);
  }

  /** Oublie tout, mémoire et disque. */
  forget(): void {
    this.memory.clear();
    this.pending.clear();
    if (!this.persist) return;
    try {
      rmSync(this.directory, { recursive: true, force: true });
    } catch {
      // rien à faire
    }
  }

  /** Nombre de runs gardés en mémoire — pour les tests et le diagnostic. */
  get liveCount(): number {
    return this.memory.size;
  }
}
