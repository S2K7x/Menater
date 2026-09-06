/**
 * Chaîne complète : Indexeur -> MCP -> Nodes (parallèle) -> Agrégateur -> Master.
 *
 * Chaque étape publie sa progression via `StepEmitter`, et tous les appels LLM
 * passent par `UsageTracker`.
 */

import { execFileSync } from 'node:child_process';
import { relative, sep } from 'node:path';

import { buildRepoIndex, type RepoIndex } from '../mcp-server/repo-index.ts';
import { createServer } from '../mcp-server/server.ts';
import { connectInProcess, type ContextProvider, type ListedRoute } from '../nodes/shared/mcp-client.ts';
import type { LlmClient } from '../nodes/shared/llm/types.ts';
import { analyzeRouteForIdor } from '../nodes/idor/node.ts';
import { aggregate, fromNodeVerdict, type NodeFinding, type AggregationResult } from '../aggregator/aggregator.ts';
import { arbitrate } from '../master/claude-client.ts';
import type { ArbitrationCache } from '../master/arbitration-cache.ts';
import type { VerdictCache } from '../nodes/shared/verdict-cache.ts';
import { buildReport, type SecurityReport } from '../master/report-builder.ts';
import { mapWithConcurrency, DEFAULT_DETECTION_CONCURRENCY } from './pool.ts';
import { StepEmitter, zoneOf, type StepName } from './step-events.ts';
import { UsageTracker, type UsageReport } from './usage-tracker.ts';
import { resolveTarget, type ResolvedTarget } from './scan-target.ts';
import { prepareTarget } from './estimator.ts';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { messages } from '../i18n/messages.ts';

export type ScanMode = 'full_scan' | 'incremental_scan';

export interface ScanRequest {
  /**
   * Ce qu'on analyse.
   *
   * Le nom reste `repo_path` pour ne pas casser les webhooks existants, mais
   * le champ accepte désormais trois formes : un dossier, un fichier seul, ou
   * l'adresse d'un dépôt GitHub (voir `scan-target.ts`).
   */
  repo_path: string;
  commit_sha?: string;
  mode: ScanMode;
  /** Langue de tout le texte produit par ce scan. Anglais par défaut. */
  locale?: Locale;
}

/**
 * Un détecteur enregistré.
 *
 * La spec parle de « (parallèle) Nodes de détection » au pluriel. Un seul node
 * existe aujourd'hui (IDOR, Phase 3), mais le registre et le `Promise.all`
 * sont en place : ajouter XSS ou SQLi se fera par une entrée ici, sans toucher
 * à l'orchestration.
 */
export interface DetectionNode {
  id: string;
  vulnerability: string;
  /**
   * Phrase affichée pendant que ce node tourne — jamais son nom technique.
   * Fonction de la langue : le texte est traduit, pas le nom du détecteur.
   */
  plainLanguage: (locale: Locale) => string;
  analyze(
    route: ListedRoute,
    context: {
      provider: ContextProvider;
      llm: LlmClient;
      locale: Locale;
      /** Cache de verdicts, quand l'appelant en possède un. */
      verdictCache?: VerdictCache;
    }
  ): Promise<NodeAnalysis | null>;
}

/**
 * Résultat d'un node sur une route : le finding, plus ce qu'il faut pour
 * l'annoncer en direct.
 */
export interface NodeAnalysis {
  finding: NodeFinding | null;
  confidence_score: number;
  plain_language_summary: string;
  /** true si aucun appel LLM n'a été nécessaire — donc gratuit. */
  free: boolean;
  /**
   * true si la gratuité vient du CACHE et non du scanner déterministe.
   *
   * Les deux ne coûtent rien, mais ne disent pas la même chose : « tranché
   * sans modèle » est un verdict rendu ici et maintenant, « déjà connu » est
   * un verdict rendu lors d'un scan précédent sur exactement le même code.
   * Les confondre ferait croire que le détecteur déterministe couvre bien
   * plus de terrain qu'il n'en couvre.
   */
  cached: boolean;
}

