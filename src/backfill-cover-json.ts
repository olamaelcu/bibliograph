#!/usr/bin/env node
import { sql } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
import { logger } from './logger.js';
import { coverFromUrl } from './cover-types.js';
import { runCoverWorker } from './cover-worker.js';

interface Row {
  uri: string;
  coverUrl: string;
}

async function backfillBooksAndShelves(): Promise<void> {
  const bookRows = db.all<Row>(sql`
    SELECT uri, coverUrl FROM books
    WHERE coverUrl IS NOT NULL
      AND (cover IS NULL OR json_extract(cover, '$.medium') IS NULL)
  `);
  const shelfRows = db.all<Row>(sql`
    SELECT uri, coverUrl FROM shelves
    WHERE coverUrl IS NOT NULL
      AND (cover IS NULL OR json_extract(cover, '$.medium') IS NULL)
  `);

  logger.info({ books: bookRows.length, shelves: shelfRows.length }, 'cover backfill: starting');

  for (const row of bookRows) {
    const cover = coverFromUrl(row.coverUrl, 'openlibrary');
    db.update(schema.books).set({ cover }).where(sql`${schema.books.uri} = ${row.uri}`).run();
  }
  for (const row of shelfRows) {
    const cover = coverFromUrl(row.coverUrl, 'openlibrary');
    db.update(schema.shelves).set({ cover }).where(sql`${schema.shelves.uri} = ${row.uri}`).run();
  }

  logger.info({ books: bookRows.length, shelves: shelfRows.length }, 'cover backfill: cover JSON populated');
  console.log(JSON.stringify({ books: bookRows.length, shelves: shelfRows.length }, null, 2));
}

async function main(): Promise<void> {
  await backfillBooksAndShelves();
  const worker = await runCoverWorker(db, { batchSize: 50 });
  logger.info(worker, 'cover backfill: worker pass complete');
  console.log(JSON.stringify(worker, null, 2));
}

main().catch((err) => {
  logger.fatal({ err }, 'cover backfill failed');
  process.exit(1);
});
