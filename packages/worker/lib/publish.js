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
  CONTRIBUTOR_COLLECTION,
  ENTITY_COLLECTIONS,
  EntityRecordError,
  buildEntityRecord
} from './entity-record.js';
import {
  PublisherConfigError,
  MAX_WRITES_PER_CALL,
  createPdsPublisher,
  publisherConfigError,
  resolvePublisherConfig
} from './pds.js';

export const EDITION_COLLECTION = 'community.lexicon.media.book.edition';

/** Every collection `pds-publish` drains. Add a builder before adding one here. */
export const OUTBOX_COLLECTIONS = Object.freeze([EDITION_COLLECTION, ...ENTITY_COLLECTIONS]);

export const MAX_ATTEMPTS = 10;
/** One claim, and therefore one `applyWrites` call: the PDS charges per call. */
export const DEFAULT_BATCH = MAX_WRITES_PER_CALL;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
/** Snapshots built in parallel; each is a short read transaction. */
export const PREPARE_CONCURRENCY = 8;
/** Write calls in flight at once. One call is ~230 ms of PDS work per 100 records. */
export const WRITE_CONCURRENCY = 4;
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
  {
    limit = DEFAULT_BATCH,
    leaseMs = DEFAULT_LEASE_MS,
    publisherDid,
    collections = OUTBOX_COLLECTIONS
  } = {}
) {
  const result = await pool.query(
    `WITH candidates AS (
       SELECT uri
         FROM pds_outbox
        WHERE collection = ANY($1::text[])
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
      collections,
      MAX_ATTEMPTS,
      Math.max(1, Math.ceil(leaseMs / 1000)),
      limit,
      publisherDid ?? null
    ]
  );
  return result.rows;
}

async function loadEditionSnapshot(pool, uri) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const edition = await client.query(
      `SELECT e.uri, e.rkey, e.title, e.subtitle, s.language, s.published_date,
              s.format, s.pages, s.duration_seconds, e.chapters, e.series,
              e.book_edition, s.description, e.cover_url, e.created_at,
              EXISTS (
                SELECT 1 FROM edition_cover_files f
                 WHERE f.edition_uri = e.uri AND f.source_url = e.cover_url
              ) AS cover_cached
         FROM editions e
         LEFT JOIN edition_identifier_shape s ON s.edition_uri = e.uri
        WHERE e.uri = $1`,
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
      `SELECT c.name, ec.role, c.identifiers, COALESCE(ec.ref, c.at_uri) AS ref
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE ec.edition_uri = $1
        ORDER BY ec.position`,
      [uri]
    );
    const publisher = await client.query(
      `SELECT p.name, p.identifiers, p.at_uri AS ref
         FROM edition_publishers_shape ps
         CROSS JOIN LATERAL unnest(ps.publisher_ids) WITH ORDINALITY AS ord(id, idx)
         JOIN publishers p ON p.id = ord.id
        WHERE ps.edition_uri = $1
        ORDER BY ord.idx
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

/**
 * One entity row, by the URI the outbox names. The table is chosen from the
 * collection constant, never from caller input.
 */
async function loadEntitySnapshot(pool, uri, collection) {
  const isContributor = collection === CONTRIBUTOR_COLLECTION;
  const table = isContributor ? 'contributors' : 'publishers';
  const columns = isContributor
    ? 'at_uri, name, name_inverted, description, image_url, born, died, identifiers, created_at'
    : 'at_uri, name, description, image_url, started, ended, identifiers, created_at';

  const [row, cid] = await Promise.all([
    pool.query(`SELECT ${columns} FROM ${table} WHERE at_uri = $1`, [uri]),
    pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [uri])
  ]);
  if (row.rowCount === 0) return undefined;
  return { collection, row: row.rows[0], cid: cid.rows[0]?.cid };
}

async function loadSnapshot(pool, uri, collection) {
  if (collection === EDITION_COLLECTION) return loadEditionSnapshot(pool, uri);
  return loadEntitySnapshot(pool, uri, collection);
}

function writeRecordValue(entry, snapshot, coversBaseUrl) {
  try {
    return entry.collection === EDITION_COLLECTION
      ? buildEditionRecord({ ...snapshot, coversBaseUrl })
      : buildEntityRecord(entry.collection, snapshot.row);
  } catch (error) {
    if (error instanceof EditionRecordError || error instanceof EntityRecordError) throw error;
    if (entry.collection === EDITION_COLLECTION) {
      throw new EditionRecordError(error?.message ?? String(error));
    }
    throw new EntityRecordError(error?.message ?? String(error));
  }
}

/**
 * Resolve one claimed row into the write it needs, without sending it:
 * `{ entry, operation, value? }`. A delete carries no value.
 *
 * This is the half of publishing that costs a catalog read; the write half is
 * batched, so a chunk of rows shares one PDS call.
 */
export async function prepareEntry({
  publisherDid,
  pool,
  entry,
  logger = console,
  coversBaseUrl = ''
}) {
  if (!OUTBOX_COLLECTIONS.includes(entry.collection)) {
    throw new Error(
      `outbox row ${entry.uri} names an unpublished collection ${entry.collection}; ` +
        'refusing to guess a record builder'
    );
  }
  if (!entry.uri.startsWith(`at://${publisherDid}/`)) {
    throw new PublisherConfigError(
      `outbox row ${entry.uri} does not belong to the publisher repo ${publisherDid}; ` +
        'the catalog rows were created under another identity. Fix ATP_SERVICE_HOST/' +
        'ATP_SERVICE_DID or rewrite the catalog URIs — publishing it would create a record ' +
        'at a different address than the catalog advertises'
    );
  }

  if (entry.op === 'delete') return { entry, operation: 'delete' };

  const snapshot = await loadSnapshot(pool, entry.uri, entry.collection);
  if (!snapshot) {
    const message =
      `${entry.uri} is gone from the catalog but the outbox row is not a delete; ` +
      'leaving it for a later retry';
    throw entry.collection === EDITION_COLLECTION
      ? new EditionRecordError(message)
      : new EntityRecordError(message);
  }
  const value = writeRecordValue(entry, snapshot, coversBaseUrl);
  const operation = snapshot.cid ? 'update' : 'create';

  return { entry, operation, value };
}

/**
 * Send one prepared write on its own, with the two race fallbacks: a record
 * created out-of-band looks like AlreadyExists to create and a deleted one
 * looks like RecordNotFound to update, so each is retried once as the other op.
 */
async function writePreparedOne(pds, prepared) {
  const { entry, operation, value } = prepared;
  const send = (op) => {
    const write = { operation: op, collection: entry.collection, rkey: entry.rkey };
    if (op !== 'delete') write.value = value;
    return pds.applyWrite(write);
  };

  try {
    return { ...(await send(operation)), operation, value };
  } catch (error) {
    if (operation === 'delete' && isRecordNotFound(error)) {
      return { operation: 'delete', absent: true };
    }
    if (operation === 'create' && error?.code === 'AlreadyExists') {
      return { ...(await send('update')), operation: 'update', value };
    }
    if (operation === 'update' && isRecordNotFound(error)) {
      return { ...(await send('create')), operation: 'create', value };
    }
    throw error;
  }
}

/** One `applyWrites` call for a prepared chunk; results stay in order. */
async function writePreparedChunk(pds, prepared) {
  const results = await pds.applyWrites({
    writes: prepared.map(({ entry, operation, value }) => ({
      operation,
      collection: entry.collection,
      rkey: entry.rkey,
      value
    }))
  });
  return prepared.map((one, index) => ({
    ...results[index],
    operation: one.operation,
    value: one.value
  }));
}

/**
 * Publish a chunk, isolating a bad record instead of failing its neighbours.
 *
 * `applyWrites` is atomic on the PDS, so a rejected chunk is split in half and
 * retried until one row is left; that row is then sent on its own, which is
 * also where the create/update race fallbacks apply.
 */
async function publishChunk({ pds, prepared, out }) {
  if (prepared.length === 1) {
    try {
      out.push({ prepared: prepared[0], result: await writePreparedOne(pds, prepared[0]) });
    } catch (error) {
      out.push({ prepared: prepared[0], error });
    }
    return;
  }
  try {
    const results = await writePreparedChunk(pds, prepared);
    prepared.forEach((one, index) => out.push({ prepared: one, result: results[index] }));
  } catch {
    const middle = Math.ceil(prepared.length / 2);
    await publishChunk({ pds, prepared: prepared.slice(0, middle), out });
    await publishChunk({ pds, prepared: prepared.slice(middle), out });
  }
}

/**
 * Publish one claimed row. Returns the atproto result (`{ uri, cid }` for
 * create/update; `{ uri }`, or nothing for an already-absent record, on delete).
 */
export async function publishEntry({
  pds,
  publisherDid,
  pool,
  entry,
  logger = console,
  coversBaseUrl = ''
}) {
  const prepared = await prepareEntry({ publisherDid, pool, entry, logger, coversBaseUrl });
  return writePreparedOne(pds, prepared);
}

/** Run `fn` over `items` with at most `size` in flight; results keep order. */
async function mapPool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(size, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let index = next; index < items.length; index = next) {
        next += 1;
        results[index] = await fn(items[index], index);
      }
    })
  );
  return results;
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
export function createOutboxPublisher({ pool, config, fetchImpl, coversBaseUrl = '' } = {}) {
  const resolved = config ?? resolvePublisherConfig();
  if (!resolved.configured) throw publisherConfigError(resolved);
  const pds = createPdsPublisher({ config: resolved, fetchImpl });

  /**
   * Publish one claim through three pools: snapshots are prepared
   * concurrently, the prepared rows are written a chunk at a time (one
   * `applyWrites` per chunk, several chunks in flight), then each row is
   * completed or backed off. A row that cannot be prepared never reaches a
   * chunk; a row the PDS rejects is isolated by `publishChunk`.
   */
  async function drain({
    limit = DEFAULT_BATCH,
    logger = console,
    maxBatches = 50,
    prepareConcurrency = PREPARE_CONCURRENCY,
    writeConcurrency = WRITE_CONCURRENCY,
    // Records per `applyWrites` call. 200 is the atproto cap and the cheapest
    // per record on the local PDS at this record size, but a host whose PDS
    // spends too long on one large transaction can lower it.
    chunkSize = MAX_WRITES_PER_CALL,
    // A graceful shutdown stops between claims: a batch is short work, and
    // finishing one means its rows are settled (published or backed off)
    // instead of being abandoned mid-flight.
    signal = null
  } = {}) {
    const chunk = Math.max(1, Math.min(chunkSize, MAX_WRITES_PER_CALL));
    let published = 0;
    let failed = 0;
    let batches = 0;
    let calls = 0;

    while (batches < maxBatches) {
      if (signal?.aborted === true) break;
      const entries = await claimBatch(pool, { limit, publisherDid: resolved.publisherDid });
      if (entries.length === 0) break;
      batches += 1;

      const prepared = [];
      const unbuildable = [];
      await mapPool(entries, prepareConcurrency, async (entry) => {
        try {
          prepared.push(
            await prepareEntry({
              publisherDid: resolved.publisherDid,
              pool,
              entry,
              logger,
              coversBaseUrl
            })
          );
        } catch (error) {
          unbuildable.push({ entry, error });
        }
      });

      const chunks = [];
      for (let index = 0; index < prepared.length; index += chunk) {
        chunks.push(prepared.slice(index, index + chunk));
      }
      const outcomes = [];
      await mapPool(chunks, writeConcurrency, (chunk) => publishChunk({ pds, prepared: chunk, out: outcomes }));
      calls += chunks.length;

      for (const { entry, error } of unbuildable) {
        failed += 1;
        const retry = await failEntry(pool, entry, error);
        logger.error?.(
          `pds-publish: ${entry.uri} failed (attempt ${retry.attempts}/${MAX_ATTEMPTS}, ` +
            `retry in ${retry.retryInSeconds}s): ${describeError(error)}`
        );
      }

      for (const outcome of outcomes) {
        const { entry } = outcome.prepared;
        if (outcome.error !== undefined) {
          failed += 1;
          const retry = await failEntry(pool, entry, outcome.error);
          logger.error?.(
            `pds-publish: ${entry.uri} failed (attempt ${retry.attempts}/${MAX_ATTEMPTS}, ` +
              `retry in ${retry.retryInSeconds}s): ${describeError(outcome.error)}`
          );
          continue;
        }
        const completed = await completeEntry(pool, entry, outcome.result);
        published += 1;
        logger.info?.(
          `pds-publish: ${outcome.result.operation ?? entry.op} ${entry.uri} ` +
            `${outcome.result.cid ?? '(no cid)'}` +
            `${completed ? '' : ' (superseded while publishing)'}`
        );
      }

      if (entries.length < limit) break;
    }

    return { published, failed, batches, calls };
  }

  return { config: resolved, pds, drain };
}
