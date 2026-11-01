#!/usr/bin/env tsx
//
// Fill the catalog for shelving records whose edition is missing.
//
// A `bookShelving` record points at a catalog edition like
// `at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL123W`.
// When that URI has no row in `editions`, shelf hydration drops the book, so the
// reader's shelf looks empty even though the record is on their PDS. This script
// walks the shelving records, works out which editions are missing, and fills
// them from the provider that owns the rkey prefix (or from another catalog
// database, when one is available).
//
// Idempotent and safe to re-run: it only looks at URIs that are still absent and
// the ingest path upserts.
//
//   pnpm backfill:shelving-editions                       # providers: whatever is configured
//   pnpm backfill:shelving-editions -- --dry              # report only
//   pnpm backfill:shelving-editions -- --limit=200        # cap the run
//   pnpm backfill:shelving-editions -- --providers=ol     # one provider
//   pnpm backfill:shelving-editions -- --copy-from=postgres://…
//
// `--copy-from` takes a second catalog database (e.g. a development instance
// that already holds the rows) and copies the editions that are missing here,
// which is often cheaper and complete when a provider key is not configured:
// the rows carry the identifiers, contributors and CIDs the provider gave at
// ingest time, so nothing is invented.
//
// Requires DATABASE_URL (the database to fill).
//

import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { db } from '../src/lib/server/db/index';
import { editions, records } from '../src/lib/server/db/schema';
import type { RecordRow } from '../src/lib/server/db/schema';
import * as schema from '../src/lib/server/db/schema';
import { createLogger } from '../src/lib/server/logger';
import { bookUriForRow } from '../src/lib/server/shelving/hydrate';
import {
  fetchEditionForUri,
  providerForEditionUri,
} from '../src/lib/server/shelving/edition-fetch';
import { editionUriFor, ingestEditionBatch } from '../src/lib/server/jobs/handlers';

const SHELVING_COLLECTION = 'net.olamaelcu.livtet.biblio.bookShelving';
const SHELF_COLLECTION = 'net.olamaelcu.livtet.biblio.shelf';
const PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 3;

type Provider = 'ol' | 'gb' | 'isbndb' | 'bh';

const ALL_PROVIDERS: Provider[] = ['ol', 'gb', 'isbndb', 'bh'];

interface Args {
  dry: boolean;
  limit?: number;
  providers: Provider[];
  copyFrom?: string;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
    return prefixed ? prefixed.slice(name.length + 3) : undefined;
  };
  const rawProviders = get('providers');
  const providers = rawProviders
    ? (rawProviders.split(',').map((p) => p.trim()).filter(Boolean) as Provider[])
    : ALL_PROVIDERS;
  for (const p of providers) {
    if (!ALL_PROVIDERS.includes(p)) {
      throw new Error(`unknown provider '${p}' (expected one of ${ALL_PROVIDERS.join(', ')})`);
    }
  }
  const limitArg = get('limit');
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got '${limitArg}'`);
  }
  const concurrencyArg = get('concurrency');
  const concurrency = concurrencyArg === undefined ? DEFAULT_CONCURRENCY : Number(concurrencyArg);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got '${concurrencyArg}'`);
  }
  return {
    dry: argv.includes('--dry'),
    limit,
    providers,
    copyFrom: get('copy-from'),
    concurrency,
  };
}

/** Every catalog URI a shelving record points at that `editions` does not hold. */
async function findOrphanEditionUris(): Promise<Map<string, number>> {
  const orphans = new Map<string, number>();
  let cursor: string | null = null;
  for (;;) {
    const rows = await db
      .select()
      .from(records)
      .where(
        cursor
          ? and(eq(records.collection, SHELVING_COLLECTION), gt(records.uri, cursor))
          : eq(records.collection, SHELVING_COLLECTION),
      )
      .orderBy(asc(records.uri))
      .limit(PAGE_SIZE);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.uri;

    const wanted = new Map<string, number>();
    for (const row of rows) {
      const uri = bookUriForRow(row as RecordRow);
      if (!uri) continue;
      wanted.set(uri, (wanted.get(uri) ?? 0) + 1);
    }
    if (wanted.size === 0) continue;
    const present = await db
      .select({ uri: editions.uri })
      .from(editions)
      .where(inArray(editions.uri, [...wanted.keys()]));
    const have = new Set(present.map((r) => r.uri));
    for (const [uri, refs] of wanted) {
      if (have.has(uri)) continue;
      orphans.set(uri, (orphans.get(uri) ?? 0) + refs);
    }
  }
  return orphans;
}

