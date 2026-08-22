import { and, eq, ilike, like, or, type SQL } from 'drizzle-orm';
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
	hydrateEdition,
	toActorView,
	toBookShelfView,
	toContributorView,
	toShelfView,
	toShelfWithBooksView,
	withActorBsky,
	withShelfBsky,
} from './hydrate.js';
import { listByCollection, getUserRecord } from '../jetstream/query.js';
import {
	bookIdentifiers,
	contributors,
	contributorIdentifiers,
	editions,
} from '../db/schema.js';
import { COLLECTION, type PdsRecord, type ViewContext } from '../lex/collections.js';
import type {
	BookShelfView,
	EditionView,
	ContributorView,
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

function notSupported(nsid: string): never {
	throw new XRPCError({ status: 501, error: 'NotSupported', message: `${nsid} is not implemented by this AppView` });
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

/** Static list of NSIDs this AppView advertises in its `compatibility` response. */
function compatibilityQueries(): { nsid: string; type?: string }[] {
	return [
		// Required community queries:
		{ nsid: 'community.lexicon.book.searchEditions', type: 'query' },
		{ nsid: 'community.lexicon.book.getEdition', type: 'query' },
		{ nsid: 'community.lexicon.book.getContributor', type: 'query' },
		{ nsid: 'community.lexicon.book.searchContributors', type: 'query' },
		{ nsid: 'community.lexicon.book.searchWorks', type: 'query' },
		{ nsid: 'community.lexicon.book.searchPublishers', type: 'query' },
		{ nsid: 'community.lexicon.book.compatibility', type: 'query' },
		// App-private image lookups:
		{ nsid: 'net.olamaelcu.livtet.biblio.getImageForBook', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.getImageForContributor', type: 'query' },
		// App-private shelf / actor endpoints:
		{ nsid: 'net.olamaelcu.livtet.biblio.getActor', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.getShelf', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.listShelves', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.getBookOnShelf', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.listBooksOnShelf', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.getShelvingOfBook', type: 'query' },
		{ nsid: 'net.olamaelcu.livtet.biblio.listShelvesWithBooks', type: 'query' },
	];
}

/**
 * Materialize a `community.lexicon.book.edition` AppView from an `editions`
 * DB row. Reads identifiers and contributors (via the JSON column) and joins
 * contributor rows for display. Single DB query for identifiers; per-contributor
 * fetches are batched.
 */
async function toEditionViewFromRow(db: Db, ctx: ViewContext, row: typeof editions.$inferSelect): Promise<EditionView> {
	const identifiersRows = await db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, row.pk));
	const subjects = (row.contributors ?? []) as { subject: string; role: string }[];
	const contributorRkeys = subjects
		.map((s) => s.subject.split('/').pop())
		.filter((s): s is string => !!s);
	const contributorRows = contributorRkeys.length
		? await db.select().from(contributors).where(or(...contributorRkeys.map((k) => eq(contributors.pk, k))) as SQL)
		: [];
	const contributorRowsByPk = new Map(contributorRows.map((c) => [c.pk, c]));
	const contributorViews: ContributorView[] = subjects
		.map((s) => {
			const rkey = s.subject.split('/').pop()!;
			const c = contributorRowsByPk.get(rkey);
			if (!c) return null;
			return {
				uri: s.subject as ContributorView['uri'],
				name: c.name,
				role: s.role,
			};
		})
		.filter((v): v is ContributorView => v !== null);
	const view: EditionView = {
		uri: `at://${ctx.serviceDid}/${COLLECTION.edition}/${row.pk}`,
		title: row.title,
		identifiers: identifiersRows.map((i) => ({
			uri: i.uri as `${string}:${string}`,
			resource: i.valueScheme,
		})),
		contributors: contributorViews,
	};
	if (row.subtitle) view.subtitle = row.subtitle;
	if (row.publishedYear != null) view.publishedYear = row.publishedYear;
	if (row.language) view.language = row.language;
	if (row.place) view.place = row.place;
	if (row.description) view.description = row.description;
	view.createdAt = new Date(row.createdAt * 1000).toISOString();
	if (row.updatedAt != null) view.updatedAt = new Date(row.updatedAt * 1000).toISOString();
	return view;
}

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
				return json({ items: items_out, total: totalItems, cursor: next });
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
					return json({ edition: gbVolumeToEditionRecord(ctx, volume) });
				}
				const row = (await db.select().from(editions).where(eq(editions.pk, rkey)))[0];
				if (!row) notFound();
				return json({ edition: gbVolumeToEditionRecord(ctx, { id: row.pk, volumeInfo: rowToVolumeInfo(row) } as GbVolume) });
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
				return json({ contributor: await toContributorView(db, ctx, row) });
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
				return json({ items, total: hasMore ? undefined : items.length, cursor: undefined });
			});
		},
	});

	router.addQuery(Lexicons.CommunityLexiconBookSearchWorks.mainSchema, {
		async handler() {
			notSupported('community.lexicon.book.searchWorks');
		},
	});

	router.addQuery(Lexicons.CommunityLexiconBookSearchPublishers.mainSchema, {
		async handler() {
			notSupported('community.lexicon.book.searchPublishers');
		},
	});

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

				if (!volumeId) return json({ url: undefined });

				const cached = await getCached<GbVolume>(db, 'getVolume', { volumeId }, { signal, requestId });
				const volume = cached ?? (await gb().getVolume(volumeId, { signal, requestId }));
				if (volume) await setCached(db, 'getVolume', { volumeId }, volume, TTL.getBook, { signal, requestId });
				const url = volume?.volumeInfo?.imageLinks?.thumbnail ?? volume?.volumeInfo?.imageLinks?.smallThumbnail;
				return json({ url });
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetImageForContributor.mainSchema, {
		async handler() {
			// TODO: implement OL cover lookup via openlibrary.org/authors/<id>.json
			return json({ url: undefined });
		},
	});

	// ─── per-user PDS endpoints (Jetstream-indexed, app-private) ─────────

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
				const book = await hydrateEdition(db, ctx, value.book.ref);
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
					const book = await hydrateEdition(db, ctx, value.book.ref);
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
					const book = await hydrateEdition(db, ctx, value.book.ref);
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
						const book = await hydrateEdition(db, ctx, value.book.ref);
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

