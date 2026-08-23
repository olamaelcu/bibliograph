import { and, eq, ilike, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { XRPCRouter, json, XRPCError, InvalidRequestError } from '@atcute/xrpc-server';
import { CID, digest } from 'multiformats';
import { loadLexiconSchema, LexiconNotFound } from '../lexicon-resolve.js';
import * as Lexicons from '../lexicons/index.js';
import { registerPdsHandlers } from '../pds/router.js';
import { GoogleBooksClient, GoogleBooksError, type GbVolume } from '../google-books/client.js';
import { decodeGbCursor, encodeGbCursor, gbIdentifiersToIdentifiers } from '../google-books/mapper.js';
import { getCached, requestHash, setCached, TTL } from '../google-books/cache.js';
import { logger } from '../logger.js';
import {
  toActorView,
  toBookShelfView,
  toContributorView,
  toShelfView,
  toShelfWithBooksView,
  hydrateEdition,
  withActorBsky,
  withShelfBsky,
} from './hydrate.js';
import { listByCollection, getUserRecord } from '../jetstream/query.js';
import {
  bookIdentifiers,
  contributors,
  editions,
} from '../db/schema.js';
import { COLLECTION, type PdsRecord, type ViewContext } from '../lex/collections.js';
import type {
  BookShelfView,
  ShelfWithBooksView,
} from '../xrpc/views.js';

type Db = NodePgDatabase<typeof schema>;

const VOLUME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseRkey(uri: string): { did: string; collection: string; rkey: string } {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'malformed at-uri' });
  const [, did, collection, rkey] = m;
  return { did, collection, rkey };
}

function rkeyFromUri(uri: string, expectedCollection: string): string {
  const { collection, rkey } = parseRkey(uri);
  if (collection !== expectedCollection) {
    throw new InvalidRequestError({
      status: 400,
      error: 'InvalidRequest',
      message: `expected collection '${expectedCollection}', got '${collection}'`,
    });
  }
  return rkey;
}

function didAndRkeyFromUri(uri: string, expectedCollection: string): { did: string; rkey: string } {
  const { did, collection, rkey } = parseRkey(uri);
  if (collection !== expectedCollection) {
    throw new InvalidRequestError({
      status: 400,
      error: 'InvalidRequest',
      message: `expected collection '${expectedCollection}', got '${collection}'`,
    });
  }
  return { did, rkey };
}

function didFromUri(uri: string): string {
  return parseRkey(uri).did;
}

function notFound(): never {
  throw new XRPCError({ status: 404, error: 'NotFound', message: 'record not found' });
}

class HandlerTimeoutError extends Error {
  constructor(readonly nsid: string, readonly timeoutMs: number) {
    super(`${nsid} handler exceeded ${timeoutMs}ms`);
    this.name = 'HandlerTimeoutError';
  }
}

