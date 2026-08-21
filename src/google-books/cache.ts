import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { gbCache } from '../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * Stable JSON serialization for cache keys. Object keys are sorted so
 * `{a:1,b:2}` and `{b:2,a:1}` hash the same.
 */
export function canonicalJson(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_, v) => {
		if (v && typeof v === 'object') {
			if (seen.has(v as object)) return null;
			seen.add(v as object);
			if (!Array.isArray(v)) {
				const sorted: Record<string, unknown> = {};
				for (const k of Object.keys(v as Record<string, unknown>).sort()) {
					sorted[k] = (v as Record<string, unknown>)[k];
				}
				return sorted;
			}
		}
		return v;
	});
}

export function requestHash(endpoint: string, params: unknown): string {
	return createHash('sha256').update(endpoint).update('\0').update(canonicalJson(params)).digest('hex');
}

/** Default TTLs (in seconds). */
export const TTL = {
	search: 5 * 60,
	getBook: 60 * 60,
} as const;

export async function getCached<T>(db: Db, endpoint: string, params: unknown): Promise<T | undefined> {
	const hash = requestHash(endpoint, params);
	const now = Math.floor(Date.now() / 1000);
	const rows = await db
		.select({ response: gbCache.response })
		.from(gbCache)
		.where(sql`${gbCache.requestHash} = ${hash} AND ${gbCache.expiresAt} > ${now}`);
	const row = rows[0];
	return row ? (row.response as T) : undefined;
}

export async function setCached(
	db: Db,
	endpoint: string,
	params: unknown,
	response: unknown,
	ttlSeconds: number,
): Promise<void> {
	const hash = requestHash(endpoint, params);
	const now = Math.floor(Date.now() / 1000);
	await db
		.insert(gbCache)
		.values({
			requestHash: hash,
			endpoint,
			response: response as never,
			expiresAt: now + ttlSeconds,
		})
		.onConflictDoUpdate({
			target: gbCache.requestHash,
			set: { response: response as never, expiresAt: now + ttlSeconds },
		});
}

/** Prune expired rows. Returns the number of rows deleted. Called hourly by gb:evict. */
export async function pruneExpired(db: Db): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const result = await db.execute<{ count: number }>(
		sql`WITH deleted AS (DELETE FROM gb_cache WHERE expires_at <= ${now} RETURNING 1) SELECT count(*)::int AS count FROM deleted`,
	);
	return Number(result.rows[0]?.count ?? 0);
}
