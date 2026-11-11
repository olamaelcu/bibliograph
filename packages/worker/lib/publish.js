/**
 * `pds-publish`: drain `public.pds_outbox` into the publisher PDS.
 *
 * Claiming is a short transaction (`FOR UPDATE SKIP LOCKED`) so several worker
 * processes can run the task without publishing a row twice. The PDS call
 * happens outside any transaction; completion is a second short transaction
 * guarded by the row's `updated_at`, so a catalog trigger that rewrites the row
 * while we are publishing is never swallowed — the new row stays queued.
 *
 * Retry policy:
 *
 * - a failed publish increments `attempts`, clears `claimed_at`, records
 *   `last_error`, and sets `next_at` to `now() + 60s * 2^attempts` (capped at
 *   one hour). The row stays visible in the table.
 * - `attempts < 10` is part of the claim predicate, matching the partial
 *   `pds_outbox_ready_idx`. After the tenth failure the row is parked: still
 *   visible for an operator, never claimed again. Requeue it by hand with
 *   `UPDATE pds_outbox SET attempts = 0, next_at = now(), last_error = NULL
 *   WHERE uri = '...'`.
 * - a claimed row whose worker disappears is reclaimed after the five-minute
 *   lease, without consuming an attempt.
 */

import {
  EditionRecordError,
  buildEditionRecord
} from './edition-record.js';
import {
  PublisherConfigError,
  createPdsPublisher,
  publisherConfigError,
  resolvePublisherConfig
} from './pds.js';

export const OUTBOX_COLLECTION = 'community.lexicon.media.book.edition';
export const MAX_ATTEMPTS = 10;
export const DEFAULT_BATCH = 25;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_BACKOFF_SECONDS = 60 * 60;
const MAX_ERROR_LENGTH = 2000;

function truncate(message) {
  return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH)}…`;
}

export function describeError(error) {
  const message = error?.message ?? String(error);
  if (!error?.name || error.name === 'Error') return message;
  return `${error.name}: ${message}`;
}

function isRecordNotFound(error) {
  return error?.code === 'RecordNotFound' || error?.status === 404;
}

/**
 * Claim up to `limit` ready rows. `updated_at` and `claimed_at` are returned as
 * the completion guards; claiming never changes `updated_at`, so a trigger that
 * runs afterwards is detectable.
 */
export async function claimBatch(
  pool,
  { limit = DEFAULT_BATCH, leaseMs = DEFAULT_LEASE_MS, publisherDid } = {}
) {
  const result = await pool.query(
    `WITH candidates AS (
       SELECT uri
         FROM pds_outbox
        WHERE collection = $1
          AND next_at <= now()
          AND attempts < $2
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))
          AND ($5::text IS NULL OR starts_with(uri, 'at://' || $5 || '/'))
        ORDER BY next_at, updated_at, uri
        LIMIT $4
        FOR UPDATE SKIP LOCKED
     )
     UPDATE pds_outbox o
        SET claimed_at = now()
       FROM candidates c
      WHERE o.uri = c.uri
      RETURNING o.uri, o.collection, o.rkey, o.op, o.attempts,
                o.claimed_at::text AS claimed_at, o.updated_at::text AS updated_at`,
    [
      OUTBOX_COLLECTION,
      MAX_ATTEMPTS,
      Math.max(1, Math.ceil(leaseMs / 1000)),
      limit,
      publisherDid ?? null
    ]
  );
  return result.rows;
}

async function loadSnapshot(pool, uri) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const edition = await client.query(
      `SELECT uri, rkey, title, subtitle, language, published_date, format, pages,
              duration_seconds, chapters, series, book_edition, description,
              cover_url, created_at
         FROM editions
        WHERE uri = $1`,
      [uri]
    );
    if (edition.rowCount === 0) {
      await client.query('COMMIT');
      return undefined;
    }
    const identifiers = await client.query(
      `SELECT issuer, value FROM edition_identifiers
        WHERE edition_uri = $1 ORDER BY issuer, value`,
      [uri]
    );
    const contributors = await client.query(
      `SELECT c.name, ec.role, c.identifiers, ec.ref
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE ec.edition_uri = $1
        ORDER BY ec.position`,
      [uri]
    );
    const publisher = await client.query(
      `SELECT p.name, p.identifiers
         FROM edition_publishers ep
         JOIN publishers p ON p.id = ep.publisher_id
        WHERE ep.edition_uri = $1
        ORDER BY ep.position
        LIMIT 1`,
      [uri]
    );
    const cid = await client.query('SELECT cid FROM pds_cids WHERE uri = $1', [uri]);
    await client.query('COMMIT');
    return {
      edition: edition.rows[0],
      identifiers: identifiers.rows,
      contributors: contributors.rows,
      publisher: publisher.rows[0],
      cid: cid.rows[0]?.cid
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function writeRecordValue(snapshot) {
  try {
    return buildEditionRecord(snapshot);
  } catch (error) {
    if (error instanceof EditionRecordError) throw error;
    throw new EditionRecordError(error?.message ?? String(error));
  }
}

/**
 * Publish one claimed row. Returns the atproto result (`{ uri, cid }` for
 * create/update; `{ uri }`, or nothing for an already-absent record, on delete).
 */
export async function publishEntry({ pds, publisherDid, pool, entry, logger = console }) {
  if (!entry.uri.startsWith(`at://${publisherDid}/`)) {
    throw new PublisherConfigError(
      `outbox row ${entry.uri} does not belong to the publisher repo ${publisherDid}; ` +
        'the catalog editions were created under another identity. Fix ATP_SERVICE_HOST/' +
        'ATP_SERVICE_DID or rewrite the edition URIs — publishing it would create a record ' +
        'at a different address than the catalog advertises'
    );
  }

  if (entry.op === 'delete') {
    try {
      const result = await pds.applyWrite({
        operation: 'delete',
        collection: entry.collection,
        rkey: entry.rkey
      });
      return { ...result, operation: 'delete' };
    } catch (error) {
      if (isRecordNotFound(error)) return { operation: 'delete', absent: true };
      throw error;
    }
  }

  const snapshot = await loadSnapshot(pool, entry.uri);
  if (!snapshot) {
    throw new EditionRecordError(
      `edition ${entry.uri} is gone from the catalog but the outbox row is not a delete; ` +
        'leaving it for a later retry'
    );
  }
  const value = writeRecordValue(snapshot);
  const operation = snapshot.cid ? 'update' : 'create';

  logger.info?.(
    `pds-publish: ${operation} ${entry.uri}` +
      (snapshot.cid ? ` (previous cid ${snapshot.cid})` : '')
  );

  try {
    const result = await pds.applyWrite({
      operation,
      collection: entry.collection,
      rkey: entry.rkey,
      value
    });
    return { ...result, operation, value };
  } catch (error) {
    // The two ops race with external state: a record created out-of-band looks
    // like AlreadyExists to create and a deleted one looks like RecordNotFound
    // to update. Retry once with the other operation; anything else propagates.
    if (operation === 'create' && error?.code === 'AlreadyExists') {
      const result = await pds.applyWrite({
        operation: 'update',
        collection: entry.collection,
        rkey: entry.rkey,
        value
      });
      return { ...result, operation: 'update', value };
    }
    if (operation === 'update' && isRecordNotFound(error)) {
      const result = await pds.applyWrite({
        operation: 'create',
        collection: entry.collection,
        rkey: entry.rkey,
        value
      });
      return { ...result, operation: 'create', value };
    }
    throw error;
  }
}

