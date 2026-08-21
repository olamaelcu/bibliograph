import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST, uri } from '../test-utils/db.js';
import { books, userRecords } from '../db/schema.js';
import { getEngagementForSubject } from '../network/constellation.js';
import type { ViewContext } from './views.js';

vi.mock('../network/constellation.js', () => ({
  getEngagementForSubject: vi.fn(),
}));

const ctx: ViewContext = { serviceDid: SERVICE_DID };

const USER_DID = 'did:web:alice.example.com';
const OTHER_DID = 'did:web:bob.example.com';

const COLLECTION = {
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelving: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
};

const atUri = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
const userUri = (collection: string, rkey: string) => atUri(USER_DID, collection, rkey);
const BOOK_URI = (pk: string) => uri('net.olamaelcu.livtet.biblio.book', pk);
const SHELF_URI = (rkey: string) => userUri(COLLECTION.shelf, rkey);

/** Valid CIDv1 string — the read paths never validate it against anything. */
const FIXED_CID = 'bafyreiadsbmmn4waznesyuz3bjgrj33xzqhxrk6mz3ksq7meugrachh3qe';

beforeAll(() => {
  process.env.ATP_SERVICE_DID = SERVICE_DID;
  process.env.ATP_SERVICE_HOST = SERVICE_HOST;
});
beforeEach(() => {
  vi.mocked(getEngagementForSubject).mockReset();
});
afterAll(() => {
  delete process.env.ATP_SERVICE_DID;
  delete process.env.ATP_SERVICE_HOST;
});

/** Bare anonymous app backed only by the local catalog DB (no user PDS). */
async function app() {
	const { db, seed } = await createTestDb();
	await seed();
	const router = createXrpcRouter(db, ctx);
	return {
		db,
		fetch: (path: string) => router.fetch(new Request(`https://books.example.com${path}`)),
	};
}

/** Seed a Jetstream-indexed user record directly, as if ingested from the firehose. */
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

async function seedReview(
	db: ReturnType<typeof createTestDb>['db'],
	did: string,
	rkey: string,
	overrides: Record<string, unknown> = {},
) {
	await seedUserRecord(db, did, COLLECTION.review, rkey, {
		book: { ref: BOOK_URI('book-dune'), title: 'Dune (40th Anniversary)' },
		tags: [],
		rating: 5,
		status: 'read',
		text: 'A masterpiece of worldbuilding',
		createdAt: '2024-01-01T00:00:00.000Z',
		...overrides,
	});
}

async function seedShelf(
	db: ReturnType<typeof createTestDb>['db'],
	did: string,
	rkey: string,
	overrides: Record<string, unknown> = {},
) {
	await seedUserRecord(db, did, COLLECTION.shelf, rkey, {
		name: 'Favorites',
		description: 'Books I loved',
		createdAt: '2024-01-01T00:00:00.000Z',
		...overrides,
	});
}

async function seedShelving(
	db: ReturnType<typeof createTestDb>['db'],
	did: string,
	rkey: string,
	overrides: Record<string, unknown> = {},
) {
	await seedUserRecord(db, did, COLLECTION.bookShelving, rkey, {
		shelf: atUri(did, COLLECTION.shelf, 'shelf-favorites'),
		book: { ref: BOOK_URI('book-dune'), title: 'Dune (40th Anniversary)' },
		metadata: { status: 'reading', position: 1 },
		createdAt: '2024-01-01T00:00:00.000Z',
		...overrides,
	});
}

async function releasedBooks() {
	const a = await app();
	const now = Math.floor(Date.now() / 1000);
	for (let i = 0; i < 5; i++) {
		await a.db
			.insert(books)
			.values({
				pk: `book-page-${i}`,
				title: `Paged Book ${String(i).padStart(2, '0')}`,
				createdAt: now + i,
				releaseStatus: 'released',
			});
	}
	return a;
}

// ─── user-content: served over the Jetstream-indexed local table ─────────────
// These endpoints are public (no self-only restriction): any indexed DID's
// records are readable by anyone, matching how catalog reads work.