export const IDOR_DETECTION_NODE: DetectionNode = {
  id: 'idor-node',
  vulnerability: 'IDOR',
  plainLanguage: (locale) => messages(locale).scan.detectionIntro,
  async analyze(route, { provider, llm, locale, verdictCache }) {
    const verdict = await analyzeRouteForIdor(
      { route: route.route, httpMethod: route.http_method },
      { contextProvider: provider, llm, locale, verdictCache }
    );
    const detail = verdict.technical_detail;
    return {
      finding: fromNodeVerdict(verdict, 'idor-node', route.guards),
      confidence_score: verdict.confidence_score,
      plain_language_summary: verdict.plain_language_summary,
      // Gratuit dans les deux cas : pas de modèle du tout, ou un modèle dont
      // la réponse était déjà connue. `calls === 0` couvre le second, que
      // `llm === null` seul manquait.
      free: detail.llm === null || detail.llm.calls === 0,
      cached: detail.from_cache,
    };
  },
};

export interface PipelineOptions {
  nodeLlm: LlmClient;
  masterLlm: LlmClient;
  nodes?: DetectionNode[];
  emitter?: StepEmitter;
  tracker?: UsageTracker;
  /**
   * Cible déjà résolue et indexée (par l'estimation qui précède le scan).
   *
   * Évite de tout refaire deux fois — et surtout, pour un dépôt GitHub, évite
   * de le cloner une seconde fois. Quand elle est fournie, c'est l'appelant
   * qui possède les ressources et les libère.
   */
  prepared?: PreparedScan;
  /**
   * Option « bypass » de `CLAUDE.md` §3 : les findings au-dessus de 0.7 sont
   * remontés sans passer par le master.
   *
   * Réglable depuis l'interface (`POST /settings`) plutôt que figé au
   * démarrage : c'est un arbitrage coût/qualité qui appartient à
   * l'utilisateur, pas à l'exploitant du serveur.
   */
  bypassClaudeForHighConfidence?: boolean;
  /**
   * Cache de verdicts d'arbitrage, partagé entre les scans.
   *
   * Absent = aucun cache. C'est le serveur qui en possède un (il vit d'un scan
   * à l'autre) ; les scripts et les tests n'en fournissent pas, pour ne jamais
   * mesurer une calibration à travers un état caché.
   */
  arbitrationCache?: ArbitrationCache;
  /**
   * Cache de verdicts de détection, partagé entre les scans.
   *
   * Même règle que ci-dessus : le serveur en possède un, les scripts et les
   * tests n'en fournissent pas.
   */
  verdictCache?: VerdictCache;
  /**
   * Nombre de routes analysées en parallèle.
   *
   * Voir `pool.ts` pour le choix du défaut. `1` restaure exactement l'ancien
   * comportement séquentiel — utile pour reproduire une mesure.
   */
  detectionConcurrency?: number;
}

export interface PreparedScan {
  target: ResolvedTarget;
  index: RepoIndex;
  provider: ContextProvider;
  routes: ListedRoute[];
  close: () => Promise<void>;
}

export interface ScanResult {
  run_id: string;
  mode: ScanMode;
  /** Ce qui a réellement été analysé (dossier, fichier, dépôt). */
  target: { kind: ResolvedTarget['kind']; label: string };
  /** Mode réellement appliqué : un incremental peut retomber en full. */
  effective_mode: ScanMode;
  report: SecurityReport;
  usage: UsageReport;
  routes_analyzed: number;
  routes_failed: number;
  /**
   * Ce qui n'a rien coûté, par raison. Distinctes à dessein : voir
   * `NodeAnalysis.cached`.
   */
  routes_settled_free: number;
  routes_from_cache: number;
  failures: string[];
  aggregation: AggregationResult;
}

/**
 * Sélectionne les routes à analyser selon le mode.
 *
 * IMPLÉMENTE `incremental_scan`, que PHASE_6 se contente d'accepter en
 * paramètre du webhook sans jamais dire quoi en faire. Or c'est la distinction
 * centrale de `CLAUDE.md` §3 : `full_scan` analyse tout, `incremental_scan`
 * ne réanalyse que les routes des fichiers modifiés — c'est le mode
 * « low-cost du quotidien », donc la tarification même du produit.
 *
 * Si le diff n'est pas calculable (dépôt non git, commit inconnu), on retombe
 * sur un scan complet et on le DIT : un incrémental silencieusement dégradé en
 * complet ferait exploser la facture sans prévenir, et l'inverse — un complet
 * dégradé en partiel — laisserait croire à une couverture qu'on n'a pas.
 */
