import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST, uri } from '../test-utils/db.js';
import { userRecords } from '../db/schema.js';
import type { ViewContext } from './views.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

const USER_DID = 'did:web:alice.example.com';

const COLLECTION = {
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelving: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
};

const BOOK_URI = (pk: string) => encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', pk));
const userUri = (collection: string, rkey: string) => `at://${USER_DID}/${collection}/${rkey}`;
const SHELF_URI = (rkey: string) => encodeURIComponent(userUri(COLLECTION.shelf, rkey));

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

async function testDb(): Promise<ReturnType<typeof createTestDb>['db']> {
	const { db, seed } = await createTestDb();
	await seed();
	return db;
}

const FIXED_CID = 'bafyreiadsbmmn4waznesyuz3bjgrj33xzqhxrk6mz3ksq7meugrachh3qe';

async function seedUserRecord(
	db: ReturnType<typeof createTestDb>['db'],
	did: string,
	collection: string,
	rkey: string,
	value: Record<string, unknown>,
) {
	await db.insert(userRecords)
		.values({
			did,
			collection,
			rkey,
			cid: FIXED_CID,
			record: { $type: collection, ...value },
			indexedAt: Math.floor(Date.now() / 1000),
		});
}

describe('catalog release gating', () => {
	it('404s a staged book from getBook', async () => {
		const db = await testDb();
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`);
		expect(res.status).toBe(404);
	});

	it('omits a released book whose work is staged', async () => {
		const db = await testDb();
		await db.execute(sql`UPDATE works SET release_status = 'staged' WHERE pk = 'work-dune'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.work).toBeUndefined();
		expect(body.book.title).toBe('Dune (40th Anniversary)');
	});

	it('omits staged contributors and genres from a book view', async () => {
		const db = await testDb();
		await db.execute(sql`UPDATE contributors SET release_status = 'staged' WHERE pk = 'author-herbert'`);
		await db.execute(sql`UPDATE genres SET release_status = 'staged' WHERE pk = 'scifi'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.contributors.some((c: { contributor: { name: string } }) => c.contributor.name === 'Frank Herbert')).toBe(false);
		expect(body.book.genres.map((g: { name: string }) => g.name)).toEqual(['Fiction']);
	});

	it('counts only released books in search hitsTotal', async () => {
		const db = await testDb();
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=${encodeURIComponent('a')}`);
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('excludes staged works from searchWorks', async () => {
		const db = await testDb();
		await db.execute(sql`UPDATE works SET release_status = 'staged' WHERE pk = 'work-dune'`);
		const res = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=${encodeURIComponent('Dune')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.works).toHaveLength(0);
		expect(body.hitsTotal).toBe(0);
	});
});

describe('auth gating', () => {
	it('serves user-content and catalog endpoints anonymously (no self-only restriction)', async () => {
		const db = await testDb();
		await seedUserRecord(db, USER_DID, COLLECTION.review, 'rev-1', {
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			status: 'read',
		});
		await seedUserRecord(db, USER_DID, COLLECTION.shelf, 'shelf-1', { name: 'Favorites' });
		const paths = [
			`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${BOOK_URI('book-dune')}`,
			'/xrpc/net.olamaelcu.livtet.biblio.listBooks',
			'/xrpc/net.olamaelcu.livtet.biblio.listGenres',
			'/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=' + encodeURIComponent('Dune'),
			'/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('Dune'),
			'/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=' + encodeURIComponent('Frank'),
			`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'rev-1'))}`,
			`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${SHELF_URI('shelf-1')}`,
			'/xrpc/net.olamaelcu.livtet.biblio.listShelves',
			'/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=' + encodeURIComponent(USER_DID),
		];
		for (const path of paths) {
			const res = await app(db).fetch(path);
			expect(res.status, path).toBe(200);
		}
	});
});

describe('user-record release gating', () => {
	it('404s a review of a staged book from getReview', async () => {
		const db = await testDb();
		await seedUserRecord(db, USER_DID, COLLECTION.review, 'rev-1', {
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			rating: 5,
			status: 'read',
		});
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'rev-1'))}`,
		);
		expect(res.status).toBe(404);
	});

	it('skips reviews of staged books from searchReviews', async () => {
		const db = await testDb();
		await seedUserRecord(db, USER_DID, COLLECTION.review, 'rev-1', {
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			rating: 5,
			status: 'read',
			text: 'worldbuilding',
		});
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('worldbuilding'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reviews).toHaveLength(0);
		expect(body.hitsTotal).toBe(0);
	});

	it('404s a bookShelving of a staged book from getBookOnShelf', async () => {
		const db = await testDb();
		await seedUserRecord(db, USER_DID, COLLECTION.shelf, 'shelf-favorites', { name: 'Favorites' });
		await seedUserRecord(db, USER_DID, COLLECTION.bookShelving, 'shelving-1', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			metadata: { status: 'reading' },
		});
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${encodeURIComponent(userUri(COLLECTION.bookShelving, 'shelving-1'))}`,
		);
		expect(res.status).toBe(404);
	});

	it('omits staged books from listBooksOnShelf', async () => {
		const db = await testDb();
		await seedUserRecord(db, USER_DID, COLLECTION.shelf, 'shelf-favorites', { name: 'Favorites' });
		await seedUserRecord(db, USER_DID, COLLECTION.bookShelving, 'shelving-1', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			metadata: { status: 'reading' },
		});
		await seedUserRecord(db, USER_DID, COLLECTION.bookShelving, 'shelving-2', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-flowers'), title: 'Flowers for Algernon' },
			metadata: { status: 'to-read' },
		});
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await app(db).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=${SHELF_URI('shelf-favorites')}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves).toHaveLength(1);
		expect(body.bookShelves[0].book.title).toBe('Dune (40th Anniversary)');
	});

	it('omits staged books from listShelvesWithBooks', async () => {
		const db = await testDb();
		await seedUserRecord(db, USER_DID, COLLECTION.shelf, 'shelf-favorites', { name: 'Favorites' });
		await seedUserRecord(db, USER_DID, COLLECTION.bookShelving, 'shelving-1', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-dune'), title: 'Dune' },
			metadata: { status: 'reading' },
		});
		await seedUserRecord(db, USER_DID, COLLECTION.bookShelving, 'shelving-2', {
			shelf: userUri(COLLECTION.shelf, 'shelf-favorites'),
			book: { ref: uri('net.olamaelcu.livtet.biblio.book', 'book-flowers'), title: 'Flowers for Algernon' },
			metadata: { status: 'to-read' },
		});
		await db.execute(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await app(db).fetch('/xrpc/net.olamaelcu.livtet.biblio.listShelvesWithBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves).toHaveLength(1);
		expect(body.shelves[0].books).toHaveLength(1);
		expect(body.shelves[0].books[0].book.title).toBe('Dune (40th Anniversary)');
	});
});
