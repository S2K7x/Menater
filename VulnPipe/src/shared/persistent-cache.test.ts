/**
 * Tests de la persistance des caches.
 *
 * Deux familles, et la seconde compte plus que la première.
 *
 *  1. Ça marche : ce qui est écrit se relit, et l'ordre d'éviction survit.
 *  2. **Ça refuse de marcher quand il le faut.** Un fichier tronqué, d'une
 *     autre version, appartenant à l'autre cache, ou trop vieux, doit donner
 *     « aucune entrée reprise » — jamais un verdict à moitié lu servi comme
 *     s'il était sûr. Un cache qui se trompe coûte un faux négatif ; un cache
 *     qui abandonne coûte un appel.
 *
 * Chaque test écrit dans son propre dossier temporaire : la suite ne touche
 * jamais l'état du développeur (voir `vitest.config.ts`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BoundedLru } from './bounded-lru.ts';
import {
  CACHE_FORMAT_VERSION,
  DebouncedCacheWriter,
  MAX_FILE_BYTES,
  cacheDirectory,
  cachePath,
  deleteCacheFile,
  loadCache,
  saveCache,
} from './persistent-cache.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vulnpipe-cache-'));
  file = join(dir, 'cache-verdicts.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => ({ path: file, kind: 'verdicts' });

describe('Aller-retour disque', () => {
  it('relit ce qu il a écrit', () => {
    const source = new BoundedLru<string>(10);
    source.set('a', 'verdict-a');
    source.set('b', 'verdict-b');

    expect(saveCache(source, store()).written).toBe(2);

    const target = new BoundedLru<string>(10);
    const outcome = loadCache(target, store());

    expect(outcome).toMatchObject({ kept: 2, dropped: 0, why: null });
    expect(target.get('a')).toBe('verdict-a');
    expect(target.get('b')).toBe('verdict-b');
  });

  it("conserve l'ordre d'éviction plutôt que de le rebattre", () => {
    // `a` a été relu, donc c'est `b` qui doit sortir en premier après
    // rechargement. Sauvegarder à l'envers ferait jeter, au démarrage
    // suivant, exactement ce qui venait d'être le plus utile.
    const source = new BoundedLru<string>(10);
    source.set('a', 'A');
    source.set('b', 'B');
    source.get('a');
    saveCache(source, store());

    const target = new BoundedLru<string>(2);
    loadCache(target, store());
    target.set('c', 'C');

    expect(target.get('b')).toBeUndefined();
    expect(target.get('a')).toBe('A');
  });

  it('écrit en 0600 : un cache porte du code source analysé', () => {
    const source = new BoundedLru<string>(10);
    source.set('a', 'A');
    saveCache(source, store());

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('ne laisse aucun fichier temporaire derrière lui', () => {
    const source = new BoundedLru<string>(10);
    source.set('a', 'A');
    saveCache(source, store());

    const leftovers = readFileSync(file, 'utf8');
    expect(leftovers.length).toBeGreaterThan(0);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('respecte la borne d entrées du LRU qui recharge', () => {
    // Un fichier écrit par une version plus permissive ne doit pas faire
    // dépasser la borne d'aujourd'hui.
    const source = new BoundedLru<string>(10);
    for (const key of ['a', 'b', 'c', 'd', 'e']) source.set(key, key);
    saveCache(source, store());

    const target = new BoundedLru<string>(2);
    loadCache(target, store());
    expect(target.size).toBe(2);
  });
});

describe('Ce qui doit être refusé', () => {
  it('traite un fichier absent comme un démarrage normal, pas comme une anomalie', () => {
    const target = new BoundedLru<string>(10);
    // Signaler « erreur » au premier démarrage ferait chercher un problème
    // qui n'existe pas.
    expect(loadCache(target, store())).toEqual({ kept: 0, dropped: 0, why: null });
  });

  it('repart de zéro sur un fichier tronqué, et le dit', () => {
    writeFileSync(file, '{"version":1,"kind":"verdicts","entries":[{"key":"a"');
    const target = new BoundedLru<string>(10);
    const outcome = loadCache(target, store());

    expect(target.size).toBe(0);
    expect(outcome.why).toContain('not valid JSON');
  });

  it('ignore EN BLOC un fichier d une autre version du format', () => {
    // Lire des entrées d'une autre forme, c'est resservir des verdicts mal
    // formés sur du code qu'on croit avoir vérifié.
    writeFileSync(
      file,
      JSON.stringify({
        version: CACHE_FORMAT_VERSION + 1,
        kind: 'verdicts',
        entries: [{ key: 'a', value: 'A', at: Date.now() }],
      })
    );
    const target = new BoundedLru<string>(10);
    const outcome = loadCache(target, store());

    expect(target.size).toBe(0);
    expect(outcome.why).toContain('another format');
    expect(outcome.dropped).toBe(1);
  });

  it("refuse le fichier de l'autre cache", () => {
    const source = new BoundedLru<string>(10);
    source.set('a', 'A');
    saveCache(source, { path: file, kind: 'arbitration' });

    const target = new BoundedLru<string>(10);
    const outcome = loadCache(target, store());

    expect(target.size).toBe(0);
    expect(outcome.why).toContain('arbitration');
  });

  it('écarte les entrées mal formées sans jeter les bonnes', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: CACHE_FORMAT_VERSION,
        kind: 'verdicts',
        entries: [
          { key: 'bon', value: 'V', at: Date.now() },
          { key: 42, value: 'V', at: Date.now() },
          { key: 'sans-date', value: 'V' },
          null,
        ],
      })
    );
    const target = new BoundedLru<string>(10);
    const outcome = loadCache(target, store());

    expect(outcome.kept).toBe(1);
    expect(outcome.dropped).toBe(3);
    expect(target.get('bon')).toBe('V');
  });

  it('écarte les entrées trop vieilles au chargement, pas à la première lecture', () => {
    // Sinon le cache annoncerait deux mille entrées dont la moitié
    // disparaîtrait au premier accès — un chiffre qu'on ne peut pas expliquer.
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    writeFileSync(
      file,
      JSON.stringify({
        version: CACHE_FORMAT_VERSION,
        kind: 'verdicts',
        entries: [
          { key: 'vieux', value: 'V', at: old },
          { key: 'frais', value: 'V', at: Date.now() },
        ],
      })
    );

    const target = new BoundedLru<string>(10, { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
    const outcome = loadCache(target, store());

    expect(outcome.kept).toBe(1);
    expect(outcome.dropped).toBe(1);
    expect(target.size).toBe(1);
    expect(target.get('vieux')).toBeUndefined();
  });

  it('ne fait pas échouer un scan réussi quand le disque refuse', () => {
    const source = new BoundedLru<string>(10);
    source.set('a', 'A');
    // Chemin non écrivable : `saveCache` doit renvoyer la raison, pas lever.
    const outcome = saveCache(source, { path: '/nonexistent-root/cache.json', kind: 'verdicts' });

    expect(outcome.written).toBe(0);
    expect(outcome.why).toBeTruthy();
  });
});

describe('Taille du fichier', () => {
  it('écrit ce qui tient et le DIT plutôt que de remplir le disque', () => {
    // Les bornes du LRU comptent des entrées ; ce sont des octets qui
    // remplissent un disque.
    const source = new BoundedLru<string>(5_000);
    const big = 'x'.repeat(20_000);
    for (let i = 0; i < 600; i++) source.set(`k${i}`, big);

    const outcome = saveCache(source, store());

    expect(outcome.truncated).toBeGreaterThan(0);
    expect(statSync(file).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    // Ce qui est gardé reste relisible : un fichier tronqué à la hache ne
    // vaudrait pas mieux que pas de fichier.
    const target = new BoundedLru<string>(5_000);
    expect(loadCache(target, store()).kept).toBe(outcome.written);
  });
});

describe('Écrivain différé', () => {
  it("n'écrit rien tant que rien n'a changé", () => {
    const lru = new BoundedLru<string>(10);
    const writer = new DebouncedCacheWriter(lru, store(), 5);
    expect(writer.flush()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('garantit une dernière écriture à la fermeture', () => {
    // C'est toute la différence entre « le cache survit » et « le cache
    // survit sauf au dernier scan » — celui qu'on vient justement de payer.
    const lru = new BoundedLru<string>(10);
    const writer = new DebouncedCacheWriter(lru, store(), 60_000);
    lru.set('a', 'A');
    writer.touch();

    expect(existsSync(file)).toBe(false);
    expect(writer.close()?.written).toBe(1);

    const target = new BoundedLru<string>(10);
    expect(loadCache(target, store()).kept).toBe(1);
  });

  it('regroupe plusieurs changements en une écriture', () => {
    const lru = new BoundedLru<string>(100);
    const writer = new DebouncedCacheWriter(lru, store(), 60_000);
    for (let i = 0; i < 40; i++) {
      lru.set(`k${i}`, 'V');
      writer.touch();
    }
    // Quarante routes, une seule écriture : le disque n'a rien à faire sur le
    // chemin critique d'un appel réseau.
    expect(existsSync(file)).toBe(false);
    expect(writer.close()?.written).toBe(40);
  });

  it('oublie tout, contenu ET fichier', () => {
    // Ajouter de la mémoire à un produit oblige à ajouter l'oubli : redémarrer
    // le service ne suffit plus.
    const lru = new BoundedLru<string>(10);
    const writer = new DebouncedCacheWriter(lru, store(), 60_000);
    lru.set('a', 'A');
    writer.touch();
    writer.close();
    expect(existsSync(file)).toBe(true);

    writer.forget();
    expect(existsSync(file)).toBe(false);
    expect(lru.size).toBe(0);
  });

  it("un oubli n'est pas défait par une écriture différée déjà armée", () => {
    // Le minuteur en vol au moment de l'oubli réécrirait ce qu'on vient
    // d'effacer : le bouton mentirait, et personne ne saurait pourquoi.
    const lru = new BoundedLru<string>(10);
    const writer = new DebouncedCacheWriter(lru, store(), 5);
    lru.set('a', 'A');
    writer.touch();
    writer.forget();

    expect(writer.flush()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('effacer un fichier absent n est pas une erreur', () => {
    expect(() => deleteCacheFile(store())).not.toThrow();
  });
});

describe('Emplacement du fichier', () => {
  it('suit le magasin de clés quand le déploiement l a déplacé', () => {
    // Deux dossiers d'état pour un même service seraient une occasion de n'en
    // sauvegarder qu'un. En Docker, `VULNPIPE_KEYSTORE=/data/.vulnpipe/keys.json`
    // suffit donc à ranger le cache dans le volume déjà monté.
    const env = { VULNPIPE_KEYSTORE: '/data/.vulnpipe/keys.json' } as NodeJS.ProcessEnv;
    expect(cacheDirectory(env)).toBe('/data/.vulnpipe');
    expect(cachePath('verdicts', env)).toBe('/data/.vulnpipe/cache-verdicts.json');
  });

  it('laisse le dossier être imposé explicitement', () => {
    const env = { VULNPIPE_CACHE_DIR: '/ailleurs' } as NodeJS.ProcessEnv;
    expect(cachePath('arbitration', env)).toBe('/ailleurs/cache-arbitration.json');
  });

  it('sépare les deux caches en deux fichiers', () => {
    const env = { VULNPIPE_CACHE_DIR: '/x' } as NodeJS.ProcessEnv;
    expect(cachePath('verdicts', env)).not.toBe(cachePath('arbitration', env));
  });
});
