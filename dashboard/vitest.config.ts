import { defineConfig } from 'vitest/config';

/**
 * Les tests d'interface viennent de VulnPipe et suivent sa section dans la
 * console : les perdre a la fusion aurait supprime la seule couverture
 * automatique de l'application web.
 *
 * L'environnement DOM est declare fichier par fichier (`@vitest-environment
 * jsdom`) : `environmentMatchGlobs` n'existe plus en Vitest 4.
 *
 * `server/` est inclus depuis l'ajout de la tracabilite : la detection des
 * chaines rompues et des executions orphelines est de la logique pure, sur
 * des formes de reponse qu'on ne peut pas reproduire a la main a chaque
 * relecture. C'etait aussi la premiere couverture automatique du serveur.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    /**
     * THE SUITE MUST NOT READ THE DEVELOPER'S OWN CONFIGURATION.
     *
     * `getConfig()` falls back to `dashboard/config.json`, which on a machine
     * that has actually been used holds real coordinates and keys. Every test
     * that touched a snapshot then went and asked THAT instance for its
     * executions, and waited ten and a half seconds for the connection to time
     * out before falling back to the sample set.
     *
     * The symptom was tests that timed out on one machine and passed on
     * another, and a suite whose duration depended on whose laptop it ran on.
     * Pointing at a path that does not exist makes `getConfig()` return its
     * defaults — no API key, so demonstration mode, immediately — which is also
     * the state a fresh clone is in.
     */
    env: {
      MENATER_CONFIG: '/nonexistent/menater-test-config.json',
      MENATER_CREDENTIALS: '/nonexistent/menater-test-credentials.json',
      /**
       * SAME LOCK, THIRD FILE. The poller's cursors default to sitting beside
       * `config.json`, and the suite both READS and WRITES them — a run would
       * otherwise re-point a developer's real cursors at whatever a test made
       * up, and the next poll would skip or re-read a window for real. The
       * VulnPipe cache paid for this exact lesson.
       */
      MENATER_CURSORS: '/nonexistent/menater-test-cursors.json',
      /**
       * SAME LOCK, FOURTH SINK — AND THE ONE THE SUITE REALLY WRITES.
       *
       * The three above point at files that do not exist, which makes
       * `getConfig()` return its DEFAULTS. The defaults are a DATABASE:
       * `localhost:5432`, database `menater`, user `n8n_soc`, empty password —
       * which is precisely what `docker compose up` publishes. So pointing the
       * config away from the developer's file aimed the suite straight at the
       * developer's database instead.
       *
       * Measured against a real PostgreSQL 16 standing there with the schema
       * `docker/init-db.sh` applies: one `npm test` wrote 11 runs, 89 run
       * steps, 2 deduplication rows and 2 audit rows, and two tests failed —
       * one of them with a different status depending on which files had run
       * before it, because they were all sharing one database. The audit rows
       * CANNOT be taken back out (append-only: `TRUNCATE` refused by the
       * trigger, `DELETE` by the `REVOKE`), and `soc_ingested_alerts` has no
       * expiry, so a test's invented alert id refuses a real alert of that id
       * for ever.
       *
       * It is the NAME and deliberately not the host or the port: those six
       * variables WIN over the file by design (`applyEnvOverrides`), so a host
       * set here would override the coordinates a test chose, and five tests
       * choose `127.0.0.1:1` on purpose to provoke a connection refusal.
       * `server/suite-isolation.test.ts` claims all of that, including this
       * shape, because the absence of this line is otherwise SILENT: CI creates
       * `menater_test`, so deleting it leaves CI perfectly green.
       */
      MENATER_DB_NAME: 'menater-no-such-database-in-tests',
    },
  },
});
