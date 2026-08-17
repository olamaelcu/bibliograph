import { describe, expect, it } from 'vitest';
import { books } from '../db/schema.js';
import { createTestDb } from '../test-utils/db.js';
import { importInBatches } from './batched-importer.js';

async function* gen<T>(items: T[]): AsyncGenerator<T, void, void> {
  for (const i of items) yield i;
}

describe('importInBatches', () => {
  it('counts inserted / skipped / failed', async () => {
    const { db } = await createTestDb();
    const summary = await importInBatches(db, gen([1, 2, 3]), {
      batchSize: 2,
      upsert: (_tx, n) => {
        if (n === 2) throw new Error('boom');
        return { action: 'inserted' };
      },
    });
    expect(summary.processed).toBe(3);
    expect(summary.inserted).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('is atomic per record at the DB level: failing record absent, batch siblings present', async () => {
    const { db } = await createTestDb();
    const now = Math.floor(Date.now() / 1000);

    const summary = await importInBatches(db, gen([{ pk: 'book-good' }, { pk: 'book-bad' }, { pk: 'book-good2' }]), {
      batchSize: 3,
      upsert: async (tx, { pk }) => {
        if (pk === 'book-bad') throw new Error('boom');
        await tx.insert(books).values({ pk, title: pk, createdAt: now, releaseStatus: 'staged' });
        return { action: 'inserted' };
      },
    });

    const pks = (await db.select().from(books)).map((r) => r.pk);
    expect(pks).toContain('book-good');
    expect(pks).toContain('book-good2');
    expect(pks).not.toContain('book-bad');
    expect(summary.inserted).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('reports progress with the known total after each flushed batch', async () => {
    const { db } = await createTestDb();
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

  it('fires onCheckpoint after each flushed batch with its last item', async () => {
    const { db } = await createTestDb();
    const calls: Array<{ processed: number; lastItem: string }> = [];
    await importInBatches(db, gen(['a', 'b', 'c', 'd', 'e']), {
      batchSize: 2,
      onCheckpoint: (processed, lastItem) => calls.push({ processed, lastItem }),
      upsert: () => ({ action: 'inserted' }),
    });
    expect(calls).toEqual([
      { processed: 2, lastItem: 'b' },
      { processed: 4, lastItem: 'd' },
      { processed: 5, lastItem: 'e' },
    ]);
  });

  it('passes total null when unknown', async () => {
    const { db } = await createTestDb();
    const calls: Array<{ processed: number; total: number | null }> = [];
    await importInBatches(db, gen([1]), {
      batchSize: 1,
      onProgress: (processed, total) => calls.push({ processed, total }),
      upsert: () => ({ action: 'inserted' }),
    });
    expect(calls).toEqual([{ processed: 1, total: null }]);
  });

  it('fires afterBatch after each flushed batch with that batch, including the trailing partial one', async () => {
    const { db } = await createTestDb();
    const calls: string[][] = [];
    await importInBatches(db, gen(['a', 'b', 'c', 'd', 'e']), {
      batchSize: 2,
      afterBatch: (batch) => calls.push([...batch]),
      upsert: () => ({ action: 'inserted' }),
    });
    expect(calls).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('fires afterBatch after the batch transaction commits (writes visible to it)', async () => {
    const { db } = await createTestDb();
    const seen: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    await importInBatches(db, gen([{ pk: 'book-x' }, { pk: 'book-y' }]), {
      batchSize: 2,
      upsert: (tx, { pk }) => {
        const p = tx.insert(books).values({ pk, title: pk, createdAt: now, releaseStatus: 'staged' });
        return p.then(() => ({ action: 'inserted' as const }));
      },
      afterBatch: async (batch) => {
        seen.push(...batch.map((b) => b.pk));
        // The inserted rows must be committed and readable here (runs after the tx).
        const rows = await db.select().from(books);
        expect(rows.map((r) => r.pk).sort()).toEqual(['book-x', 'book-y']);
      },
    });
    expect(seen).toEqual(['book-x', 'book-y']);
  });

  it('stops at the next batch boundary when the signal aborts mid-stream', async () => {
    const { db } = await createTestDb();
    const controller = new AbortController();
    const source = (async function* () {
      yield 1;
      yield 2;
      controller.abort(new Error('stopped by test'));
      yield 3;
      yield 4;
    })();

    const checkpoints: Array<number> = [];
    await expect(
      importInBatches(db, source, {
        batchSize: 2,
        signal: controller.signal,
        onCheckpoint: (processed) => checkpoints.push(processed),
        upsert: () => ({ action: 'inserted' }),
      }),
    ).rejects.toThrow('stopped by test');
    expect(checkpoints).toEqual([2]);
  });

  it('stops before processing any item when aborted before the loop starts', async () => {
    const { db } = await createTestDb();
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    const called: boolean[] = [];
    await expect(
      importInBatches(db, gen([1, 2, 3]), {
        signal: controller.signal,
        upsert: () => {
          called.push(true);
          return { action: 'inserted' };
        },
      }),
    ).rejects.toThrow('pre-aborted');
    expect(called).toEqual([]);
  });
});
