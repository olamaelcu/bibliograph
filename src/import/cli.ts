#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/connection.js';
import { runDumpImport } from './dump-runner.js';
import {
  mapAuthorToCandidate,
  mapEditionToCandidates,
  mapWorkToCandidate,
  olKeyOf,
} from './mappers/openlibrary.js';
import { hydrateBookContributorsFromEdition } from './book-contributors.js';
import { logger } from '../logger.js';
import { ProgressBar } from './progress.js';

const OL_EDITIONS_URL = process.env.OL_EDITIONS_DUMP_URL ?? 'https://openlibrary.org/data/ol_dump_editions_latest.txt.gz';
const OL_WORKS_URL = process.env.OL_WORKS_DUMP_URL ?? 'https://openlibrary.org/data/ol_dump_works_latest.txt.gz';
const OL_AUTHORS_URL = process.env.OL_AUTHORS_DUMP_URL ?? 'https://openlibrary.org/data/ol_dump_authors_latest.txt.gz';

const mbFormat = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Run a dump import with shared terminal progress bars: one for the download
 * (bytes, labelled "download") and one for the import phase (records). Both are
 * finalised with a newline when the run ends so later log lines don't collide
 * with the \r render.
 */
async function runWithProgress<T>(
  label: string,
  run: (onDownload: (r: number, t: number | null) => void, onImport: (p: number, t: number | null) => void) => Promise<T>,
): Promise<T> {
  const download = new ProgressBar({ label: `${label} download`, format: mbFormat });
  const importBar = new ProgressBar({ label: `${label} import` });
  try {
    return await run(
      (received, total) => download.update(received, total),
      (processed, total) => importBar.update(processed, total),
    );
  } finally {
    download.done();
    importBar.done();
  }
}

const USAGE =
  'usage: tsx src/import/cli.ts openlibrary:dump|works:dump|contributors:dump|bookhive:catalog|images:refresh [--no-download] [--reset] [--keep-dump] [--path=DIR] [--batch-size=N]';

interface Flags {
  noDownload: boolean;
  reset: boolean;
  keepDump: boolean;
  dumpPath?: string;
  batchSize?: number;
  unknown: string[];
}

function parseFlags(rest: string[]): Flags {
  const f: Flags = { noDownload: false, reset: false, keepDump: false, unknown: [] };
  for (const arg of rest) {
    if (arg === '--no-download') f.noDownload = true;
    else if (arg === '--reset') f.reset = true;
    else if (arg === '--keep-dump') f.keepDump = true;
    else if (arg.startsWith('--path=')) f.dumpPath = arg.slice('--path='.length);
    else if (arg.startsWith('--batch-size=')) {
      f.batchSize = Number(arg.slice('--batch-size='.length));
      if (Number.isNaN(f.batchSize)) {
        throw new Error(`invalid --batch-size value: ${arg.slice('--batch-size='.length)}`);
      }
    } else f.unknown.push(arg);
  }
  return f;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const [cmd, ...rest] = args;
  const flags = parseFlags(rest);
  if (flags.unknown.length > 0) logger.warn({ unknown: flags.unknown }, 'ignoring unknown flags');

  if (cmd === 'openlibrary:dump') {
    const s = await runWithProgress('ol-editions', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-editions', url: OL_EDITIONS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        parse: (fields) => mapEditionToCandidates(JSON.parse(fields[4])),
        hydrate: (fields) => {
          const rec = JSON.parse(fields[4]) as { key: string; authors?: Array<{ key?: string }> };
          hydrateBookContributorsFromEdition(db, rec.key, rec.authors ?? []);
        },
      }),
    );
    logger.info(s, 'editions import done');
  } else if (cmd === 'works:dump') {
    const s = await runWithProgress('ol-works', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-works', url: OL_WORKS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        parse: (fields) => [mapWorkToCandidate(JSON.parse(fields[4]))],
      }),
    );
    logger.info(s, 'works import done');
  } else if (cmd === 'contributors:dump') {
    const s = await runWithProgress('ol-authors', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-authors', url: OL_AUTHORS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        parse: (fields) => [mapAuthorToCandidate(JSON.parse(fields[4]))],
      }),
    );
    logger.info(s, 'contributors import done');
  } else if (cmd === 'bookhive:catalog') {
    const { importBookhiveCatalog } = await import('./bookhive/importer.js');
    const s = await importBookhiveCatalog({ db, reset: flags.reset, limit: flags.batchSize });
    logger.info(s, 'bookhive catalog import done');
  } else if (cmd === 'images:refresh') {
    const { BlobStore, blobStoreConfigFromEnv } = await import('../storage/store.js');
    const { fetchBookCover, fetchContributorPortrait } = await import('../images/fetch.js');
    const { and, eq, isNull } = await import('drizzle-orm');
    const { bookIdentifiers, books, contributors } = await import('../db/schema.js');

    const store = new BlobStore(db, blobStoreConfigFromEnv());
    const limit = flags.batchSize ?? 100;

    const bookRows = db.select().from(books)
      .where(and(eq(books.releaseStatus as never, 'released' as never), isNull(books.coverUrl)))
      .orderBy(books.pk)
      .limit(limit)
      .all() as Array<{ pk: string; coverUrl: string | null }>;
    for (const b of bookRows) {
      const coverSource = db.select().from(bookIdentifiers)
        .where(eq(bookIdentifiers.bookPk, b.pk))
        .all() as Array<{ resource: string }>;
      let coverUrl: string | undefined;
      for (const id of coverSource) {
        if (id.resource.startsWith('openlibrary:books/')) {
          coverUrl = `https://covers.openlibrary.org/b/olid/${id.resource.slice('openlibrary:books/'.length)}-L.jpg`;
          break;
        }
      }
      if (!coverUrl) {
        const isbn = coverSource.find((i) => i.resource.startsWith('isbn:'));
        if (isbn) coverUrl = `https://covers.openlibrary.org/b/isbn/${isbn.resource.slice('isbn:'.length)}-L.jpg`;
      }
      if (coverUrl) {
        const res = await fetchBookCover(db, store, b.pk, coverUrl);
        if (res.fetched) db.update(books).set({ coverUrl: res.url }).where(eq(books.pk, b.pk)).run();
      }
    }

    const contributorRows = db.select().from(contributors)
      .where(and(eq(contributors.releaseStatus as never, 'released' as never), isNull(contributors.imageUrl)))
      .orderBy(contributors.pk)
      .limit(limit)
      .all() as Array<{ pk: string; name: string; imageUrl: string | null }>;
    for (const c of contributorRows) {
      const res = await fetchContributorPortrait(db, store, c.pk, c.name, undefined);
      if (res.fetched) db.update(contributors).set({ imageUrl: res.url }).where(eq(contributors.pk, c.pk)).run();
    }
    logger.info({ books: bookRows.length, contributors: contributorRows.length }, 'images refresh done');
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

export { main };

// Only run the dispatcher when executed directly, so a smoke test can import the
// module without triggering a usage-exit.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.fatal({ err: err as Error }, 'import failed');
    process.exit(1);
  });
}
