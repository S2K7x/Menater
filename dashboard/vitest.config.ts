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
    },
  },
});
