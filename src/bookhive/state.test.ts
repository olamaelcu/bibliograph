import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, clearSqliteTables } from '../test-utils/db.js';
import { schema } from '../db/connection.js';
import { BookhiveCatalogState } from './state.js';

const { db } = createTestDb();
const STATE_NAME = 'bookhive_catalog';

beforeEach(() => {
  clearSqliteTables((db as any).$sqlite);
});

describe('BookhiveCatalogState', () => {
  it('returns null when no state row exists yet', () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    expect(state.get()).toBeNull();
  });

  it('persists catalogDid (in `url`) and lastRkey cursor across sets', () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    state.set({ catalogDid: 'did:plc:enu2j5xjlqsjaylv3du4myh4', lastRkey: 'rkey1', totalProcessed: 1 });
    state.set({ lastRkey: 'rkey2', totalProcessed: 2 });
    state.set({ lastRkey: 'rkey3', totalProcessed: 3 });

    const row = state.get();
    expect(row).not.toBeNull();
    expect(row!.catalogDid).toBe('did:plc:enu2j5xjlqsjaylv3du4myh4');
    expect(row!.lastRkey).toBe('rkey3');
    expect(row!.totalProcessed).toBe(3);
  });

  it('preserves startedAt across sets', () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    state.set({ catalogDid: 'did:plc:x', lastRkey: 'a', totalProcessed: 1 });
    const startedAt = state.get()!.startedAt;
    expect(startedAt).toBeTruthy();

    state.set({ lastRkey: 'b', totalProcessed: 2 });
    expect(state.get()!.startedAt).toBe(startedAt);
  });

  it('markComplete sets complete=true', () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    state.set({ catalogDid: 'did:plc:x', lastRkey: 'a', totalProcessed: 1 });
    state.markComplete();
    expect(state.get()!.complete).toBe(true);
  });

  it('clear removes the row', () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    state.set({ catalogDid: 'did:plc:x', lastRkey: 'a', totalProcessed: 1 });
    expect(state.get()).not.toBeNull();
    state.clear();
    expect(state.get()).toBeNull();
  });

  it('writes a row in the backfill_state table under the given name', () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    state.set({ catalogDid: 'did:plc:x', lastRkey: 'rkey-42', totalProcessed: 42 });

    const rows = db
      .select()
      .from(schema.backfillState)
      .where(eq(schema.backfillState.name, STATE_NAME))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(STATE_NAME);
    expect(rows[0].url).toBe('did:plc:x');
    expect(rows[0].lastKeyCursor).toBe('rkey-42');
    expect(rows[0].totalProcessed).toBe(42);
  });
});
