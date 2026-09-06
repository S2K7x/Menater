/**
 * Test d'assemblage : le moteur et le catalogue, ensemble.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EXISTE EN PLUS DES AUTRES
 *
 * `engine.test.ts` teste la boucle avec des gestionnaires factices.
 * `nodes.test.ts` teste chaque nœud isolément. Les deux peuvent passer alors
 * que rien ne fonctionne : c'est le branchement entre eux qui porte les vraies
 * erreurs — un port mal nommé, un contexte mal transmis, une variable qui
 * n'arrive pas jusqu'au nœud.
 *
 * Ce test rejoue donc une chaîne d'approbation COMPLÈTE, avec le vrai moteur,
 * les vrais nœuds, et un réseau simulé. C'est le squelette du workflow
 * 04-Action-Routing, réduit à ce qui compte.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import { Engine } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import { TransformRegistry, pureHandlers } from './nodes/pure.ts';
import { ioHandlers } from './nodes/io.ts';
import { controlHandlers } from './nodes/control.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Le squelette de 04-Action-Routing :
 *
 *   déclencheur → décision réversible ? → (oui) attente humaine
 *                                              ├── approuvé  → applique
 *                                              └── expiré    → escalade
 *                                       → (non) refus catégorique
 */
function approvalWorkflow(): WorkflowDef {
  return {
    id: '04-action-routing',
    name: 'Action & Routing',
    version: 1,
    nodes: [
      { id: 'in', type: 'trigger.subflow', label: 'Reçu de 03', params: {}, position: { x: 0, y: 0 } },
      {
        id: 'catalogue',
        type: 'transform',
        label: 'Action au catalogue ?',
        params: { fn: 'verifierCatalogue' },
        position: { x: 1, y: 0 },
      },
      {
        id: 'autorisee',
        type: 'if',
        label: 'Action autorisée ?',
        params: { condition: { left: { kind: 'input', path: 'allowed' }, op: 'isTrue' } },
        position: { x: 2, y: 0 },
      },
      {
        id: 'demande',
        type: 'notify',
        label: 'Demande d’approbation',
        params: {
          channel: { kind: 'var', key: 'slack.approvalChannel' },
          text: { kind: 'input', path: 'action' },
        },
        position: { x: 3, y: 0 },
      },
      {
        id: 'attente',
        type: 'wait',
        label: 'Attente humaine',
        params: { timeoutMinutes: { kind: 'var', key: 'approval.timeoutMinutes' } },
        position: { x: 4, y: 0 },
      },
      {
        id: 'applique',
        type: 'http',
        label: 'Exécute l’action',
        params: { url: { kind: 'var', key: 'endpoint.isolation' }, method: 'POST' },
        position: { x: 5, y: 0 },
      },
      {
        id: 'escalade',
        type: 'notify',
        label: 'Escalade sur expiration',
        params: {
          channel: { kind: 'var', key: 'slack.escalationChannel' },
          text: { kind: 'const', value: 'Approval expired' },
        },
        position: { x: 5, y: 1 },
      },
      {
        id: 'refus',
        type: 'respond',
        label: 'Action hors catalogue',
        params: { status: 422 },
        position: { x: 3, y: 2 },
      },
    ],
    edges: [
      { from: 'in', fromPort: 'main', to: 'catalogue' },
      { from: 'catalogue', fromPort: 'main', to: 'autorisee' },
      { from: 'autorisee', fromPort: 'true', to: 'demande' },
      { from: 'autorisee', fromPort: 'false', to: 'refus' },
      { from: 'demande', fromPort: 'main', to: 'attente' },
      // LES DEUX PORTS SONT DISTINCTS : `main` mène à l'action, `timeout` à
      // l'escalade. C'est le câblage qui empêche le silence de valoir accord.
      { from: 'attente', fromPort: 'main', to: 'applique' },
      { from: 'attente', fromPort: 'timeout', to: 'escalade' },
    ],
  };
}

/** Le catalogue fermé d'actions, tel que 04 le porte aujourd'hui. */
const CATALOGUE = ['isolate_host_temporary', 'ticket', 'escalate', 'auto_close'];

function assemble(over: { fetch?: typeof fetch; clock?: () => Date } = {}) {
  const store = new MemoryRunStore();
  const vars = new Map<string, unknown>([
    ['slack.approvalChannel', '#soc-approvals'],
    ['slack.escalationChannel', '#soc-escalation'],
    ['approval.timeoutMinutes', 30],
    ['endpoint.isolation', 'https://edr.test/isolate'],
  ]);
  const transforms = new TransformRegistry().register('verifierCatalogue', (input) => {
    const action = (input as { action?: string }).action;
    return { ...(input as object), allowed: CATALOGUE.includes(action ?? '') };
  });

  let clock = over.clock ?? (() => new Date('2026-08-24T10:00:00Z'));
  const deps = {
    transforms,
    vars: () => vars,
    now: () => clock(),
    secret: (name: string) => (name === 'slack.botToken' ? 'xoxb-test' : undefined),
    fetch: over.fetch ?? (async () => new Response('{"ok":true,"ts":"1"}', { status: 200 })),
    newToken: () => 'jeton-fixe',
  };

  const engine = new Engine({
    store,
    handlers: { ...pureHandlers(deps), ...ioHandlers(deps), ...controlHandlers(deps) },
    now: () => clock(),
    newId: () => 'run-1',
  });
  engine.register(approvalWorkflow());
  return { engine, store, vars, setClock: (d: Date) => { clock = () => d; } };
}

