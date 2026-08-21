import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleBooksClient, GoogleBooksError } from './client.js';

const KEY = 'test-key';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fakeFetch(impl: Parameters<typeof fetch>[1] extends infer R ? (input: Request | URL | string, init?: R) => Promise<Response> : never) {
	return vi.fn(impl) as unknown as typeof fetch;
}

describe('GoogleBooksClient', () => {
	it('throws on first fetch when constructed without an api key', async () => {
		const client = new GoogleBooksClient({ apiKey: '' });
		await expect(client.getVolume('x')).rejects.toThrow(/GOOGLE_BOOKS_API_KEY/);
	});

	describe('searchVolumes', () => {
		it('hits the GB endpoint with q/maxResults/startIndex/key/fields, sends User-Agent, and parses items/totalItems', async () => {
			let captured: { url: string; headers: Record<string, string> } | null = null;
			const fetchImpl = fakeFetch(async (input, init) => {
				captured = { url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) };
				return new Response(
					JSON.stringify({
						totalItems: 17,
						items: [{ id: '_abc', volumeInfo: { title: 'A' } }, { id: '_def', volumeInfo: { title: 'B' } }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			});
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			const res = await client.searchVolumes('flowers', { startIndex: 20, maxResults: 10 });
			expect(res.totalItems).toBe(17);
			expect(res.items?.map((v) => v.id)).toEqual(['_abc', '_def']);
			expect(captured?.url).toContain('https://www.googleapis.com/books/v1/volumes');
			expect(captured?.url).toContain('q=flowers');
			expect(captured?.url).toContain('startIndex=20');
			expect(captured?.url).toContain('maxResults=10');
			expect(captured?.url).toContain('key=' + KEY);
			expect(captured?.url).toMatch(/[?&]fields=items/);
			expect(captured?.url).toContain('volumeInfo');
			expect(captured?.headers['accept']).toBe('application/json');
			expect(captured?.headers['user-agent']).toContain('gzip');
		});

		it('caps maxResults at GB\'s 40 limit', async () => {
			const fetchImpl = fakeFetch(async () => new Response('{"totalItems":0}', { status: 200 }));
			let url = '';
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
				url = String(input);
				return new Response('{"totalItems":0}', { status: 200 });
			});
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl: globalThis.fetch });
			await client.searchVolumes('q', { maxResults: 999 });
			expect(url).toContain('maxResults=40');
		});
	});

	describe('getVolume', () => {
		it('returns the volume on success', async () => {
			const fetchImpl = fakeFetch(async () =>
				new Response(JSON.stringify({ id: '_abc', volumeInfo: { title: 'A' } }), { status: 200 }),
			);
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			const v = await client.getVolume('_abc');
			expect(v?.id).toBe('_abc');
			expect(v?.volumeInfo?.title).toBe('A');
		});

		it('requests partial-response fields=id,volumeInfo(...) for a single volume', async () => {
			let url = '';
			const fetchImpl = fakeFetch(async (input) => {
				url = String(input);
				return new Response(JSON.stringify({ id: '_abc' }), { status: 200 });
			});
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			await client.getVolume('_abc');
			expect(url).toContain('/volumes/_abc');
			expect(url).toContain('fields=');
			expect(url).toContain('id,volumeInfo');
			expect(url).toContain('title');
		});

		it('returns undefined on 404', async () => {
			const fetchImpl = fakeFetch(async () => new Response('not found', { status: 404 }));
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			expect(await client.getVolume('_nope')).toBeUndefined();
		});

		it('encodes the volumeId in the path', async () => {
			let url = '';
			const fetchImpl = fakeFetch(async (input) => {
				url = String(input);
				return new Response('{"totalItems":0}', { status: 200 });
			});
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			await client.getVolume('a/b_c');
			expect(url).toContain('/volumes/a%2Fb_c');
		});

		it('surfaces non-404 errors as GoogleBooksError', async () => {
			const fetchImpl = fakeFetch(async () => new Response('rate limited', { status: 429 }));
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			await expect(client.getVolume('x')).rejects.toBeInstanceOf(GoogleBooksError);
		});
	});

	describe('429 retry behavior', () => {
		it('respects Retry-After: 2 and retries after ~2 seconds', async () => {
			const callTimes: number[] = [];
			const fetchImpl = fakeFetch(async () => {
				callTimes.push(Date.now());
				if (callTimes.length === 1) {
					return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } });
				}
				return new Response(JSON.stringify({ id: '_abc', volumeInfo: { title: 'A' } }), { status: 200 });
			});
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			const v = await client.getVolume('_abc');
			expect(v?.id).toBe('_abc');
			expect(callTimes.length).toBe(2);
			expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(2000);
		});

		it('falls back to exponential backoff (≤4s per sleep) for 429 without Retry-After', async () => {
			let callCount = 0;
			const fetchImpl = fakeFetch(async () => {
				callCount++;
				return new Response('rate limited', { status: 429 });
			});
			const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
			await expect(client.getVolume('x')).rejects.toBeInstanceOf(GoogleBooksError);
			// 429 is retried up to DEFAULT_ATTEMPTS times before propagating
			expect(callCount).toBe(3);
		});

		it('caps Retry-After larger than 60s at 60s', async () => {
			vi.useFakeTimers();
			try {
				let callCount = 0;
				const fetchImpl = fakeFetch(async () => {
					callCount++;
					if (callCount === 1) {
						return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
					}
					return new Response(JSON.stringify({ id: '_abc' }), { status: 200 });
				});
				const client = new GoogleBooksClient({ apiKey: KEY, fetchImpl });
				const promise = client.getVolume('_abc');
				// Advance just past the 60s cap. If the cap were not applied (delay = 120s),
				// the second fetch would not have happened yet.
				await vi.advanceTimersByTimeAsync(60_500);
				const v = await promise;
				expect(v?.id).toBe('_abc');
				expect(callCount).toBe(2);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
