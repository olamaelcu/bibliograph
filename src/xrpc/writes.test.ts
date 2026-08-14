import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XRPCRouter } from '@atcute/xrpc-server';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST, uri } from '../test-utils/db.js';
import { createFakePds, serveFakePds, type FakePds } from '../test-utils/fake-pds.js';
import { makeDidDoc, makeJwt } from '../test-utils/fake-auth.js';
import { getServiceDid } from '../did.js';
import type { ViewContext } from './views.js';
import { slugify } from './writes.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

const USER_DID = 'did:web:alice.example.com';
const USER_HANDLE = 'alice.example.com';

const COLLECTION = {
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelving: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
};

const BOOK_URI = (pk: string) => uri('net.olamaelcu.livtet.biblio.book', pk);
const SHELF_URI = (rkey: string) => `at://${USER_DID}/${COLLECTION.shelf}/${rkey}`;

beforeAll(() => {
	process.env.ATP_SERVICE_DID = SERVICE_DID;
	process.env.ATP_SERVICE_HOST = SERVICE_HOST;
});
afterAll(() => {
	delete process.env.ATP_SERVICE_DID;
	delete process.env.ATP_SERVICE_HOST;
});

/**
 * Full proxy harness: local catalog DB + an in-memory fake user PDS served over
 * HTTP, with global fetch stubbed for DID-document lookups.
 */
