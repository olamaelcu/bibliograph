import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  acquireReservation,
  heartbeatReservation,
  releaseReservation,
  isReservationActive,
} from './reservation.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 100');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  (db as any).$sqlite = sqlite;
  return { sqlite, db };
}

describe('backfill reservation', () => {
  it('acquires, heartbeats, and releases a reservation row', () => {
    const { db } = makeDb();
    const stateName = 'openlibrary_editions';

    acquireReservation(db, { stateName, batchSize: 500 });
    let row = db.select().from(schema.backfillReservation).get();
    expect(row).toBeDefined();
    expect(row!.stateName).toBe(stateName);
    expect(row!.status).toBe('active');
    expect(row!.ownerPid).toBe(process.pid);
    expect(isReservationActive(db, stateName)).toBe(true);

    const before = row!.heartbeatAt;
    const later = Date.now() + 10_000;
    vi.useFakeTimers();
    vi.setSystemTime(later);
    try {
      heartbeatReservation(db, stateName);
    } finally {
      vi.useRealTimers();
    }
    row = db.select().from(schema.backfillReservation).get();
    expect(row!.heartbeatAt).toBeGreaterThan(before);

    releaseReservation(db, stateName);
    row = db.select().from(schema.backfillReservation).get();
    expect(row).toBeUndefined();
    expect(isReservationActive(db, stateName)).toBe(false);
  });

  it('rejects a second acquisition while one is active', () => {
    const { db } = makeDb();
    acquireReservation(db, { stateName: 's', batchSize: 500 });
    expect(() => acquireReservation(db, { stateName: 's', batchSize: 500 })).toThrow(
      /held by another active process/,
    );
  });

  it('allows takeover after the heartbeat goes stale', () => {
    const { db } = makeDb();
    acquireReservation(db, { stateName: 's', batchSize: 500 });

    const staleAt = Date.now() + 121_000;
    vi.useFakeTimers();
    vi.setSystemTime(staleAt);
    try {
      // Simulate an importer that died without releasing: refresh heartbeat then
      // cross the staleness window.
      db.update(schema.backfillReservation)
        .set({ heartbeatAt: Date.now() })
        .where(eq(schema.backfillReservation.stateName, 's'))
        .run();
      const farFuture = Date.now() + 130_000;
      vi.setSystemTime(farFuture);

      expect(() => acquireReservation(db, { stateName: 's', batchSize: 500 })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    const row = db.select().from(schema.backfillReservation).get();
    expect(row!.ownerPid).toBe(process.pid);
  });

  it('release is idempotent', () => {
    const { db } = makeDb();
    releaseReservation(db, 'never-acquired');
    expect(db.select().from(schema.backfillReservation).get()).toBeUndefined();
  });
});