/** Copy edition rows that the target database lacks from another catalog DB. */
async function copyFromCatalog(
  sourceUrl: string,
  uris: string[],
  dry: boolean,
): Promise<{ copied: number; absent: number }> {
  if (uris.length === 0) return { copied: 0, absent: 0 };
  const pool = new Pool({ connectionString: sourceUrl, max: 2 });
  const source = drizzle(pool, { schema });
  try {
    let copied = 0;
    let absent = 0;
    for (let i = 0; i < uris.length; i += PAGE_SIZE) {
      const chunk = uris.slice(i, i + PAGE_SIZE);
      const rows = await source.select().from(editions).where(inArray(editions.uri, chunk));
      absent += chunk.length - rows.length;
      if (rows.length === 0) continue;
      if (dry) {
        copied += rows.length;
        continue;
      }
      // Every column is carried over, including cid and identifiers: these rows
      // are what the provider returned when the source instance ingested them.
      await db.insert(editions).values(rows).onConflictDoNothing({ target: editions.uri });
      copied += rows.length;
    }
    return { copied, absent };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger('worker');
  const startedAt = Date.now();

  console.log('==> Scanning shelving records for missing editions');
  const orphanMap = await findOrphanEditionUris();
  const allOrphans = [...orphanMap.keys()];
  const byProvider = new Map<Provider | 'unknown', string[]>();
  for (const uri of allOrphans) {
    const provider = providerForEditionUri(uri) ?? 'unknown';
    const bucket = byProvider.get(provider) ?? [];
    bucket.push(uri);
    byProvider.set(provider, bucket);
  }
  console.log(`    ${allOrphans.length} distinct editions missing across ${SHELVING_COLLECTION}`);
  for (const [provider, uris] of [...byProvider.entries()].sort()) {
    console.log(`    ${provider.padEnd(8)} ${uris.length}`);
  }

  const selected = allOrphans.filter((uri) => {
    const provider = providerForEditionUri(uri);
    return provider !== null && args.providers.includes(provider);
  });
  const capped = args.limit === undefined ? selected : selected.slice(0, args.limit);
  if (args.limit !== undefined && selected.length > capped.length) {
    console.log(`    --limit=${args.limit} caps this run; ${capped.length} of ${selected.length} attempted`);
  }
  if (capped.length === 0) {
    console.log('==> Nothing to do');
    return;
  }

  const counts = {
    copied: 0,
    fetched: 0,
    failed: 0,
    uri_mismatch: 0,
  };

  let pending = capped;
  if (args.copyFrom) {
    console.log(`==> Copying from the source catalog${args.dry ? ' (dry run)' : ''}`);
    const { copied, absent } = await copyFromCatalog(args.copyFrom, pending, args.dry);
    counts.copied = copied;
    console.log(`    copied ${copied}; ${absent} absent there; ${pending.length - copied - absent} left for providers`);
    // Whatever the copy pass could not supply is fetched from its provider.
    pending = await filterStillMissing(pending);
  }

  const toFetch = pending;
  if (toFetch.length > 0) {
    console.log(`==> Fetching from providers (concurrency ${args.concurrency})${args.dry ? ' (dry run)' : ''}`);
  }

  let index = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(args.concurrency, toFetch.length) }, async () => {
    for (;;) {
      const current = index++;
      const uri = toFetch[current];
      if (uri === undefined) return;
      const provider = providerForEditionUri(uri) ?? 'unknown';
      if (args.dry) {
        done++;
        if (done % 50 === 0) console.log(`    (dry) ${done}/${toFetch.length}`);
        continue;
      }
      const item = await fetchEditionForUri(uri, log);
      if (!item) {
        counts.failed++;
      } else if (editionUriFor(item.identifiers) !== uri) {
        // The provider answered but mapped to a different URI (e.g. an OLID was
        // resolved where the reference carries an ISBNdb id): persisting it would
        // not resolve this row and would silently change which book it shows.
        counts.uri_mismatch++;
      } else {
        await ingestEditionBatch([item], log, 1);
        counts.fetched++;
      }
      done++;
      if (done % 50 === 0) console.log(`    ${done}/${toFetch.length} (${provider})`);
    }
  });
  await Promise.all(workers);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('==> Done');
  console.log(`    missing at start : ${allOrphans.length}`);
  console.log(`    copied           : ${counts.copied}`);
  console.log(`    fetched          : ${counts.fetched}`);
  console.log(`    failed           : ${counts.failed}`);
  console.log(`    uri mismatch     : ${counts.uri_mismatch}`);
  console.log(`    elapsed          : ${seconds}s`);
  const unresolved = await findOrphanEditionUris();
  console.log(`    missing now      : ${unresolved.size}`);
  if (args.dry) console.log('    (dry run: nothing was written)');

  // A non-zero exit would make a partial run look like a crash; the counts are
  // the report. Providers without a configured key land in `failed` by design.
  process.exit(0);
}

/** URIs from `capped` that are still absent from the catalog. */
async function filterStillMissing(capped: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < capped.length; i += PAGE_SIZE) {
    const chunk = capped.slice(i, i + PAGE_SIZE);
    const present = await db
      .select({ uri: editions.uri })
      .from(editions)
      .where(inArray(editions.uri, chunk));
    const have = new Set(present.map((r) => r.uri));
    for (const uri of chunk) if (!have.has(uri)) out.push(uri);
  }
  return out;
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
