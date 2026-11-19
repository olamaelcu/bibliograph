/**
 * Push queued catalog changes into the external search index.
 *
 * Postgres owns the queue (`search_dirty`, written by the catalog triggers) and
 * the document itself (`search_documents_for`); this module only moves one
 * batch at a time: claim a version, rebuild the current document, post both
 * deletes and upserts in one request, then acknowledge exactly the versions it
 * applied. A failure before the ack leaves the rows queued, so a retry — or the
 * next cron tick — picks them up again, and posting a document twice is a
 * replace, not a duplicate.
 */

/** Changes one job may apply before it returns to the queue. */
export const SEARCH_INDEX_BATCH = 500;
/** Batches one job drains; a backlog keeps draining on the next tick. */
export const SEARCH_INDEX_BATCHES_PER_JOB = 20;
/** The index service is on loopback; waiting longer than this means it is down. */
const POST_TIMEOUT_MS = 30_000;

function clamp(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

export function searchIndexSize(payload) {
  return clamp(payload?.batchSize ?? SEARCH_INDEX_BATCH, 1, 2000);
}

export function searchIndexBatches(payload) {
  return clamp(payload?.maxBatches ?? SEARCH_INDEX_BATCHES_PER_JOB, 1, 100);
}

async function postBatch({ searchUrl, searchFetch, body, signal }) {
  const timeout = AbortSignal.timeout(POST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await searchFetch(`${searchUrl.replace(/\/+$/, '')}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: combined
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`search index POST /docs: HTTP ${response.status} ${detail}`);
  }
  return response.json();
}

/**
 * Drain the queue until it is empty, the batch budget is spent, or the stop
 * signal fires. Returns what it applied; every batch is acked independently, so
 * a stop mid-way is safe.
 */
export async function drainSearchIndex({
  pool,
  searchUrl,
  searchFetch = fetch,
  batchSize = SEARCH_INDEX_BATCH,
  maxBatches = SEARCH_INDEX_BATCHES_PER_JOB,
  // Restrict the claim to these uris; production passes nothing and drains
  // everything.
  uris = null,
  logger = null,
  signal = null
}) {
  let applied = 0;
  let deletes = 0;
  let batches = 0;

  while (batches < maxBatches) {
    if (signal?.aborted) break;
    const claimed = await pool.query('SELECT * FROM claim_search_dirty($1, $2)', [batchSize, uris]);
    const rows = claimed.rows;
    if (rows.length === 0) break;
    batches += 1;

    const deleteUris = rows.filter((row) => row.op === 'delete').map((row) => row.uri);
    const upsertUris = rows.filter((row) => row.op === 'upsert').map((row) => row.uri);
    let upserts = [];
    if (upsertUris.length > 0) {
      // Rebuild from the current state, not from the row that queued the change:
      // several edits to one edition collapse into the last one.
      const current = await pool.query('SELECT * FROM search_documents_for($1::text[])', [
        upsertUris
      ]);
      upserts = current.rows;
    }

    await postBatch({ searchUrl, searchFetch, body: { upsert: upserts, delete: deleteUris }, signal });

    const acked = await pool.query('SELECT ack_search_dirty($1::text[], $2::text[]) AS acked', [
      rows.map((row) => row.uri),
      rows.map((row) => row.changed_at)
    ]);
    // A claim that cannot be acknowledged would be re-read forever; say so
    // instead of looping on the same rows.
    if (Number(acked.rows[0]?.acked ?? 0) === 0) {
      throw new Error('search index ack applied nothing; claimed versions did not match');
    }

    applied += rows.length;
    deletes += deleteUris.length;
    logger?.debug?.(
      `catalog.search.index: batch ${batches} applied ${rows.length} (${deleteUris.length} deletes)`
    );
  }

  return { applied, deletes, batches };
}
