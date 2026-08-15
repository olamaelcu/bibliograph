import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { importBookhiveCatalog } from './importer.js';
import { backfillReservation } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const listRecordsMock = vi.fn();

vi.mock('@atcute/client', () => ({
  Client: class {
    get(method: string, opts: unknown) {
      return listRecordsMock(method, opts);
    }
  },
  simpleFetchHandler: () => undefined,
}));

describe('importBookhiveCatalog', () => {
  beforeEach(() => {
    listRecordsMock.mockReset();
    process.env.BOOKHIVE_PDS_URL = 'https://pds.test';
    process.env.BOOKHIVE_CATALOG_DID = 'did:web:test';
  });

  function reservationFor(db: ReturnType<typeof createTestDb>['db']) {
    return db.select().from(backfillReservation).where(eq(backfillReservation.stateName, 'bookhive-catalog')).get();
  }

  it('imports pages, advances the cursor, and releases the lock and reservation', async () => {
    listRecordsMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          records: [
            { uri: 'at://did:web:test/buzz.bookhive.catalogBook/a', value: { hiveId: 'h1', title: 'Alpha', author: 'Ada' } },
            { uri: 'at://did:web:test/buzz.bookhive.catalogBook/b', value: { hiveId: 'h2', title: 'Beta', author: 'Bob' } },
          ],
          cursor: 'cursor-2',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { records: [], cursor: undefined },
      });

    const { db } = createTestDb();
    const lockDir = mkdtempSync(join(tmpdir(), 'bookhive-lock-'));
    const lockPath = join(lockDir, 'lock');
    const res = await importBookhiveCatalog({ db, lockPath });
    expect(res.processed).toBe(2);
    expect(res.failed).toBe(0);
    expect(listRecordsMock).toHaveBeenCalledTimes(2);
    expect(listRecordsMock.mock.calls[1]?.[1]?.params?.cursor).toBe('cursor-2');
    expect(existsSync(lockPath)).toBe(false);
    expect(reservationFor(db)).toBeUndefined();
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('skips re-import when the state is already complete unless reset', async () => {
    listRecordsMock.mockResolvedValueOnce({ ok: true, data: { records: [], cursor: undefined } });
    const { db } = createTestDb();
    const lockDir = mkdtempSync(join(tmpdir(), 'bookhive-lock-'));
    const lockPath = join(lockDir, 'lock');
    await importBookhiveCatalog({ db, lockPath });
    expect(listRecordsMock).toHaveBeenCalledTimes(1);

    const res = await importBookhiveCatalog({ db, lockPath });
    expect(res.processed).toBe(0);
    expect(listRecordsMock).toHaveBeenCalledTimes(1);

    listRecordsMock.mockResolvedValueOnce({ ok: true, data: { records: [], cursor: undefined } });
    const resetRes = await importBookhiveCatalog({ db, lockPath, reset: true });
    expect(listRecordsMock).toHaveBeenCalledTimes(2);
    expect(resetRes.processed).toBe(0);
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('rejects on API failure and still releases the lock and reservation', async () => {
    listRecordsMock.mockResolvedValueOnce({
      ok: false,
      data: { error: 'AuthRequired', message: 'x' },
    });
    const { db } = createTestDb();
    const lockDir = mkdtempSync(join(tmpdir(), 'bookhive-lock-'));
    const lockPath = join(lockDir, 'lock');
    await expect(importBookhiveCatalog({ db, lockPath })).rejects.toThrow('AuthRequired');
    expect(existsSync(lockPath)).toBe(false);
    expect(reservationFor(db)).toBeUndefined();
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('retries a transient fetch failure and continues the import', async () => {
    listRecordsMock
      .mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }),
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: {
          records: [
            { uri: 'at://did:web:test/buzz.bookhive.catalogBook/c', value: { hiveId: 'h3', title: 'Gamma', author: 'Cara' } },
          ],
          cursor: undefined,
        },
      });

    const { db } = createTestDb();
    const lockDir = mkdtempSync(join(tmpdir(), 'bookhive-lock-'));
    const lockPath = join(lockDir, 'lock');
    const res = await importBookhiveCatalog({ db, lockPath });
    expect(res.processed).toBe(1);
    expect(listRecordsMock).toHaveBeenCalledTimes(2);
    expect(existsSync(lockPath)).toBe(false);
    expect(reservationFor(db)).toBeUndefined();
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('rejects on a non-transient fetch failure and releases the lock and reservation', async () => {
    listRecordsMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('boom') }));
    const { db } = createTestDb();
    const lockDir = mkdtempSync(join(tmpdir(), 'bookhive-lock-'));
    const lockPath = join(lockDir, 'lock');
    await expect(importBookhiveCatalog({ db, lockPath })).rejects.toThrow('fetch failed');
    expect(existsSync(lockPath)).toBe(false);
    expect(reservationFor(db)).toBeUndefined();
    rmSync(lockDir, { recursive: true, force: true });
  });
});
