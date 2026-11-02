import { Pool } from 'pg';

/**
 * Cache for tap queue depth reads.
 *
 * graphile-worker docs explicitly warn: "you should not read from the jobs view
 * frequently; any reading from Graphile Worker's tables can cause a performance
 * impact on the running workers… Do not read from the jobs view from within a
 * transaction." We throttle with a 1s cache to stay well under that ceiling.
 */

interface DepthCache {
  value: number;
  fetchedAt: number;
}

let cached: DepthCache | null = null;
const CACHE_TTL_MS = 1000;

// One pool for the process. Building and tearing down a pool per cache miss did
// a full connection handshake once a second, from inside the consumer's read
// loop — the loop this metric exists to protect.
let pool: Pool | null = null;

function depthPool(connectionString: string): Pool {
  pool ??= new Pool({ connectionString, max: 1 });
  return pool;
}

export async function getTapQueueDepth(): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  const { rows } = await depthPool(connectionString).query<{ count: string }>(
    "SELECT COUNT(*)::text FROM graphile_worker.jobs WHERE task_identifier LIKE 'tap-record-%' AND locked_at IS NULL",
  );
  const value = Number(rows[0]?.count ?? '0');
  cached = { value, fetchedAt: now };
  return value;
}

export function resetDepthCache(): void {
  cached = null;
}

/** Test hook: close the shared pool so a test process can exit. */
export async function closeDepthPool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end();
}