#!/usr/bin/env tsx
//
// Backfill edition display metadata from Goodreads: `format`, `pages`,
// ISBN-10/13 and ASIN identifiers, `publishedYear`, and the BCP-47 `language`.
// Genres, publisher, publication date, and contributor portraits are parsed and
// logged, but not yet stored because the edition schema has no column for them.
//
// Provider APIs are preferred, but Google-only editions carry no binding at all
// and OpenLibrary does not always expose one. Goodreads publishes both in the
// book page's `p[data-testid="pagesFormat"]` field. This is a manually-run
// backfill, not a request-path scrape: Goodreads is HTML and can change or
// rate-limit without warning.
//
//   pnpm backfill:formats                 # scan editions missing metadata
//   pnpm backfill:formats -- --dry        # log without writing
//   pnpm backfill:formats -- --limit=50
//   pnpm backfill:formats -- --isbn=9780691176512
//
// Requires DATABASE_URL.
//

import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../src/lib/server/db/index";
import {
  editionGoodreadsBackfill,
  editions,
} from "../src/lib/server/db/schema";
import { createLogger } from "../src/lib/server/logger";
import { editionRecordCid } from "../src/lib/server/edition-record";
import {
  GoodreadsBlockedError,
  fetchGoodreadsBook,
} from "../src/lib/server/api/goodreads";
import {
  MAX_IDENTIFIERS,
  isbnFromIdentifier,
  mergeIsbnIdentifiers,
  normaliseIsbn,
} from "../src/lib/server/isbn/merge";
import { ProgressBar } from "./lib/progress";
import type { EditionRow } from "../src/lib/server/db/schema";
import type { Identifier } from "../src/lib/server/search/types";

const PAGE_SIZE = 50;
const REQUEST_SPACING_MS = 1_000;
/** Stop a run once this share of attempted rows has failed or gone missing. */
const FAILURE_LIMIT = 0.8;
const MIN_FAILURE_SAMPLE = 20;

const HAS_ISBN = sql`EXISTS (
  SELECT 1 FROM jsonb_array_elements(${editions.identifiers}) elem
   WHERE elem->>'uri' LIKE 'isbn:%'
)`;

const NOT_KNOWN_MISSING = sql`NOT EXISTS (
  SELECT 1 FROM edition_goodreads_backfill b
   WHERE b.uri = ${editions.uri} AND b.status = 'not_found'
)`;

const MISSING = and(
  HAS_ISBN,
  NOT_KNOWN_MISSING,
  or(
    isNull(editions.format),
    isNull(editions.pages),
    isNull(editions.publishedYear),
    isNull(editions.language),
  ),
)!;

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
    identifiers.some((current) => current.uri === identifier.uri)
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
    before.some((identifier, index) => identifier.uri !== after[index]?.uri)
  );
}