describe('getReview', () => {
	it('returns a review view hydrated from the local index', async () => {
		const a = await app();
		await seedReview(a.db, USER_DID, 'rev-1', { rating: 4 });
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'rev-1'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.review.did).toBe(USER_DID);
		expect(body.review.rating).toBe(4);
		expect(body.review.book.title).toBe('Dune (40th Anniversary)');
	});

	it('serves a review indexed for any DID, not just the caller', async () => {
		const a = await app();
		await seedReview(a.db, OTHER_DID, 'rev-1');
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(atUri(OTHER_DID, COLLECTION.review, 'rev-1'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.review.did).toBe(OTHER_DID);
	});

	it('returns NotFound for a record not yet indexed', async () => {
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getReview?uri=${encodeURIComponent(userUri(COLLECTION.review, 'nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('getShelf', () => {
	it('returns a shelf view', async () => {
		const a = await app();
		await seedShelf(a.db, USER_DID, 'shelf-favorites');
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getShelf?uri=${encodeURIComponent(SHELF_URI('shelf-favorites'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelf.name).toBe('Favorites');
	});
});

describe('getBookOnShelf', () => {
	it('hydrates the shelving with its shelf and catalog book', async () => {
		const a = await app();
		await seedShelf(a.db, USER_DID, 'shelf-favorites');
		await seedShelving(a.db, USER_DID, 'shelving-1');
		const res = await a.fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getBookOnShelf?uri=${encodeURIComponent(userUri(COLLECTION.bookShelving, 'shelving-1'))}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelf.did).toBe(USER_DID);
		expect(body.bookShelf.shelf.name).toBe('Favorites');
		expect(body.bookShelf.book.title).toBe('Dune (40th Anniversary)');
	});
});

describe('getShelvingOfBook', () => {
	it('aggregates shelvings of a book across every indexed DID', async () => {
		const a = await app();
		await seedShelf(a.db, USER_DID, 'shelf-favorites');
		await seedShelf(a.db, OTHER_DID, 'shelf-favorites');
		await seedShelving(a.db, USER_DID, 'shelving-1');
		await seedShelving(a.db, OTHER_DID, 'shelving-1');
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getShelvingOfBook?book=${encodeURIComponent(BOOK_URI('book-dune'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves.map((b: { did: string }) => b.did).sort()).toEqual([OTHER_DID, USER_DID].sort());
	});
});

describe('listReviewsByBook', () => {
	it('lists reviews of a book across every indexed DID', async () => {
		const a = await app();
		await seedReview(a.db, USER_DID, 'rev-1', { text: 'from alice' });
		await seedReview(a.db, OTHER_DID, 'rev-1', { text: 'from bob' });
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(BOOK_URI('book-dune'))}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reviews).toHaveLength(2);
		expect(body.reviews.map((r: { did: string }) => r.did).sort()).toEqual([OTHER_DID, USER_DID].sort());
	});

	it('returns NotFound for an unreleased book', async () => {
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.listReviewsByBook?book=${encodeURIComponent(BOOK_URI('nope'))}`);
		expect(res.status).toBe(404);
	});
});

describe('listShelves', () => {
	it('lists shelves across every indexed DID', async () => {
		const a = await app();
		await seedShelf(a.db, USER_DID, 'shelf-favorites', { name: 'Favorites' });
		await seedShelf(a.db, OTHER_DID, 'shelf-tbr', { name: 'To Be Read' });
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listShelves');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves.map((s: { name: string }) => s.name).sort()).toEqual(['Favorites', 'To Be Read']);
	});
});

describe('listBooksOnShelf', () => {
	it('orders shelvings on a single shelf by position', async () => {
		const a = await app();
		await seedShelf(a.db, USER_DID, 'shelf-favorites');
		await seedShelving(a.db, USER_DID, 'shelving-2', { metadata: { status: 'to-read', position: 2 } });
		await seedShelving(a.db, USER_DID, 'shelving-1', { metadata: { status: 'reading', position: 1 } });
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=${SHELF_URI('shelf-favorites')}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.bookShelves.map((b: { metadata: { position: number } }) => b.metadata?.position)).toEqual([1, 2]);
	});
});

describe('listShelvesWithBooks', () => {
	it('nests each DID’s shelves with their own shelvings', async () => {
		const a = await app();
		await seedShelf(a.db, USER_DID, 'shelf-favorites', { name: 'Favorites' });
		await seedShelving(a.db, USER_DID, 'shelving-1');
		await seedShelf(a.db, OTHER_DID, 'shelf-favorites', { name: 'Favorites' });
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listShelvesWithBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shelves).toHaveLength(2);
		const withBooks = body.shelves.filter((s: { books: unknown[] }) => s.books.length > 0);
		expect(withBooks).toHaveLength(1);
		expect(withBooks[0].books[0].did).toBe(USER_DID);
	});
});

describe('searchReviews', () => {
	it('matches review text across every indexed DID', async () => {
		const a = await app();
		await seedReview(a.db, USER_DID, 'rev-1', { text: 'A masterpiece of worldbuilding' });
		await seedReview(a.db, OTHER_DID, 'rev-1', { text: 'Just okay' });
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=' + encodeURIComponent('masterpiece'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].did).toBe(USER_DID);
	});

	it('filters by rating', async () => {
		const a = await app();
		await seedReview(a.db, USER_DID, 'rev-1', { rating: 5 });
		await seedReview(a.db, OTHER_DID, 'rev-1', { rating: 2 });
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchReviews?q=%20&rating=4');
		const body = await res.json();
		expect(body.reviews).toHaveLength(1);
		expect(body.reviews[0].did).toBe(USER_DID);
	});
});

describe('getActor', () => {
	it('returns the actor profile for an indexed DID', async () => {
		const a = await app();
		await seedUserRecord(a.db, USER_DID, COLLECTION.actor, 'self', { displayName: 'Alice' });
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=' + encodeURIComponent(USER_DID));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.actor.did).toBe(USER_DID);
		expect(body.actor.displayName).toBe('Alice');
	});

	it('returns a bare actor view for a DID with no indexed profile record', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=' + encodeURIComponent(USER_DID));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.actor.did).toBe(USER_DID);
		expect(body.actor.displayName).toBeUndefined();
	});
});

describe('getBook', () => {
	it('hydrates a book view with work, format, genres, contributors', async () => {
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(BOOK_URI('book-dune'))}`);
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
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(BOOK_URI('nope'))}`);
		expect(res.status).toBe(404);
	});

it('rejects a uri from a different service', async () => {
    const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=' + encodeURIComponent('at://did:web:other.example.com/net.olamaelcu.livtet.biblio.book/x'));
    expect(res.status).toBe(400);
  });

  it('attaches bsky engagement when constellation returns non-zero counts', async () => {
    const bookUri = BOOK_URI('book-dune');
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 3, quoteCount: 1 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(bookUri)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.book.bsky).toEqual({ likeCount: 3, quoteCount: 1 });
    expect(vi.mocked(getEngagementForSubject)).toHaveBeenCalledWith(bookUri);
  });

  it('omits bsky when constellation returns zero counts', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 0, quoteCount: 0 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(BOOK_URI('book-dune'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.book.bsky).toBeUndefined();
    expect('bsky' in body.book).toBe(false);
  });

  it('omits bsky when constellation fetch fails', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue(undefined);
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(BOOK_URI('book-dune'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.book.bsky).toBeUndefined();
    expect('bsky' in body.book).toBe(false);
  });
});

describe('getWork', () => {
  it('returns a work view', async () => {
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'work-dune'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work.title).toBe('Dune');
    expect(body.work.identifiers[0].resource).toBe('openlibrary:works/OL893423W');
  });

  it('returns NotFound', async () => {
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'nope'))}`);
    expect(res.status).toBe(404);
  });

  it('attaches bsky engagement when constellation returns non-zero counts', async () => {
    const workUri = uri('net.olamaelcu.livtet.biblio.work', 'work-dune');
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 3, quoteCount: 1 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(workUri)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work.bsky).toEqual({ likeCount: 3, quoteCount: 1 });
    expect(vi.mocked(getEngagementForSubject)).toHaveBeenCalledWith(workUri);
  });

  it('omits bsky when constellation returns zero counts', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 0, quoteCount: 0 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'work-dune'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work.bsky).toBeUndefined();
    expect('bsky' in body.work).toBe(false);
  });

  it('omits bsky when constellation fetch fails', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue(undefined);
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getWork?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'work-dune'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work.bsky).toBeUndefined();
    expect('bsky' in body.work).toBe(false);
  });
});

