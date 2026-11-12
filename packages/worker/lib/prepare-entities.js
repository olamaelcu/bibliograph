/**
 * `entities.prepare`: give existing contributor/publisher rows their record
 * addresses and queue the records.
 *
 * Minting is deliberately not part of the schema migration: the URI authority
 * is runtime configuration (`ATP_SERVICE_DID`), not database state, so only the
 * worker can build `at://<publisher>/<collection>/<tid>`. New rows mint at
 * ingest (`lib/ingest.js`); this task covers the rows that predate the feature.
 *
 * Two phases, both idempotent:
 *
 * - `mint` (default): mint a TID URI for every row whose `at_uri` is NULL, queue
 *   the new entity records, and queue the editions that credit those entities so
 *   their inline `ref` appears. A second run mints nothing.
 * - `editions`: queue every edition that credits an entity which already has a
 *   URI. Run it once after the entity records have been published, to republish
 *   editions that were published before the refs existed. Re-running it only
 *   rewrites the same pending rows.
 *
 * Nothing here publishes; `pds-publish` drains the rows.
 */

import { CONTRIBUTOR_COLLECTION, PUBLISHER_COLLECTION } from './entity-record.js';

const DEFAULT_BATCH = 500;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';

const TABLES = Object.freeze({
  [CONTRIBUTOR_COLLECTION]: {
    table: 'contributors',
    rowsKey: 'contributorsMinted'
  },
  [PUBLISHER_COLLECTION]: {
    table: 'publishers',
    rowsKey: 'publishersMinted'
  }
});

function assertAuthority(authority) {
  if (typeof authority !== 'string' || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(authority)) {
    throw new Error(
      `entities.prepare needs the publisher DID to mint record URIs; got ${JSON.stringify(authority)}`
    );
  }
}

/** Mint one batch of URIs. The table and collection are constants, not input. */
async function mintBatch(client, collection, authority, limit) {
  const { table } = TABLES[collection];
  const result = await client.query(
    `UPDATE ${table} c
        SET at_uri = 'at://' || $1 || '/' || $2 || '/' || t.rkey
       FROM (
         SELECT id, editions_next_tid() AS rkey
           FROM ${table}
          WHERE at_uri IS NULL
          ORDER BY id
          LIMIT $3
       ) t
      WHERE c.id = t.id AND c.at_uri IS NULL
      RETURNING c.id, c.at_uri`,
    [authority, collection, limit]
  );
  return result.rows;
}

/**
 * Queue entity rows defensively. The 0004 trigger already queues them for the
 * minting UPDATE, but an operator may run this task on a database where the
 * trigger has not been applied yet; `ON CONFLICT DO NOTHING` never rewrites a
 * newer outbox row.
 */
async function queueEntities(client, collection, uris) {
  if (uris.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO pds_outbox (uri, collection, rkey, op)
     SELECT u.uri, $2, split_part(u.uri, '/', 5), 'create'
       FROM unnest($1::text[]) AS u(uri)
     ON CONFLICT (uri) DO UPDATE SET
       op = 'create',
       value = NULL,
       updated_at = now()`,
    [uris, collection]
  );
  return result.rowCount;
}

/** Queue the editions that credit one of the just-minted entities. */
async function queueEditionsForIds(client, contributorIds, publisherIds) {
  const result = await client.query(
    `INSERT INTO pds_outbox (uri, collection, rkey, op)
     SELECT e.uri, $3, e.rkey, 'update'
       FROM editions e
      WHERE EXISTS (
              SELECT 1 FROM edition_contributors ec
               WHERE ec.edition_uri = e.uri
                 AND ec.contributor_id = ANY($1::bigint[])
            )
         OR EXISTS (
              SELECT 1 FROM edition_publishers ep
               WHERE ep.edition_uri = e.uri
                 AND ep.publisher_id = ANY($2::bigint[])
            )
     ON CONFLICT (uri) DO UPDATE SET
       op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
       value = NULL,
       updated_at = now()`,
    [contributorIds, publisherIds, EDITION_COLLECTION]
  );
  return result.rowCount;
}

/** Queue every edition that credits an entity with an address. */
async function queueEditionsForMintedEntities(client) {
  const result = await client.query(
    `INSERT INTO pds_outbox (uri, collection, rkey, op)
     SELECT e.uri, $1, e.rkey, 'update'
       FROM editions e
      WHERE EXISTS (
              SELECT 1 FROM edition_contributors ec
                JOIN contributors c ON c.id = ec.contributor_id
               WHERE ec.edition_uri = e.uri AND c.at_uri IS NOT NULL
            )
         OR EXISTS (
              SELECT 1 FROM edition_publishers ep
                JOIN publishers p ON p.id = ep.publisher_id
               WHERE ep.edition_uri = e.uri AND p.at_uri IS NOT NULL
            )
     ON CONFLICT (uri) DO UPDATE SET
       op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
       value = NULL,
       updated_at = now()`,
    [EDITION_COLLECTION]
  );
  return result.rowCount;
}

/**
 * @param {object} pool pg Pool
 * @param {object} options
 * @param {string} options.authority publisher DID (`ATP_SERVICE_DID`)
 * @param {'mint'|'editions'} [options.phase]
 * @param {number} [options.batchSize]
 * @param {object} [options.logger]
 */
export async function prepareEntityRecords(
  pool,
  { authority, phase = 'mint', batchSize = DEFAULT_BATCH, logger = console } = {}
) {
  assertAuthority(authority);
  if (phase !== 'mint' && phase !== 'editions') {
    throw new Error(`unknown entities.prepare phase ${JSON.stringify(phase)}`);
  }
  const limit = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH;
  const summary = {
    phase,
    contributorsMinted: 0,
    publishersMinted: 0,
    entityRowsQueued: 0,
    editionsQueued: 0
  };

  if (phase === 'editions') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      summary.editionsQueued = await queueEditionsForMintedEntities(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    logger.info?.(
      `entities.prepare[editions]: queued ${summary.editionsQueued} edition(s)`
    );
    return summary;
  }

  for (;;) {
    const client = await pool.connect();
    let minted = [];
    try {
      await client.query('BEGIN');
      for (const collection of Object.keys(TABLES)) {
        const rows = await mintBatch(client, collection, authority, limit);
        if (rows.length === 0) continue;
        minted.push({ collection, rows });
        summary[TABLES[collection].rowsKey] += rows.length;
        await queueEntities(client, collection, rows.map((row) => row.at_uri));
        // Every minted row is now queued (by the 0004 trigger, or by the
        // defensive insert above), so the minted count is the queued count.
        summary.entityRowsQueued += rows.length;
      }
      if (minted.length > 0) {
        const contributorIds = minted
          .filter((entry) => entry.collection === CONTRIBUTOR_COLLECTION)
          .flatMap((entry) => entry.rows.map((row) => row.id));
        const publisherIds = minted
          .filter((entry) => entry.collection === PUBLISHER_COLLECTION)
          .flatMap((entry) => entry.rows.map((row) => row.id));
        summary.editionsQueued += await queueEditionsForIds(
          client,
          contributorIds,
          publisherIds
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (minted.length === 0) break;
  }

  logger.info?.(
    `entities.prepare[mint]: ${summary.contributorsMinted} contributor(s), ` +
      `${summary.publishersMinted} publisher(s), ` +
      `${summary.entityRowsQueued} entity row(s), ` +
      `${summary.editionsQueued} edition(s) queued`
  );
  return summary;
}
