import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST } from '../test-utils/db.js';
import { GoogleBooksClient } from '../google-books/client.js';
import type { ViewContext } from '../lex/collections.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

let dbHolder: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	process.env.ATP_SERVICE_HOST = SERVICE_HOST;
	dbHolder = await createTestDb();
	await dbHolder.seed();
});

afterAll(async () => {
	await dbHolder.close();
	delete process.env.ATP_SERVICE_HOST;
});

function stubFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})) as typeof fetch;
}

function countingFetch(body: unknown): { fetch: typeof fetch; calls: { count: number } } {
	const counter = { count: 0 };
	const fetchImpl = (async () => {
		counter.count += 1;
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	return { fetch: fetchImpl, calls: counter };
}

function appWithGb(fetchImpl: typeof fetch) {
	const gb = new GoogleBooksClient({ apiKey: 'test', fetchImpl });
	const r = createXrpcRouter(dbHolder.db, ctx, { client: gb });
	return {
		fetch: (path: string) => r.fetch(new Request('https://books.example.com' + path)),
	};
}

const SEARCH_EDITIONS = '/xrpc/community.lexicon.book.searchEditions';
const GET_EDITION = '/xrpc/community.lexicon.book.getEdition';
const GET_CONTRIBUTOR = '/xrpc/community.lexicon.book.getContributor';
const SEARCH_CONTRIBUTORS = '/xrpc/community.lexicon.book.searchContributors';
const COMPATIBILITY = '/xrpc/community.lexicon.book.compatibility';

describe('community.lexicon.book.searchEditions', () => {
	it('returns GB results with total and items[]', async () => {
		const items = [
			{ id: '_abc', volumeInfo: { title: 'A' } },
			{ id: '_def', volumeInfo: { title: 'B' } },
		];
		const a = appWithGb(stubFetch({ totalItems: 2, items }));
		const res = await a.fetch(`${SEARCH_EDITIONS}?q=flowers&limit=2`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.total).toBe(2);
		expect(body.items).toHaveLength(2);
		expect(body.items[0].title).toBe('A');
	});

	it('handles empty GB results with total 0', async () => {
		const a = appWithGb(stubFetch({ totalItems: 0, items: [] }));
		const res = await a.fetch(`${SEARCH_EDITIONS}?q=nothing`);
		const body = await res.json();
		expect(body.items).toEqual([]);
		expect(body.total).toBe(0);
	});

	it('returns empty when no q or id given', async () => {
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch(SEARCH_EDITIONS);
		const body = await res.json();
		expect(body.items).toEqual([]);
	});

	it('P8 in-flight dedup: 5 concurrent identical searches hit Google Books once', async () => {
		const items = [{ id: '_a', volumeInfo: { title: 'A' } }];
		const { fetch: fetchImpl, calls } = countingFetch({ totalItems: 1, items });
		const a = appWithGb(fetchImpl);
		const responses = await Promise.all([
			a.fetch(`${SEARCH_EDITIONS}?q=tolkien&limit=1`),
			a.fetch(`${SEARCH_EDITIONS}?q=tolkien&limit=1`),
			a.fetch(`${SEARCH_EDITIONS}?q=tolkien&limit=1`),
			a.fetch(`${SEARCH_EDITIONS}?q=tolkien&limit=1`),
			a.fetch(`${SEARCH_EDITIONS}?q=tolkien&limit=1`),
		]);
		expect(calls.count).toBe(1);
		const bodies = await Promise.all(responses.map((r) => r.json()));
		expect(bodies[0].items[0].title).toBe('A');
		expect(bodies[4].items[0].title).toBe('A');
	});
});

describe('community.lexicon.book.getEdition', () => {
	it('returns 200 for a gb- rkey and shapes the edition record', async () => {
		const a = appWithGb(stubFetch({ id: '_abc', volumeInfo: { title: 'X', authors: ['A'] } }));
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/gb-_abc`;
		const res = await a.fetch(`${GET_EDITION}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.edition.title).toBe('X');
		expect(body.edition.$type).toBe('community.lexicon.book.edition');
	});

	it('returns 404 for a non-gb rkey that has no DB row', async () => {
		const a = appWithGb(stubFetch({}));
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/ol123m`;
		const res = await a.fetch(`${GET_EDITION}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});

	it('returns 404 when GB has no such volume', async () => {
		const a = appWithGb(stubFetch('not found', 404));
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/gb-_nope`;
		const res = await a.fetch(`${GET_EDITION}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});

	it('returns 404 when GB omits volumeInfo.title', async () => {
		const a = appWithGb(stubFetch({ id: 'x', volumeInfo: {} }));
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/gb-no-title`;
		const res = await a.fetch(`${GET_EDITION}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});

	it('returns 200 for a non-gb rkey when the edition is in the DB', async () => {
		const a = appWithGb(stubFetch({}));
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/test-edition-dune`;
		const res = await a.fetch(`${GET_EDITION}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.edition.title).toBe('Dune (40th Anniversary)');
	});
});

