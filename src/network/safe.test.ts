import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeFetchJson } from './safe.js';

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }));

describe('safeFetchJson', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns the parsed JSON body on a 2xx response', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true, n: 7 }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);

		const result = await safeFetchJson<{ ok: boolean; n: number }>('https://example.com/data');
		expect(result).toEqual({ ok: true, n: 7 });
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
	});

	it('returns the parsed JSON body on a 201 response', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ created: true }), { status: 201 }),
		);
		const result = await safeFetchJson<{ created: boolean }>('https://example.com/data');
		expect(result).toEqual({ created: true });
	});

	it('returns null on a non-2xx response', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
		);
		const result = await safeFetchJson('https://example.com/down');
		expect(result).toBeNull();
	});

	it('returns null on a 404', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 404 }));
		const result = await safeFetchJson('https://example.com/missing');
		expect(result).toBeNull();
	});

	it('returns null when the network request rejects', async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network down'));
		const result = await safeFetchJson('https://example.com/unreachable');
		expect(result).toBeNull();
	});

	it('returns null when the body is not valid JSON', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response('not json at all', { status: 200 }),
		);
		const result = await safeFetchJson('https://example.com/garbage');
		expect(result).toBeNull();
	});

	it('returns null when the request times out', async () => {
		vi.mocked(fetch).mockImplementationOnce(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				}),
		);

		const result = await safeFetchJson('https://example.com/slow', { timeoutMs: 50 });
		expect(result).toBeNull();
	});

	it('uses GET by default and forwards headers', async () => {
		const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
		);
		await safeFetchJson('https://example.com/x', { headers: { 'x-test': 'yes' } });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://example.com/x');
		expect(init.method).toBe('GET');
		expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
		expect((init.headers as Record<string, string>)['x-test']).toBe('yes');
	});
});