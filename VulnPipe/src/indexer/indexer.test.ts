import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { indexFile, indexSource } from './indexer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '__fixtures__', 'order.controller.ts');

describe('Indexeur — fixture OrderController (cas de test imposé par PHASE_1_INDEXER.md)', () => {
  const index = indexFile(FIXTURE);
  const controller = index.controllers[0];

  it('trouve exactement un contrôleur, nommé OrderController', () => {
    expect(index.controllers).toHaveLength(1);
    expect(controller.controller).toBe('OrderController');
    expect(controller.base_path).toBe('/orders');
  });

  it('extrait la symbol table (propriété -> classe injectée) depuis le constructeur', () => {
    expect(controller.injection_map).toEqual({
      orderService: 'OrderService',
      logger: 'LoggerService',
    });
  });

  it('extrait les deux routes avec le préfixe du @Controller appliqué', () => {
    expect(controller.endpoints.map((e) => e.route)).toEqual(['/orders/:id', '/orders/public/:id']);
    expect(controller.endpoints.map((e) => e.http_method)).toEqual(['Get', 'Get']);
    expect(controller.endpoints.map((e) => e.handler)).toEqual(['getOrder', 'getPublicOrder']);
  });

  it('rattache @UseGuards au bon handler, et laisse l autre sans guard', () => {
    const [guarded, unguarded] = controller.endpoints;

    // Piège n°1 : les décorateurs sont des frères du method_definition, pas des enfants.
    expect(guarded.framework_metadata.decorators).toEqual([
      '@UseGuards(OwnershipGuard)',
      "@Get('/:id')",
    ]);
    expect(guarded.framework_metadata.guards).toEqual(['UseGuards']);
    expect(guarded.framework_metadata.is_unguarded).toBe(false);

    expect(unguarded.framework_metadata.decorators).toEqual(["@Get('/public/:id')"]);
    expect(unguarded.framework_metadata.guards).toEqual([]);
    expect(unguarded.framework_metadata.is_unguarded).toBe(true);
  });

  it("n'inclut pas les décorateurs de paramètre (@Param, @Req) dans les décorateurs de route", () => {
    for (const endpoint of controller.endpoints) {
      expect(endpoint.framework_metadata.decorators.join(' ')).not.toContain('@Param');
      expect(endpoint.framework_metadata.decorators.join(' ')).not.toContain('@Req');
    }
  });

  it('résout le call graph local avec le type injecté, dans l ordre du code source', () => {
    const [getOrder, getPublicOrder] = controller.endpoints;

    expect(getOrder.local_call_graph.map((c) => ({ call: c.call, injected_type: c.injected_type }))).toEqual([
      { call: 'log', injected_type: 'LoggerService' },
      { call: 'findById', injected_type: 'OrderService' },
    ]);
    expect(getOrder.local_call_graph.every((c) => c.resolution === 'constructor_injection')).toBe(true);

    expect(
      getPublicOrder.local_call_graph.map((c) => ({ call: c.call, injected_type: c.injected_type }))
    ).toEqual([{ call: 'findPublicById', injected_type: 'OrderService' }]);
  });

  it('construit la symbol table clé (classe, méthode) — pas le nom de méthode seul', () => {
    expect(controller.symbol_table.map((s) => s.key).sort()).toEqual([
      'LoggerService::log',
      'OrderService::findById',
      'OrderService::findPublicById',
    ]);
    const findById = controller.symbol_table.find((s) => s.key === 'OrderService::findById')!;
    expect(findById).toMatchObject({
      injected_type: 'OrderService',
      method: 'findById',
      called_from: ['getOrder'],
    });
  });

  it('capture un code_snapshot qui est le vrai texte source du handler', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    for (const endpoint of controller.endpoints) {
      expect(endpoint.code_snapshot.length).toBeGreaterThan(0);
      expect(source).toContain(endpoint.code_snapshot);
      expect(endpoint.code_snapshot).toContain(endpoint.handler);
    }
    expect(controller.endpoints[0].code_snapshot).toContain('this.orderService.findById(id)');
  });

  it('reporte des numéros de ligne 1-indexés cohérents avec le fichier', () => {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n');
    const getOrder = controller.endpoints[0];
    expect(lines[getOrder.source.start_line - 1]).toContain('async getOrder');
    const findByIdCall = getOrder.local_call_graph.find((c) => c.call === 'findById')!;
    expect(lines[findByIdCall.line - 1]).toContain('findById');
  });

  it('ne signale aucun warning : la fixture est entièrement résolue', () => {
    expect(controller.index_warnings).toEqual([]);
    expect(index.index_warnings).toEqual([]);
  });

  it('produit un JSON sérialisable conforme au contrat de la Phase 1', () => {
    const roundTripped = JSON.parse(JSON.stringify(index));
    expect(roundTripped.controllers[0]).toHaveProperty('controller');
    expect(roundTripped.controllers[0].endpoints[0]).toEqual(
      expect.objectContaining({
        route: expect.any(String),
        http_method: expect.any(String),
        handler: expect.any(String),
        framework_metadata: expect.objectContaining({ decorators: expect.any(Array) }),
        local_call_graph: expect.any(Array),
        code_snapshot: expect.any(String),
      })
    );
  });
});

