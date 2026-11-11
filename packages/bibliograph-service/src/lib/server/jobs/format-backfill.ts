import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db as defaultDb } from '../db/index';
import {
  editionGoodreadsBackfill,
  editions,
  type EditionRow,
} from '../db/schema';
import { editionRecordCid, rowIdentifiers } from '../edition-record';
import { wireContributorsFor } from './wire-contributors';
import {
  identifierKey,
  isbnValueFromIdentifier,
  providerIdentifier,
  sameIdentifier,
  type Identifier,
} from '../identifiers';
import {
  MAX_IDENTIFIERS,
  mergeIsbnIdentifiers,
} from '../isbn/merge';
import {
  GoodreadsBlockedError,
  fetchGoodreadsBook,
} from '../api/goodreads';

type Db = typeof defaultDb;

export type FormatBackfillStatus =
  | 'updated'          // row written
  | 'no_isbn'          // no ISBN identifier — nothing to look up
  | 'already_complete' // format, pages, publishedYear, language all set — no upstream call
  | 'not_found'        // Goodreads has no book for this ISBN (ledger upserted)
  | 'blocked'          // Goodreads anti-bot (GoodreadsBlockedError); no retry wanted
  | 'no_change'        // upstream fetched, but every field was already filled / identifiers unchanged
  | 'dry_run';         // dry mode: would update, nothing written

export interface FormatBackfillResult {
  status: FormatBackfillStatus;
}

const LANGUAGE_TAGS: Record<string, string> = {
  english: "en",
  german: "de",
  french: "fr",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  swedish: "sv",
  norwegian: "no",
  danish: "da",
  finnish: "fi",
  polish: "pl",
  russian: "ru",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
  arabic: "ar",
  hebrew: "he",
  turkish: "tr",
  czech: "cs",
  greek: "el",
  hungarian: "hu",
  romanian: "ro",
  ukrainian: "uk",
};

function languageTag(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(value)) return value;
  return LANGUAGE_TAGS[value.toLowerCase()];
}

function appendIdentifier(
  identifiers: readonly Identifier[],
  identifier: Identifier,
): Identifier[] {
  if (
    identifiers.length >= MAX_IDENTIFIERS ||
    identifiers.some((current) => sameIdentifier(current, identifier))
  ) {
    return [...identifiers];
  }
  return [...identifiers, identifier];
}

function identifiersChanged(
  before: readonly Identifier[],
  after: readonly Identifier[],
): boolean {
  return (
    before.length !== after.length ||
    before.some((identifier, index) => {
      const next = after[index];
      return !next || identifierKey(identifier) !== identifierKey(next);
    })
  );
}

/** The ISBN a row carries, as the hyphenless ISBN-13 the record stores. */
export function isbnForRow(identifiers: readonly Identifier[]): string | undefined {
  for (const identifier of identifiers) {
    const isbn = isbnValueFromIdentifier(identifier);
    if (isbn) return isbn;
  }
  return undefined;
}

/**
 * Backfill `format`, `pages`, ISBN/ASIN identifiers, `publishedYear` and
 * `language` on one edition row from Goodreads.
 *
 * Writes only fields the row is missing; an explicit call (e.g. the admin
 * button) re-contacts Goodreads even for rows recorded as `not_found` in the
 * `edition_goodreads_backfill` ledger.
 */
