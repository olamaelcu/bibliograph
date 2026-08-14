import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XRPCRouter } from '@atcute/xrpc-server';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST, uri } from '../test-utils/db.js';
import { createFakePds, serveFakePds, type FakePds } from '../test-utils/fake-pds.js';
import { makeDidDoc, makeJwt } from '../test-utils/fake-auth.js';
import { getServiceDid } from '../did.js';
import { books } from '../db/schema.js';
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

const userUri = (collection: string, rkey: string) => `at://${USER_DID}/${collection}/${rkey}`;
const BOOK_URI = (pk: string) => uri('net.olamaelcu.livtet.biblio.book', pk);
const SHELF_URI = (rkey: string) => userUri(COLLECTION.shelf, rkey);
const FORMAT_URI = (pk: string) => uri('net.olamaelcu.livtet.biblio.format', pk);

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

/** Bare anonymous app backed only by the local catalog DB (no user PDS). */
function app() {
	const { db, seed } = createTestDb();
	seed();
	const router = createXrpcRouter(db, ctx);
	return {
		db,
		fetch: (path: string) => router.fetch(new Request(`https://books.example.com${path}`)),
	};
}

function releasedBooks() {
	const a = app();
	const now = Math.floor(Date.now() / 1000);
	for (let i = 0; i < 5; i++) {
		a.db
			.insert(books)
			.values({
				pk: `book-page-${i}`,
				title: `Paged Book ${String(i).padStart(2, '0')}`,
				createdAt: now + i,
				releaseStatus: 'released',
			})
			.run();
	}
	return a;
}

/**
 * Full proxy harness: local catalog DB + an in-memory fake user PDS served over
 * HTTP. Global fetch is stubbed so DID document lookups (`*.well-known/did.json`)
 * resolve to the fake's endpoint while every other request still hits the real
 * network (so the PDS client can talk to the fake server).
 *
 * MUST be instantiated at `describe` scope (it registers beforeEach/afterEach).
 */
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

	const fetchUser = (path: string, headers: Record<string, string> = {}) =>
		router.fetch(
			new Request(`https://books.example.com${path}`, {
				headers: { authorization: `Bearer ${token}`, ...headers },
			}),
		);

	const seed = (collection: string, rkey: string, value: Record<string, unknown>) => {
		fake.records.set(`${collection}/${rkey}`, {
			value: { $type: collection, ...value },
			cid: FIXED_CID,
		});
	};

	const seedReview = (rkey: string, overrides: Record<string, unknown> = {}) =>
		seed(COLLECTION.review, rkey, {
			book: { ref: BOOK_URI('book-dune'), title: 'Dune (40th Anniversary)' },
			tags: [],
			rating: 5,
			status: 'read',
			text: 'A masterpiece of worldbuilding',
			createdAt: '2024-01-01T00:00:00.000Z',
			...overrides,
		});

	const seedShelf = (rkey: string, overrides: Record<string, unknown> = {}) =>
		seed(COLLECTION.shelf, rkey, {
			name: 'Favorites',
			description: 'Books I loved',
			createdAt: '2024-01-01T00:00:00.000Z',
			...overrides,
		});

	const seedShelving = (rkey: string, overrides: Record<string, unknown> = {}) =>
		seed(COLLECTION.bookShelving, rkey, {
			shelf: SHELF_URI('shelf-favorites'),
			book: { ref: BOOK_URI('book-dune'), title: 'Dune (40th Anniversary)' },
			metadata: { status: 'reading', position: 1 },
			createdAt: '2024-01-01T00:00:00.000Z',
			...overrides,
		});

	return {
		get db() {
			return db;
		},
		get fake() {
			return fake;
		},
		fetchUser,
		seed,
		seedReview,
		seedShelf,
		seedShelving,
	};
}

