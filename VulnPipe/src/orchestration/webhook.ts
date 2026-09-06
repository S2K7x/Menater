/**
 * Serveur HTTP : réception du webhook Git + flux d'événements pour l'UI.
 *
 * Volontairement bâti sur `node:http` plutôt qu'Express : quatre routes ne
 * justifient pas une dépendance de plus dans un MVP.
 *
 * Routes :
 *   POST /estimate      { target, mode, commit_sha? }     -> devis avant scan
 *   POST /webhook       { repo_path|target, mode, ... }   -> lance un scan
 *   GET  /runs/:id/events   flux SSE de progression (rejoue l'historique)
 *   GET  /runs/:id          état + rapport final + consommation
 *   GET  /providers         fournisseurs disponibles (sélecteur de l'UI)
 *   POST /providers         change le fournisseur actif
 *   GET  /settings          réglages d'analyse (arbitrage) + seuils
 *   POST /settings          change un réglage d'analyse
 *   GET  /provider-keys     état des clés de moteur (posée / absente, d'où)
 *   PUT  /provider-keys     enregistre une clé, prise en compte à chaud
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  createLlmClient,
  describeProviders,
  parseEffort,
  SUPPORTED_PROVIDERS,
  type ProviderName,
} from '../nodes/shared/llm/factory.ts';
import { LlmError, type EffortLevel, type LlmClient } from '../nodes/shared/llm/types.ts';
import { DIRECT_ALERT_ABOVE, REJECT_BELOW } from '../aggregator/aggregator.ts';
import { StepEmitter, type StepEvent } from './step-events.ts';
import { isValidRunId, RunStore, type RunState } from './run-store.ts';
import { UsageTracker } from './usage-tracker.ts';
import { InMemoryArbitrationCache } from '../master/arbitration-cache.ts';
import { InMemoryVerdictCache } from '../nodes/shared/verdict-cache.ts';
import { DebouncedCacheWriter, DEFAULT_MAX_AGE_MS, loadCache } from '../shared/persistent-cache.ts';
import {
  DEFAULT_DETECTION_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  normalizeConcurrency,
} from './pool.ts';
import { runScan, selectRoutes, type PreparedScan, type ScanMode, type ScanRequest, type ScanResult } from './pipeline.ts';
import { estimateScan, prepareTarget, type ScanEstimate } from './estimator.ts';
import { resolveTarget, TargetError } from './scan-target.ts';
import { normalizeLocale, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';
import { describeKeys, isManagedKey, KeyStoreError, setKeys } from '../config/keystore.ts';
import type { JobQueue } from './queue.ts';

/**
 * Durée de vie d'un devis, en millisecondes.
 *
 * Un devis retient des ressources : l'index en mémoire et, pour un dépôt
 * GitHub, un clone sur le disque. Sans expiration, un utilisateur qui demande
 * dix devis puis ferme son navigateur laisse dix clones derrière lui.
 */
const ESTIMATE_TTL_MS = 15 * 60 * 1000;

/**
 * L'état d'un run vit désormais dans `run-store.ts`, avec sa persistance.
 * Ré-exporté ici parce que c'était son adresse historique : le déplacer sans
 * laisser de suivi casserait les appelants pour rien.
 */
export type { RunState, RunStatus, RunSummary } from './run-store.ts';

interface StoredEstimate {
  id: string;
  estimate: ScanEstimate;
  prepared: PreparedScan;
  expiresAt: number;
  /** true dès qu'un scan a consommé ce devis : il ne sera pas repris. */
  claimed: boolean;
}

/**
 * Configuration modifiable à chaud des fournisseurs.
 *
 * Répond à la demande « pouvoir switch les providers facilement » : le choix
 * ne vit plus uniquement dans les variables d'environnement au démarrage, il
 * est modifiable depuis l'interface, sans redémarrer le serveur.
 */
export interface ProviderSettings {
  nodeProvider: ProviderName;
  nodeModel?: string;
  /** Profondeur de raisonnement des détecteurs. Absent = défaut du modèle. */
  nodeEffort?: EffortLevel;
  masterProvider: ProviderName;
  masterModel?: string;
  /** Profondeur de raisonnement de l'arbitre. Absent = défaut du modèle. */
  masterEffort?: EffortLevel;
}

/**
 * Réglages d'analyse modifiables à chaud, distincts du choix des moteurs.
 *
 * Ils vivent sur le serveur et non dans le navigateur : ils changent ce que la
 * pipeline FAIT (et ce qu'elle facture), pas la façon dont l'écran l'affiche.
 * Deux onglets ouverts sur la même machine doivent lancer des scans réglés à
 * l'identique.
 */
export interface ScanSettings {
  /** Remonte les findings > 0.7 sans arbitrage Claude (CLAUDE.md §3). */
  bypassClaudeForHighConfidence: boolean;
  /**
   * Nombre d'adresses examinées en même temps.
   *
   * C'est le réglage vitesse / prudence. Monter la valeur raccourcit le scan
   * dans la même proportion, tant que le fournisseur suit ; la dépasser fait
   * arriver des refus de quota, que la reprise absorbe au prix de l'attente
   * qu'on cherchait justement à éviter. Voir `pool.ts` pour le choix du
   * défaut, calé sur le palier gratuit le plus étroit.
   */
  detectionConcurrency: number;
}

export interface ServerOptions {
  queue: JobQueue<ScanRequest & { run_id: string; estimate_id?: string }>;
  settings?: Partial<ProviderSettings>;
  scanSettings?: Partial<ScanSettings>;
  /** Plafond de devis retenus simultanément. Voir MAX_PENDING_ESTIMATES. */
  maxPendingEstimates?: number;
  /** Plafond d'émetteurs retenus. Voir MAX_LIVE_EMITTERS. */
  maxLiveEmitters?: number;
  env?: NodeJS.ProcessEnv;
}

