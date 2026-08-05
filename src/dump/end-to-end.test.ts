import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTestDb } from '../test-utils/db.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { runEditionsDumpImport } from './index.js';
import * as _s from '../db/schema.js';

function makeTsv(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(
      `/type/edition\t/books/OL${i}M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t` +
        `{"key":"/books/OL${i}M","type":"/type/edition","title":"Book ${i}","authors":[{"key":"/authors/OL${i}A","name":"Author ${i}"}],"isbn_13":["978000000000${i}"]}`,
    );
  }
  lines.push(`/type/work\t/works/OL999W\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/works/OL999W","type":"/type/work","title":"X"}`);
  lines.push(`/type/edition\t/books/OL888M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL888M","type":"/type/edition","title":"No ISBN"}`);
  return lines.join('\n') + '\n';
}

let dir: string;
let gzPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dump-e2e-'));
  gzPath = join(dir, 'dump.txt.gz');
  writeFileSync(gzPath, gzipSync(makeTsv(50)));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('runEditionsDumpImport (end-to-end)', () => {
  it('inserts every ISBN-bearing edition exactly once across 50 records', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'openlibrary_editions');
    const downloader = new HttpDownloader('https://x');

    const summary = await runEditionsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 10,
    });

    expect(summary.imported).toBe(50);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(db.select().from(_s.books).all()).toHaveLength(50);
    expect(state.get()!.complete).toBe(true);
    expect(state.get()!.totalProcessed).toBe(50);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);
  });

  it('a second run against the same dump is a no-op', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'openlibrary_editions');
    const downloader = new HttpDownloader('https://x');
    const opts = {
      db,
      state,
      downloader,
      gzPath,
      stateName: 'openlibrary_editions',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 10,
    };

    const first = await runEditionsDumpImport(opts);
    expect(first.imported).toBe(50);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);

    const second = await runEditionsDumpImport(opts);
    expect(second.imported).toBe(0);
    expect(db.select().from(_s.books).all()).toHaveLength(50);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);
  });
});
