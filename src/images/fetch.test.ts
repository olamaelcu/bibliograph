import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { BlobStore } from '../storage/store.js';
import { fetchBookCover, fetchContributorPortrait } from './fetch.js';

describe('images', () => {
	it('stores a cover from OL and returns its URL', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), {
					status: 200,
					headers: { 'content-type': 'image/jpeg' },
				}),
			),
		);
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory', publicBaseUrl: 'https://cdn.example.com' });
		const res = await fetchBookCover(db, store, 'book-dune', 12345);
		expect(res.fetched).toBe(true);
		expect(res.url).toContain('catalog/book/book-dune/cover-');
		vi.unstubAllGlobals();
	});

	it('flags an issue when cover fetch fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory' });
		const res = await fetchBookCover(db, store, 'book-dune', 99999);
		expect(res.fetched).toBe(false);
		vi.unstubAllGlobals();
	});

	it('falls back to Wikipedia when OL has no photo', async () => {
		const olRes = new Response('nope', { status: 404 });
		const wikiJson = new Response(
			JSON.stringify({ thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/8/89/Frank_Herbert.jpg' } }),
			{ status: 200 },
		);
		const imgRes = new Response(new Blob([new Uint8Array([9, 8, 7])], { type: 'image/jpeg' }), {
			status: 200,
			headers: { 'content-type': 'image/jpeg' },
		});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olRes).mockResolvedValueOnce(wikiJson).mockResolvedValueOnce(imgRes));
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory', publicBaseUrl: 'https://cdn.example.com' });
		const res = await fetchContributorPortrait(db, store, 'author-herbert', 'Frank Herbert', 99999);
		expect(res.fetched).toBe(true);
		expect(res.url).toContain('catalog/contributor/author-herbert/portrait-');
		vi.unstubAllGlobals();
	});
});