export function createVulnPipeServer(options: ServerOptions) {
  const env = options.env ?? process.env;
  /**
   * L'état des runs — sur le disque, plus seulement en mémoire.
   *
   * Remplace une `Map` QUI N'ÉTAIT JAMAIS VIDÉE : chaque scan y laissait ses
   * deux cents événements et son rapport complet, définitivement. Le store
   * garde une fenêtre récente en mémoire et range le reste (voir
   * `run-store.ts`).
   */
  const runStore = new RunStore({ env: env as NodeJS.ProcessEnv });
  // Un seul cache pour tout le serveur : son intérêt est justement de survivre
  // d'un scan au suivant. Il disparaît au redémarrage, comme l'état des runs.
  const arbitrationCache = new InMemoryArbitrationCache(undefined, { maxAgeMs: DEFAULT_MAX_AGE_MS });
  // Le cache des verdicts de détection, lui aussi unique pour tout le serveur :
  // son intérêt est de survivre d'un scan au suivant, et c'est celui qui porte
  // l'essentiel de l'économie (85 à 90 % des appels sont des détections).
  const verdictCache = new InMemoryVerdictCache(undefined, { maxAgeMs: DEFAULT_MAX_AGE_MS });

  // --- Persistance des caches ------------------------------------------------
  //
  // Les deux caches survivent désormais au redémarrage. C'est ce qui rend leur
  // économie réelle : en mémoire, un `docker compose restart` la remettait à
  // zéro, et le scan suivant repayait tout — exactement la situation d'avant
  // le cache. Voir `shared/persistent-cache.ts` pour la décision de stockage
  // et pour ce que la persistance oblige à rattraper.
  //
  // `VULNPIPE_CACHE_PERSIST=false` éteint tout : les caches restent en
  // mémoire, rien n'est lu ni écrit. Utile en test et sur un poste où le
  // dossier d'état n'est pas souhaité.
  const persistCaches = env.VULNPIPE_CACHE_PERSIST !== 'false';

  const cacheStores = persistCaches
    ? {
        verdict: new DebouncedCacheWriter(verdictCache.lru, { kind: 'verdicts' }, 2_000, env as NodeJS.ProcessEnv),
        arbitration: new DebouncedCacheWriter(
          arbitrationCache.lru,
          { kind: 'arbitration' },
          2_000,
          env as NodeJS.ProcessEnv
        ),
      }
    : null;

  /**
   * Ce que la reprise a donné — DIT, pas seulement journalisé.
   *
   * Un cache qui annonce deux mille entrées alors qu'il en a repris zéro
   * (fichier d'une autre version, disque neuf) ferait chercher longtemps
   * pourquoi le scan « censé être gratuit » facture tout.
   */
  /**
   * Runs qu'un arrêt du service a laissés en plan.
   *
   * Gravés `interrupted` maintenant plutôt que redéduits à chaque lecture, et
   * ANNONCÉS : quelqu'un attend peut-être un rapport qui n'arrivera jamais.
   * Un scan qui disparaît dans un redémarrage sans que rien ne le dise, c'est
   * la panne qui montre vert dont ce produit fait son affaire.
   */
  const interruptedRuns = runStore.recoverInterrupted();

  const cacheLoad: Array<{ kind: string; kept: number; dropped: number; why: string | null }> = [];
  if (persistCaches) {
    for (const [kind, lru] of [
      ['verdicts', verdictCache.lru],
      ['arbitration', arbitrationCache.lru],
    ] as const) {
      const outcome = loadCache(lru as never, { kind }, env as NodeJS.ProcessEnv);
      cacheLoad.push({ kind, ...outcome });
    }
  }
  /**
   * Émetteurs des runs EN COURS seulement.
   *
   * Ils ne servent qu'au direct : une fois le run terminé, le flux SSE se
   * rejoue depuis le journal du store. Les garder tous était l'autre moitié de
   * la fuite — un `StepEmitter` retient tout son historique.
   */
  const emitters = new Map<string, StepEmitter>();

  /**
   * Retire l'émetteur d'un run terminé, après un délai de grâce.
   *
   * Pas tout de suite : un client dont la requête SSE est arrivée pendant que
   * le scan se terminait doit encore trouver l'émetteur pour recevoir sa
   * trame de fin. Trente secondes suffisent, et bornent la mémoire.
   */
  // Réglable pour la même raison que le plafond de devis : vérifier une borne
  // ne doit pas coûter soixante-dix scans réels à chaque `npm test`.
  const MAX_LIVE_EMITTERS = Math.max(1, options.maxLiveEmitters ?? 64);

  const retireEmitter = (runId: string): void => {
    const timer = setTimeout(() => emitters.delete(runId), 30_000);
    timer.unref?.();
  };

  /**
   * Plafond DUR sur le nombre d'émetteurs retenus.
   *
   * Le délai de grâce de trente secondes borne la durée, pas la quantité : une
   * rafale de scans courts en accumule autant qu'elle en lance, et chaque
   * émetteur retient tout l'historique de son run. La durée protège le client
   * qui se branche en retard ; ce plafond protège la mémoire.
   *
   * ==========================================================================
   * IL NE TOUCHE JAMAIS À UN RUN VIVANT. Trouvé en relisant l'interaction
   * entre ce plafond et la file.
   *
   * La file traite les jobs un par un : lancer soixante-cinq scans les met
   * tous en attente, avec leur émetteur. Une version qui évinçait simplement
   * « le plus ancien » retirait donc l'émetteur du PREMIER scan de la file —
   * celui qui allait justement démarrer. Le traitement le retrouvait absent
   * et marquait le run en échec : un scan légitime, jamais lancé, présenté
   * comme une panne.
   *
   * On n'évince donc que les runs déjà TERMINÉS. Si aucun ne l'est, la carte
   * dépasse temporairement le plafond — c'est la bonne direction : de la
   * mémoire coûte moins cher qu'un scan perdu, et une file de soixante-cinq
   * scans en attente est un problème en soi, pas un problème d'émetteurs.
   * ==========================================================================
   */
  const capEmitters = (): void => {
    if (emitters.size <= MAX_LIVE_EMITTERS) return;
    for (const runId of [...emitters.keys()]) {
      if (emitters.size <= MAX_LIVE_EMITTERS) return;
      const status = runStore.get(runId)?.status;
      if (status === 'queued' || status === 'running') continue;
      emitters.delete(runId);
    }
  };

  const settings: ProviderSettings = {
    nodeProvider: (options.settings?.nodeProvider ?? env.VULNPIPE_LLM_PROVIDER ?? 'gemini') as ProviderName,
    nodeModel: options.settings?.nodeModel ?? env.VULNPIPE_LLM_MODEL,
    nodeEffort: options.settings?.nodeEffort ?? parseEffort(env.VULNPIPE_LLM_EFFORT),
    masterProvider: (options.settings?.masterProvider ??
      env.VULNPIPE_MASTER_PROVIDER ??
      'anthropic') as ProviderName,
    masterModel: options.settings?.masterModel ?? env.VULNPIPE_MASTER_MODEL,
    masterEffort: options.settings?.masterEffort ?? parseEffort(env.VULNPIPE_MASTER_EFFORT),
  };

  const scanSettings: ScanSettings = {
    bypassClaudeForHighConfidence:
      options.scanSettings?.bypassClaudeForHighConfidence ??
      env.VULNPIPE_BYPASS_MASTER === 'true',
    // Une valeur d'environnement hors bornes est IGNORÉE, pas ramenée en
    // silence dans les clous : `VULNPIPE_DETECTION_CONCURRENCY=200` doit
    // laisser le défaut en place plutôt que faire croire à un réglage appliqué.
    detectionConcurrency:
      options.scanSettings?.detectionConcurrency ??
      normalizeConcurrency(env.VULNPIPE_DETECTION_CONCURRENCY) ??
      DEFAULT_DETECTION_CONCURRENCY,
  };

  /**
   * État des caches, pour l'écran.
   *
   * Rendu VISIBLE à dessein : une mémoire qu'on ne voit pas est une mémoire
   * qu'on ne pense pas à vider, et c'est le premier réflexe quand on soupçonne
   * un verdict figé. Les compteurs décrivent la session en cours ; `entries`
   * décrit ce qui a été repris du disque en plus.
   */
  const describeCaches = () => ({
    persisted: persistCaches,
    /** Ce que la reprise au démarrage a donné, y compris quand elle a échoué. */
    restored: cacheLoad,
    detection: {
      entries: verdictCache.size,
      hits: verdictCache.hits,
      misses: verdictCache.misses,
      expired: verdictCache.expired,
    },
    arbitration: {
      entries: arbitrationCache.size,
      hits: arbitrationCache.hits,
      misses: arbitrationCache.misses,
      expired: arbitrationCache.expired,
    },
  });

  /** Indique quels fournisseurs sont réellement utilisables (clé présente). */
  const providerAvailability = (locale: Locale = 'en') => describeProviders(env as never, locale);

  /**
   * Repli sur un fournisseur utilisable si le réglage par défaut n'a pas sa clé.
   *
   * Sans ça, la configuration livrée (arbitre = anthropic) faisait échouer tout
   * scan sur une machine sans `ANTHROPIC_API_KEY` — et l'échec ne survenait
   * qu'après avoir déjà payé toute la phase de détection. Mieux vaut basculer
   * sur ce qui marche et l'écrire, que planter au milieu.
   */
  /**
   * Repli de fournisseur : on retient CE QUI a été remplacé.
   *
   * CE REPLI NE PRODUIT PLUS DE BANDEAU SUR L'ÉCRAN D'ANALYSE. La phrase
   * « la relecture finale devait utiliser X, dont la clé est absente… »
   * s'affichait à chaque scan, en tête de résultat, dans un vocabulaire
   * (fournisseur, clé d'accès) qui ne veut rien dire pour quelqu'un qui veut
   * juste savoir si son code est sûr — et elle ne demandait aucune action.
   *
   * L'information n'est pas perdue : la page Réglages affiche le moteur
   * réellement actif et dit, fournisseur par fournisseur, lequel est
   * utilisable. C'est là qu'on peut agir, donc c'est là que ça se lit.
   */
  const fallbacks: Array<{ role: 'detection' | 'arbitration'; wanted: string; used: string }> = [];
  const notesFor = (_locale: Locale): string[] => [];
  {
    const availability = providerAvailability();
    const usable = (id: ProviderName): boolean =>
      availability.find((entry) => entry.id === id)?.available === true;
    const firstUsable = availability.find((entry) => entry.available)?.id;

    for (const role of ['nodeProvider', 'masterProvider'] as const) {
      if (usable(settings[role]) || !firstUsable) continue;
      const wanted = settings[role];
      settings[role] = firstUsable;
      fallbacks.push({
        role: role === 'nodeProvider' ? 'detection' : 'arbitration',
        wanted,
        used: firstUsable,
      });
    }
  }

  function buildClient(provider: ProviderName, model?: string, effort?: EffortLevel): LlmClient {
    return createLlmClient({
      ...env,
      VULNPIPE_LLM_PROVIDER: provider,
      VULNPIPE_LLM_MODEL: model,
      VULNPIPE_LLM_EFFORT: effort,
    } as never);
  }

  // --- Devis en attente ------------------------------------------------------
  //
  // ==========================================================================
  // CETTE CARTE EST BORNÉE, ET ELLE NE L'ÉTAIT PAS. TROUVÉ PAR `npm run qa`.
  //
  // Un devis n'est pas un objet léger : il RETIENT l'index complet du dépôt —
  // c'est tout son intérêt, le scan qui suit n'a plus rien à réindexer — et,
  // pour une cible GitHub, le clone temporaire qui va avec.
  //
  // Le balayage périodique ne libérait que les devis EXPIRÉS, toutes les
  // soixante secondes. Dans cette fenêtre, rien ne limitait leur nombre :
  // soixante demandes d'estimation retenaient soixante index (21 Mo mesurés
  // sur une fixture de quatre fichiers, sans commune mesure avec un vrai
  // dépôt), et autant de dossiers temporaires. Il n'y a pas besoin d'un
  // attaquant pour y arriver : quelqu'un qui reclique « Estimer » suffit.
  //
  // On plafonne donc le NOMBRE, en plus de la durée. Quand le plafond est
  // atteint, le plus ancien devis NON RÉCLAMÉ est libéré — jamais un devis
  // qu'un scan est en train d'utiliser. Celui qui le présentera ensuite
  // reçoit le 409 « devis inconnu ou expiré » qui existe déjà, et qui dit la
  // vérité : il n'est plus là.
  // ==========================================================================
  //
  // Réglable par le déploiement : un poste qui analyse de gros dépôts voudra
  // en retenir moins (chaque devis pèse un index), et les tests en veulent
  // peu pour ne pas indexer trente fois pour vérifier une borne.
  const MAX_PENDING_ESTIMATES = Math.max(
    1,
    Number(env.VULNPIPE_MAX_PENDING_ESTIMATES) || options.maxPendingEstimates || 24
  );
  const estimates = new Map<string, StoredEstimate>();

  const releaseEstimate = async (stored: StoredEstimate): Promise<void> => {
    estimates.delete(stored.id);
    await stored.prepared.close().catch(() => {});
    await stored.prepared.target.cleanup().catch(() => {});
  };

  const sweepEstimates = async (): Promise<void> => {
    const now = Date.now();
    for (const stored of [...estimates.values()]) {
      if (!stored.claimed && stored.expiresAt <= now) await releaseEstimate(stored);
    }
  };

  /**
   * Fait de la place avant d'ajouter un devis.
   *
   * `Map` conserve l'ordre d'insertion : le premier non réclamé est le plus
   * ancien. On ne touche JAMAIS à un devis réclamé — un scan s'en sert, et le
   * lui retirer ferait échouer un travail déjà lancé.
   */
  const makeRoomForEstimate = async (): Promise<void> => {
    while (estimates.size >= MAX_PENDING_ESTIMATES) {
      const oldest = [...estimates.values()].find((stored) => !stored.claimed);
      // Tous réclamés : ils se libéreront d'eux-mêmes à la fin de leur scan.
      // Rien à faire, et surtout pas casser un scan en cours pour en accepter
      // un de plus.
      if (!oldest) return;
      await releaseEstimate(oldest);
    }
  };

  // `unref` : ce minuteur ne doit jamais empêcher le process de s'arrêter.
  const sweeper = setInterval(() => void sweepEstimates(), 60_000);
  sweeper.unref?.();

  // --- Traitement des jobs ---------------------------------------------------
  options.queue.process(async (payload) => {
    runStore.setStatus(payload.run_id, 'running');
    const emitter = emitters.get(payload.run_id);
    // Un job dont l'émetteur a disparu (relance de file après redémarrage)
    // n'a personne à qui parler : le refuser vaut mieux que planter sur un
    // `!` et faire tomber le worker pour tous les suivants.
    if (!emitter) {
      runStore.finish(payload.run_id, {
        status: 'failed',
        error: 'This scan was queued by a service that has since restarted; it was not run.',
      });
      return;
    }

    const stored = payload.estimate_id ? estimates.get(payload.estimate_id) : undefined;

    try {
      const result = await runScan(payload, {
        nodeLlm: buildClient(settings.nodeProvider, settings.nodeModel, settings.nodeEffort),
        masterLlm: buildClient(settings.masterProvider, settings.masterModel, settings.masterEffort),
        emitter,
        tracker: new UsageTracker(),
        prepared: stored?.prepared,
        bypassClaudeForHighConfidence: scanSettings.bypassClaudeForHighConfidence,
        arbitrationCache,
        verdictCache,
        detectionConcurrency: scanSettings.detectionConcurrency,
      });
      runStore.finish(payload.run_id, { status: 'done', result });
      // Groupée : quarante routes ne doivent pas produire quarante écritures.
      cacheStores?.verdict.touch();
      cacheStores?.arbitration.touch();
    } catch (error) {
      const why = (error as Error).message;
      // Un scan qui plante doit se voir dans la timeline, pas seulement
      // dans les logs serveur.
      emitter.emit('report', 'failed', messages(payload.locale ?? 'en').scan.interrupted, {
        detail: why,
      });
      // APRÈS l'événement : la ligne finale doit être la dernière du journal,
      // sinon la relecture verrait un run clos suivi d'événements.
      runStore.finish(payload.run_id, { status: 'failed', error: why });
    } finally {
      retireEmitter(payload.run_id);
      // Un scan interrompu a pu payer et mémoriser des verdicts avant de
      // tomber : les perdre parce que la SUITE a mal tourné reviendrait à
      // repayer ce qui a déjà été facturé.
      cacheStores?.verdict.touch();
      cacheStores?.arbitration.touch();
      // Le devis a servi : on rend le clone temporaire et l'index, que le scan
      // ait réussi ou non.
      if (stored) await releaseEstimate(stored);
    }
  });

  // --- Utilitaires HTTP ------------------------------------------------------
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end(payload);
  };

  /**
   * Lit un corps de requête JSON.
   *
   * ==========================================================================
   * DEUX DÉFAUTS TROUVÉS PAR LA PASSE QA (`npm run qa`), PAS PAR LES TESTS
   *
   *  1. **Un corps `null` faisait tomber la requête.** `JSON.parse("null")`
   *     rend `null`, que les appelants lisaient comme un objet
   *     (`body.locale`) : exception non rattrapée sur une entrée triviale.
   *     Un corps qui n'est pas un OBJET n'est pas un corps utilisable — et le
   *     remplacer en silence par `{}` serait combler un trou avec une valeur
   *     par défaut, ce que ce produit refuse. On le refuse en le nommant.
   *
   *  2. **Aucune borne de taille.** Les morceaux s'accumulaient sans limite :
   *     un client envoyant un gigaoctet faisait grossir le tas jusqu'à
   *     l'étouffement. Ce n'est pas une hypothèse d'école, c'est le mode de
   *     déni de service le plus banal sur une API qui accepte du JSON. On
   *     coupe à la borne, et on DIT que c'est la taille qui a fâché.
   * ==========================================================================
   */
  const MAX_BODY_BYTES = 2 * 1024 * 1024;

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        // On arrête de lire ET on jette ce qu'on tient : continuer à
        // accumuler pour ensuite refuser serait payer le déni de service tout
        // en le refusant.
        chunks.length = 0;
        throw new Error(`request body too large (over ${MAX_BODY_BYTES} bytes)`);
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('invalid JSON request body');
    }

    // `typeof null === 'object'` : le test doit exclure `null` explicitement,
    // et les tableaux, qui passeraient aussi pour des objets.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    /**
     * Lecture commune des paramètres de cible.
     *
     * `/estimate` et `/webhook` acceptent exactement les mêmes entrées : le
     * devis doit porter sur ce qui sera réellement analysé, sinon il ne vaut
     * rien. `target` est le nom clair ; `repo_path` reste accepté pour ne pas
     * casser les webhooks Git déjà configurés.
     */
    const readTargetInput = (
      body: Record<string, unknown>
    ):
      | { target: string; mode: ScanMode; commitSha?: string; locale: Locale }
      | { error: string; friendly: string; locale: Locale } => {
      // La langue est lue en premier : même un refus doit être écrit dans la
      // langue de celui qui le lit.
      const locale = normalizeLocale(body.locale ?? body.lang);
      const t = messages(locale).api;
      const target = (body.target ?? body.repo_path) as unknown;
      const mode = (body.mode ?? 'full_scan') as ScanMode;

      if (typeof target !== 'string' || target.trim().length === 0) {
        return { error: 'missing target (target / repo_path)', friendly: t.targetMissing, locale };
      }
      if (mode !== 'full_scan' && mode !== 'incremental_scan') {
        return { error: `unknown mode: ${String(mode)}`, friendly: t.unknownMode, locale };
      }
      return {
        target: target.trim(),
        mode,
        locale,
        commitSha: typeof body.commit_sha === 'string' && body.commit_sha ? body.commit_sha : undefined,
      };
    };

    // POST /estimate — ce que l'analyse va coûter, AVANT de la lancer.
    if (req.method === 'POST' && url.pathname === '/estimate') {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return;
      }

      const input = readTargetInput(body);
      if ('error' in input) {
        json(res, 400, { error: input.error, plain_language_summary: input.friendly });
        return;
      }

      let prepared: PreparedScan;
      try {
        const target = await resolveTarget(input.target, { locale: input.locale });
        const ready = await prepareTarget(target);
        prepared = { target, ...ready };
      } catch (error) {
        json(res, 400, {
          error: (error as Error).message,
          plain_language_summary:
            error instanceof TargetError
              ? error.plainLanguageSummary
              : messages(input.locale).api.targetUnreadable,
        });
        return;
      }

      try {
        // Le devis porte sur les routes du MODE demandé : estimer un scan
        // complet quand l'utilisateur va lancer un incrémental annoncerait
        // une facture dix fois trop élevée, et l'inverse serait pire.
        const selection = selectRoutes(
          prepared.routes,
          { repo_path: input.target, mode: input.mode, commit_sha: input.commitSha },
          prepared.index,
          prepared.target.indexRoot,
          input.locale
        );

        const estimate = await estimateScan({
          target: prepared.target,
          mode: selection.effectiveMode,
          routes: selection.routes,
          index: prepared.index,
          provider: prepared.provider,
          detection: { provider: settings.nodeProvider, model: settings.nodeModel },
          arbitration: { provider: settings.masterProvider, model: settings.masterModel },
          env: env as NodeJS.ProcessEnv,
          locale: input.locale,
          // Le devis doit être calculé sur le réglage RÉELLEMENT en vigueur :
          // annoncer une durée en série pour un scan qui partira par lots
          // ferait renoncer à un scan abordable.
          detectionConcurrency: scanSettings.detectionConcurrency,
        });

        if (selection.note) estimate.warnings.unshift(selection.note);

        // Avant d'en retenir un de plus : voir MAX_PENDING_ESTIMATES.
        await makeRoomForEstimate();

        const id = `est-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        estimates.set(id, {
          id,
          estimate,
          prepared,
          expiresAt: Date.now() + ESTIMATE_TTL_MS,
          claimed: false,
        });

        json(res, 200, {
          estimate_id: id,
          expires_in_s: Math.round(ESTIMATE_TTL_MS / 1000),
          estimate,
          notes: notesFor(input.locale),
        });
      } catch (error) {
        // Un devis qui échoue ne doit pas laisser un clone derrière lui.
        await prepared.close().catch(() => {});
        await prepared.target.cleanup().catch(() => {});
        json(res, 500, {
          error: (error as Error).message,
          plain_language_summary: messages(input.locale).api.estimateFailed,
        });
      }
      return;
    }

    // POST /webhook
    if (req.method === 'POST' && url.pathname === '/webhook') {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return;
      }

      const input = readTargetInput(body);
      if ('error' in input) {
        json(res, 400, { error: input.error, plain_language_summary: input.friendly });
        return;
      }

      // Devis accepté : on réutilise le travail déjà fait (index, clone) au
      // lieu de tout recommencer.
      const estimateId = typeof body.estimate_id === 'string' ? body.estimate_id : undefined;
      const stored = estimateId ? estimates.get(estimateId) : undefined;
      if (estimateId && !stored) {
        json(res, 409, {
          error: `unknown or expired estimate: ${estimateId}`,
          plain_language_summary: messages(input.locale).api.estimateExpired,
        });
        return;
      }
      if (stored) stored.claimed = true;

      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const emitter = new StepEmitter(runId);
      runStore.create({
        run_id: runId,
        status: 'queued',
        events: [],
        result: null,
        error: null,
        estimate: stored?.estimate ?? null,
      });
      // Le store range l'événement en mémoire ET sur le disque : un seul
      // abonnement, une seule vérité.
      emitter.on((event) => runStore.appendEvent(runId, event));
      emitters.set(runId, emitter);
      capEmitters();

      await options.queue.add({
        run_id: runId,
        repo_path: input.target,
        commit_sha: input.commitSha,
        mode: input.mode,
        locale: input.locale,
        estimate_id: stored?.id,
      });

      json(res, 202, {
        run_id: runId,
        events_url: `/runs/${runId}/events`,
        estimate: stored?.estimate ?? null,
        notes: notesFor(input.locale),
        plain_language_summary: messages(input.locale).api.scanStarted,
      });
      return;
    }

    // GET /runs — la liste.
    //
    // Sans elle, la persistance serait invisible : des rapports rangés sur le
    // disque que personne ne peut retrouver ne servent à rien. Volontairement
    // un RÉSUMÉ — cible, statut, nombre de signalements — et pas les rapports
    // complets : lister deux cents runs ne doit pas en charger deux cents.
    if (req.method === 'GET' && url.pathname === '/runs') {
      const asked = Number(url.searchParams.get('limit') ?? 50);
      const limit = Number.isInteger(asked) && asked > 0 && asked <= 200 ? asked : 50;
      json(res, 200, { runs: runStore.list(limit), interrupted_at_startup: interruptedRuns });
      return;
    }

    // GET /runs/:id/events  (SSE)
    const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (req.method === 'GET' && eventsMatch) {
      const runId = eventsMatch[1]!;
      // Refusé AVANT d'atteindre le store, qui compose un chemin de fichier
      // avec cette valeur. Voir `isValidRunId` : c'est une traversée de
      // répertoire, pas une formalité.
      if (!isValidRunId(runId)) {
        json(res, 400, { error: 'invalid run id' });
        return;
      }
      const state = runStore.get(runId);
      if (!state) {
        json(res, 404, { error: 'unknown run' });
        return;
      }
      const emitter = emitters.get(runId);

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });

      // Rejoue l'historique : un client qui se branche en cours de scan ne
      // doit pas rater le début de la timeline.
      //
      // La source est l'ÉMETTEUR quand le run tourne encore, le JOURNAL
      // sinon : après un redémarrage il n'y a plus d'émetteur, et un rapport
      // relu doit pouvoir se rejouer entièrement.
      for (const event of emitter ? emitter.getHistory() : state.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      // `interrupted` est terminal au même titre que `done` et `failed` :
      // laisser le flux ouvert ferait attendre indéfiniment un client sur un
      // scan que plus personne n'exécute.
      if (state.status !== 'queued' && state.status !== 'running') {
        res.write(`event: end\ndata: ${JSON.stringify({ status: state.status })}\n\n`);
        res.end();
        return;
      }
      if (!emitter) {
        // Ni terminé, ni suivi par personne : c'est un run interrompu que la
        // reprise n'a pas encore gravé. On le dit plutôt que de faire
        // patienter sur un flux qui ne dira jamais rien.
        res.write(`event: end\ndata: ${JSON.stringify({ status: 'interrupted' })}\n\n`);
        res.end();
        return;
      }

      const unsubscribe = emitter.on((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.step === 'report' && (event.status === 'done' || event.status === 'failed')) {
          res.write(`event: end\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
          res.end();
        }
      });
      req.on('close', unsubscribe);
      return;
    }

    // GET /runs/:id
    const runMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && runMatch) {
      const runId = runMatch[1]!;
      if (!isValidRunId(runId)) {
        json(res, 400, { error: 'invalid run id' });
        return;
      }
      const state = runStore.get(runId);
      if (!state) {
        json(res, 404, { error: 'unknown run' });
        return;
      }
      json(res, 200, {
        run_id: state.run_id,
        status: state.status,
        events: state.events,
        error: state.error,
        estimate: state.estimate,
        target: state.result?.target ?? null,
        report: state.result?.report ?? null,
        usage: state.result?.usage ?? null,
        effective_mode: state.result?.effective_mode ?? null,
        routes_analyzed: state.result?.routes_analyzed ?? null,
        routes_failed: state.result?.routes_failed ?? null,
      });
      return;
    }

    // GET /providers  — pour le sélecteur de l'UI
    if (req.method === 'GET' && url.pathname === '/providers') {
      const locale = normalizeLocale(url.searchParams.get('locale'));
      json(res, 200, {
        settings,
        available: providerAvailability(locale),
        notes: notesFor(locale),
      });
      return;
    }

    // POST /providers — bascule à chaud
    if (req.method === 'POST' && url.pathname === '/providers') {
      let body: Partial<ProviderSettings> & { locale?: string };
      try {
        body = (await readBody(req)) as Partial<ProviderSettings>;
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return;
      }

      const locale = normalizeLocale(body.locale);
      const t = messages(locale).providers;

      for (const key of ['nodeProvider', 'masterProvider'] as const) {
        const value = body[key];
        if (value && !SUPPORTED_PROVIDERS.includes(value)) {
          json(res, 400, { error: `unknown provider: ${value}`, plain_language_summary: t.unknownProvider(value) });
          return;
        }
      }

      // Un niveau d'effort inconnu est REFUSÉ plutôt qu'ignoré : ici la
      // personne l'a posé explicitement, l'avaler en silence lui ferait croire
      // à un réglage appliqué qui ne l'est pas.
      for (const key of ['nodeEffort', 'masterEffort'] as const) {
        const value = body[key] as string | undefined;
        if (value !== undefined && value !== null && parseEffort(value) === undefined) {
          json(res, 400, {
            error: `unknown effort level: ${value}`,
            plain_language_summary: t.unknownEffort(String(value)),
          });
          return;
        }
      }

      const next: ProviderSettings = { ...settings, ...body, locale: undefined } as ProviderSettings;
      // On vérifie que le nouveau réglage est utilisable AVANT de l'appliquer :
      // basculer sur un fournisseur sans clé ferait échouer le scan suivant
      // avec un message incompréhensible.
      //
      // La vérification passe par `describeProviders` et NON par une
      // construction de client : le SDK Anthropic se construit sans clé et
      // n'échoue qu'à l'appel, ce qui laissait passer une bascule vouée à
      // planter en plein scan.
      const availability = providerAvailability(locale);
      const blocked = [next.nodeProvider, next.masterProvider]
        .map((id) => availability.find((entry) => entry.id === id))
        .find((entry) => entry && !entry.available);

      if (blocked) {
        json(res, 400, { error: blocked.why, plain_language_summary: t.unusable });
        return;
      }

      try {
        buildClient(next.nodeProvider, next.nodeModel, next.nodeEffort);
        buildClient(next.masterProvider, next.masterModel, next.masterEffort);
      } catch (error) {
        json(res, 400, {
          error: (error as Error).message,
          plain_language_summary: t.invalidSetting,
        });
        return;
      }

      Object.assign(settings, next);
      json(res, 200, { settings, available: providerAvailability(locale), notes: notesFor(locale) });
      return;
    }

    // GET /provider-keys — quelles clés sont posées, et d'où elles viennent
    if (req.method === 'GET' && url.pathname === '/provider-keys') {
      json(res, 200, { keys: describeKeys() });
      return;
    }

    // PUT /provider-keys — saisie depuis les Réglages de la console
    if (req.method === 'PUT' && url.pathname === '/provider-keys') {
      const locale = normalizeLocale(url.searchParams.get('locale'));
      const t = messages(locale).providerKeys;

      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return;
      }

      const patch: Record<string, string | null | undefined> = {};
      for (const [name, value] of Object.entries(body ?? {})) {
        if (name === 'locale') continue;
        if (!isManagedKey(name)) {
          // Liste fermée : refuser un nom inconnu plutôt que l'ignorer. Cet
          // endpoint écrit dans `process.env` du service — accepter un nom
          // quelconque en ferait un moyen d'y injecter n'importe quoi.
          json(res, 400, { error: `unknown key: ${name}`, plain_language_summary: t.unknownKey(name) });
          return;
        }
        if (value === null) {
          patch[name] = null;
        } else if (typeof value === 'string') {
          patch[name] = value;
        } else if (value !== undefined) {
          json(res, 400, { error: `invalid value for ${name}`, plain_language_summary: t.invalidValue(name) });
          return;
        }
      }

      try {
        const keys = setKeys(patch);
        // La disponibilité est RECALCULÉE ici : c'est tout l'intérêt d'écrire
        // dans `process.env` plutôt que dans un fichier à relire au démarrage.
        // Le sélecteur de moteur passe de « clé absente » à « disponible »
        // sans que personne n'ait rien redémarré.
        json(res, 200, { keys, available: providerAvailability(locale) });
      } catch (error) {
        if (error instanceof KeyStoreError) {
          json(res, 409, {
            error: error.message,
            plain_language_summary: t.lockedByEnvironment(error.key),
          });
          return;
        }
        json(res, 500, {
          error: (error as Error).message,
          plain_language_summary: t.writeFailed((error as Error).message),
        });
      }
      return;
    }

    // GET /settings — réglages d'analyse + seuils appliqués
    if (req.method === 'GET' && url.pathname === '/settings') {
      json(res, 200, {
        settings: scanSettings,
        thresholds: { reject_below: REJECT_BELOW, direct_alert_above: DIRECT_ALERT_ABOVE },
        // Les bornes viennent du serveur : recopiées dans l'interface, elles
        // mentiraient le jour où elles bougeraient.
        limits: { concurrency: { min: MIN_CONCURRENCY, max: MAX_CONCURRENCY } },
        // Un seul appel sert deux choses, comme pour les réglages eux-mêmes :
        // pinguer séparément ajouterait une requête pour une information qu'on
        // obtient déjà.
        cache: describeCaches(),
      });
      return;
    }

    // DELETE /cache — l'oubli.
    //
    // Ajouter de la mémoire à un produit oblige à ajouter l'oubli. Tant que
    // les caches vivaient en RAM, redémarrer le service suffisait à repartir
    // de zéro ; ce n'est plus vrai. Sans ce bouton, quelqu'un qui soupçonne un
    // verdict figé n'a AUCUN moyen de le vérifier — et il aurait raison de ne
    // plus faire confiance au rapport.
    if (req.method === 'DELETE' && url.pathname === '/cache') {
      if (cacheStores) {
        cacheStores.verdict.forget();
        cacheStores.arbitration.forget();
      } else {
        verdictCache.lru.clear();
        arbitrationCache.lru.clear();
      }
      cacheLoad.length = 0;
      // Les RUNS ne sont pas effacés ici. Le cache est une optimisation qu'on
      // jette sans rien perdre ; l'historique des scans est un résultat qu'on
      // a payé. Deux gestes différents, deux boutons différents.
      json(res, 200, { cache: describeCaches() });
      return;
    }

    // POST /settings — bascule à chaud
    if (req.method === 'POST' && url.pathname === '/settings') {
      let body: Partial<ScanSettings>;
      try {
        body = (await readBody(req)) as Partial<ScanSettings>;
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return;
      }

      if (
        body.bypassClaudeForHighConfidence !== undefined &&
        typeof body.bypassClaudeForHighConfidence !== 'boolean'
      ) {
        const locale = normalizeLocale((body as { locale?: string }).locale);
        json(res, 400, {
          error: 'bypassClaudeForHighConfidence must be a boolean',
          plain_language_summary: messages(locale).providers.invalidSetting,
        });
        return;
      }

      if (body.detectionConcurrency !== undefined) {
        const normalized = normalizeConcurrency(body.detectionConcurrency);
        if (normalized === null) {
          const locale = normalizeLocale((body as { locale?: string }).locale);
          json(res, 400, {
            error: `detectionConcurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`,
            plain_language_summary: messages(locale).providers.invalidSetting,
          });
          return;
        }
        scanSettings.detectionConcurrency = normalized;
      }

      if (body.bypassClaudeForHighConfidence !== undefined) {
        scanSettings.bypassClaudeForHighConfidence = body.bypassClaudeForHighConfidence;
      }

      json(res, 200, {
        settings: scanSettings,
        thresholds: { reject_below: REJECT_BELOW, direct_alert_above: DIRECT_ALERT_ABOVE },
        // Les bornes viennent du serveur : recopiées dans l'interface, elles
        // mentiraient le jour où elles bougeraient.
        limits: { concurrency: { min: MIN_CONCURRENCY, max: MAX_CONCURRENCY } },
        cache: describeCaches(),
      });
      return;
    }

    json(res, 404, { error: 'unknown route' });
  };

  const server = createHttpServer((req, res) => {
    handler(req, res).catch((error) => {
      json(res, 500, { error: (error as Error).message });
    });
  });

  /**
   * Dernière écriture avant l'arrêt.
   *
   * C'est elle qui fait toute la différence entre « le cache survit » et « le
   * cache survit sauf au dernier scan » — or le dernier scan est justement
   * celui qu'on vient de payer quand on relance le service.
   */
  /**
   * Arrêt propre.
   *
   * ==========================================================================
   * IL LIBÈRE AUSSI LES DEVIS EN ATTENTE, ET IL NE LE FAISAIT PAS.
   *
   * Un devis retient un index, une connexion au serveur de contexte, et pour
   * une cible GitHub un CLONE TEMPORAIRE sur le disque. Le balayage
   * périodique les libère au fil de l'eau — mais il ne tourne plus une fois le
   * service arrêté. Chaque redémarrage laissait donc derrière lui les clones
   * des devis qui n'avaient pas encore expiré, sans que rien ne les ramasse
   * jamais : le dossier temporaire de la machine grossissait à chaque cycle.
   *
   * Trouvé en cherchant pourquoi la suite de tests s'arrêtait par à-coups —
   * les connexions laissées ouvertes retenaient le processus. Le symptôme
   * était un test lent ; la cause était une fuite de ressources en production.
   * ==========================================================================
   */
  const shutdown = (): void => {
    cacheStores?.verdict.close();
    cacheStores?.arbitration.close();
    // Les événements encore groupés partent sur le disque. Un run en cours
    // n'aura pas de ligne finale — c'est voulu : il SERA interrompu, et la
    // reprise au prochain démarrage le dira.
    runStore.flushAll();
    // Le balayeur n'a plus rien à balayer, et il ne doit pas retenir le
    // processus si quelqu'un a retiré son `unref`.
    clearInterval(sweeper);
    // Les devis en attente rendent leur index et leur clone. On n'attend pas :
    // un arrêt ne doit pas être retardé par du ménage, et chaque libération
    // est indépendante.
    for (const stored of [...estimates.values()]) void releaseEstimate(stored);
  };

  return {
    server,
    runStore,
    emitters,
    settings,
    scanSettings,
    providerAvailability,
    handler,
    notesFor,
    estimates,
    interruptedRuns,
    arbitrationCache,
    verdictCache,
    describeCaches,
    shutdown,
  };
}