function isbnForRow(row: EditionRow): string | undefined {
  for (const identifier of row.identifiers ?? []) {
    const isbn = isbnFromIdentifier(identifier);
    if (isbn?.length === 13) return isbn;
  }
  for (const identifier of row.identifiers ?? []) {
    const isbn = isbnFromIdentifier(identifier);
    if (isbn) return isbn;
  }
  return undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const limitArg = args
    .find((arg) => arg.startsWith("--limit="))
    ?.slice("--limit=".length);
  const hardLimit = limitArg ? Number(limitArg) : undefined;
  const isbnArg = args
    .find((arg) => arg.startsWith("--isbn="))
    ?.slice("--isbn=".length);
  const isbn = isbnArg ? normaliseIsbn(isbnArg) : undefined;
  const log = createLogger("worker");

  const isbnFilter = isbn
    ? sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements(${editions.identifiers}) elem
         WHERE elem->>'uri' = ${`isbn:${isbn}`}
      )`
    : undefined;
  const filter = isbnFilter ? and(MISSING, isbnFilter)! : MISSING;

  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(editions)
    .where(filter as unknown as SQL);
  const outstanding = Number(counted?.count ?? 0);
  const bar = new ProgressBar(
    "[backfill-formats]",
    hardLimit === undefined ? outstanding : Math.min(outstanding, hardLimit),
  );

  let total = 0;
  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  let blocked = 0;
  let failed = 0;
  let stopped: "failure-threshold" | "blocked" | null = null;
  let cursor: string | null = null;

  const failureRate = (): number =>
    total > 0 ? (notFound + failed) / total : 0;
  const stopForFailures = (): boolean => {
    if (total < MIN_FAILURE_SAMPLE || failureRate() < FAILURE_LIMIT) {
      return false;
    }
    stopped = "failure-threshold";
    log.error(
      {
        event: "backfill-failure-threshold",
        stage: "backfill-formats",
        total,
        notFound,
        failed,
        failureRate: failureRate(),
      },
      "failure rate reached the backfill limit; stopping",
    );
    return true;
  };

  run: for (;;) {
    if (hardLimit !== undefined && total >= hardLimit) break;
    const pageSize =
      hardLimit !== undefined
        ? Math.min(PAGE_SIZE, hardLimit - total)
        : PAGE_SIZE;
    const pageFilter: SQL | undefined = cursor
      ? and(filter, sql`${editions.uri} > ${cursor}`)
      : filter;
    const rows: EditionRow[] = await db
      .select()
      .from(editions)
      .where(pageFilter as unknown as SQL)
      .orderBy(asc(editions.uri))
      .limit(pageSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.uri;
      total += 1;
      const rowIsbn = isbnForRow(row);
      if (!rowIsbn) {
        skipped += 1;
        bar.advance();
        continue;
      }

      try {
        const found = await fetchGoodreadsBook(rowIsbn);
        if (!found) {
          skipped += 1;
          notFound += 1;
          log.warn(
            {
              event: "goodreads-book-not-found",
              stage: "backfill-formats",
              uri: row.uri,
              isbn: rowIsbn,
            },
            "goodreads book not found",
          );
          await db
            .insert(editionGoodreadsBackfill)
            .values({
              uri: row.uri,
              status: "not_found",
              reason: "not_found",
              checkedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: editionGoodreadsBackfill.uri,
              set: {
                status: "not_found",
                reason: "not_found",
                checkedAt: new Date(),
              },
            });
          bar.advance();
          if (stopForFailures()) break run;
          if (hardLimit !== undefined && total >= hardLimit) break;
          if (total < outstanding) await sleep(REQUEST_SPACING_MS);
          continue;
        }

        const isbnMerge = mergeIsbnIdentifiers(
          row.identifiers,
          [found.isbn10, found.isbn13].filter(
            (value): value is string => value !== undefined,
          ),
        );
        let nextIdentifiers = isbnMerge.identifiers;
        if (found.asin) {
          nextIdentifiers = appendIdentifier(nextIdentifiers, {
            uri: `asin:${found.asin}`,
            resource: "asin",
          });
        }
        nextIdentifiers = appendIdentifier(nextIdentifiers, {
          uri: found.url,
          resource: "goodreads",
        });

        const nextFormat = row.format ?? found.format;
        const nextPages = row.pages ?? found.pages;
        const nextPublishedYear = row.publishedYear ?? found.publishedYear;
        const nextLanguage = row.language ?? languageTag(found.language);
        const identifiersMoved = identifiersChanged(
          row.identifiers,
          nextIdentifiers,
        );
        const changed =
          (row.format === null && nextFormat != null) ||
          (row.pages === null && nextPages != null) ||
          (row.publishedYear === null && nextPublishedYear != null) ||
          (row.language === null && nextLanguage != null) ||
          identifiersMoved;

        if (!changed) {
          skipped += 1;
          log.info(
            {
              stage: "backfill-formats",
              uri: row.uri,
              isbn: rowIsbn,
              reason: "already_have_fields",
            },
            "nothing to write",
          );
        } else if (dry) {
          skipped += 1;
          log.info(
            {
              stage: "backfill-formats",
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
            "dry-run: would update",
          );
        } else {
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
            identifiersMoved ||
            (row.publishedYear === null && nextPublishedYear != null) ||
            (row.language === null && nextLanguage != null)
          ) {
            set.cid = await editionRecordCid(row, {
              pages: row.pages === null ? nextPages : undefined,
              identifiers: nextIdentifiers,
              publishedYear: nextPublishedYear,
              language: nextLanguage,
            });
          }
          await db.update(editions).set(set).where(eq(editions.uri, row.uri));
          await db
            .insert(editionGoodreadsBackfill)
            .values({
              uri: row.uri,
              status: "updated",
              checkedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: editionGoodreadsBackfill.uri,
              set: { status: "updated", reason: null, checkedAt: new Date() },
            });
          updated += 1;
          log.info(
            {
              stage: "backfill-formats",
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
            "edition metadata backfilled",
          );
        }
      } catch (err) {
        if (err instanceof GoodreadsBlockedError) {
          blocked += 1;
          stopped = "blocked";
          log.error(
            {
              event: "goodreads-blocked",
              status: err.status,
              stage: "backfill-formats",
              uri: row.uri,
              isbn: rowIsbn,
            },
            "goodreads blocked the backfill; stopping",
          );
          break run;
        }
        failed += 1;
        log.error(
          { stage: "backfill-formats", err, uri: row.uri, isbn: rowIsbn },
          "update failed",
        );
        if (stopForFailures()) break run;
      }
      bar.advance();
      if (hardLimit !== undefined && total >= hardLimit) break;
      if (total < outstanding) await sleep(REQUEST_SPACING_MS);
    }
  }

  bar.finish();
  const summary = {
    stage: "backfill-formats:summary",
    total,
    updated,
    skipped,
    notFound,
    blocked,
    failed,
    failureRate: failureRate(),
    stopped,
    dry,
  };
  console.log(JSON.stringify(summary));
  log.info(summary, "backfill-formats done");
  process.exit(failed > 0 || blocked > 0 || stopped ? 1 : 0);
}

main().catch((err) => {
  console.error("backfill-formats crashed:", err);
  process.exit(2);
});
