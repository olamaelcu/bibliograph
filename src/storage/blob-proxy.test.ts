import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { BlobStore } from './store.js';
import { registerBlobProxy } from './blob-proxy.js';
import { books, catalogBlobs } from '../db/schema.js';

function makeApp(
	db: ReturnType<typeof createTestDb>['db'],
	store: { get: (key: string) => Promise<Uint8Array> },
): Hono {
	const app = new Hono();
	registerBlobProxy(app, db, store);
	return app;
}

async function putCover(
	db: ReturnType<typeof createTestDb>['db'],
	store: BlobStore,
): Promise<string> {
	const bytes = new TextEncoder().encode('fake-cover-bytes');
	const blob = await store.put({
		entityType: 'book',
		entityPk: 'book-dune',
		kind: 'cover',
		bytes,
		mimeType: 'image/jpeg',
		source: 'openlibrary',
	});
	return blob.objectKey;
}

describe('blob proxy', () => {
	it('serves a released book cover with content-type and cache headers', async () => {
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory' });
		const app = makeApp(db, store);
		const objectKey = await putCover(db, store);

		const res = await app.request(`/catalog-blobs/${objectKey}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/jpeg');
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('fake-cover-bytes');
	});

	it('returns 404 when the entity is not released', async () => {
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory' });
		const app = makeApp(db, store);
		const objectKey = await putCover(db, store);
		db.update(books).set({ releaseStatus: 'staged' }).where(eq(books.pk, 'book-dune')).run();

		const res = await app.request(`/catalog-blobs/${objectKey}`);
		expect(res.status).toBe(404);
	});

	it('returns 404 for an unknown object key', async () => {
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory' });
		const app = makeApp(db, store);

		const res = await app.request('/catalog-blobs/catalog/book/book-dune/cover-nope');
		expect(res.status).toBe(404);
	});

	it('returns 404 when the store read fails', async () => {
		const { db, seed } = createTestDb();
		seed();
		const store = new BlobStore(db, { scheme: 'memory' });
		const objectKey = await putCover(db, store);
		const app = makeApp(db, { get: () => Promise.reject(new Error('storage down')) });

		const res = await app.request(`/catalog-blobs/${objectKey}`);
		expect(res.status).toBe(404);
	});

	it('returns 404 for an unknown entityType even when a contributor row matches', async () => {
		const { db, seed } = createTestDb();
		seed();
		// entityType 'work' is not a blob owner; entityPk deliberately matches a released
		// contributor so a naive fallback-to-contributors lookup would wrongly authorize it.
		const objectKey = 'catalog/work/author-herbert/cover-abc123';
		db.insert(catalogBlobs)
			.values({
				pk: 'work:author-herbert:cover',
				entityType: 'work',
				entityPk: 'author-herbert',
				kind: 'cover',
				cid: 'abc123',
				mimeType: 'image/jpeg',
				size: 3,
				objectKey,
				source: 'openlibrary',
				createdAt: Math.floor(Date.now() / 1000),
			})
			.run();
		const app = makeApp(db, { get: async () => new Uint8Array([1, 2, 3]) });

		const res = await app.request(`/catalog-blobs/${objectKey}`);
		expect(res.status).toBe(404);
	});
});