describe('getBook', () => {
	it('hydrates a book view with work, format, genres, contributors', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(BOOK_URI('book-dune'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.title).toBe('Dune (40th Anniversary)');
		expect(body.book.work.title).toBe('Dune');
		expect(body.book.format.unit).toBe('pages');
		expect(body.book.genres.map((g: { name: string }) => g.name)).toEqual(['Fiction', 'Science Fiction']);
		expect(body.book.contributors[0].contributor.name).toBe('Frank Herbert');
		expect(body.book.contributors[0].role).toBe(uri('net.olamaelcu.livtet.biblio.contributorRole', 'author'));
		expect(body.book.identifiers[0].resource).toBe('isbn:0441172717');
	});

	it('returns NotFound for a missing book', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(BOOK_URI('nope'))}`);
		expect(res.status).toBe(404);
	});

	it('rejects a uri from a different service', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=' + encodeURIComponent('at://did:web:other.example.com/net.olamaelcu.livtet.biblio.book/x'));
		expect(res.status).toBe(400);
	});
});

describe('getWork', () => {
	it('returns a work view', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'work-dune'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.work.title).toBe('Dune');
		expect(body.work.identifiers[0].resource).toBe('openlibrary:works/OL893423W');
	});

	it('returns NotFound', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('getContributor', () => {
	it('returns a contributor view', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'author-herbert'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.contributor.name).toBe('Frank Herbert');
		expect(body.contributor.sortName).toBe('Herbert, Frank');
		expect(body.contributor.identifiers[0].resource).toBe('viaf:59083797');
	});

	it('returns NotFound', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('getGenre', () => {
	it('returns a genre view with parent', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'scifi'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.genre.name).toBe('Science Fiction');
		expect(body.genre.parent).toBe(uri('net.olamaelcu.livtet.biblio.genre', 'fiction'));
	});

	it('returns NotFound', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('listBooks', () => {
	it('returns all books with a cursor only when a next page exists', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.books.map((b: { title: string }) => b.title).sort()).toEqual([
			'Dune (40th Anniversary)',
			'Flowers for Algernon',
		]);
		expect(body.cursor).toBeUndefined();
	});

	it('filters by genre', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooks?genre=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'scifi'))}`);
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('filters by work', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooks?work=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'work-dune'))}`);
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('ignores the status param (no longer a review filter)', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?status=read');
		const body = await res.json();
		expect(body.books.map((b: { title: string }) => b.title).sort()).toEqual([
			'Dune (40th Anniversary)',
			'Flowers for Algernon',
		]);
	});

	it('paginates with a limit of 1 and returns a cursor', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?limit=1');
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.cursor).toBeDefined();
	});

	it('follows the cursor to the next page without overlap', async () => {
		const { fetch } = releasedBooks();
		const first = await (await fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?limit=2')).json();
		expect(first.books).toHaveLength(2);
		expect(first.cursor).toBeDefined();
		const firstTitles = first.books.map((b: { title: string }) => b.title);

		const second = await (
			await fetch(
				'/xrpc/net.olamaelcu.livtet.biblio.listBooks?limit=2&cursor=' + encodeURIComponent(first.cursor),
			)
		).json();
		expect(second.books).toHaveLength(2);
		const secondTitles = second.books.map((b: { title: string }) => b.title);
		expect(secondTitles).not.toEqual(firstTitles);
		expect(firstTitles.filter((t: string) => secondTitles.includes(t))).toHaveLength(0);
	});

	it('follows a searchBooks cursor to the next page without overlap', async () => {
		const { fetch } = releasedBooks();
		const q = encodeURIComponent('Paged');
		const first = await (await fetch(`/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=${q}&limit=2`)).json();
		expect(first.books).toHaveLength(2);
		expect(first.cursor).toBeDefined();
		const firstTitles = first.books.map((b: { title: string }) => b.title);

		const second = await (
			await fetch(
				`/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=${q}&limit=2&cursor=` + encodeURIComponent(first.cursor),
			)
		).json();
		expect(second.books).toHaveLength(2);
		const secondTitles = second.books.map((b: { title: string }) => b.title);
		expect(secondTitles).not.toEqual(firstTitles);
		expect(firstTitles.filter((t: string) => secondTitles.includes(t))).toHaveLength(0);
	});

	it('rejects a malformed cursor with 400', async () => {
		const res = await app().fetch(
			'/xrpc/net.olamaelcu.livtet.biblio.listBooks?cursor=' + encodeURIComponent('not-a-cursor'),
		);
		expect(res.status).toBe(400);
	});
});

describe('listGenres', () => {
	it('returns all genres', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listGenres');
		const body = await res.json();
		expect(body.genres.map((g: { name: string }) => g.name).sort()).toEqual(['Fiction', 'Science Fiction']);
	});

	it('filters to top-level genres', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listGenres?topLevelOnly=true');
		const body = await res.json();
		expect(body.genres.map((g: { name: string }) => g.name)).toEqual(['Fiction']);
	});
});

describe('searchBooks', () => {
	it('finds books by title', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=' + encodeURIComponent('Dune'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('finds books by identifier', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=' + encodeURIComponent('isbn:0441172717'));
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});
});

describe('searchContributors', () => {
	it('finds contributors by name', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=' + encodeURIComponent('Frank'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.contributors[0].name).toBe('Frank Herbert');
	});

	it('finds contributors by sort name', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=' + encodeURIComponent('Herbert'));
		const body = await res.json();
		expect(body.contributors).toHaveLength(1);
	});
});

describe('searchWorks', () => {
	it('finds works by title', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('Dune'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.works[0].title).toBe('Dune');
	});

	it('finds works by identifier', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('openlibrary:works/OL893423W'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.works[0].identifiers[0].resource).toBe('openlibrary:works/OL893423W');
	});

	it('returns empty results for no match', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('nonexistent'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(0);
		expect(body.works).toHaveLength(0);
	});
});

describe('getReview', () => {
	const h = makeUserHarness();

	it('returns a review view hydrated from the user PDS and local catalog', async () => {
		h.seedReview('rev-1', {
			tags: ['favorite', 'worldbuilding'],
			progress: { format: FORMAT_URI('paperback'), progress: 412, unit: 'pages' },
			text: 'A masterpiece of worldbuilding',
		});
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'rev-1'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.review.uri).toBe(userUri(COLLECTION.review, 'rev-1'));
		expect(body.review.rating).toBe(5);
		expect(body.review.status).toBe('read');
		expect(body.review.tags).toEqual(['favorite', 'worldbuilding']);
		expect(body.review.book.title).toBe('Dune (40th Anniversary)');
		expect(body.review.did).toBe(USER_DID);
		expect(body.review.progress.progress).toBe(412);
		expect(body.review.progress.format.unit).toBe('pages');
		expect(body.review.text).toBe('A masterpiece of worldbuilding');
		expect(body.review.createdAt).toBe('2024-01-01T00:00:00.000Z');
	});

	it('returns NotFound for a missing record', async () => {
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'nope'))}`,
		);
		expect(res.status).toBe(404);
	});

	it('returns NotFound when the uri DID is not the authenticated user', async () => {
		h.seedReview('rev-1');
		const res = await h.fetchUser(
			'/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=' +
				encodeURIComponent('at://did:web:someone-else.example.com/net.olamaelcu.livtet.biblio.review/rev-1'),
		);
		expect(res.status).toBe(404);
	});
});

