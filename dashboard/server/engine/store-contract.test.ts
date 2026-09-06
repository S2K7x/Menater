/**
 * Contrat du magasin d'exécutions — la MÊME suite pour les deux implémentations.
 *
 * ============================================================================
 * POURQUOI CE FICHIER EXISTE
 *
 * Le moteur ne connaît que l'interface `RunStore`. Deux implémentations la
 * remplissent : mémoire pour les tests, Postgres en production. Rien
 * n'empêche naturellement les deux de diverger — et une divergence ici ne se
 * verrait qu'en production, sur la reprise d'une exécution interrompue,
 * c'est-à-dire au pire moment possible.
 *
 * Les tests ci-dessous sont donc écrits UNE fois et exécutés contre chaque
 * implémentation. Ils ne vérifient pas du SQL : ils vérifient les promesses
 * dont dépend la garantie « au plus une fois ».
 *
 * ============================================================================
 * SANS POSTGRES, LA MOITIÉ EST SAUTÉE — ET LE DIT
 *
 * Les tests Postgres ne tournent que si `MENATER_TEST_PG` désigne une base.
 * Sinon ils sont marqués `skipped`, ce que vitest affiche. Un test silencieux
 * qui ne tourne jamais est pire qu'un test absent : il donne l'impression
 * d'une couverture qu'on n'a pas.
 *
 *     MENATER_TEST_PG=postgres://user:pass@localhost:5432/menater_test npm test
 * ============================================================================
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { MemoryRunStore, type RunStore } from './store.ts';
import { PgRunStore, createPool } from './pg-store.ts';
import type { RunRecord, StepRecord } from './types.ts';

const PG_URL = process.env.MENATER_TEST_PG;

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: `run-${Math.random().toString(36).slice(2, 10)}`,
  workflowId: '01-ingestion',
  workflowVersion: 1,
  status: 'running',
  alertId: 'A-1',
  input: { alert_id: 'A-1' },
  startedAt: new Date('2026-08-24T10:00:00Z').toISOString(),
  endedAt: null,
  error: null,
  ...over,
});

const step = (runId: string, over: Partial<StepRecord> = {}): StepRecord => ({
  runId,
  nodeId: 'validate',
  attempt: 1,
  status: 'running',
  output: null,
  port: null,
  error: null,
  startedAt: new Date('2026-08-24T10:00:00Z').toISOString(),
  endedAt: null,
  ...over,
});

/** La suite, écrite une fois. `make` rend un magasin vierge. */
function contract(name: string, make: () => Promise<RunStore>) {
  describe(`contrat — ${name}`, () => {
    let store: RunStore;
    beforeEach(async () => {
      store = await make();
    });

    it('relit une exécution telle qu’elle a été écrite', async () => {
      const r = run();
      await store.createRun(r);
      expect(await store.getRun(r.id)).toMatchObject({
        id: r.id, workflowId: r.workflowId, status: 'running', alertId: 'A-1',
      });
    });

    it('rend null pour une exécution inconnue — pas une erreur', async () => {
      expect(await store.getRun('jamais-vue')).toBeNull();
    });

    it('pose une date de fin sur une exécution terminée, et seulement là', async () => {
      // Une exécution « terminée » sans date de fin fausse toutes les mesures
      // de durée, sans jamais lever.
      const r = run();
      await store.createRun(r);
      await store.setRunStatus(r.id, 'waiting');
      expect((await store.getRun(r.id))?.endedAt).toBeNull();
      await store.setRunStatus(r.id, 'done');
      expect((await store.getRun(r.id))?.endedAt).not.toBeNull();
    });

    it('REFUSE une exécution terminée sans date de fin', async () => {
      // Postgres le fait respecter par contrainte ; le magasin mémoire
      // l'acceptait. Divergence trouvée par ce test contre une VRAIE base.
      // Une exécution « terminée » sans date fausse toutes les mesures de
      // durée, et ne lève jamais.
      await expect(store.createRun(run({ status: 'done', endedAt: null })))
        .rejects.toThrow();
    });

    it('accepte une exécution terminée AVEC sa date de fin', async () => {
      const r = run({ status: 'done', endedAt: new Date('2026-08-24T10:05:00Z').toISOString() });
      await store.createRun(r);
      expect((await store.getRun(r.id))?.endedAt).not.toBeNull();
    });

    it('ne rend inachevées que les exécutions qui le sont', async () => {
      const a = run({ status: 'running' });
      const b = run({ status: 'waiting' });
      const c = run({ status: 'done', endedAt: new Date('2026-08-24T10:05:00Z').toISOString() });
      for (const r of [a, b, c]) await store.createRun(r);

      const ids = (await store.unfinishedRuns()).map((r) => r.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(c.id);
    });

    it('rend l’étape DURABLE dès `beginStep`', async () => {
      // TOUTE LA GARANTIE « AU PLUS UNE FOIS » TIENT À CELA : après cet appel,
      // une interruption laisse forcément une trace d'un appel en cours.
      const r = run();
      await store.createRun(r);
      await store.beginStep(step(r.id, { nodeId: 'slack' }));

      const found = (await store.stepsOf(r.id)).find((s) => s.nodeId === 'slack');
      expect(found?.status).toBe('running');
      expect(found?.endedAt).toBeNull();
    });

    it('conclut une étape et conserve sa sortie', async () => {
      const r = run();
      await store.createRun(r);
      await store.beginStep(step(r.id));
      await store.endStep(r.id, 'validate', 1, {
        status: 'ok', output: { validation_ok: true }, port: 'main',
      });

      const found = (await store.stepsOf(r.id))[0];
      expect(found).toMatchObject({ status: 'ok', port: 'main' });
      expect(found.output).toEqual({ validation_ok: true });
      expect(found.endedAt).not.toBeNull();
    });

    it('REFUSE de conclure une étape jamais commencée', async () => {
      // Conclure dans le vide écrirait une trace pour une étape qui n'a pas eu
      // lieu — exactement le genre de ligne verte qui masque une panne.
      const r = run();
      await store.createRun(r);
      await expect(store.endStep(r.id, 'inexistante', 1, { status: 'ok' }))
        .rejects.toThrow(/was never started/);
    });

    it('n’écrase pas une étape déjà commencée', async () => {
      // Une reprise peut retrouver une étape en cours. Écraser sa trace
      // effacerait ce qui permet de savoir qu'une écriture était en vol.
      const r = run();
      await store.createRun(r);
      await store.beginStep(step(r.id, { status: 'running' }));
      await store.beginStep(step(r.id, { status: 'pending' }));

      const all = await store.stepsOf(r.id);
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe('running');
    });

    it('sépare les passages d’un même nœud', async () => {
      const r = run();
      await store.createRun(r);
      await store.beginStep(step(r.id, { attempt: 1 }));
      await store.beginStep(step(r.id, { attempt: 2 }));
      expect(await store.stepsOf(r.id)).toHaveLength(2);
    });

    it('ne mélange pas les étapes de deux exécutions', async () => {
      const a = run();
      const b = run();
      await store.createRun(a);
      await store.createRun(b);
      await store.beginStep(step(a.id));
      expect(await store.stepsOf(b.id)).toEqual([]);
    });

    // --- Attentes ---------------------------------------------------------

    it('relit une attente par son jeton', async () => {
      const r = run();
      await store.createRun(r);
      await store.createWait({
        runId: r.id, nodeId: 'attente', token: 'jeton-1',
        deadline: new Date('2026-08-24T10:30:00Z').toISOString(),
        resumedAt: null, payload: null,
      });
      expect(await store.waitByToken('jeton-1')).toMatchObject({ runId: r.id, resumedAt: null });
    });

    it('NE TRANCHE QU’UNE FOIS la même attente', async () => {
      // Un double clic, un lien rouvert, un rejeu de requête : une seule prise
      // d'effet. Deux approbations sur la même demande, c'est une action
      // exécutée deux fois.
      const r = run();
      await store.createRun(r);
      await store.createWait({
        runId: r.id, nodeId: 'attente', token: 'jeton-2',
        deadline: new Date('2026-08-24T10:30:00Z').toISOString(),
        resumedAt: null, payload: null,
      });
      await store.resolveWait('jeton-2', { decision: 'approve' });
      await expect(store.resolveWait('jeton-2', { decision: 'reject' }))
        .rejects.toThrow(/already settled/);

      expect((await store.waitByToken('jeton-2'))?.payload).toEqual({ decision: 'approve' });
    });

    it('refuse un jeton inconnu', async () => {
      await expect(store.resolveWait('jamais-emis', {})).rejects.toThrow(/inconnu/);
    });

    it('ne rend échues que les attentes ouvertes et dépassées', async () => {
      const r = run();
      await store.createRun(r);
      const at = (t: string) => new Date(t).toISOString();
      await store.createWait({ runId: r.id, nodeId: 'a', token: 'passee', deadline: at('2026-08-24T09:00:00Z'), resumedAt: null, payload: null });
      await store.createWait({ runId: r.id, nodeId: 'b', token: 'future', deadline: at('2026-08-24T23:00:00Z'), resumedAt: null, payload: null });
      await store.createWait({ runId: r.id, nodeId: 'c', token: 'tranchee', deadline: at('2026-08-24T09:00:00Z'), resumedAt: null, payload: null });
      await store.resolveWait('tranchee', {});

      const tokens = (await store.expiredWaits(at('2026-08-24T10:00:00Z'))).map((w) => w.token);
      expect(tokens).toEqual(['passee']);
    });

    // --- Verrou -----------------------------------------------------------

    it('accorde le verrou une seule fois', async () => {
      // Deux moteurs qui reprennent la même exécution rejouent ses étapes.
      const r = run();
      await store.createRun(r);
      expect(await store.claimRun(r.id, 'console-a')).toBe(true);
      expect(await store.claimRun(r.id, 'console-b')).toBe(false);
    });

    it('est réentrant pour son propre détenteur', async () => {
      // `start` puis `drive` réclament le verrou successivement : le refuser
      // au même processus bloquerait l'exécution qu'il vient de créer.
      const r = run();
      await store.createRun(r);
      await store.claimRun(r.id, 'console-a');
      expect(await store.claimRun(r.id, 'console-a')).toBe(true);
    });

    it('libère, et seulement pour son détenteur', async () => {
      const r = run();
      await store.createRun(r);
      await store.claimRun(r.id, 'console-a');
      await store.releaseRun(r.id, 'console-b');
      expect(await store.claimRun(r.id, 'console-b')).toBe(false);
      await store.releaseRun(r.id, 'console-a');
      expect(await store.claimRun(r.id, 'console-b')).toBe(true);
    });
  });
}

contract('mémoire', async () => new MemoryRunStore());

if (PG_URL) {
  const url = new URL(PG_URL);
  const pool = createPool({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: url.searchParams.get('sslmode') === 'require',
  });

  afterAll(async () => {
    await pool.end();
  });

  contract('postgres', async () => {
    // Table rase entre deux tests : `soc_run` cascade vers les étapes et les
    // attentes.
    await pool.query('DELETE FROM soc_run');
    return new PgRunStore(pool);
  });
} else {
  describe.skip('contrat — postgres', () => {
    it('sauté : définir MENATER_TEST_PG pour l’exécuter', () => {});
  });
}