export async function backfillEditionMetadata(
  row: EditionRow,
  log: Logger,
  opts?: { dry?: boolean; db?: Db },
): Promise<FormatBackfillResult> {
  const db = opts?.db ?? defaultDb;
  const STAGE = 'backfill-formats';
  // Rows written before the identifier migration still hold the legacy
  // `{ uri, resource }` pair, so normalise once and use that from here on.
  const currentIdentifiers = rowIdentifiers(row.identifiers);
  const rowIsbn = isbnForRow(currentIdentifiers);
  if (!rowIsbn) {
    log.info({ stage: STAGE, uri: row.uri, reason: 'no_isbn' }, 'no ISBN on row; nothing to look up');
    return { status: 'no_isbn' };
  }
  if (
    row.format != null &&
    row.pages != null &&
    row.publishedYear != null &&
    row.language != null
  ) {
    log.info({ stage: STAGE, uri: row.uri, reason: 'already_complete' }, 'edition metadata complete; nothing to do');
    return { status: 'already_complete' };
  }

  let found;
  try {
    found = await fetchGoodreadsBook(rowIsbn);
  } catch (err) {
    if (err instanceof GoodreadsBlockedError) {
      log.error(
        {
          event: 'goodreads-blocked',
          stage: STAGE,
          uri: row.uri,
          isbn: rowIsbn,
          status: err.status,
        },
        'goodreads blocked the backfill',
      );
      return { status: 'blocked' };
    }
    throw err;
  }

  if (!found) {
    log.warn(
      {
        event: 'goodreads-book-not-found',
        stage: STAGE,
        uri: row.uri,
        isbn: rowIsbn,
      },
      'goodreads book not found',
    );
    await db
      .insert(editionGoodreadsBackfill)
      .values({
        uri: row.uri,
        status: 'not_found',
        reason: 'not_found',
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: editionGoodreadsBackfill.uri,
        set: {
          status: 'not_found',
          reason: 'not_found',
          checkedAt: new Date(),
        },
      });
    return { status: 'not_found' };
  }

  const isbnMerge = mergeIsbnIdentifiers(
    currentIdentifiers,
    [found.isbn10, found.isbn13].filter(
      (value): value is string => value !== undefined,
    ),
  );
  let nextIdentifiers = isbnMerge.identifiers;
  if (found.asin) {
    nextIdentifiers = appendIdentifier(nextIdentifiers, {
      type: 'asin',
      value: found.asin,
    });
  }
  // `url` keeps the Goodreads page for display; the stored identity is
  // the provider domain plus the book's own id.
  nextIdentifiers = appendIdentifier(
    nextIdentifiers,
    providerIdentifier('goodreads', found.url),
  );

  const nextFormat = row.format ?? found.format;
  const nextPages = row.pages ?? found.pages;
  const nextPublishedYear = row.publishedYear ?? found.publishedYear;
  const nextLanguage = row.language ?? languageTag(found.language);
  const identifiersMoved = identifiersChanged(
    currentIdentifiers,
    nextIdentifiers,
  );
  const changed =
    (row.format === null && nextFormat != null) ||
    (row.pages === null && nextPages != null) ||
    (row.publishedYear === null && nextPublishedYear != null) ||
    (row.language === null && nextLanguage != null) ||
    identifiersMoved;

  if (!changed) {
    log.info(
      {
        stage: STAGE,
        uri: row.uri,
        isbn: rowIsbn,
        reason: 'already_have_fields',
      },
      'nothing to write',
    );
    return { status: 'no_change' };
  }

  if (opts?.dry) {
    log.info(
      {
        stage: STAGE,
        uri: row.uri,
        isbn: rowIsbn,
        format: nextFormat,
        pages: nextPages,
        publishedYear: nextPublishedYear,
        language: nextLanguage,
        identifiers: nextIdentifiers,
        publisher: found.publisher,
        publishedDate: found.publishedDate,
        genres: found.genres.map((genre) => genre.name),
        contributors: found.contributors,
        source: found.url,
      },
      'dry-run: would update',
    );
    return { status: 'dry_run' };
  }

  const set: Partial<typeof editions.$inferInsert> = {
    format: nextFormat ?? null,
    pages: nextPages ?? null,
    publishedYear: nextPublishedYear ?? null,
    language: nextLanguage ?? null,
    identifiers: nextIdentifiers,
    indexedAt: new Date(),
  };
  // These fields live in the record; changing one must move the CID so
  // a record read and the AppView cannot disagree.
  if (
    (row.pages === null && nextPages != null) ||
    (row.format === null && nextFormat != null) ||
    identifiersMoved ||
    (row.publishedYear === null && nextPublishedYear != null) ||
    (row.language === null && nextLanguage != null)
  ) {
    // `defs#contributor` inlines names, so the strongRefs are expanded
    // the same way the response boundary expands them before hashing.
    const contributors = await wireContributorsFor(db, row.contributors);
    const cid = await editionRecordCid(row, {
      pages: row.pages === null ? nextPages : undefined,
      identifiers: nextIdentifiers,
      publishedYear: nextPublishedYear,
      language: nextLanguage,
      format: nextFormat,
      contributors,
    });
    // `null` means the value is not a valid record (no identifiers),
    // which the ISBN filter above already rules out.
    if (cid) set.cid = cid;
  }
  await db.update(editions).set(set).where(eq(editions.uri, row.uri));
  await db
    .insert(editionGoodreadsBackfill)
    .values({
      uri: row.uri,
      status: 'updated',
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: editionGoodreadsBackfill.uri,
      set: { status: 'updated', reason: null, checkedAt: new Date() },
    });
  log.info(
    {
      stage: STAGE,
      uri: row.uri,
      isbn: rowIsbn,
      format: nextFormat,
      pages: nextPages,
      publishedYear: nextPublishedYear,
      language: nextLanguage,
      identifiers: nextIdentifiers,
      publisher: found.publisher,
      publishedDate: found.publishedDate,
      genres: found.genres.map((genre) => genre.name),
      contributors: found.contributors,
      source: found.url,
    },
    'edition metadata backfilled',
  );
  return { status: 'updated' };
}