describe('getShelf', () => {
	const h = makeUserHarness();

	it('returns a shelf view from the user PDS', async () => {
		h.seedShelf('shelf-favorites', { name: 'Favorites', description: 'Books I loved' });
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${encodeURIComponent(SHELF_URI('shelf-favorites'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelf.uri).toBe(SHELF_URI('shelf-favorites'));
		expect(body.shelf.name).toBe('Favorites');
		expect(body.shelf.description).toBe('Books I loved');
	});

	it('returns NotFound for a missing shelf', async () => {
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${encodeURIComponent(SHELF_URI('nope'))}`,
		);
		expect(res.status).toBe(404);
	});
});

describe('getBookOnShelf', () => {
	const h = makeUserHarness();

	it('returns a bookShelving view with hydrated shelf and book', async () => {
		h.seedShelf('shelf-favorites');
		h.seedShelving('shelving-1', {
			metadata: { status: 'reading', position: 1, notes: 'Rereading this winter', emoji: '🐛' },
		});
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${encodeURIComponent(userUri(COLLECTION.bookShelving, 'shelving-1'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelf.shelf.name).toBe('Favorites');
		expect(body.bookShelf.book.title).toBe('Dune (40th Anniversary)');
		expect(body.bookShelf.metadata.status).toBe('reading');
		expect(body.bookShelf.metadata.position).toBe(1);
		expect(body.bookShelf.metadata.emoji).toBe('🐛');
		expect(body.bookShelf.did).toBe(USER_DID);
	});

	it('returns NotFound for a missing bookShelving record', async () => {
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${encodeURIComponent(userUri(COLLECTION.bookShelving, 'nope'))}`,
		);
		expect(res.status).toBe(404);
	});
});

describe('getActor', () => {
	const h = makeUserHarness();

	it('returns the authenticated user profile with a self record', async () => {
		h.seed(COLLECTION.actor, 'self', { displayName: 'Alice', description: 'Reader of worlds' });
		const res = await h.fetchUser(`/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=${encodeURIComponent(USER_DID)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.actor.did).toBe(USER_DID);
		expect(body.actor.handle).toBe(USER_HANDLE);
		expect(body.actor.displayName).toBe('Alice');
		expect(body.actor.description).toBe('Reader of worlds');
	});

	it('returns did and handle when no self record exists', async () => {
		const res = await h.fetchUser(`/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=${encodeURIComponent(USER_DID)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.actor.did).toBe(USER_DID);
		expect(body.actor.handle).toBe(USER_HANDLE);
		expect(body.actor.displayName).toBeUndefined();
		expect(body.actor.description).toBeUndefined();
	});

	it('returns NotFound for another actor', async () => {
		const res = await h.fetchUser(
			'/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=' + encodeURIComponent('did:web:someone-else.example.com'),
		);
		expect(res.status).toBe(404);
	});
});

describe('listReviewsByBook', () => {
	const h = makeUserHarness();

	it('lists only the reviews for the requested book', async () => {
		h.seedReview('rev-1', { text: 'Dune is great' });
		h.seedReview('rev-2', { rating: 4, status: 'reading', text: 'Also dune', tags: ['sand'] });
		h.seedReview('rev-flowers', { book: { ref: BOOK_URI('book-flowers'), title: 'Flowers for Algernon' } });
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(BOOK_URI('book-dune'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reviews).toHaveLength(2);
		for (const review of body.reviews) {
			expect(review.book.title).toBe('Dune (40th Anniversary)');
		}
	});

	it('paginates over the filtered reviews', async () => {
		h.seedReview('r1', { text: 'one' });
		h.seedReview('r2', { text: 'two' });
		h.seedReview('r3', { text: 'three' });
		h.seedReview('r4', { book: { ref: BOOK_URI('book-flowers'), title: 'Flowers for Algernon' }, text: 'other' });
		const first = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(BOOK_URI('book-dune'))}&limit=2`,
		);
		expect(first.status).toBe(200);
		const firstBody = await first.json();
		expect(firstBody.reviews).toHaveLength(2);
		expect(firstBody.cursor).toBeDefined();
		const firstUris = firstBody.reviews.map((r: { uri: string }) => r.uri);

		const second = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(BOOK_URI('book-dune'))}&limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`,
		);
		expect(second.status).toBe(200);
		const secondBody = await second.json();
		expect(secondBody.reviews).toHaveLength(1);
		expect(secondBody.cursor).toBeUndefined();
		const secondUris = secondBody.reviews.map((r: { uri: string }) => r.uri);
		expect(secondUris.filter((u: string) => firstUris.includes(u))).toHaveLength(0);
	});

	it('returns NotFound for a missing book', async () => {
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(BOOK_URI('nope'))}`,
		);
		expect(res.status).toBe(404);
	});
});

describe('searchReviews', () => {
	const h = makeUserHarness();

	it('finds reviews by text (case-insensitive)', async () => {
		h.seedReview('rev-1', { text: 'A MASTERPIECE of worldbuilding' });
		h.seedReview('rev-2', { text: 'meh' });
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('masterpiece'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.reviews[0].uri).toBe(userUri(COLLECTION.review, 'rev-1'));
	});

	it('filters by tag', async () => {
		h.seedReview('rev-1', { tags: ['favorite', 'worldbuilding'] });
		h.seedReview('rev-2', { tags: ['sand'] });
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=%20&tag=' + encodeURIComponent('favorite'));
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].uri).toBe(userUri(COLLECTION.review, 'rev-1'));
	});

	it('filters by minimum rating', async () => {
		h.seedReview('rev-1', { rating: 5 });
		h.seedReview('rev-2', { rating: 3 });
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=%20&rating=4');
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].rating).toBe(5);
	});

	it('filters by status', async () => {
		h.seedReview('rev-1', { status: 'read' });
		h.seedReview('rev-2', { status: 'reading' });
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=%20&status=' + encodeURIComponent('reading'));
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].uri).toBe(userUri(COLLECTION.review, 'rev-2'));
	});

	it('filters by book', async () => {
		h.seedReview('rev-1', { text: 'hello' });
		h.seedReview('rev-2', { book: { ref: BOOK_URI('book-flowers'), title: 'Flowers for Algernon' }, text: 'hello' });
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=${encodeURIComponent('hello')}&book=${encodeURIComponent(BOOK_URI('book-flowers'))}`,
		);
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].book.title).toBe('Flowers for Algernon');
	});

	it('reports hitsTotal across the whole filtered set', async () => {
		h.seedReview('rev-1', { text: 'same words' });
		h.seedReview('rev-2', { text: 'same words' });
		h.seedReview('rev-3', { text: 'different' });
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('same'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(2);
	});
});

