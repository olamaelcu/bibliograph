#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { db, schema } from './db/connection.js';
import { trackRepos } from './tap.js';
import { logger } from './logger.js';

const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/;

export function collectKnownDids(db: typeof import('./db/connection.js').db): string[] {
  const tables = [
    schema.books,
    schema.reviews,
    schema.readingStatuses,
    schema.claims,
    schema.shelves,
    schema.shelfItems,
  ];
  const dids = new Set<string>();
  for (const t of tables) {
    const rows = db.select({ did: t.did }).from(t).groupBy(t.did).all();
    for (const r of rows) dids.add(r.did);
  }
  return [...dids];
}

function requireTap(): void {
  if (!process.env.TAP_URL) {
    throw new Error('TAP_URL is not set; backfill requires a running Tap instance');
  }
}

export async function backfillTap(): Promise<void> {
  requireTap();
  const dids = collectKnownDids(db);
  if (dids.length === 0) {
    logger.info('no DIDs found in database; nothing to backfill');
    return;
  }
  logger.info({ count: dids.length }, 'adding known DIDs to Tap for backfill');
  await trackRepos(dids);
}

export async function backfillDid(did: string): Promise<void> {
  if (!DID_RE.test(did)) throw new Error(`invalid DID: ${did}`);
  requireTap();
  logger.info({ did }, 'adding DID to Tap for backfill');
  await trackRepos([did]);
}

function readIsbns(path: string | undefined): string[] {
  if (!path || path === '-') {
    return readFileSync(0, 'utf8').split('\n');
  }
  return readFileSync(path, 'utf8').split('\n');
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: backfill tap | did:<did> | openlibrary [isbns.txt|-] | openlibrary:author <authorKey> | googlebooks [isbns.txt|-] | googlebooks:author <authorName>');
    process.exit(1);
  }
  if (cmd === 'tap') {
    await backfillTap();
  } else if (cmd.startsWith('did:')) {
    await backfillDid(cmd);
  } else if (cmd === 'openlibrary') {
    const { backfillOpenLibraryFromIsbns } = await import('./openlibrary-backfill.js');
    await backfillOpenLibraryFromIsbns(db, readIsbns(process.argv[3]));
  } else if (cmd === 'openlibrary:author') {
    const authorKey = process.argv[3];
    if (!authorKey) {
      console.error('usage: backfill openlibrary:author <authorKey>');
      process.exit(1);
    }
    const { backfillOpenLibraryAuthor } = await import('./openlibrary-backfill.js');
    await backfillOpenLibraryAuthor(db, authorKey);
  } else if (cmd === 'googlebooks') {
    const { backfillGoogleBooksFromIsbns } = await import('./googlebooks-backfill.js');
    await backfillGoogleBooksFromIsbns(db, readIsbns(process.argv[3]));
  } else if (cmd === 'googlebooks:author') {
    const authorName = process.argv[3];
    if (!authorName) {
      console.error('usage: backfill googlebooks:author <authorName>');
      process.exit(1);
    }
    const { backfillGoogleBooksAuthor } = await import('./googlebooks-backfill.js');
    await backfillGoogleBooksAuthor(db, authorName);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.fatal({ err }, 'backfill failed');
    process.exit(1);
  });
}
