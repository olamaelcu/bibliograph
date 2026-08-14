import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { XRPCRouter, json, InvalidRequestError, XRPCError } from '@atcute/xrpc-server';
import type { ResourceUri } from '@atcute/lexicons';
import * as Lexicons from '../lexicons/index.js';
import { createPdsClient, type PdsClient } from '../pds/client.js';
import type { PdsSession } from '../pds/auth.js';
import { authenticate } from '../pds/auth.js';
import {
	COLLECTION,
	bookRkeyFromRef,
	rkeyFromAtUri,
	toExpandedBook,
	type ViewContext,
} from './views.js';
import { books } from '../db/schema.js';
import { releasedFilter } from './gate.js';

type Db = BetterSQLite3Database;

function errorInvalidRequest(message: string): never {
	throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message });
}

function errorNotFound(message: string): never {
	throw new XRPCError({ status: 400, error: 'NotFound', message });
}

/** Parse `at://<did>/<collection>/<rkey>` for a user record. */
function parseRecordUri(uri: string): { did: string; collection: string; rkey: string } {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
	if (!match || !match[1].startsWith('did:')) {
		errorInvalidRequest('invalid record uri');
	}
	return { did: match![1], collection: match![2], rkey: match![3] };
}

/** rkey (pk) of a released catalog book referenced by at-uri, or 400. */
function requireCatalogBook(db: Db, bookUri: string): { pk: string; title: string; coverUrl: string | null; workPk: string | null } {
	const pk = bookRkeyFromRef(bookUri);
	if (!pk) errorInvalidRequest('book uri must reference the catalog');
	const row = db.select().from(books).where(and(eq(books.pk, pk), releasedFilter(books))).get();
	if (!row) errorNotFound(`book not found in catalog: ${bookUri}`);
	return row!;
}

function clientForSession(session: PdsSession): PdsClient {
	return createPdsClient({ pdsUrl: session.pdsUrl, token: session.token, repo: session.did });
}

/** Shape a put/delete ref into the `{uri, cid}` procedure output. */
function writeResult(ref: { uri: string; cid: string }): { uri: ResourceUri; cid: string } {
	return { uri: ref.uri as ResourceUri, cid: ref.cid };
}

/**
 * Register the biblio write procedures (`put*` / `delete*`). Each authenticates
 * the caller, builds the full record value (hydrating book metadata from the
 * local catalog), and proxies the write to the caller's own PDS via
 * `com.atproto.repo.*`. Record keys are derived server-side so a user holds
 * exactly one record per natural key.
 */
export function registerBiblioWrites(router: XRPCRouter, db: Db, ctx: ViewContext): void {
	// ─── putReview ─────────────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioPutReview.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const book = requireCatalogBook(db, input.book);
			const now = new Date().toISOString();
			const value: Lexicons.NetOlamaelcuLivtetBiblioReview.Main = {
				$type: COLLECTION.review,
				book: await toExpandedBook(db, ctx, book),
				rating: input.rating,
				status: input.status,
				createdAt: now,
			};
			if (input.tags?.length) value.tags = input.tags;
			if (input.text) value.text = input.text;
			if (input.progress) value.progress = input.progress;

			const client = clientForSession(session);
			const ref = await client.putRecord(COLLECTION.review, book.pk, value);
			return json(writeResult(ref));
		},
	});

	// ─── deleteReview ──────────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioDeleteReview.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const book = requireCatalogBook(db, input.book);
			const client = clientForSession(session);
			await client.deleteRecord(COLLECTION.review, book.pk);
			return json({});
		},
	});

	// ─── putShelf ──────────────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioPutShelf.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const rkey = input.rkey ?? slugify(input.name);
			const now = new Date().toISOString();
			const value: Lexicons.NetOlamaelcuLivtetBiblioShelf.Main = {
				$type: COLLECTION.shelf,
				name: input.name,
				createdAt: now,
			};
			if (input.description) value.description = input.description;

			const client = clientForSession(session);
			const ref = await client.putRecord(COLLECTION.shelf, rkey, value);
			return json(writeResult(ref));
		},
	});

	// ─── deleteShelf ───────────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioDeleteShelf.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const parsed = parseRecordUri(input.shelf);
			if (parsed.collection !== COLLECTION.shelf) {
				errorInvalidRequest('shelf uri must reference a shelf record');
			}
			if (parsed.did !== session.did) {
				errorInvalidRequest('shelf must belong to the authenticated account');
			}
			const client = clientForSession(session);
			await client.deleteRecord(COLLECTION.shelf, parsed.rkey);
			return json({});
		},
	});

	// ─── putBookShelving ───────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioPutBookShelving.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const book = requireCatalogBook(db, input.book);
			const shelf = parseRecordUri(input.shelf);
			if (shelf.collection !== COLLECTION.shelf) {
				errorInvalidRequest('shelf uri must reference a shelf record');
			}
			if (shelf.did !== session.did) {
				errorInvalidRequest('shelf must belong to the authenticated account');
			}

			const client = clientForSession(session);
			// The shelf record must exist in the caller's repo.
			try {
				await client.getRecord(COLLECTION.shelf, shelf.rkey);
			} catch {
				errorNotFound(`shelf not found: ${input.shelf}`);
			}

			const now = new Date().toISOString();
			const value: Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main = {
				$type: COLLECTION.bookShelf,
				shelf: input.shelf as unknown as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main['shelf'],
				book: await toExpandedBook(db, ctx, book),
				metadata: input.metadata,
				createdAt: now,
			};

			const rkey = `${book.pk}--${shelf.rkey}`;
			const ref = await client.putRecord(COLLECTION.bookShelf, rkey, value);
			return json(writeResult(ref));
		},
	});

	// ─── deleteBookShelving ────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioDeleteBookShelving.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const book = requireCatalogBook(db, input.book);
			const shelf = parseRecordUri(input.shelf);
			if (shelf.collection !== COLLECTION.shelf) {
				errorInvalidRequest('shelf uri must reference a shelf record');
			}
			if (shelf.did !== session.did) {
				errorInvalidRequest('shelf must belong to the authenticated account');
			}
			const client = clientForSession(session);
			await client.deleteRecord(COLLECTION.bookShelf, `${book.pk}--${shelf.rkey}`);
			return json({});
		},
	});

	// ─── putActor ──────────────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioPutActor.mainSchema, {
		async handler({ request, input }) {
			const session = await authenticate(request);
			const now = new Date().toISOString();
			const value: Lexicons.NetOlamaelcuLivtetBiblioActor.Main = {
				$type: COLLECTION.actor,
				createdAt: now,
			};
			if (input.displayName) value.displayName = input.displayName;
			if (input.description) value.description = input.description;

			const client = clientForSession(session);
			const ref = await client.putRecord(COLLECTION.actor, 'self', value);
			return json(writeResult(ref));
		},
	});

	// ─── deleteActor ───────────────────────────────────────────────────────
	router.addProcedure(Lexicons.NetOlamaelcuLivtetBiblioDeleteActor.mainSchema, {
		async handler({ request }) {
			const session = await authenticate(request);
			const client = clientForSession(session);
			await client.deleteRecord(COLLECTION.actor, 'self');
			return json({});
		},
	});
}

/**
 * Record-key-safe slug from a shelf name: lowercase, non-alphanumeric runs to
 * a single `-`. Falls back to a timestamp when the name slugs to nothing.
 */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\w]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (slug) return slug;
	return `shelf-${Date.now().toString(36)}`;
}
