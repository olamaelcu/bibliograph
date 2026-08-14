import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { XRPCRouter } from '@atcute/xrpc-server';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST, uri } from '../test-utils/db.js';
import { createFakePds, serveFakePds, type FakePds } from '../test-utils/fake-pds.js';
import { makeDidDoc, makeJwt } from '../test-utils/fake-auth.js';
import { getServiceDid } from '../did.js';
import type { ViewContext } from './views.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

const USER_DID = 'did:web:alice.example.com';
const USER_HANDLE = 'alice.example.com';

const COLLECTION = {
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelving: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
};

const BOOK_URI = (pk: string) => encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', pk));
const userUri = (collection: string, rkey: string) => `at://${USER_DID}/${collection}/${rkey}`;
const SHELF_URI = (rkey: string) => encodeURIComponent(userUri(COLLECTION.shelf, rkey));

/** Valid CIDv1 string the fake PDS echoes back (schema-valid for client validation). */
const FIXED_CID = 'bafyreiadsbmmn4waznesyuz3bjgrj33xzqhxrk6mz3ksq7meugrachh3qe';

beforeAll(() => {
	process.env.ATP_SERVICE_DID = SERVICE_DID;
	process.env.ATP_SERVICE_HOST = SERVICE_HOST;
});
afterAll(() => {
	delete process.env.ATP_SERVICE_DID;
	delete process.env.ATP_SERVICE_HOST;
});

function app(db: ReturnType<typeof createTestDb>['db']) {
	const router = createXrpcRouter(db, ctx);
	return {
		fetch: (path: string) => router.fetch(new Request(`https://books.example.com${path}`)),
	};
}

function testDb(): ReturnType<typeof createTestDb>['db'] {
	const { db, seed } = createTestDb();
	seed();
	return db;
}

/** Full proxy harness: local catalog + fake user PDS with an authenticated session. */
function makeUserHarness() {
	let fake: FakePds;
	let close: () => void;
	let token: string;
	let db: ReturnType<typeof createTestDb>['db'];
	let router: XRPCRouter;

	beforeEach(async () => {
		const t = createTestDb();
		t.seed();
		db = t.db;
		router = createXrpcRouter(db, ctx);

		fake = createFakePds({ repo: USER_DID });
		const server = await serveFakePds(fake);
		close = server.close;

		const realFetch = globalThis.fetch;
		const doc = makeDidDoc({
			serviceEndpoint: server.baseUrl,
			alsoKnownAs: [`at://${USER_HANDLE}`],
		});
		vi.stubGlobal(
			'fetch',
			((input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.toString()
							: (input as Request).url;
				if (url.includes('/.well-known/did.json')) {
					return Promise.resolve(
						new Response(JSON.stringify(doc), {
							status: 200,
							headers: { 'content-type': 'application/json' },
						}),
					);
				}
				return realFetch(input, init);
			}) as typeof fetch,
		);

		token = makeJwt({ sub: USER_DID, aud: getServiceDid() });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		close();
	});

	const fetchUser = (path: string) =>
		router.fetch(
			new Request(`https://books.example.com${path}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

	const seed = (collection: string, rkey: string, value: Record<string, unknown>) => {
		fake.records.set(`${collection}/${rkey}`, {
			value: { $type: collection, ...value },
			cid: FIXED_CID,
		});
	};

	return {
		get db() {
			return db;
		},
		fetchUser,
		seed,
	};
}

describe('catalog release gating', () => {
	it('404s a staged book from getBook', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`);
		expect(res.status).toBe(404);
	});

	it('omits a released book whose work is staged', async () => {
		const db = testDb();
		db.run(sql`UPDATE works SET release_status = 'staged' WHERE pk = 'work-dune'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.work).toBeUndefined();
		expect(body.book.title).toBe('Dune (40th Anniversary)');
	});

	it('omits staged contributors and genres from a book view', async () => {
		const db = testDb();
		db.run(sql`UPDATE contributors SET release_status = 'staged' WHERE pk = 'author-herbert'`);
		db.run(sql`UPDATE genres SET release_status = 'staged' WHERE pk = 'scifi'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.contributors.some((c: { contributor: { name: string } }) => c.contributor.name === 'Frank Herbert')).toBe(false);
		expect(body.book.genres.map((g: { name: string }) => g.name)).toEqual(['Fiction']);
	});

	it('counts only released books in search hitsTotal', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=${encodeURIComponent('a')}`);
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('excludes staged works from searchWorks', async () => {
		const db = testDb();
		db.run(sql`UPDATE works SET release_status = 'staged' WHERE pk = 'work-dune'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=${encodeURIComponent('Dune')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.works).toHaveLength(0);
		expect(body.hitsTotal).toBe(0);
	});
});

