import { describe, expect, it } from 'vitest';
import { books } from '../db/schema.js';
import { createTestDb } from '../test-utils/db.js';
import { importInBatches } from './batched-importer.js';

async function* gen<T>(items: T[]): AsyncGenerator<T, void, void> {
  for (const i of items) yield i;
}

describe('importInBatches', () => {
  it('counts inserted / skipped / failed', async () => {
    const { db } = createTestDb();
    const summary = await importInBatches(db, gen([1, 2, 3]), {
      batchSize: 2,
      upsert: (n) => {
        if (n === 2) throw new Error('boom');
        return { action: 'inserted' };
      },
    });
    expect(summary.processed).toBe(3);
    expect(summary.inserted).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('is atomic per record at the DB level: failing record absent, batch siblings present', async () => {
    const { db } = createTestDb();
    const now = Math.floor(Date.now() / 1000);

    const summary = await importInBatches(db, gen([{ pk: 'book-good' }, { pk: 'book-bad' }, { pk: 'book-good2' }]), {
      batchSize: 3,
      upsert: ({ pk }) => {
        if (pk === 'book-bad') throw new Error('boom');
        db.insert(books).values({ pk, title: pk, createdAt: now, releaseStatus: 'staged' }).run();
        return { action: 'inserted' };
      },
    });

    const pks = db.select().from(books).all().map((r) => r.pk);
    expect(pks).toContain('book-good');
    expect(pks).toContain('book-good2');
    expect(pks).not.toContain('book-bad');
    expect(summary.inserted).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('reports progress with the known total after each flushed batch', async () => {
    const { db } = createTestDb();
    const calls: Array<{ processed: number; total: number | null }> = [];
    await importInBatches(db, gen([1, 2, 3, 4, 5]), {
      batchSize: 2,
      total: 5,
      onProgress: (processed, total) => calls.push({ processed, total }),
      upsert: () => ({ action: 'inserted' }),
    });
    // Two full batches + one trailing flush.
    expect(calls).toEqual([
      { processed: 2, total: 5 },
      { processed: 4, total: 5 },
      { processed: 5, total: 5 },
    ]);
  });

  it('passes total null when unknown', async () => {
    const { db } = createTestDb();
    const calls: Array<{ processed: number; total: number | null }> = [];
    await importInBatches(db, gen([1]), {
      batchSize: 1,
      onProgress: (processed, total) => calls.push({ processed, total }),
      upsert: () => ({ action: 'inserted' }),
    });
    expect(calls).toEqual([{ processed: 1, total: null }]);
  });
});
