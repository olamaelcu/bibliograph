import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { DumpState } from './state.js';

describe('DumpState', () => {
  it('persists and resumes cursor', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    expect(await state.get()).toBeNull();

    await state.set({ lastKeyCursor: 'OL100M', lastByteOffset: 4096 });
    expect((await state.get())?.cursor).toBe('OL100M');

    await state.set({ lastKeyCursor: 'OL200M' });
    expect((await state.get())?.cursor).toBe('OL200M');
  });

  it('markComplete sets the complete flag to 1', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    await state.set({ url: 'https://dump.example/ol.gz' });
    expect((await state.get())?.complete).toBe(0);
    await state.markComplete();
    expect((await state.get())?.complete).toBe(1);
    // A completed run is not marked stopped.
    expect((await state.get())?.stopped).toBe(0);
  });

  it('marks a run stopped without touching complete or the resume cursor', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    await state.set({ url: 'https://dump.example/ol.gz', lastKeyCursor: 'OL100M', totalProcessed: 42 });
    await state.set({ stopped: true });
    const row = await state.get();
    expect(row?.stopped).toBe(1);
    expect(row?.complete).toBe(0);
    expect(row?.cursor).toBe('OL100M');
    expect(row?.totalProcessed).toBe(42);
  });

  it('can clear the stopped flag to resume', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    await state.set({ stopped: true });
    await state.set({ stopped: false, lastKeyCursor: 'OL200M' });
    const row = await state.get();
    expect(row?.stopped).toBe(0);
    expect(row?.cursor).toBe('OL200M');
  });

  it('partial updates preserve existing fields', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    await state.set({ url: 'https://dump.example/ol.gz', lastKeyCursor: 'OL100M' });
    await state.set({ totalProcessed: 42 });
    const row = await state.get();
    expect(row?.url).toBe('https://dump.example/ol.gz');
    expect(row?.cursor).toBe('OL100M');
    expect(row?.totalProcessed).toBe(42);
  });

  it('persists totalRecords', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    await state.set({ url: 'https://dump.example/ol.gz' });
    expect((await state.get())?.totalRecords).toBeNull();
    await state.set({ totalRecords: 41_619_418 });
    expect((await state.get())?.totalRecords).toBe(41_619_418);
  });

  it('clears state', async () => {
    const { db } = await createTestDb();
    const state = new DumpState(db, 'ol-editions');
    await state.set({ lastKeyCursor: 'OL1M' });
    await state.clear();
    expect(await state.get()).toBeNull();
  });
});