export function selectRoutes(
  routes: ListedRoute[],
  request: ScanRequest,
  index: RepoIndex,
  /**
   * Racine réellement indexée.
   *
   * Distincte de `request.repo_path` depuis que la cible peut être un dépôt
   * GitHub cloné dans un dossier temporaire : lancer `git diff` dans l'URL du
   * dépôt échouerait, et le scan retomberait silencieusement en analyse
   * complète — exactement la dégradation que cette fonction est censée
   * signaler plutôt que subir.
   */
  root: string = request.repo_path,
  locale: Locale = DEFAULT_LOCALE
): { routes: ListedRoute[]; effectiveMode: ScanMode; note: string | null } {
  const t = messages(locale).scan;
  if (request.mode === 'full_scan') {
    return { routes, effectiveMode: 'full_scan', note: null };
  }

  if (!request.commit_sha) {
    return {
      routes,
      effectiveMode: 'full_scan',
      note: t.noCommit,
    };
  }

  let changed: string[];
  try {
    // `--relative` : sans lui, `git diff` renvoie des chemins relatifs à la
    // racine du DÉPÔT, alors que `route.file` est relatif à la racine INDEXÉE.
    // Sur un monorepo dont on n'indexe qu'un paquet, plus aucun chemin ne
    // correspondait et le scan concluait « rien à revérifier ».
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--relative', `${request.commit_sha}^`, request.commit_sha],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    changed = output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return {
      routes,
      effectiveMode: 'full_scan',
      note: t.diffUnavailable,
    };
  }

  const changedSet = new Set(changed.map((file) => file.split(sep).join('/')));
  const rootRelative = (file: string): string => relative(root, file).split(sep).join('/');

  // Fichiers modifiés que l'index rattache effectivement à une route. Ce qui
  // reste en dehors est traité plus bas : on ne sait pas ce qu'il influence.
  const attributed = new Set<string>();

  const selected = routes.filter((route) => {
    const dependencies = routeDependencies(index, route);
    if (dependencies === null) return true; // route inconnue de l'index : dans le doute, on analyse
    let touched = false;
    for (const file of dependencies) {
      if (changedSet.has(file)) {
        attributed.add(file);
        touched = true;
      }
    }
    return touched;
  });

  // Un fichier de code modifié que l'index ne relie à AUCUNE route : on ne
  // sait pas ce qu'il influence. Répondre « rien à revérifier » serait une
  // affirmation qu'on ne peut pas soutenir, et un faux négatif silencieux est
  // le pire défaut possible ici. On analyse donc tout — et on le dit.
  //
  // Seuls les fichiers réellement indexés comptent : modifier un README ou un
  // fichier de configuration ne doit pas coûter un scan complet.
  const unattributed = index.files
    .map(rootRelative)
    .filter((file) => changedSet.has(file) && !attributed.has(file));

  if (unattributed.length > 0) {
    return {
      routes,
      effectiveMode: 'full_scan',
      note: t.changeNotAttributable(unattributed.slice(0, 3), unattributed.length),
    };
  }

  return {
    routes: selected,
    effectiveMode: 'incremental_scan',
    note:
      selected.length === 0 ? t.nothingChanged : null,
  };
}

