import { createHash } from 'node:crypto';
import { catalogPool } from './db';
import type { Identifier } from './editions';

const RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 60 * 60 * 1000;

let readiness: { ok: boolean; checkedAt: number } | undefined;

/**
 * Hydration is optional: a deployment without the worker (or without its
 * support table) keeps serving the catalog and simply skips enqueueing.
 */
async function workerReady(): Promise<boolean> {
  if (readiness && (readiness.ok || Date.now() - readiness.checkedAt < 60_000)) {
    return readiness.ok;
  }
  try {
    const pool = catalogPool();
    const result = await pool.query(
      `SELECT to_regclass('graphile_worker.jobs') IS NOT NULL
          AND to_regclass('catalog_enqueue_marks') IS NOT NULL AS ok`
    );
    const ok = result.rows[0]?.ok === true;
    readiness = { ok, checkedAt: Date.now() };
    return ok;
  } catch (error) {
    // A missing DATABASE_URL or table must not take the XRPC surface down.
    console.warn('[xrpc] could not check catalog hydration availability', error);
    readiness = { ok: false, checkedAt: Date.now() };
    return false;
  }
}

function canonical(value: string): string {
  return value.trim().toLowerCase();
}

function searchKey(input: {
  q?: string;
  title?: string;
  author?: string;
  identifiers: Identifier[];
}): string {
  const identifiers = input.identifiers
    .map((identifier) => `${canonical(identifier.issuer)}:${identifier.value}`)
    .sort();
  const material = JSON.stringify({
    q: input.q ? canonical(input.q) : '',
    title: input.title ? canonical(input.title) : '',
    author: input.author ? canonical(input.author) : '',
    identifiers
  });
  return `search:${createHash('sha256').update(material).digest('hex')}`;
}

async function enqueue(
  key: string,
  task: 'catalog.resolve' | 'catalog.search' | 'catalog.isbn',
  payload: unknown,
  ttlMs: number
): Promise<boolean> {
  try {
    if (!(await workerReady())) return false;
    const pool = catalogPool();

    const claim = await pool.query(
      `INSERT INTO catalog_enqueue_marks (key, enqueued_at)
       VALUES ($1, now())
       ON CONFLICT (key) DO UPDATE SET enqueued_at = now()
       WHERE catalog_enqueue_marks.enqueued_at < now() - ($2::text || ' milliseconds')::interval
       RETURNING key`,
      [key, ttlMs]
    );
    if (claim.rowCount === 0) return false;

    try {
      await pool.query(
        `SELECT graphile_worker.add_job(
           identifier := $1::text,
           payload := $2::json,
           job_key := $3::text,
           max_attempts := 5
         )`,
        [task, JSON.stringify(payload), key]
      );
    } catch (error) {
      await pool.query('DELETE FROM catalog_enqueue_marks WHERE key = $1', [key]);
      throw error;
    }
    return true;
  } catch (error) {
    console.warn('[xrpc] could not enqueue catalog hydration', error);
    return false;
  }
}

export function enqueueResolveMiss(identifier: Identifier): Promise<boolean> {
  return enqueue(
    `resolve:${identifier.issuer}:${identifier.value}`,
    'catalog.resolve',
    { identifier },
    RESOLVE_TTL_MS
  );
}

export function enqueueSearchHydration(input: {
  q?: string;
  title?: string;
  author?: string;
  identifiers: Identifier[];
}): Promise<boolean> {
  return enqueue(searchKey(input), 'catalog.search', input, SEARCH_TTL_MS);
}

/**
 * Direct ISBNdb lookup for an ISBN seen in a search, even when the local
 * catalog already answered, so the edition is enriched from the provider.
 */
export function enqueueIsbnHydration(isbn13: string): Promise<boolean> {
  return enqueue(`isbn:${isbn13}`, 'catalog.isbn', { isbn: isbn13 }, RESOLVE_TTL_MS);
}

/**
 * Queue a genre fetch for an edition whose genres came back empty.
 *
 * The claim and the retry window live in the SQL function, not here: it inserts
 * or refreshes the ledger row and only then queues the job, so the edge and the
 * worker's sweep share one definition of "already asked recently". A database
 * without `0005-genres.sql` (or without `graphile_worker`) raises, which is
 * caught and logged exactly like an absent hydration schema: the read still
 * answered, so the caller must not fail.
 */
export async function enqueueGenreFetch(editionUri: string): Promise<boolean> {
  try {
    if (!(await workerReady())) return false;
    const pool = catalogPool();
    const result = await pool.query<{ enqueued: boolean }>(
      'SELECT catalog_enqueue_genre_fetch($1::text) AS enqueued',
      [editionUri]
    );
    return result.rows[0]?.enqueued === true;
  } catch (error) {
    console.warn('[xrpc] could not enqueue genre hydration', error);
    return false;
  }
}
