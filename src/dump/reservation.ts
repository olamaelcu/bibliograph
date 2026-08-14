import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { backfillReservation } from '../db/schema.js';
import { isPidAlive } from './lock.js';

/**
 * Serialize long-running backfill work against live web writes. Web write
 * paths call `withWriteRetry` which observes reservations and retries on
 * SQLITE_BUSY. Acquiring a reservation means "a long import is running".
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
      if (held) {
        // Take over reservations left by a dead process (crashed/interrupted
        // run); otherwise only the owning pid may re-acquire.
        if (this.isPidAlive(held.pid)) return held.pid === this.pid;
        this.db.delete(backfillReservation).where(eq(backfillReservation.stateName, this.stateName)).run();
      }
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

  /** True if `pid` is a live process on this host. */
  isPidAlive(pid: number): boolean {
    return isPidAlive(pid);
  }

  release(): void {
    this.db.delete(backfillReservation).where(eq(backfillReservation.stateName, this.stateName)).run();
  }
}