describe('listShelves', () => {
	const h = makeUserHarness();

	it('lists the user shelves from the PDS', async () => {
		h.seedShelf('shelf-favorites', { name: 'Favorites' });
		h.seedShelf('shelf-dnf', { name: 'DNF' });
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.listShelves');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves.map((s: { name: string }) => s.name).sort()).toEqual(['DNF', 'Favorites']);
	});
});

describe('listBooksOnShelf', () => {
	const h = makeUserHarness();

	it('lists the books on a shelf with hydrated shelf and book', async () => {
		h.seedShelf('shelf-favorites');
		h.seedShelving('shelving-1', { metadata: { status: 'reading', position: 1 } });
		h.seedShelving('shelving-2', {
			book: { ref: BOOK_URI('book-flowers'), title: 'Flowers for Algernon' },
			metadata: { status: 'to-read' },
		});
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=${encodeURIComponent(SHELF_URI('shelf-favorites'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves).toHaveLength(2);
		expect(body.bookShelves[0].book.title).toBe('Dune (40th Anniversary)');
		expect(body.bookShelves[0].shelf.name).toBe('Favorites');
		expect(body.bookShelves[1].book.title).toBe('Flowers for Algernon');
	});
});

describe('getShelvingOfBook', () => {
	const h = makeUserHarness();

	it('lists the shelves a book is on', async () => {
		h.seedShelf('shelf-favorites');
		h.seedShelf('shelf-current', { name: 'current' });
		h.seedShelving('shelving-1', { shelf: SHELF_URI('shelf-favorites') });
		h.seedShelving('shelving-2', { shelf: SHELF_URI('shelf-current'), metadata: { status: 'to-read' } });
		h.seedShelving('shelving-3', {
			book: { ref: BOOK_URI('book-flowers'), title: 'Flowers for Algernon' },
			shelf: SHELF_URI('shelf-favorites'),
		});
		const res = await h.fetchUser(
			`/xrpc/net.olamaelcu.livtet.biblio.getShelvingOfBook?book=${encodeURIComponent(BOOK_URI('book-dune'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves).toHaveLength(2);
		expect(body.bookShelves.map((b: { shelf: { name: string } }) => b.shelf.name).sort()).toEqual([
			'Favorites',
			'current',
		]);
	});
});

describe('listShelvesWithBooks', () => {
	const h = makeUserHarness();

	it('returns shelves each hydrated with their books', async () => {
		h.seedShelf('shelf-favorites');
		h.seedShelf('shelf-empty', { name: 'Empty' });
		h.seedShelving('shelving-1', { metadata: { status: 'reading', position: 1 } });
		h.seedShelving('shelving-2', {
			book: { ref: BOOK_URI('book-flowers'), title: 'Flowers for Algernon' },
			metadata: { status: 'to-read', position: 2 },
		});
		const res = await h.fetchUser('/xrpc/net.olamaelcu.livtet.biblio.listShelvesWithBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves).toHaveLength(2);
		const favorites = body.shelves.find((s: { shelf: { name: string } }) => s.shelf.name === 'Favorites');
		expect(favorites.books).toHaveLength(2);
		expect(favorites.books.map((b: { book: { title: string } }) => b.book.title).sort()).toEqual([
			'Dune (40th Anniversary)',
			'Flowers for Algernon',
		]);
		const empty = body.shelves.find((s: { shelf: { name: string } }) => s.shelf.name === 'Empty');
		expect(empty.books).toHaveLength(0);
	});
});
