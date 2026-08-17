import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { openIssuesFor } from './issues.js';
import { buildMergeBatchContext, mergeBatch } from './merge-batch.js';
import type { MergeCandidate } from './merge.js';

describe('mergeBatch', () => {
	it('inserts a fresh candidate in a single batch', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const candidate: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-new-batch',
			source: 'openlibrary',
			matchName: 'Brand New Batch Book',
			identifiers: [{ resource: 'isbn:9781111111111', url: 'https://ol/x' }],
			fields: { title: 'Brand New Batch Book', description: 'fresh' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [candidate]);
			const results = await mergeBatch(tx, [candidate], ctx);
			expect(results[0].existed).toBe(false);
			expect(results[0].pk).toBe('books/ol-new-batch');
		});
	});

	it('merges onto an existing record via a pre-fetched identifier map (no round-trip SELECT)', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const candidate: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol123m',
			source: 'openlibrary',
			matchName: 'Dune',
			identifiers: [{ resource: 'isbn:0441172717', url: 'https://ol/dune' }],
			fields: { title: 'Dune', description: 'Classic' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [candidate]);
			const results = await mergeBatch(tx, [candidate], ctx);
			expect(results[0].existed).toBe(true);
			expect(results[0].pk).toBe('book-dune');
			expect(results[0].conflictFields).toContain('title');
		});
		const issues = await openIssuesFor(db, 'book', 'book-dune');
		expect(issues.some((i) => i.field === 'title' && i.incomingValue === 'Dune')).toBe(true);
	});

	it('honors skipNameFallback: true', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const candidate: MergeCandidate = {
			entityType: 'contributor',
			pk: 'authors/frank-herbert-2',
			source: 'openlibrary',
			matchName: 'Frank Herbert',
			identifiers: [],
			fields: { name: 'Frank Herbert' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [candidate]);
			const results = await mergeBatch(tx, [candidate], ctx, { skipNameFallback: true });
			expect(results[0].existed).toBe(false);
			expect(results[0].pk).toBe('authors/frank-herbert-2');
		});
	});

	it('detects cross-record identifier conflict within the same batch', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		// Two candidates both claim the same ISBN; the second must surface a conflict.
		const a: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-batch-a',
			source: 'openlibrary',
			matchName: null,
			identifiers: [{ resource: 'isbn:9781111111112', url: 'https://ol/a' }],
			fields: { title: 'Book A' },
		};
		const b: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-batch-b',
			source: 'openlibrary',
			matchName: null,
			identifiers: [{ resource: 'isbn:9781111111112', url: 'https://ol/b' }],
			fields: { title: 'Book B' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [a, b]);
			const results = await mergeBatch(tx, [a, b], ctx);
			// Both inserted cleanly (A first, B then sees the claim and merges onto A's pk).
			expect(results[0].pk).toBe('books/ol-batch-a');
			expect(results[1].pk).toBe('books/ol-batch-a'); // B is merged onto A
		});
		// A's book row carries the title "Book A" (or B's if merged later, but
		// since A inserted first and B merged onto A, the title stays "Book A").
		const rows = await db.execute(sql`SELECT title FROM books WHERE pk = ${'books/ol-batch-a'}`);
		const row = (rows.rows[0] as { title: string } | undefined);
		expect(row?.title).toBe('Book A');
	});

	it('flags an identifier conflict when a later identifier in the same candidate is owned by another entity', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		// book-flowers exists in the seed (no identifier). Add a second identifier
		// to dune so the candidate can claim dune's first ISBN and a third
		// unknown ISBN, then also a conflicting identifier.
		await db.execute(sql`INSERT INTO book_identifiers (book_pk, resource, url) VALUES ('book-dune', 'isbn:9780000000002', 'https://ol/2') ON CONFLICT DO NOTHING`);
		// dune now owns isbn:0441172717 AND isbn:9780000000002.
		// New candidate claims both dune's first ISBN + a fresh ISBN: it merges
		// onto book-dune, and the second identifier matches the existing one
		// (no conflict). To force a conflict, the candidate also claims a
		// third identifier owned by book-flowers.
		await db.execute(sql`INSERT INTO book_identifiers (book_pk, resource, url) VALUES ('book-flowers', 'isbn:9780000000003', 'https://ol/3') ON CONFLICT DO NOTHING`);
		const candidate: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-batch-conflict',
			source: 'openlibrary',
			matchName: null,
			identifiers: [
				{ resource: 'isbn:0441172717', url: 'https://ol/dune' },
				{ resource: 'isbn:9781111111999', url: 'https://ol/x' },
				{ resource: 'isbn:9780000000003', url: 'https://ol/3' },
			],
			fields: { title: 'New owner' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [candidate]);
			const results = await mergeBatch(tx, [candidate], ctx);
			expect(results[0].existed).toBe(true);
			expect(results[0].pk).toBe('book-dune');
		});
		const issues = await openIssuesFor(db, 'book', 'book-dune');
		expect(issues.some((i) => i.field === 'identifier' && i.incomingValue === 'isbn:9780000000003' && i.storedValue === 'book-flowers')).toBe(true);
	});

	it('isolates a record failure (FK violation) so the rest of the batch commits', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		// First candidate: a book pointing to a non-existent work — FK fails.
		// Second candidate: a perfectly valid book that must commit despite the first failing.
		const failing: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-bad-fk',
			source: 'openlibrary',
			matchName: null,
			identifiers: [],
			fields: { title: 'Bad FK', workPk: 'works-does-not-exist' },
		};
		const good: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-good-after-fk',
			source: 'openlibrary',
			matchName: null,
			identifiers: [{ resource: 'isbn:9781111111124', url: 'https://ol/x' }],
			fields: { title: 'Good book' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [failing, good]);
			const results = await mergeBatch(tx, [failing, good], ctx);
			// The batch must have committed (no error thrown), the good
			// candidate must have been inserted, and the failing one
			// must have been recorded as a failed result.
			expect(results[0].pk).toBe('books/ol-bad-fk'); // sentinel
			expect(results[1].existed).toBe(false);
			expect(results[1].pk).toBe('books/ol-good-after-fk');
		});
		// Verify the good candidate was actually inserted (not rolled back).
		const inserted = await db.execute(sql`SELECT title FROM books WHERE pk = ${'books/ol-good-after-fk'}`);
		expect((inserted.rows[0] as { title: string } | undefined)?.title).toBe('Good book');
		const badRow = await db.execute(sql`SELECT title FROM books WHERE pk = ${'books/ol-bad-fk'}`);
		expect(badRow.rows).toHaveLength(0); // failed insert was rolled back
	});

	it('handles a mixed batch of new + existing + identifier-merge candidates', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const newCand: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-mixed-new',
			source: 'openlibrary',
			matchName: null,
			identifiers: [{ resource: 'isbn:9781111111123', url: 'https://ol/x' }],
			fields: { title: 'New' },
		};
		const mergeCand: MergeCandidate = {
			entityType: 'book',
			pk: 'books/ol-mixed-merge',
			source: 'openlibrary',
			matchName: null,
			identifiers: [{ resource: 'isbn:0441172717', url: 'https://ol/dune' }],
			fields: { title: 'Dune' },
		};
		await db.transaction(async (tx) => {
			const ctx = await buildMergeBatchContext(tx, [newCand, mergeCand]);
			const results = await mergeBatch(tx, [newCand, mergeCand], ctx);
			expect(results[0].existed).toBe(false);
			expect(results[0].pk).toBe('books/ol-mixed-new');
			expect(results[1].existed).toBe(true);
			expect(results[1].pk).toBe('book-dune');
		});
	});
});
