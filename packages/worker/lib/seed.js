/**
 * Seed the catalogue from a provider's public listing.
 *
 * The catalog owns no data: every `editions` row arrives through `ingest()` from
 * a provider. A fresh stack therefore has nothing for `hv-fixtures` to point at
 * (it reads catalog editions and joins them to `pds_cids`), and nothing to
 * browse before a reader's first ISBN lookup. This fills that gap for
 * development by walking a provider's most-popular listing and ingesting each
 * record it names.
 *
 * Publishing is not part of seeding: inserting an edition queues its record
 * through the catalog trigger, and `pds-publish` (the worker task) drains
 * `pds_outbox` on its own schedule. One slow or failing record must not abort
 * the run — it is counted and reported, so a partial seed is still usable.
 */

/**
 * @param {object} options
 * @param {{popular: Function, byId: Function}} options.provider
 *   A provider that can list ids (`popular`) and read one (`byId`).
 * @param {(candidate: object) => Promise<{uri: string, created: boolean}|undefined>} options.ingest
 *   The catalog ingest from `createIngest`.
 * @param {number} [options.count] How many records to seed.
 * @param {object} [options.logger] Sink for per-record warnings.
 * @returns {Promise<{requested: number, listed: number, created: number,
 *   updated: number, skipped: number, failed: number, uris: string[]}>}
 */
export async function seedCatalogFromProvider({
  provider,
  ingest,
  count = 10,
  logger = console
} = {}) {
  if (!provider || typeof provider.popular !== 'function' || typeof provider.byId !== 'function') {
    throw new Error('seeding needs a provider with popular() and byId()');
  }
  if (typeof ingest !== 'function') throw new Error('seeding needs an ingest() function');
  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }

  const ids = await provider.popular({ limit: wanted });
  const summary = {
    requested: wanted,
    listed: ids.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    uris: []
  };

  for (const id of ids) {
    try {
      const [candidate] = await provider.byId(id);
      if (!candidate) {
        summary.skipped += 1;
        logger?.warn?.(`worker: seed ${id} listed no record`);
        continue;
      }
      const result = await ingest(candidate);
      if (!result) {
        summary.skipped += 1;
        logger?.warn?.(`worker: seed ${id} carried no identifier`);
        continue;
      }
      if (result.created) summary.created += 1;
      else summary.updated += 1;
      summary.uris.push(result.uri);
    } catch (error) {
      summary.failed += 1;
      logger?.warn?.(`worker: seed ${id} failed — ${error.message}`);
    }
  }

  return summary;
}
