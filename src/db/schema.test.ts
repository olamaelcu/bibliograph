import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bookIdentifiers } from './schema.js';
import { createTestDb } from '../test-utils/db.js';

describe('catalog schema', () => {
	it('enforces unique identifier (value_scheme, value)', async () => {
		const { db } = await createTestDb();
		await db.execute(sql`INSERT INTO editions (pk, title, created_at) VALUES ('b1', 'One', 0)`);
		await db.execute(sql`INSERT INTO editions (pk, title, created_at) VALUES ('b2', 'Two', 0)`);
		await db.insert(bookIdentifiers).values({
			bookPk: 'b1',
			valueScheme: 'isbn13',
			value: '9780000000001',
			uri: 'urn:isbn:9780000000001',
		});
		await expect(
			db.insert(bookIdentifiers).values({
				bookPk: 'b2',
				valueScheme: 'isbn13',
				value: '9780000000001',
				uri: 'urn:isbn:9780000000001',
			}),
		).rejects.toThrow();
	});

	it('creates the google books response cache table', async () => {
		await createTestDb();
		const { Pool } = await import('pg');
		const url = new URL(process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph_test');
		url.pathname = `/bibliograph_test_${process.pid}`;
		const pool = new Pool({ connectionString: url.toString() });
		const res = await pool.query(
			`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'gb_cache'`,
		);
		await pool.end();
		const names = res.rows as Array<{ table_name: string }>;
		expect(names.map((r) => r.table_name)).toEqual(['gb_cache']);
	});

	it('keeps seeded reference data intact', async () => {
		const { db, seed } = await createTestDb();
		await seed();

		const ids = await db.execute(
			sql`SELECT value_scheme, value FROM book_identifiers WHERE book_pk = 'test-edition-dune'`,
		);
		const values = (ids.rows as Array<{ value_scheme: string; value: string }>).map((r) => r.value_scheme + ':' + r.value);
		expect(values).toContain('isbn13:9780441172719');
		expect(values).toContain('googleBooks:dune-vol');
	});
});