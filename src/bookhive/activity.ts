import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { logger } from '../logger.js';
import type { ListRecordsFn, ListRecordsResponse } from './streamer.js';
import { BookhiveStreamer } from './streamer.js';

export interface BookhiveActivityEnumeratorOptions {
  catalogDid: string;
  pdsUrl?: string;
  pageSize?: number;
  listActivity?: ListRecordsFn;
  listCatalogBooks?: ListRecordsFn;
}

export interface EnumerateResult {
  discovered: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Discovers BookHive users whose reading statuses we should backfill, from two
 * on-protocol sources:
 *   1. `buzz.bookhive.activity` records on the @bookhive.buzz repo (each records
 *      a user who added/started/finished a book).
 *   2. The @bookhive.buzz repo's own `buzz.bookhive.book` records (the service
 *      account holds real statuses too, e.g. the BookHive team's library).
 * Persists results to `bookhive_user_discovery`.
 */
export class BookhiveActivityEnumerator {
  private readonly opts: Required<
    Omit<BookhiveActivityEnumeratorOptions, 'pdsUrl' | 'listActivity' | 'listCatalogBooks'>
  > & {
    pdsUrl: string;
    listActivity: ListRecordsFn;
    listCatalogBooks: ListRecordsFn;
  };

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    opts: BookhiveActivityEnumeratorOptions,
  ) {
    const pdsUrl = opts.pdsUrl ?? 'https://bluesky.nickthesick.com';
    this.opts = {
      catalogDid: opts.catalogDid,
      pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
      pdsUrl,
      listActivity: opts.listActivity ?? ((o) => defaultListRecords(pdsUrl, o)),
      listCatalogBooks: opts.listCatalogBooks ?? ((o) => defaultListRecords(pdsUrl, o)),
    };
  }

  async enumerate(): Promise<EnumerateResult> {
    const discovered = new Map<string, { handle: string | null; books: number }>();
    const now = new Date().toISOString();

    // Source 1: activity feed
    const activityStreamer = new BookhiveStreamer({
      pdsUrl: this.opts.pdsUrl,
      repoDid: this.opts.catalogDid,
      collection: 'buzz.bookhive.activity',
      pageSize: this.opts.pageSize,
      listRecords: this.opts.listActivity,
    });
    for await (const item of activityStreamer.iter()) {
      const rec = item.record as Record<string, unknown>;
      const did = rec.userDid;
      if (typeof did !== 'string' || !did) continue;
      const handle = typeof rec.userHandle === 'string' ? rec.userHandle : null;
      const hiveId = typeof rec.hiveId === 'string' ? rec.hiveId : null;
      const entry = discovered.get(did) ?? { handle: null, books: 0 };
      if (handle && !entry.handle) entry.handle = handle;
      if (hiveId) entry.books += 1;
      discovered.set(did, entry);
    }

    // Source 2: the catalog repo's own book records
    const bookStreamer = new BookhiveStreamer({
      pdsUrl: this.opts.pdsUrl,
      repoDid: this.opts.catalogDid,
      collection: 'buzz.bookhive.book',
      pageSize: this.opts.pageSize,
      listRecords: this.opts.listCatalogBooks,
    });
    for await (const item of bookStreamer.iter()) {
      const rec = item.record as Record<string, unknown>;
      const did = this.opts.catalogDid;
      const hiveId = typeof rec.hiveId === 'string' ? rec.hiveId : null;
      const entry = discovered.get(did) ?? { handle: 'bookhive.buzz', books: 0 };
      if (hiveId) entry.books += 1;
      discovered.set(did, entry);
    }

    for (const [did, entry] of discovered) {
      this.db
        .insert(schema.bookhiveUserDiscovery)
        .values({
          did,
          handle: entry.handle,
          firstSeenActivityAt: now,
          lastSeenAt: now,
          bookCountDiscovered: entry.books,
        })
        .onConflictDoUpdate({
          target: schema.bookhiveUserDiscovery.did,
          set: {
            handle: sql`CASE WHEN ${schema.bookhiveUserDiscovery.handle} IS NULL THEN ${entry.handle} ELSE ${schema.bookhiveUserDiscovery.handle} END`,
            lastSeenAt: now,
            bookCountDiscovered: entry.books,
          },
        })
        .run();
    }

    logger.info(
      { discovered: discovered.size, totalUsers: discovered.size },
      'bookhive activity: user discovery complete',
    );
    return { discovered: discovered.size, total: discovered.size };
  }
}

async function defaultListRecords(
  pdsUrl: string,
  opts: Parameters<ListRecordsFn>[0],
): Promise<ListRecordsResponse> {
  const params = new URLSearchParams({
    repo: opts.repo,
    collection: opts.collection,
    limit: String(opts.limit),
  });
  if (opts.cursor) params.set('cursor', opts.cursor);
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `listRecords: ${pdsUrl}/xrpc/com.atproto.repo.listRecords returned ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as ListRecordsResponse;
}