async function withHandlerTimeout<T>(
  nsid: string,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new HandlerTimeoutError(nsid, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimedHandler<T>(
  nsid: string,
  opts: { timeoutMs: number; requestId?: string | null; params?: Record<string, unknown> },
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeStart = Date.now();
  logger.info(
    { nsid, requestId: opts.requestId, params: opts.params, timeoutMs: opts.timeoutMs },
    'xrpc handler started',
  );
  try {
    const result = await withHandlerTimeout(nsid, work, opts.timeoutMs);
    logger.info(
      { nsid, requestId: opts.requestId, durationMs: Date.now() - timeStart },
      'xrpc handler completed',
    );
    return result;
  } catch (err) {
    if (err instanceof HandlerTimeoutError) {
      logger.warn(
        { nsid, requestId: opts.requestId, timeoutMs: opts.timeoutMs, durationMs: Date.now() - timeStart },
        `xrpc handler timed out after ${opts.timeoutMs} milliseconds`,
      );
      throw new XRPCError({
        status: 504,
        error: 'Timeout',
        message: `${nsid} exceeded ${opts.timeoutMs}ms`,
      });
    }
    logger.error(
      { nsid, requestId: opts.requestId, durationMs: Date.now() - timeStart, err },
      'xrpc handler threw',
    );
    if (err instanceof GoogleBooksError) {
      throw new XRPCError({
        status: 502,
        error: 'UpstreamFailure',
        message: `Google Books API returned ${err.status}`,
      });
    }
    throw err;
  }
}

function requestIdOf(request: Request): string | null {
  return request.headers.get('X-Request-Id');
}

export interface RouterOptions {
  client?: GoogleBooksClient;
  handlerTimeoutMs?: number;
}

/** Static list of NSIDs this AppView advertises in its `compatibility` response. */
function compatibilityQueries(): { nsid: string; type?: string }[] {
  return [
    { nsid: 'book.searchEditions', type: 'query' },
    { nsid: 'book.searchContributors', type: 'query' },
    { nsid: 'book.searchWorks', type: 'query' },
    { nsid: 'book.searchPublishers', type: 'query' },
  ];
}

/**
 * Materialize a `community.lexicon.book.edition` AppView from an `editions`
 * DB row. Reads identifiers and contributors (via the JSON column) and joins
 * contributor rows for display. Single DB query for identifiers; per-contributor
 * fetches are batched.
 */
// Removed: duplicated by `toEditionView` in hydrate.ts. Kept here for callers
// that need a one-shot row → EditionView without going through the
// `hydrateEdition` helper.

export function createXrpcRouter(
  db: Db,
  ctx: ViewContext,
  opts: RouterOptions = {},
): XRPCRouter {
  const router = new XRPCRouter();
  registerPdsHandlers(router, db, ctx, { client: opts.client });

  if (!process.env.GOOGLE_BOOKS_API_KEY) {
    logger.warn(
      { stage: 'config' },
      'GOOGLE_BOOKS_API_KEY is not set; google-books-backed queries will fail with 502',
    );
  }

  // Map<string, Promise<unknown>> dedupes concurrent identical cache-miss
  // calls in `searchEditions` so N parallel requests share a single Google
  // Books round-trip and a single cache write.
  const inflight = new Map<string, Promise<unknown>>();

  let cachedGb: GoogleBooksClient | undefined = opts.client;
  const gb = () => {
    if (!cachedGb) {
      cachedGb = new GoogleBooksClient({ apiKey: process.env.GOOGLE_BOOKS_API_KEY ?? '' });
    }
    return cachedGb;
  };

  const handlerTimeoutMs =
    opts.handlerTimeoutMs ?? parseInt(process.env.XRPC_HANDLER_TIMEOUT_MS ?? '60000', 10);

  router.addQuery(Lexicons.ComAtprotoLexiconResolveLexicon.mainSchema, {
    async handler({ params }) {
      try {
        const schemaNsid: string = params.nsid;
        const { json: schemaJson, bytes } = loadLexiconSchema(schemaNsid);
        const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
        const hashBytes = new Uint8Array(hash);
        const digestObj = digest.create(0x12, hashBytes);
        const cid = CID.createV1(0x0129, digestObj);
        const uri = `at://${ctx.serviceDid}/com.atproto.lexicon.schema/${schemaNsid}`;
        return json({
          uri,
          cid: cid.toString(),
          schema: schemaJson as unknown as Lexicons.ComAtprotoLexiconResolveLexicon.$output['schema'],
        });
      } catch (err) {
        if (err instanceof LexiconNotFound) {
          throw new XRPCError({ status: 400, error: 'LexiconNotFound', message: err.message });
        }
        throw err;
      }
    },
  });

  // ─── community.lexicon.book.* (GB-backed) ─────────────────────────────

  router.addQuery(Lexicons.CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'community.lexicon.book.searchEditions';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { hasCursor: !!params.cursor, hasQ: !!params.q, hasIds: !!params.id?.length } }, async (signal) => {
        const requestId = requestIdOf(request) ?? undefined;
        const q = params.q?.trim() ?? '';
        const ids = params.id ?? [];
        const limit = Math.min(100, Math.max(1, params.limit ?? 20));

        if (!q && ids.length === 0) {
          return json({ items: [], total: 0, cursor: undefined });
        }

        // Build GB query. If `id[]` is provided, OR each value into q.
        // GB accepts freeform text; specific ISBN/OL lookups via inauthor/isbn
        // are not yet supported (limitation; resolve via getEdition round-trip).
        const combinedQ = q || ids.join(' ');
        const cursor = decodeGbCursor(params.cursor);
        const startIndex = cursor?.q === combinedQ ? cursor.startIndex : 0;

        const cacheKey = { q: combinedQ, startIndex, limit };
        const hash = requestHash('searchEditions', cacheKey);
        const cached = await getCached<{ totalItems: number; items: unknown[] }>(db, 'searchEditions', cacheKey, { signal, requestId });
        let totalItems: number;
        let items: GbVolume[];
        if (cached) {
          logger.info({ nsid, requestId, stage: 'cache', hit: true, cachedItems: cached.items.length }, 'cache hit');
          totalItems = cached.totalItems;
          items = cached.items as GbVolume[];
        } else {
          const existing = inflight.get(hash);
          if (existing) {
            const shared = (await existing) as { totalItems: number; items: unknown[] };
            logger.info({ nsid, requestId, stage: 'inflight', hit: true }, 'shared in-flight google books response');
            totalItems = shared.totalItems;
            items = shared.items as GbVolume[];
          } else {
            logger.info({ nsid, requestId, stage: 'cache', hit: false }, 'cache miss; calling google books');
            const work = (async () => {
              const res = await gb().searchVolumes(combinedQ, { startIndex, maxResults: limit }, { signal, requestId });
              return { totalItems: res.totalItems, items: res.items ?? [] };
            })();
            inflight.set(hash, work);
            try {
              const result = await work;
              totalItems = result.totalItems;
              items = result.items as GbVolume[];
              logger.info({ nsid, requestId, stage: 'google', totalItems, itemsReturned: items.length }, 'google books response');
              await setCached(db, 'searchEditions', cacheKey, { totalItems, items }, TTL.search, { signal, requestId });
            } finally {
              inflight.delete(hash);
            }
          }
        }

        // Map GB volumes → EditionRecord objects (the community shape).
        const items_out: unknown[] = [];
        let dropped = 0;
        for (const v of items) {
          if (!v.volumeInfo?.title) {
            dropped++;
            continue;
          }
          items_out.push(gbVolumeToEditionRecord(ctx, v));
        }
        if (dropped > 0) {
          logger.warn({ nsid, requestId, stage: 'map', dropped, kept: items_out.length }, 'volumes dropped during mapping');
        }
        const hasMore = startIndex + items_out.length < totalItems;
        const next = hasMore ? encodeGbCursor({ q: combinedQ, startIndex: startIndex + items_out.length }) : undefined;
        return json({ items: items_out as unknown as Lexicons.CommunityLexiconBookSearchEditions.$output['items'], total: totalItems, cursor: next });
      });
    },
  });

  router.addQuery(Lexicons.CommunityLexiconBookGetEdition.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'community.lexicon.book.getEdition';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { uri: params.uri } }, async (signal) => {
        const requestId = requestIdOf(request) ?? undefined;
        const rkey = rkeyFromUri(params.uri, COLLECTION.edition);
        if (rkey.startsWith('gb-')) {
          // GB lazy-load: fetch volume, persist as edition, return.
          const volumeId = rkey.slice(3);
          if (!VOLUME_ID_RE.test(volumeId)) {
            throw new InvalidRequestError({
              status: 400,
              error: 'InvalidRequest',
              message: `invalid google books volume id: '${volumeId}'`,
            });
          }
          const cached = await getCached<GbVolume>(db, 'getEdition', { volumeId }, { signal, requestId });
          let volume: GbVolume | undefined;
          if (cached) {
            volume = cached;
          } else {
            volume = await gb().getVolume(volumeId, { signal, requestId });
            if (volume) await setCached(db, 'getEdition', { volumeId }, volume, TTL.getBook, { signal, requestId });
          }
          if (!volume) throw new XRPCError({ status: 404, error: 'NotFound', message: 'no such volume' });
          const rec = gbVolumeToEditionRecord(ctx, volume);
          if (!rec) throw new XRPCError({ status: 404, error: 'NotFound', message: 'volume missing title' });
          return json({ edition: rec as unknown as Lexicons.CommunityLexiconBookGetEdition.$output['edition'] });
        }
        const row = (await db.select().from(editions).where(eq(editions.pk, rkey)))[0];
        if (!row) notFound();
        const rec = gbVolumeToEditionRecord(ctx, { id: row.pk, volumeInfo: rowToVolumeInfo(row) } as GbVolume);
        if (!rec) notFound();
        return json({ edition: rec as unknown as Lexicons.CommunityLexiconBookGetEdition.$output['edition'] });
      });
    },
  });

  router.addQuery(Lexicons.CommunityLexiconBookGetContributor.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'community.lexicon.book.getContributor';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { uri: params.uri } }, async () => {
        const rkey = rkeyFromUri(params.uri, COLLECTION.contributor);
        const row = (await db.select().from(contributors).where(eq(contributors.pk, rkey)))[0];
        if (!row) notFound();
        const view = await toContributorView(db, ctx, row);
        return json({ contributor: view as unknown as Lexicons.CommunityLexiconBookGetContributor.$output['contributor'] });
      });
    },
  });

  router.addQuery(Lexicons.CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'community.lexicon.book.searchContributors';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { hasCursor: !!params.cursor } }, async () => {
        const q = params.q.trim();
        const term = `%${q}%`;
        const limit = Math.min(100, Math.max(1, params.limit ?? 20));
        const rows = await db
          .select()
          .from(contributors)
          .where(or(ilike(contributors.name, term), ilike(contributors.sortName, term)))
          .orderBy(contributors.name)
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const items = await Promise.all(page.map((r) => toContributorView(db, ctx, r)));
        return json({ items: items as unknown as Lexicons.CommunityLexiconBookSearchContributors.$output['items'], total: hasMore ? undefined : items.length, cursor: undefined });
      });
    },
  });

  // searchWorks / searchPublishers are part of the community lexicon
  // contract but not implemented in this AppView. We still advertise them in
  // the compatibility response (returning 501) per the proposal's guidance
  // (Apps can opt to implement the optional queries).

  router.addQuery(Lexicons.CommunityLexiconBookCompatibility.mainSchema, {
    async handler() {
      return json({ queries: compatibilityQueries() });
    },
  });

  // ─── app-private image lookups ───────────────────────────────────────

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetImageForBook.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.getImageForBook';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { uri: params.uri } }, async (signal) => {
        const requestId = requestIdOf(request) ?? undefined;
        const rkey = rkeyFromUri(params.uri, COLLECTION.edition);

        // Resolve a GB volume id: either the rkey is `gb-<id>` directly, or
        // the persisted edition has a `googleBooks` identifier we can use.
        let volumeId: string | undefined;
        if (rkey.startsWith('gb-')) {
          volumeId = rkey.slice(3);
        } else {
          const row = (await db
            .select()
            .from(bookIdentifiers)
            .where(and(eq(bookIdentifiers.bookPk, rkey), eq(bookIdentifiers.valueScheme, 'googleBooks')))
            .limit(1))[0];
          if (row) {
            const m = row.uri.match(/\/volumes\/([^/]+)$/);
            if (m) volumeId = m[1];
          }
        }

        if (!volumeId) return json({ url: undefined as unknown as `${string}:${string}` | undefined });

        const cached = await getCached<GbVolume>(db, 'getVolume', { volumeId }, { signal, requestId });
        const volume = cached ?? (await gb().getVolume(volumeId, { signal, requestId }));
        if (volume) await setCached(db, 'getVolume', { volumeId }, volume, TTL.getBook, { signal, requestId });
        const url = volume?.volumeInfo?.imageLinks?.thumbnail ?? volume?.volumeInfo?.imageLinks?.smallThumbnail;
        return json({ url: url as unknown as `${string}:${string}` | undefined });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetImageForContributor.mainSchema, {
    async handler() {
      // TODO: implement OL cover lookup via openlibrary.org/authors/<id>.json
      return json({ url: undefined as unknown as `${string}:${string}` | undefined });
    },
  });

  // ─── per-user PDS endpoints (Jetstream-indexed, app-private) ─────────

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetActor.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.getActor';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const rec = await getUserRecord(db, params.actor, COLLECTION.actor, 'self');
        return json({ actor: (await withActorBsky(toActorView(rec, params.actor))) as unknown as Lexicons.NetOlamaelcuLivtetBiblioGetActor.$output['actor'] });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelf.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.getShelf';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const { did, rkey } = didAndRkeyFromUri(params.uri, COLLECTION.shelf);
        const rec = await getUserRecord(db, did, COLLECTION.shelf, rkey);
        if (!rec) notFound();
        return json({ shelf: (await withShelfBsky(toShelfView(rec))) as unknown as Lexicons.NetOlamaelcuLivtetBiblioGetShelf.$output['shelf'] });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
    async handler({ request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.listShelves';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const records = await listByCollection(db, COLLECTION.shelf);
        return json({ shelves: records.map((r) => toShelfView(r) as unknown as Lexicons.NetOlamaelcuLivtetBiblioListShelves.$output['shelves'][number]) });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBookOnShelf.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.getBookOnShelf';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const { did, rkey } = didAndRkeyFromUri(params.uri, COLLECTION.bookShelf);
        const rec = await getUserRecord(db, did, COLLECTION.bookShelf, rkey);
        if (!rec) notFound();
        const value = rec.value as { shelf: string; book: { ref: string } };
        const book = await hydrateEdition(db, ctx, value.book.ref);
        if (!book) notFound();
        const shelfParsed = parseRkey(String(value.shelf));
        const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
        if (!shelfRec) notFound();
        const view = toBookShelfView(rec, did, await withShelfBsky(toShelfView(shelfRec)), book);
        return json({ bookShelf: view as unknown as Lexicons.NetOlamaelcuLivtetBiblioGetBookOnShelf.$output['bookShelf'] });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooksOnShelf.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.listBooksOnShelf';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const records = await listByCollection(db, COLLECTION.bookShelf);
        const matching = records
          .filter((r) => (r.value as { shelf: string }).shelf === params.shelf)
          .sort((a, b) => {
            const pa = (a.value as { metadata?: { position?: number } }).metadata?.position;
            const pb = (b.value as { metadata?: { position?: number } }).metadata?.position;
            if (pa == null && pb == null) return 0;
            if (pa == null) return 1;
            if (pb == null) return -1;
            return pa - pb;
          });
        const views: BookShelfView[] = [];
        for (const rec of matching) {
          const value = rec.value as { shelf: string; book: { ref: string } };
          const owner = didFromUri(rec.uri);
          const book = await hydrateEdition(db, ctx, value.book.ref);
          if (!book) continue;
          const shelfParsed = parseRkey(String(value.shelf));
          const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
          if (!shelfRec) continue;
          views.push(toBookShelfView(rec, owner, await withShelfBsky(toShelfView(shelfRec)), book));
        }
        logger.info({ nsid: 'listBooksOnShelf', stage: 'list', count: views.length, shelf: params.shelf }, 'list books on shelf');
        return json({ bookShelves: views as unknown as Lexicons.NetOlamaelcuLivtetBiblioListBooksOnShelf.$output['bookShelves'] });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelvingOfBook.mainSchema, {
    async handler({ params, request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.getShelvingOfBook';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const records = await listByCollection(db, COLLECTION.bookShelf);
        const matching = records.filter((r) => (r.value as { book: { ref: string } }).book.ref === params.book);
        const views: BookShelfView[] = [];
        for (const rec of matching) {
          const value = rec.value as { shelf: string; book: { ref: string } };
          const owner = didFromUri(rec.uri);
          const book = await hydrateEdition(db, ctx, value.book.ref);
          if (!book) continue;
          const shelfParsed = parseRkey(String(value.shelf));
          const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
          if (!shelfRec) continue;
          views.push(toBookShelfView(rec, owner, await withShelfBsky(toShelfView(shelfRec)), book));
        }
        logger.info({ nsid: 'getShelvingOfBook', stage: 'list', count: views.length, book: params.book }, 'shelving of book');
        return json({ bookShelves: views as unknown as Lexicons.NetOlamaelcuLivtetBiblioGetShelvingOfBook.$output['bookShelves'] });
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelvesWithBooks.mainSchema, {
    async handler({ request }) {
      const nsid = 'net.olamaelcu.livtet.biblio.listShelvesWithBooks';
      return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
        const [shelfRecords, shelvingRecords] = await Promise.all([
          listByCollection(db, COLLECTION.shelf),
          listByCollection(db, COLLECTION.bookShelf),
        ]);
        const shelvingsByShelf = new Map<string, PdsRecord[]>();
        for (const rec of shelvingRecords) {
          const shelfUri = String((rec.value as { shelf: string }).shelf);
          const list = shelvingsByShelf.get(shelfUri) ?? [];
          list.push(rec);
          shelvingsByShelf.set(shelfUri, list);
        }
        const views: ShelfWithBooksView[] = [];
        for (const shelfRec of shelfRecords) {
          const shelfView = await withShelfBsky(toShelfView(shelfRec));
          const shelvingsForShelf = shelvingsByShelf.get(shelfRec.uri) ?? [];
          const booksView: BookShelfView[] = [];
          for (const rec of shelvingsForShelf) {
            const value = rec.value as { book: { ref: string } };
            const owner = didFromUri(rec.uri);
            const book = await hydrateEdition(db, ctx, value.book.ref);
            if (!book) continue;
            booksView.push(toBookShelfView(rec, owner, shelfView, book));
          }
          views.push(toShelfWithBooksView(shelfView, booksView));
        }
        return json({ shelves: views as unknown as Lexicons.NetOlamaelcuLivtetBiblioListShelvesWithBooks.$output['shelves'] });
      });
    },
  });

  return router;
}

// ─── Helpers used by router.ts ──────────────────────────────────────────────

/** Map an `editions` DB row into a fake GB volume so `gbVolumeToEditionRecord` can render it. */
function rowToVolumeInfo(row: typeof editions.$inferSelect): { title: string; subtitle?: string; publishedDate?: string; description?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string }; authors?: string[] } {
  const vi: { title: string; subtitle?: string; publishedDate?: string; description?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string }; authors?: string[] } = {
    title: row.title,
  };
  if (row.subtitle) vi.subtitle = row.subtitle;
  if (row.publishedYear != null) vi.publishedDate = String(row.publishedYear);
  if (row.description) vi.description = row.description;
  return vi;
}

