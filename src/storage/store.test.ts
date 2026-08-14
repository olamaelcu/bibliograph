import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { BlobStore } from './store.js';

describe('BlobStore (memory scheme)', () => {
	it('put/get/delete roundtrip with catalog_blobs row', async () => {
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 'memory', publicBaseUrl: 'https://cdn.example.com' });
		const bytes = new TextEncoder().encode('fake-jpeg-bytes');
		const blob = await store.put({
			entityType: 'book',
			entityPk: 'book-dune',
			kind: 'cover',
			bytes,
			mimeType: 'image/jpeg',
			source: 'openlibrary',
		});
		expect(blob.url).toContain('catalog/book/book-dune/cover-');
		const fetched = await store.get(blob.objectKey);
		expect(new TextDecoder().decode(fetched)).toBe('fake-jpeg-bytes');

		await store.delete('book', 'book-dune', 'cover');
		await expect(store.get(blob.objectKey)).rejects.toThrow();
	});

	it('constructs without throwing when s3 scheme has no bucket (falls back to memory)', async () => {
		const { db } = createTestDb();
		const store = new BlobStore(db, { scheme: 's3' });
		const bytes = new TextEncoder().encode('fake-cover-bytes');
		const blob = await store.put({
			entityType: 'book',
			entityPk: 'book-dune',
			kind: 'cover',
			bytes,
			mimeType: 'image/jpeg',
			source: 'openlibrary',
		});
		const fetched = await store.get(blob.objectKey);
		expect(new TextDecoder().decode(fetched)).toBe('fake-cover-bytes');
	});

	it('constructs without throwing when scheme is unset and no bucket is given', () => {
		const { db } = createTestDb();
		expect(() => new BlobStore(db, {})).not.toThrow();
	});
});
