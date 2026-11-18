/**
 * Per-provider daily call accounting for metered upstream APIs.
 *
 * The counter lives in Postgres (`provider_daily_usage`) rather than process
 * memory so several worker processes and restarts share one quota. Days are
 * UTC: every query uses `(now() AT TIME ZONE 'UTC')::date`.
 *
 * The counter is one row per `(provider, day)` and therefore one hot row; each
 * process holds a small allowance bought from it in blocks rather than
 * round-tripping per call (`createDailyQuota`).
 */

export const DEFAULT_ISBNDB_DAILY_LIMIT = 5000;

/**
 * Fraction of the hard daily limit that the soft limit sits at.
 *
 * `createDailyQuota` enforces the hard limit; the soft limit is what the
 * metrics expose so an alert can fire while calls are still allowed. At the
 * default 5000 that is 4750, leaving 250 calls of headroom to investigate
 * before the provider stops answering.
 */
export const ISBNDB_SOFT_LIMIT_RATIO = 0.95;

/**
 * Parse a positive-integer daily limit. Zero and negatives are invalid (they
 * are not "unlimited"); invalid values warn and fall back to the default.
 */
export function parseDailyLimit(raw, logger = console) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_ISBNDB_DAILY_LIMIT;
  }
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  logger?.warn?.(
    `worker: ISBNDB_DAILY_LIMIT=${JSON.stringify(String(raw))} is not a positive integer; ` +
      `using ${DEFAULT_ISBNDB_DAILY_LIMIT} (0/negative is invalid, not unlimited)`
  );
  return DEFAULT_ISBNDB_DAILY_LIMIT;
}

/**
 * Calls reserved per round trip to the shared counter.
 *
 * The counter is one hot row per `(provider, day)`, and a per-call reservation
 * serialises every worker on it: 300k editions of ISBNdb lookups were 300k
 * updates of the same row. Reserving ten at a time in process memory keeps the
 * hard daily limit while cutting that contention tenfold; the cost is at most
 * nine calls of the day's quota reserved but never spent.
 */
export const DAILY_QUOTA_BLOCK = 10;

/**
 * A process-local allowance on top of the shared daily counter.
 *
 * Returns an async `reserve()` that spends one call and answers the shared
 * counter's value at the refill that funded it, or `null` when the day's limit
 * is reached — the same "do not touch the network" answer a per-call
 * reservation gave. When the allowance runs out, one upsert buys the next
 * block:
 *
 *   INSERT … ON CONFLICT (provider, day)
 *     DO UPDATE SET calls = calls + $block
 *     WHERE calls + $block <= $limit
 *   RETURNING calls, day
 *
 * so the hard limit is still enforced by the row itself and can never be
 * exceeded, whichever order concurrent workers refill in. The block is capped
 * at the limit, and a block that would not fit is refused rather than made to
 * fit: the effective cap is the largest whole number of blocks within the
 * limit, never above it.
 *
 * A reservation never crosses UTC midnight: the allowance was bought against
 * one day's row, so a new day starts it at zero and refills against the new row.
 */
export function createDailyQuota(
  pool,
  { provider = 'isbndb', limit, block = DAILY_QUOTA_BLOCK } = {}
) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('createDailyQuota requires a positive integer limit');
  }
  const size = Math.max(
    1,
    Math.min(Number.isInteger(block) && block > 0 ? block : DAILY_QUOTA_BLOCK, limit)
  );
  let allowance = 0;
  let day = null;
  let calls = 0;

  async function refill() {
    const result = await pool.query(
      `INSERT INTO provider_daily_usage (provider, day, calls)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2)
       ON CONFLICT (provider, day) DO UPDATE
         SET calls = provider_daily_usage.calls + EXCLUDED.calls
         WHERE provider_daily_usage.calls + EXCLUDED.calls <= $3
       RETURNING calls, day::text AS day`,
      [provider, size, limit]
    );
    const row = result.rows[0];
    if (!row) return false;
    allowance = size;
    day = row.day;
    calls = row.calls;
    return true;
  }

  return async function reserve() {
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) allowance = 0;
    if (allowance === 0 && !(await refill())) return null;
    allowance -= 1;
    return calls;
  };
}

/** Calls reserved for today's UTC day; 0 when no row exists yet. */
export async function readDailyCalls(pool, provider = 'isbndb') {
  const result = await pool.query(
    `SELECT calls FROM provider_daily_usage
      WHERE provider = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
    [provider]
  );
  return result.rows[0]?.calls ?? 0;
}