/**
 * Fichiers dont le verdict d'une route dépend : le sien, plus ceux des classes
 * qu'elle injecte, transitivement.
 *
 * POURQUOI. Le tri incrémental se faisait sur `fichier.includes(nomDuContrôleur)` :
 * un chemin `src/order.controller.ts` ne contient jamais `OrderController`, la
 * condition était donc toujours fausse et seul le fichier du contrôleur
 * lui-même déclenchait une réanalyse. Conséquence : le commit qui retire le
 * filtre `userId` d'un service — la façon la plus courante d'introduire une
 * faille IDOR — ne faisait réanalyser aucune route, et l'utilisateur lisait
 * « rien à revérifier » sur le commit qui venait de créer la faille.
 *
 * On suit ici la même piste que le resolver : la carte d'injection du
 * constructeur (`injection_map`), déjà produite par l'indexeur. Aucun appel
 * LLM, aucune lecture supplémentaire du disque — `CLAUDE.md` §1 : ce qu'un
 * contrôle déterministe sait faire, il le fait.
 *
 * Deux choix prudents :
 *   - une classe définie plusieurs fois (homonymes) fait entrer TOUS ses
 *     fichiers : on préfère réanalyser en trop que rater le bon ;
 *   - `null` signifie « route absente de l'index, dépendances inconnues » :
 *     l'appelant doit alors analyser la route, jamais l'écarter.
 */
export function routeDependencies(index: RepoIndex, route: ListedRoute): Set<string> | null {
  const match = index.endpoints.find(
    (indexed) =>
      indexed.endpoint.source.file === route.file &&
      indexed.endpoint.route === route.route &&
      indexed.endpoint.http_method.toUpperCase() === route.http_method.toUpperCase()
  );
  if (!match) return null;

  const files = new Set<string>([route.file]);
  const pending = Object.values(match.controller.injection_map);
  const seen = new Set<string>();

  while (pending.length > 0) {
    const className = pending.pop()!;
    if (seen.has(className)) continue;
    seen.add(className);
    for (const definition of index.classes.get(className) ?? []) {
      files.add(definition.file);
      pending.push(...Object.values(definition.injection_map));
    }
  }

  return files;
}