/** Delete the outbox row and record the CID, atomically. */
export async function completeEntry(pool, entry, result) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      'DELETE FROM pds_outbox WHERE uri = $1 AND updated_at = $2::timestamptz',
      [entry.uri, entry.updated_at]
    );

    if (entry.op === 'delete') {
      await client.query('DELETE FROM pds_cids WHERE uri = $1', [entry.uri]);
    } else if (typeof result?.cid === 'string' && result.cid !== '') {
      await client.query(
        `INSERT INTO pds_cids (uri, cid, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (uri) DO UPDATE SET cid = EXCLUDED.cid, updated_at = now()`,
        [entry.uri, result.cid]
      );
    }

    // The row changed while we held the claim. The trigger left the new state
    // queued; release only the claim we own so it is not postponed by the lease.
    if (deleted.rowCount === 0) {
      await client.query(
        'UPDATE pds_outbox SET claimed_at = NULL WHERE uri = $1 AND claimed_at = $2::timestamptz',
        [entry.uri, entry.claimed_at]
      );
    }

    await client.query('COMMIT');
    return deleted.rowCount > 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Record a failure with exponential backoff. Never overwrites a newer row. */
export async function failEntry(pool, entry, error) {
  const attempts = entry.attempts + 1;
  const backoffSeconds = Math.min(
    MAX_BACKOFF_SECONDS,
    60 * 2 ** Math.min(attempts, 10)
  );
  const client = await pool.connect();
  try {
    const updated = await client.query(
      `UPDATE pds_outbox
          SET attempts = attempts + 1,
              claimed_at = NULL,
              last_error = $3,
              next_at = now() + make_interval(secs => $4)
        WHERE uri = $1 AND updated_at = $2::timestamptz`,
      [entry.uri, entry.updated_at, truncate(describeError(error)), backoffSeconds]
    );
    if (updated.rowCount === 0) {
      // The row was rewritten under us; do not consume an attempt for the new
      // state, just release the claim.
      await client.query(
        'UPDATE pds_outbox SET claimed_at = NULL WHERE uri = $1 AND claimed_at = $2::timestamptz',
        [entry.uri, entry.claimed_at]
      );
    }
    return { attempts, retryInSeconds: backoffSeconds };
  } finally {
    client.release();
  }
}

/**
 * Build the publisher from configuration and expose `drain`, which the graphile
 * task calls. Construction fails fast (and loudly) on incomplete credentials.
 */
export function createOutboxPublisher({ pool, config, fetchImpl } = {}) {
  const resolved = config ?? resolvePublisherConfig();
  if (!resolved.configured) throw publisherConfigError(resolved);
  const pds = createPdsPublisher({ config: resolved, fetchImpl });

  async function drain({ limit = DEFAULT_BATCH, logger = console, maxBatches = 50 } = {}) {
    let published = 0;
    let failed = 0;
    let batches = 0;

    while (batches < maxBatches) {
      const entries = await claimBatch(pool, { limit, publisherDid: resolved.publisherDid });
      if (entries.length === 0) break;
      batches += 1;

      for (const entry of entries) {
        try {
          const result = await publishEntry({
            pds,
            publisherDid: resolved.publisherDid,
            pool,
            entry,
            logger
          });
          const completed = await completeEntry(pool, entry, result);
          published += 1;
          logger.info?.(
            `pds-publish: ${result.operation ?? entry.op} ${entry.uri} ` +
              `${result.cid ?? '(no cid)'}${completed ? '' : ' (superseded while publishing)'}`
          );
        } catch (error) {
          failed += 1;
          const retry = await failEntry(pool, entry, error);
          logger.error?.(
            `pds-publish: ${entry.uri} failed (attempt ${retry.attempts}/${MAX_ATTEMPTS}, ` +
              `retry in ${retry.retryInSeconds}s): ${describeError(error)}`
          );
        }
      }

      if (entries.length < limit) break;
    }

    return { published, failed, batches };
  }

  return { config: resolved, pds, drain };
}
