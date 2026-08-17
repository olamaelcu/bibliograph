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
  olResourceExists,
  skipSeenContributors,
  skipSeenWorks,
  type OlEdition,
} from './mappers/openlibrary.js';
import { resolveBookContributors, stageEditionAuthors, type StagedAuthorLink } from './book-contributors.js';
import { workIdentifiersAdapter } from './identifiers.js';
import { logger } from '../logger.js';
import { ProgressBar } from './progress.js';
import { installInterruptHandlers, signalExitCode, InterruptedError } from '../dump/interrupt.js';

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
  'usage: tsx src/import/cli.ts openlibrary:dump|editions:rehydrate|works:dump|contributors:dump|contributors:enrich|works:enrich|bookhive:catalog|images:refresh [--no-download] [--reset] [--keep-dump] [--snapshot] [--path=DIR] [--batch-size=N]\n\n  editions:rehydrate  re-process editions to insert only books; run AFTER works:dump so work_pks land and previously-failed FK references succeed.';

interface Flags {
  noDownload: boolean;
  reset: boolean;
  keepDump: boolean;
  snapshot: boolean;
  dumpPath?: string;
  batchSize?: number;
  unknown: string[];
}

function parseFlags(rest: string[]): Flags {
  const f: Flags = { noDownload: false, reset: false, keepDump: false, snapshot: false, unknown: [] };
  for (const arg of rest) {
    if (arg === '--no-download') f.noDownload = true;
    else if (arg === '--reset') f.reset = true;
    else if (arg === '--keep-dump') f.keepDump = true;
    else if (arg === '--snapshot') f.snapshot = true;
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
  const interrupt = installInterruptHandlers();
  try {
    await dispatch(args, interrupt.signal);
  } finally {
    interrupt.dispose();
  }
  // Import loops stop gracefully and return normally on an interrupt; exit with
  // the signal-derived code so scripts see a non-zero (non-1) result.
  interrupt.exit();
}

async function dispatch(args: string[], signal: AbortSignal): Promise<void> {
  const [cmd, ...rest] = args;
  const flags = parseFlags(rest);
  if (flags.unknown.length > 0) logger.warn({ unknown: flags.unknown }, 'ignoring unknown flags');

  if (cmd === 'openlibrary:dump') {
    // Edition→author links deferred to the staging table: collected during
    // each batch, flushed after the batch commits, and resolved into
    // book_contributors after the whole dump is imported.
    const pending: StagedAuthorLink[] = [];
    const s = await runWithProgress('ol-editions', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-editions', url: OL_EDITIONS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump, useSnapshot: flags.snapshot,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        signal,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        skipNameFallback: true,
        parse: async (fields) => {
          const rec = JSON.parse(fields[4]) as OlEdition;
          for (const a of rec.authors ?? []) {
            if (a.key) pending.push({ editionKey: rec.key, authorKey: a.key });
          }
          // Work-skip: works are referenced by many editions; once a work's
          // openlibrary: key is claimed, skip its merge entirely (saves the
          // per-ISBN identifier pass on an existing row). The book candidate
          // still links to it via workPk, so the FK stays intact.
          const workKey = rec.works?.[0]?.key;
          const cands = mapEditionToCandidates(rec);
          if (workKey && (await olResourceExists(db, workIdentifiersAdapter, workKey))) {
            return cands.filter((c) => c.entityType !== 'work');
          }
          return cands;
        },
        afterBatch: async () => {
          if (pending.length === 0) return;
          await stageEditionAuthors(db, pending);
          pending.length = 0;
        },
      }),
    );
    logger.info(s, 'editions import done');
    const linked = await resolveBookContributors(db, { batchSize: flags.batchSize ?? 10_000 });
    logger.info({ linked }, 'book contributors linked from staging');
  } else if (cmd === 'editions:rehydrate') {
    // Re-process the OL editions dump to insert only book rows; assumes the
    // works table is already populated (run works:dump first). Records whose
    // work_pk doesn't exist will hit FK and be caught by the per-record
    // savepoint, so this pass is safe to run alongside a previous import run.
    const pending: StagedAuthorLink[] = [];
    const s = await runWithProgress('ol-editions-rehydrate', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-editions-rehydrate', url: OL_EDITIONS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump, useSnapshot: flags.snapshot,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        signal,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        skipNameFallback: true,
        parse: (fields) => {
          const rec = JSON.parse(fields[4]) as OlEdition;
          for (const a of rec.authors ?? []) {
            if (a.key) pending.push({ editionKey: rec.key, authorKey: a.key });
          }
          return mapEditionToCandidates(rec).filter((c) => c.entityType === 'book');
        },
        afterBatch: async () => {
          if (pending.length === 0) return;
          await stageEditionAuthors(db, pending);
          pending.length = 0;
        },
      }),
    );
    logger.info(s, 'editions rehydrate done');
    const linked = await resolveBookContributors(db, { batchSize: flags.batchSize ?? 10_000 });
    logger.info({ linked }, 'book contributors linked from staging (rehydrate)');
  } else if (cmd === 'works:dump') {
    const s = await runWithProgress('ol-works', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-works', url: OL_WORKS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump, useSnapshot: flags.snapshot,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        signal,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        skipIfSeen: skipSeenWorks(db),
        skipNameFallback: true,
        parse: (fields) => [mapWorkToCandidate(JSON.parse(fields[4]))],
      }),
    );
    logger.info(s, 'works import done');
  } else if (cmd === 'contributors:dump') {
    const s = await runWithProgress('ol-authors', (onDownload, onImport) =>
      runDumpImport({
        db, stateName: 'ol-authors', url: OL_AUTHORS_URL,
        noDownload: flags.noDownload, reset: flags.reset, keepDump: flags.keepDump, useSnapshot: flags.snapshot,
        dumpPath: flags.dumpPath, batchSize: flags.batchSize,
        signal,
        onProgress: onDownload,
        onImportProgress: onImport,
        keyOf: olKeyOf,
        skipIfSeen: skipSeenContributors(db),
        skipNameFallback: true,
        parse: (fields) => { const c = mapAuthorToCandidate(JSON.parse(fields[4])); return c ? [c] : []; },
      }),
    );
    logger.info(s, 'contributors import done');
  } else if (cmd === 'contributors:enrich') {
    const { enrichContributors } = await import('./enrich.js');
    const s = await enrichContributors(db, { dumpPath: flags.dumpPath, batchSize: flags.batchSize, signal });
    logger.info(s, 'contributors enrichment done');
  } else if (cmd === 'works:enrich') {
    const { enrichWorks } = await import('./enrich.js');
    const s = await enrichWorks(db, { dumpPath: flags.dumpPath, batchSize: flags.batchSize, signal });
    logger.info(s, 'works enrichment done');
  } else if (cmd === 'bookhive:catalog') {
    const { importBookhiveCatalog } = await import('./bookhive/importer.js');
    const s = await importBookhiveCatalog({ db, reset: flags.reset, limit: flags.batchSize, signal });
    logger.info(s, 'bookhive catalog import done');
  } else if (cmd === 'images:refresh') {
    const { BlobStore, blobStoreConfigFromEnv } = await import('../storage/store.js');
    const { fetchBookCover, fetchContributorPortrait } = await import('../images/fetch.js');
    const { and, eq, isNull } = await import('drizzle-orm');
    const { bookIdentifiers, books, contributors } = await import('../db/schema.js');

    const store = new BlobStore(db, blobStoreConfigFromEnv());
    const limit = flags.batchSize ?? 100;

    const bookRows = await db.select().from(books)
      .where(and(eq(books.releaseStatus as never, 'released' as never), isNull(books.coverUrl)))
      .orderBy(books.pk)
      .limit(limit);
    for (const b of bookRows) {
      const coverSource = await db.select().from(bookIdentifiers)
        .where(eq(bookIdentifiers.bookPk, b.pk));
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
        if (res.fetched) await db.update(books).set({ coverUrl: res.url }).where(eq(books.pk, b.pk));
      }
    }

    const contributorRows = await db.select().from(contributors)
      .where(and(eq(contributors.releaseStatus as never, 'released' as never), isNull(contributors.imageUrl)))
      .orderBy(contributors.pk)
      .limit(limit);
    for (const c of contributorRows) {
      const res = await fetchContributorPortrait(db, store, c.pk, c.name, undefined);
      if (res.fetched) await db.update(contributors).set({ imageUrl: res.url }).where(eq(contributors.pk, c.pk));
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
    if (err instanceof InterruptedError) {
      logger.warn({ signal: err.signal }, 'import interrupted');
      process.exit(signalExitCode(err.signal));
    }
    logger.fatal({ err: err as Error }, 'import failed');
    process.exit(1);
  });
}
