import { describe, expect, it } from 'vitest';
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
});