function makeHarness() {
	let fake: FakePds;
	let close: () => void;
	let token: string;
	let router: XRPCRouter;

	beforeEach(async () => {
		const t = createTestDb();
		t.seed();
		router = createXrpcRouter(t.db, ctx);

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

	const post = (path: string, body: unknown, auth = true) =>
		router.fetch(
			new Request(`https://books.example.com${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(auth ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			}),
		);

	return {
		get fake() {
			return fake;
		},
		post,
	};
}

describe('biblio write procedures (proxy to user PDS)', () => {
	const h = makeHarness();

	it('putReview writes a review record keyed by the book pk', async () => {
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putReview', {
			book: BOOK_URI('book-dune'),
			rating: 5,
			status: 'read',
			text: 'A masterpiece of worldbuilding',
			tags: ['favorite', 'worldbuilding'],
		});
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.uri).toBe(`at://${USER_DID}/${COLLECTION.review}/book-dune`);
		expect(out.cid).toMatch(/^baf/);

		const rec = h.fake.records.get(`${COLLECTION.review}/book-dune`);
		expect(rec).toBeDefined();
		const value = rec!.value as {
			$type: string;
			book: { ref: string; title: string };
			rating: number;
			status: string;
			text: string;
			tags: string[];
		};
		expect(value.$type).toBe(COLLECTION.review);
		expect(value.book.ref).toBe(BOOK_URI('book-dune'));
		expect(value.book.title).toBe('Dune (40th Anniversary)');
		expect(value.rating).toBe(5);
		expect(value.status).toBe('read');
		expect(value.text).toBe('A masterpiece of worldbuilding');
		expect(value.tags).toEqual(['favorite', 'worldbuilding']);
	});

	it('putReview upserts in place of the same book', async () => {
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putReview', {
			book: BOOK_URI('book-dune'),
			rating: 4,
			status: 'reading',
		});
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putReview', {
			book: BOOK_URI('book-dune'),
			rating: 5,
			status: 'read',
			text: 'Better on reread',
		});
		expect(res.status).toBe(200);
		const rec = h.fake.records.get(`${COLLECTION.review}/book-dune`);
		expect(rec).toBeDefined();
		expect((rec!.value as { rating: number }).rating).toBe(5);
		expect((rec!.value as { text: string }).text).toBe('Better on reread');
	});

	it('putReview rejects a book outside the catalog', async () => {
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putReview', {
			book: BOOK_URI('nope'),
			rating: 5,
			status: 'read',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('NotFound');
		expect(h.fake.records.size).toBe(0);
	});

	it('deleteReview removes the book-keyed review', async () => {
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putReview', {
			book: BOOK_URI('book-dune'),
			rating: 4,
			status: 'read',
		});
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.deleteReview', {
			book: BOOK_URI('book-dune'),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
		expect(h.fake.records.has(`${COLLECTION.review}/book-dune`)).toBe(false);
	});

	it('putShelf derives the rkey from the name and upserts', async () => {
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putShelf', {
			name: 'Favorites',
			description: 'Books I loved',
		});
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.uri).toBe(`at://${USER_DID}/${COLLECTION.shelf}/favorites`);
		expect(h.fake.records.get(`${COLLECTION.shelf}/favorites`)?.value).toMatchObject({
			$type: COLLECTION.shelf,
			name: 'Favorites',
			description: 'Books I loved',
		});

		const res2 = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putShelf', {
			name: 'Favorites',
			description: 'Updated description',
		});
		expect(res2.status).toBe(200);
		expect(h.fake.records.get(`${COLLECTION.shelf}/favorites`)?.value).toMatchObject({
			name: 'Favorites',
			description: 'Updated description',
		});
	});

	it('deleteShelf removes the shelf record', async () => {
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putShelf', { name: 'To Read' });
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.deleteShelf', {
			shelf: SHELF_URI('to-read'),
		});
		expect(res.status).toBe(200);
		expect(h.fake.records.has(`${COLLECTION.shelf}/to-read`)).toBe(false);
	});

	it('putBookShelving writes a shelving record with derived rkey', async () => {
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putShelf', { name: 'Favorites' });
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putBookShelving', {
			shelf: SHELF_URI('favorites'),
			book: BOOK_URI('book-dune'),
			metadata: { status: 'reading', position: 1, notes: 'Rereading' },
		});
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.uri).toBe(`at://${USER_DID}/${COLLECTION.bookShelving}/book-dune--favorites`);

		const rec = h.fake.records.get(`${COLLECTION.bookShelving}/book-dune--favorites`);
		expect(rec).toBeDefined();
		const value = rec!.value as {
			$type: string;
			shelf: string;
			book: { ref: string };
			metadata: { status: string; position: number; notes: string };
		};
		expect(value.$type).toBe(COLLECTION.bookShelving);
		expect(value.shelf).toBe(SHELF_URI('favorites'));
		expect(value.book.ref).toBe(BOOK_URI('book-dune'));
		expect(value.metadata).toEqual({ status: 'reading', position: 1, notes: 'Rereading' });
	});

	it('putBookShelving rejects a shelf that does not exist', async () => {
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putBookShelving', {
			shelf: SHELF_URI('missing'),
			book: BOOK_URI('book-dune'),
			metadata: { status: 'reading' },
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('NotFound');
	});

	it('deleteBookShelving removes the shelving record', async () => {
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putShelf', { name: 'Favorites' });
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putBookShelving', {
			shelf: SHELF_URI('favorites'),
			book: BOOK_URI('book-dune'),
			metadata: { status: 'reading' },
		});
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.deleteBookShelving', {
			shelf: SHELF_URI('favorites'),
			book: BOOK_URI('book-dune'),
		});
		expect(res.status).toBe(200);
		expect(h.fake.records.has(`${COLLECTION.bookShelving}/book-dune--favorites`)).toBe(false);
	});

	it('putActor writes the self profile record', async () => {
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.putActor', {
			displayName: 'Alice',
			description: 'Reader',
		});
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.uri).toBe(`at://${USER_DID}/${COLLECTION.actor}/self`);
		expect(h.fake.records.get(`${COLLECTION.actor}/self`)?.value).toMatchObject({
			$type: COLLECTION.actor,
			displayName: 'Alice',
			description: 'Reader',
		});
	});

	it('deleteActor removes the self profile record', async () => {
		await h.post('/xrpc/net.olamaelcu.livtet.biblio.putActor', { displayName: 'Alice' });
		const res = await h.post('/xrpc/net.olamaelcu.livtet.biblio.deleteActor', {});
		expect(res.status).toBe(200);
		expect(h.fake.records.has(`${COLLECTION.actor}/self`)).toBe(false);
	});

	it('requires auth for every write', async () => {
		const res = await h.post(
			'/xrpc/net.olamaelcu.livtet.biblio.putReview',
			{ book: BOOK_URI('book-dune'), rating: 5, status: 'read' },
			false,
		);
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('AuthRequired');
	});
});

describe('slugify', () => {
	it('lowercases and replaces runs of non-word chars', () => {
		expect(slugify('Favorites')).toBe('favorites');
		expect(slugify('To Read')).toBe('to-read');
		expect(slugify('  Sci-Fi & Fantasy  ')).toBe('sci-fi-fantasy');
	});

	it('falls back to a timestamped slug for a name that slugs to nothing', () => {
		const slug = slugify('!!!');
		expect(slug).toMatch(/^shelf-[0-9a-z]+$/);
	});
});
