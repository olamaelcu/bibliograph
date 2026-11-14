import { createOutboxPublisher, DEFAULT_BATCH } from './publish.js';
import { publisherConfigError, resolvePublisherConfig } from './pds.js';
import { createIngest } from './ingest.js';
import { isbn13 as normalizeIsbn13 } from './util.js';
import { prepareEntityRecords } from './prepare-entities.js';
import { mergeGenres } from './genres.js';

/** Upper bound on editions one catalog task ingests; providers may return fewer. */
export const CANDIDATES_PER_TASK = 50;

/** Editions one genre sweep claims when the payload names no limit. */
export const GENRE_SWEEP_BATCH = 25;
/** Upper bound on one sweep, whatever the payload asks for. */
export const GENRE_SWEEP_BATCH_MAX = 200;

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

export function createTasks({ pool, providers, publisherDid, publisherHost, publisher }) {
  const ingest = createIngest({ pool, publisherDid, publisherHost });

  // Without configured credentials the task still exists and fails with the
  // exact missing settings; it must never quietly drop outbox rows.
  const outbox =
    publisher ??
    (() => {
      const config = resolvePublisherConfig();
      if (!config.configured) return undefined;
      return createOutboxPublisher({ pool, config });
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
        `SELECT (SELECT count(*) FROM editions) AS editions,
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
             FROM editions e
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

      let enqueued = 0;
      for (const row of candidates) {
        const claimed = await pool.query(
          'SELECT catalog_enqueue_genre_fetch($1::text) AS enqueued',
          [row.uri]
        );
        if (claimed.rows[0]?.enqueued === true) enqueued += 1;
      }
      helpers.logger.info(
        `catalog.genres.sweep: ${candidates.length} candidate(s) ` +
          `(${freshCount} new, ${candidates.length - freshCount} retry), ` +
          `${enqueued} enqueued`
      );
    },

    'pds-publish': async (payload, helpers) => {
      if (!outbox) throw publisherConfigError(resolvePublisherConfig());
      const limit = Number.isInteger(payload?.limit) ? payload.limit : DEFAULT_BATCH;
      const result = await outbox.drain({ limit, logger: helpers.logger });
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