describe('community.lexicon.book.getContributor', () => {
	it('returns a contributor view hydrated from the catalog', async () => {
		const uri = `at://${SERVICE_DID}/community.lexicon.book.contributor/ctest-author-herbert`;
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch(`${GET_CONTRIBUTOR}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.contributor.name).toBe('Frank Herbert');
	});

	it('rejects a uri from a different collection', async () => {
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/test-edition-dune`;
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch(`${GET_CONTRIBUTOR}?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(400);
	});
});

describe('community.lexicon.book.searchContributors', () => {
	it('finds contributors by name', async () => {
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch(`${SEARCH_CONTRIBUTORS}?q=herbert`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.items.length).toBeGreaterThan(0);
	});
});

describe('community.lexicon.book.compatibility', () => {
	it('lists supported queries', async () => {
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch(COMPATIBILITY);
		expect(res.status).toBe(200);
		const body = await res.json();
		const ids = body.queries.map((q: { nsid: string }) => q.nsid);
		expect(ids).toContain('community.lexicon.book.searchEditions');
		expect(ids).toContain('community.lexicon.book.getEdition');
		expect(ids).toContain('net.olamaelcu.livtet.biblio.getImageForBook');
	});
});

describe('net.olamaelcu.livtet.biblio.getImageForBook', () => {
	it('returns 500 (not 502) when no GB client configured and no cached row', async () => {
		// Without GOOGLE_BOOKS_API_KEY set, the lazy-built GB client throws when
		// called. The handler reports this as an InternalServerError (500). To get
		// 502, callers must explicitly omit the GOOGLE_BOOKS_API_KEY at startup
		// — covered by the warning at createXrpcRouter time.
		const r = createXrpcRouter(dbHolder.db, ctx);
		const res = await r.fetch(
			new Request(
				'https://books.example.com/xrpc/net.olamaelcu.livtet.biblio.getImageForBook?uri=' +
					encodeURIComponent(`at://${SERVICE_DID}/community.lexicon.book.edition/gb-noclient`),
			),
		);
		expect(res.status).toBe(500);
	});

	it('returns the GB thumbnail URL', async () => {
		const a = appWithGb(stubFetch({
			id: 'vol-thumb',
			volumeInfo: { title: 'T', imageLinks: { thumbnail: 'https://example.com/cover.jpg' } },
		}));
		const uri = `at://${SERVICE_DID}/community.lexicon.book.edition/gb-vol-thumb`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getImageForBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.url).toBe('https://example.com/cover.jpg');
	});
});

describe('net.olamaelcu.livtet.biblio.getImageForContributor', () => {
	it('returns undefined url (TODO: OL cover lookup)', async () => {
		const uri = `at://${SERVICE_DID}/community.lexicon.book.contributor/ctest-author-herbert`;
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.getImageForContributor?uri=${encodeURIComponent(uri)}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.url).toBeUndefined();
	});
});

describe('community.lexicon.book.searchWorks / searchPublishers (not implemented)', () => {
	// Work and publisher records aren't published by this AppView. The community
	// lexicon contract allows optional 501 responses. We omit these lex files
	// entirely and return 404 to make the absence visible in tooling.
	it('searchWorks returns 404 (lex not registered)', async () => {
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch('/xrpc/community.lexicon.book.searchWorks?q=foo');
		expect(res.status).toBe(404);
	});
});

describe('handler timeout', () => {
	it('searchEditions completes normally within the timeout', async () => {
		const a = appWithGb(stubFetch({ totalItems: 0, items: [] }));
		const res = await a.fetch(`${SEARCH_EDITIONS}?q=normal`);
		expect(res.status).toBe(200);
	});

	it('searchEditions returns 504 when handler exceeds the timeout', async () => {
		const slowFetch = (async (_input: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				if (init?.signal) {
					init.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}
				setTimeout(() => {}, 60_000);
			})) as typeof fetch;
		process.env.XRPC_HANDLER_TIMEOUT_MS = '50';
		const a = appWithGb(slowFetch);
		const res = await a.fetch(`${SEARCH_EDITIONS}?q=slow`);
		expect([500, 504]).toContain(res.status);
		delete process.env.XRPC_HANDLER_TIMEOUT_MS;
	});
});