/**
 * Map a Google Books volume to a `community.lexicon.book.edition` record shape
 * (the shape that gets persisted in the PDS and returned by AppView queries).
 */
export function gbVolumeToEditionRecord(
  ctx: ViewContext,
  volume: GbVolume,
): Record<string, unknown> | undefined {
  const info = volume.volumeInfo;
  if (!info?.title) return undefined;
  const rkey = `gb-${volume.id}`;
  // FIXME: Expand this to include `uri` for this record like in line 621.
  const record: Record<string, unknown> = {
    $type: 'community.lexicon.book.edition',
    title: info.title,
  };
  if (info.subtitle) record.subtitle = info.subtitle;
  if (info.publishedDate) {
    const year = parseYear(info.publishedDate);
    if (year != null) record.publishedYear = year;
  }
  if (info.description) record.description = info.description;
  if (info.authors?.length) {
    record.contributors = info.authors.map((name) => ({
      subject: `at://${ctx.serviceDid}/community.lexicon.book.contributor/${encodeURIComponent(name)}`,
      role: 'author',
    }));
  }
  const identifiers = gbIdentifiersToIdentifiers(info);
  if (identifiers.length) record.identifiers = identifiers;
  // Tag the edition with a GB volume id under resource=googleBooks so
  // getImageForBook can resolve the cover URL.
  if (!identifiers.find((i) => i.resource === 'googleBooks')) {
    identifiers.push({
      uri: `https://www.googleapis.com/books/v1/volumes/${volume.id}`,
      resource: 'googleBooks',
    });
  }
  record.identifiers = identifiers;
  void rkey;
  return record;
}

function parseYear(publishedDate: string): number | undefined {
  const m = publishedDate.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}
