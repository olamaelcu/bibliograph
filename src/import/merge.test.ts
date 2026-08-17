import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../logger.js';
import { mergeEntity } from './merge.js';
import { openIssuesFor } from './issues.js';
import { bookIdentifiersAdapter } from './identifiers.js';

describe('mergeEntity', () => {
	it('inserts new record as staged with identifiers', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const res = await mergeEntity(db, {
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

	it('forces new records to staged even when fields include releaseStatus', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/olnew',
			source: 'openlibrary',
			matchName: null,
			identifiers: [],
			fields: { title: 'Some New Book', releaseStatus: 'released' },
		});
		const result = await db.execute(sql`SELECT release_status AS rs FROM books WHERE pk = ${'books/olnew'}`);
		const row = result.rows[0] as { rs: string };
		expect(row.rs).toBe('staged');
	});

	it('merges onto existing record by identifier and flags conflict', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		// book-dune exists with title 'Dune (40th Anniversary)' and isbn:0441172717
		const res = await mergeEntity(db, {
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

		const issues = await openIssuesFor(db, 'book', 'book-dune');
		expect(issues.some((i) => i.field === 'title' && i.incomingValue === 'Dune')).toBe(true);
	});

	it('unions identifiers on merge', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol123m',
			source: 'bookhive',
			matchName: 'Dune (40th Anniversary)',
			identifiers: [{ resource: 'hiveId:abc123', url: 'https://hive/abc123' }],
			fields: { title: 'Dune (40th Anniversary)' },
		});
		// hiveId now resolves to book-dune
		expect(await bookIdentifiersAdapter.findByResource(db, 'hiveId:abc123')).toBe('book-dune');
	});

	it('merges a contributor via case-insensitive name fallback without spurious name conflict', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const res = await mergeEntity(db, {
			entityType: 'contributor',
			pk: 'contributors/new',
			source: 'bookhive',
			matchName: 'frank herbert',
			identifiers: [],
			fields: { name: 'Frank Herbert', bio: 'A master of sci-fi' },
		});
		expect(res.existed).toBe(true);
		expect(res.pk).toBe('author-herbert');
		expect(res.conflictFields).not.toContain('name');
		expect(res.conflictFields).toContain('bio');
	});

	it('flags ambiguous fallback when two records share matchName and stays staged', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		// two seeded records with the same title, via matchName:null so neither merges
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ambig-a',
			source: 'openlibrary',
			matchName: null,
			identifiers: [],
			fields: { title: 'The Ambiguous Book' },
		});
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ambig-b',
			source: 'openlibrary',
			matchName: null,
			identifiers: [],
			fields: { title: 'The Ambiguous Book' },
		});
		const res = await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ambig-c',
			source: 'bookhive',
			matchName: 'the ambiguous book',
			identifiers: [],
			fields: { title: 'The Ambiguous Book' },
		});
		expect(res.existed).toBe(false);
		expect(res.pk).toBe('books/ambig-c');
		const issues = await openIssuesFor(db, 'book', 'books/ambig-c');
		expect(issues.some((i) => i.field === 'matchName')).toBe(true);
		const result = await db.execute(sql`SELECT release_status AS rs FROM books WHERE pk = ${'books/ambig-c'}`);
		const row = result.rows[0] as { rs: string };
		expect(row.rs).toBe('staged');
	});

	it('re-importing the same candidate is idempotent', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const candidate = {
			entityType: 'book' as const,
			pk: 'books/olnew',
			source: 'openlibrary',
			matchName: 'Some New Book',
			identifiers: [{ resource: 'isbn:9789999999999', url: 'https://ol/x' }],
			fields: { title: 'Some New Book', description: 'fresh' },
		};
		await mergeEntity(db, candidate);
		await mergeEntity(db, candidate);
		const bookCount = (await db.execute(sql`SELECT count(*) AS c FROM books`)).rows[0] as { c: string };
		expect(bookCount.c).toBe('3'); // 2 seed + 1 candidate
		const idCount = (await db.execute(sql`SELECT count(*) AS c FROM book_identifiers`)).rows[0] as { c: string };
		expect(idCount.c).toBe('2'); // 1 seed + 1 candidate
		expect(await openIssuesFor(db, 'book', 'books/olnew')).toHaveLength(0);
	});

	it('flags a slug collision when candidate pk already exists but identifiers point elsewhere', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const res = await mergeEntity(db, {
			entityType: 'book',
			pk: 'book-dune',
			source: 'bookhive',
			matchName: 'Completely Unrelated Title',
			identifiers: [{ resource: 'isbn:9789999999998', url: 'https://ol/x' }],
			fields: { title: 'Completely Unrelated Title' },
		});
		expect(res.existed).toBe(false);
		expect(res.pk).toBe('book-dune');
		const issues = await openIssuesFor(db, 'book', 'book-dune');
		expect(issues.some((i) => i.field === 'pk')).toBe(true);
		const bookCount = (await db.execute(sql`SELECT count(*) AS c FROM books`)).rows[0] as { c: string };
		expect(bookCount.c).toBe('2');
	});

	it('flags an issue when a later claimed identifier is owned by another entity', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		// books/ol-b owns isbn:9780000000002
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol-b',
			source: 'bookhive',
			matchName: null,
			identifiers: [{ resource: 'isbn:9780000000002', url: 'https://ol/2' }],
			fields: { title: 'Book B' },
		});
		// candidate claims isbn:0441172717 (owned by book-dune) first, so the merge
		// target is book-dune; the second identifier is owned by someone else.
		const res = await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol-a',
			source: 'openlibrary',
			matchName: null,
			identifiers: [
				{ resource: 'isbn:0441172717', url: 'https://ol/dune' },
				{ resource: 'isbn:9780000000002', url: 'https://ol/2' },
			],
			fields: { title: 'Book A' },
		});
		expect(res.existed).toBe(true);
		expect(res.pk).toBe('book-dune');
		const issues = await openIssuesFor(db, 'book', 'book-dune');
		expect(
			issues.some((i) => i.field === 'identifier' && i.incomingValue === 'isbn:9780000000002' && i.storedValue === 'books/ol-b'),
		).toBe(true);
	});
});

