import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheClear } from './cache.js';
import { CONSTELLATION_URL } from './config.js';
import { getEngagementForSubject } from './constellation.js';

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }));

describe('getEngagementForSubject', () => {
	beforeEach(() => {
		cacheClear();
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mockJsonResponses(...bodies: Array<{ status: number; body: string }>) {
		const fetchMock = vi.mocked(fetch);
		for (const { status, body } of bodies) {
			fetchMock.mockResolvedValueOnce(new Response(body, { status }));
		}
		return fetchMock;
	}

	it('returns likeCount and quoteCount on success', async () => {
		const fetchMock = mockJsonResponses(
			{ status: 200, body: JSON.stringify({ total: 5 }) },
			{ status: 200, body: JSON.stringify({ total: 3 }) },
		);

		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toEqual({ likeCount: 5, quoteCount: 3 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('returns zero counts when both responses report zero', async () => {
		mockJsonResponses(
			{ status: 200, body: JSON.stringify({ total: 0 }) },
			{ status: 200, body: JSON.stringify({ total: 0 }) },
		);
		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toEqual({ likeCount: 0, quoteCount: 0 });
	});

	it('returns undefined when the likes fetch fails (need both signals)', async () => {
		const fetchMock = mockJsonResponses(
			{ status: 503, body: 'down' },
			{ status: 200, body: JSON.stringify({ total: 3 }) },
		);
		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('returns undefined when the quotes fetch fails', async () => {
		mockJsonResponses(
			{ status: 200, body: JSON.stringify({ total: 5 }) },
			{ status: 500, body: 'boom' },
		);
		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toBeUndefined();
	});

	it('returns undefined when both fetches fail', async () => {
		mockJsonResponses(
			{ status: 503, body: 'down' },
			{ status: 503, body: 'down' },
		);
		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toBeUndefined();
	});

	it('returns undefined when either response has invalid JSON', async () => {
		mockJsonResponses(
			{ status: 200, body: '{not-json' },
			{ status: 200, body: JSON.stringify({ total: 3 }) },
		);
		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toBeUndefined();
	});

	it('URL-encodes the subject and includes both sources', async () => {
		const fetchMock = mockJsonResponses(
			{ status: 200, body: JSON.stringify({ total: 1 }) },
			{ status: 200, body: JSON.stringify({ total: 1 }) },
		);
		await getEngagementForSubject('at://did/x/y');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const urls = fetchMock.mock.calls.map((call) => call[0] as string);
		for (const url of urls) {
			expect(url.startsWith(`${CONSTELLATION_URL}/xrpc/blue.microcosm.links.getBacklinksCount`)).toBe(true);
			const parsed = new URL(url);
			expect(parsed.searchParams.get('subject')).toBe('at://did/x/y');
			expect(parsed.searchParams.get('source')).toMatch(
				/^(app\.bsky\.feed\.like:subject|app\.bsky\.feed\.post:embed\.record\.uri)$/,
			);
		}
		const sources = urls
			.map((u) => new URL(u).searchParams.get('source'))
			.sort();
		expect(sources).toEqual([
			'app.bsky.feed.like:subject',
			'app.bsky.feed.post:embed.record.uri',
		]);
	});

	it('caches successful fetches so a second call does not hit the network', async () => {
		const fetchMock = mockJsonResponses(
			{ status: 200, body: JSON.stringify({ total: 5 }) },
			{ status: 200, body: JSON.stringify({ total: 3 }) },
		);

		const first = await getEngagementForSubject('at://did/x/y');
		expect(first).toEqual({ likeCount: 5, quoteCount: 3 });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const second = await getEngagementForSubject('at://did/x/y');
		expect(second).toEqual({ likeCount: 5, quoteCount: 3 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('returns undefined on a network rejection', async () => {
		vi.mocked(fetch)
			.mockRejectedValueOnce(new TypeError('network down'))
			.mockRejectedValueOnce(new TypeError('network down'));
		const result = await getEngagementForSubject('at://did/x/y');
		expect(result).toBeUndefined();
	});
});