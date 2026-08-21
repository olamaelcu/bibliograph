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
		expect(removed).toBe(1);

		const remaining = await dbHolder.db.select().from(gbCache);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].endpoint).toBe('searchBooks');
	});

	it('returns 0 when nothing is expired', async () => {
		await dbHolder.db.execute(sql`DELETE FROM gb_cache`);
		await setCached(dbHolder.db, 'searchBooks', { q: 'k' }, { v: 1 }, 3600);
		const removed = await pruneExpired(dbHolder.db);
		expect(removed).toBe(0);
	});
});