describe('mergeEntity logging', () => {
	it('logs each merge step and warns on anomalies', async () => {
		const { db, seed } = await createTestDb();
		await seed();

		const debugSpy = vi.spyOn(logger, 'debug');
		const warnSpy = vi.spyOn(logger, 'warn');

		// fresh insert path
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol-log-a',
			source: 'openlibrary',
			matchName: 'Logging Test Book',
			identifiers: [{ resource: 'isbn:9785555555555', url: 'https://ol/x' }],
			fields: { title: 'Logging Test Book' },
		});

		// slug collision path (candidate pk exists but nothing matched it)
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'book-dune',
			source: 'bookhive',
			matchName: 'Completely Unrelated Title',
			identifiers: [{ resource: 'isbn:9786666666666', url: 'https://ol/x' }],
			fields: { title: 'Completely Unrelated Title' },
		});

		// establish an owner for isbn:9780000000002, then merge a candidate whose
		// two identifiers span two different entities (0441172717 → book-dune, the
		// other → the owner we just created)
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol-log-owner',
			source: 'bookhive',
			matchName: null,
			identifiers: [{ resource: 'isbn:9780000000002', url: 'https://ol/2' }],
			fields: { title: 'Owner' },
		});
		await mergeEntity(db, {
			entityType: 'book',
			pk: 'books/ol-log-b',
			source: 'openlibrary',
			matchName: null,
			identifiers: [
				{ resource: 'isbn:0441172717', url: 'https://ol/dune' },
				{ resource: 'isbn:9780000000002', url: 'https://ol/2' },
			],
			fields: { title: 'Book B2' },
		});

		expect(debugSpy.mock.calls.some(([o, m]) => m === 'merge: identifier match')).toBe(true);
		expect(debugSpy.mock.calls.some(([o, m]) => m === 'merge: field conflict')).toBe(true);
		expect(debugSpy.mock.calls.some(([o, m]) => m === 'merge: inserted')).toBe(true);
		expect(warnSpy.mock.calls.some(([o, m]) => m === 'merge: slug collision')).toBe(true);
		expect(warnSpy.mock.calls.some(([o, m]) => m === 'merge: identifier conflict')).toBe(true);

		debugSpy.mockRestore();
		warnSpy.mockRestore();
	});
});