describe('getContributor', () => {
  it('returns a contributor view', async () => {
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'author-herbert'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributor.name).toBe('Frank Herbert');
    expect(body.contributor.sortName).toBe('Herbert, Frank');
    expect(body.contributor.identifiers[0].resource).toBe('viaf:59083797');
  });

  it('returns NotFound', async () => {
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'nope'))}`);
    expect(res.status).toBe(404);
  });

  it('attaches bsky engagement when constellation returns non-zero counts', async () => {
    const contributorUri = uri('net.olamaelcu.livtet.biblio.contributor', 'author-herbert');
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 3, quoteCount: 1 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(contributorUri)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributor.bsky).toEqual({ likeCount: 3, quoteCount: 1 });
    expect(vi.mocked(getEngagementForSubject)).toHaveBeenCalledWith(contributorUri);
  });

  it('omits bsky when constellation returns zero counts', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 0, quoteCount: 0 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'author-herbert'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributor.bsky).toBeUndefined();
    expect('bsky' in body.contributor).toBe(false);
  });

  it('omits bsky when constellation fetch fails', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue(undefined);
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'author-herbert'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributor.bsky).toBeUndefined();
    expect('bsky' in body.contributor).toBe(false);
  });
});

describe('getGenre', () => {
  it('returns a genre view with parent', async () => {
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'scifi'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.genre.name).toBe('Science Fiction');
    expect(body.genre.parent).toBe(uri('net.olamaelcu.livtet.biblio.genre', 'fiction'));
  });

  it('returns NotFound', async () => {
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'nope'))}`);
    expect(res.status).toBe(404);
  });

  it('attaches bsky engagement when constellation returns non-zero counts', async () => {
    const genreUri = uri('net.olamaelcu.livtet.biblio.genre', 'scifi');
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 3, quoteCount: 1 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(genreUri)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.genre.bsky).toEqual({ likeCount: 3, quoteCount: 1 });
    expect(vi.mocked(getEngagementForSubject)).toHaveBeenCalledWith(genreUri);
  });

  it('omits bsky when constellation returns zero counts', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue({ likeCount: 0, quoteCount: 0 });
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'scifi'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.genre.bsky).toBeUndefined();
    expect('bsky' in body.genre).toBe(false);
  });

  it('omits bsky when constellation fetch fails', async () => {
    vi.mocked(getEngagementForSubject).mockResolvedValue(undefined);
    const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'scifi'))}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.genre.bsky).toBeUndefined();
    expect('bsky' in body.genre).toBe(false);
  });
});

