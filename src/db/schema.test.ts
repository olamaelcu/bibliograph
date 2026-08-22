import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { bookIdentifiers } from './schema.js';
import { sql } from 'drizzle-orm';

describe('catalog schema', () => {
	it('enforces unique identifier resource', async () => {
		const { db } = await createTestDb();
		await db.execute(sql`INSERT INTO books (pk, title, created_at) VALUES ('b1', 'One', 0)`);
		await db.execute(sql`INSERT INTO books (pk, title, created_at) VALUES ('b2', 'Two', 0)`);
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

	it('creates the google books response cache table', async () => {
		const { db } = await createTestDb();
		const names = (
			await db.execute(
				sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'gb_cache'`,
			)
		).rows as Array<{ table_name: string }>;
		expect(names.map((r) => r.table_name)).toEqual(['gb_cache']);
	});

	it('keeps seeded reference data intact', async () => {
		const { db, seed } = await createTestDb();
		await seed();

		const ids = await db.execute(
			sql`SELECT resource FROM book_identifiers WHERE book_pk = 'book-dune'`,
		);
		expect(ids.rows.map((r) => (r as { resource: string }).resource)).toEqual(['isbn:0441172717']);
	});
});