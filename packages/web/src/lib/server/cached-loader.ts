/**
 * A read-through cache for one value that is expensive to recompute and cheap
 * to be slightly stale.
 *
 * Two properties matter for the callers here: a value that is still fresh is
 * returned without touching the source, and concurrent callers share one load
 * instead of starting their own (a page that renders once per request must not
 * multiply the source query when a burst arrives). Failures are never cached —
 * an outage recovers on the next call — and the clock is injectable so a test
 * can advance it instead of sleeping.
 *
 * With `staleWhileRevalidate` a caller never waits for a refresh: once a value
 * exists, the expired one is returned as-is and the reload happens in the
 * background. That is what keeps a page whose traffic is one request a minute
 * from paying the whole load on every single request.
 */
export type CachedLoader<T> = () => Promise<T>;

export function cachedLoader<T>(options: {
  /** How long a loaded value stays fresh. Zero disables reuse. */
  ttlMs: number;
  load: () => Promise<T>;
  /** Serve an expired value and refresh behind the caller instead of blocking. */
  staleWhileRevalidate?: boolean;
  /** Injectable clock, milliseconds; defaults to `Date.now`. */
  now?: () => number;
}): CachedLoader<T> {
  const now = options.now ?? Date.now;
  const swr = options.staleWhileRevalidate === true;
  let loadedAt: number | null = null;
  let value: T;
  let inFlight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    inFlight ??= options.load().then(
      (loaded) => {
        value = loaded;
        loadedAt = now();
        inFlight = null;
        return loaded;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      }
    );
    return inFlight;
  };

  return async function read(): Promise<T> {
    const hasValue = loadedAt !== null;
    if (hasValue && now() - (loadedAt as number) < options.ttlMs) return value;
    if (hasValue && swr) {
      // The caller gets the expired value; the refresh is not its problem, and
      // a failed refresh keeps the previous value for the next caller.
      void refresh().catch(() => {});
      return value;
    }
    return refresh();
  };
}
