import { createOutboxPublisher, DEFAULT_BATCH } from './publish.js';
import { publisherConfigError, resolvePublisherConfig } from './pds.js';
import { createIngest } from './ingest.js';
import { isbn13 as normalizeIsbn13 } from './util.js';

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
      const ingested = await ingestCandidates(candidates, 3);
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
      const ingested = await ingestCandidates(candidates, 10);
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

      // A direct by-ISBN lookup beats the generic fan-out, but only when
      // ISBNdb is configured; otherwise fall back to the normal resolve chain.
      const isbndb = providers?.providers?.isbndb;
      let candidates;
      if (isbndb) {
        candidates = await isbndb.byIsbn(isbn);
      } else {
        helpers.logger.warn(
          `catalog.isbn: ISBNdb is not configured (ISBNDB_API_KEY unset); ` +
            `falling back to the resolve chain for ${isbn}`
        );
        candidates = await providers.resolve({ issuer: 'isbn13', value: isbn });
      }

      const ingested = await ingestCandidates(candidates, 3);
      helpers.logger.info(
        `catalog.isbn ${isbn}: ${candidates.length} candidate(s), ${ingested} ingested`
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
    }
  };
}