describe('chaîne d’approbation complète', () => {
  it('s’arrête sur l’attente, après avoir posté la demande', async () => {
    const calls: string[] = [];
    const { engine, store } = assemble({
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response('{"ok":true,"ts":"1"}', { status: 200 });
      }) as never,
    });

    const run = await engine.start('04-action-routing', { action: 'isolate_host_temporary' }, 'A-1');

    expect(run.status).toBe('waiting');
    expect(calls).toEqual(['https://slack.com/api/chat.postMessage']);
    // L'action N'A PAS été exécutée : rien n'est isolé tant qu'un humain n'a
    // pas tranché.
    expect(calls).not.toContain('https://edr.test/isolate');
    expect((await store.stepsOf(run.id)).map((s) => s.nodeId))
      .toEqual(['in', 'catalogue', 'autorisee', 'demande', 'attente']);
  });

  it('exécute l’action quand un humain approuve', async () => {
    const calls: string[] = [];
    const { engine } = assemble({
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response('{"ok":true,"ts":"1"}', { status: 200 });
      }) as never,
    });

    await engine.start('04-action-routing', { action: 'isolate_host_temporary' }, 'A-1');
    const run = await engine.resumeWait('jeton-fixe', { decision: 'approve', approver: 'shai' });

    expect(run?.status).toBe('done');
    expect(calls).toContain('https://edr.test/isolate');
  });

  it('LE SILENCE N’EST PAS UN ACCORD : à l’expiration, on escalade sans isoler', async () => {
    const calls: string[] = [];
    const { engine, setClock } = assemble({
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response('{"ok":true,"ts":"1"}', { status: 200 });
      }) as never,
    });

    await engine.start('04-action-routing', { action: 'isolate_host_temporary' }, 'A-1');
    setClock(new Date('2026-08-24T10:31:00Z')); // 31 min : au-delà des 30
    await engine.sweepExpiredWaits();

    expect(calls).not.toContain('https://edr.test/isolate');
    // Deux messages Slack : la demande, puis l'escalade.
    expect(calls.filter((c) => c.includes('slack'))).toHaveLength(2);
  });

  it('refuse une action hors catalogue sans jamais demander d’approbation', async () => {
    const calls: string[] = [];
    const { engine, store } = assemble({
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response('{"ok":true}', { status: 200 });
      }) as never,
    });

    // Le catalogue est FERMÉ : rien d'autre n'est implémentable, même derrière
    // une approbation. La branche s'arrête avant même de poser la question.
    const run = await engine.start('04-action-routing', { action: 'wipe_disk' }, 'A-2');
    expect(run.status).toBe('done');
    expect(calls).toEqual([]);
    expect((await store.stepsOf(run.id)).map((s) => s.nodeId))
      .toEqual(['in', 'catalogue', 'autorisee', 'refus']);
  });

  it('une variable modifiée prend effet à la prochaine exécution, sans redémarrage', async () => {
    const channels: unknown[] = [];
    const { engine, vars } = assemble({
      fetch: (async (_url: string, init?: RequestInit) => {
        channels.push(JSON.parse(String(init?.body)).channel);
        return new Response('{"ok":true,"ts":"1"}', { status: 200 });
      }) as never,
    });

    await engine.start('04-action-routing', { action: 'ticket' }, 'A-1');
    // C'est le besoin exprimé : changer un canal ou un seuil dans l'interface,
    // et que ça s'applique. C'était un `docker-compose` et un redémarrage.
    vars.set('slack.approvalChannel', '#autre-canal');
    await engine.resumeWait('jeton-fixe', { decision: 'reject' });

    expect(channels[0]).toBe('#soc-approvals');
    expect(vars.get('slack.approvalChannel')).toBe('#autre-canal');
  });
});

describe('reprise, sur une vraie chaîne', () => {
  it('ne reposte PAS la demande d’approbation après un redémarrage', async () => {
    // Le scénario qui compte : le processus meurt juste après avoir posté sur
    // Slack, avant d'avoir enregistré le résultat. Reposter donnerait deux
    // boutons pour la même décision.
    const post = vi.fn(async () => new Response('{"ok":true,"ts":"1"}', { status: 200 }));
    const { engine, store } = assemble({ fetch: post as never });

    await store.createRun({
      id: 'run-x', workflowId: '04-action-routing', workflowVersion: 1, status: 'running',
      alertId: 'A-1', input: { action: 'ticket' }, startedAt: '2026-08-24T10:00:00Z',
      endedAt: null, error: null,
    });
    for (const [nodeId, output] of [['in', { action: 'ticket' }], ['catalogue', { action: 'ticket', allowed: true }], ['autorisee', { action: 'ticket', allowed: true }]] as const) {
      await store.beginStep({ runId: 'run-x', nodeId, attempt: 1, status: 'ok', output,
        port: nodeId === 'autorisee' ? 'true' : 'main', error: null, startedAt: '', endedAt: null });
    }
    // L'envoi Slack laissé `running` : mort en plein appel.
    await store.beginStep({ runId: 'run-x', nodeId: 'demande', attempt: 1, status: 'running',
      output: null, port: null, error: null, startedAt: '', endedAt: null });

    await engine.resume();

    expect(post).not.toHaveBeenCalled();
    const step = (await store.stepsOf('run-x')).find((s) => s.nodeId === 'demande');
    expect(step?.status).toBe('indeterminate');
    expect((await store.getRun('run-x'))?.status).toBe('failed');
  });
});
