import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { BatchedImporter } from './batched-importer.js';
import { createTestDb, clearAllTables } from '../test-utils/db.js';
import * as _s from '../db/schema.js';
import type { BookData } from '../providers/interface.js';

const { db } = createTestDb();
let importer: BatchedImporter;

function makeBook(i: number): BookData {
  return {
    title: `Book ${i}`,
    author: 'Author',
    isbn13: `978000000000${i}`,
    publishedDate: '2020',
    identifiers: { openlibrary: `/books/OL${i}M` },
    sourceProvider: 'openlibrary',
  };
}

beforeEach(() => {
  clearAllTables(db);
  importer = new BatchedImporter(db, { batchSize: 5 });
});

describe('BatchedImporter', () => {
  it('inserts rows in chunks of batchSize', async () => {
    const summary = await importer.runAll(
      Array.from({ length: 12 }, (_, i) => makeBook(i)),
    );
    expect(summary.imported).toBe(12);
    expect(db.select().from(_s.books).all()).toHaveLength(12);
  });

  it('skips rows whose ISBN already exists', async () => {
    await importer.runAll([makeBook(0)]);
    const summary = await importer.runAll([makeBook(0)]);
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(_s.books).all()).toHaveLength(1);
  });

  it('shares dedup keys across runAll invocations when constructed with shared seen', async () => {
    const seen = new Set<string>();
    const a = new BatchedImporter(db, { batchSize: 5, seen });
    await a.runAll([makeBook(0)]);
    expect(seen).toContain('/books/OL0M');
    const b = new BatchedImporter(db, { batchSize: 5, seen });
    const summary = await b.runAll([makeBook(0), makeBook(1)]);
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('continues past per-row failures and counts them', async () => {
    const bad: BookData = {
      ...makeBook(0),
      title: '',
      author: '',
    };
    const ok1 = makeBook(1);
    const ok2 = makeBook(2);
    const summary = await importer.runAll([bad, ok1, ok2]);
    expect(summary.imported).toBeGreaterThanOrEqual(1);
  });

  it('emits at least one flush when input crosses batch boundary', async () => {
    let flushes = 0;
    const counter = new BatchedImporter(db, { batchSize: 3, onFlush: () => { flushes += 1; } });
    await counter.runAll(Array.from({ length: 7 }, (_, i) => makeBook(i)));
    expect(flushes).toBeGreaterThanOrEqual(2);
  });

  it('maps sourceProvider=openlibrary onto identifiers.openlibrary', async () => {
    await importer.runAll([makeBook(7)]);
    const row = db.select().from(_s.books).where(eq(_s.books.isbn, '9780000000007')).get()!;
    const idents = typeof row.identifiers === 'string' ? JSON.parse(row.identifiers) : row.identifiers;
    expect(idents).toContainEqual({ type: 'openlibrary', value: '/books/OL7M' });
  });

  it('throws (without partial state) when transaction fails twice', async () => {
    const localDb = createTestDb().db;
    (localDb as any).transaction = () => { throw new Error('disk full'); };
    const failing = new BatchedImporter(localDb, { batchSize: 5 });
    await expect(failing.runAll([makeBook(0), makeBook(1)])).rejects.toThrow(/disk full/);
    expect(localDb.select().from(_s.books).all()).toHaveLength(0);
  });

  it('retries once and succeeds if the second transaction attempt works', async () => {
    const localDb = createTestDb().db;
    let calls = 0;
    const realTransaction = localDb.transaction.bind(localDb);
    (localDb as any).transaction = (fn: (...args: unknown[]) => unknown) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return realTransaction(fn);
    };
    const recovering = new BatchedImporter(localDb, { batchSize: 5 });
    const summary = await recovering.runAll([makeBook(0), makeBook(1)]);
    expect(calls).toBe(2);
    expect(summary.imported).toBe(2);
    expect(localDb.select().from(_s.books).all()).toHaveLength(2);
  });

  it('honors AbortSignal between batches', async () => {
    const controller = new AbortController();
    controller.abort();
    const signaled = new BatchedImporter(db, { batchSize: 5, signal: controller.signal });
    await expect(signaled.runAll([makeBook(0), makeBook(1)])).rejects.toThrow(/aborted/);
    expect(db.select().from(_s.books).all()).toHaveLength(0);
  });
});
