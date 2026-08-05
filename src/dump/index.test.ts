import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTestDb } from '../test-utils/db.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { SeekError } from './streamer.js';
import { runEditionsDumpImport } from './index.js';
import { BatchedImporter } from './batched-importer.js';

const TSV_LINES = [
  '/type/edition\t/books/OL1M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL1M","type":"/type/edition","title":"Dune","authors":[{"key":"/authors/OL1A","name":"Frank Herbert"}],"isbn_13":["9780441172719"]}',
  '/type/edition\t/books/OL2M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL2M","type":"/type/edition","title":"Dune Messiah","authors":[{"key":"/authors/OL1A","name":"Frank Herbert"}],"isbn_13":["9780441172726"]}',
  '/type/work\t/works/OL1W\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/works/OL1W","type":"/type/work","title":"Dune"}',
  '/type/edition\t/books/OL3M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL3M","type":"/type/edition","title":"Children of Dune","authors":[{"key":"/authors/OL1A","name":"Frank Herbert"}],"isbn_10":["0441104022"]}',
].join('\n') + '\n';

let dir: string;
let gzPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dump-orchestrator-'));
  gzPath = join(dir, 'dump.txt.gz');
  writeFileSync(gzPath, gzipSync(TSV_LINES));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function setUp(): { db: ReturnType<typeof createTestDb>['db']; state: DumpState; downloader: HttpDownloader } {
  const { db } = createTestDb();
  return {
    db,
    state: new DumpState(db, 'openlibrary_editions'),
    downloader: new HttpDownloader('https://x'),
  };
}

describe('runEditionsDumpImport', () => {
  it('imports three editions and skips the work', async () => {
    const { db, state, downloader } = setUp();
    const summary = await runEditionsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
    });
    expect(summary.imported).toBe(3);
    expect(summary.failed).toBe(0);
    expect(state.get()!.complete).toBe(true);
    expect(state.get()!.totalProcessed).toBe(3);
    expect(state.get()!.lastByteOffset).toBeGreaterThan(0);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);
  });

  it('is a no-op when state.complete is true and last_modified matches', async () => {
    const { db, state, downloader } = setUp();
    state.set({
      url: 'https://x',
      filePath: gzPath,
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: 1,
      lastByteOffset: 9_999_999_999,
      totalProcessed: 12,
      complete: true,
    });
    const downloaderSpy = vi.spyOn(downloader, 'download');
    const summary = await runEditionsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
    });
    expect(summary.imported).toBe(0);
    expect(downloaderSpy).not.toHaveBeenCalled();
    expect(state.get()!.lastByteOffset).toBe(9_999_999_999);
  });

  it('falls back to key replay when byte-offset seek fails', async () => {
    const { db, state, downloader } = setUp();
    state.set({
      url: 'https://x',
      filePath: gzPath,
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      lastByteOffset: 99_999_999,
      lastNumericCursor: 1,
      totalProcessed: 1,
    });
    const summary = await runEditionsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
    });
    expect(summary.imported).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it('throws a helpful error when disk space check fails', async () => {
    const { db, state, downloader } = setUp();
    await expect(runEditionsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/insufficient disk space/);
  });

  it('does not advance cursor when a batch retry is exhausted', async () => {
    const { db, state, downloader } = setUp();
    state.set({
      url: 'https://x',
      filePath: gzPath,
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      lastByteOffset: 0,
      lastKeyCursor: null,
      lastNumericCursor: 0,
      totalProcessed: 0,
    });
    const failingFactory = (_d: unknown, _b: unknown) => {
      const fakeDb = createTestDb().db;
      (fakeDb as any).transaction = () => { throw new Error('disk full'); };
      return new BatchedImporter(fakeDb as never, { batchSize: 5 });
    };
    await expect(runEditionsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      importFactory: failingFactory as never,
    })).rejects.toThrow(/disk full/);
    const after = state.get()!;
    expect(after.lastNumericCursor).toBe(0);
    expect(after.lastKeyCursor).toBeNull();
    expect(after.complete).toBe(false);
  });

  it('does not early-return when lastModified is null (forces a real attempt)', async () => {
    const { db, state, downloader } = setUp();
    state.set({
      url: 'https://x',
      filePath: gzPath,
      lastModified: null,
      fileSize: 1,
      lastByteOffset: 1,
      totalProcessed: 5,
      complete: true,
    });
    const summary = await runEditionsDumpImport({
      db, state, downloader, gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: null,
      fileSize: null,
      fetchMetadata: async () => ({ lastModified: null, contentLength: null }),
    });
    expect(summary.imported).toBe(3);
  });
});
