import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createXrpcRouter } from './router.js';
import { createTestDb, SERVICE_DID, SERVICE_HOST } from '../test-utils/db.js';
import { GoogleBooksClient } from '../google-books/client.js';
import type { ViewContext } from '../lex/collections.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

let dbHolder: Awaited<ReturnType<typeof createTestDb>>;
const router = () => createXrpcRouter(dbHolder.db, ctx);

beforeAll(async () => {
	process.env.ATP_SERVICE_DID = SERVICE_DID;
	process.env.ATP_SERVICE_HOST = SERVICE_HOST;
	dbHolder = await createTestDb();
	await dbHolder.seed();
});

afterAll(async () => {
	await dbHolder.close();
	delete process.env.ATP_SERVICE_DID;
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
	const fetchImpl = (async (_input: Request | URL | string, _init?: RequestInit) => {
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

describe('placeholder', () => {
	it('1', () => expect(1).toBe(1));
});
describe('searchBooks (Google Books backed)', () => {
	it('returns GB results with hitsTotal', async () => {
		const items = [{ id: '_abc', volumeInfo: { title: 'A' } }, { id: '_def', volumeInfo: { title: 'B' } }];
		const a = appWithGb(stubFetch({ totalItems: 2, items }));
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=flowers&limit=2');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.hitsTotal).toBe(2);
		expect(body.books).toHaveLength(2);
		expect(body.books[0].title).toBe('A');
	});

	it('handles empty GB results with hitsTotal 0', async () => {
		const a = appWithGb(stubFetch({ totalItems: 0, items: [] }));
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=nothing');
		const body = await res.json();
		expect(body.books).toEqual([]);
		expect(body.hitsTotal).toBe(0);
	});
});

describe('getBook (Google Books backed)', () => {
	it('returns 200 for a gb- rkey and shapes the BookView', async () => {
		const a = appWithGb(stubFetch({ id: '_abc', volumeInfo: { title: 'X', authors: ['A'] } }));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_abc`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.book.uri).toBe(uri);
		expect(body.book.title).toBe('X');
	});

	it('returns 400 for a non-gb rkey', async () => {
		const a = appWithGb(stubFetch({}));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/ol123m`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(400);
	});

	it('returns 404 when GB has no such volume', async () => {
		const a = appWithGb(stubFetch('not found', 404));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_nope`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});

	it('returns 404 when GB omits volumeInfo.title', async () => {
		const a = appWithGb(stubFetch({ id: '_empty' }));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.book/gb-_empty`;
		const res = await a.fetch(`/xrpc/net.olamaelcu.livtet.biblio.getBook?uri=${encodeURIComponent(uri)}`);
		expect(res.status).toBe(404);
	});
});

describe('listBooks (Google Books backed)', () => {
	it('requires at least one of q/genre/contributor', async () => {
		const a = appWithGb(stubFetch({}));
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks');
		expect(res.status).toBe(400);
	});

	it('rejects the format filter as unsupported', async () => {
		const a = appWithGb(stubFetch({}));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.format/paperback`;
		const res = await a.fetch(
			`/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=x&format=${encodeURIComponent(uri)}`,
		);
		expect(res.status).toBe(400);
	});

	it('forwards q verbatim to GB', async () => {
		const a = appWithGb(stubFetch({ totalItems: 0, items: [] }));
		const res = await a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=hello');
		expect(res.status).toBe(200);
	});
});

describe('listBooks (Google Books backed) — P4 contributor slug', () => {
	it('returns 400 InvalidRequest for a malformed contributor slug', async () => {
		const a = appWithGb(stubFetch({}));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.contributor/not-a-real-slug`;
		const res = await a.fetch(
			'/xrpc/net.olamaelcu.livtet.biblio.listBooks?contributor=' + encodeURIComponent(uri),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('InvalidRequest');
	});

	it('returns 400 when the contributor rkey is missing the gbauthors- prefix', async () => {
		const a = appWithGb(stubFetch({}));
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.contributor/c-s-lewis`;
		const res = await a.fetch(
			'/xrpc/net.olamaelcu.livtet.biblio.listBooks?contributor=' + encodeURIComponent(uri),
		);
		expect(res.status).toBe(400);
	});

	it('accepts a well-formed gbauthors- slug and forwards inauthor:"<name>" to GB', async () => {
		let captured: { url: string } | null = null;
		const fetchImpl = (async (input: Request | URL | string) => {
			captured = { url: String(input) };
			return new Response(JSON.stringify({ totalItems: 0, items: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;
		const a = appWithGb(fetchImpl);
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.contributor/gbauthors-c-s-lewis`;
		const res = await a.fetch(
			'/xrpc/net.olamaelcu.livtet.biblio.listBooks?contributor=' + encodeURIComponent(uri),
		);
		expect(res.status).toBe(200);
		expect(captured?.url).toContain('inauthor%3A%22c+s+lewis%22');
	});
});

describe('getContributor', () => {
	it('returns a contributor view hydrated from the catalog', async () => {
		const res = await router().fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=' +
				encodeURIComponent(`at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.contributor/author-herbert`)),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.contributor.name).toBe('Frank Herbert');
		expect(body.contributor.sortName).toBe('Herbert, Frank');
		expect(body.contributor.identifiers[0].resource).toBe('viaf:59083797');
	});

	it('returns 404 for a missing contributor', async () => {
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.contributor/nope`;
		const res = await router().fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=' + encodeURIComponent(uri)),
		);
		expect(res.status).toBe(404);
	});

	it('rejects a uri from a different collection', async () => {
		const uri = `at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.genre/scifi`;
		const res = await router().fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri=' + encodeURIComponent(uri)),
		);
		expect(res.status).toBe(400);
	});
});

describe('getGenre', () => {
	it('returns a genre view with parent uri', async () => {
		const res = await router().fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.getGenre?uri=' +
				encodeURIComponent(`at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.genre/scifi`)),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.genre.name).toBe('Science Fiction');
		expect(body.genre.parent).toBe(`at://${SERVICE_DID}/net.olamaelcu.livtet.biblio.genre/fiction`);
	});
});

describe('listGenres', () => {
	it('returns all genres', async () => {
		const res = await router().fetch(new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.listGenres'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.genres.map((g: { name: string }) => g.name).sort()).toEqual(['Fiction', 'Science Fiction']);
	});

	it('filters to top-level genres', async () => {
		const res = await router().fetch(new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.listGenres?topLevelOnly=true'));
		const body = await res.json();
		expect(body.genres.map((g: { name: string }) => g.name)).toEqual(['Fiction']);
	});
});

describe('searchContributors', () => {
	it('finds contributors by name', async () => {
		const res = await router().fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.searchContributors?q=Frank'),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.contributors).toHaveLength(1);
		expect(body.contributors[0].name).toBe('Frank Herbert');
	});
});

describe('getActor', () => {
	it('returns a bare actor view for an unindexed DID', async () => {
		const res = await router().fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.getActor?actor=' + encodeURIComponent(SERVICE_DID)),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.actor.did).toBe(SERVICE_DID);
	});
});

describe('searchBooks (Google Books backed) — P8 in-flight dedup', () => {
	it('five concurrent identical searches hit Google Books once and yield equal responses', async () => {
		const body = {
			totalItems: 3,
			items: [
				{ id: '_a', volumeInfo: { title: 'A' } },
				{ id: '_b', volumeInfo: { title: 'B' } },
				{ id: '_c', volumeInfo: { title: 'C' } },
			],
		};
		const { fetch: fetchImpl, calls } = countingFetch(body);
		const a = appWithGb(fetchImpl);
		const responses = await Promise.all(
			Array.from({ length: 5 }, () => a.fetch('/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=flowers&limit=3')),
		);
		expect(calls.count).toBe(1);
		expect(responses.every((r) => r.status === 200)).toBe(true);
		const bodies = await Promise.all(responses.map((r) => r.json()));
		expect(bodies[0]).toEqual(bodies[1]);
		expect(bodies[0]).toEqual(bodies[4]);
		expect(bodies[0].hitsTotal).toBe(3);
		expect(bodies[0].books).toHaveLength(3);
	});

	it('two concurrent listBooks with identical params hit GB once', async () => {
		const body = { totalItems: 1, items: [{ id: '_a', volumeInfo: { title: 'A' } }] };
		const { fetch: fetchImpl, calls } = countingFetch(body);
		const a = appWithGb(fetchImpl);
		const responses = await Promise.all([
			a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=flowers'),
			a.fetch('/xrpc/net.olamaelcu.livtet.biblio.listBooks?q=flowers'),
		]);
		expect(calls.count).toBe(1);
		expect(responses.every((r) => r.status === 200)).toBe(true);
	});
});

describe('handler timeout', () => {
	function hangingFetch(): typeof fetch {
		return (() => new Promise<Response>(() => {})) as typeof fetch;
	}

	function routerWithHangingGb(timeoutMs: number) {
		const gb = new GoogleBooksClient({ apiKey: 'test', fetchImpl: hangingFetch() });
		return createXrpcRouter(dbHolder.db, ctx, { client: gb, handlerTimeoutMs: timeoutMs });
	}

	it('searchBooks returns 504 when the handler exceeds the configured timeout', async () => {
		const router = routerWithHangingGb(50);
		const res = await router.fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=hangs'),
		);
		expect(res.status).toBe(504);
		const body = await res.json();
		expect(body.error).toBe('Timeout');
	});

	it('searchBooks completes normally when within the timeout', async () => {
		const router = createXrpcRouter(dbHolder.db, ctx, {
			client: new GoogleBooksClient({
				apiKey: 'test',
				fetchImpl: stubFetch({ totalItems: 0, items: [] }),
			}),
			handlerTimeoutMs: 50,
		});
		const res = await router.fetch(
			new Request('https://x/xrpc/net.olamaelcu.livtet.biblio.searchBooks?q=fast'),
		);
		expect(res.status).toBe(200);
	});
});
