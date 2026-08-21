import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { bookIdentifiers, importIssues } from './schema.js';
import { sql } from 'drizzle-orm';

describe('staged-release schema', () => {
	it('applies release_status and released_at columns with CHECK constraints', async () => {
		const { db } = await createTestDb();
		const rows = (
			await db.execute(
				sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'books' AND column_name IN ('release_status', 'released_at')`,
			)
		).rows as Array<{ column_name: string }>;
		expect(rows.map((r) => r.column_name).sort()).toEqual(['release_status', 'released_at']);

		const constraints = (
			await db.execute(
				sql`SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'books' AND constraint_type = 'CHECK'`,
			)
		).rows as Array<{ constraint_name: string }>;
		expect(constraints.map((r) => r.constraint_name)).toContain('books_release_status_check');
	});

	it('rejects invalid release_status', async () => {
		const { db } = await createTestDb();
		await expect(
			db.execute(
				sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('b1', 'T', 0, 'bogus')`,
			),
		).rejects.toThrow();
	});

	it('rejects invalid import_issues entity_type', async () => {
		const { db } = await createTestDb();
		await expect(
			db
				.insert(importIssues)
				.values({
					entityType: 'bogus',
					entityPk: 'x',
					field: 'title',
					source: 'openlibrary',
					createdAt: 0,
				}),
		).rejects.toThrow();
	});

	it('enforces unique identifier resource', async () => {
		const { db } = await createTestDb();
		await db.execute(sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('b1', 'One', 0, 'staged')`);
		await db.execute(sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('b2', 'Two', 0, 'staged')`);
		await db.insert(bookIdentifiers).values({
			bookPk: 'b1',
			resource: 'isbn:9780000000001',
			url: 'u1',
		});
		await expect(
			db.insert(bookIdentifiers).values({
				bookPk: 'b2',
				resource: 'isbn:9780000000001',
				url: 'u2',
			}),
		).rejects.toThrow();
	});

	it('exposes review views with aggregated open issues', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const now = Math.floor(Date.now() / 1000);
		await db.insert(importIssues).values({
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune (Alternate)',
			storedValue: 'Dune (40th Anniversary)',
			source: 'openlibrary',
			status: 'open',
			createdAt: now,
		});
		const result = await db.execute(sql`SELECT pk, open_issues FROM book_import_issues`);
		const rows = result.rows as Array<{ pk: string; open_issues: unknown }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].pk).toBe('book-dune');
		const issues = rows[0].open_issues as Array<{ field: string; incomingValue: string }>;
		expect(issues).toHaveLength(1);
		expect(issues[0].field).toBe('title');
		expect(issues[0].incomingValue).toBe('Dune (Alternate)');
	});

	it('applies DEFAULT staged to new inserts', async () => {
		const { db } = await createTestDb();
		await db.execute(sql`INSERT INTO books (pk, title, created_at) VALUES ('fresh', 'New Book', 0)`);
		const rows = (
			await db.execute(sql`SELECT release_status FROM books WHERE pk = 'fresh'`)
		).rows as Array<{ release_status: string }>;
		expect(rows[0].release_status).toBe('staged');
	});

	it('creates the catalog tables', async () => {
		const { db } = await createTestDb();
		const names = (
			await db.execute(
				sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('import_issues', 'catalog_blobs', 'gb_cache')`,
			)
		).rows as Array<{ table_name: string }>;
		expect(names.map((r) => r.table_name).sort()).toEqual([
			'catalog_blobs',
			'gb_cache',
			'import_issues',
		]);
	});

	it('keeps seeded reference data and schema invariants intact', async () => {
		const { db, seed } = await createTestDb();
		await seed();

		// The release_status CHECK still guards inserts on seeded tables.
		await expect(
			db.execute(
				sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('bogus', 'T', 0, 'bogus')`,
			),
		).rejects.toThrow();

		// The review view aggregates over the seeded graph.
		const now = Math.floor(Date.now() / 1000);
		await db.insert(importIssues).values({
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune (Alternate)',
			storedValue: 'Dune (40th Anniversary)',
			source: 'openlibrary',
			status: 'open',
			createdAt: now,
		});
		const result = await db.execute(sql`SELECT pk, open_issues FROM book_import_issues`);
		const rows = result.rows as Array<{ pk: string; open_issues: unknown }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].pk).toBe('book-dune');
		expect(rows[0].open_issues as unknown[]).toHaveLength(1);
	});
});
