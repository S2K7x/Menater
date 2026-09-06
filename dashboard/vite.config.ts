import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * L'API tourne sur un port separe (`npm run serve`). Le proxy evite CORS en
 * developpement et laisse le client utiliser des chemins relatifs : la meme
 * build fonctionne ensuite derriere un reverse-proxy.
 */
const API_PORT = process.env.MENATER_API_PORT ?? process.env.SOC_API_PORT ?? '4400';

export default defineConfig({
  server: {
    port: 5174,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
  plugins: [react()],
});
