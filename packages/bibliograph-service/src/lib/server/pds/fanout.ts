/**
 * Bounded-concurrency map for fan-outs that talk to a repo (PDS) or a provider.
 *
 * Every listing read that falls back to Constellation or to a PDS fetches one
 * record per backlink. Written as `for (const x of items) { … await fetch(x) }`
 * that is one network round trip after another inside a single request: a
 * 50-record page cost 50 serial RTTs, and a slow upstream held the response for
 * the sum of its timeouts instead of a couple of waves. The same loop is
 * hand-rolled in the worker (`jobs/handlers.ts`) and in a backfill script.
 *
 * `limit` is the number of promises in flight, not the number of results:
 * results keep the input order, so callers can slice afterwards exactly as they
 * did with the sequential loop.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const out = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
