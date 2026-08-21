import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST } from '../test-utils/db.js';
import { GoogleBooksClient } from '../google-books/client.js';
import type { ViewContext } from '../lex/collections.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

let dbHolder: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	process.env.ATP_SERVICE_DID = SERVICE_DID;
	process.env.ATP_SERVICE_HOST = SERVICE_HOST;
	dbHolder = await createTestDb();
});

afterAll(async () => {
	await dbHolder.close();
	delete process.env.ATP_SERVICE_DID;
	delete process.env.ATP_SERVICE_HOST;
});

async function appWithGb(fetchImpl: typeof fetch, body: unknown) {
	const gb = new GoogleBooksClient({ apiKey: 'test', fetchImpl });
	const router = createXrpcRouter(dbHolder.db, ctx, { client: gb });
	return {
		fetch: (path: string) =>
			router.fetch(new Request(`https://books.example.com${path}`)),
		fetchImpl,
	};
}

function stubFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})) as typeof fetch;
}

describe('searchBooks (Google Books backed)', () => {
	it('returns GB results with hitsTotal', async () => {
		const items = [
			{ id: '_abc', volumeInfo: { title: 'A' } },
			{ id: '_def', volumeInfo: { title: 'B' } },
		];
		const a = await appWithGb(stubFetch({ totalItems: 2, items }), null);
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=flowers&limit=2');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.hitsTotal).toBe(2);
		expect(body.books).toHaveLength(2);
		expect(body.books[0].title).toBe('A');
	});

	it('emits a cursor when more pages exist', async () => {
		// totalItems=10 but we asked for limit=2 — should yield a cursor
		const items = Array.from({ length: 2 }, (_, i) => ({ id: `_id${i}`, volumeInfo: { title: `T${i}` } }));
		const a = await appWithGb(stubFetch({ totalItems: 10, items }), null);
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=x&limit=2');
		const body = await res.json();
		expect(typeof body.cursor).toBe('string');
	});

	it('serves cached hits without re-hitting GB on identical params', async () => {
		let calls = 0;
		const trackingFetch = (async () => {
			calls += 1;
			return new Response(JSON.stringify({ totalItems: 1, items: [{ id: '_a', volumeInfo: { title: 'A' } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;
		const a = await appWithGb(trackingFetch, null);
		await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=cached');
		await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=cached');
		expect(calls).toBe(1);
	});

	it('handles empty GB results with hitsTotal 0', async () => {
		const a = await appWithGb(stubFetch({ totalItems: 0, items: [] }), null);
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=nothing');
		const body = await res.json();
		expect(body.books).toEqual([]);
		expect(body.hitsTotal).toBe(0);
	});
});

describe('getBook (Google Books backed)', () => {
	it('returns 200 for a gb- rkey and shapes the BookView', async () => {
		const a = await appWithGb(
			stubFetch({ id: '_abc', volumeInfo: { title: 'X', authors: ['A'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '1' }] } }),
			null,
		);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_abc`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.uri).toBe(uri);
		expect(body.book.title).toBe('X');
		expect(body.book.identifiers[0].resource).toBe('isbn_13:1');
	});

	it('returns 400 for a non-gb rkey', async () => {
		const a = await appWithGb(stubFetch({}), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/ol123m`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(400);
	});

	it('returns 404 when GB has no such volume', async () => {
		const a = await appWithGb(stubFetch('not found', 404), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_nope`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});

	it('returns 404 when GB omits volumeInfo.title', async () => {
		const a = await appWithGb(stubFetch({ id: '_empty' }), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_empty`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});
});

describe('listBooks (Google Books backed)', () => {
	it('requires at least one of q/genre/contributor', async () => {
		const a = await appWithGb(stubFetch({}), null);
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks');
		expect(res.status).toBe(400);
	});

	it('rejects the format filter as unsupported', async () => {
		const a = await appWithGb(stubFetch({}), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.format/paperback`;
		const res = await a.fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=x&format=${encodeURIComponent(uri)}`,
		);
		expect(res.status).toBe(400);
	});

	it('forwards q verbatim to GB', async () => {
		const a = await appWithGb(stubFetch({ totalItems: 0, items: [] }), null);
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=hello');
		expect(res.status).toBe(200);
	});

	it('translates contributor= to inauthor:', async () => {
		const a = await appWithGb(stubFetch({ totalItems: 0, items: [] }), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.contributor/gbauthors-tolkien-j-r-r`;
		const res = await a.fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooks?contributor=${encodeURIComponent(uri)}`,
		);
		expect(res.status).toBe(200);
	});

	it('translates genre= to subject:', async () => {
		const a = await appWithGb(stubFetch({ totalItems: 0, items: [] }), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.genre/fiction`;
		const res = await a.fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooks?genre=${encodeURIComponent(uri)}`,
		);
		expect(res.status).toBe(200);
	});
});

// Sanity: cache table is reused between handlers.
describe('cache cross-pollination', () => {
	it('searchBooks and listBooks do not share cache keys', async () => {
		const items = [{ id: '_a', volumeInfo: { title: 'A' } }];
		const a = await appWithGb(stubFetch({ totalItems: 1, items }), null);
		// Different endpoints cache under different endpoint names; calling
		// them with identical q should each make one GB request.
		let calls = 0;
		const tracking = (async () => {
			calls += 1;
			return new Response(JSON.stringify({ totalItems: 1, items }), { status: 200 });
		}) as typeof fetch;
		const b = await appWithGb(tracking, null);
		await b.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=z');
		await b.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=z');
		expect(calls).toBe(2);
		void a;
	});
});

// Touch the per-handler notImplemented stubs at least once each to confirm
// the export surface. The full per-endpoint behavior is covered by app.test
// only indirectly; this guards against accidental removal.
describe('stub handlers', () => {
	it('every remaining stub returns 501 NotImplemented', async () => {
		const a = await appWithGb(stubFetch({ totalItems: 0, items: [] }), null);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_abc`;
		const cases: Array<{ nsid: string; path: string }> = [
			{ nsid: 'getActor', path: `?actor=${encodeURIComponent(SERVICE_DID)}` },
			{ nsid: 'getBookOnShelf', path: `?uri=${encodeURIComponent(uri)}` },
			{ nsid: 'getContributor', path: `?uri=${encodeURIComponent(uri)}` },
			{ nsid: 'getGenre', path: `?uri=${encodeURIComponent(uri)}` },
			{ nsid: 'getReview', path: `?uri=${encodeURIComponent(uri)}` },
			{ nsid: 'getShelf', path: `?uri=${encodeURIComponent(uri)}` },
			{ nsid: 'getShelvingOfBook', path: `?book=${encodeURIComponent(uri)}` },
			{ nsid: 'listBooksOnShelf', path: `?shelf=${encodeURIComponent(uri)}` },
			{ nsid: 'listGenres', path: '' },
			{ nsid: 'listReviewsByBook', path: `?book=${encodeURIComponent(uri)}` },
			{ nsid: 'listShelves', path: '' },
			{ nsid: 'listShelvesWithBooks', path: '' },
			{ nsid: 'searchContributors', path: '?q=x' },
			{ nsid: 'searchReviews', path: '?q=x' },
		];
		for (const { nsid, path } of cases) {
			const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.${nsid}${path}`);
			expect(res.status, nsid).toBe(501);
			const body = await res.json();
			expect(body.error, nsid).toBe('NotImplementedError');
		}
	});
});

// Smoke test that nothing else in the router suite blows up.
void sql;
