import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { BlobStore } from '../storage/store.js';
import { fetchBookCover, fetchContributorPortrait } from './fetch.js';
import { catalogBlobs, importIssues } from '../db/schema.js';

const MAX_BYTES = 10 * 1024 * 1024;

describe('images', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory', publicBaseUrl: 'https://cdn.example.com' });
		const res = await fetchBookCover(db, store, 'book-dune', 12345);
		expect(res.fetched).toBe(true);
		expect(res.url).toContain('catalog/book/book-dune/cover-');
	});

	it('accepts a content-type with parameters', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'content-type': 'image/jpeg; charset=binary' },
				}),
			),
		);
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory' });
		const res = await fetchBookCover(db, store, 'book-dune', 12345);
		expect(res.fetched).toBe(true);
	});

	it('flags an issue with the expected row when cover fetch fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory' });
		const res = await fetchBookCover(db, store, 'book-dune', 99999);
		expect(res.fetched).toBe(false);

		const issue = db.select().from(importIssues).get();
		expect(issue).toMatchObject({
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'coverUrl',
			source: 'openlibrary',
			status: 'open',
		});
	});

	it('returns fetched:false and does not fetch or write when olCoverId is null', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory' });
		const res = await fetchBookCover(db, store, 'book-dune', undefined);
		expect(res).toEqual({ kind: 'cover', fetched: false, url: null });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(db.select().from(catalogBlobs).all()).toHaveLength(0);
	});

	it('rejects an oversized content-length before reading the body', async () => {
		const res = new Response(new Uint8Array([1, 2, 3]), {
			status: 200,
			headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_BYTES + 1) },
		});
		const arrayBufferSpy = vi.spyOn(res, 'arrayBuffer');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory' });
		const result = await fetchBookCover(db, store, 'book-dune', 12345);
		expect(result.fetched).toBe(false);
		expect(arrayBufferSpy).not.toHaveBeenCalled();
	});

	it('rejects a body larger than MAX_BYTES when content-length is absent', async () => {
		const big = new Uint8Array(MAX_BYTES + 1);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(big, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
			),
		);
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory' });
		const result = await fetchBookCover(db, store, 'book-dune', 12345);
		expect(result.fetched).toBe(false);
		expect(db.select().from(catalogBlobs).all()).toHaveLength(0);
	});

	it('rejects a content-type that merely contains an allowed type', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'content-type': 'x-image/jpegx' },
				}),
			),
		);
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory' });
		const result = await fetchBookCover(db, store, 'book-dune', 12345);
		expect(result.fetched).toBe(false);
		expect(db.select().from(catalogBlobs).all()).toHaveLength(0);
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
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory', publicBaseUrl: 'https://cdn.example.com' });
		const res = await fetchContributorPortrait(db, store, 'author-herbert', 'Frank Herbert', 99999);
		expect(res.fetched).toBe(true);
		expect(res.url).toContain('catalog/contributor/author-herbert/portrait-');
	});
});
