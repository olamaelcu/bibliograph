import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { BOOKS_MISSING_COVER_VARIANTS, SHELVES_MISSING_COVER_VARIANTS } from './db/views.js';
import type { Cover, CoverCollection, CoverFormat, CoverSize } from './cover-types.js';
import { COVER_FORMATS, COVER_SIZES, setCoverVariant, variantUrl } from './cover-types.js';
import { transcodeCover } from './cover-transcode.js';
import { writeCover } from './cover-storage.js';
import { fetchCoverSource } from './cover-source.js';
import { rkeyFromUri } from './cover-types.js';
import { logger } from './logger.js';

const DEFAULT_BATCH_SIZE = 50;

export interface CoverWorkerOptions {
  batchSize?: number;
  signal?: AbortSignal;
}

export interface CoverWorkerResult {
  scanned: number;
  processed: number;
  failed: number;
  skipped: number;
}

interface Row {
  uri: string;
  cover: Cover | string;
  rkey: string;
}

export async function runCoverWorker(
  db: BetterSQLite3Database<typeof schema>,
  opts: CoverWorkerOptions = {},
): Promise<CoverWorkerResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: CoverWorkerResult = { scanned: 0, processed: 0, failed: 0, skipped: 0 };

  await processTable(db, 'book', BOOKS_MISSING_COVER_VARIANTS, batchSize, result, opts.signal);
  await processTable(db, 'shelf', SHELVES_MISSING_COVER_VARIANTS, batchSize, result, opts.signal);

  return result;
}

async function processTable(
  db: BetterSQLite3Database<typeof schema>,
  collection: CoverCollection,
  viewName: string,
  batchSize: number,
  result: CoverWorkerResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rows = selectRows(db, viewName, batchSize);
  for (const row of rows) {
    if (signal?.aborted) {
      logger.info({ collection, scanned: result.scanned }, 'cover worker aborted');
      return;
    }
    result.scanned += 1;
    try {
      const outcome = await processRow(db, collection, row, signal);
      if (outcome === 'processed') result.processed += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, uri: row.uri, collection }, 'cover worker: row failed');
    }
  }
}

function selectRows(db: BetterSQLite3Database<typeof schema>, viewName: string, limit: number): Row[] {
  return db.all<Row>(sql`
    SELECT uri, cover, rkey FROM ${sql.raw(viewName)} LIMIT ${sql.raw(String(limit))}
  `);
}

function parseCover(raw: Cover | string | null | undefined): Cover | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as Cover;
  } catch {
    return null;
  }
}

async function processRow(
  db: BetterSQLite3Database<typeof schema>,
  collection: CoverCollection,
  row: Row,
  signal: AbortSignal | undefined,
): Promise<'processed' | 'skipped'> {
  let derivedRkey: string;
  try {
    derivedRkey = rkeyFromUri(row.uri);
  } catch {
    logger.warn({ uri: row.uri }, 'cover worker: rkey mismatch, skipping');
    return 'skipped';
  }
  if (derivedRkey !== row.rkey) {
    logger.warn({ uri: row.uri, viewRkey: row.rkey, derivedRkey }, 'cover worker: rkey mismatch, skipping');
    return 'skipped';
  }

  const cover = parseCover(row.cover);
  if (!cover) {
    logger.warn({ uri: row.uri }, 'cover worker: cover JSON unparseable, skipping');
    return 'skipped';
  }

  const sourceUrl = cover.medium;
  if (!sourceUrl) {
    logger.warn({ uri: row.uri }, 'cover worker: no cover.medium, skipping');
    return 'skipped';
  }

  const source = await fetchCoverSource(sourceUrl, { collection, rkey: row.rkey });
  if (!source) {
    logger.warn({ uri: row.uri, source: sourceUrl }, 'cover worker: source fetch failed, skipping');
    return 'skipped';
  }

  let result;
  try {
    result = await transcodeCover(source.bytes);
  } catch (err) {
    logger.error({ err, uri: row.uri }, 'cover worker: transcode failed');
    return 'skipped';
  }

  const next: Cover = {
    ...cover,
    width: result.width,
    height: result.height,
    color: result.dominantColor,
    updatedAt: new Date().toISOString(),
  };

  for (const size of COVER_SIZES) {
    if (signal?.aborted) return 'skipped';
    for (const format of COVER_FORMATS) {
      const buf = format === 'jpg' ? result.variants[size].jpg : result.variants[size].avif;
      await writeCover(collection, row.rkey, size, format, buf);
      const url = variantUrl(collection, row.rkey, size, format);
      Object.assign(next, setCoverVariant(next, size, format, url));
    }
  }

  await updateCover(db, collection, row.uri, next);
  return 'processed';
}

async function updateCover(
  db: BetterSQLite3Database<typeof schema>,
  collection: CoverCollection,
  uri: string,
  cover: Cover,
): Promise<void> {
  if (collection === 'book') {
    db.update(schema.books).set({ cover }).where(sql`${schema.books.uri} = ${uri}`).run();
  } else {
    db.update(schema.shelves).set({ cover }).where(sql`${schema.shelves.uri} = ${uri}`).run();
  }
}

export interface CoverWorkerCliArgs {
  batchSize?: number;
}

export async function runCoverWorkerFromCli(args: CoverWorkerCliArgs): Promise<void> {
  const { db } = await import('./db/connection.js');
  const result = await runCoverWorker(db, { batchSize: args.batchSize });
  logger.info(result, 'cover worker: complete');
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , ...cliArgs] = process.argv;
  const batchSize = cliArgs.includes('--batch-size')
    ? parseInt(cliArgs[cliArgs.indexOf('--batch-size') + 1] ?? '50', 10)
    : undefined;
  runCoverWorkerFromCli({ batchSize }).catch((err) => {
    logger.fatal({ err }, 'cover worker failed');
    process.exit(1);
  });
}
