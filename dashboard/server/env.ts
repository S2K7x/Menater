/**
 * Where this process listens, and where the built interface lives.
 *
 * Its own module so that a route can read the port without importing the
 * request handler that imports the route — the cycle that a shared constant
 * left in `app.ts` would create.
 */

// The MENATER_* variables are the current names; the older SOC_* ones stay
// accepted so a .env already in place at the time of the rename keeps working.
const env = (...names: string[]): string | undefined => {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
};

export const PORT = Number(env('MENATER_API_PORT', 'SOC_API_PORT') ?? 4400);

/**
 * Directory of the built interface. `null` in development.
 *
 * Configurable so the container image can put it wherever it likes, without
 * this file assuming a directory layout.
 */
export const UI_ROOT = env('MENATER_UI_ROOT') ?? new URL('../dist', import.meta.url).pathname;
