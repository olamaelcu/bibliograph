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

  it('clears state', () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'ol-editions');
    state.set({ lastKeyCursor: 'OL1M' });
    state.clear();
    expect(state.get()).toBeNull();
  });
});
