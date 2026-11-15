/**
 * Import Bookhive's catalog into the edition catalog.
 *
 * Bookhive's reader records name a book by `hiveId` (`bk_…`), never by an
 * edition or an ISBN, so the only way a Bookhive record can be read as a
 * Bibliograph one is for every `hiveId` to resolve to an edition. That is what
 * this walk creates: it pages Bookhive's own `buzz.bookhive.catalogBook`
 * collection out of its PDS and feeds each book through the normal catalog
 * ingest, which records `(bookhive.buzz, hiveId)` as one of the edition's
 * identifiers and adds the ISBN/Goodreads pairs the book carries.
 *
 * Identity is the identifier bag, not the record: a catalog book whose ISBN
 * already names an edition (a Google Books one, say) lands on that edition and
 * only gains the `bookhive.buzz` pair; a book with no ISBN becomes an edition
 * of its own. Re-running is therefore safe — the second pass finds each
 * candidate's identifier set already present and skips it.
 *
 * The lexicons are Bookhive's, not ours: `buzz.bookhive.catalogBook` and the
 * `buzz.bookhive.defs#bookIdentifiers` object it refs.
 */

import { fetchJson } from './providers/http.js';
import { isbn13 as normalizeIsbn13, stripHtml } from './util.js';

/** Bookhive's own repo; its catalog books live here, not in reader repos. */
export const BOOKHIVE_REPO = 'did:plc:enu2j5xjlqsjaylv3du4myh4';
export const BOOKHIVE_CATALOG_COLLECTION = 'buzz.bookhive.catalogBook';
/** The identifier issuer the hive ids are catalogued under. */
export const BOOKHIVE_ISSUER = 'bookhive.buzz';

/**
 * Bookhive's PDS: the host of the catalog records, and where `listRecords` is
 * served. `BOOKHIVE_PDS_URL` overrides it when the instance moves.
 */
export function bookhivePdsUrl(env = process.env) {
  return (env.BOOKHIVE_PDS_URL ?? '').trim() || 'https://bluesky.nickthesick.com';
}

/**
 * In-memory counters for the walk, rendered by the metrics endpoint.
 *
 * The walk is one job in one process, so a process-local counter is the whole
 * history since boot; the durable record is `edition_identifiers` itself (the
 * `bibliograph_catalog_bookhive_editions` gauge reads that). The endpoint reads
 * a snapshot on scrape, so a counter never needs a scrape to exist to be
 * counted.
 */
export function createBookhiveMetrics() {
  /** @type {Map<string, { result: string, count: number }>} */
  const counts = new Map();

  return {
    /** Count one event. `result` is one of this file's own branches. */
    record(result) {
      const existing = counts.get(result);
      if (existing) {
        existing.count += 1;
        return;
      }
      counts.set(result, { result, count: 1 });
    },

    /** Sorted, copy-on-read view for the exposition; safe across scrapes. */
    snapshot() {
      return [...counts.values()]
        .map((entry) => ({ ...entry }))
        .sort((a, b) => a.result.localeCompare(b.result));
    }
  };
}

/** A hive id as Bookhive mints it: `bk_` plus an alphanumeric body. */
const HIVE_ID = /^bk_[A-Za-z0-9]{6,}$/;

/**
 * Authors are a tab-separated list (Bookhive's `parseAuthors`); older and
 * hand-written rows also use commas, semicolons, ampersands or `and`.
 */
const AUTHOR_SEPARATORS = /\s*(?:[\t;&]|\band\b)\s*|,\s*/i;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Bookhive stores a human-readable language name ("English", "Dutch; Flemish"),
 * not a tag; the edition lexicon wants BCP 47. The catalog already carries every
 * two-letter code the alias table knows, so the name -> tag table is derived
 * from ICU rather than hand-written: `Intl.DisplayNames` renders each code, and
 * the first `;`-separated name (`Dutch; Flemish`) is the key.
 *
 * @param {string[]} codes Two-letter language codes, e.g. `select distinct language from language_aliases`.
 * @returns {Map<string, string>} lowercased display name -> code
 */
export function languageTags(codes) {
  const names = new Map();
  const display = new Intl.DisplayNames(['en'], { type: 'language' });
  for (const code of Array.isArray(codes) ? codes : []) {
    if (typeof code !== 'string' || !/^[a-z]{2,3}$/.test(code)) continue;
    let name;
    try {
      name = display.of(code);
    } catch {
      continue;
    }
    if (typeof name !== 'string' || name === '') continue;
    const key = name.toLowerCase().split(';')[0].trim();
    if (key !== '' && !names.has(key)) names.set(key, code);
  }
  return names;
}

/**
 * The language codes the catalog's alias table knows, for `languageTags`.
 * One small read per import run; a failure is not worth aborting the walk for
 * (the walk still imports everything else), so it degrades to no language.
 */