/** Exécute un scan de bout en bout. */
export async function runScan(request: ScanRequest, options: PipelineOptions): Promise<ScanResult> {
  const runId = options.emitter?.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emitter = options.emitter ?? new StepEmitter(runId);
  const tracker = options.tracker ?? new UsageTracker(request.locale ?? DEFAULT_LOCALE);
  const nodes = options.nodes ?? [IDOR_DETECTION_NODE];
  const locale = request.locale ?? DEFAULT_LOCALE;
  const t = messages(locale).scan;

  const nodeLlm = tracker.wrap(options.nodeLlm, 'detection');
  const masterLlm = tracker.wrap(options.masterLlm, 'master_review');

  // La consommation est republiée à chaque appel facturé : le compteur de
  // l'interface avance pendant le scan, pas seulement à la fin.
  //
  // L'événement est rattaché à l'ÉTAPE EN COURS, pas à `detection` en dur :
  // un appel passé pendant la relecture finale doit s'afficher sous la
  // relecture, sinon la timeline attribue à la détection un coût qui n'est
  // pas le sien.
  let currentStep: StepName = 'received';
  const stopWatching = tracker.onRecord((usage) => {
    emitter.emit(currentStep, 'running', compteurConsommation(usage, locale), { usage });
  });

  emitter.emit('received', 'done', t.received);

  // --- 1. Cible + indexation ------------------------------------------------
  // Quand l'estimation a déjà tout préparé, on ne refait rien : ni clone, ni
  // indexation, ni résolution.
  let prepared = options.prepared;
  let ownsPrepared = false;

  if (!prepared) {
    emitter.emit('indexing', 'running', t.indexingRunning);
    try {
      const target = await resolveTarget(request.repo_path, { locale });
      const ready = await prepareTarget(target);
      prepared = { target, ...ready };
      ownsPrepared = true;
    } catch (error) {
      const friendly =
        (error as { plainLanguageSummary?: string }).plainLanguageSummary ?? t.readFailed;
      emitter.emit('indexing', 'failed', friendly, { detail: (error as Error).message });
      stopWatching();
      throw error;
    }
  }

  const { target, index, provider } = prepared;

  emitter.emit(
    'indexing',
    'done',
    t.indexingDone(index.files.length, index.endpoints.length, target.label),
    { detail: target.warnings.join(' ') || undefined }
  );

  // --- 2. Serveur de contexte ----------------------------------------------
  emitter.emit('context_server', 'done', t.contextDone);

  try {
    const selection = selectRoutes(prepared.routes, request, index, target.indexRoot, locale);
    if (selection.note) {
      emitter.emit('detection', 'skipped', selection.note);
    }

    // --- 3. Détection (routes en parallèle borné, nodes en parallèle) -------
    //
    // Les routes partaient une par une. Les appels au modèle sont pourtant
    // indépendants : sur quarante routes à deux secondes l'appel, la détection
    // passait une minute à attendre le réseau. Elles partent maintenant par
    // lots bornés (`pool.ts` explique pourquoi bornés et pas tous d'un coup).
    //
    // Deux choses ne changent PAS pour autant :
    //   - les findings restent dans l'ordre des routes, pas dans celui des
    //     réponses : un rapport dont l'ordre bouge à chaque exécution n'est ni
    //     comparable ni testable ;
    //   - le direct, lui, suit l'ordre d'arrivée — c'est son intérêt.
    currentStep = 'detection';
    const failures: string[] = [];
    const concurrency = options.detectionConcurrency ?? DEFAULT_DETECTION_CONCURRENCY;
    let done = 0;

    for (const node of nodes) {
      emitter.emit('detection', 'running', node.plainLanguage(locale), {
        detail: node.vulnerability,
        progress: { done: 0, total: selection.routes.length },
      });
    }

    // Une case par route, remplie à l'achèvement, relue dans l'ordre ensuite.
    const perRoute: Array<NodeFinding[]> = selection.routes.map(() => []);
    // Deux gratuités comptées séparément : ce que les règles déterministes ont
    // tranché seules, et ce qui était déjà connu. Un total unique laisserait
    // croire que le scanner couvre le terrain que le cache couvre.
    let settledFree = 0;
    let servedFromCache = 0;

    await mapWithConcurrency(
      selection.routes,
      concurrency,
      async (route, index) => {
        const routeRef = { http_method: route.http_method, route: route.route };

        // On annonce l'adresse AVANT de l'analyser : pendant les secondes que
        // dure l'appel au modèle, l'utilisateur voit sur quoi on travaille.
        emitter.emit('detection', 'running', t.routeExamining(route.http_method, route.route), {
          route: routeRef,
          progress: { done, total: selection.routes.length },
        });

        // Les nodes tournent en parallèle sur une même route : ils sont
        // indépendants et n'ont aucune raison de s'attendre.
        const results = await Promise.allSettled(
          nodes.map((node) =>
            node.analyze(route, {
              provider,
              llm: nodeLlm,
              locale,
              verdictCache: options.verdictCache,
            })
          )
        );

        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            if (!result.value) return;
            const analysis = result.value;
            if (analysis.finding) perRoute[index]!.push(analysis.finding);
            if (analysis.cached) servedFromCache += 1;
            else if (analysis.free) settledFree += 1;

            // Verdict publié route par route : c'est ce qui transforme une barre
            // de progression en compte rendu vivant.
            emitter.emit('detection', 'running', analysis.plain_language_summary, {
              route: routeRef,
              verdict: {
                vulnerability: nodes[i]!.vulnerability,
                confidence_score: analysis.confidence_score,
                zone: zoneOf(analysis.confidence_score),
                free: analysis.free,
                cached: analysis.cached,
                plain_language_summary: analysis.plain_language_summary,
              },
              progress: { done: done + 1, total: selection.routes.length },
            });
          } else {
            const message = `${nodes[i]!.vulnerability} sur ${route.http_method} ${route.route} : ${result.reason?.message ?? result.reason}`;
            failures.push(message);
            // Une route non analysée n'est PAS une route saine : elle est
            // annoncée comme un échec, jamais passée sous silence.
            emitter.emit('detection', 'failed', t.routeFailed(route.http_method, route.route), {
              detail: message,
              route: routeRef,
            });
          }
        });

        done += 1;
        emitter.emit('detection', 'running', t.routeProgress(done, selection.routes.length), {
          progress: { done, total: selection.routes.length },
        });
      }
      // Aucun crochet `onSettled` : `analyze` ne rejette pas (tout est capté
      // par le `allSettled` ci-dessus), et la progression est déjà publiée là
      // où elle a lieu.
    );

    const findings: NodeFinding[] = perRoute.flat();

    // Un scan qui coûte moins que le précédent sans rien dire ressemble à une
    // analyse au rabais : on nomme ce qui n'a pas été facturé, et pourquoi.
    const savings = t.detectionSavings(settledFree, servedFromCache, selection.routes.length);

    emitter.emit(
      'detection',
      failures.length > 0 ? 'failed' : 'done',
      (failures.length > 0
        ? t.detectionPartial(failures.length)
        : t.detectionDone(selection.routes.length)) + (savings ? ` ${savings}` : ''),
      { usage: tracker.snapshot() }
    );

    // --- 4. Agrégation ------------------------------------------------------
    currentStep = 'aggregation';
    emitter.emit('aggregation', 'running', t.aggregationRunning);
    const aggregation = aggregate(findings, {
      routesAnalyzed: selection.routes.length,
      locale,
      bypassClaudeForHighConfidence: options.bypassClaudeForHighConfidence === true,
    });
    const candidates = [...aggregation.claude_payload, ...aggregation.direct_alerts];
    emitter.emit(
      'aggregation',
      'done',
      t.aggregationDone(aggregation.stats.rejected_low_confidence, candidates.length)
    );

    // --- 5. Arbitrage master -------------------------------------------------
    currentStep = 'master_review';
    emitter.emit(
      'master_review',
      'running',
      candidates.length === 0 ? t.arbitrationNothing : t.arbitrationRunning(candidates.length)
    );
    const outcome = await arbitrate(candidates, {
      llm: masterLlm,
      contextProvider: provider,
      locale,
      cache: options.arbitrationCache,
    });
    // Un scan qui coûte moins que le précédent sans rien dire ressemble à une
    // analyse au rabais. Quand des verdicts viennent du cache, on l'annonce.
    const reused = outcome.cache_hits > 0 ? ` ${t.arbitrationReused(outcome.cache_hits)}` : '';
    emitter.emit(
      'master_review',
      outcome.unarbitrated.length > 0 ? 'failed' : 'done',
      (outcome.unarbitrated.length > 0
        ? t.arbitrationPartial(outcome.unarbitrated.length)
        : t.arbitrationDone) + reused,
      { usage: tracker.snapshot() }
    );

    // --- 6. Rapport ----------------------------------------------------------
    currentStep = 'report';
    emitter.emit('report', 'running', t.reportRunning);
    const report = buildReport(aggregation, outcome, {
      routesAnalyzed: selection.routes.length,
      routesFailed: failures.length,
      locale,
      // Lu ICI, tant que la cible est montée : le `finally` ci-dessous
      // supprime le clone temporaire d'un dépôt GitHub.
      sourceRoot: target.indexRoot,
      // Un clone temporaire ne survit pas au scan : proposer « ouvrir dans mon
      // éditeur » vers un dossier effacé serait un lien mort.
      sourceRootPersists: target.kind !== 'github',
    });
    emitter.emit('report', 'done', report.scan_summary.plain_language_intro, {
      usage: tracker.snapshot(),
    });

    return {
      run_id: runId,
      mode: request.mode,
      target: { kind: target.kind, label: target.label },
      effective_mode: selection.effectiveMode,
      report,
      usage: tracker.report(),
      routes_analyzed: selection.routes.length,
      routes_failed: failures.length,
      routes_settled_free: settledFree,
      routes_from_cache: servedFromCache,
      failures,
      aggregation,
    };
  } finally {
    stopWatching();
    // On ne ferme que ce qu'on a ouvert : si l'estimation a préparé la cible,
    // c'est elle qui la libérera (le clone temporaire lui appartient).
    if (ownsPrepared) {
      await prepared.close();
      await target.cleanup();
    }
  }
}

function compteurConsommation(
  usage: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cost_usd: number | null;
  },
  locale: Locale
): string {
  const mots = usage.input_tokens + usage.output_tokens + usage.thinking_tokens;
  return messages(locale).scan.usageCounter(
    usage.calls,
    Math.round(mots / 1000),
    usage.cost_usd
  );
}
