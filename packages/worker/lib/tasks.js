import { createOutboxPublisher, DEFAULT_BATCH } from './publish.js';
import { publisherConfigError, resolvePublisherConfig } from './pds.js';
import { createIngest } from './ingest.js';
import { importBookhiveCatalog } from './bookhive.js';
import { createBookhiveMetrics } from './bookhive.js';
import { cleanString, isbn13 as normalizeIsbn13 } from './util.js';
import { prepareEntityRecords } from './prepare-entities.js';
import { mergeGenres } from './genres.js';
import { isbn10FromIsbn13, lookupIsbn } from './providers/isbn-lookup.js';
import {
  CoverRejectedError,
  cachedCoverSize,
  coversBaseUrlFromEnv,
  downloadCover,
  removeCachedCover,
  writeCachedCover
} from './cover-cache.js';
import { createCoverMetrics } from './cover-metrics.js';

/** Upper bound on editions one catalog task ingests; providers may return fewer. */
export const CANDIDATES_PER_TASK = 50;

/** Editions one genre sweep claims when the payload names no limit. */
export const GENRE_SWEEP_BATCH = 25;
/** Upper bound on one sweep, whatever the payload asks for. */
export const GENRE_SWEEP_BATCH_MAX = 200;

/** Editions one cover sweep claims when the payload names no limit. */
export const COVER_SWEEP_BATCH = 500;
/** Upper bound on one cover sweep, whatever the payload asks for. */
// The sweep only enqueues; download politeness is the gate inside
// `downloadCover`, so a wide sweep is what lets a ~300k-edition backfill finish.
export const COVER_SWEEP_BATCH_MAX = 5000;

/** Editions one ISBN backfill sweep claims: one daily batch, spent by the budget. */
export const ISBN_BACKFILL_BATCH = 50;
/**
 * Real lookup attempts one day may spend when `ISBN_BACKFILL_PER_DAY` is unset.
 * A hundred-thousand-edition backlog must not turn into a hundred thousand
 * provider queries in one night, so the budget is the throttle and the batch
 * size is only the shape of one cron tick.
 */
export const ISBN_BACKFILL_PER_DAY_DEFAULT = 250;

function validIdentifier(identifier) {
  return (
    identifier !== null &&
    typeof identifier === 'object' &&
    typeof identifier.issuer === 'string' &&
    identifier.issuer !== '' &&
    typeof identifier.value === 'string' &&
    identifier.value !== ''
  );
}

/**
 * Ask the free providers for a cover URL when the edition has none of its own.
 * OpenLibrary answers first (one request, no key); Google Books only for an ISBN
 * and only when OpenLibrary had nothing.
 *
 * Returns the URL, or `null` after recording the attempt as `none`. A total
 * outage throws, so the caller's job retries instead of filing an absence.
 */
async function discoverCoverUrl({ pool, providers, uri, logger }) {
  const identifiers = (
    await pool.query(
      `SELECT issuer, value
         FROM edition_identifiers
        WHERE edition_uri = $1
        ORDER BY issuer, value`,
      [uri]
    )
  ).rows;
  if (identifiers.length === 0) {
    await pool.query(
      `UPDATE edition_cover_fetches
          SET requested_at = now(), outcome = 'none'
        WHERE edition_uri = $1`,
      [uri]
    );
    logger.warn(`catalog.covers ${uri}: no identifiers`);
    return null;
  }

  let attempted = 0;
  let failed = 0;
  let firstFailure;
  const noteFailure = (label, error) => {
    failed += 1;
    firstFailure ??= error;
    logger.warn(`catalog.covers ${uri}: ${label} failed — ${error?.message ?? error}`);
  };

  let cover;
  const openlibrary = providers?.providers?.openlibrary;
  if (openlibrary) {
    attempted += 1;
    try {
      cover = cleanString(await openlibrary.coverForEdition(identifiers));
    } catch (error) {
      noteFailure('OpenLibrary', error);
    }
  }

  if (!cover) {
    const isbn = normalizeIsbn13(
      cleanString(
        identifiers.find((identifier) =>
          ['isbn13', 'isbn10', 'isbn'].includes(cleanString(identifier?.issuer)?.toLowerCase())
        )?.value
      )
    );
    const google = providers?.providers?.google;
    if (isbn && google) {
      attempted += 1;
      try {
        const candidates = await google.byIsbn(isbn);
        cover = candidates.map((candidate) => cleanString(candidate?.coverUrl)).find(Boolean);
      } catch (error) {
        noteFailure('Google Books', error);
      }
    }
  }

  if (cover) return cover;

  if (attempted > 0 && failed === attempted) {
    // Nothing answered, so this is an outage rather than an absence. Rethrow so
    // the job retries; the claim is still held, so the retry does not wait out
    // the seven-day window.
    throw firstFailure;
  }
  await pool.query(
    `UPDATE edition_cover_fetches
        SET requested_at = now(), outcome = 'none'
      WHERE edition_uri = $1`,
    [uri]
  );
  logger.info(`catalog.covers ${uri}: no cover`);
  return null;
}

