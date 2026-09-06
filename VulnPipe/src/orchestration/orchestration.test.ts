/**
 * Tests d'orchestration : file, événements, webhook, pipeline, consommation.
 *
 * Le scan complet est exécuté pour de vrai (indexeur, MCP, agrégateur, master),
 * avec un faux client LLM : c'est la logique d'enchaînement qu'on vérifie, pas
 * la qualité d'un modèle. Le vrai bout-en-bout réseau est dans `npm run e2e`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { InMemoryQueue, createQueue } from './queue.ts';
import { DEFAULT_DETECTION_CONCURRENCY, MAX_CONCURRENCY, MIN_CONCURRENCY } from './pool.ts';
import { StepEmitter } from './step-events.ts';
import { UsageTracker } from './usage-tracker.ts';
import { runScan, selectRoutes, IDOR_DETECTION_NODE, type DetectionNode, type ScanRequest } from './pipeline.ts';
import { createVulnPipeServer } from './webhook.ts';
import { DIRECT_ALERT_ABOVE, REJECT_BELOW } from '../aggregator/aggregator.ts';
import { FakeLlmClient } from '../nodes/shared/llm/fake.ts';
import { LlmError } from '../nodes/shared/llm/types.ts';
import { buildRepoIndex } from '../mcp-server/repo-index.ts';
import type { ListedRoute } from '../nodes/shared/mcp-client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(here, '..', 'nodes', 'idor', '__fixtures__', 'repo');

/** Verdict de node bien formé. */
const NODE_VERDICT = {
  analysis: { resource_identifier: 'id', user_context: 'aucun', step_by_step_reasoning: '...' },
  findings: [{ vulnerability: 'IDOR', line: 3, proof_snippet: 'findOne({ id })' }],
  confidence_score: 0.9,
  reason: 'none',
  plain_language_summary: "N'importe qui peut lire les commandes des autres.",
};

/** Verdict d'arbitre couvrant n'importe quel identifiant. */
function masterVerdicts(ids: string[]) {
  return {
    verdicts: ids.map((id) => ({
      finding_id: id,
      claude_verdict: 'confirmed',
      claude_reasoning: 'Le code lit la ressource sans vérifier le propriétaire.',
      technical_summary: 'Lecture par identifiant sans filtre.',
      plain_language_summary: "Quelqu'un peut voir les données d'un autre en changeant le numéro.",
      suggested_fix_direction: "Vérifier que la donnée appartient à la personne connectée.",
      owasp_category: 'A01:2021 – Broken Access Control',
    })),
  };
}

// ===========================================================================
// File de messages
// ===========================================================================

describe('File de messages', () => {
  it('traite les jobs dans l ordre et signale la fin', async () => {
    const queue = new InMemoryQueue<{ n: number }>('test');
    const seen: number[] = [];
    queue.process(async (payload) => {
      seen.push(payload.n);
    });
    await queue.add({ n: 1 });
    await queue.add({ n: 2 });
    await queue.add({ n: 3 });
    await queue.drain();
    expect(seen).toEqual([1, 2, 3]);
  });

  it('un job en échec ne bloque pas les suivants', async () => {
    const queue = new InMemoryQueue<{ n: number }>('test');
    const seen: number[] = [];
    queue.process(async (payload) => {
      if (payload.n === 2) throw new Error('échec volontaire');
      seen.push(payload.n);
    });
    await queue.add({ n: 1 });
    await queue.add({ n: 2 });
    await queue.add({ n: 3 });
    await queue.drain();
    expect(seen).toEqual([1, 3]);
  });

  it('choisit la file en mémoire sans REDIS_URL', async () => {
    const queue = await createQueue('scan', {});
    expect(queue).toBeInstanceOf(InMemoryQueue);
  });

  it('explique clairement si REDIS_URL est posé sans bullmq installé', async () => {
    await expect(createQueue('scan', { REDIS_URL: 'redis://localhost:6379' })).rejects.toThrow(
      /bullmq.*n'est pas installé/
    );
  });
});

// ===========================================================================
// Événements de progression
// ===========================================================================

