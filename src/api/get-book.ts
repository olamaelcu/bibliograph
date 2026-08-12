import type { Context } from 'hono';
import { and, asc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { getLabels } from '../labeler.js';
import { parsePagination, nextCursor } from '../pagination.js';
import { searchFallback, type FallbackResult, type FallbackSource } from './search-fallback.js';
import { computeDeduplicationHash } from '../dedup.js';
import { parseIdentifierInput, resolveBooksByIdentifier, type ResolvedBook } from './identifier-lookup.js';
import { serializeContributor, serializeContributorType } from './contributor.js';
import { ftsSearchBooks } from '../db/init.js';
import type { BookData } from '../providers/interface.js';
import type {
  GetBookParams, GetBooksParams, GetReviewsParams, GetReviewParams,
  GetUserStatusParams, SearchBooksParams, GetClaimsParams,
  GetShelvesParams, GetShelfParams, GetShelfItemsParams,
  BookContributorJoined,
} from '../types.js';

const { books, reviews, readingStatuses, claims, shelves, shelfItems, contributors, contributorTypes, bookContributors } = schema;

export async function getBooks(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const uris = c.req.queries('uris');
  if (!uris?.length) {
    log.warn('getBooks rejected: missing uris');
    return c.json({ error: 'InvalidRequest', message: 'uris is required' }, 400);
  }

  log.info({ count: uris.length }, 'handling getBooks');

  const sliced = uris.slice(0, 25);
  const notFound: string[] = [];
  const multiMatch: Array<{ input: string; count: number }> = [];
  const matched: ResolvedBook[] = [];

  for (const input of sliced) {
    const ident = parseIdentifierInput(input);
    if (!ident) {
      log.warn({ input }, 'getBooks rejected: unparseable identifier');
      return c.json(
        {
          error: 'InvalidInput',
          message: 'one or more uris is not a recognized identifier',
        },
        400,
      );
    }
    const rows = await resolveBooksByIdentifier(db, input);
    if (rows.length === 0) {
      notFound.push(input);
      continue;
    }
    matched.push(pickCanonicalBook(rows));
    if (rows.length > 1) {
      multiMatch.push({ input, count: rows.length });
    }
  }

  const contributorMap = await attachContributors(matched.map((r) => r.uri));

  log.info(
    { found: matched.length, notFound: notFound.length, multiMatch: multiMatch.length },
    'getBooks complete',
  );
  return c.json({
    books: matched.map((book) => ({
      uri: book.uri,
      record: serializeBookRecord(book),
      cid: undefined,
      contributors: contributorMap.get(book.uri) ?? [],
    })),
    notFound,
    multiMatch,
  });
}

export async function getReviews(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { bookUri, cursor, limit = '50' } = c.req.query();
  if (!bookUri) {
    log.warn('getReviews rejected: missing bookUri');
    return c.json({ error: 'InvalidRequest', message: 'bookUri is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ bookUri, limit: lim }, 'handling getReviews');

  const results = await db.query.reviews.findMany({
    where: eq(reviews.bookUri, bookUri),
    orderBy: (reviews, { desc }) => [desc(reviews.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ found: results.length, hasCursor: !!cursorOut }, 'getReviews complete');
  return c.json({
    reviews: results.map(r => ({
      uri: r.uri,
      did: r.did,
      record: {
        $type: 'community.lexicon.book.review',
        bookUri: r.bookUri,
        text: r.text,
        rating: r.rating,
        bookRef: {
          uri: r.bookUri,
          title: r.bookTitle,
          author: r.bookAuthor,
        },
        createdAt: r.createdAt,
      },
    })),
    cursor: cursorOut,
  });
}

export async function getReview(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { uri, did, bookUri } = c.req.query();

  let where;
  if (uri) {
    where = eq(reviews.uri, uri);
  } else if (did && bookUri) {
    where = and(eq(reviews.did, did), eq(reviews.bookUri, bookUri));
  } else {
    log.warn('getReview rejected: uri or did+bookUri required');
    return c.json({ error: 'InvalidRequest', message: 'uri or did+bookUri is required' }, 400);
  }

  log.info({ uri, did, bookUri }, 'handling getReview');

  const review = await db.query.reviews.findFirst({ where });
  if (!review) {
    log.info({ found: false }, 'getReview complete');
    return c.json({ error: 'NotFound', message: 'Review not found' }, 404);
  }

  log.info({ found: true }, 'getReview complete');
  return c.json({
    uri: review.uri,
    did: review.did,
    record: {
      $type: 'community.lexicon.book.review',
      bookUri: review.bookUri,
      text: review.text,
      rating: review.rating,
      bookRef: {
        uri: review.bookUri,
        title: review.bookTitle,
        author: review.bookAuthor,
      },
      createdAt: review.createdAt,
    },
    cid: review.cid ?? undefined,
  });
}

export async function getUserStatus(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { did, bookUri, status, cursor, limit = '50' } = c.req.query();
  if (!did) {
    log.warn('getUserStatus rejected: missing did');
    return c.json({ error: 'InvalidRequest', message: 'did is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ did, bookUri, status, limit: lim }, 'handling getUserStatus');

  const conditions = [eq(readingStatuses.did, did)];
  if (bookUri) conditions.push(eq(readingStatuses.bookUri, bookUri));
  if (status) conditions.push(eq(readingStatuses.status, status));

  const results = await db.query.readingStatuses.findMany({
    where: (fields, { and }) => and(...conditions),
    orderBy: (fields, { desc }) => [desc(fields.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ uris: results.map(s => s.uri), found: results.length }, 'getUserStatus complete');
  return c.json({
    statuses: results.map(s => ({
      uri: s.uri,
      did: s.did,
      bookUri: s.bookUri,
      record: {
        $type: 'community.lexicon.book.status',
        bookUri: s.bookUri,
        status: s.status,
        progress: s.progress,
        rating: s.rating,
        bookRef: {
          uri: s.bookUri,
          title: s.bookTitle,
          author: s.bookAuthor,
        },
        identifiers: typeof s.identifiers === 'string' ? JSON.parse(s.identifiers) : s.identifiers,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        createdAt: s.createdAt,
      },
    })),
    cursor: cursorOut,
  });
}

function pickCanonicalBook(rows: ResolvedBook[]): ResolvedBook {
  return [...rows].sort((a, b) => {
    const aActive = a.status === 'active' ? 0 : 1;
    const bActive = b.status === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.createdAt.localeCompare(b.createdAt);
  })[0];
}

async function findImportedBookRow(book: BookData) {
  const canonical = book.isbn13 || book.isbn10;
  if (canonical) {
    const byIsbn = await db.query.books.findFirst({ where: eq(books.isbn, canonical) });
    if (byIsbn) return byIsbn;
  }
  const dhash = computeDeduplicationHash(book.title, book.contributors[0]?.name ?? '', book.publishedDate);
  if (dhash) {
    const byHash = await db.query.books.findFirst({ where: eq(books.deduplicationHash, dhash) });
    if (byHash) return byHash;
  }
  return null;
}

function providerRecord(book: BookData): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.book',
    title: book.title,
    author: book.contributors[0]?.name ?? '',
    isbn: book.isbn13 || book.isbn10,
    publishedDate: book.publishedDate,
    description: book.description,
    pageCount: book.pageCount,
    language: book.language,
    categories: book.categories || [],
    identifiers: book.identifiers,
    coverUrl: book.coverUrl,
    cover: book.cover,
  };
}

interface FallbackEntry {
  uri: string;
  record: Record<string, unknown>;
  source: FallbackSource;
}

async function enrichFallbackBooks(fallbackBooks: BookData[], source: FallbackSource): Promise<FallbackEntry[]> {
  const entries: FallbackEntry[] = [];
  for (const book of fallbackBooks) {
    const row = await findImportedBookRow(book);
    if (row) {
      entries.push({ uri: row.uri, record: providerRecord(book), source });
    }
  }
  return entries;
}

function getSearchFallbackTimeoutMs(): number {
  const raw = process.env.SEARCH_FALLBACK_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 4000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4000;
}

async function searchFallbackWithTimeout(
  sanitized: string,
  log: import('pino').Logger,
): Promise<FallbackResult> {
  const timeoutMs = getSearchFallbackTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FallbackResult>(resolve => {
    timer = setTimeout(() => {
      log.warn({ q: sanitized, timeoutMs }, 'searchFallback timeout — returning empty');
      resolve({ books: [], source: 'none' });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([searchFallback(db, sanitized, log), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function searchBooksHandler(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { q, limit = '20', cursor, identifier, includeUnverified } = c.req.query();
  if (!q && !identifier) {
    log.warn('searchBooks rejected: missing q and identifier');
    return c.json({ error: 'InvalidRequest', message: 'q or identifier is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 20, 100);

  log.info({ q, identifier, limit: lim }, 'handling searchBooksHandler');

  if (identifier) {
    const sanitized = (q as string || '').replace(/['"]/g, '').trim();
    const identifierTypes = (identifier as string).split(',').map(t => t.trim()).filter(Boolean);

    const conditions: ReturnType<typeof sql>[] = [sql`1 = 1`];

    if (sanitized) {
      conditions.push(sql`identifier_value LIKE ${`%${sanitized}%`}`);
    }

    if (identifierTypes.length > 0) {
      conditions.push(
        sql`identifier_type IN (${sql.join(identifierTypes.map(t => sql`${t}`), sql`, `)})`,
      );
    }

    if (includeUnverified !== 'true') {
      conditions.push(sql`claim_status IN ('json', 'verified')`);
    }

    const rows = db.all(
      sql`
        SELECT DISTINCT uri, title, author, isbn, identifier_type, identifier_value, claim_status
        FROM books_identifiers
        WHERE ${and(...conditions)}
        ORDER BY title
        LIMIT ${lim} OFFSET ${offset}
      `,
    ) as Array<{ uri: string; title: string; author: string; isbn: string | null; identifier_type: string; identifier_value: string; claim_status: string }>;

    const bookEntries: Array<Record<string, unknown>> = rows.map(row => ({
      uri: row.uri,
      record: {
        $type: 'community.lexicon.book.book',
        title: row.title,
        author: row.author,
        isbn: row.isbn,
      },
      matchedIdentifier: {
        type: row.identifier_type,
        value: row.identifier_value,
        status: row.claim_status,
      },
    }));

    if (rows.length === 0 && identifierTypes.length === 1 && identifierTypes[0] === 'isbn' && sanitized) {
      const fb = await searchFallbackWithTimeout(sanitized, log);
      const enriched = await enrichFallbackBooks(fb.books, fb.source);
      for (const entry of enriched) {
        bookEntries.push({
          uri: entry.uri,
          record: entry.record,
          source: entry.source,
        });
      }
    }

    log.info({ found: bookEntries.length }, 'searchBooksHandler complete');
    return c.json({
      books: bookEntries,
      cursor: nextCursor(bookEntries.length, offset, lim),
    });
  }

  const sanitized = (q as string).replace(/['"]/g, '').trim();

  let results: Array<typeof books.$inferSelect>;
  if (sanitized.match(/^[0-9-]+$/)) {
    results = await db.query.books.findMany({
      where: or(like(books.isbn, `%${sanitized}%`), like(books.title, `%${sanitized}%`)),
      limit: lim,
      offset,
    });
  } else {
    results = ftsSearchBooks(sanitized, lim, offset);
  }

  const contributorMap = await attachContributors(results.map((r) => r.uri));

  const bookEntries: Array<{ uri: string; record: Record<string, unknown>; source?: FallbackSource; contributors?: BookContributorJoined[] }> = results.map(book => ({
    uri: book.uri,
    record: serializeBookRecord(book),
    contributors: contributorMap.get(book.uri) ?? [],
  }));

  if (results.length === 0 && sanitized) {
    const fb = await searchFallbackWithTimeout(sanitized, log);
    const enriched = await enrichFallbackBooks(fb.books, fb.source);
    const enrichedUris = enriched.map((e) => e.uri);
    const enrichedContributorMap = await attachContributors(enrichedUris);
    for (const entry of enriched) {
      bookEntries.push({
        uri: entry.uri,
        record: entry.record,
        source: entry.source,
        contributors: enrichedContributorMap.get(entry.uri) ?? [],
      });
    }
  }

  log.info({ found: bookEntries.length }, 'searchBooksHandler complete');
  return c.json({
    books: bookEntries,
    cursor: nextCursor(bookEntries.length, offset, lim),
    total: bookEntries.length,
  });
}

export async function listBooksHandler(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { limit = '50', cursor, includeUnverified } = c.req.query();

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ limit: lim, offset, includeUnverified }, 'handling listBooksHandler');

  const statusFilter = includeUnverified === 'true'
    ? or(eq(books.status, 'active'), eq(books.status, 'pending'))
    : eq(books.status, 'active');

  const rows = await db.select().from(books)
    .where(statusFilter)
    .orderBy(asc(books.createdAt), asc(books.uri))
    .limit(lim)
    .offset(offset)
    .all();

  const bookEntries: Array<{ uri: string; record: Record<string, unknown> }> = rows.map(book => ({
    uri: book.uri,
    record: serializeBookRecord(book),
  }));

  log.info({ found: bookEntries.length, nextOffset: offset + rows.length }, 'listBooksHandler complete');
  return c.json({
    books: bookEntries,
    cursor: nextCursor(bookEntries.length, offset, lim),
  });
}

export async function getClaims(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { bookUri } = c.req.query();
  if (!bookUri) {
    log.warn('getClaims rejected: missing bookUri');
    return c.json({ error: 'InvalidRequest', message: 'bookUri is required' }, 400);
  }

  log.info({ bookUri }, 'handling getClaims');

  const results = await db.query.claims.findMany({
    where: eq(claims.bookUri, bookUri),
    orderBy: (claims, { desc }) => [desc(claims.createdAt)],
  });

  log.info({ found: results.length }, 'getClaims complete');
  return c.json({
    claims: results.map(c => ({
      uri: c.uri,
      did: c.did,
      record: {
        $type: 'community.lexicon.book.claim',
        bookUri: c.bookUri,
        identifier: c.identifier,
        identifierType: c.identifierType,
        claimedBy: c.claimedBy,
        status: c.status,
        verifiedBy: c.verifiedBy,
        verifiedAt: c.verifiedAt,
        createdAt: c.createdAt,
      },
    })),
  });
}

function serializeBookRecord(book: typeof books.$inferSelect): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.book',
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    publishedDate: book.publishedDate,
    description: book.description,
    pageCount: book.pageCount,
    language: book.language,
    categories: typeof book.categories === 'string' ? JSON.parse(book.categories) : book.categories,
    identifiers: typeof book.identifiers === 'string' ? JSON.parse(book.identifiers) : book.identifiers,
    coverUrl: book.cover?.medium ?? book.coverUrl,
    cover: book.cover,
    deduplicationHash: book.deduplicationHash,
    status: book.status,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

export async function attachContributors(
  bookUris: string[],
): Promise<Map<string, BookContributorJoined[]>> {
  const out = new Map<string, BookContributorJoined[]>();
  if (bookUris.length === 0) return out;

  const joinRows = await db
    .select()
    .from(bookContributors)
    .where(inArray(bookContributors.bookUri, bookUris))
    .all();

  if (joinRows.length === 0) return out;

  const contributorUris = Array.from(new Set(joinRows.map((r) => r.contributorUri)));
  const roleUris = Array.from(new Set(joinRows.map((r) => r.roleUri)));

  const [contribRows, typeRows] = await Promise.all([
    contributorUris.length > 0
      ? db.select().from(contributors).where(inArray(contributors.uri, contributorUris)).all()
      : Promise.resolve([] as Array<typeof contributors.$inferSelect>),
    roleUris.length > 0
      ? db.select().from(contributorTypes).where(inArray(contributorTypes.uri, roleUris)).all()
      : Promise.resolve([] as Array<typeof contributorTypes.$inferSelect>),
  ]);

  const contributorByUri = new Map(contribRows.map((r) => [r.uri, r]));
  const typeByUri = new Map(typeRows.map((r) => [r.uri, r]));

  for (const row of joinRows) {
    const contrib = contributorByUri.get(row.contributorUri);
    const type = typeByUri.get(row.roleUri);
    if (!contrib || !type) continue;
    const entry: BookContributorJoined = {
      contributor: {
        uri: contrib.uri,
        cid: row.contributorCid,
        did: contrib.did,
        record: serializeContributor(contrib),
      },
      role: {
        uri: type.uri,
        cid: row.roleCid,
        did: type.did,
        record: serializeContributorType(type),
      },
      order: row.ordering ?? 0,
    };
    const arr = out.get(row.bookUri) ?? [];
    arr.push(entry);
    out.set(row.bookUri, arr);
  }

  for (const arr of out.values()) {
    arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  return out;
}

export async function getBook(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const params = c.req.query() as unknown as GetBookParams;
  if (!params.uri) {
    log.warn('getBook rejected: missing uri');
    return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);
  }

  log.info({ uri: params.uri }, 'handling getBook');

  const ident = parseIdentifierInput(params.uri);
  if (!ident) {
    log.warn({ uri: params.uri }, 'getBook rejected: unparseable identifier');
    return c.json(
      {
        error: 'InvalidInput',
        message: 'uri must be an AT-URI, ISBN, OLID, or other recognized identifier',
      },
      400,
    );
  }

  const matches = await resolveBooksByIdentifier(db, params.uri);
  if (matches.length === 0) {
    log.info({ found: false }, 'getBook complete');
    return c.json({ error: 'NotFound', message: 'Book not found' }, 404);
  }
  if (matches.length > 1) {
    log.info({ count: matches.length }, 'getBook 409 MultipleBooks');
    return c.json(
      {
        error: 'MultipleBooks',
        message: 'Identifier matches multiple books; use getBooks to disambiguate',
        identifier: params.uri,
        candidates: matches.slice(0, 10).map((b) => ({
          uri: b.uri,
          title: b.title,
          author: b.author,
        })),
      },
      409,
    );
  }

  const book = matches[0];
  const contributorMap = await attachContributors([book.uri]);
  const contributorsArr = contributorMap.get(book.uri) ?? [];

  log.info({ found: true }, 'getBook complete');
  return c.json({
    uri: book.uri,
    record: serializeBookRecord(book),
    cid: undefined,
    contributors: contributorsArr,
  });
}

export async function getShelves(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { did, cursor, limit = '50' } = c.req.query();
  if (!did) {
    log.warn('getShelves rejected: missing did');
    return c.json({ error: 'InvalidRequest', message: 'did is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ did, limit: lim }, 'handling getShelves');

  const results = await db.query.shelves.findMany({
    where: eq(shelves.did, did),
    orderBy: (shelves, { desc }) => [desc(shelves.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ found: results.length, hasCursor: !!cursorOut }, 'getShelves complete');
  return c.json({
    shelves: results.map(s => ({
      uri: s.uri,
      did: s.did,
      record: serializeShelfRecord(s),
    })),
    cursor: cursorOut,
  });
}

export async function getShelf(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { uri } = c.req.query();
  if (!uri) {
    log.warn('getShelf rejected: missing uri');
    return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);
  }

  log.info({ uri }, 'handling getShelf');

  const shelf = await db.query.shelves.findFirst({ where: eq(shelves.uri, uri) });
  if (!shelf) {
    log.info({ found: false }, 'getShelf complete');
    return c.json({ error: 'NotFound', message: 'Shelf not found' }, 404);
  }

  log.info({ found: true }, 'getShelf complete');
  return c.json({
    uri: shelf.uri,
    did: shelf.did,
    record: serializeShelfRecord(shelf),
  });
}

export async function getShelfItems(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { shelfUri, cursor, limit = '50' } = c.req.query();
  if (!shelfUri) {
    log.warn('getShelfItems rejected: missing shelfUri');
    return c.json({ error: 'InvalidRequest', message: 'shelfUri is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ shelfUri, limit: lim }, 'handling getShelfItems');

  const results = await db.query.shelfItems.findMany({
    where: eq(shelfItems.shelfUri, shelfUri),
    orderBy: (shelfItems, { desc }) => [desc(shelfItems.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ found: results.length, hasCursor: !!cursorOut }, 'getShelfItems complete');
  return c.json({
    items: results.map(i => ({
      uri: i.uri,
      did: i.did,
      record: {
        $type: 'community.lexicon.book.shelfItem',
        shelfUri: i.shelfUri,
        bookUri: i.bookUri,
        bookRef: {
          uri: i.bookUri,
          title: i.bookTitle,
          author: i.bookAuthor,
        },
        note: i.note,
        createdAt: i.createdAt,
      },
    })),
    cursor: cursorOut,
  });
}

function serializeShelfRecord(shelf: typeof shelves.$inferSelect): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.shelf',
    name: shelf.name,
    description: shelf.description,
    metadata: typeof shelf.metadata === 'string' ? JSON.parse(shelf.metadata) : shelf.metadata,
    coverUrl: shelf.cover?.medium ?? shelf.coverUrl,
    cover: shelf.cover,
    createdAt: shelf.createdAt,
  };
}

export function getLabelerLabels(c: Context): Response {
  const log = c.get('log') as import('pino').Logger;
  const { uri, val } = c.req.query();
  if (!uri) {
    log.warn('getLabelerLabels rejected: missing uri');
    return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);
  }

  log.info({ uri, val }, 'handling getLabelerLabels');

  const labels = getLabels(uri, val || undefined);
  log.info({ found: labels.length }, 'getLabelerLabels complete');
  return c.json({ labels });
}
