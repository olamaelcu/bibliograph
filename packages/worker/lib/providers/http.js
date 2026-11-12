const DAY = 24 * 60 * 60 * 1000;

/** Read-through cache over google_books_cache / isbndb_cache. */
export function createJsonCache(pool, table) {
  if (table !== 'google_books_cache' && table !== 'isbndb_cache') {
    throw new Error(`unsupported cache table ${table}`);
  }
  const requestColumn = table === 'isbndb_cache' ? 'request' : 'url';

  return {
    async get(key) {
      const result = await pool.query(
        `SELECT body FROM ${table} WHERE key = $1 AND expires_at > now() LIMIT 1`,
        [key]
      );
      return result.rows[0]?.body ?? undefined;
    },
    async put(key, request, body, ttlMs = 7 * DAY) {
      await pool.query(
        `INSERT INTO ${table} (key, ${requestColumn}, body, fetched_at, expires_at)
         VALUES ($1, $2, $3::jsonb, now(), now() + ($4::text || ' milliseconds')::interval)
         ON CONFLICT (key) DO UPDATE SET
           ${requestColumn} = EXCLUDED.${requestColumn},
           body = EXCLUDED.body,
           fetched_at = now(),
           expires_at = EXCLUDED.expires_at`,
        [key, request, JSON.stringify(body), ttlMs]
      );
    }
  };
}

/**
 * Fetch JSON while keeping the status visible to the caller.
 *
 * A 404 answers `{ status: 404, body: undefined }` instead of throwing because
 * "no such book/publisher" is a normal provider answer; every other non-2xx
 * status throws, with the status attached for callers that care.
 */
export async function fetchJsonResponse(fetchImpl, url, options = {}, timeoutMs = 15_000) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  });
  if (response.status === 404) return { status: 404, body: undefined };
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { status: response.status, body: await response.json() };
}

export async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 15_000) {
  const { status, body } = await fetchJsonResponse(fetchImpl, url, options, timeoutMs);
  return status === 404 ? undefined : body;
}

export async function fetchText(fetchImpl, url, options = {}, timeoutMs = 15_000) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { text: await response.text(), url: response.url || url };
}