describe('listBooks', () => {
	it('returns all books with a cursor only when a next page exists', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.books.map((b: { title: string }) => b.title).sort()).toEqual([
			'Dune (40th Anniversary)',
			'Flowers for Algernon',
		]);
		expect(body.cursor).toBeUndefined();
	});

	it('filters by genre', async () => {
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooks?genre=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.genre', 'scifi'))}`);
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('filters by work', async () => {
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooks?work=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.work', 'work-dune'))}`);
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('filters by contributor', async () => {
		const res = await (await app()).fetch(`/xrpc/net.olamaelcu.livtet.biblio.listBooks?contributor=${encodeURIComponent(uri('net.olamaelcu.livtet.biblio.contributor', 'author-herbert'))}`);
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('ignores the status param (no longer a review filter)', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?status=read');
		const body = await res.json();
		expect(body.books.map((b: { title: string }) => b.title).sort()).toEqual([
			'Dune (40th Anniversary)',
			'Flowers for Algernon',
		]);
	});

	it('paginates with a limit of 1 and returns a cursor', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?limit=1');
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.cursor).toBeDefined();
	});

	it('follows the cursor to the next page without overlap', async () => {
		const { fetch } = await releasedBooks();
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
		const { fetch } = await releasedBooks();
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
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?cursor=' + encodeURIComponent('not-a-cursor'),);
		expect(res.status).toBe(400);
	});
});

describe('listGenres', () => {
	it('returns all genres', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.listGenres');
		const body = await res.json();
		expect(body.genres.map((g: { name: string }) => g.name).sort()).toEqual(['Fiction', 'Science Fiction']);
	});

	it('filters to top-level genres', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.listGenres?topLevelOnly=true');
		const body = await res.json();
		expect(body.genres.map((g: { name: string }) => g.name)).toEqual(['Fiction']);
	});
});

describe('searchBooks', () => {
	it('finds books by title', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=' + encodeURIComponent('Dune'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});

	it('finds books by identifier', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=' + encodeURIComponent('isbn:0441172717'));
		const body = await res.json();
		expect(body.books).toHaveLength(1);
		expect(body.books[0].title).toBe('Dune (40th Anniversary)');
	});
});

describe('searchContributors', () => {
	it('finds contributors by name', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=' + encodeURIComponent('Frank'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.contributors[0].name).toBe('Frank Herbert');
	});

	it('finds contributors by sort name', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=' + encodeURIComponent('Herbert'));
		const body = await res.json();
		expect(body.contributors).toHaveLength(1);
	});
});

describe('searchWorks', () => {
	it('finds works by title', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('Dune'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.works[0].title).toBe('Dune');
	});

	it('finds works by identifier', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('openlibrary:works/OL893423W'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(1);
		expect(body.works[0].identifiers[0].resource).toBe('openlibrary:works/OL893423W');
	});

	it('returns empty results for no match', async () => {
		const res = await (await app()).fetch('/xrpc/net.olamaelcu.livtet.biblio.searchWorks?q=' + encodeURIComponent('nonexistent'));
		const body = await res.json();
		expect(body.hitsTotal).toBe(0);
		expect(body.works).toHaveLength(0);
	});
});

