import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { mergeEntity } from './merge.js';
import { openIssuesFor } from './issues.js';

describe('mergeEntity', () => {
	it('inserts new record as staged with identifiers', () => {
		const { db, seed } = createTestDb();
		seed();
		const res = mergeEntity(db, {
			entityType: 'book',
			pk: 'books/olnew',
			source: 'openlibrary',
			matchName: 'Some New Book',
			identifiers: [{ resource: 'isbn:9781111111111', url: 'https://ol/x' }],
			fields: { title: 'Some New Book', description: 'fresh' },
		});
		expect(res.existed).toBe(false);
		expect(res.pk).toBe('books/olnew');
	});

	it('merges onto existing record by identifier and flags conflict', () => {
		const { db, seed } = createTestDb();
		seed();
		// book-dune exists with title 'Dune (40th Anniversary)' and isbn:0441172717
		const res = mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol123m',
			source: 'openlibrary',
			matchName: 'Dune',
			identifiers: [{ resource: 'isbn:0441172717', url: 'https://ol/0441172717' }],
			fields: { title: 'Dune', description: 'The classic' },
		});
		expect(res.existed).toBe(true);
		expect(res.pk).toBe('book-dune');
		expect(res.conflictFields).toContain('title');

		const issues = openIssuesFor(db, 'book', 'book-dune');
		expect(issues.some((i) => i.field === 'title' && i.incomingValue === 'Dune')).toBe(true);
	});

	it('unions identifiers on merge', async () => {
		const { db, seed } = createTestDb();
		seed();
		mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol123m',
			source: 'bookhive',
			matchName: 'Dune (40th Anniversary)',
			identifiers: [{ resource: 'hiveId:abc123', url: 'https://hive/abc123' }],
			fields: { title: 'Dune (40th Anniversary)' },
		});
		// hiveId now resolves to book-dune
		const { bookIdentifiersAdapter } = await import('./identifiers.js');
		expect(bookIdentifiersAdapter.findByResource(db, 'hiveId:abc123')).toBe('book-dune');
	});
});
