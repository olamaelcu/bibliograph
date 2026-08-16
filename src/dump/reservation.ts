import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { backfillReservation } from '../db/schema.js';
import { isPidAlive } from './lock.js';

type Database = NodePgDatabase<typeof schema>;

/**
 * Serialize long-running backfill work against live web writes. Web write
 * paths call `withWriteRetry` which observes reservations and retries on
 * SQLITE_BUSY. Acquiring a reservation means "a long import is running".
 */
export class Reservation {
  constructor(
    private readonly db: Database,
    private readonly stateName: string,
    private readonly pid = process.pid,
  ) {}

  async acquire(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      const heldRows = await this.db
        .select()
        .from(backfillReservation)
        .where(eq(backfillReservation.stateName, this.stateName));
      const held = heldRows[0];
      if (held) {
        // Take over reservations left by a dead process (crashed/interrupted
        // run); otherwise only the owning pid may re-acquire.
        if (this.isPidAlive(held.pid)) return held.pid === this.pid;
        await this.db.delete(backfillReservation).where(eq(backfillReservation.stateName, this.stateName));
      }
      const res = await this.db
        .insert(backfillReservation)
        .values({ stateName: this.stateName, pid: this.pid, startedAt: now })
        .onConflictDoNothing();
      return (res.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async isHeld(): Promise<boolean> {
    const heldRows = await this.db
      .select()
      .from(backfillReservation)
      .where(eq(backfillReservation.stateName, this.stateName));
    return heldRows[0] != null;
  }

  /** True if `pid` is a live process on this host. */
  isPidAlive(pid: number): boolean {
    return isPidAlive(pid);
  }

  async release(): Promise<void> {
    await this.db.delete(backfillReservation).where(eq(backfillReservation.stateName, this.stateName));
  }
}