export async function loadLanguageTags(pool, logger = console) {
  try {
    const result = await pool.query(
      'SELECT DISTINCT language FROM language_aliases ORDER BY language'
    );
    return languageTags(result.rows.map((row) => row.language));
  } catch (error) {
    logger?.warn?.(`catalog.bookhive: no language table (${error.message}); languages dropped`);
    return new Map();
  }
}

/**
 * `defs#series` for Bookhive's series field, or undefined when it names none.
 *
 * Bookhive stores Goodreads' series object as a JSON *string*:
 * `{"title":"Psmith","position":"2","webUrl":"https://www.goodreads.com/series/..."}`.
 * Older and hand-written rows hold the bare name instead, so both shapes are
 * accepted. `position` is only kept when it is the decimal string the lexicon
 * wants (Goodreads also writes `1.1` and the empty string).
 */
function seriesOf(value) {
  const objectForm =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const raw = trimmed(value);
  if (objectForm === null && raw === '') return undefined;

  let parsed = objectForm;
  if (parsed === null && raw.startsWith('{')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  const fields = parsed !== null && typeof parsed === 'object' ? parsed : {};
  // A bare name is the whole series; a parsed object names it in `title`.
  const name = trimmed(fields.title) || trimmed(fields.name) || raw;
  if (name === '' || name.startsWith('{')) return undefined;

  const series = { name };
  const position = trimmed(fields.position);
  if (/^\d+(\.\d+)?$/.test(position)) series.position = position;
  return series;
}

/** A BCP 47 tag for Bookhive's language name, or undefined when it is unknown. */
function languageTag(value, languages) {
  const name = trimmed(value);
  if (name === '') return undefined;
  // Some rows already hold a tag (`en`, `en-US`); keep it rather than dropping it.
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(name)) return name.toLowerCase();
  const key = name.toLowerCase().split(';')[0].trim();
  return languages?.get(key);
}

/**
 * One `buzz.bookhive.catalogBook` record as an ingest candidate.
 *
 * The catalog book is the only place a Bookhive hive id carries metadata, so
 * whatever it has is passed on: description, page count, language, publication
 * year, publisher and series. `sourceIdentifier` tells ingest that all of it
 * describes the `bookhive.buzz` identifier — an edition matched by ISBN keeps
 * its own provider's claims and publisher credit instead of being overwritten.
 *
 * Returns `null` for anything that cannot be catalogued: a missing or
 * hand-written hive id, or a title that is empty once trimmed. `coverUrl` is the
 * full-size cover when present, else the thumbnail.
 */
export function parseCatalogBook(value, { languages } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value;
  const hiveId = trimmed(record.id);
  if (!HIVE_ID.test(hiveId)) return null;
  const title = trimmed(record.title);
  if (title === '') return null;

  const identifiers = [{ issuer: BOOKHIVE_ISSUER, value: hiveId }];
  const supplied =
    record.identifiers !== null &&
    typeof record.identifiers === 'object' &&
    !Array.isArray(record.identifiers)
      ? record.identifiers
      : {};
  const isbn = normalizeIsbn13(supplied.isbn13 ?? supplied.isbn10);
  if (isbn !== null) identifiers.push({ issuer: 'isbn13', value: isbn });
  const goodreads = trimmed(supplied.goodreadsId);
  if (goodreads !== '') identifiers.push({ issuer: 'goodreads', value: goodreads });

  const contributors = (typeof record.authors === 'string' ? record.authors : '')
    .split(AUTHOR_SEPARATORS)
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => ({ name }));

  const coverUrl = trimmed(record.cover) || trimmed(record.thumbnail);
  const candidate = { hiveId, title, identifiers, contributors };
  if (coverUrl !== '') candidate.coverUrl = coverUrl;

  // Bookhive copies provider blurbs verbatim, so they arrive with HTML in them
  // (`<i>The Faerie Queene</i> …`). Google Books' descriptions are stripped the
  // same way: a description is plain text in this catalog.
  const description = trimmed(stripHtml(record.description) ?? '');
  if (description !== '') candidate.description = description;
  // `numPages` is a count of print pages; the claim's `pages` is the same unit.
  if (Number.isInteger(record.numPages) && record.numPages > 0) {
    candidate.pages = record.numPages;
  }
  const language = languageTag(record.language, languages);
  if (language !== undefined) candidate.language = language;
  // `publicationYear` is a bare year; the lexicon wants ISO 8601 at its known
  // precision, and a year alone is that.
  if (Number.isInteger(record.publicationYear) && record.publicationYear > 0 && record.publicationYear <= 9999) {
    candidate.publishedDate = String(record.publicationYear);
  }
  const publisher = trimmed(record.publisher);
  if (publisher !== '') candidate.publisher = { name: publisher };
  // The series lives on the edition, not on a claim: it names the work's place
  // in a series, which every identifier of the edition shares.
  const series = seriesOf(record.series);
  if (series !== undefined) candidate.series = series;
  candidate.sourceIdentifier = { issuer: BOOKHIVE_ISSUER, value: hiveId };
  return candidate;
}

