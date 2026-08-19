import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { stageBookWork, resolveBookWorks } from './book-works.js';
import { mergeEntity } from './merge.js';
import { books, works, workIdentifiers } from '../db/schema.js';

describe('stageBookWork + resolveBookWorks', () => {
	it('stages a deferred book→work link without touching the books row', async () => {
		const { db } = await createTestDb();
		const now = Math.floor(Date.now() / 1000);
		await db.insert(works).values({ pk: 'works-ol99999w', title: 'TestWork', createdAt: now, releaseStatus: 'staged' });
		await db.insert(books).values({ pk: 'books-ol99999m', title: 'TestBook', createdAt: now, releaseStatus: 'staged' });
		await stageBookWork(db, 'books-ol99999m', '/works/OL99999W', 'openlibrary');
		const rows = (await db.execute(sql`SELECT book_pk, work_ol_key, source FROM book_work_staging WHERE book_pk = 'books-ol99999m'`)).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0].work_ol_key).toBe('/works/OL99999W');
	});

	it('idempotent: restaging the same book_pk is a no-op', async () => {
		const { db } = await createTestDb();
		await stageBookWork(db, 'books-ol11111m', '/works/OL11111W', 'openlibrary');
		await stageBookWork(db, 'books-ol11111m', '/works/OL22222W', 'openlibrary');
		const rows = (await db.execute(sql`SELECT book_pk, work_ol_key FROM book_work_staging WHERE book_pk = 'books-ol11111m'`)).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0].work_ol_key).toBe('/works/OL11111W');
	});

	it('resolveBookWorks fills NULL work_pk when the work lands', async () => {
		const { db } = await createTestDb();
		const now = Math.floor(Date.now() / 1000);
		await db.insert(works).values({ pk: 'works-ol99999w', title: 'TestWork', createdAt: now, releaseStatus: 'staged' });
		await db.insert(workIdentifiers).values({ workPk: 'works-ol99999w', resource: 'openlibrary:works/OL99999W', url: 'https://openlibrary.org/works/OL99999W' });
		await db.insert(books).values({ pk: 'books-ol99999m', title: 'TestBook', createdAt: now, workPk: null, releaseStatus: 'staged' });
		await stageBookWork(db, 'books-ol99999m', '/works/OL99999W', 'openlibrary');

		const resolved = await resolveBookWorks(db);
		expect(resolved).toBe(1);

		const row = (await db.select().from(books).where(eq(books.pk, 'books-ol99999m')))[0];
		expect(row?.workPk).toBe('works-ol99999w');
		const staging = (await db.execute(sql`SELECT book_pk FROM book_work_staging WHERE book_pk = 'books-ol99999m'`)).rows;
		expect(staging).toHaveLength(0);
	});

	it('resolveBookWorks drops stale links whose work never materializes', async () => {
		const { db } = await createTestDb();
		const now = Math.floor(Date.now() / 1000);
		await db.insert(books).values({ pk: 'books-noresolve', title: 'NoResolve', createdAt: now, workPk: null, releaseStatus: 'staged' });
		await stageBookWork(db, 'books-noresolve', '/works/OL99999W', 'openlibrary');

		const resolved = await resolveBookWorks(db);
		expect(resolved).toBe(0);

		const row = (await db.select().from(books).where(eq(books.pk, 'books-noresolve')))[0];
		expect(row?.workPk).toBeNull();
		const staging = (await db.execute(sql`SELECT book_pk FROM book_work_staging`)).rows;
		expect(staging).toHaveLength(0);
	});

	it('mergeEntity throws FK violation when work is missing (caller must pre-check or pre-fetch)', async () => {
		// mergeEntity is the low-level merger. It does not pre-check work
		// existence — that responsibility lives in the upsert callback
		// (dump-runner.ts) which uses a per-batch pre-fetched `workExists`
		// set to mutate the candidate to workPk=null before calling here.
		// Without that pre-check, the FK violation propagates to the
		// batched-importer's per-record savepoint catch.
		const { db } = await createTestDb();
		let caught: unknown;
		try {
			await mergeEntity(db, {
				entityType: 'book',
				pk: 'books-fkfallback',
				source: 'openlibrary',
				matchName: 'FkFallback',
				identifiers: [{ resource: 'openlibrary:books/OL_FK_FALLBACK', url: 'https://openlibrary.org/books/OL_FK_FALLBACK' }],
				fields: { title: 'FkFallback', publishDate: '866630400', workPk: 'works-not-yet-imported' },
			}, { skipNameFallback: true });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		// Drizzle wraps pg errors in DrizzleQueryError; the cause carries the
		// SQLSTATE (23503 = foreign_key_violation) and the constraint message.
		const cause = (caught as { cause?: { code?: string; message?: string } }).cause;
		expect(cause?.code).toBe('23503');
		expect(cause?.message ?? '').toMatch(/foreign key constraint/);
		const row = (await db.select().from(books).where(eq(books.pk, 'books-fkfallback')))[0];
		expect(row).toBeUndefined();
		const staging = (await db.execute(sql`SELECT book_pk FROM book_work_staging WHERE book_pk = 'books-fkfallback'`)).rows;
		expect(staging).toHaveLength(0);
	});
});
