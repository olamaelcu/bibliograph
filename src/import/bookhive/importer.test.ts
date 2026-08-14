import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { importBookhiveCatalog } from './importer.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const listRecordsMock = vi.fn();

vi.mock('@atcute/client', () => ({
  Client: class {
    get() {
      return listRecordsMock();
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

  it('imports pages and advances cursor', async () => {
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
    const res = await importBookhiveCatalog({ db, lockPath: join(lockDir, 'lock') });
    expect(res.processed).toBe(2);
    expect(listRecordsMock).toHaveBeenCalledTimes(2);
    rmSync(lockDir, { recursive: true, force: true });
  });
});
