import { and, eq, inArray, like, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { XRPCRouter, json, InvalidRequestError, XRPCError } from '@atcute/xrpc-server';
import { CID, digest } from 'multiformats';
import { loadLexiconSchema, LexiconNotFound } from '../lexicon-resolve.js';
import * as Lexicons from '../lexicons/index.js';
import { registerPdsHandlers } from '../pds/router.js';
import { authenticateOptional } from '../oauth/auth.js';
import { getUserRecord, listByCollection } from '../jetstream/query.js';
import { decodeCursor, encodeCursor, type CursorValue } from './cursor.js';
import { releasedFilter } from './gate.js';
import {
  COLLECTION,
  bookRkeyFromRef,
  toActorView,
  toBookShelfView,
  toBookView,
  toContributorView,
  toGenreView,
  toReviewView,
  toShelfView,
  toShelfWithBooksView,
  toWorkView,
  type PdsRecord,
  type ViewContext,
} from './views.js';
import {
  contributors,
  contributorIdentifiers,
  bookContributors,
  bookGenres,
  bookIdentifiers,
  books,
  // contributorRoles,
  // formats,
  genreIdentifiers,
  genres,
  workIdentifiers,
  works,
} from '../db/schema.js';
import type {
  BookShelfView,
  BookView,
  ReviewView,
  ShelfView,
  ShelfWithBooksView,
} from '../lexicons/types/net/olamaelcu/livtet/biblio/defs.js';
import { logger } from '../logger.js';

type Db = NodePgDatabase<typeof schema>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, limit));
}

/** Decode a cursor, rejecting malformed values as a client error (400). */
function decodeCursorParam(cursor: string | undefined): CursorValue | undefined {
  if (cursor == null) return undefined;
  try {
    return decodeCursor(cursor);
  } catch {
    throw new InvalidRequestError({
      status: 400,
      error: 'InvalidRequest',
      message: 'invalid cursor',
    });
  }
}

/**
 * Keyset predicate for `ORDER BY col asc, pk asc`: strictly after the cursor
 * row. `key` is the last row's sort value; `pk` is the deterministic tiebreak.
 */
function cursorAfter(col: SQLWrapper, pk: SQLWrapper, cursor: string | undefined): SQL | undefined {
  const decoded = decodeCursorParam(cursor);
  if (!decoded) return undefined;
  const { key, pk: cursorPk } = decoded;
  return sql`((${col} > ${key}) OR (${col} = ${key} AND ${pk} > ${cursorPk}))`;
}

function notFound(): never {
  throw new XRPCError({ status: 404, error: 'NotFound', message: 'record not found' });
}

/** Extract the record key (rkey) segment from an at-uri for our own collection. */
function rkeyFromUri(ctx: ViewContext, collection: string, uri: string): string {
  const prefix = `at://${ctx.serviceDid}/${collection}/`;
  if (!uri.startsWith(prefix)) {
    throw new InvalidRequestError({
      status: 400,
      error: 'InvalidRequest',
      message: 'uri must reference a record hosted by this service',
    });
  }
  const rkey = uri.slice(prefix.length);
  if (!rkey || rkey.includes('/')) {
    throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'invalid record uri' });
  }
  return rkey;
}

/** Parse a user record at-uri (`at://<did>/<collection>/<rkey>`). */
function parseRecordUri(uri: string): { did: string; collection: string; rkey: string } {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match || !match[1].startsWith('did:')) {
    throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'invalid record uri' });
  }
  return { did: match[1], collection: match[2], rkey: match[3] };
}

function requireCollection(parsed: { collection: string }, expected: string): void {
  if (parsed.collection !== expected) {
    throw new InvalidRequestError({
      status: 400,
      error: 'InvalidRequest',
      message: `uri must reference a ${expected} record`,
    });
  }
}

/** Hydrate a catalog bookView from an `expandedBook.ref`, or undefined if unknown/unreleased. */
async function hydrateBook(
  db: Db,
  ctx: ViewContext,
  ref: string | undefined,
): Promise<BookView | undefined> {
  const rkey = bookRkeyFromRef(ref);
  if (!rkey) return undefined;
  const row = (await db.select().from(books).where(and(eq(books.pk, rkey), releasedFilter(books))))[0];
  return row ? toBookView(db, ctx, row) : undefined;
}

/** Index shelf records by their at-uri. */
function shelfIndex(records: PdsRecord[]): Map<string, ShelfView> {
  return new Map(records.map((rec) => [rec.uri, toShelfView(rec)]));
}

