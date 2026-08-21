import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { gbCache } from '../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * Stable JSON serialization for cache keys. Object keys are sorted so
 * `{a:1,b:2}` and `{b:2,a:1}` hash equal.
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

/**
 * Returns a promise that rejects when `signal` aborts; never settles if
 * `signal` is undefined. Used to race drizzle query builders against the
 * outer handler's abort signal without changing their API.
 */
function abortOn(signal: AbortSignal | undefined): Promise<never> {
	if (!signal) return new Promise<never>(() => {});
	return new Promise<never>((_, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error('aborted'));
			return;
		}
		signal.addEventListener(
			'abort',
			() => reject(signal.reason ?? new Error('aborted')),
			{ once: true },
		);
	});
}

export async function getCached<T>(
	db: Db,
	endpoint: string,
	params: unknown,
	opts: { signal?: AbortSignal } = {},
): Promise<T | undefined> {
	const hash = requestHash(endpoint, params);
	const now = Math.floor(Date.now() / 1000);
	const query = db
		.select({ response: gbCache.response })
		.from(gbCache)
		.where(sql`${gbCache.requestHash} = ${hash} AND ${gbCache.expiresAt} > ${now}`);
	const rows = await Promise.race([query, abortOn(opts.signal)]);
	const row = rows[0];
	return row ? (row.response as T) : undefined;
}

export async function setCached(
	db: Db,
	endpoint: string,
	params: unknown,
	response: unknown,
	ttlSeconds: number,
	opts: { signal?: AbortSignal } = {},
): Promise<void> {
	const hash = requestHash(endpoint, params);
	const now = Math.floor(Date.now() / 1000);
	const promise = db
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
	await Promise.race([promise, abortOn(opts.signal)]);
}

/** Default maximum rows retained in `gb_cache`. Overridable via `GB_CACHE_MAX_ROWS`. */
const MAX_ROWS_DEFAULT = 100_000;

/**
 * Prune the cache in two passes:
 *   1. delete rows whose `expires_at` has passed (age-based eviction);
 *   2. if still over the size cap, delete the oldest surplus rows by `created_at`.
 * Returns the counts of rows deleted by each reason. Called hourly by `gb:evict`.
 */
export async function pruneExpired(db: Db): Promise<{ expired: number; overCap: number }> {
	const now = Math.floor(Date.now() / 1000);
	const maxRows = parseInt(process.env.GB_CACHE_MAX_ROWS ?? String(MAX_ROWS_DEFAULT), 10);

	const expiredResult = await db.execute<{ count: number }>(
		sql`WITH deleted AS (
			DELETE FROM gb_cache WHERE expires_at <= ${now} RETURNING 1
		) SELECT count(*)::int AS count FROM deleted`,
	);
	const expired = Number(expiredResult.rows[0]?.count ?? 0);

	let overCap = 0;
	const countResult = await db.execute<{ count: number }>(
		sql`SELECT count(*)::int AS count FROM gb_cache`,
	);
	const total = Number(countResult.rows[0]?.count ?? 0);
	if (total > maxRows) {
		const overflow = total - maxRows;
		const capResult = await db.execute<{ count: number }>(
			sql`WITH deleted AS (
				DELETE FROM gb_cache
				WHERE request_hash IN (
					SELECT request_hash FROM gb_cache
					ORDER BY created_at ASC
					LIMIT ${overflow}
				) RETURNING 1
			) SELECT count(*)::int AS count FROM deleted`,
		);
		overCap = Number(capResult.rows[0]?.count ?? 0);
	}

	return { expired, overCap };
}
