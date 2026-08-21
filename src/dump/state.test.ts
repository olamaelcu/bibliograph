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

	it('persists lastByteOffset and fileSize values beyond INT4 max', async () => {
		// Regression for the August 2026 crash where uncompressed OL dumps
		// exceeded 2 GB and the import checkpoint hit "value out of range for
		// type integer" on backfill_state.last_byte_offset / file_size.
		const { db } = await createTestDb();
		const state = new DumpState(db, 'ol-editions');
		await state.set({ fileSize: 4_500_000_000, lastByteOffset: 2_800_000_000 });
		const row = await state.get();
		expect(row?.fileSize).toBe(4_500_000_000);
		expect(row?.lastByteOffset).toBe(2_800_000_000);
	});

	it('partial update does not null out unspecified fields (regression for total_records overwrite)', async () => {
		// Regression for the August 2026 ol-works import where onCheckpoint
		// partial updates overwrote total_records with null because the chained
		// `??` fallback in state.set fell through to null when the caller didn't
		// pass a field and the existing value was also null. The fix: only
		// include a column in the SET clause when explicitly passed OR when the
		// existing row has a non-null value to keep.
		const { db } = await createTestDb();
		const state = new DumpState(db, 'ol-editions');
		await state.set({ totalRecords: 41_619_418, totalProcessed: 100 });
		const afterFirst = await state.get();
		expect(afterFirst?.totalRecords).toBe(41_619_418);
		expect(afterFirst?.totalProcessed).toBe(100);

		// Simulate an onCheckpoint that updates only totalProcessed.
		await state.set({ totalProcessed: 200 });
		const afterSecond = await state.get();
		expect(afterSecond?.totalRecords).toBe(41_619_418); // preserved
		expect(afterSecond?.totalProcessed).toBe(200);

		// An explicit null still clears the column (the legacy "clear" behavior).
		await state.set({ totalRecords: null as unknown as number });
		const afterClear = await state.get();
		expect(afterClear?.totalRecords).toBeNull();

		// A fresh row with no fields preserves the schema defaults (null everywhere).
		const fresh = new DumpState(db, 'ol-fresh');
		await fresh.set({ stopped: false });
		const freshRow = await fresh.get();
		expect(freshRow?.stopped).toBe(0);
		expect(freshRow?.totalRecords).toBeNull();
		expect(freshRow?.totalProcessed).toBeNull();
	});
});