/**
 * One page of `com.atproto.repo.listRecords` over the catalog collection.
 *
 * `records` are the record bodies; `cursor` is absent on the last page.
 * Listing needs no auth: the collection is public data on a public PDS.
 */
export async function fetchCatalogPage({
  cursor,
  limit = 100,
  fetchImpl = fetch,
  pdsUrl = bookhivePdsUrl()
} = {}) {
  const params = new URLSearchParams({
    repo: BOOKHIVE_REPO,
    collection: BOOKHIVE_CATALOG_COLLECTION,
    limit: String(limit)
  });
  if (typeof cursor === 'string' && cursor !== '') params.set('cursor', cursor);

  const body = await fetchJson(
    fetchImpl,
    `${pdsUrl.replace(/\/+$/, '')}/xrpc/com.atproto.repo.listRecords?${params}`,
    {},
    30_000
  );
  const records = Array.isArray(body?.records) ? body.records : [];
  return {
    records: records
      .map((entry) => (entry !== null && typeof entry === 'object' ? entry.value : null))
      .filter((value) => value !== null && typeof value === 'object'),
    cursor: typeof body?.cursor === 'string' && body.cursor !== '' ? body.cursor : undefined
  };
}

/**
 * Which of a page's hive ids already live on an edition, and with which
 * identifier pairs.
 *
 * One query for the whole page: the sub-select finds the editions owning any of
 * the hive ids, the outer one reads every identifier of those editions. The
 * result answers both the hive id -> edition question and the skip test.
 *
 * @returns {Promise<Map<string, {uri: string, pairs: Set<string>}>>}
 */
async function knownEditions(pool, hiveIds) {
  const known = new Map();
  if (hiveIds.length === 0) return known;

  const result = await pool.query(
    // The edition's identifier pairs, plus what the hive id's claim row and the
    // edition already hold: a complete identifier set is not enough to skip a
    // book whose metadata the catalog has since gained (or corrected), or the
    // first version of the importer would freeze an edition forever.
    `SELECT i.edition_uri, i.issuer, i.value,
            info.description, info.language, info.published_date, info.pages,
            e.series->>'name' AS series_name,
            EXISTS (
              SELECT 1 FROM edition_identifier_publishers p
               WHERE p.edition_uri = i.edition_uri
                 AND p.issuer = $2
                 AND p.value = i.value
            ) AS has_publisher
       FROM edition_identifiers i
       JOIN editions e ON e.uri = i.edition_uri
       LEFT JOIN edition_identifier_info info
              ON info.edition_uri = i.edition_uri
             AND info.issuer = i.issuer
             AND info.value = i.value
      WHERE i.edition_uri IN (
        SELECT edition_uri FROM edition_identifiers
         WHERE issuer = $2 AND value = ANY($1::text[])
      )`,
    [hiveIds, BOOKHIVE_ISSUER]
  );

  // hive id -> edition comes from the rows that carry the hive id itself; every
  // other row of that edition belongs to the same map entry.
  const editionByHiveId = new Map();
  const hiveIdByEdition = new Map();
  for (const row of result.rows) {
    if (row.issuer !== BOOKHIVE_ISSUER || !hiveIds.includes(row.value)) continue;
    editionByHiveId.set(row.value, row.edition_uri);
    hiveIdByEdition.set(row.edition_uri, row.value);
  }
  for (const row of result.rows) {
    const hiveId = hiveIdByEdition.get(row.edition_uri);
    if (!known.has(hiveId)) {
      known.set(hiveId, {
        uri: editionByHiveId.get(hiveId),
        pairs: new Set(),
        claims: {},
        seriesName: null,
        hasPublisher: false
      });
    }
    const entry = known.get(hiveId);
    entry.pairs.add(`${row.issuer}\u0000${row.value}`);
    if (row.issuer === BOOKHIVE_ISSUER && row.value === hiveId) {
      entry.claims = {
        description: row.description,
        language: row.language,
        publishedDate: row.published_date,
        pages: row.pages
      };
      entry.seriesName = row.series_name;
      entry.hasPublisher = row.has_publisher === true;
    }
  }
  return known;
}

/**
 * Whether this book is already in the catalog exactly as the record describes
 * it: every identifier present, every claim the record carries already stored,
 * and its series and a publisher credit in place. Anything short of that
 * re-ingests, so a field a later version of this importer starts carrying still
 * reaches an edition imported before. A value that changed upstream does not:
 * ingest fills a missing claim and never overwrites a stored one.
 */
