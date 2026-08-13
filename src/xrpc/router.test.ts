import { describe, expect, it } from 'vitest';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, uri } from '../test-utils/db.js';
import type { ViewContext } from './views.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

function app() {
	const { db, seed } = createTestDb();
	seed();
	const router = createXrpcRouter(db, ctx);
	return {
		fetch: (path: string) => router.fetch(new Request(`https://books.example.com${path}`)),
	};
}

describe('getBook', () => {
	it('hydrates a book view with work, format, genres, contributors', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', 'book-dune'))}`);
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
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', 'nope'))}`);
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
		expect(body.work.identifiers[0].resource).toBe('openlibrary:OL893423W');
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

describe('getReview', () => {
	it('returns a review view with hydrated book and tags', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.review', 'review-1'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.review.rating).toBe(5);
		expect(body.review.status).toBe('read');
		expect(body.review.tags).toEqual(['favorite', 'worldbuilding']);
		expect(body.review.book.title).toBe('Dune (40th Anniversary)');
		expect(body.review.did).toBe('did:plc:reader1');
		expect(body.review.progress.progress).toBe(412);
		expect(body.review.progress.format.unit).toBe('pages');
	});

	it('returns NotFound', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.review', 'nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('getShelf', () => {
	it('returns a shelf view', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.shelf', 'shelf-favorites'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelf.name).toBe('Favorites');
	});

	it('returns NotFound', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.shelf', 'nope'))}`);
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

	it('filters by status', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooks?status=read`);
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('paginates with a limit of 1 and returns a cursor', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?limit=1');
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.cursor).toBeDefined();
	});
});

describe('listReviewsByBook', () => {
	it('lists reviews for a book', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', 'book-dune'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].rating).toBe(5);
	});

	it('returns NotFound for a missing book', async () => {
		const res = await app().fetch(`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.book', 'nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('listShelves', () => {
	it('returns all shelves', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.listShelves');
		const body = await res.json();
		expect(body.shelves).toHaveLength(1);
		expect(body.shelves[0].name).toBe('Favorites');
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

describe('searchReviews', () => {
	it('finds reviews by text', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('worldbuilding'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.reviews[0].rating).toBe(5);
	});

	it('finds reviews by tag', async () => {
		const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('favorite'));
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
	});

  it('filters by rating', async () => {
    const res = await app().fetch('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('a') + '&rating=5');
    const body = await res.json();
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].rating).toBe(5);
  });
});
