#!/usr/bin/env tsx
//
// Backfill edition display metadata from Goodreads: `format`, `pages`,
// ISBN-10/13 and ASIN identifiers, `publishedYear`, and the BCP-47 `language`.
// Genres, publisher, publication date, and contributor portraits are parsed and
// logged, but not yet stored because the edition schema has no column for them.
//
// Provider APIs are preferred, but Google-only editions carry no binding at all
// and ISBNdb does not always expose one. Goodreads publishes both in the
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

import { and, asc, isNull, or, sql, type SQL } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../src/lib/server/db/index";
import { editions } from "../src/lib/server/db/schema";
import { createLogger } from "../src/lib/server/logger";
import { loadEditionIdentifiers } from "../src/lib/server/edition-record";
import {
  backfillEditionMetadata,
  isbnForRow,
} from "../src/lib/server/jobs/format-backfill";
import { isbn13FromAny } from "../src/lib/server/identifiers";
import { ProgressBar } from "./lib/progress";
import type { EditionRow } from "../src/lib/server/db/schema";

const PAGE_SIZE = 50;
const REQUEST_SPACING_MS = 1_000;
/** Stop a run once this share of attempted rows has failed or gone missing. */
const FAILURE_LIMIT = 0.8;
const MIN_FAILURE_SAMPLE = 20;

const HAS_ISBN = sql`EXISTS (
  SELECT 1 FROM edition_identifiers i
   WHERE i.edition_uri = ${editions.uri} AND i.issuer = 'isbn13'
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
    isNull(editions.publishedDate),
    isNull(editions.language),
  ),
)!;

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
  const isbn = isbnArg ? isbn13FromAny(isbnArg) : undefined;
  const log = createLogger("worker");

  const isbnFilter = isbn
    ? sql`EXISTS (
        SELECT 1 FROM edition_identifiers i
         WHERE i.edition_uri = ${editions.uri} AND i.issuer = 'isbn13' AND i.value = ${isbn}
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
      // Rows written before the identifier migration still hold the legacy
      // `{ uri, resource }` pair, so normalise once and use that from here on.
      const currentIdentifiers = await loadEditionIdentifiers(row.uri);
      const rowIsbn = isbnForRow(currentIdentifiers);
      if (rowIsbn) {
        try {
          const res = await backfillEditionMetadata(row, log, { dry: dry });
          if (res.status === 'not_found') { notFound += 1; if (stopForFailures()) break run; }
          else if (res.status === 'already_complete' || res.status === 'no_isbn' || res.status === 'no_change' || res.status === 'dry_run') { skipped += 1; }
          else if (res.status === 'updated') { updated += 1; }
          else if (res.status === 'blocked') {
            blocked += 1;
            stopped = 'blocked';
            break run;
          }
        } catch (err) {
          failed += 1;
          log.error({ stage: 'backfill-formats', err, uri: row.uri, isbn: rowIsbn }, 'update failed');
          if (stopForFailures()) break run;
        }
      } else {
        skipped += 1;
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