export function createTasks({
  pool,
  providers,
  publisherDid,
  publisherHost,
  publisher,
  // Deployment configuration, never a baked-in path: without it the cover cache
  // is disabled rather than guessing a directory the process cannot write.
  coversCacheDir = '',
  coversBaseUrl = '',
  coverFetch = fetch,
  // Shared with the metrics endpoint so a scrape reports what the jobs saw; a
  // bare caller (a test, a script) gets its own counter.
  coverMetrics = createCoverMetrics(),
  // Same contract for the Bookhive walk: the counters are process-local, so
  // the endpoint must be handed the instance the task writes to.
  bookhiveMetrics = createBookhiveMetrics(),
  // The daily ceiling on real ISBN lookups (`ISBN_BACKFILL_PER_DAY`). Passed
  // through so a test (or an operator script) can spend a smaller budget; the
  // task itself never mutates it.
  isbnBackfillPerDay = Number.parseInt(process.env.ISBN_BACKFILL_PER_DAY ?? '', 10),
  // Aborted when the process is asked to stop, before graphile's per-job abort
  // fires. Combined with `helpers.abortSignal` below.
  signal = null
}) {
  const ingest = createIngest({ pool, publisherDid, publisherHost });

  // One signal for both stop paths: the process-wide one (SIGTERM, announced by
  // `pool:gracefulShutdown`) and graphile's per-job abort. Either one means the
  // long tasks should return at their next checkpoint.
  const stopSignal = (helpers) =>
    helpers?.abortSignal && signal
      ? AbortSignal.any([signal, helpers.abortSignal])
      : (helpers?.abortSignal ?? signal);
  const coversDir = coversCacheDir.trim();
  const coverCacheEnabled = coversDir !== '';
  // `coversBaseUrl` may arrive unset (tests, older callers); derive it from the
  // publisher host so a record never advertises a bare path.
  const coversBase = coversBaseUrl || coversBaseUrlFromEnv({}, publisherHost);
  const isbnBudget =
    Number.isFinite(isbnBackfillPerDay) && isbnBackfillPerDay > 0
      ? isbnBackfillPerDay
      : ISBN_BACKFILL_PER_DAY_DEFAULT;

  // Without configured credentials the task still exists and fails with the
  // exact missing settings; it must never quietly drop outbox rows.
  const outbox =
    publisher ??
    (() => {
      const config = resolvePublisherConfig();
      if (!config.configured) return undefined;
      return createOutboxPublisher({ pool, config, coversBaseUrl: coversBase });
    })();

  async function ingestCandidates(candidates, limit) {
    let ingested = 0;
    for (const candidate of candidates.slice(0, limit)) {
      if (await ingest(candidate)) ingested += 1;
    }
    return ingested;
  }

  return {
    'catalog.resolve': async (payload, helpers) => {
      const identifier = payload?.identifier;
      if (!validIdentifier(identifier)) {
        helpers.logger.warn('catalog.resolve: invalid identifier payload');
        return;
      }

      const candidates = await providers.resolve(identifier);
      const ingested = await ingestCandidates(candidates, CANDIDATES_PER_TASK);
      helpers.logger.info(
        `catalog.resolve ${identifier.issuer}:${identifier.value}: ` +
          `${candidates.length} candidate(s), ${ingested} ingested`
      );
    },

    'catalog.search': async (payload, helpers) => {
      const identifiers = Array.isArray(payload?.identifiers)
        ? payload.identifiers.filter(validIdentifier)
        : [];
      const hasText = ['q', 'title', 'author'].some(
        (key) => typeof payload?.[key] === 'string' && payload[key].trim() !== ''
      );
      if (!hasText && identifiers.length === 0) {
        helpers.logger.warn('catalog.search: empty payload');
        return;
      }

      const candidates = await providers.search({
        q: typeof payload.q === 'string' ? payload.q : undefined,
        title: typeof payload.title === 'string' ? payload.title : undefined,
        author: typeof payload.author === 'string' ? payload.author : undefined,
        identifiers
      });
      const ingested = await ingestCandidates(candidates, CANDIDATES_PER_TASK);
      helpers.logger.info(
        `catalog.search: ${candidates.length} candidate(s), ${ingested} ingested`
      );
    },

    'catalog.isbn': async (payload, helpers) => {
      const isbn = typeof payload?.isbn === 'string' ? normalizeIsbn13(payload.isbn) : null;
      if (!isbn) {
        helpers.logger.warn('catalog.isbn: invalid isbn payload');
        return;
      }

      // A direct by-ISBN lookup beats the generic fan-out; an empty result falls
      // back to the resolve chain, which itself starts with ISBNdb (cache hit).
      // A throw here means ISBNdb is down or its breaker is open; the resolve
      // chain retries it fast and then uses Google/Goodreads.
      const isbndb = providers?.providers?.isbndb;
      let candidates = [];
      if (isbndb) {
        try {
          candidates = await isbndb.byIsbn(isbn);
        } catch (error) {
          helpers.logger.warn(
            `catalog.isbn: ISBNdb failed for ${isbn} — ${error.message}; using the resolve chain`
          );
        }
      } else {
        helpers.logger.warn(
          `catalog.isbn: ISBNdb is not configured (ISBNDB_API_KEY unset); ` +
            `falling back to the resolve chain for ${isbn}`
        );
      }
      if (candidates.length === 0) {
        candidates = await providers.resolve({ issuer: 'isbn13', value: isbn });
      }

      const ingested = await ingestCandidates(candidates, CANDIDATES_PER_TASK);
      helpers.logger.info(
        `catalog.isbn ${isbn}: ${candidates.length} candidate(s), ${ingested} ingested`
      );
    },

    // Bookhive's catalog is the only join its reader records have: every hive
    // id a `buzz.bookhive.book` carries has to resolve to an edition before
    // that record can be read as a review or a feed entry.
    'catalog.bookhive': async (payload, helpers) => {
      const summary = await importBookhiveCatalog({
        pool,
        ingest,
        pages: Number(payload?.pages) || 5000,
        logger: helpers.logger,
        metrics: bookhiveMetrics,
        // Stopping at the next page keeps the walk's place instead of losing it
        // to a killed process.
        signal: stopSignal(helpers)
      });
      helpers.logger.info(`catalog.bookhive ${JSON.stringify(summary)}`);
    },

    // Hydrates one edition's genres from the providers that actually have
    // them: Goodreads book-page genres and OpenLibrary subjects, both free and
    // asked together, then ISBNdb's deprecated `subjects` list as a metered
    // last resort — only when the other two produced nothing, and through its
    // seven-day response cache, so a repeat costs no daily call.
    //
    // Idempotent by construction. An edition that already has genres is never
    // re-fetched, and `edition_genre_fetches` records when an edition was last
    // asked and what came back. A failed provider is not fatal while the other
    // answers, and the stored list is only rewritten when there is something to
    // write — so a provider outage can never wipe genres.
    'catalog.genres': async (payload, helpers) => {
      const uri =
        typeof payload?.editionUri === 'string' && payload.editionUri !== ''
          ? payload.editionUri
          : null;
      if (uri === null) {
        helpers.logger.warn('catalog.genres: invalid payload');
        return;
      }

      const existing = await pool.query(
        'SELECT EXISTS (SELECT 1 FROM edition_genres WHERE edition_uri = $1) AS has_genres',
        [uri]
      );
      if (existing.rows[0]?.has_genres === true) {
        await pool.query(
          `UPDATE edition_genre_fetches
              SET requested_at = now(), outcome = 'found'
            WHERE edition_uri = $1`,
          [uri]
        );
        helpers.logger.info(`catalog.genres ${uri}: already has genres`);
        return;
      }

      const identifiers = (
        await pool.query(
          `SELECT issuer, value
             FROM edition_identifiers
            WHERE edition_uri = $1
            ORDER BY issuer, value`,
          [uri]
        )
      ).rows;
      if (identifiers.length === 0) {
        await pool.query(
          `UPDATE edition_genre_fetches
              SET requested_at = now(), outcome = 'none'
            WHERE edition_uri = $1`,
          [uri]
        );
        helpers.logger.warn(`catalog.genres ${uri}: no identifiers`);
        return;
      }

      // Both providers are asked at once; they are gated independently, and a
      // Goodreads challenge must not cost the OpenLibrary answer.
      // ISBNdb stays out of this batch: it is metered, and one call per edition
      // must only be spent when the free pair answered nothing.
      const [goodreads, openlibrary] = await Promise.allSettled([
        providers.providers.goodreads.genresForEdition(identifiers),
        providers.providers.openlibrary.genresForEdition(identifiers)
      ]);
      for (const settled of [goodreads, openlibrary]) {
        if (settled.status === 'rejected') {
          const reason = settled.reason;
          helpers.logger.warn(
            `catalog.genres ${uri}: provider failed — ${reason?.message ?? reason}`
          );
        }
      }
      const freeLabels = {
        goodreads: goodreads.status === 'fulfilled' ? goodreads.value : [],
        openlibrary: openlibrary.status === 'fulfilled' ? openlibrary.value : []
      };
      let merged = mergeGenres(freeLabels);

      if (merged.length === 0) {
        const isbndb = providers.providers.isbndb;
        if (isbndb) {
          try {
            const subjects = await isbndb.genresForEdition(identifiers);
            if (subjects === undefined) {
              // The daily quota refused the call: this edition was not asked, so
              // its ledger row must not claim it was looked at.
              helpers.logger.info(
                `catalog.genres ${uri}: ISBNdb daily quota exhausted; skipped`
              );
              return;
            }
            merged = mergeGenres({ ...freeLabels, isbndb: subjects });
          } catch (error) {
            helpers.logger.warn(
              `catalog.genres ${uri}: ISBNdb failed — ${error?.message ?? error}`
            );
          }
        }
      }

      if (merged.length === 0 && goodreads.status === 'rejected' && openlibrary.status === 'rejected') {
        // Nothing answered, so this is an outage rather than an absence. Rethrow
        // so the job retries; the ledger keeps the claim, so the retry does not
        // wait out the seven-day window.
        throw goodreads.reason;
      }
      if (merged.length === 0) {
        await pool.query(
          `UPDATE edition_genre_fetches
              SET requested_at = now(), outcome = 'none'
            WHERE edition_uri = $1`,
          [uri]
        );
        helpers.logger.info(`catalog.genres ${uri}: 0 genres`);
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM edition_genres WHERE edition_uri = $1', [uri]);
        for (const [index, genre] of merged.entries()) {
          // The no-op `DO UPDATE` is what makes RETURNING yield a row on
          // conflict; `DO NOTHING` would return nothing for an existing genre.
          const row = await client.query(
            `INSERT INTO genres (name) VALUES ($1)
             ON CONFLICT (lower(name)) DO UPDATE SET name = genres.name
             RETURNING id`,
            [genre.name]
          );
          await client.query(
            `INSERT INTO edition_genres (edition_uri, genre_id, position, source)
             VALUES ($1, $2, $3, $4)`,
            [uri, row.rows[0].id, index + 1, genre.source]
          );
        }
        await client.query(
          `UPDATE edition_genre_fetches
              SET requested_at = now(), outcome = 'found'
            WHERE edition_uri = $1`,
          [uri]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      helpers.logger.info(`catalog.genres ${uri}: ${merged.length} genre(s)`);
    },

    // Files editions that have no genres into the queue.
    //
    // Two passes, in priority order. Editions that were never attempted come
    // first, because they are the ones no reader has ever seen genres for; the
    // retry pass only fills capacity the first pass left over. Without that
    // split a large population of genreless editions, re-armed every seven days
    // by the claim function, could occupy every sweep and starve new arrivals —
    // and since candidates are ordered oldest-`indexed_at` first, a fresh
    // edition would never reach the front.
    //
    // The claim itself lives in `catalog_enqueue_genre_fetch`, so a sweep racing
    // the edge never queues the same edition twice.
    'catalog.genres.sweep': async (payload, helpers) => {
      const limit = Number.isInteger(payload?.limit)
        ? Math.min(Math.max(payload.limit, 1), GENRE_SWEEP_BATCH_MAX)
        : GENRE_SWEEP_BATCH;

      // A fresh candidate is an edition with no ledger row at all, which is a set
      // difference no index can answer cheaply: when the set is empty the walk
      // has to cover every edition to prove it (3.6 s at 300k). Ledger rows are
      // a subset of editions, so equal counts prove the set is empty for the
      // price of two index-only counts.
      const counts = await pool.query(
        `SELECT (SELECT count(*) FROM books) AS editions,
                (SELECT count(*) FROM edition_genre_fetches) AS attempts`
      );
      const hasFresh =
        Number(counts.rows[0]?.attempts ?? 0) < Number(counts.rows[0]?.editions ?? 0);
      const candidates = [];
      let freshCount = 0;

      if (hasFresh) {
        // Backed by `editions_indexed_at_idx`, so the LIMIT ends the walk
        // instead of scanning `editions` and sorting it.
        const fresh = await pool.query(
          `SELECT e.uri
             FROM books e
            WHERE NOT EXISTS (
                    SELECT 1 FROM edition_genres g WHERE g.edition_uri = e.uri
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM edition_genre_fetches f WHERE f.edition_uri = e.uri
                  )
            ORDER BY e.indexed_at ASC, e.uri ASC
            LIMIT $1`,
          [limit]
        );
        freshCount = fresh.rows.length;
        candidates.push(...fresh.rows);
      }

      if (candidates.length < limit) {
        const retries = await pool.query(
          // Driven by the ledger itself, so this pass can only return editions
          // the fresh pass has already excluded. Ordered by the ledger clock, so
          // the edition that has waited longest for a retry comes first, and
          // `edition_genre_fetches_retry_idx` serves that order: the scan starts
          // at the eligible end of the table and stops at the limit.
          //
          // `outcome` replaces a join back to `edition_genres` here: the task
          // writes the genre rows and this `found` mark in one transaction, so
          // the mark is the cheap, indexable form of the same question. Probing
          // `edition_genres` per row instead made an eligible-heavy ledger
          // seq-scan the whole table (4.5 s for 25 rows at 300k).
          `SELECT f.edition_uri AS uri
             FROM edition_genre_fetches f
            WHERE f.requested_at < now() - interval '7 days'
              AND f.outcome IS DISTINCT FROM 'found'
            ORDER BY f.requested_at ASC
            LIMIT $1`,
          [limit - candidates.length]
        );
        candidates.push(...retries.rows);
      }

      // One claim call for the whole batch instead of one per candidate: the
      // function still decides per edition (that is what makes the sweep safe
      // against the edge), it just runs set-wise over the same ordered list.
      // `WITH ORDINALITY` keeps the candidate order the loop had, so the jobs
      // are queued in the same sequence they used to be.
      const claimed =
        candidates.length === 0
          ? { rows: [] }
          : await pool.query(
              `SELECT catalog_enqueue_genre_fetch(t.uri) AS enqueued
                 FROM unnest($1::text[]) WITH ORDINALITY AS t(uri, ord)
                ORDER BY t.ord`,
              [candidates.map((row) => row.uri)]
            );
      const enqueued = claimed.rows.filter((row) => row.enqueued === true).length;
      helpers.logger.info(
        `catalog.genres.sweep: ${candidates.length} candidate(s) ` +
          `(${freshCount} new, ${candidates.length - freshCount} retry), ` +
          `${enqueued} enqueued`
      );
    },

    // Caches one edition's cover image on disk.
    //
    // A cover URL is not evidence of a cover: OpenLibrary answers a missing
    // ISBN with a 43-byte placeholder that a browser renders as nothing. So the
    // bytes are downloaded once, sniffed, and written to the shared cache the
    // edge serves from; `edition_cover_files` records what is there. Anything
    // under `MIN_COVER_BYTES` (or not an image) nulls `cover_url` and is
    // recorded as a terminal `rejected`, because retrying that URL only spends
    // provider requests.
    //
    // A provider outage is different: it throws so graphile retries, because a
    // transient failure must not be mistaken for an absence. The ledger is the
    // retry clock, and every edition update is guarded so a concurrent curator
    // edit wins.
    'catalog.covers': async (payload, helpers) => {
      const uri =
        typeof payload?.editionUri === 'string' && payload.editionUri !== ''
          ? payload.editionUri
          : null;
      if (uri === null) {
        helpers.logger.warn('catalog.covers: invalid payload');
        return;
      }
      if (!coverCacheEnabled) {
        // Nothing is downloaded and no ledger outcome is written: the edition's
        // provider URL stays as it is, and the job is a no-op until an operator
        // sets COVERS_CACHE_DIR.
        helpers.logger.warn(`catalog.covers ${uri}: COVERS_CACHE_DIR is not set, skipping`);
        return;
      }

      const edition = await pool.query(
        `SELECT e.cover_url, f.source_url AS cached_source, f.content_type, f.byte_size
           FROM books e
           LEFT JOIN edition_cover_files f
                  ON f.edition_uri = e.uri AND f.source_url = e.cover_url
          WHERE e.uri = $1`,
        [uri]
      );
      if (edition.rowCount === 0) {
        // The ledger row cascaded away with the edition.
        helpers.logger.warn(`catalog.covers ${uri}: edition not found`);
        return;
      }
      const row = edition.rows[0];

      // The cache row only matches when it was written for the *current*
      // `cover_url` (the join pairs them), so a curated URL change falls through
      // to a fresh download instead of serving the old provider's bytes.
      if (row.content_type !== null && (await cachedCoverSize(coversDir, uri)) !== null) {
        await pool.query(
          `UPDATE edition_cover_fetches
              SET requested_at = now(), outcome = 'found', source_url = $2
            WHERE edition_uri = $1`,
          [uri, cleanString(row.cover_url)]
        );
        helpers.logger.info(`catalog.covers ${uri}: already cached`);
        return;
      }

      // No usable image for this source: either the cache row is stale or the
      // file it names is gone. The path is keyed by URI alone, so leftover bytes
      // from another source have to be removed before a new download lands.
      // Counted only when a file was actually there: the counter tracks the
      // cache directory, not removal attempts.
      if (await removeCachedCover(coversDir, uri)) coverMetrics.recordRemoval();
      await pool.query('DELETE FROM edition_cover_files WHERE edition_uri = $1', [uri]);
      let source = cleanString(row.cover_url);
      let discovered = false;

      if (!source) {
        source = await discoverCoverUrl({ pool, providers, uri, logger: helpers.logger });
        if (source === null) return;
        discovered = true;
      }

      let image;
      try {
        image = await downloadCover(source, { fetchImpl: coverFetch });
      } catch (error) {
        // A bad URL is terminal: the ledger records `rejected` against this
        // source, and the edition loses a URL that never had a cover behind it.
        // Anything else (transport, a 5xx, a truncated response) is a provider
        // problem, so it propagates and graphile retries with a fresh claim.
        // The endpoint reports both classes: `rejected` never retries, `retry`
        // will, so a rising `retry` count is the provider-health signal.
        if (!(error instanceof CoverRejectedError)) {
          coverMetrics.record('retry', String(error.status ?? 'none'));
          throw error;
        }
        coverMetrics.record('rejected', String(error.status ?? 'none'));
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM edition_cover_files WHERE edition_uri = $1', [uri]);
          await client.query(
            `UPDATE books SET cover_url = NULL
              WHERE uri = $1 AND cover_url = $2`,
            [uri, source]
          );
          await client.query(
            `UPDATE edition_cover_fetches
                SET requested_at = now(), outcome = 'rejected', source_url = $2
              WHERE edition_uri = $1`,
            [uri, source]
          );
          await client.query('COMMIT');
        } catch (rejection) {
          await client.query('ROLLBACK');
          throw rejection;
        } finally {
          client.release();
        }
        helpers.logger.warn(
          `catalog.covers ${uri}: rejected ${error.byteSize ?? 0} bytes from ${source} ` +
            `(${error.message})`
        );
        return;
      }

      await writeCachedCover(coversDir, uri, image.bytes);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The previous source is read inside the transaction: the record has to
        // be republished whenever what it advertises changes, and that is
        // exactly when this differs (first cache, or a different provider URL).
        const previous = await client.query(
          'SELECT source_url FROM edition_cover_files WHERE edition_uri = $1',
          [uri]
        );
        await client.query(
          `INSERT INTO edition_cover_files
                  (edition_uri, source_url, content_type, byte_size, cached_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (edition_uri) DO UPDATE SET
             source_url = EXCLUDED.source_url,
             content_type = EXCLUDED.content_type,
             byte_size = EXCLUDED.byte_size,
             cached_at = now()`,
          [uri, source, image.contentType, image.byteSize]
        );
        if (discovered) {
          // The same guard as ingest: a curator edit that landed meanwhile wins.
          await client.query(
            `UPDATE books SET cover_url = $2
              WHERE uri = $1 AND (cover_url IS NULL OR btrim(cover_url) = '')`,
            [uri, source]
          );
        }
        if (previous.rows[0]?.source_url !== source) {
          // What the record advertises just changed, so it is stale until
          // republished. A discovered source also fires the edition trigger;
          // this upsert coalesces with it.
          await client.query(
            `INSERT INTO pds_outbox (uri, collection, rkey, op)
             SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
               FROM books e
              WHERE e.uri = $1
             ON CONFLICT (uri) DO UPDATE SET
               op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
               value = NULL,
               updated_at = now()`,
            [uri]
          );
        }
        await client.query(
          `UPDATE edition_cover_fetches
              SET requested_at = now(), outcome = 'found', source_url = $2
            WHERE edition_uri = $1`,
          [uri, source]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      helpers.logger.info(
        `catalog.covers ${uri}: cached ${image.byteSize} bytes from ${source}`
      );
      coverMetrics.recordWrite(image.byteSize);
      coverMetrics.record('cached', '200');
    },

    // Files editions that still need a cached cover into the queue.
    //
    // Three passes, in priority order: a known source URL that is not cached yet
    // (the backfill — these are cheap and always progress), then editions that
    // were never attempted, then retries on the seven-day clock. Each pass only
    // gets the capacity the earlier ones left over, so a population of
    // genuinely coverless editions, re-armed every seven days, cannot occupy
    // every sweep and starve the backfill.
    //
    // A `rejected` outcome is terminal for the source it names: the first pass
    // and the retry pass both skip that pair, since re-downloading a placeholder
    // only costs a provider request. A curated URL change makes it a new pair.
    //
    // No count precheck: the partial `editions_missing_cover_idx` makes the
    // never-attempted walk index-only-sized when nothing is coverless, so
    // proving there is nothing to do is already cheap, and a stale precheck
    // could only hide new arrivals.
    //
    // The claim lives in `catalog_enqueue_cover_fetch`, so a sweep racing the
    // edge never queues the same edition twice.
    'catalog.covers.sweep': async (payload, helpers) => {
      if (!coverCacheEnabled) {
        // Queuing jobs that can only no-op would just churn the ledger, so the
        // sweep stays silent-but-loud until an operator configures the cache.
        helpers.logger.warn('catalog.covers.sweep: COVERS_CACHE_DIR is not set, skipping');
        return;
      }
      const limit = Number.isInteger(payload?.limit)
        ? Math.min(Math.max(payload.limit, 1), COVER_SWEEP_BATCH_MAX)
        : COVER_SWEEP_BATCH;

      const candidates = [];

      const uncached = await pool.query(
        // Has a source URL, no cached file for it, and that URL has not already
        // been rejected. Ordered by `indexed_at` so the LIMIT ends the walk
        // (`editions_cover_url_idx`). Every queued edition leaves this pass, so
        // it always makes progress through the catalog.
        `SELECT e.uri
           FROM books e
           LEFT JOIN edition_cover_files f
                  ON f.edition_uri = e.uri AND f.source_url = e.cover_url
          WHERE e.cover_url IS NOT NULL AND btrim(e.cover_url) <> ''
            AND f.edition_uri IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM edition_cover_fetches l
                   WHERE l.edition_uri = e.uri
                     AND l.outcome = 'rejected'
                     AND l.source_url = e.cover_url
                )
          ORDER BY e.indexed_at ASC, e.uri ASC
          LIMIT $1`,
        [limit]
      );
      candidates.push(...uncached.rows);

      // An exhausted budget skips the remaining passes instead of asking the
      // database for a `LIMIT 0` it already knows the answer to.
      const fresh =
        candidates.length < limit
          ? await pool.query(
              // Never attempted: no usable URL and no ledger row. The claim
              // function is what discovers a URL for these.
              `SELECT e.uri
                 FROM books e
                WHERE (e.cover_url IS NULL OR btrim(e.cover_url) = '')
                  AND NOT EXISTS (
                        SELECT 1 FROM edition_cover_fetches f WHERE f.edition_uri = e.uri
                      )
                ORDER BY e.indexed_at ASC, e.uri ASC
                LIMIT $1`,
              [limit - candidates.length]
            )
          : { rows: [] };
      if (fresh.rows.length > 0) candidates.push(...fresh.rows);

      const retries =
        candidates.length < limit
          ? await pool.query(
              // Driven by the ledger, so it can only return editions the earlier
              // passes already excluded, oldest attempt first; the partial
              // `edition_cover_fetches_retry_idx` serves that order. `rejected`
              // is skipped: it is terminal for the URL it names, and
              // `fillMissingFields` clears it when a provider offers a new one.
              `SELECT l.edition_uri AS uri
                 FROM edition_cover_fetches l
                 JOIN books e ON e.uri = l.edition_uri
                 LEFT JOIN edition_cover_files f
                        ON f.edition_uri = e.uri AND f.source_url = e.cover_url
                WHERE l.requested_at < now() - interval '7 days'
                  AND l.outcome IS DISTINCT FROM 'found'
                  AND l.outcome IS DISTINCT FROM 'rejected'
                  AND f.edition_uri IS NULL
                ORDER BY l.requested_at ASC
                LIMIT $1`,
              [limit - candidates.length]
            )
          : { rows: [] };
      if (retries.rows.length > 0) candidates.push(...retries.rows);

      // Same batching as the genre sweep: one statement per sweep batch, the
      // candidate order kept by `WITH ORDINALITY`.
      const claimed =
        candidates.length === 0
          ? { rows: [] }
          : await pool.query(
              `SELECT catalog_enqueue_cover_fetch(t.uri) AS enqueued
                 FROM unnest($1::text[]) WITH ORDINALITY AS t(uri, ord)
                ORDER BY t.ord`,
              [candidates.map((row) => row.uri)]
            );
      const enqueued = claimed.rows.filter((row) => row.enqueued === true).length;
      helpers.logger.info(
        `catalog.covers.sweep: ${candidates.length} candidate(s) ` +
          `(${uncached.rows.length} uncached, ${fresh.rows.length} new, ` +
          `${retries.rows.length} retry), ${enqueued} enqueued`
      );
    },

    // Finds the ISBN of an edition that has none.
    //
    // The guards run cheapest first, so a day's work stays bounded:
    //
    //   1. an edition that already carries an ISBN is recorded `skipped` (the
    //      claim can race an ingest that filled the field first);
    //   2. the daily budget refuses once today's real attempts reach
    //      `ISBN_BACKFILL_PER_DAY` — `edition_isbn_backfill` is the spend record
    //      already, so today's `found` + `none` + `conflict` count is the whole
    //      ledger read, with no new table;
    //   3. the lookup itself only ever asks the free providers
    //      (`lookupIsbn`), never the metered ISBNdb.
    //
    // A found ISBN is attached in one transaction — the identifier row, the
    // claim row carrying what the candidate knew, and the ledger's `found`. The
    // `edition_identifiers` trigger queues the republication, so nothing here
    // writes to `pds_outbox`. An ISBN another edition already owns is a
    // `conflict` and writes nothing: attaching it would make the identifier bag
    // resolve later ingests to the wrong book, and minting a second book for a
    // known ISBN is worse than one edition staying ISBN-less.
    'catalog.isbn.backfill': async (payload, helpers) => {
      const uri =
        typeof payload?.editionUri === 'string' && payload.editionUri !== ''
          ? payload.editionUri
          : null;
      if (uri === null) {
        helpers.logger.warn('catalog.isbn.backfill: invalid payload');
        return { status: 'invalid' };
      }

      const edition = await pool.query('SELECT title FROM books WHERE uri = $1', [uri]);
      if (edition.rowCount === 0) {
        // The ledger row cascaded away with the edition.
        helpers.logger.warn(`catalog.isbn.backfill ${uri}: edition not found`);
        return { status: 'missing' };
      }
      const title = cleanString(edition.rows[0].title);

      const identifiers = (
        await pool.query(
          `SELECT issuer, value
             FROM edition_identifiers
            WHERE edition_uri = $1
            ORDER BY issuer, value`,
          [uri]
        )
      ).rows;
      if (
        identifiers.some((identifier) =>
          ['isbn13', 'isbn10', 'isbn'].includes(cleanString(identifier?.issuer)?.toLowerCase())
        )
      ) {
        await pool.query(
          `UPDATE edition_isbn_backfill
              SET requested_at = now(), outcome = 'skipped'
            WHERE edition_uri = $1`,
          [uri]
        );
        helpers.logger.info(`catalog.isbn.backfill ${uri}: already has an ISBN`);
        return { status: 'skipped' };
      }

      // Today is the server's day, the same clock the ledger writes.
      const spent = await pool.query(
        `SELECT count(*)::int AS attempts
           FROM edition_isbn_backfill
          WHERE requested_at >= date_trunc('day', now())
            AND outcome IN ('found', 'none', 'conflict')`
      );
      const attempts = Number(spent.rows[0]?.attempts ?? 0);
      if (attempts >= isbnBudget) {
        // The claim row stays `skipped` with a fresh `requested_at`, so this
        // edition waits out the seven-day window instead of hot-looping.
        helpers.logger.info(
          `catalog.isbn.backfill ${uri}: daily budget spent (${attempts}/${isbnBudget})`
        );
        return { status: 'budget' };
      }

      const authors = (
        await pool.query(
          `SELECT c.name
             FROM edition_contributors ec
             JOIN contributors c ON c.id = ec.contributor_id
            WHERE ec.edition_uri = $1 AND ec.role = 'author'
            ORDER BY ec.position`,
          [uri]
        )
      ).rows
        .map((row) => cleanString(row.name))
        .filter(Boolean);

      // A thrown lookup (every provider down) propagates: the claim is held, so
      // graphile's retry does not wait out the window, and no absence is filed.
      const found = await lookupIsbn({
        providers: providers?.providers,
        title,
        authors,
        identifiers,
        logger: helpers.logger
      });

      if (found === null) {
        await pool.query(
          `UPDATE edition_isbn_backfill
              SET requested_at = now(), outcome = 'none'
            WHERE edition_uri = $1`,
          [uri]
        );
        helpers.logger.info(`catalog.isbn.backfill ${uri}: no ISBN found`);
        return { status: 'none' };
      }

      // The catalog stores both issuers, so the same book printed as its
      // ten-digit ISBN is the same owner. A 979 ISBN has no ISBN-10 form, and
      // `value = NULL` simply never matches.
      const owner = await pool.query(
        `SELECT edition_uri
           FROM edition_identifiers
          WHERE edition_uri <> $2
            AND (
                  (issuer = 'isbn13' AND value = $1)
               OR (issuer = 'isbn10' AND value = $3)
                )
          LIMIT 1`,
        [found.isbn13, uri, isbn10FromIsbn13(found.isbn13)]
      );
      if (owner.rowCount > 0) {
        await pool.query(
          `UPDATE edition_isbn_backfill
              SET requested_at = now(), outcome = 'conflict', source = $2, isbn = $3
            WHERE edition_uri = $1`,
          [uri, found.source, found.isbn13]
        );
        helpers.logger.warn(
          `catalog.isbn.backfill ${uri}: ${found.isbn13} already belongs to ` +
            `${owner.rows[0].edition_uri} (${found.source})`
        );
        return { status: 'conflict', isbn: found.isbn13, source: found.source };
      }

      const candidate = found.candidate ?? {};
      // `pages` is a projection of `extent` (0013), so the page count is what the
      // claim carries. A candidate with no valid count contributes no extent.
      const pages = Number(candidate.pages);
      const extent = Number.isInteger(pages) && pages > 0 ? JSON.stringify({ pages }) : null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO edition_identifiers (edition_uri, issuer, value)
           VALUES ($1, 'isbn13', $2)
           ON CONFLICT (edition_uri, issuer, value) DO NOTHING`,
          [uri, found.isbn13]
        );
        // The claim row carries only what the candidate actually knows; every
        // COALESCE keeps an existing, curated claim ahead of the provider's.
        await client.query(
          `INSERT INTO edition_identifier_info
                  (edition_uri, issuer, value, language, published_date, description, extent)
           VALUES ($1, 'isbn13', $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (edition_uri, issuer, value) DO UPDATE SET
             language = COALESCE(edition_identifier_info.language, EXCLUDED.language),
             published_date = COALESCE(
               edition_identifier_info.published_date, EXCLUDED.published_date
             ),
             description = COALESCE(edition_identifier_info.description, EXCLUDED.description),
             extent = normalize_identifier_extent(
               COALESCE(EXCLUDED.extent, '{}'::jsonb)
                 || COALESCE(edition_identifier_info.extent, '{}'::jsonb)
             ),
             updated_at = now()`,
          [
            uri,
            found.isbn13,
            cleanString(candidate.language) ?? null,
            cleanString(candidate.publishedDate) ?? null,
            cleanString(candidate.description) ?? null,
            extent
          ]
        );
        await client.query(
          `UPDATE edition_isbn_backfill
              SET requested_at = now(), outcome = 'found', source = $2, isbn = $3
            WHERE edition_uri = $1`,
          [uri, found.source, found.isbn13]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      helpers.logger.info(
        `catalog.isbn.backfill ${uri}: ${found.isbn13} from ${found.source}`
      );
      return { status: 'found', isbn: found.isbn13, source: found.source };
    },

    // Files ISBN-less editions into the queue, one bounded batch per cron tick.
    //
    // Two passes, both driven by the `books.indexed_at` index and each stopping
    // at the batch size: editions never attempted, then ledger rows older than
    // the seven-day window (ordered by `edition_isbn_backfill_retry_idx`). Both
    // carry the same ISBN predicate, expressed as a `NOT EXISTS` against the
    // `(edition_uri, issuer, value)` primary key so the planner never materialises
    // the identifier set. An edition that gained an ISBN since its ledger row
    // was written is excluded by that predicate, so the retry pass is only ever
    // genuinely ISBN-less books.
    //
    // The claim lives in `catalog_enqueue_isbn_backfill`, so two sweeps racing
    // each other never queue the same edition twice.
    'catalog.isbn.backfill.sweep': async (payload, helpers) => {
      const limit = Number.isInteger(payload?.limit)
        ? Math.min(Math.max(payload.limit, 1), ISBN_BACKFILL_BATCH)
        : ISBN_BACKFILL_BATCH;
      const candidates = [];

      const fresh = await pool.query(
        `SELECT e.uri
           FROM books e
          WHERE NOT EXISTS (
                  SELECT 1 FROM edition_identifiers i
                   WHERE i.edition_uri = e.uri AND i.issuer IN ('isbn13', 'isbn10')
                )
            AND NOT EXISTS (
                  SELECT 1 FROM edition_isbn_backfill l WHERE l.edition_uri = e.uri
                )
          ORDER BY e.indexed_at ASC, e.uri ASC
          LIMIT $1`,
        [limit]
      );
      candidates.push(...fresh.rows);

      const retries =
        candidates.length < limit
          ? await pool.query(
              `SELECT l.edition_uri AS uri
                 FROM edition_isbn_backfill l
                WHERE l.requested_at < now() - interval '7 days'
                  AND NOT EXISTS (
                        SELECT 1 FROM edition_identifiers i
                         WHERE i.edition_uri = l.edition_uri
                           AND i.issuer IN ('isbn13', 'isbn10')
                      )
                ORDER BY l.requested_at ASC
                LIMIT $1`,
              [limit - candidates.length]
            )
          : { rows: [] };
      candidates.push(...retries.rows);

      // Same batching as the genre and cover sweeps: one claim call for the
      // whole list, candidate order kept by `WITH ORDINALITY`.
      const claimed =
        candidates.length === 0
          ? { rows: [] }
          : await pool.query(
              `SELECT catalog_enqueue_isbn_backfill(t.uri) AS enqueued
                 FROM unnest($1::text[]) WITH ORDINALITY AS t(uri, ord)
                ORDER BY t.ord`,
              [candidates.map((row) => row.uri)]
            );
      const enqueued = claimed.rows.filter((row) => row.enqueued === true).length;
      helpers.logger.info(
        `catalog.isbn.backfill.sweep: ${candidates.length} candidate(s) ` +
          `(${fresh.rows.length} new, ${retries.rows.length} retry), ${enqueued} enqueued`
      );
    },

    // Deletes the edge's enqueue-throttle marks once they can no longer throttle
    // anything.
    //
    // `catalog_enqueue_marks` is a primary-key table that every annotation and
    // hydration claim inserts into and nothing ever removed from; the edge only
    // reads a mark inside its own window (the longest is the search budget's one
    // hour), so a row older than a day is dead weight that still has to be
    // scanned by the primary key. It is its own cron task rather than a branch in
    // one of the sweeps: those are per-edition work whose queue can be starved
    // by a backlog, and a table-wide DELETE must not sit behind that queue.
    'catalog.marks.prune': async (_payload, helpers) => {
      const deleted = await pool.query(
        "DELETE FROM catalog_enqueue_marks WHERE enqueued_at < now() - interval '24 hours'"
      );
      helpers.logger.info(
        `catalog.marks.prune: ${deleted.rowCount ?? 0} mark(s) older than 24 h removed`
      );
    },

    'pds-publish': async (payload, helpers) => {
      if (!outbox) throw publisherConfigError(resolvePublisherConfig());
      const limit = Number.isInteger(payload?.limit) ? payload.limit : DEFAULT_BATCH;
      const result = await outbox.drain({
        limit,
        logger: helpers.logger,
        signal: stopSignal(helpers)
      });
      helpers.logger.info(
        `pds-publish: ${result.published} published, ${result.failed} failed, ` +
          `${result.batches} batch(es)`
      );
    },

    // Operator-only: mints record URIs for rows that predate the feature and
    // queues the records (and the editions that credit them). Nothing is minted
    // automatically; `phase: 'editions'` is the post-publish republish pass.
    'entities.prepare': async (payload, helpers) => {
      const phase = payload?.phase === 'editions' ? 'editions' : 'mint';
      const result = await prepareEntityRecords(pool, {
        authority: publisherDid,
        phase,
        batchSize: Number.isInteger(payload?.batchSize) ? payload.batchSize : undefined,
        logger: helpers.logger
      });
      helpers.logger.info(`entities.prepare[${phase}]: ${JSON.stringify(result)}`);
    }
  };
}
