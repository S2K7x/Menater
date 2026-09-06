import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Plus de tests d'interface ici : ils ont suivi l'interface dans la console.
    include: ['src/**/*.test.ts'],
    // ---------------------------------------------------------------------
    // La suite ne touche JAMAIS l'état du développeur.
    //
    // Même origine que le piège déjà documenté côté console (« la suite de
    // tests lisait le config.json du développeur ») : depuis que les caches
    // de verdicts se rangent sur le disque, une suite qui les lit mesure une
    // calibration à travers un état caché, et passe ou échoue selon ce qui
    // traîne dans `.vulnpipe/` sur la machine. Elle en écrirait aussi, ce qui
    // pollue le dépôt.
    //
    // Deux verrous plutôt qu'un : le drapeau éteint la persistance, et le
    // dossier pointe ailleurs de toute façon — pour qu'un test qui
    // réactiverait la persistance sans y penser n'écrive quand même rien
    // dans le dossier réel.
    env: {
      VULNPIPE_CACHE_PERSIST: 'false',
      VULNPIPE_CACHE_DIR: '/nonexistent/vulnpipe-tests',
    },
  },
});
