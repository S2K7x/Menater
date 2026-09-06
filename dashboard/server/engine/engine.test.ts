/**
 * Tests du moteur d'exécution durable.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Un moteur durable ne casse jamais bruyamment. Il « marche » pendant des
 * mois, puis un redémarrage tombe au mauvais moment et une action se joue deux
 * fois. C'est précisément le genre de panne que ce projet documente sous n8n :
 * elle s'affiche en vert.
 *
 * Ces tests coupent donc le courant EXPRÈS, au pire moment, et vérifient ce
 * qui se passe ensuite. Sans eux, la promesse « au plus une fois » n'est
 * qu'un commentaire.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import { Engine, assertAcyclic, type NodeHandler } from './engine.ts';
import { MemoryRunStore } from './store.ts';
import type { NodeDef, NodeType, WorkflowDef } from './types.ts';

let seq = 0;
const node = (id: string, type: NodeType, params: Record<string, unknown> = {}): NodeDef => ({
  id,
  type,
  label: `étiquette librement modifiable de ${id}`,
  params,
  position: { x: 0, y: 0 },
});

const edge = (from: string, to: string, fromPort = 'main') => ({ from, fromPort, to });

function workflow(nodes: NodeDef[], edges: ReturnType<typeof edge>[]): WorkflowDef {
  return { id: 'wf', name: 'test', version: 1, nodes, edges };
}

function engineWith(
  wf: WorkflowDef,
  handlers: Partial<Record<string, NodeHandler>>,
  store = new MemoryRunStore(),
) {
  seq = 0;
  const engine = new Engine({ store, handlers, newId: () => `run-${++seq}` });
  engine.register(wf);
  return { engine, store };
}

const pass: NodeHandler = async (ctx) => ({ output: ctx.input });

describe('parcours du graphe', () => {
  it('exécute les nœuds dans l’ordre des liens', async () => {
    const order: string[] = [];
    const trace: NodeHandler = async (ctx) => {
      order.push(ctx.node.id);
      return { output: ctx.input };
    };
    const wf = workflow(
      [node('t', 'trigger.webhook'), node('a', 'transform'), node('b', 'set')],
      [edge('t', 'a'), edge('a', 'b')],
    );
    const { engine } = engineWith(wf, { 'trigger.webhook': trace, transform: trace, set: trace });

    const run = await engine.start('wf', { hello: 1 });
    expect(run.status).toBe('done');
    expect(order).toEqual(['t', 'a', 'b']);
  });

  it('ne prend QUE la branche dont le port a été emprunté', async () => {
    const seen: string[] = [];
    const wf = workflow(
      [node('t', 'trigger.webhook'), node('cond', 'if'), node('oui', 'set'), node('non', 'set')],
      [edge('t', 'cond'), edge('cond', 'oui', 'true'), edge('cond', 'non', 'false')],
    );
    const { engine } = engineWith(wf, {
      'trigger.webhook': pass,
      if: async () => ({ output: {}, port: 'true' }),
      set: async (ctx) => {
        seen.push(ctx.node.id);
        return { output: null };
      },
    });

    await engine.start('wf', {});
    // La branche non prise ne s'exécute pas, et n'a rien eu à « sauter » :
    // aucun lien actif n'y menait.
    expect(seen).toEqual(['oui']);
  });

  it('s’arrête proprement quand aucune branche ne correspond', async () => {
    // C'était le piège n8n du Switch sans sortie de repli : zéro item sur
    // toutes les sorties, et le flux s'arrêtait EN AFFICHANT `success`.
    const wf = workflow(
      [node('t', 'trigger.webhook'), node('sw', 'switch'), node('a', 'set')],
      [edge('t', 'sw'), edge('sw', 'a', 'cas-a')],
    );
    const { engine, store } = engineWith(wf, {
      'trigger.webhook': pass,
      switch: async () => ({ output: {}, port: 'cas-inexistant' }),
      set: pass,
    });

    const run = await engine.start('wf', {});
    const steps = await store.stepsOf(run.id);
    // Le journal MONTRE où ça s'est arrêté : le switch a abouti sur un port
    // que personne n'écoute, et `a` n'a jamais commencé.
    expect(steps.map((s) => s.nodeId)).toEqual(['t', 'sw']);
    expect(steps.find((s) => s.nodeId === 'sw')?.port).toBe('cas-inexistant');
  });

  it('refuse un graphe cyclique à la publication', () => {
    const wf = workflow(
      [node('a', 'transform'), node('b', 'transform')],
      [edge('a', 'b'), edge('b', 'a')],
    );
    expect(() => assertAcyclic(wf)).toThrow(/Cycle/);
  });
});

describe('jonction : attendre TOUTES les branches', () => {
  it('n’exécute une jonction qu’une fois ses trois amonts connus', async () => {
    // LE DÉFAUT QUE LES DÉFINITIONS DE 02 ONT DÉMASQUÉ. Le nœud d'assemblage
    // reçoit trois sources d'enrichissement ; démarrer dès qu'une seule a
    // répondu l'aurait fait travailler sur un tiers des données — sans erreur,
    // sans trace, avec un résultat plausible.
    const wf = workflow(
      [
        node('t', 'trigger.webhook'),
        node('a', 'http'), node('b', 'http'), node('c', 'http'),
        node('join', 'merge'),
      ],
      [
        edge('t', 'a'), edge('t', 'b'), edge('t', 'c'),
        edge('a', 'join'), edge('b', 'join'), edge('c', 'join'),
      ],
    );
    let joinSawSources = 0;
    const { engine } = engineWith(wf, {
      'trigger.webhook': pass,
      http: async (ctx) => ({ output: { from: ctx.node.id } }),
      merge: async (ctx) => {
        joinSawSources = ['a', 'b', 'c'].filter((id) => ctx.outputs.has(id)).length;
        return { output: null };
      },
    });

    await engine.start('wf', {});
    expect(joinSawSources).toBe(3);
  });

  it('n’attend pas une branche qui ne sera jamais prise', async () => {
    // Le pendant du test précédent : une jonction bloquée par une branche
    // morte ne s'exécuterait jamais, et l'exécution s'arrêterait en silence.
    const wf = workflow(
      [
        node('t', 'trigger.webhook'), node('cond', 'if'),
        node('pris', 'set'), node('jamais', 'set'), node('join', 'merge'),
      ],
      [
        edge('t', 'cond'),
        edge('cond', 'pris', 'true'), edge('cond', 'jamais', 'false'),
        edge('pris', 'join'), edge('jamais', 'join'),
      ],
    );
    const { engine, store } = engineWith(wf, {
      'trigger.webhook': pass,
      if: async () => ({ output: {}, port: 'true' }),
      set: pass,
      merge: async () => ({ output: 'joint' }),
    });

    const run = await engine.start('wf', {});
    expect(run.status).toBe('done');
    const steps = await store.stepsOf(run.id);
    expect(steps.map((s) => s.nodeId)).toContain('join');
    expect(steps.map((s) => s.nodeId)).not.toContain('jamais');
  });
});

describe('échec d’un nœud', () => {
  it('emprunte la branche d’erreur quand elle est câblée', async () => {
    const wf = workflow(
      [node('t', 'trigger.webhook'), node('call', 'http'), node('rattrape', 'set')],
      [edge('t', 'call'), edge('call', 'rattrape', 'error')],
    );
    const { engine, store } = engineWith(wf, {
      'trigger.webhook': pass,
      http: async () => {
        throw new Error('502 en amont');
      },
      set: pass,
    });

    const run = await engine.start('wf', {});
    expect(run.status).toBe('done');
    const steps = await store.stepsOf(run.id);
    expect(steps.find((s) => s.nodeId === 'call')?.status).toBe('failed');
    expect(steps.find((s) => s.nodeId === 'rattrape')?.status).toBe('ok');
  });

  it('arrête l’exécution — et JOURNALISE — sans branche d’erreur', async () => {
    const wf = workflow(
      [node('t', 'trigger.webhook'), node('call', 'http')],
      [edge('t', 'call')],
    );
    const { engine, store } = engineWith(wf, {
      'trigger.webhook': pass,
      http: async () => {
        throw new Error('502 en amont');
      },
    });

    const run = await engine.start('wf', {});
    expect(run.status).toBe('failed');
    // « Ne jamais throw une erreur silencieuse » : la cause est dans le journal.
    expect((await store.stepsOf(run.id)).find((s) => s.nodeId === 'call')?.error)
      .toContain('502');
  });

  it('refuse de démarrer sur un type sans gestionnaire, en le nommant', async () => {
    const wf = workflow([node('t', 'trigger.webhook'), node('x', 'llm')], [edge('t', 'x')]);
    const { engine } = engineWith(wf, { 'trigger.webhook': pass });
    const run = await engine.start('wf', {});
    expect(run.status).toBe('failed');
    expect(run.error).toContain('llm');
  });
});

describe('reprise après interruption', () => {
  it('REJOUE le journal au lieu de recalculer', async () => {
    let calls = 0;
    const wf = workflow(
      [node('t', 'trigger.webhook'), node('calc', 'transform'), node('fin', 'set')],
      [edge('t', 'calc'), edge('calc', 'fin')],
    );
    const store = new MemoryRunStore();
    const counted: NodeHandler = async (ctx) => {
      calls += 1;
      return { output: ctx.input };
    };

    // Premier passage : `fin` n'a pas de gestionnaire, l'exécution s'arrête.
    const first = engineWith(wf, { 'trigger.webhook': pass, transform: counted }, store);
    const run = await first.engine.start('wf', {});
    expect(run.status).toBe('failed');
    expect(calls).toBe(1);

    // On remet l'exécution en route avec le gestionnaire manquant.
    await store.setRunStatus(run.id, 'running');
    store.simulateCrash();
    const second = engineWith(wf, { 'trigger.webhook': pass, transform: counted, set: pass }, store);
    await second.engine.resume();

    // `calc` avait abouti : son résultat est relu, pas recalculé.
    expect(calls).toBe(1);
  });

  it('REJOUE une lecture interrompue — c’est sans conséquence', async () => {
    const wf = workflow([node('t', 'trigger.webhook'), node('lit', 'http')], [edge('t', 'lit')]);
    const store = new MemoryRunStore();
    const run = { id: 'run-x', workflowId: 'wf', workflowVersion: 1, status: 'running' as const,
      alertId: null, input: {}, startedAt: new Date().toISOString(), endedAt: null, error: null };
    await store.createRun(run);
    await store.beginStep({ runId: run.id, nodeId: 't', attempt: 1, status: 'ok', output: {},
      port: 'main', error: null, startedAt: '', endedAt: null });
    // Une lecture laissée `running` : le processus est mort pendant l'appel.
    await store.beginStep({ runId: run.id, nodeId: 'lit', attempt: 1, status: 'running',
      output: null, port: null, error: null, startedAt: '', endedAt: null });

    let reads = 0;
    const { engine } = engineWith(wf, {
      'trigger.webhook': pass,
      http: async () => {
        reads += 1;
        return { output: { ok: true } };
      },
    }, store);
    await engine.resume();

    // `http` est classé `read` : au pire on refait une requête sans effet.
    expect(reads).toBe(1);
    expect((await store.getRun(run.id))?.status).toBe('done');
  });

  it('NE REJOUE JAMAIS une écriture interrompue — elle devient « indéterminée »', async () => {
    // LE TEST LE PLUS IMPORTANT DU FICHIER.
    //
    // Le processus meurt pendant un nœud qui modifie le monde : un message
    // Slack d'approbation, un ticket, une isolation d'hôte. Le moteur ne peut
    // pas savoir si l'appel a abouti. Réessayer isolerait potentiellement une
    // machine deux fois ; supposer l'échec perdrait une trace d'audit.
    const wf = workflow([node('t', 'trigger.webhook'), node('poste', 'notify')], [edge('t', 'poste')]);
    const store = new MemoryRunStore();
    await store.createRun({ id: 'run-x', workflowId: 'wf', workflowVersion: 1, status: 'running',
      alertId: 'A-1', input: {}, startedAt: new Date().toISOString(), endedAt: null, error: null });
    await store.beginStep({ runId: 'run-x', nodeId: 't', attempt: 1, status: 'ok', output: {},
      port: 'main', error: null, startedAt: '', endedAt: null });
    await store.beginStep({ runId: 'run-x', nodeId: 'poste', attempt: 1, status: 'running',
      output: null, port: null, error: null, startedAt: '', endedAt: null });

    const posted = vi.fn(async () => ({ output: {} }));
    const { engine } = engineWith(wf, { 'trigger.webhook': pass, slack: posted }, store);
    await engine.resume();

    expect(posted).not.toHaveBeenCalled();
    const step = (await store.stepsOf('run-x')).find((s) => s.nodeId === 'poste');
    expect(step?.status).toBe('indeterminate');
    // L'exécution s'arrête : un humain doit trancher, ce n'est pas au moteur
    // de deviner.
    expect((await store.getRun('run-x'))?.status).toBe('failed');
    expect((await store.getRun('run-x'))?.error).toContain('does not replay');
  });

  it('ne reprend PAS une exécution en attente d’un humain', async () => {
    // Redémarrer le serveur n'est pas une décision d'approbation.
    const wf = workflow([node('t', 'trigger.webhook'), node('w', 'wait')], [edge('t', 'w')]);
    const store = new MemoryRunStore();
    await store.createRun({ id: 'run-x', workflowId: 'wf', workflowVersion: 1, status: 'waiting',
      alertId: 'A-1', input: {}, startedAt: new Date().toISOString(), endedAt: null, error: null });

    const { engine } = engineWith(wf, { 'trigger.webhook': pass, wait: pass }, store);
    expect(await engine.resume()).toEqual([]);
    expect((await store.getRun('run-x'))?.status).toBe('waiting');
  });

  it('ne reprend pas une exécution déjà prise par un autre processus', async () => {
    const wf = workflow([node('t', 'trigger.webhook')], []);
    const store = new MemoryRunStore();
    await store.createRun({ id: 'run-x', workflowId: 'wf', workflowVersion: 1, status: 'running',
      alertId: null, input: {}, startedAt: new Date().toISOString(), endedAt: null, error: null });
    await store.claimRun('run-x', 'un-autre-processus');

    const { engine } = engineWith(wf, { 'trigger.webhook': pass }, store);
    expect(await engine.resume()).toEqual([]);
  });
});

describe('attente d’une approbation humaine', () => {
  const approvalFlow = () =>
    workflow(
      [
        node('t', 'trigger.webhook'),
        node('attend', 'wait'),
        node('applique', 'http'),
        node('escalade', 'notify'),
      ],
      [
        edge('t', 'attend'),
        edge('attend', 'applique', 'main'),
        edge('attend', 'escalade', 'timeout'),
      ],
    );

  const waitHandler: NodeHandler = async () => ({
    output: null,
    suspend: { token: 'jeton-1', deadlineMs: 30 * 60_000 },
  });

  it('suspend l’exécution dans un état DISTINCT de « en cours »', async () => {
    const { engine, store } = engineWith(approvalFlow(), {
      'trigger.webhook': pass, wait: waitHandler, http: pass, slack: pass,
    });
    const run = await engine.start('wf', {});
    // `waiting` et non `running` : les 30 minutes d'approbation ne doivent
    // jamais être comptées comme une chaîne à l'arrêt.
    expect(run.status).toBe('waiting');
    expect((await store.waitByToken('jeton-1'))?.resumedAt).toBeNull();
  });

  it('reprend sur le port principal quand un humain tranche', async () => {
    const applied = vi.fn(async () => ({ output: { done: true } }));
    const escalated = vi.fn(async () => ({ output: {} }));
    const { engine } = engineWith(approvalFlow(), {
      'trigger.webhook': pass, wait: waitHandler, http: applied, notify: escalated,
    });

    await engine.start('wf', {});
    const run = await engine.resumeWait('jeton-1', { decision: 'approve', approver: 'shai' });

    expect(run?.status).toBe('done');
    expect(applied).toHaveBeenCalled();
    expect(escalated).not.toHaveBeenCalled();
  });

  it('LE SILENCE N’EST PAS UN ACCORD : l’expiration escalade, elle n’exécute pas', async () => {
    const applied = vi.fn(async () => ({ output: {} }));
    const escalated = vi.fn(async () => ({ output: {} }));

    let clock = new Date('2026-08-24T10:00:00Z');
    const store = new MemoryRunStore();
    const engine = new Engine({
      store,
      handlers: { 'trigger.webhook': pass, wait: waitHandler, http: applied, notify: escalated },
      now: () => clock,
      newId: () => 'run-1',
    });
    engine.register(approvalFlow());

    await engine.start('wf', {});
    clock = new Date('2026-08-24T10:31:00Z'); // 31 minutes plus tard
    await engine.sweepExpiredWaits();

    // L'action n'est PAS appliquée. La branche `timeout` mène à l'escalade.
    expect(applied).not.toHaveBeenCalled();
    expect(escalated).toHaveBeenCalled();
  });

  it('ne tranche pas deux fois la même attente', async () => {
    const applied = vi.fn(async () => ({ output: {} }));
    const { engine } = engineWith(approvalFlow(), {
      'trigger.webhook': pass, wait: waitHandler, http: applied, slack: pass,
    });
    await engine.start('wf', {});
    await engine.resumeWait('jeton-1', { decision: 'approve' });
    await engine.resumeWait('jeton-1', { decision: 'reject' });
    // Un double clic, un lien rouvert, un rejeu de requête : une seule prise
    // d'effet.
    expect(applied).toHaveBeenCalledTimes(1);
  });
});

describe('le nom d’un nœud n’est pas son contrat', () => {
  it('renommer l’étiquette ne casse rien', async () => {
    // Sous n8n, la console lisait des NOMS exacts : renommer
    // « Finalize Decision + shadow_mode » la rendait aveugle, sans erreur.
    const wf = workflow([node('t', 'trigger.webhook'), node('x', 'set')], [edge('t', 'x')]);
    wf.nodes[1].label = 'un nom complètement différent, avec des accents et des ✨';

    const { engine, store } = engineWith(wf, { 'trigger.webhook': pass, set: pass });
    const run = await engine.start('wf', {});
    expect(run.status).toBe('done');
    // Le journal référence l'identifiant, jamais l'étiquette.
    expect((await store.stepsOf(run.id)).map((s) => s.nodeId)).toEqual(['t', 'x']);
  });
});

describe('la version est figée à la création', () => {
  it('republier ne change pas une exécution en cours', async () => {
    const wf = workflow([node('t', 'trigger.webhook')], []);
    const { engine, store } = engineWith(wf, { 'trigger.webhook': pass });
    const run = await engine.start('wf', {});
    engine.register({ ...wf, version: 7 });
    expect((await store.getRun(run.id))?.workflowVersion).toBe(1);
  });
});
