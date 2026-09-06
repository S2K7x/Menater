/**
 * Tests de la persistance de l'état des runs.
 *
 * ============================================================================
 * CE QU'ILS VERROUILLENT
 *
 * Trois propriétés, et la première est la seule qui compte vraiment :
 *
 *  1. **Un run coupé est relu INTERROMPU, jamais « en cours ».** Le processus
 *     qui l'exécutait n'existe plus ; l'afficher comme actif serait une panne
 *     qui montre vert, exactement le défaut que ce produit traque.
 *  2. Une écriture coupée abîme la dernière ligne, jamais les précédentes.
 *  3. Rien ne grossit sans fin : ni la mémoire, ni le disque. C'était la fuite
 *     que ce store est venu refermer.
 *
 * Et une quatrième, qui n'est pas une propriété de confort : un identifiant de
 * run compose un chemin de fichier, donc il est validé.
 * ============================================================================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStore, SWEEP_EVERY_CREATES, isValidRunId, RUN_FORMAT_VERSION, type RunState } from './run-store.ts';
import type { StepEvent } from './step-events.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vulnpipe-runs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = (options: Record<string, unknown> = {}) =>
  new RunStore({ directory: dir, persist: true, ...options });

const blank = (runId: string): RunState => ({
  run_id: runId,
  status: 'queued',
  events: [],
  result: null,
  error: null,
  estimate: null,
});

const event = (seq: number): StepEvent => ({
  run_id: 'r',
  seq,
  step: 'detection',
  status: 'running',
  plain_language: `étape ${seq}`,
  at: new Date().toISOString(),
});

describe('Identifiant de run', () => {
  it('accepte ce que le serveur produit', () => {
    expect(isValidRunId('run-1757000000000-a1b2c3')).toBe(true);
    expect(isValidRunId('abc_DEF-123')).toBe(true);
  });

  it('refuse tout ce qui pourrait composer un chemin', () => {
    // Ce n'est pas une formalité : l'identifiant vient de l'URL et sert de
    // nom de fichier. Liste BLANCHE — une liste noire de motifs rate
    // toujours un encodage.
    for (const bad of ['../secret', '..%2Fsecret', 'a/b', 'a\\b', '/etc/passwd', '', ' ', 'a'.repeat(200), 'a.b']) {
      expect(isValidRunId(bad)).toBe(false);
    }
  });

  it('ne compose aucun fichier pour un identifiant refusé', () => {
    const s = store();
    expect(s.get('../secret')).toBeNull();
    // Et rien n'a été écrit hors du dossier.
    expect(existsSync(join(dir, '..', 'secret.jsonl'))).toBe(false);
  });
});

describe('Aller-retour disque', () => {
  it('relit un run terminé, événements et rapport compris', () => {
    const first = store();
    first.create(blank('run-a'));
    first.appendEvent('run-a', event(0));
    first.appendEvent('run-a', event(1));
    first.finish('run-a', { status: 'done', result: { run_id: 'run-a' } as never });
    first.flushAll();

    // Un autre store : c'est un redémarrage du service.
    const second = store();
    const state = second.get('run-a');

    expect(state?.status).toBe('done');
    expect(state?.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(state?.result).toEqual({ run_id: 'run-a' });
    expect(state?.started_at).toBeTruthy();
  });

  it('garde le devis accepté au lancement', () => {
    const first = store();
    first.create({ ...blank('run-a'), estimate: { routes_selected: 4 } as never });
    first.finish('run-a', { status: 'done' });

    expect(store().get('run-a')?.estimate).toEqual({ routes_selected: 4 });
  });

  it('conserve une erreur de scan', () => {
    const first = store();
    first.create(blank('run-a'));
    first.finish('run-a', { status: 'failed', error: 'le modèle a refusé' });

    const state = store().get('run-a');
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('le modèle a refusé');
  });

  it('ignore un journal écrit par une autre version du format', () => {
    writeFileSync(
      join(dir, 'run-vieux.jsonl'),
      `${JSON.stringify({ t: 'run', v: RUN_FORMAT_VERSION + 1, run_id: 'run-vieux', started_at: '', estimate: null })}\n`
    );
    expect(store().get('run-vieux')).toBeNull();
  });
});

describe('Le run interrompu', () => {
  it("un journal sans ligne finale est relu INTERROMPU, jamais « en cours »", () => {
    // C'est LE test de ce fichier. Le processus qui exécutait ce run n'existe
    // plus ; le montrer « en cours » ferait attendre un rapport qui
    // n'arrivera jamais.
    const first = store();
    first.create(blank('run-coupe'));
    first.appendEvent('run-coupe', event(0));
    first.flushAll();
    // Pas de `finish` : c'est exactement ce qu'un arrêt brutal laisse.

    const state = store().get('run-coupe');
    expect(state?.status).toBe('interrupted');
  });

  it('et il dit pourquoi, sans prétendre reprendre', () => {
    const first = store();
    first.create(blank('run-coupe'));
    first.flushAll();

    const state = store().get('run-coupe');
    expect(state?.error).toContain('interrupted');
    // Aucune promesse de reprise : la pipeline n'est pas jalonnée, il n'y a
    // pas d'état intermédiaire d'où repartir.
    expect(state?.error).toContain('Run it again');
  });

  it('la reprise au démarrage grave le fait et nomme les runs concernés', () => {
    const first = store();
    first.create(blank('run-coupe'));
    first.create(blank('run-fini'));
    first.finish('run-fini', { status: 'done' });
    first.flushAll();

    const second = store();
    expect(second.recoverInterrupted()).toEqual(['run-coupe']);

    // Gravé : une seconde reprise n'a plus rien à signaler.
    expect(store().recoverInterrupted()).toEqual([]);
    // Et le statut tient.
    expect(store().get('run-coupe')?.status).toBe('interrupted');
  });

  it('un run terminé n est jamais confondu avec un run coupé', () => {
    const first = store();
    first.create(blank('run-fini'));
    first.finish('run-fini', { status: 'done' });
    expect(store().recoverInterrupted()).toEqual([]);
    expect(store().get('run-fini')?.status).toBe('done');
  });
});

describe('Écriture coupée', () => {
  it('écarte la dernière ligne illisible et garde tout ce qui précède', () => {
    const first = store();
    first.create(blank('run-a'));
    first.appendEvent('run-a', event(0));
    first.flushAll();
    // Une écriture interrompue en plein milieu.
    writeFileSync(join(dir, 'run-a.jsonl'), readFileSync(join(dir, 'run-a.jsonl'), 'utf8') + '{"t":"even');

    const state = store().get('run-a');
    expect(state).not.toBeNull();
    expect(state?.events).toHaveLength(1);
  });

  it('un fichier de pur bruit ne fait pas tomber la lecture', () => {
    writeFileSync(join(dir, 'run-bruit.jsonl'), 'ceci n est pas du json\n{{{\n');
    expect(() => store().get('run-bruit')).not.toThrow();
    expect(store().get('run-bruit')).toBeNull();
  });

  it("un journal sans en-tête n'est pas un run", () => {
    // Sans en-tête on ne sait ni quand il a commencé ni sur quoi : le
    // présenter comme un run à moitié connu vaudrait moins que rien.
    writeFileSync(join(dir, 'run-sans-tete.jsonl'), `${JSON.stringify({ t: 'event', e: event(0) })}\n`);
    expect(store().get('run-sans-tete')).toBeNull();
  });
});

describe('Rien ne grossit sans fin', () => {
  it('la mémoire garde une fenêtre récente, pas tout l historique', () => {
    // C'ÉTAIT LA FUITE : la `Map` d'origine n'était jamais vidée, et chaque
    // run y laissait ses événements et son rapport complet, définitivement.
    const s = store({ maxInMemory: 3 });
    for (let i = 0; i < 20; i++) {
      s.create(blank(`run-${i}`));
      s.finish(`run-${i}`, { status: 'done' });
    }
    expect(s.liveCount).toBe(3);
  });

  it('un run sorti de la mémoire reste lisible sur le disque', () => {
    const s = store({ maxInMemory: 2 });
    for (let i = 0; i < 6; i++) {
      s.create(blank(`run-${i}`));
      s.appendEvent(`run-${i}`, event(0));
      s.finish(`run-${i}`, { status: 'done' });
    }
    // Borner la mémoire ne doit pas perdre le rapport : c'est le tout premier
    // qu'on vérifie, celui qui est sorti en premier.
    const state = s.get('run-0');
    expect(state?.status).toBe('done');
    expect(state?.events).toHaveLength(1);
  });

  it('le disque est purgé au-delà de la borne', () => {
    const s = store({ maxRuns: 5 });
    for (let i = 0; i < 20; i++) {
      s.create(blank(`run-${String(i).padStart(3, '0')}`));
      s.finish(`run-${String(i).padStart(3, '0')}`, { status: 'done' });
    }
    // La purge est espacée pour ne pas coûter deux cents appels système à
    // chaque lancement : le dépassement toléré vaut un intervalle, pas plus.
    expect(readdirSync(dir).filter((n) => n.endsWith('.jsonl')).length).toBeLessThanOrEqual(
      5 + SWEEP_EVERY_CREATES
    );
  });

  it("les événements d'un run évincé de la mémoire sont écrits avant qu'il parte", () => {
    // Sinon ils seraient perdus sans jamais atteindre le disque : le run
    // paraîtrait vide, ce qui est pire qu'absent.
    const s = store({ maxInMemory: 1 });
    s.create(blank('run-a'));
    s.appendEvent('run-a', event(0));
    s.create(blank('run-b')); // évince `run-a`

    expect(s.get('run-a')?.events).toHaveLength(1);
  });
});

describe('Liste', () => {
  it('rend les runs du plus récent au plus ancien', () => {
    const s = store();
    for (const [id, at] of [
      ['run-vieux', '2026-01-01T00:00:00.000Z'],
      ['run-recent', '2026-09-01T00:00:00.000Z'],
    ] as const) {
      s.create({ ...blank(id), started_at: at });
      s.finish(id, { status: 'done' });
    }
    expect(s.list(10).map((run) => run.run_id)).toEqual(['run-recent', 'run-vieux']);
  });

  it('résume sans charger les rapports complets', () => {
    const s = store();
    s.create(blank('run-a'));
    s.finish('run-a', { status: 'done' });
    const [summary] = s.list(10);
    // Un résumé, pas un rapport : lister deux cents runs ne doit pas en
    // charger deux cents.
    expect(Object.keys(summary!).sort()).toEqual(
      ['error', 'findings', 'run_id', 'started_at', 'status', 'target'].sort()
    );
  });
});

describe('Persistance éteinte', () => {
  it('garde tout en mémoire et n écrit rien', () => {
    const s = new RunStore({ directory: dir, persist: false });
    s.create(blank('run-a'));
    s.appendEvent('run-a', event(0));
    s.finish('run-a', { status: 'done' });

    expect(s.get('run-a')?.status).toBe('done');
    expect(existsSync(join(dir, 'run-a.jsonl'))).toBe(false);
    // Et rien à reprendre : il n'y a pas de disque à relire.
    expect(s.recoverInterrupted()).toEqual([]);
  });
});