describe('Événements de progression', () => {
  it('numérote les événements pour garantir un ordre stable', () => {
    const emitter = new StepEmitter('run-x');
    emitter.emit('indexing', 'running', 'a');
    emitter.emit('detection', 'running', 'b');
    emitter.emit('indexing', 'done', 'c');
    expect(emitter.getHistory().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('rejoue son historique à un client qui arrive en cours de route', () => {
    const emitter = new StepEmitter('run-x');
    emitter.emit('indexing', 'done', 'déjà passé');
    const received: string[] = [];
    for (const event of emitter.getHistory()) received.push(event.plain_language);
    emitter.on((event) => received.push(event.plain_language));
    emitter.emit('detection', 'running', 'en cours');
    expect(received).toEqual(['déjà passé', 'en cours']);
  });

  it("un listener qui plante n'interrompt pas le scan", () => {
    const emitter = new StepEmitter('run-x');
    emitter.on(() => {
      throw new Error('listener cassé');
    });
    expect(() => emitter.emit('indexing', 'done', 'ok')).not.toThrow();
  });

  it('supporte un statut d échec, absent de la spec', () => {
    const emitter = new StepEmitter('run-x');
    const event = emitter.emit('detection', 'failed', "Une adresse n'a pas pu être vérifiée.");
    expect(event.status).toBe('failed');
  });
});

// ===========================================================================
// Suivi de consommation (fonctionnalité demandée)
// ===========================================================================

describe('Suivi de consommation', () => {
  it('compte les appels par étape et par modèle sans instrumenter les nodes', async () => {
    const tracker = new UsageTracker();
    const wrapped = tracker.wrap(new FakeLlmClient([{ parsed: NODE_VERDICT }]), 'detection');

    await wrapped.complete({ system: 's', user: 'u', schema: { type: 'object', properties: {}, required: [] } });
    const report = tracker.report();

    expect(report.totals.calls).toBe(1);
    expect(report.by_stage.detection!.calls).toBe(1);
    expect(Object.keys(report.by_model)).toEqual(['fake/fake-model']);
  });

  it("n'invente jamais un coût que le fournisseur ne donne pas", async () => {
    const tracker = new UsageTracker();
    const wrapped = tracker.wrap(new FakeLlmClient([{ parsed: NODE_VERDICT }]), 'detection');
    await wrapped.complete({ system: 's', user: 'u', schema: { type: 'object', properties: {}, required: [] } });

    const report = tracker.report();
    expect(report.totals.cost_usd).toBeNull();
    expect(report.totals.cost_partial).toBe(true);
    expect(report.plain_language_summary).toContain('does not report cost');
  });

  it('dit clairement quand aucun appel IA n a eu lieu', () => {
    expect(new UsageTracker().report().plain_language_summary).toContain('no artificial intelligence');
  });
});

// ===========================================================================
// Modes de scan — incremental_scan, non implémenté par la spec
// ===========================================================================

describe('Sélection des routes selon le mode', () => {
  const index = buildRepoIndex(FIXTURE_REPO);
  const routes: ListedRoute[] = [
    { route: '/orders/:id', http_method: 'GET', controller: 'OrderController', handler: 'getOrder', file: 'order.controller.ts', guards: [], is_unguarded: true },
    { route: '/health', http_method: 'GET', controller: 'HealthController', handler: 'check', file: 'health.controller.ts', guards: [], is_unguarded: true },
  ];

  it('analyse tout en full_scan', () => {
    const result = selectRoutes(routes, { repo_path: FIXTURE_REPO, mode: 'full_scan' }, index);
    expect(result.routes).toHaveLength(2);
    expect(result.effectiveMode).toBe('full_scan');
  });

  it('retombe en full_scan et le DIT si le commit est absent', () => {
    const result = selectRoutes(routes, { repo_path: FIXTURE_REPO, mode: 'incremental_scan' }, index);
    expect(result.effectiveMode).toBe('full_scan');
    // Un incrémental dégradé en complet fait exploser la facture sans
    // prévenir : la dégradation doit être annoncée, jamais silencieuse.
    expect(result.note).toContain('the whole project was analyzed');
  });

  it('retombe en full_scan et le DIT si le diff est incalculable', () => {
    const result = selectRoutes(
      routes,
      { repo_path: FIXTURE_REPO, mode: 'incremental_scan', commit_sha: 'commit-inexistant' },
      index
    );
    expect(result.effectiveMode).toBe('full_scan');
    expect(result.note).toContain('not under version control, or unknown commit');
  });
});

// ===========================================================================
// Sélection incrémentale sur un vrai diff git
//
// Les tests ci-dessus ne couvraient que les REPLIS (pas de commit, diff
// incalculable) : le chemin nominal — un vrai `git diff`, un vrai choix de
// routes — n'était exercé nulle part. C'est pourtant lui qui décide ce qui
// n'est PAS analysé, donc le seul endroit du mode incrémental capable de
// produire un faux négatif.
//
// Ces dépôts sont créés sur disque et commités : `git` est local, hors ligne,
// et l'ensemble tourne en quelques dizaines de millisecondes.
// ===========================================================================

const temporaryRepositories: string[] = [];

afterAll(() => {
  for (const directory of temporaryRepositories) rmSync(directory, { recursive: true, force: true });
});

/**
 * Crée un dépôt git jetable et y joue une suite de commits.
 * `commits` : liste de jeux de fichiers, appliqués et commités dans l'ordre.
 */
function makeRepository(commits: Record<string, string>[], subdirectory = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'vulnpipe-select-'));
  temporaryRepositories.push(root);
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=test', ...args], {
      cwd: root,
      stdio: 'ignore',
    });
  };
  git('init', '-q', '.');
  for (const files of commits) {
    for (const [name, content] of Object.entries(files)) {
      const full = join(root, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    git('add', '-A');
    git('commit', '-qm', 'commit');
  }
  return subdirectory ? join(root, subdirectory) : root;
}

function headOf(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/** Les routes telles que le serveur MCP les publierait pour cet index. */
function listRoutesOf(index: ReturnType<typeof buildRepoIndex>): ListedRoute[] {
  return index.endpoints.map((e) => ({
    route: e.endpoint.route,
    http_method: e.endpoint.http_method.toUpperCase(),
    controller: e.controller.controller,
    handler: e.endpoint.handler,
    file: e.endpoint.source.file,
    guards: e.endpoint.framework_metadata.guards,
    is_unguarded: e.endpoint.framework_metadata.is_unguarded,
  }));
}

const CONTROLLER = `@Controller('orders')
export class OrderController {
  constructor(private orderService: OrderService) {}

  @Get('/:id')
  async getOrder(@Param('id') id: string) {
    return this.orderService.findById(id);
  }
}
`;

const OTHER_CONTROLLER = `@Controller('health')
export class HealthController {
  @Get('/')
  async check() {
    return { ok: true };
  }
}
`;

const SERVICE_SAFE = `export class OrderService {
  async findById(id: string, userId: string) {
    return this.db.orders.findOne({ id, userId });
  }
}
`;

const SERVICE_VULNERABLE = `export class OrderService {
  async findById(id: string) {
    return this.db.orders.findOne({ id });
  }
}
`;

describe('Sélection incrémentale sur un vrai diff git', () => {
  it('réanalyse la route quand SEUL le service qu elle appelle a changé', () => {
    // Le scénario le plus banal du produit : le contrôleur ne bouge pas, mais
    // le service perd son filtre `userId`. La faille est introduite par ce
    // commit. Si la route n'est pas resélectionnée, VulnPipe annonce « rien à
    // revérifier » sur le commit qui vient de créer la faille.
    const root = makeRepository([
      { 'package.json': '{}', 'src/order.controller.ts': CONTROLLER, 'src/order.service.ts': SERVICE_SAFE },
      { 'src/order.service.ts': SERVICE_VULNERABLE },
    ]);
    const repoIndex = buildRepoIndex(root);

    const result = selectRoutes(
      listRoutesOf(repoIndex),
      { repo_path: root, mode: 'incremental_scan', commit_sha: headOf(root) },
      repoIndex,
      root
    );

    expect(result.effectiveMode).toBe('incremental_scan');
    expect(result.routes.map((r) => r.route)).toEqual(['/orders/:id']);
  });

  it('n analyse pas les routes qu un changement ne peut pas atteindre', () => {
    // La contrepartie : le mode n'a d'intérêt que s'il élague vraiment. Une
    // route sans aucun lien avec le fichier modifié doit rester de côté.
    const root = makeRepository([
      {
        'package.json': '{}',
        'src/order.controller.ts': CONTROLLER,
        'src/order.service.ts': SERVICE_SAFE,
        'src/health.controller.ts': OTHER_CONTROLLER,
      },
      { 'src/order.service.ts': SERVICE_VULNERABLE },
    ]);
    const repoIndex = buildRepoIndex(root);

    const result = selectRoutes(
      listRoutesOf(repoIndex),
      { repo_path: root, mode: 'incremental_scan', commit_sha: headOf(root) },
      repoIndex,
      root
    );

    expect(result.routes.map((r) => r.route)).toEqual(['/orders/:id']);
  });

  it('retombe en full_scan et le DIT si un fichier de code modifié n est rattaché à aucune route', () => {
    // On ne sait pas ce que ce fichier influence : l'index ne le relie à
    // aucune route. Conclure « rien à revérifier » serait une affirmation
    // qu'on ne peut pas soutenir — donc on analyse tout, et on l'annonce.
    const root = makeRepository([
      { 'package.json': '{}', 'src/order.controller.ts': CONTROLLER, 'src/order.service.ts': SERVICE_SAFE },
      { 'src/pricing.ts': 'export class Pricing {\n  total(n: number) {\n    return n;\n  }\n}\n' },
    ]);
    const repoIndex = buildRepoIndex(root);

    const result = selectRoutes(
      listRoutesOf(repoIndex),
      { repo_path: root, mode: 'incremental_scan', commit_sha: headOf(root) },
      repoIndex,
      root
    );

    expect(result.effectiveMode).toBe('full_scan');
    expect(result.routes).toHaveLength(1);
    expect(result.note).toContain('src/pricing.ts');
  });

  it('un fichier hors code (documentation) ne déclenche pas de scan complet', () => {
    const root = makeRepository([
      { 'package.json': '{}', 'src/order.controller.ts': CONTROLLER, 'src/order.service.ts': SERVICE_SAFE },
      { 'README.md': '# doc\n' },
    ]);
    const repoIndex = buildRepoIndex(root);

    const result = selectRoutes(
      listRoutesOf(repoIndex),
      { repo_path: root, mode: 'incremental_scan', commit_sha: headOf(root) },
      repoIndex,
      root
    );

    expect(result.effectiveMode).toBe('incremental_scan');
    expect(result.routes).toHaveLength(0);
    expect(result.note).toContain('nothing to re-check');
  });

  it('trouve les fichiers modifiés quand le code vit dans un sous-dossier du dépôt', () => {
    // `git diff --name-only` renvoie des chemins relatifs à la RACINE DU DÉPÔT,
    // pas au dossier courant. Sur un monorepo dont on n'indexe qu'un paquet,
    // aucun chemin ne correspondait et le scan concluait « rien à revérifier ».
    const indexRoot = makeRepository(
      [
        {
          'packages/api/package.json': '{}',
          'packages/api/src/order.controller.ts': CONTROLLER,
          'packages/api/src/order.service.ts': SERVICE_SAFE,
        },
        { 'packages/api/src/order.service.ts': SERVICE_VULNERABLE },
      ],
      'packages/api'
    );
    const repoIndex = buildRepoIndex(indexRoot);

    const result = selectRoutes(
      listRoutesOf(repoIndex),
      { repo_path: indexRoot, mode: 'incremental_scan', commit_sha: headOf(indexRoot) },
      repoIndex,
      indexRoot
    );

    expect(result.routes.map((r) => r.route)).toEqual(['/orders/:id']);
  });
});

// ===========================================================================
// Pipeline complète
// ===========================================================================

describe('Pipeline complète', () => {
  it('enchaîne toutes les étapes dans l ordre et produit un rapport', async () => {
    const emitter = new StepEmitter('run-test');
    const events: string[] = [];
    emitter.on((event) => events.push(`${event.step}:${event.status}`));

    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([
          { parsed: masterVerdicts(['IDOR:GET:/orders/:id', 'IDOR:GET:/reports/:id']) },
        ]),
        emitter,
      }
    );

    expect(events[0]).toBe('received:done');
    expect(events).toContain('indexing:done');
    expect(events).toContain('context_server:done');
    expect(events).toContain('aggregation:done');
    expect(events).toContain('master_review:done');
    expect(events[events.length - 1]).toBe('report:done');

    expect(result.report.scan_summary.total_findings).toBeGreaterThan(0);
    expect(result.routes_analyzed).toBe(4);
  });

  it('mesure la consommation de bout en bout, détecteurs et arbitre séparés', async () => {
    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts(['IDOR:GET:/orders/:id']) }]),
      }
    );

    expect(result.usage.by_stage.detection!.calls).toBeGreaterThan(0);
    expect(result.usage.by_stage.master_review!.calls).toBe(1);
    expect(result.usage.totals.calls).toBe(
      result.usage.by_stage.detection!.calls + result.usage.by_stage.master_review!.calls
    );
  });

  it("économise les appels sur les routes tranchées sans IA", async () => {
    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
      }
    );
    // 4 routes, mais /health et /invoices/:id sont tranchées par le scanner
    // déterministe : moins d'appels que de routes.
    expect(result.usage.by_stage.detection!.calls).toBeLessThan(result.routes_analyzed);
  });

  it("signale une route en échec au lieu de la compter comme saine", async () => {
    const emitter = new StepEmitter('run-fail');
    const events: Array<{ step: string; status: string }> = [];
    emitter.on((event) => events.push({ step: event.step, status: event.status }));

    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([
          { error: new LlmError('fake', 'unavailable', 'moteur indisponible', true) },
        ]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
        emitter,
      }
    );

    expect(result.routes_failed).toBeGreaterThan(0);
    expect(events.some((e) => e.step === 'detection' && e.status === 'failed')).toBe(true);
    // Le rapport doit annoncer la couverture partielle.
    expect(result.report.scan_summary.plain_language_intro).toContain('incomplet');
  });

  it('publie des messages en langage humain, sans nom de composant', async () => {
    const emitter = new StepEmitter('run-lang');
    const messages: string[] = [];
    emitter.on((event) => messages.push(event.plain_language));

    await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
        emitter,
        nodes: [IDOR_DETECTION_NODE],
      }
    );

    const joined = messages.join(' ');
    for (const jargon of ['Node IDOR', 'MCP', 'aggregator', 'LLM', 'payload', 'confidence_score']) {
      expect(joined).not.toContain(jargon);
    }
  });

  // -------------------------------------------------------------------------
  // Parallélisme borné de la détection
  // -------------------------------------------------------------------------

  it('examine plusieurs adresses en même temps sans dépasser la borne', async () => {
    let inFlight = 0;
    let peak = 0;

    // Un node factice qui tient le compte de ce qui est en vol. Le vrai node
    // IDOR tranche deux des quatre routes du dépôt de test sans modèle : il ne
    // laisserait pas assez de travail simultané pour mesurer quoi que ce soit.
    const counting: DetectionNode = {
      id: 'counting-node',
      vulnerability: 'IDOR',
      plainLanguage: () => 'Vérification en cours.',
      async analyze() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          finding: null,
          confidence_score: 0.1,
          plain_language_summary: 'Rien à signaler ici.',
          free: true,
          cached: false,
        };
      },
    };

    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
        nodes: [counting],
        detectionConcurrency: 3,
      }
    );

    expect(result.routes_analyzed).toBe(4);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('à concurrence 1, retrouve exactement le comportement séquentiel', async () => {
    let inFlight = 0;
    let peak = 0;
    const counting: DetectionNode = {
      id: 'counting-node',
      vulnerability: 'IDOR',
      plainLanguage: () => 'Vérification en cours.',
      async analyze() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return {
          finding: null,
          confidence_score: 0.1,
          plain_language_summary: 'Rien à signaler ici.',
          free: true,
          cached: false,
        };
      },
    };

    await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
        nodes: [counting],
        detectionConcurrency: 1,
      }
    );

    expect(peak).toBe(1);
  });

  it("rend les signalements dans l'ordre des adresses, pas dans celui des réponses", async () => {
    // La route la plus lente répond en dernier. Son signalement doit tout de
    // même ressortir à sa place : un rapport dont l'ordre bouge d'une
    // exécution à l'autre n'est ni comparable ni testable.
    const order: string[] = [];
    const slowFirst: DetectionNode = {
      id: 'slow-first',
      vulnerability: 'IDOR',
      plainLanguage: () => 'Vérification en cours.',
      async analyze(route) {
        // Première route servie = la plus lente.
        const delay = order.length === 0 ? 30 : 1;
        order.push(route.route);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          finding: {
            vulnerability: 'IDOR',
            route: route.route,
            http_method: route.http_method,
            handler: 'h',
            file: route.file,
            line: 1,
            confidence_score: 0.9,
            reason: null,
            plain_language_summary: `Signalement sur ${route.route}.`,
            detected_by: 'slow-first',
          },
          confidence_score: 0.9,
          plain_language_summary: `Signalement sur ${route.route}.`,
          free: false,
          cached: false,
        };
      },
    };

    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
        nodes: [slowFirst],
        detectionConcurrency: 4,
      }
    );

    const started = order;
    const produced = result.aggregation.claude_payload
      .concat(result.aggregation.direct_alerts)
      .map((finding) => finding.route);

    // Toutes les routes lancées sont représentées, et la première lancée
    // (la plus lente) n'est pas reléguée en queue.
    expect(new Set(produced)).toEqual(new Set(started));
    expect(produced[0]).toBe(started[0]);
  });

  it('nomme ce qui n a pas été facturé, gratuité par gratuité', async () => {
    const emitter = new StepEmitter('run-savings');
    const said: string[] = [];
    emitter.on((event) => said.push(event.plain_language));

    const result = await runScan(
      { repo_path: FIXTURE_REPO, mode: 'full_scan' },
      {
        nodeLlm: new FakeLlmClient([{ parsed: NODE_VERDICT }]),
        masterLlm: new FakeLlmClient([{ parsed: masterVerdicts([]) }]),
        emitter,
      }
    );

    // Deux des quatre routes du dépôt de test sont tranchées par le scanner.
    expect(result.routes_settled_free).toBe(2);
    expect(result.routes_from_cache).toBe(0);
    expect(said.join(' ')).toContain('settled without the AI');
  });
});

