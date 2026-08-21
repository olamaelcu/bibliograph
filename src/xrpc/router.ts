import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { XRPCRouter, json, XRPCError, InvalidRequestError } from '@atcute/xrpc-server';
import { CID, digest } from 'multiformats';
import { loadLexiconSchema, LexiconNotFound } from '../lexicon-resolve.js';
import * as Lexicons from '../lexicons/index.js';
import { registerPdsHandlers } from '../pds/router.js';
import { GoogleBooksClient, type GbVolume } from '../google-books/client.js';
import { decodeGbCursor, encodeGbCursor, gbVolumeToBookView } from '../google-books/mapper.js';
import { getCached, setCached, TTL } from '../google-books/cache.js';
import type { BookView } from '../lexicons/types/net/olamaelcu/livtet/biblio/defs.js';
import type { ViewContext } from '../lex/collections.js';

type Db = NodePgDatabase<typeof schema>;

const VOLUME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseRkey(uri: string): { did: string; collection: string; rkey: string } {
	const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
	if (!m) throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'malformed at-uri' });
	const [, did, collection, rkey] = m;
	return { did, collection, rkey };
}

function notImplemented(nsid: string): never {
	throw new XRPCError({
		status: 501,
		error: 'NotImplementedError',
		message: `${nsid} is not implemented`,
	});
}

/**
 * Pull a `gb-` rkey out of an at-uri. Throws 400 if the rkey doesn't carry
 * the `gb-` prefix or the embedded volume ID is malformed (rkey is
 * `gb-{volumeId}` — see memory #125 on rkey-safety; GB volume IDs only
 * contain `[A-Za-z0-9_-]{1,64}`).
 */
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

export interface RouterOptions {
	client?: GoogleBooksClient;
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

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchBooks.mainSchema, {
		async handler({ params }) {
			const q = params.q.trim();
			const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
			const cursor = decodeGbCursor(params.cursor);
			const startIndex = cursor?.q === q ? cursor.startIndex : 0;

			const cacheKey = { q, startIndex, limit };
			const cached = await getCached<{ totalItems: number; items: unknown[] }>(db, 'searchBooks', cacheKey);
			let totalItems: number;
			let items: GbVolume[];
			if (cached) {
				totalItems = cached.totalItems;
				items = cached.items as GbVolume[];
			} else {
				const res = await gb().searchVolumes(q, { startIndex, maxResults: limit });
				totalItems = res.totalItems;
				items = res.items ?? [];
				await setCached(db, 'searchBooks', cacheKey, { totalItems, items }, TTL.search);
			}

			const books: BookView[] = [];
			for (const volume of items) {
				const view = gbVolumeToBookView(ctx, volume);
				if (view) books.push(view);
			}
			const hasMore = startIndex + books.length < totalItems;
			const next = hasMore ? encodeGbCursor({ q, startIndex: startIndex + books.length }) : undefined;
			return json({ books, hitsTotal: totalItems, cursor: next });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBook.mainSchema, {
		async handler({ params }) {
			const volumeId = parseVolumeId(params.uri);
			const cached = await getCached<GbVolume>(db, 'getBook', { volumeId });
			let volume: GbVolume | undefined;
			if (cached) {
				volume = cached;
			} else {
				volume = await gb().getVolume(volumeId);
				if (volume) await setCached(db, 'getBook', { volumeId }, volume, TTL.getBook);
			}
			if (!volume) {
				throw new XRPCError({ status: 404, error: 'NotFound', message: 'no such volume' });
			}
			const book = gbVolumeToBookView(ctx, volume);
			if (!book) {
				throw new XRPCError({ status: 404, error: 'NotFound', message: 'volume missing title' });
			}
			return json({ book });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooks.mainSchema, {
		async handler({ params }) {
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
			const cached = await getCached<{ totalItems: number; items: unknown[] }>(db, 'listBooks', cacheKey);
			let totalItems: number;
			let items: GbVolume[];
			if (cached) {
				totalItems = cached.totalItems;
				items = cached.items as GbVolume[];
			} else {
				const res = await gb().searchVolumes(q, { startIndex, maxResults: limit });
				totalItems = res.totalItems;
				items = res.items ?? [];
				await setCached(db, 'listBooks', cacheKey, { totalItems, items }, TTL.search);
			}
			const books: BookView[] = [];
			for (const volume of items) {
				const view = gbVolumeToBookView(ctx, volume);
				if (view) books.push(view);
			}
			const hasMore = startIndex + books.length < totalItems;
			const next = hasMore ? encodeGbCursor({ q, startIndex: startIndex + books.length }) : undefined;
			return json({ books, cursor: next });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetActor.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getActor'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBookOnShelf.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getBookOnShelf'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetContributor.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getContributor'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetGenre.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getGenre'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetReview.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getReview'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelf.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getShelf'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelvingOfBook.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getShelvingOfBook'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooksOnShelf.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listBooksOnShelf'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListGenres.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listGenres'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListReviewsByBook.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listReviewsByBook'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listShelves'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelvesWithBooks.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listShelvesWithBooks'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchContributors.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.searchContributors'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchReviews.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.searchReviews'),
	});

	return router;
}
