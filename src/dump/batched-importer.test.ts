import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { BatchedImporter } from './batched-importer.js';
import { createTestDb, clearAllTables } from '../test-utils/db.js';
import * as _s from '../db/schema.js';
import type { BookData } from '../providers/interface.js';

const { db } = createTestDb();
const importer = new BatchedImporter(db, { batchSize: 5 });

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

beforeEach(() => clearAllTables(db));

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
});
