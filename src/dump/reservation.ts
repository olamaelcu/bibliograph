import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { isBusyError } from '../db/connection.js';
import { logger } from '../logger.js';

/**
 * Reservation row that coordinates a dump backfill against live app writes.
 *
 * The importer writes one row per state name, refreshing `heartbeat_at` on every
 * batch boundary. The web app's write path retries SQLITE_BUSY for up to
 * `maxWaitMs` (default 3000) — long enough to ride out a batch transaction —
 * instead of failing the request. After a stale timeout the reservation is
 * considered abandoned and cleared.
 */

const DEFAULT_HEARTBEAT_MAX_MS = 120_000;

export function acquireReservation(
  db: BetterSQLite3Database<typeof schema>,
  opts: {
    stateName: string;
    batchSize: number;
    maxHeartbeatMs?: number;
  },
): void {
  const now = Date.now();
  const existing = db
    .select({ status: schema.backfillReservation.status })
    .from(schema.backfillReservation)
    .where(eq(schema.backfillReservation.stateName, opts.stateName))
    .get();

  if (existing) {
    if (existing.status === 'active') {
      const stale = isReservationStale(db, opts.stateName, opts.maxHeartbeatMs ?? DEFAULT_HEARTBEAT_MAX_MS);
      if (!stale) {
        throw new Error(
          `backfill reservation '${opts.stateName}' is held by another active process; refusing to run concurrently`,
        );
      }
      logger.warn(
        { stateName: opts.stateName },
        'backfill reservation is stale (owner heartbeat expired); taking over',
      );
    }
  }

  db.insert(schema.backfillReservation)
    .values({
      stateName: opts.stateName,
      ownerPid: process.pid,
      acquiredAt: now,
      heartbeatAt: now,
      batchSize: opts.batchSize,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: schema.backfillReservation.stateName,
      set: {
        ownerPid: process.pid,
        acquiredAt: now,
        heartbeatAt: now,
        batchSize: opts.batchSize,
        status: 'active',
      },
    })
    .run();
}

export function heartbeatReservation(
  db: BetterSQLite3Database<typeof schema>,
  stateName: string,
): void {
  db.update(schema.backfillReservation)
    .set({ heartbeatAt: Date.now() })
    .where(eq(schema.backfillReservation.stateName, stateName))
    .run();
}

export function releaseReservation(
  db: BetterSQLite3Database<typeof schema>,
  stateName: string,
): void {
  db.delete(schema.backfillReservation)
    .where(eq(schema.backfillReservation.stateName, stateName))
    .run();
}

export function isReservationActive(
  db: BetterSQLite3Database<typeof schema>,
  stateName: string,
  maxHeartbeatMs: number = DEFAULT_HEARTBEAT_MAX_MS,
): boolean {
  const row = db
    .select({ heartbeatAt: schema.backfillReservation.heartbeatAt, status: schema.backfillReservation.status })
    .from(schema.backfillReservation)
    .where(eq(schema.backfillReservation.stateName, stateName))
    .get();
  if (!row || row.status !== 'active') return false;
  return Date.now() - row.heartbeatAt <= maxHeartbeatMs;
}

function isReservationStale(
  db: BetterSQLite3Database<typeof schema>,
  stateName: string,
  maxHeartbeatMs: number,
): boolean {
  const row = db
    .select({ heartbeatAt: schema.backfillReservation.heartbeatAt })
    .from(schema.backfillReservation)
    .where(eq(schema.backfillReservation.stateName, stateName))
    .get();
  if (!row) return false;
  return Date.now() - row.heartbeatAt > maxHeartbeatMs;
}

/** True if the error is a transient write-lock contention we can retry. */
export { isBusyError };
