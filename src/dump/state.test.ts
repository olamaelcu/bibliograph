import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { DumpState } from './state.js';

describe('DumpState', () => {
  it('persists and resumes cursor', () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'ol-editions');
    expect(state.get()).toBeNull();

    state.set({ lastKeyCursor: 'OL100M', lastByteOffset: 4096 });
    expect(state.get()?.cursor).toBe('OL100M');

    state.set({ lastKeyCursor: 'OL200M' });
    expect(state.get()?.cursor).toBe('OL200M');
  });

  it('markComplete sets the complete flag to 1', () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'ol-editions');
    state.set({ url: 'https://dump.example/ol.gz' });
    expect(state.get()?.complete).toBe(0);
    state.markComplete();
    expect(state.get()?.complete).toBe(1);
  });

  it('partial updates preserve existing fields', () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'ol-editions');
    state.set({ url: 'https://dump.example/ol.gz', lastKeyCursor: 'OL100M' });
    state.set({ totalProcessed: 42 });
    const row = state.get();
    expect(row?.url).toBe('https://dump.example/ol.gz');
    expect(row?.cursor).toBe('OL100M');
    expect(row?.totalProcessed).toBe(42);
  });

  it('persists totalRecords', () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'ol-editions');
    state.set({ url: 'https://dump.example/ol.gz' });
    expect(state.get()?.totalRecords).toBeNull();
    state.set({ totalRecords: 41_619_418 });
    expect(state.get()?.totalRecords).toBe(41_619_418);
  });

  it('clears state', () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'ol-editions');
    state.set({ lastKeyCursor: 'OL1M' });
    state.clear();
    expect(state.get()).toBeNull();
  });
});
