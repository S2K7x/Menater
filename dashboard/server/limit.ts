/**
 * `Promise.all` with a ceiling.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN FILE
 *
 * It was written once, inside `n8n.ts`, to fix a measured defect: a refresh
 * opened 120 heavy requests at once, each with its own 25 s timeout, and the
 * last ones in the queue expired before being served — a chain lost its steps
 * through SLOWNESS, not failure. Eight at a time fixed it.
 *
 * The pull transport needs exactly the same ceiling for exactly the same
 * reason, twice over: across sources, and across the alerts one poll delivers.
 * Copying it would have meant two implementations of a bound whose whole job
 * is to be the same everywhere.
 *
 * ORDER IS PRESERVED. Results come back in the order the inputs went in, which
 * is what lets a caller say "the first N succeeded" — the poller's cursor
 * depends on that being true, not on the order things happened to finish in.
 * ============================================================================
 */

/** Runs `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  // Never more workers than items: `Array.from({length: 8})` over two items
  // spawns six that immediately fall out of the loop, which is harmless and
  // still six promises to schedule.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}
