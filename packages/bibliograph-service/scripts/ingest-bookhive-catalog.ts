#!/usr/bin/env tsx
//
// Ingest Bookhive's catalog (`buzz.bookhive.catalogBook`) into the local edition
// catalog, keyed `bh.{hiveId}` with a `bookhive` identifier pointing back at the
// Bookhive record. That identifier is what lets Bibliograph attach Bookhive
// reviews and shelving to the edition (see `bookhive/records.ts`).
//
//   pnpm ingest:bookhive              # walk the whole Bookhive catalog
//   pnpm ingest:bookhive -- --dry     # log mappings without writing
//   pnpm ingest:bookhive -- --limit=500 --pages=5
//
// Idempotent: editions are upserted by uri, so re-running only refreshes rows.
// Requires DATABASE_URL (for the catalog writes and author name resolution).
//

import { inArray, sql } from 'drizzle-orm';
import { db } from '../src/lib/server/db/index';
import { contributors } from '../src/lib/server/db/schema';
import { createLogger } from '../src/lib/server/logger';
import { syncIngestEditions } from '../src/lib/server/jobs/handlers';
import {
  catalogBookToEditionItem,
  fetchCatalogBooksPage,
  splitAuthors,
} from '../src/lib/server/bookhive/catalog';
import type { ContributionEntry, EditionItem } from '../src/lib/server/search/types';

function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * Resolve author names to contributor strongRefs. Bookhive only carries a free
 * form author *string*, so the edition lexicon's refs can only be filled for
 * names the local catalog already knows; unknown names are dropped rather than
 * invented.
 */
async function contributionsFor(names: string[]): Promise<Map<string, ContributionEntry[]>> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n !== ''))];
  const byName = new Map<string, ContributionEntry[]>();
  if (wanted.length === 0) return byName;
  const rows = await db
    .select({ uri: contributors.uri, cid: contributors.cid, name: contributors.name })
    .from(contributors)
    .where(inArray(sql`lower(${contributors.name})`, wanted));
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push({ subject: { uri: row.uri, cid: row.cid }, role: 'author' });
    byName.set(key, list);
  }
  return byName;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limitArg = flagValue(args, 'limit');
  const hardLimit = limitArg ? Number(limitArg) : undefined;
  const pagesArg = flagValue(args, 'pages');
  const maxPages = pagesArg ? Number(pagesArg) : Number.POSITIVE_INFINITY;
  const log = createLogger('worker');

  let cursor: string | undefined;
  let pages = 0;
  let seen = 0;
  let written = 0;
  let skipped = 0;

  for (;;) {
    const page = await fetchCatalogBooksPage({ cursor });
    pages++;
    seen += page.records.length;

    const names = page.records.flatMap((r) => splitAuthors(r.value.authors));
    const contributions = await contributionsFor(names);

    const items: EditionItem[] = [];
    for (const record of page.records) {
      if (hardLimit !== undefined && written + items.length >= hardLimit) break;
      const resolved = splitAuthors(record.value.authors)
        .flatMap((name) => contributions.get(name.trim().toLowerCase()) ?? []);
      const item = catalogBookToEditionItem(record.value, resolved);
      if (!item) {
        skipped++;
        continue;
      }
      items.push(item);
    }

    if (dry) {
      for (const item of items) {
        log.info({ stage: 'ingest-bookhive', uri: item.uri, title: item.title }, 'dry-run: would ingest');
      }
    } else if (items.length > 0) {
      await syncIngestEditions(items, log);
    }
    written += items.length;
    log.info({ stage: 'ingest-bookhive', pages, seen, written, skipped, cursor: page.cursor ?? null }, 'page ingested');

    if (hardLimit !== undefined && written >= hardLimit) break;
    if (!page.cursor || page.records.length === 0) break;
    if (pages >= maxPages) break;
    cursor = page.cursor;
  }

  log.info({ stage: 'ingest-bookhive', pages, seen, written, skipped, dry }, 'done');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
