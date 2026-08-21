import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { canonicalJson, getCached, pruneExpired, requestHash, setCached, TTL } from './cache.js';

const dbHolder = { db: undefined as Awaited<ReturnType<typeof createTestDb>>['db'] | undefined, close: async () => {} };

beforeAll(async () => {
	const t = await createTestDb();
	dbHolder.db = t.db;
	dbHolder.close = t.close;
});

beforeEach(async () => {
	await dbHolder.db!.execute(
		(await import('drizzle-orm')).sql`DELETE FROM gb_cache`,
	);
});

afterAll(async () => {
	await dbHolder.close();
});

describe('canonicalJson', () => {
	it('sorts object keys so {a:1,b:2} and {b:2,a:1} hash equal', () => {
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});

	it('preserves array order', () => {
		expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
	});

	it('handles cycles without throwing (returns null for the cycle)', () => {
		const obj: Record<string, unknown> = {};
		obj.self = obj;
		expect(() => canonicalJson(obj)).not.toThrow();
	});
});

describe('requestHash', () => {
	it('changes when endpoint changes', () => {
		const params = { q: 'x' };
		expect(requestHash('searchBooks', params)).not.toBe(requestHash('getBook', params));
	});

	it('changes when params change', () => {
		expect(requestHash('searchBooks', { q: 'x' })).not.toBe(requestHash('searchBooks', { q: 'y' }));
	});
});

describe('cache round-trip', () => {
	it('setCached then getCached returns the value before expiry', async () => {
		const db = dbHolder.db!;
		const params = { q: 'round-trip', startIndex: 0, limit: 10 };
		const value = { totalItems: 5, items: [{ id: 'a', volumeInfo: { title: 'A' } }] };
		await setCached(db, 'searchBooks', params, value, TTL.search);
		const cached = await getCached<typeof value>(db, 'searchBooks', params);
		expect(cached).toEqual(value);
	});

	it('overwrites existing entry on collision (same hash)', async () => {
		const db = dbHolder.db!;
		const params = { q: 'overwrite' };
		await setCached(db, 'searchBooks', params, { version: 1 }, 3600);
		await setCached(db, 'searchBooks', params, { version: 2 }, 3600);
		const cached = await getCached<{ version: number }>(db, 'searchBooks', params);
		expect(cached?.version).toBe(2);
	});

	it('getCached returns undefined for an expired entry', async () => {
		const db = dbHolder.db!;
		const params = { q: 'expired' };
		await setCached(db, 'searchBooks', params, { ok: true }, 1);
		// backdate the entry past expiry
		await db.execute((await import('drizzle-orm')).sql`UPDATE gb_cache SET expires_at = 0 WHERE request_hash = ${requestHash('searchBooks', params)}`);
		expect(await getCached(db, 'searchBooks', params)).toBeUndefined();
	});

	it('pruneExpired removes only past-expiry rows', async () => {
		const db = dbHolder.db!;
		await setCached(db, 'searchBooks', { q: 'old' }, { v: 1 }, 1);
		await setCached(db, 'searchBooks', { q: 'new' }, { v: 2 }, 3600);
		await db.execute((await import('drizzle-orm')).sql`UPDATE gb_cache SET expires_at = 0 WHERE request_hash = ${requestHash('searchBooks', { q: 'old' })}`);
		const removed = await pruneExpired(db);
		expect(removed).toBe(1);
		const kept = await getCached(db, 'searchBooks', { q: 'new' });
		expect(kept).toEqual({ v: 2 });
	});
});
