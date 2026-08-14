import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, uri } from '../test-utils/db.js';
import type { ViewContext } from './views.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

function app(db: ReturnType<typeof createTestDb>['db']) {
	const router = createXrpcRouter(db, ctx);
	return {
		fetch: (path: string) => router.fetch(new Request(`https://books.example.com${path}`)),
	};
}

const BOOK_URI = (pk: string) =>
	encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', pk));

function testDb(): ReturnType<typeof createTestDb>['db'] {
	const { db, seed } = createTestDb();
	seed();
	return db;
}

describe('release gating', () => {
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

	it('hides reviews of a staged book from listReviewsByBook and searchReviews', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const list = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${BOOK_URI('book-dune')}`);
		expect(list.status).toBe(404);
		const search = await app(db).fetch(`/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=${encodeURIComponent('worldbuilding')}`);
		expect(search.status).toBe(200);
		const body = await search.json();
		expect(body.reviews).toHaveLength(0);
		expect(body.hitsTotal).toBe(0);
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

describe('shelf release gating', () => {
	const BOOK_SHELVING_URI = (pk: string) =>
		encodeURIComponent(uri('net.olamaelcu.livtet.biblio.bookShelving', pk));
	const SHELF_URI = (pk: string) =>
		encodeURIComponent(uri('net.olamaelcu.livtet.biblio.shelf', pk));

	it('404s a staged book from getBookOnShelf', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${BOOK_SHELVING_URI('shelving-1')}`,
		);
		expect(res.status).toBe(404);
	});

	it('404s a staged book from getShelvingOfBook', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-dune'`);
		const res = await app(db).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getShelvingOfBook?book=${BOOK_URI('book-dune')}`,
		);
		expect(res.status).toBe(404);
	});

	it('omits a staged book from listBooksOnShelf', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await app(db).fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=${SHELF_URI('shelf-favorites')}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves).toHaveLength(1);
		expect(body.bookShelves[0].book.title).toBe('Dune (40th Anniversary)');
	});

	it('omits a staged book from listShelvesWithBooks', async () => {
		const db = testDb();
		db.run(sql`UPDATE books SET release_status = 'staged' WHERE pk = 'book-flowers'`);
		const res = await app(db).fetch('/xrpc/net.olamaelcu.livtet.biblio.listShelvesWithBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves).toHaveLength(1);
		expect(body.shelves[0].books).toHaveLength(1);
		expect(body.shelves[0].books[0].book.title).toBe('Dune (40th Anniversary)');
	});
});