/** Order bookShelving records by `position` (null positions last), then record order. */
function sortByPosition(a: PdsRecord, b: PdsRecord): number {
  const pa = (a.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main).metadata?.position;
  const pb = (b.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main).metadata?.position;
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

// In-memory pagination over already-fetched lists; the cursor encodes the
// offset into the (filtered) list.
function encodeOffsetCursor(offset: number): string {
  return encodeCursor({ key: 'offset', pk: String(offset) });
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor == null) return 0;
  const decoded = decodeCursorParam(cursor);
  const offset = Number(decoded!.pk);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'invalid cursor' });
  }
  return offset;
}

function paginate<T>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): { page: T[]; cursor: string | undefined } {
  const offset = decodeOffsetCursor(cursor);
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return { page, cursor: hasMore ? encodeOffsetCursor(offset + page.length) : undefined };
}

export function createXrpcRouter(db: Db, ctx: ViewContext): XRPCRouter {
  const router = new XRPCRouter();
  registerPdsHandlers(router, db, ctx);

  router.addQuery(Lexicons.ComAtprotoLexiconResolveLexicon.mainSchema, {
    async handler({ params }) {
      let schemaNsid: string;
      try {
        schemaNsid = params.nsid;
        const { json: schemaJson, bytes } = loadLexiconSchema(schemaNsid);
        const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
        const hashBytes = new Uint8Array(hash);
        const digestObj = digest.create(0x12, hashBytes);
        const cid = CID.createV1(0x0129, digestObj);
        const uri = `at://${ctx.serviceDid}/com.atproto.lexicon.schema/${schemaNsid}`;
        return json({ uri, cid: cid.toString(), schema: schemaJson as unknown as Lexicons.ComAtprotoLexiconResolveLexicon.$output['schema'] });
      } catch (err) {
        if (err instanceof LexiconNotFound) {
          throw new XRPCError({ status: 400, error: 'LexiconNotFound', message: err.message });
        }
        throw err;
      }
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBook.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const rkey = rkeyFromUri(ctx, COLLECTION.book, params.uri);
      const row = (await db.select().from(books).where(and(eq(books.pk, rkey), releasedFilter(books))))[0];
      if (!row) notFound();
      return json({ book: await toBookView(db, ctx, row!) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetWork.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const rkey = rkeyFromUri(ctx, COLLECTION.work, params.uri);
      const row = (await db.select().from(works).where(and(eq(works.pk, rkey), releasedFilter(works))))[0];
      if (!row) notFound();
      const identifiers = await db
        .select()
        .from(workIdentifiers)
        .where(eq(workIdentifiers.workPk, rkey));
      return json({ work: toWorkView(ctx, row!, identifiers) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetContributor.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const rkey = rkeyFromUri(ctx, COLLECTION.contributor, params.uri);
      const row = (await db.select().from(contributors).where(and(eq(contributors.pk, rkey), releasedFilter(contributors))))[0];
      if (!row) notFound();
      const identifiers = await db
        .select()
        .from(contributorIdentifiers)
        .where(eq(contributorIdentifiers.contributorPk, rkey));
      return json({ contributor: toContributorView(ctx, row!, identifiers) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetReview.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const parsed = parseRecordUri(params.uri);
      requireCollection(parsed, COLLECTION.review);
      const rec = await getUserRecord(db, parsed.did, COLLECTION.review, parsed.rkey);
      if (!rec) notFound();
      const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioReview.Main;
      const book = await hydrateBook(db, ctx, value.book?.ref);
      if (!book) notFound();
      return json({ review: await toReviewView(db, ctx, rec, parsed.did, book) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelf.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const parsed = parseRecordUri(params.uri);
      requireCollection(parsed, COLLECTION.shelf);
      const rec = await getUserRecord(db, parsed.did, COLLECTION.shelf, parsed.rkey);
      if (!rec) notFound();
      return json({ shelf: toShelfView(rec) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetGenre.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const rkey = rkeyFromUri(ctx, COLLECTION.genre, params.uri);
      const row = (await db.select().from(genres).where(and(eq(genres.pk, rkey), releasedFilter(genres))))[0];
      if (!row) notFound();
      const identifiers = await db
        .select()
        .from(genreIdentifiers)
        .where(eq(genreIdentifiers.genrePk, rkey));
      return json({ genre: toGenreView(ctx, row!, identifiers) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooks.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const limit = clampLimit(params.limit);
      const filters = [releasedFilter(books)];
      if (params.genre) {
        const genrePk = rkeyFromUri(ctx, COLLECTION.genre, params.genre);
        const sub = db
          .select({ bookPk: bookGenres.bookPk })
          .from(bookGenres)
          .where(eq(bookGenres.genrePk, genrePk));
        filters.push(sql`${books.pk} in (${sub})`);
      }
      if (params.work) {
        const workPk = rkeyFromUri(ctx, COLLECTION.work, params.work);
        filters.push(eq(books.workPk, workPk));
      }
      if (params.format) {
        const formatPk = rkeyFromUri(ctx, COLLECTION.format, params.format);
        filters.push(eq(books.formatPk, formatPk));
      }
      const where = filters.length ? and(...filters) : undefined;
      const rows = await db
        .select()
        .from(books)
        .where(and(where, cursorAfter(books.title, books.pk, params.cursor)))
        .orderBy(sql`${books.title} asc, ${books.pk} asc`)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const views = [];
      for (const row of page) views.push(await toBookView(db, ctx, row));
      const last = page.at(-1);
      return json({
        books: views,
        cursor: hasMore && last ? encodeCursor({ key: last.title, pk: last.pk }) : undefined,
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListReviewsByBook.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const bookPk = rkeyFromUri(ctx, COLLECTION.book, params.book);
      const bookRow = (await db.select().from(books).where(and(eq(books.pk, bookPk), releasedFilter(books))))[0];
      if (!bookRow) notFound();
      const limit = clampLimit(params.limit);
      const records = await listByCollection(db, COLLECTION.review);
      const book = await toBookView(db, ctx, bookRow);
      const reviews: ReviewView[] = [];
      for (const rec of records) {
        const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioReview.Main;
        if (value.book?.ref !== params.book) continue;
        const owner = parseRecordUri(rec.uri).did;
        reviews.push(await toReviewView(db, ctx, rec, owner, book));
      }
      const { page, cursor } = paginate(reviews, limit, params.cursor);
      return json({ reviews: page, cursor });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const limit = clampLimit(params.limit);
      const records = await listByCollection(db, COLLECTION.shelf);
      const shelves = records.map((rec) => toShelfView(rec));
      const { page, cursor } = paginate(shelves, limit, params.cursor);
      return json({ shelves: page, cursor });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBookOnShelf.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const parsed = parseRecordUri(params.uri);
      requireCollection(parsed, COLLECTION.bookShelf);
      const rec = await getUserRecord(db, parsed.did, COLLECTION.bookShelf, parsed.rkey);
      if (!rec) notFound();
      const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main;
      const book = await hydrateBook(db, ctx, value.book?.ref);
      if (!book) notFound();
      const shelfParsed = parseRecordUri(String(value.shelf));
      const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
      if (!shelfRec) notFound();
      return json({ bookShelf: toBookShelfView(rec, parsed.did, toShelfView(shelfRec), book) });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelvingOfBook.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const limit = clampLimit(params.limit);
      const shelfRecords = await listByCollection(db, COLLECTION.shelf);
      const shelvingRecords = await listByCollection(db, COLLECTION.bookShelf);
      const shelves = shelfIndex(shelfRecords);
      const views: BookShelfView[] = [];
      for (const rec of shelvingRecords) {
        const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main;
        if (value.book?.ref !== params.book) continue;
        const shelf = shelves.get(String(value.shelf));
        if (!shelf) continue;
        const book = await hydrateBook(db, ctx, value.book.ref);
        if (!book) continue;
        const owner = parseRecordUri(rec.uri).did;
        views.push(toBookShelfView(rec, owner, shelf, book));
      }
      const { page, cursor } = paginate(views, limit, params.cursor);
      return json({ bookShelves: page, cursor });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooksOnShelf.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const limit = clampLimit(params.limit);
      const shelfRecords = await listByCollection(db, COLLECTION.shelf);
      const shelvingRecords = await listByCollection(db, COLLECTION.bookShelf);
      const shelves = shelfIndex(shelfRecords);
      const filtered = shelvingRecords
        .filter((rec) => String((rec.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main).shelf) === params.shelf)
        .sort(sortByPosition);
      const views: BookShelfView[] = [];
      for (const rec of filtered) {
        const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main;
        const shelf = shelves.get(String(value.shelf));
        if (!shelf) continue;
        const book = await hydrateBook(db, ctx, value.book?.ref);
        if (!book) continue;
        const owner = parseRecordUri(rec.uri).did;
        views.push(toBookShelfView(rec, owner, shelf, book));
      }
      const { page, cursor } = paginate(views, limit, params.cursor);
      return json({ bookShelves: page, cursor });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelvesWithBooks.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const limit = clampLimit(params.limit);
      const shelfRecords = await listByCollection(db, COLLECTION.shelf);
      const shelvingRecords = await listByCollection(db, COLLECTION.bookShelf);
      const shelves = shelfIndex(shelfRecords);
      const shelvingsByShelf = new Map<string, PdsRecord[]>();
      for (const rec of shelvingRecords) {
        const shelfUri = String((rec.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main).shelf);
        const list = shelvingsByShelf.get(shelfUri) ?? [];
        list.push(rec);
        shelvingsByShelf.set(shelfUri, list);
      }
      const views: ShelfWithBooksView[] = [];
      for (const rec of shelfRecords) {
        const shelfView = shelves.get(rec.uri)!;
        const shelvings = (shelvingsByShelf.get(rec.uri) ?? []).sort(sortByPosition);
        const shelfBooks: BookShelfView[] = [];
        for (const shelving of shelvings) {
          const value = shelving.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main;
          const book = await hydrateBook(db, ctx, value.book?.ref);
          if (!book) continue;
          const owner = parseRecordUri(shelving.uri).did;
          shelfBooks.push(toBookShelfView(shelving, owner, shelfView, book));
        }
        views.push(toShelfWithBooksView(shelfView, shelfBooks));
      }
      const { page, cursor } = paginate(views, limit, params.cursor);
      return json({ shelves: page, cursor });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListGenres.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const limit = clampLimit(params.limit);
      const conds = [releasedFilter(genres)];
      if (params.topLevelOnly) conds.push(sql`${genres.parentPk} is null`);
      const rows = await db
        .select()
        .from(genres)
        .where(and(...conds, cursorAfter(genres.name, genres.pk, params.cursor)))
        .orderBy(sql`${genres.name} asc, ${genres.pk} asc`)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const pks = page.map((g) => g.pk);
      const idRows: { genrePk: string; resource: string; url: string }[] = pks.length
        ? await db
          .select()
          .from(genreIdentifiers)
          .where(inArray(genreIdentifiers.genrePk, pks))
        : [];
      const idByGenre = new Map<string, { genrePk: string; resource: string; url: string }[]>();
      for (const row of idRows) {
        const list = idByGenre.get(row.genrePk) ?? [];
        list.push(row);
        idByGenre.set(row.genrePk, list);
      }
      const last = page.at(-1);
      return json({
        genres: page.map((g) => toGenreView(ctx, g, idByGenre.get(g.pk) ?? [])),
        cursor: hasMore && last ? encodeCursor({ key: last.name, pk: last.pk }) : undefined,
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchBooks.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const q = params.q.trim();
      const limit = clampLimit(params.limit);
      const term = `%${q}%`;
      logger.info({ q, limit }, 'Searching books...');
      const idSub = db
        .select({ bookPk: bookIdentifiers.bookPk })
        .from(bookIdentifiers)
        .where(like(bookIdentifiers.resource, term));
      const where = and(
        releasedFilter(books),
        or(
          like(books.title, term),
          like(books.description, term),
          sql`${books.pk} in (${idSub})`,
        ),
      );
      const rows = await db
        .select()
        .from(books)
        .where(and(where, cursorAfter(books.title, books.pk, params.cursor)))
        .orderBy(sql`${books.title} asc, ${books.pk} asc`)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const views = [];
      for (const row of page) views.push(await toBookView(db, ctx, row));
      const hitsTotal = (await db.select({ count: sql`count(*)` }).from(books).where(where))[0];
      const last = page.at(-1);
      const hitsTotalCount = Number(hitsTotal?.count ?? 0);
      const cursor = hasMore && last ? encodeCursor({ key: last.title, pk: last.pk }) : undefined;
      logger.info({ count: views.length, hits: hitsTotalCount, cursor, q, limit }, "Search completed")
      return json({
        books: views,
        hitsTotal: hitsTotalCount,
        cursor,
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchContributors.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const q = params.q.trim();
      const limit = clampLimit(params.limit);
      const term = `%${q}%`;
      const filters = [
        releasedFilter(contributors),
        or(like(contributors.name, term), like(contributors.sortName, term), like(contributors.bio, term)),
      ];
      if (params.role) {
        const rolePk = rkeyFromUri(ctx, COLLECTION.contributorRole, params.role);
        const sub = db
          .select({ contributorPk: bookContributors.contributorPk })
          .from(bookContributors)
          .innerJoin(books, eq(bookContributors.bookPk, books.pk))
          .where(and(eq(bookContributors.rolePk, rolePk), releasedFilter(books)));
        filters.push(sql`${contributors.pk} in (${sub})`);
      }
      const where = and(...filters);
      const rows = await db
        .select()
        .from(contributors)
        .where(and(where, cursorAfter(contributors.name, contributors.pk, params.cursor)))
        .orderBy(sql`${contributors.name} asc, ${contributors.pk} asc`)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const pks = page.map((a) => a.pk);
      const idRows: { contributorPk: string; resource: string; url: string }[] = pks.length
        ? await db
          .select()
          .from(contributorIdentifiers)
          .where(inArray(contributorIdentifiers.contributorPk, pks))
        : [];
      const idByContributor = new Map<string, { contributorPk: string; resource: string; url: string }[]>();
      for (const row of idRows) {
        const list = idByContributor.get(row.contributorPk) ?? [];
        list.push(row);
        idByContributor.set(row.contributorPk, list);
      }
      const hitsTotal = (await db.select({ count: sql`count(*)` }).from(contributors).where(where))[0];
      const last = page.at(-1);
      return json({
        contributors: page.map((a) => toContributorView(ctx, a, idByContributor.get(a.pk) ?? [])),
        hitsTotal: Number(hitsTotal?.count ?? 0),
        cursor: hasMore && last ? encodeCursor({ key: last.name, pk: last.pk }) : undefined,
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchReviews.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const q = (params.q ?? '').trim();
      const term = q.toLowerCase();
      const limit = clampLimit(params.limit);
      const records = await listByCollection(db, COLLECTION.review);
      const matched: ReviewView[] = [];
      for (const rec of records) {
        const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioReview.Main;
        if (q && !(value.text ?? '').toLowerCase().includes(term)) continue;
        if (params.book && value.book?.ref !== params.book) continue;
        if (params.rating != null && (value.rating ?? 0) < params.rating) continue;
        if (params.status && value.status !== params.status) continue;
        if (params.tag?.length && !params.tag.some((t) => (value.tags ?? []).includes(t))) continue;
        const book = await hydrateBook(db, ctx, value.book?.ref);
        if (!book) continue;
        const owner = parseRecordUri(rec.uri).did;
        matched.push(await toReviewView(db, ctx, rec, owner, book));
      }
      const { page, cursor } = paginate(matched, limit, params.cursor);
      return json({ reviews: page, hitsTotal: matched.length, cursor });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchWorks.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const q = params.q.trim();
      const limit = clampLimit(params.limit);
      const term = `%${q}%`;
      const idSub = db
        .select({ workPk: workIdentifiers.workPk })
        .from(workIdentifiers)
        .where(like(workIdentifiers.resource, term));
      const where = and(
        releasedFilter(works),
        or(
          like(works.title, term),
          like(works.description, term),
          sql`${works.pk} in (${idSub})`,
        ),
      );
      const rows = await db
        .select()
        .from(works)
        .where(and(where, cursorAfter(works.title, works.pk, params.cursor)))
        .orderBy(sql`${works.title} asc, ${works.pk} asc`)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const pks = page.map((w) => w.pk);
      const idRows: { workPk: string; resource: string; url: string }[] = pks.length
        ? await db
          .select()
          .from(workIdentifiers)
          .where(inArray(workIdentifiers.workPk, pks))
        : [];
      const idByWork = new Map<string, { workPk: string; resource: string; url: string }[]>();
      for (const row of idRows) {
        const list = idByWork.get(row.workPk) ?? [];
        list.push(row);
        idByWork.set(row.workPk, list);
      }
      const hitsTotal = (await db.select({ count: sql`count(*)` }).from(works).where(where))[0];
      const last = page.at(-1);
      return json({
        works: page.map((w) => toWorkView(ctx, w, idByWork.get(w.pk) ?? [])),
        hitsTotal: Number(hitsTotal?.count ?? 0),
        cursor: hasMore && last ? encodeCursor({ key: last.title, pk: last.pk }) : undefined,
      });
    },
  });

  router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetActor.mainSchema, {
    async handler({ params, request }) {
      const session = await authenticateOptional(request);
      void session;
      const rec = await getUserRecord(db, params.actor, COLLECTION.actor, 'self');
      return json({ actor: toActorView(rec, { did: params.actor }) });
    },
  });

  return router;
}
