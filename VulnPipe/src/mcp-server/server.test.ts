import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer, createServerFromDirectory } from './server.ts';
import { buildRepoIndex } from './repo-index.ts';
import { resolveContext, guardClassNames, ContextResolutionError } from './resolver.ts';
import type { ContextBundle, ResolvedCall } from './resolver.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(here, '__fixtures__', 'repo');

/** Monte un client MCP relié au serveur, en mémoire (pas de process externe). */
async function connectClient(root: string) {
  const { server } = createServerFromDirectory(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vulnpipe-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

/** Écrit un mini-repo jetable et renvoie son chemin. */
function makeTempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vulnpipe-'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

/** Aplatit l'arbre d'appels résolus. */
function flatten(calls: ResolvedCall[]): ResolvedCall[] {
  return calls.flatMap((c) => [c, ...flatten(c.resolved_calls)]);
}

// ===========================================================================
// Cas de test imposés par PHASE_2_MCP_SERVER.md
// ===========================================================================

describe('get_context via un vrai client MCP', () => {
  let client: Awaited<ReturnType<typeof connectClient>>['client'];
  let server: Awaited<ReturnType<typeof connectClient>>['server'];

  beforeAll(async () => {
    ({ client, server } = await connectClient(FIXTURE_REPO));
  });
  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('expose get_context et list_routes avec un schéma d entrée valide', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_context', 'list_routes']);

    const getContext = tools.find((t) => t.name === 'get_context')!;
    expect(getContext.inputSchema.required).toEqual(['route']);
    expect(Object.keys(getContext.inputSchema.properties!)).toEqual(
      expect.arrayContaining(['route', 'http_method', 'depth', 'byte_budget'])
    );
  });

  it('résout findById à travers les fichiers — le cas central de la Phase 2', async () => {
    const result = await client.callTool({
      name: 'get_context',
      arguments: { route: '/orders/:id', http_method: 'GET', depth: 2 },
    });

    expect(result.isError).not.toBe(true);
    const bundle = result.structuredContent as unknown as ContextBundle;

    expect(bundle.endpoint.handler).toBe('getOrder');
    expect(bundle.controller).toBe('OrderController');

    const findById = bundle.resolved_calls.find((c) => c.call === 'findById')!;
    expect(findById.resolution_status).toBe('resolved');
    expect(findById.reason).toBeNull();
    expect(findById.candidates).toHaveLength(1);

    // Le point clé : on a bien le CORPS de la méthode, pas juste son nom.
    const [candidate] = findById.candidates;
    expect(candidate.class_name).toBe('OrderService');
    expect(candidate.file).toBe('order.service.ts');
    expect(candidate.code_snapshot).toContain('this.db.orders.findOne({ id })');
  });

  it("désambiguïse par injected_type : UserService.findById ne rend pas l'appel ambigu", async () => {
    const result = await client.callTool({
      name: 'get_context',
      arguments: { route: '/orders/:id', http_method: 'GET' },
    });
    const bundle = result.structuredContent as unknown as ContextBundle;

    // UserService.findById existe bel et bien dans la fixture.
    const index = buildRepoIndex(FIXTURE_REPO);
    expect(index.classes.get('UserService')![0].methods.map((m) => m.name)).toContain('findById');

    const findById = bundle.resolved_calls.find((c) => c.call === 'findById')!;
    expect(findById.resolution_status).toBe('resolved');
    expect(findById.candidates.map((c) => c.class_name)).toEqual(['OrderService']);
    expect(findById.candidates[0].code_snapshot).not.toContain('this.db.users');
  });

  it('renvoie une erreur exploitable sur une route inconnue', async () => {
    const result = await client.callTool({
      name: 'get_context',
      arguments: { route: '/nope/:id' },
    });
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as { error: string; plain_language_summary: string };
    expect(payload.error).toContain('introuvable');
    expect(payload.plain_language_summary).toContain('/nope/:id');
  });

  it('rejette un argument mal typé sans exécuter le handler', async () => {
    const result = await client.callTool({
      name: 'get_context',
      arguments: { route: '/orders/:id', depth: 'deux' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('-32602');
  });

  it('list_routes énumère les routes et isole celles sans contrôle d accès', async () => {
    const all = await client.callTool({ name: 'list_routes', arguments: {} });
    const allPayload = all.structuredContent as { total: number; routes: Array<{ route: string }> };
    expect(allPayload.total).toBe(3);

    const unguarded = await client.callTool({
      name: 'list_routes',
      arguments: { unguarded_only: true },
    });
    const unguardedPayload = unguarded.structuredContent as {
      routes: Array<{ handler: string }>;
      plain_language_summary: string;
    };
    expect(unguardedPayload.routes.map((r) => r.handler).sort()).toEqual([
      'deleteOrder',
      'getPublicOrder',
    ]);
    expect(unguardedPayload.plain_language_summary).toContain('no declared access control');
  });
});

// ===========================================================================
// Correction n°1 — le corps du guard (absent de la spec, décisif pour l'IDOR)
// ===========================================================================

describe('résolution des guards', () => {
  const index = buildRepoIndex(FIXTURE_REPO);

  it('extrait les noms de classes guard depuis les décorateurs', () => {
    const guarded = index.endpoints.find((e) => e.endpoint.handler === 'getOrder')!.endpoint;
    expect(guardClassNames(guarded)).toEqual(['OwnershipGuard']);

    const unguarded = index.endpoints.find((e) => e.endpoint.handler === 'getPublicOrder')!.endpoint;
    expect(guardClassNames(unguarded)).toEqual([]);
  });

  it('récupère le corps de OwnershipGuard.canActivate — impossible via le call graph seul', () => {
    const bundle = resolveContext(index, { route: '/orders/:id', httpMethod: 'GET', depth: 2 });

    expect(bundle.resolved_guards).toHaveLength(1);
    const [guard] = bundle.resolved_guards;
    expect(guard.guard).toBe('OwnershipGuard');
    expect(guard.resolution_status).toBe('resolved');

    // La preuve que la route est réellement protégée : la comparaison de
    // propriété. Aucun appel du local_call_graph ne mène à ce code.
    expect(guard.candidates[0].method).toBe('canActivate');
    expect(guard.candidates[0].code_snapshot).toContain('order.userId === request.user.id');
  });

  it('distingue une route protégée d une route qui ne l est pas', () => {
    const guarded = resolveContext(index, { route: '/orders/:id', httpMethod: 'GET' });
    const unguarded = resolveContext(index, { route: '/orders/public/:id', httpMethod: 'GET' });

    expect(guarded.resolved_guards).toHaveLength(1);
    expect(unguarded.resolved_guards).toHaveLength(0);
    expect(unguarded.plain_language_summary).toContain("aucun contrôle d'accès");
  });

  it('signale un guard dont le code est introuvable plutôt que de le croire sûr', () => {
    const root = makeTempRepo({
      'a.controller.ts': `@Controller('a')
export class AController {
  @UseGuards(GhostGuard)
  @Get('/:id')
  async get() { return 1; }
}`,
    });
    const bundle = resolveContext(buildRepoIndex(root), { route: '/a/:id', httpMethod: 'GET' });
    expect(bundle.resolved_guards[0].resolution_status).toBe('not_found');
    expect(bundle.resolved_guards[0].reason).toBe('missing_context');
    expect(bundle.plain_language_summary).toContain("je n'ai pas retrouvé le code");
    rmSync(root, { recursive: true, force: true });
  });
});

// ===========================================================================
// Correction n°2 — collision de route (GET vs DELETE sur le même chemin)
// ===========================================================================

describe('identité d une route', () => {
  const index = buildRepoIndex(FIXTURE_REPO);

  it('refuse de deviner quand plusieurs verbes partagent la même route', () => {
    // La fixture a @Get('/:id') ET @Delete('/:id').
    expect(() => resolveContext(index, { route: '/orders/:id' })).toThrow(ContextResolutionError);
    try {
      resolveContext(index, { route: '/orders/:id' });
    } catch (error) {
      expect((error as ContextResolutionError).plainLanguageSummary).toContain('plusieurs méthodes HTTP');
    }
  });

  it('renvoie le bon handler une fois le verbe précisé', () => {
    expect(resolveContext(index, { route: '/orders/:id', httpMethod: 'GET' }).endpoint.handler).toBe(
      'getOrder'
    );
    expect(
      resolveContext(index, { route: '/orders/:id', httpMethod: 'DELETE' }).endpoint.handler
    ).toBe('deleteOrder');
  });
});

// ===========================================================================
// Correction n°3 — cycles, profondeur, budget
// ===========================================================================

describe('récursion bornée', () => {
  it('ne boucle pas sur un cycle A -> B -> A', () => {
    const root = makeTempRepo({
      'ping.controller.ts': `@Controller('ping')
export class PingController {
  constructor(private a: AService) {}
  @Get('/')
  async go() { return this.a.ping(); }
}`,
      'a.service.ts': `export class AService {
  constructor(private b: BService) {}
  async ping() { return this.b.pong(); }
}`,
      'b.service.ts': `export class BService {
  constructor(private a: AService) {}
  async pong() { return this.a.ping(); }
}`,
    });

    // Sans garde de cycle, cet appel part en stack overflow.
    const bundle = resolveContext(buildRepoIndex(root), { route: '/ping', httpMethod: 'GET', depth: 5 });
    const all = flatten(bundle.resolved_calls);

    expect(all.find((c) => c.call === 'ping' && c.already_expanded)).toBeDefined();
    expect(all.every((c) => c.resolution_status === 'resolved')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('depth=1 ne descend pas dans les appels du service résolu', () => {
    const index = buildRepoIndex(FIXTURE_REPO);
    const shallow = resolveContext(index, { route: '/orders/:id', httpMethod: 'GET', depth: 1 });
    const findById = shallow.resolved_calls.find((c) => c.call === 'findById')!;
    expect(findById.candidates).toHaveLength(1); // le corps est bien là
    expect(findById.resolved_calls).toEqual([]); // mais on ne descend pas
  });

  it('depth=2 descend d un niveau et voit la requête base non filtrée', () => {
    const index = buildRepoIndex(FIXTURE_REPO);
    const deep = resolveContext(index, { route: '/orders/:id', httpMethod: 'GET', depth: 2 });
    const findById = deep.resolved_calls.find((c) => c.call === 'findById')!;

    // `this.db.orders.findOne({ id })` — l'appel que les queries de la Phase 1
    // laissaient tomber silencieusement. C'est LE signal IDOR.
    const dbCall = findById.resolved_calls.find((c) => c.call === 'findOne')!;
    expect(dbCall).toBeDefined();
    expect(dbCall.receiver).toBe('this.db.orders');
    expect(dbCall.resolution_status).toBe('not_found');
    expect(dbCall.reason).toBe('missing_context');
  });

  it('respecte le budget d octets et le signale au lieu de couper en silence', () => {
    const index = buildRepoIndex(FIXTURE_REPO);
    const bundle = resolveContext(index, {
      route: '/orders/:id',
      httpMethod: 'GET',
      depth: 2,
      byteBudget: 60,
    });

    expect(bundle.budget.truncated).toBe(true);
    expect(bundle.budget.bytes_used).toBeLessThanOrEqual(60);
    expect(bundle.plain_language_summary).toContain('coupée');

    const snapshots = [
      ...bundle.resolved_guards.flatMap((g) => g.candidates.map((c) => c.code_snapshot)),
      ...flatten(bundle.resolved_calls).flatMap((c) => c.candidates.map((s) => s.code_snapshot)),
    ];
    expect(snapshots.some((s) => s.includes('budget de contexte atteint'))).toBe(true);
  });
});

// ===========================================================================
// Correction n°4 — ambiguïté réelle et mapping des raisons (CLAUDE.md §3)
// ===========================================================================

describe('ambiguïté et nature du doute', () => {
  it('marque ambiguous quand deux classes homonymes portent la méthode', () => {
    const root = makeTempRepo({
      'shop.controller.ts': `@Controller('shop')
export class ShopController {
  constructor(private orderService: OrderService) {}
  @Get('/:id')
  async get(@Param('id') id: string) { return this.orderService.findById(id); }
}`,
      'legacy/order.service.ts': `export class OrderService {
  async findById(id: string) { return this.db.legacyOrders.findOne({ id }); }
}`,
      'modern/order.service.ts': `export class OrderService {
  async findById(id: string) { return this.db.orders.findOne({ id, userId: this.ctx.userId }); }
}`,
    });

    const index = buildRepoIndex(root);
    expect(index.warnings.join(' ')).toContain('définie 2 fois');

    const bundle = resolveContext(index, { route: '/shop/:id', httpMethod: 'GET' });
    const call = bundle.resolved_calls.find((c) => c.call === 'findById')!;

    expect(call.resolution_status).toBe('ambiguous');
    // CLAUDE.md §3 : contexte complet mais jugement difficile -> direct à Claude.
    expect(call.reason).toBe('ambiguous_logic');
    expect(call.candidates).toHaveLength(2);
    expect(call.candidates.map((c) => c.file).sort()).toEqual([
      'legacy/order.service.ts',
      'modern/order.service.ts',
    ]);
    expect(bundle.reason).toBe('ambiguous_logic');
    rmSync(root, { recursive: true, force: true });
  });

  it('remonte missing_context quand il manque du code, pas ambiguous_logic', () => {
    const index = buildRepoIndex(FIXTURE_REPO);
    const bundle = resolveContext(index, { route: '/orders/public/:id', httpMethod: 'GET', depth: 2 });
    expect(bundle.reason).toBe('missing_context');
  });

  it('résout un appel de méthode locale sur la classe appelante', () => {
    const root = makeTempRepo({
      'x.controller.ts': `@Controller('x')
export class XController {
  @Get('/')
  async list() { return this.buildPayload(); }
  private buildPayload() { return { ok: true }; }
}`,
    });
    const bundle = resolveContext(buildRepoIndex(root), { route: '/x', httpMethod: 'GET' });
    const call = bundle.resolved_calls.find((c) => c.call === 'buildPayload')!;
    expect(call.resolution_status).toBe('resolved');
    expect(call.candidates[0].class_name).toBe('XController');
    rmSync(root, { recursive: true, force: true });
  });
});

// ===========================================================================
// Correction n°5 — explicabilité (CLAUDE.md §4, non négociable)
// ===========================================================================

describe('plain_language_summary', () => {
  const index = buildRepoIndex(FIXTURE_REPO);

  it('accompagne chaque bundle et reste lisible par un non-développeur', () => {
    const bundle = resolveContext(index, { route: '/orders/:id', httpMethod: 'GET', depth: 2 });
    const summary = bundle.plain_language_summary;

    expect(summary.length).toBeGreaterThan(80);
    expect(summary).toContain('GET /orders/:id');
    expect(summary).toContain('OwnershipGuard');
    // Pas de jargon SAST ni de fuite de structure technique.
    for (const jargon of ['JSON', 'AST', 'tree-sitter', 'call_graph', 'resolution_status', 'null']) {
      expect(summary).not.toContain(jargon);
    }
  });

  it('dit explicitement quand une route n a aucun contrôle d accès', () => {
    const bundle = resolveContext(index, { route: '/orders/public/:id', httpMethod: 'GET' });
    expect(bundle.plain_language_summary).toContain("n'a aucun contrôle d'accès déclaré");
  });
});

// ===========================================================================
// Index repo
// ===========================================================================

describe('index repo', () => {
  const index = buildRepoIndex(FIXTURE_REPO);

  it('indexe les classes NON contrôleurs — ce que la Phase 1 ne faisait pas', () => {
    expect([...index.classes.keys()].sort()).toEqual([
      'OrderController',
      'OrderService',
      'OwnershipGuard',
      'UserService',
    ]);
    const orderService = index.classes.get('OrderService')![0];
    expect(orderService.is_controller).toBe(false);
    expect(orderService.methods.map((m) => m.name)).toEqual(['findById', 'findPublicById']);
  });

  it('ignore node_modules et les fichiers de test', () => {
    const root = makeTempRepo({
      'a.controller.ts': `@Controller('a')\nexport class AController { @Get('/') async g() { return 1; } }`,
      'a.spec.ts': `export class ShouldBeIgnored {}`,
      'node_modules/pkg/index.ts': `export class AlsoIgnored {}`,
    });
    const tempIndex = buildRepoIndex(root);
    expect([...tempIndex.classes.keys()]).toEqual(['AController']);
    rmSync(root, { recursive: true, force: true });
  });

  it('crée un serveur MCP à partir d un index injecté en mémoire', () => {
    expect(createServer(index)).toBeDefined();
  });
});
