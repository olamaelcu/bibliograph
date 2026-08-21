import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { setCached, pruneExpired } from '../google-books/cache.js';
import { gbCache } from '../db/schema.js';

let dbHolder: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	dbHolder = await createTestDb();
});
afterAll(async () => {
	await dbHolder.close();
});

describe('gb:evict contract', () => {
	it('prunes expired rows and leaves fresh ones alone', async () => {
		const now = Math.floor(Date.now() / 1000);
		await dbHolder.db.execute(sql`DELETE FROM gb_cache`);
		await setCached(dbHolder.db, 'searchBooks', { q: 'fresh' }, { v: 1 }, 3600);
		await setCached(dbHolder.db, 'searchBooks', { q: 'old' }, { v: 2 }, 1);
		// only the old row is past expiry; the fresh one stays valid
		await dbHolder.db.execute(sql`UPDATE gb_cache SET expires_at = ${now - 1} WHERE endpoint = 'searchBooks' AND (response->>'v')::int = 2`);

		const removed = await pruneExpired(dbHolder.db);
		expect(removed.expired).toBe(1);
		expect(removed.overCap).toBe(0);

		const remaining = await dbHolder.db.select().from(gbCache);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].endpoint).toBe('searchBooks');
	});

	it('returns zero counts when nothing is expired', async () => {
		await dbHolder.db.execute(sql`DELETE FROM gb_cache`);
		await setCached(dbHolder.db, 'searchBooks', { q: 'k' }, { v: 1 }, 3600);
		const removed = await pruneExpired(dbHolder.db);
		expect(removed.expired).toBe(0);
		expect(removed.overCap).toBe(0);
	});

	it('enforces GB_CACHE_MAX_ROWS when over cap', async () => {
		await dbHolder.db.execute(sql`DELETE FROM gb_cache`);
		// Seed 200 rows with far-future TTL so age-based eviction leaves them alone.
		for (let i = 0; i < 200; i++) {
			await setCached(dbHolder.db, 'searchBooks', { q: `k${i}` }, { v: i }, 3600);
		}
		// Default cap is 100_000; 200 rows are well under it, so nothing is evicted.
		const removed = await pruneExpired(dbHolder.db);
		expect(removed.expired).toBe(0);
		expect(removed.overCap).toBe(0);
		const before = await dbHolder.db.select().from(gbCache);
		expect(before).toHaveLength(200);

		// Override the cap to 100; the 100 oldest rows must go.
		process.env.GB_CACHE_MAX_ROWS = '100';
		try {
			const removed2 = await pruneExpired(dbHolder.db);
			expect(removed2.expired).toBe(0);
			expect(removed2.overCap).toBe(100);
			const remaining = await dbHolder.db.select().from(gbCache);
			expect(remaining).toHaveLength(100);
		} finally {
			delete process.env.GB_CACHE_MAX_ROWS;
		}
	});
});
