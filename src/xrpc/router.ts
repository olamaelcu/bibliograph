import { and, eq, isNull, like, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { XRPCRouter, json, XRPCError, InvalidRequestError } from '@atcute/xrpc-server';
import { CID, digest } from 'multiformats';
import { loadLexiconSchema, LexiconNotFound } from '../lexicon-resolve.js';
import * as Lexicons from '../lexicons/index.js';
import { registerPdsHandlers } from '../pds/router.js';
import { GoogleBooksClient, GoogleBooksError, type GbVolume } from '../google-books/client.js';
import { decodeGbCursor, encodeGbCursor, gbVolumeToBookView } from '../google-books/mapper.js';
import { getCached, setCached, TTL } from '../google-books/cache.js';
import { logger } from '../logger.js';
import { releasedFilter } from './gate.js';
import {
	hydrateBook,
	toActorView,
	toBookShelfView,
	toContributorView,
	toGenreView,
	toShelfView,
	toShelfWithBooksView,
	withActorBsky,
	withShelfBsky,
} from './hydrate.js';
import { listByCollection, getUserRecord } from '../jetstream/query.js';
import { contributors, genres } from '../db/schema.js';
import { COLLECTION, type PdsRecord, type ViewContext } from '../lex/collections.js';
import type {
	BookShelfView,
	BookView,
	GenreView,
	ShelfWithBooksView,
} from '../lexicons/types/net/olamaelcu/livtet/biblio/defs.js';

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

function parseVolumeId(uri: string): string {
	const { rkey } = parseRkey(uri);
	if (!rkey.startsWith('gb-')) {
		throw new InvalidRequestError({
			status: 400,
			error: 'InvalidRequest',
			message: `rkey must be 'gb-{volumeId}', got '${rkey}'`,
		});
	}
	const volumeId = rkey.slice(3);
	if (!VOLUME_ID_RE.test(volumeId)) {
		throw new InvalidRequestError({
			status: 400,
			error: 'InvalidRequest',
			message: `invalid google books volume id: '${volumeId}'`,
		});
	}
	return volumeId;
}

function buildGbQuery(opts: { q?: string; genre?: string; contributor?: string }): string {
	const terms: string[] = [];
	if (opts.contributor) {
		const slug = parseRkey(opts.contributor).rkey;
		const authorName = slug.replace(/^gbauthors-/, '').replace(/^c-/, '').replace(/-/g, ' ');
		terms.push(`inauthor:"${authorName.replace(/"/g, '')}"`);
	}
	if (opts.genre) {
		const slug = parseRkey(opts.genre).rkey;
		terms.push(`subject:${slug.replace(/^gbgenres-/, '')}`);
	}
	if (opts.q) terms.push(opts.q);
	return terms.join(' ');
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 40;

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
	const t0 = Date.now();
	logger.info(
		{ nsid, requestId: opts.requestId, params: opts.params, timeoutMs: opts.timeoutMs },
		'xrpc handler started',
	);
	try {
		const result = await withHandlerTimeout(nsid, work, opts.timeoutMs);
		logger.info(
			{ nsid, requestId: opts.requestId, durationMs: Date.now() - t0 },
			'xrpc handler completed',
		);
		return result;
	} catch (err) {
		if (err instanceof HandlerTimeoutError) {
			logger.warn(
				{ nsid, requestId: opts.requestId, timeoutMs: opts.timeoutMs, durationMs: Date.now() - t0 },
				'xrpc handler timed out',
			);
			throw new XRPCError({
				status: 504,
				error: 'Timeout',
				message: `${nsid} exceeded ${opts.timeoutMs}ms`,
			});
		}
		// Surface the stack for unhandled throws (e.g. Google Books 4xx, drizzle
		// errors, constellation failures). Map well-known upstream errors to
		// typed XRPCErrors so clients see something better than the generic 500.
		logger.error(
			{ nsid, requestId: opts.requestId, durationMs: Date.now() - t0, err },
			'xrpc handler threw',
		);
		if (err instanceof GoogleBooksError) {
			throw new XRPCError({
				status: 502,
				error: 'UpstreamFailure',
				message: `google books returned ${err.status}`,
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

export function createXrpcRouter(
	db: Db,
	ctx: ViewContext,
	opts: RouterOptions = {},
): XRPCRouter {
	const router = new XRPCRouter();
	registerPdsHandlers(router, db, ctx);

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
			let schemaNsid: string;
			try {
				schemaNsid = params.nsid;
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

	// ─── GB-backed handlers ────────────────────────────────────────────────

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchBooks.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.searchBooks';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { hasCursor: !!params.cursor } }, async (signal) => {
				const q = params.q.trim();
				const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
				const cursor = decodeGbCursor(params.cursor);
				const startIndex = cursor?.q === q ? cursor.startIndex : 0;

				const cacheKey = { q, startIndex, limit };
				const cached = await getCached<{ totalItems: number; items: unknown[] }>(db, 'searchBooks', cacheKey, { signal });
				let totalItems: number;
				let items: GbVolume[];
				if (cached) {
					logger.info({ nsid: 'searchBooks', stage: 'cache', hit: true, cachedItems: cached.items.length }, 'cache hit');
					totalItems = cached.totalItems;
					items = cached.items as GbVolume[];
				} else {
					logger.info({ nsid: 'searchBooks', stage: 'cache', hit: false }, 'cache miss; calling google books');
					const res = await gb().searchVolumes(q, { startIndex, maxResults: limit }, signal);
					totalItems = res.totalItems;
					items = res.items ?? [];
					logger.info({ nsid: 'searchBooks', stage: 'google', totalItems, itemsReturned: items.length }, 'google books response');
					await setCached(db, 'searchBooks', cacheKey, { totalItems, items }, TTL.search, { signal });
				}

				const books: BookView[] = [];
				let dropped = 0;
				for (const volume of items) {
					const view = await gbVolumeToBookView(ctx, volume);
					if (view) books.push(view);
					else dropped += 1;
				}
				if (dropped > 0) {
					logger.warn({ nsid: 'searchBooks', stage: 'map', dropped, kept: books.length }, 'volumes dropped during mapping');
				}
				const hasMore = startIndex + books.length < totalItems;
				const next = hasMore ? encodeGbCursor({ q, startIndex: startIndex + books.length }) : undefined;
				return json({ books, hitsTotal: totalItems, cursor: next });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBook.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.getBook';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { uri: params.uri } }, async (signal) => {
				const volumeId = parseVolumeId(params.uri);
				const cached = await getCached<GbVolume>(db, 'getBook', { volumeId }, { signal });
				let volume: GbVolume | undefined;
				if (cached) {
					logger.info({ nsid: 'getBook', stage: 'cache', hit: true, volumeId }, 'cache hit');
					volume = cached;
				} else {
					logger.info({ nsid: 'getBook', stage: 'cache', hit: false, volumeId }, 'cache miss; calling google books');
					volume = await gb().getVolume(volumeId, signal);
					if (volume) {
						logger.info({ nsid: 'getBook', stage: 'google', volumeId, returned: true }, 'google books response');
						await setCached(db, 'getBook', { volumeId }, volume, TTL.getBook, { signal });
					} else {
						logger.info({ nsid: 'getBook', stage: 'google', volumeId, returned: false }, 'google books returned no volume');
					}
				}
				if (!volume) {
					throw new XRPCError({ status: 404, error: 'NotFound', message: 'no such volume' });
				}
				const book = await gbVolumeToBookView(ctx, volume);
				if (!book) {
					throw new XRPCError({ status: 404, error: 'NotFound', message: 'volume missing title' });
				}
				return json({ book });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooks.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.listBooks';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request), params: { hasGenre: !!params.genre, hasContributor: !!params.contributor, hasFormat: !!params.format } }, async (signal) => {
				const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
				const q = buildGbQuery({ q: params.q, genre: params.genre, contributor: params.contributor });
				if (!q) {
					throw new InvalidRequestError({
						status: 400,
						error: 'InvalidRequest',
						message: 'at least one of q, genre, or contributor is required',
					});
				}
				if (params.format) {
					throw new InvalidRequestError({
						status: 400,
						error: 'InvalidRequest',
						message: 'format filter is unsupported for google-books-backed listBooks',
					});
				}
				const cursor = decodeGbCursor(params.cursor);
				const startIndex = cursor?.q === q ? cursor.startIndex : 0;
				const cacheKey = { q, startIndex, limit };
				const cached = await getCached<{ totalItems: number; items: unknown[] }>(db, 'listBooks', cacheKey, { signal });
				let totalItems: number;
				let items: GbVolume[];
				if (cached) {
					logger.info({ nsid: 'listBooks', stage: 'cache', hit: true, cachedItems: cached.items.length }, 'cache hit');
					totalItems = cached.totalItems;
					items = cached.items as GbVolume[];
				} else {
					logger.info({ nsid: 'listBooks', stage: 'cache', hit: false, q }, 'cache miss; calling google books');
					const res = await gb().searchVolumes(q, { startIndex, maxResults: limit }, signal);
					totalItems = res.totalItems;
					items = res.items ?? [];
					logger.info({ nsid: 'listBooks', stage: 'google', totalItems, itemsReturned: items.length }, 'google books response');
					await setCached(db, 'listBooks', cacheKey, { totalItems, items }, TTL.search, { signal });
				}
				const booksOut: BookView[] = [];
				let dropped = 0;
				for (const volume of items) {
					const view = await gbVolumeToBookView(ctx, volume);
					if (view) booksOut.push(view);
					else dropped += 1;
				}
				if (dropped > 0) {
					logger.warn({ nsid: 'listBooks', stage: 'map', dropped, kept: booksOut.length }, 'volumes dropped during mapping');
				}
				const hasMore = startIndex + booksOut.length < totalItems;
				const next = hasMore ? encodeGbCursor({ q, startIndex: startIndex + booksOut.length }) : undefined;
				return json({ books: booksOut, cursor: next });
			});
		},
	});

	// ─── catalog endpoints (local DB) ──────────────────────────────────────

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetContributor.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.getContributor';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
				const rkey = rkeyFromUri(params.uri, COLLECTION.contributor);
				const row = (await db
					.select()
					.from(contributors)
					.where(and(eq(contributors.pk, rkey), releasedFilter(contributors))))[0];
				if (!row) notFound();
				return json({ contributor: await toContributorView(db, ctx, row) });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetGenre.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.getGenre';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
				const rkey = rkeyFromUri(params.uri, COLLECTION.genre);
				const row = (await db
					.select()
					.from(genres)
					.where(and(eq(genres.pk, rkey), releasedFilter(genres))))[0];
				if (!row) notFound();
				return json({ genre: await toGenreView(db, ctx, row) });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListGenres.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.listGenres';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
				const limit = Math.min(100, Math.max(1, params.limit ?? 50));
				const filters = [releasedFilter(genres)];
				if (params.topLevelOnly) filters.push(isNull(genres.parentPk));
				const rows = await db
					.select()
					.from(genres)
					.where(and(...filters))
					.orderBy(genres.name)
					.limit(limit);
				const genreViews: GenreView[] = rows.map((g) => ({
					uri: `at://${ctx.serviceDid}/${COLLECTION.genre}/${g.pk}` as GenreView['uri'],
					name: g.name,
					description: g.description,
					emoji: g.emoji,
					identifiers: [],
				}));
				return json({ genres: genreViews });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchContributors.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.searchContributors';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
				const q = params.q.trim();
				const term = `%${q}%`;
				const limit = Math.min(100, Math.max(1, params.limit ?? 25));
				const rows = await db
					.select()
					.from(contributors)
					.where(
						and(
							releasedFilter(contributors),
							or(like(contributors.name, term), like(contributors.sortName, term)),
						),
					)
					.limit(limit);
				const contributorViews = await Promise.all(rows.map((r) => toContributorView(db, ctx, r)));
				return json({ contributors: contributorViews });
			});
		},
	});

	// ─── per-user PDS endpoints (Jetstream-indexed) ─────────────────────────

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetActor.mainSchema, {
		async handler({ params, request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.getActor';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
				const rec = await getUserRecord(db, params.actor, COLLECTION.actor, 'self');
				return json({ actor: await withActorBsky(toActorView(rec, params.actor)) });
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
				return json({ shelf: await withShelfBsky(toShelfView(rec)) });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
		async handler({ request }) {
			const nsid = 'net.olamaelcu.livtet.biblio.listShelves';
			return withTimedHandler(nsid, { timeoutMs: handlerTimeoutMs, requestId: requestIdOf(request) }, async () => {
				const records = await listByCollection(db, COLLECTION.shelf);
				return json({ shelves: records.map((r) => toShelfView(r)) });
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
				const book = await hydrateBook(db, ctx, value.book.ref);
				if (!book) notFound();
				const shelfParsed = parseRkey(String(value.shelf));
				const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
				if (!shelfRec) notFound();
				const view = toBookShelfView(rec, did, await withShelfBsky(toShelfView(shelfRec)), book);
				return json({ bookShelf: view });
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
					const book = await hydrateBook(db, ctx, value.book.ref);
					if (!book) continue;
					const shelfParsed = parseRkey(String(value.shelf));
					const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
					if (!shelfRec) continue;
					views.push(toBookShelfView(rec, owner, await withShelfBsky(toShelfView(shelfRec)), book));
				}
				logger.info({ nsid: 'listBooksOnShelf', stage: 'list', count: views.length, shelf: params.shelf }, 'list books on shelf');
				return json({ bookShelves: views });
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
					const book = await hydrateBook(db, ctx, value.book.ref);
					if (!book) continue;
					const shelfParsed = parseRkey(String(value.shelf));
					const shelfRec = await getUserRecord(db, shelfParsed.did, COLLECTION.shelf, shelfParsed.rkey);
					if (!shelfRec) continue;
					views.push(toBookShelfView(rec, owner, await withShelfBsky(toShelfView(shelfRec)), book));
				}
				logger.info({ nsid: 'getShelvingOfBook', stage: 'list', count: views.length, book: params.book }, 'shelving of book');
				return json({ bookShelves: views });
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
						const book = await hydrateBook(db, ctx, value.book.ref);
						if (!book) continue;
						booksView.push(toBookShelfView(rec, owner, shelfView, book));
					}
					views.push(toShelfWithBooksView(shelfView, booksView));
				}
				return json({ shelves: views });
			});
		},
	});

	return router;
}