// ===========================================================================
// Webhook
// ===========================================================================

describe('Webhook', () => {
  function makeServer(env: Record<string, string> = {}) {
    const queue = new InMemoryQueue<ScanRequest & { run_id: string }>('scan');
    return {
      queue,
      ...createVulnPipeServer({
        queue,
        // L'environnement est fourni EN ENTIER ici : `vitest.config.ts` ne
        // protège que ce qui lit `process.env`, et ce serveur-ci lit l'objet
        // qu'on lui passe. Sans ce drapeau, chaque test écrirait un cache
        // dans le dossier d'état du développeur.
        env: { GEMINI_API_KEY: 'x', VULNPIPE_CACHE_PERSIST: 'false', ...env } as NodeJS.ProcessEnv,
        settings: { nodeProvider: 'gemini', masterProvider: 'gemini' },
      }),
    };
  }

  /** Appelle le handler HTTP sans ouvrir de socket. */
  async function call(
    server: ReturnType<typeof makeServer>,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(
      (async function* () {
        yield* chunks;
      })(),
      { method, url: path, on: () => {} }
    ) as never;

    return new Promise((resolve) => {
      let status = 200;
      let payload = '';
      const res = {
        writeHead(code: number) {
          status = code;
          return res;
        },
        write(chunk: string) {
          payload += chunk;
          return true;
        },
        end(chunk?: string) {
          if (chunk) payload += chunk;
          resolve({ status, json: payload ? JSON.parse(payload) : {} });
        },
      } as never;
      void server.handler(req, res);
    });
  }

  it('refuse une demande sans cible, en expliquant pourquoi', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/webhook', { mode: 'full_scan' });
    expect(response.status).toBe(400);
    // Le message énumère les trois formes acceptées : un utilisateur qui ne
    // sait pas quoi coller doit lire la réponse, pas la documentation.
    expect(response.json.plain_language_summary).toContain('folder');
    expect(response.json.plain_language_summary).toContain('file');
    expect(response.json.plain_language_summary).toContain('GitHub');
  });

  it('refuse un mode inconnu', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/webhook', { repo_path: '/x', mode: 'turbo' });
    expect(response.status).toBe(400);
  });

  it('accepte une demande valide et renvoie de quoi suivre le scan', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/webhook', {
      repo_path: FIXTURE_REPO,
      mode: 'full_scan',
    });
    expect(response.status).toBe(202);
    expect(String(response.json.run_id)).toMatch(/^run-/);
    expect(response.json.events_url).toContain('/events');
  });

  it('liste les fournisseurs avec leur disponibilité réelle', async () => {
    const server = makeServer();
    const response = await call(server, 'GET', '/providers');
    const available = response.json.available as Array<{ id: string; available: boolean; why: string | null }>;

    expect(available.find((p) => p.id === 'gemini')!.available).toBe(true);
    const anthropic = available.find((p) => p.id === 'anthropic')!;
    // Sans clé, le fournisseur est signalé indisponible AVEC la raison, plutôt
    // que masqué : l'utilisateur doit savoir ce qui lui manque.
    expect(anthropic.available).toBe(false);
    expect(anthropic.why).toBeTruthy();
  });

  it('bascule de fournisseur à chaud', async () => {
    const server = makeServer({ OPEN_ROUTER_API_KEY: 'clef' });
    const response = await call(server, 'POST', '/providers', { nodeProvider: 'openrouter' });
    expect(response.status).toBe(200);
    expect((response.json.settings as { nodeProvider: string }).nodeProvider).toBe('openrouter');
  });

  it('refuse une bascule vers un fournisseur sans clé, et garde l ancien réglage', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/providers', { nodeProvider: 'anthropic' });
    expect(response.status).toBe(400);
    expect(response.json.plain_language_summary).toContain('access key is missing');
    expect(server.settings.nodeProvider).toBe('gemini');
  });

  it('renvoie 404 sur un run inconnu', async () => {
    const server = makeServer();
    expect((await call(server, 'GET', '/runs/inexistant')).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Réglages d'analyse
  //
  // Ils sont servis PAR LE SERVEUR et non figés dans l'interface : les seuils
  // affichés à l'utilisateur doivent être ceux que l'agrégateur applique
  // réellement, sinon l'écran explique une pipeline qui n'existe pas.
  // -------------------------------------------------------------------------

  it("REFUSE un niveau d effort inconnu au lieu de l ignorer", async () => {
    // Ici la personne l'a posé explicitement : l'avaler en silence lui ferait
    // croire à un réglage appliqué qui ne l'est pas.
    const server = makeServer();
    const response = await call(server, 'POST', '/providers', { masterEffort: 'turbo' });

    expect(response.status).toBe(400);
    expect(response.json.plain_language_summary).toMatch(/low, medium, high/);
    expect(server.settings.masterEffort).toBeUndefined();
  });

  it('accepte et conserve un niveau d effort valide', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/providers', { masterEffort: 'low' });

    expect(response.status).toBe(200);
    expect(server.settings.masterEffort).toBe('low');
  });

  /** Le corps des réponses est un `Record<string, unknown>` : on le lit une fois. */
  const concurrencyOf = (body: Record<string, unknown>): unknown =>
    (body.settings as { detectionConcurrency?: unknown }).detectionConcurrency;

  it('expose les réglages d analyse et les seuils réellement appliqués', async () => {
    const server = makeServer();
    const response = await call(server, 'GET', '/settings');
    expect(response.status).toBe(200);
    expect(response.json.settings).toEqual({
      bypassClaudeForHighConfidence: false,
      detectionConcurrency: DEFAULT_DETECTION_CONCURRENCY,
    });
    expect(response.json.thresholds).toEqual({ reject_below: REJECT_BELOW, direct_alert_above: DIRECT_ALERT_ABOVE });
    // Les bornes viennent du serveur : recopiées dans l'interface, elles
    // mentiraient le jour où elles bougeraient.
    expect((response.json.limits as { concurrency: unknown }).concurrency).toEqual({
      min: MIN_CONCURRENCY,
      max: MAX_CONCURRENCY,
    });
  });

  it('applique à chaud le nombre d adresses examinées en même temps', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/settings', { detectionConcurrency: 8 });
    expect(response.status).toBe(200);
    expect(concurrencyOf(response.json)).toBe(8);
    expect(concurrencyOf((await call(server, 'GET', '/settings')).json)).toBe(8);
  });

  it('refuse une concurrence hors bornes au lieu de la rabattre en silence', async () => {
    const server = makeServer();
    for (const bad of [0, 200, 2.5, 'beaucoup']) {
      const response = await call(server, 'POST', '/settings', { detectionConcurrency: bad });
      expect(response.status).toBe(400);
      // Le corps dit CE QUI ne va pas, pas seulement que ça a échoué.
      expect(response.json.error).toContain('detectionConcurrency');
      expect(response.json.plain_language_summary).toBeTruthy();
    }
    // Et le réglage précédent tient : un refus ne doit rien changer.
    expect(concurrencyOf((await call(server, 'GET', '/settings')).json)).toBe(
      DEFAULT_DETECTION_CONCURRENCY
    );
  });

  // -------------------------------------------------------------------------
  // Persistance des caches
  // -------------------------------------------------------------------------

  it('reprend ses caches au redémarrage, et le dit', () => {
    // C'est ce qui rend l'économie réelle : en mémoire, un
    // `docker compose restart` la remettait à zéro et le scan suivant
    // repayait tout — exactement la situation d'avant le cache.
    const dir = mkdtempSync(join(tmpdir(), 'vulnpipe-server-cache-'));
    try {
      const env = { VULNPIPE_CACHE_DIR: dir } as Record<string, string>;

      const first = makeServer({ ...env, VULNPIPE_CACHE_PERSIST: 'true' });
      first.verdictCache.set('cle-de-test', { confidence_score: 0.9 });
      first.shutdown();

      const second = makeServer({ ...env, VULNPIPE_CACHE_PERSIST: 'true' });
      expect(second.verdictCache.get('cle-de-test')).toEqual({ confidence_score: 0.9 });

      const state = second.describeCaches();
      expect(state.persisted).toBe(true);
      // La reprise est ANNONCÉE : un cache qu'on croit chargé et qui ne l'est
      // pas transforme un scan censé être gratuit en scan facturé, sans que
      // rien ne l'explique.
      expect(state.restored.find((entry) => entry.kind === 'verdicts')).toMatchObject({
        kept: 1,
        why: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("oublie sur demande — l'échappatoire que le redémarrage n'est plus", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vulnpipe-server-forget-'));
    try {
      const env = { VULNPIPE_CACHE_DIR: dir, VULNPIPE_CACHE_PERSIST: 'true' } as Record<string, string>;

      const server = makeServer(env);
      server.verdictCache.set('cle-de-test', { confidence_score: 0.9 });
      server.shutdown();

      const response = await call(makeServer(env), 'DELETE', '/cache');
      expect(response.status).toBe(200);

      // Rien ne doit remonter du disque au démarrage suivant.
      const after = makeServer(env);
      expect(after.verdictCache.get('cle-de-test')).toBeUndefined();
      expect(after.describeCaches().detection.entries).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Défauts trouvés par la passe QA (`npm run qa`), verrouillés ici
  // -------------------------------------------------------------------------

  it('refuse un corps qui n est pas un objet JSON, au lieu de tomber dessus', async () => {
    // `JSON.parse("null")` rend `null`, que les appelants lisaient comme un
    // objet (`body.locale`) : exception non rattrapée sur une entrée triviale.
    // Et le remplacer en silence par `{}` serait combler un trou avec une
    // valeur par défaut — ce que ce produit refuse.
    const server = makeServer();
    for (const body of ['null', '[]', '"une chaîne"', '42', 'true']) {
      const response = await call(server, 'POST', '/webhook', JSON.parse(body));
      expect(response.status).toBe(400);
      expect(response.json.error).toContain('JSON object');
    }
  });

  it('refuse un corps démesuré au lieu de l accumuler en mémoire', async () => {
    // Aucune borne : un client envoyant un gigaoctet faisait grossir le tas
    // jusqu'à l'étouffement. Le mode de déni de service le plus banal sur une
    // API qui accepte du JSON.
    const server = makeServer();
    const huge = { target: FIXTURE_REPO, mode: 'full_scan', pad: 'x'.repeat(3 * 1024 * 1024) };
    const response = await call(server, 'POST', '/webhook', huge);

    expect(response.status).toBe(400);
    expect(response.json.error).toContain('too large');
  });

  it('accepte un corps normal — la borne ne gêne pas l usage réel', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/webhook', { target: FIXTURE_REPO, mode: 'full_scan' });
    expect(response.status).toBe(202);
  });

  it('borne le nombre de devis retenus, sans jamais casser un scan en cours', async () => {
    // Un devis RETIENT l'index complet du dépôt, et pour une cible GitHub le
    // clone temporaire qui va avec. Le balayage ne libérait que les expirés,
    // toutes les 60 s : dans cette fenêtre, rien ne limitait leur nombre.
    // Plafond abaissé pour ce test : indexer trente fois le même dépôt pour
    // vérifier une borne coûterait des secondes à chaque `npm test`.
    const queue = new InMemoryQueue<ScanRequest & { run_id: string }>('scan');
    const server = {
      queue,
      ...createVulnPipeServer({
        queue,
        env: { GEMINI_API_KEY: 'x', VULNPIPE_CACHE_PERSIST: 'false' } as NodeJS.ProcessEnv,
        settings: { nodeProvider: 'gemini', masterProvider: 'gemini' },
        maxPendingEstimates: 3,
      }),
    };

    // Cinq demandes pour un plafond de trois : deux évictions suffisent à
    // prouver la règle, et chaque demande indexe RÉELLEMENT le dépôt.
    for (let i = 0; i < 5; i++) {
      const response = await call(server, 'POST', '/estimate', { target: FIXTURE_REPO, mode: 'full_scan' });
      expect(response.status).toBe(200);
    }
    expect(server.estimates.size).toBeLessThanOrEqual(3);

    // Un devis retient une connexion au serveur de contexte : le laisser
    // ouvert retient le processus, en test comme en production.
    server.shutdown();
  });

  it("le plafond d'émetteurs n'évince jamais un scan encore en attente", async () => {
    // La file traite un job à la fois : lancer beaucoup de scans les met tous
    // en attente. Un plafond qui évincerait « le plus ancien » retirerait
    // l'émetteur du PREMIER de la file — celui qui allait démarrer — et le
    // ferait apparaître en panne alors qu'il n'a jamais été lancé.
    // Plafond abaissé : ce qu'on vérifie est la RÈGLE, pas le chiffre.
    const queue = new InMemoryQueue<ScanRequest & { run_id: string }>('scan');
    const server = {
      queue,
      ...createVulnPipeServer({
        queue,
        env: { GEMINI_API_KEY: 'x', VULNPIPE_CACHE_PERSIST: 'false' } as NodeJS.ProcessEnv,
        settings: { nodeProvider: 'gemini', masterProvider: 'gemini' },
        maxLiveEmitters: 2,
      }),
    };

    // Quatre lancements pour un plafond de deux : le plus ancien est
    // candidat à l'éviction, ce qui est exactement le cas à couvrir.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await call(server, 'POST', '/webhook', { target: FIXTURE_REPO, mode: 'full_scan' });
      ids.push((response.json as { run_id: string }).run_id);
    }

    // Aucun run n'est marqué en échec pour cause d'émetteur disparu.
    const spurious = ids.filter((id) => {
      const state = server.runStore.get(id);
      return state?.status === 'failed' && (state.error ?? '').includes('has since restarted');
    });
    expect(spurious).toEqual([]);
    server.shutdown();
    // Budget explicite : ce test indexe le dépôt cinq fois, pendant que les
    // scans des tests précédents finissent encore dans leur file. Cinq
    // secondes n'est pas un budget honnête pour du travail réel — et un test
    // qui rougit une fois sur deux est un test qu'on finit par ignorer.
  }, 30_000);

  it('un identifiant de run biscornu est refusé avant d atteindre le disque', async () => {
    // L'identifiant vient de l'URL et compose un nom de fichier depuis que
    // les runs sont persistés : c'est une traversée de répertoire.
    const server = makeServer();
    for (const bad of ['../secret', '..%2Fsecret', 'a/b', '/etc/passwd']) {
      const response = await call(server, 'GET', `/runs/${encodeURIComponent(bad)}`);
      expect(response.status).toBe(400);
    }
  });

  it('reste utilisable quand la persistance est éteinte', () => {
    // Les caches doivent continuer à fonctionner en mémoire : éteindre la
    // persistance ne doit pas éteindre l'économie du scan en cours.
    const server = makeServer({ VULNPIPE_CACHE_PERSIST: 'false' });
    server.verdictCache.set('k', { confidence_score: 0.1 });

    expect(server.verdictCache.get('k')).toEqual({ confidence_score: 0.1 });
    expect(server.describeCaches().persisted).toBe(false);
    expect(server.describeCaches().restored).toEqual([]);
    expect(() => server.shutdown()).not.toThrow();
  });

  it('ignore une variable d environnement hors bornes plutôt que de la rabattre', async () => {
    // `VULNPIPE_DETECTION_CONCURRENCY=200` doit laisser le défaut en place :
    // rabattre à 16 ferait croire au réglage appliqué.
    const absurd = makeServer({ VULNPIPE_DETECTION_CONCURRENCY: '200' });
    expect(concurrencyOf((await call(absurd, 'GET', '/settings')).json)).toBe(
      DEFAULT_DETECTION_CONCURRENCY
    );

    const sound = makeServer({ VULNPIPE_DETECTION_CONCURRENCY: '2' });
    expect(concurrencyOf((await call(sound, 'GET', '/settings')).json)).toBe(2);
  });

  it('bascule le contournement de l arbitrage à chaud', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/settings', {
      bypassClaudeForHighConfidence: true,
    });
    expect(response.status).toBe(200);
    expect(server.scanSettings.bypassClaudeForHighConfidence).toBe(true);

    // Et le réglage tient d'une requête à l'autre.
    const reread = await call(server, 'GET', '/settings');
    expect((reread.json.settings as { bypassClaudeForHighConfidence: boolean }).bypassClaudeForHighConfidence).toBe(true);
  });

  it('refuse une valeur qui n est pas un booléen, et garde l ancien réglage', async () => {
    const server = makeServer();
    const response = await call(server, 'POST', '/settings', {
      bypassClaudeForHighConfidence: 'oui',
    });
    expect(response.status).toBe(400);
    expect(response.json.plain_language_summary).toBeTruthy();
    expect(server.scanSettings.bypassClaudeForHighConfidence).toBe(false);
  });

  it('démarre avec le contournement demandé par l environnement', async () => {
    const server = makeServer({ VULNPIPE_BYPASS_MASTER: 'true' });
    expect(server.scanSettings.bypassClaudeForHighConfidence).toBe(true);
  });
});