function alreadyImported(existing, candidate) {
  if (existing === undefined) return false;
  const pairsComplete = candidate.identifiers.every((identifier) =>
    existing.pairs.has(`${identifier.issuer}\u0000${identifier.value}`)
  );
  if (!pairsComplete) return false;

  const claims = existing.claims ?? {};
  const sameClaim = (carried, stored) => {
    // A claim the record does not carry says nothing about the stored one.
    if (carried === undefined) return true;
    if (stored === null || stored === undefined) return false;
    return String(stored) === String(carried);
  };
  if (!sameClaim(candidate.description, claims.description)) return false;
  if (!sameClaim(candidate.language, claims.language)) return false;
  if (!sameClaim(candidate.publishedDate, claims.publishedDate)) return false;
  if (!sameClaim(candidate.pages, claims.pages)) return false;
  if (candidate.series !== undefined && existing.seriesName !== candidate.series.name) {
    return false;
  }
  if (candidate.publisher !== undefined && existing.hasPublisher !== true) return false;
  return true;
}

/**
 * Walk the catalog and ingest every book.
 *
 * Per-record failures are counted and logged, never fatal: a page with one bad
 * record must not abandon the walk, and a re-run resumes from the first page
 * with the finished records already skipped.
 *
 * @param {object} options
 * @param {{query: Function}} options.pool Postgres pool (reads identifier sets).
 * @param {(candidate: object) => Promise<{uri: string, created: boolean}|undefined>} options.ingest
 *   The catalog ingest from `createIngest`.
 * @param {Function} [options.fetchImpl] `fetch` seam for tests.
 * @param {number} [options.pages] Page budget; the walk also stops at the last page.
 * @param {string} [options.pdsUrl] Overrides the PDS host.
 * @param {object} [options.logger] Sink for per-record warnings.
 * @returns {Promise<{pages: number, seen: number, skipped: number, created: number,
 *   updated: number, failed: number, cursor?: string}>}
 */
export async function importBookhiveCatalog({
  pool,
  ingest,
  fetchImpl = fetch,
  pages = 100,
  pdsUrl = bookhivePdsUrl(),
  logger = console,
  metrics = null,
  // A graceful shutdown stops between pages: the walk is idempotent, so the
  // next run re-reads from page 1 and skips what is already stored.
  signal = null
} = {}) {
  if (typeof ingest !== 'function') {
    throw new Error('importing the catalog needs an ingest() function');
  }
  const pageBudget = Number(pages);
  if (!Number.isInteger(pageBudget) || pageBudget < 1) {
    throw new Error(`pages must be a positive integer, got ${pages}`);
  }

  // Counted before the first request: a run that dies mid-walk is still an
  // attempted run on the dashboard.
  metrics?.record?.('run');

  // Derived once for the whole walk: Bookhive writes language names, and the
  // catalog's alias table is the authoritative set of codes to map them onto.
  const languages = await loadLanguageTags(pool, logger);

  const summary = { pages: 0, seen: 0, skipped: 0, created: 0, updated: 0, failed: 0 };
  let cursor;

  // One bump for both the returned summary and the scrape counters, so the two
  // can never disagree about what the run did.
  const count = (field) => {
    summary[field] += 1;
    metrics?.record?.(field);
  };

  while (summary.pages < pageBudget) {
    if (signal?.aborted === true) break;
    const page = await fetchCatalogPage({ cursor, fetchImpl, pdsUrl });
    count('pages');
    summary.seen += page.records.length;

    const candidates = [];
    for (const value of page.records) {
      const candidate = parseCatalogBook(value, { languages });
      if (candidate === null) {
        count('failed');
        logger?.warn?.(`catalog.bookhive: uncataloguable record (id=${trimmed(value.id)})`);
        continue;
      }
      candidates.push(candidate);
    }

    const known = await knownEditions(
      pool,
      candidates.map((candidate) => candidate.hiveId)
    );

    for (const candidate of candidates) {
      // A page is ~100 books and each ingest is a transaction, so a shutdown
      // must be able to land mid-page as well as between pages.
      if (signal?.aborted === true) break;
      const existing = known.get(candidate.hiveId);
      if (alreadyImported(existing, candidate)) {
        count('skipped');
        continue;
      }
      try {
        const result = await ingest(candidate);
        if (!result) {
          count('skipped');
          continue;
        }
        count(result.created ? 'created' : 'updated');
      } catch (error) {
        count('failed');
        logger?.warn?.(`catalog.bookhive ${candidate.hiveId} failed — ${error.message}`);
      }
    }

    cursor = page.cursor;
    if (cursor === undefined) break;
  }

  if (cursor !== undefined) summary.cursor = cursor;
  return summary;
}
