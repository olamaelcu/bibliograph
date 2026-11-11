/**
 * Per-provider daily call accounting for metered upstream APIs.
 *
 * The counter lives in Postgres (`provider_daily_usage`) rather than process
 * memory so several worker processes and restarts share one quota. Days are
 * UTC: every query uses `(now() AT TIME ZONE 'UTC')::date`.
 */

export const DEFAULT_ISBNDB_DAILY_LIMIT = 5000;

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
 * Atomically reserve one call for the current UTC day.
 *
 * Returns the new call count, or null when the daily limit is already reached.
 * A false return means the caller must not touch the network.
 */
export async function reserveDailyCall(pool, { provider = 'isbndb', limit }) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('reserveDailyCall requires a positive integer limit');
  }
  const result = await pool.query(
    `INSERT INTO provider_daily_usage (provider, day, calls)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (provider, day) DO UPDATE
       SET calls = provider_daily_usage.calls + 1
       WHERE provider_daily_usage.calls < $2
     RETURNING calls`,
    [provider, limit]
  );
  return result.rows[0]?.calls ?? null;
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
