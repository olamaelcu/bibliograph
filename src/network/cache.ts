interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const MAX_ENTRIES = 10_000;

const store = new Map<string, CacheEntry<unknown>>();

/** Get a cached value if present and not expired. Returns undefined on miss or expiry. */
export function cacheGet<T>(key: string, now: number = Date.now()): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/** Set a cached value with an explicit TTL in milliseconds. Evicts oldest entry when full. */
export function cacheSet<T>(key: string, value: T, ttlMs: number, now: number = Date.now()): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: now + ttlMs });
}

/** Clear the cache (for tests). */
export function cacheClear(): void {
  store.clear();
}