// ─── Helpers used by router.ts ──────────────────────────────────────────────

/** Map an `editions` DB row into a fake GB volume so `gbVolumeToEditionRecord` can render it. */
function rowToVolumeInfo(row: typeof editions.$inferSelect): { title: string; subtitle?: string; publishedDate?: string; description?: string; language?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string }; authors?: string[] } {
	const vi: { title: string; subtitle?: string; publishedDate?: string; description?: string; language?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string }; authors?: string[] } = {
		title: row.title,
	};
	if (row.subtitle) vi.subtitle = row.subtitle;
	if (row.publishedYear != null) vi.publishedDate = String(row.publishedYear);
	if (row.description) vi.description = row.description;
	if (row.language) vi.language = row.language;
	return vi;
}

/**
 * Map a Google Books volume to a `community.lexicon.book.edition` record shape
 * (the shape that gets persisted in the PDS and returned by AppView queries).
 */
export function gbVolumeToEditionRecord(
ctx: ViewContext,
volume: GbVolume,
): Record<string, unknown> {
	const info = volume.volumeInfo;
	const rkey = `gb-${volume.id}`;
	const record: Record<string, unknown> = {
		$type: 'community.lexicon.book.edition',
		title: info.title,
		createdAt: new Date().toISOString(),
	};
	if (info.subtitle) record.subtitle = info.subtitle;
	if (info.publishedDate) {
		const year = parseYear(info.publishedDate);
		if (year != null) record.publishedYear = year;
	}
	if (info.language) record.language = info.language;
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