describe('auth gating', () => {
	it('requires a token for review endpoints', async () => {
		const res = await app(testDb()).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'rev-1'))}`,
		);
		expect(res.status).toBe(401);
	});

	it('requires a token for shelf endpoints', async () => {
		const res = await app(testDb()).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${SHELF_URI('shelf-1')}`,
		);
		expect(res.status).toBe(401);
	});

	it('requires a token for bookShelving endpoints', async () => {
		const res = await app(testDb()).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${encodeURIComponent(userUri(COLLECTION.bookShelving, 'shelving-1'))}`,
		);
		expect(res.status).toBe(401);
	});

	it('requires a token for list endpoints over user records', async () => {
		const db = testDb();
		const paths = [
			`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${BOOK_URI('book-dune')}`,
			'/xrpc/net.olamaelcu.livtet.biblio.listShelves',
			'/xrpc/net.olamaelcu.livtet.biblio.listShelvesWithBooks',
			`/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=${SHELF_URI('shelf-1')}`,
			`/xrpc/net.olamaelcu.livtet.biblio.getShelvingOfBook?book=${BOOK_URI('book-dune')}`,
			'/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('worldbuilding'),
		];
		for (const path of paths) {
			const res = await app(db).fetch(path);
			expect(res.status).toBe(401);
		}
	});

	it('requires a token for getActor', async () => {
		const res = await app(testDb()).fetch(
			'/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=' + encodeURIComponent(USER_DID),
		);
		expect(res.status).toBe(401);
	});

	it('serves catalog endpoints anonymously', async () => {
		const db = testDb();
		const paths = [
			`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`,
			'/xrpc/net.olamaelcu.livtet.biblio.listBooks',
			'/xrpc/net.olamaelcu.livtet.biblio.listGenres',
			'/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=' + encodeURIComponent('Dune'),
			'/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('Dune'),
			'/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=' + encodeURIComponent('Frank'),
		];
		for (const path of paths) {
			const res = await app(db).fetch(path);
			expect(res.status).toBe(200);
		}
	});
});

describe('user-record release gating', () => {
	const h = makeUserHarness();

	it('404s a review of a staged book from getReview', async () => {
		h.seed(COLLECTION.review, 'rev-1', {
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			rating: 5,
			status: 'read',
		});
		h.db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'rev-1'))}`,
		);
		expect(res.status).toBe(404);
	});

	it('skips reviews of staged books from searchReviews', async () => {
		h.seed(COLLECTION.review, 'rev-1', {
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			rating: 5,
			status: 'read',
			text: 'worldbuilding',
		});
		h.db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('worldbuilding'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reviews).toHaveLength(0);
		expect(body.hitsTotal).toBe(0);
	});

	it('404s a bookShelving of a staged book from getBookOnShelf', async () => {
		h.seed(COLLECTION.shelf, 'shelf-favorites', { name: 'Favorites' });
		h.seed(COLLECTION.bookShelving, 'shelving-1', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			metadata: { status: 'reading' },
		});
		h.db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${encodeURIComponent(userUri(COLLECTION.bookShelving, 'shelving-1'))}`,
		);
		expect(res.status).toBe(404);
	});

	it('omits staged books from listBooksOnShelf', async () => {
		h.seed(COLLECTION.shelf, 'shelf-favorites', { name: 'Favorites' });
		h.seed(COLLECTION.bookShelving, 'shelving-1', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			metadata: { status: 'reading' },
		});
		h.seed(COLLECTION.bookShelving, 'shelving-2', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-flowers'), title: 'Flowers for Algernon' },
			metadata: { status: 'to-read' },
		});
		h.db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=${SHELF_URI('shelf-favorites')}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves).toHaveLength(1);
		expect(body.bookShelves[0].book.title).toBe('Dune (40th Anniversary)');
	});

	it('omits staged books from listShelvesWithBooks', async () => {
		h.seed(COLLECTION.shelf, 'shelf-favorites', { name: 'Favorites' });
		h.seed(COLLECTION.bookShelving, 'shelving-1', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			metadata: { status: 'reading' },
		});
		h.seed(COLLECTION.bookShelving, 'shelving-2', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-flowers'), title: 'Flowers for Algernon' },
			metadata: { status: 'to-read' },
		});
		h.db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.listShelvesWithBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves).toHaveLength(1);
		expect(body.shelves[0].books).toHaveLength(1);
		expect(body.shelves[0].books[0].book.title).toBe('Dune (40th Anniversary)');
	});
});
