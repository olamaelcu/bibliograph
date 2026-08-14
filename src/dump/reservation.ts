import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { backfillReservation } from '../db/schema.js';

/**
 * Serialize long-running backfill work against live web writes. Web write
 * paths call `withWriteRetry` (added in a later task) which observes
 * reservations and retries on SQLITE_BUSY. Acquiring a reservation means
 * "a long import is running".
 */
export class Reservation {
  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly stateName: string,
    private readonly pid = process.pid,
  ) {}

  acquire(): boolean {
    const now = Math.floor(Date.now() / 1000);
    try {
      const held = this.db
        .select()
        .from(backfillReservation)
        .where(eq(backfillReservation.stateName, this.stateName))
        .get();
      if (held) return held.pid === this.pid;
      const res = this.db
        .insert(backfillReservation)
        .values({ stateName: this.stateName, pid: this.pid, startedAt: now })
        .onConflictDoNothing()
        .run();
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  isHeld(): boolean {
    return (
      this.db
        .select()
        .from(backfillReservation)
        .where(eq(backfillReservation.stateName, this.stateName))
        .get() != null
    );
  }

  release(): void {
    this.db.delete(backfillReservation).where(eq(backfillReservation.stateName, this.stateName)).run();
  }
}