describe('Indexeur — cas limites', () => {
  it('marque resolution="unresolved" quand la propriété n est pas injectée au constructeur', () => {
    const index = indexSource(`
      @Controller('carts')
      export class CartController {
        constructor(private cartService: CartService) {}

        @Get('/:id')
        async get(@Param('id') id: string) {
          this.mystery.doThing(id);
          return this.cartService.findById(id);
        }
      }
    `);
    const calls = index.controllers[0].endpoints[0].local_call_graph;
    expect(calls.find((c) => c.call === 'doThing')).toMatchObject({
      injected_type: null,
      receiver: 'mystery',
      resolution: 'unresolved',
    });
    expect(calls.find((c) => c.call === 'findById')).toMatchObject({
      injected_type: 'CartService',
      resolution: 'constructor_injection',
    });
    // Un appel non résolu doit être signalé : c'est ce qui déclenchera
    // reason="missing_context" côté node de détection (CLAUDE.md §3).
    expect(index.controllers[0].index_warnings.join(' ')).toContain('missing_context');
  });

  it('distingue un appel de méthode locale (this.x()) d un appel sur service injecté', () => {
    const index = indexSource(`
      @Controller('a')
      export class AController {
        constructor(private svc: SvcClass) {}

        @Get('/')
        async list() {
          this.assertAdmin();
          return this.svc.all();
        }

        private assertAdmin() {}
      }
    `);
    const calls = index.controllers[0].endpoints[0].local_call_graph;
    expect(calls).toEqual([
      expect.objectContaining({ call: 'assertAdmin', resolution: 'local_method', injected_type: null }),
      expect.objectContaining({ call: 'all', resolution: 'constructor_injection', injected_type: 'SvcClass' }),
    ]);
    // assertAdmin n'a pas de décorateur HTTP : ce n'est pas une route.
    expect(index.controllers[0].endpoints).toHaveLength(1);
  });

  it('propage les guards déclarés au niveau du contrôleur sur toutes ses routes', () => {
    const index = indexSource(`
      @UseGuards(JwtGuard)
      @Controller('admin')
      export class AdminController {
        @Get('/users')
        async users() { return 1; }
      }
    `);
    const endpoint = index.controllers[0].endpoints[0];
    expect(endpoint.route).toBe('/admin/users');
    expect(endpoint.framework_metadata.guards).toEqual(['UseGuards']);
    expect(endpoint.framework_metadata.is_unguarded).toBe(false);
  });

  it('gère les verbes HTTP autres que Get et les routes sans argument de path', () => {
    const index = indexSource(`
      @Controller('items')
      export class ItemController {
        constructor(private svc: ItemService) {}

        @Post()
        async create() { return this.svc.create(); }

        @Delete(':id')
        async remove() { return this.svc.remove(); }
      }
    `);
    expect(index.controllers[0].endpoints.map((e) => [e.http_method, e.route])).toEqual([
      ['Post', '/items'],
      ['Delete', '/items/:id'],
    ]);
  });

  it('ignore une classe sans décorateur @Controller et le signale', () => {
    const index = indexSource(`export class PlainService { doThing() {} }`);
    expect(index.controllers).toHaveLength(0);
    expect(index.index_warnings.join(' ')).toContain('@Controller');
  });
});
