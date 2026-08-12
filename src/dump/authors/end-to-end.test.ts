import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getTableName } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { DumpState } from '../state.js';
import { HttpDownloader } from '../downloader.js';
import { runAuthorsDumpImport } from './batched-importer.js';
import * as _s from '../../db/schema.js';

function makeTsv(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    lines.push(
      `/type/author\t/authors/OL${i}A\t1\tWed, 01 Jan 2026 00:00:00 GMT\t` +
        `{"key":"/authors/OL${i}A","type":"/type/author","name":"Author ${i}","alternate_names":["A${i}"]}`,
    );
  }
  lines.push(`/type/work\t/works/OL999W\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/works/OL999W","type":"/type/work","title":"X"}`);
  lines.push(`/type/author\t/authors/OL888A\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/authors/OL888A","type":"/type/author"}`);
  lines.push(`/type/author\t/authors/OL777A\t1\tWed, 01 Jan 2026 00:00:00 GMT\tnot-json`);
  return lines.join('\n') + '\n';
}

let dir: string;
let gzPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authors-e2e-'));
  gzPath = join(dir, 'authors.txt.gz');
  writeFileSync(gzPath, gzipSync(makeTsv(50)));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('runAuthorsDumpImport (end-to-end)', () => {
  it('inserts every well-formed author exactly once across 50 records', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'authors');
    const downloader = new HttpDownloader('https://x');

    const summary = await runAuthorsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'authors',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 10,
    });

    expect(summary.imported).toBe(50);
    expect(summary.failed).toBe(0);
    const rows = db.select().from(_s.contributors).all();
    expect(rows).toHaveLength(50);
    const row = rows[0]!;
    const idents = typeof row.identifiers === 'string' ? JSON.parse(row.identifiers) : row.identifiers;
    expect(idents).toEqual([{ type: 'openlibrary', value: '/authors/OL1A' }]);
    expect(state.get()!.complete).toBe(true);
    expect(state.get()!.totalProcessed).toBe(50);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);
  });

  it('skips rows missing a name and rows missing a key without counting as imports', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'authors');
    const downloader = new HttpDownloader('https://x');

    const summary = await runAuthorsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'authors',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 100,
    });

    expect(summary.imported).toBe(50);
    expect(summary.failed).toBe(0);
    expect(db.select().from(_s.contributors).all()).toHaveLength(50);
  });

  it('a second run against the same dump is a no-op', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'authors');
    const downloader = new HttpDownloader('https://x');
    const opts = {
      db,
      state,
      downloader,
      gzPath,
      stateName: 'authors',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 10,
    };

    const first = await runAuthorsDumpImport(opts);
    expect(first.imported).toBe(50);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);

    const second = await runAuthorsDumpImport(opts);
    expect(second.imported).toBe(0);
    expect(db.select().from(_s.contributors).all()).toHaveLength(50);
    expect(state.get()!.lastByteOffset).toBe(statSync(gzPath).size);
    expect(state.get()!.totalProcessed).toBe(50);
  });

  it('clears the backfill_reservation row on exit (releases the reservation)', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'authors');
    const downloader = new HttpDownloader('https://x');

    await runAuthorsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'authors',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 100,
    });

    const rows = db.select().from(_s.backfillReservation).all();
    expect(rows).toHaveLength(0);
  });

  it('acquires and releases the authors reservation across a run', async () => {
    const { db } = createTestDb();
    const state = new DumpState(db, 'authors');
    const downloader = new HttpDownloader('https://x');

    let reservationRowObserved = false;
    const origInsert = db.insert.bind(db);
    const origDelete = db.delete.bind(db);
    vi.spyOn(db, 'insert').mockImplementation(((target: unknown) => {
      if (getTableName(target as never) === 'backfill_reservation') reservationRowObserved = true;
      return origInsert(target as never);
    }) as never);
    vi.spyOn(db, 'delete').mockImplementation(((target: unknown) => {
      if (getTableName(target as never) === 'backfill_reservation') reservationRowObserved = true;
      return origDelete(target as never);
    }) as never);

    await runAuthorsDumpImport({
      db,
      state,
      downloader,
      gzPath,
      stateName: 'authors',
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: statSync(gzPath).size,
      batchSize: 100,
    });

    expect(reservationRowObserved).toBe(true);
    expect(db.select().from(_s.backfillReservation).all()).toHaveLength(0);
  });
});
