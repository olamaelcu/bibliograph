import { describe, it, expect, beforeEach } from 'vitest';
import { DumpState } from './state.js';
import { createTestDb, clearAllTables } from '../test-utils/db.js';

const { db } = createTestDb();
const dump = new DumpState(db, 'openlibrary_editions');

beforeEach(() => clearAllTables(db));

describe('DumpState', () => {
  it('returns null when no state has been written', () => {
    expect(dump.get()).toBeNull();
  });

  it('writes and reads back a full state', () => {
    dump.set({
      url: 'https://openlibrary.org/data/ol_dump_editions_latest.txt.gz',
      filePath: '/tmp/dumps/ol_dump_editions_latest.txt.gz',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: 9_200_000_000,
      lastByteOffset: 1_234_567,
      lastKeyCursor: '/books/OL100M',
      totalProcessed: 5_000,
    });

    const row = dump.get();
    expect(row).not.toBeNull();
    expect(row!.url).toBe('https://openlibrary.org/data/ol_dump_editions_latest.txt.gz');
    expect(row!.filePath).toBe('/tmp/dumps/ol_dump_editions_latest.txt.gz');
    expect(row!.fileSize).toBe(9_200_000_000);
    expect(row!.lastByteOffset).toBe(1_234_567);
    expect(row!.lastKeyCursor).toBe('/books/OL100M');
    expect(row!.totalProcessed).toBe(5_000);
    expect(row!.complete).toBe(false);
    expect(row!.startedAt).toBeNull();
  });

  it('records startedAt on first set, keeps it on subsequent sets', () => {
    dump.set({
      url: 'https://x',
      filePath: '/tmp/x',
      startedAt: '2026-08-05T00:00:00.000Z',
    });
    const first = dump.get()!.startedAt;

    dump.set({ url: 'https://x', filePath: '/tmp/x', lastByteOffset: 100 });
    const second = dump.get()!.startedAt;
    expect(second).toBe(first);
  });

  it('marks complete', () => {
    dump.set({
      url: 'https://x',
      filePath: '/tmp/x',
      lastByteOffset: 9_200_000_000,
    });
    dump.markComplete();
    expect(dump.get()!.complete).toBe(true);
  });

  it('clears the row', () => {
    dump.set({ url: 'https://x', filePath: '/tmp/x' });
    dump.clear();
    expect(dump.get()).toBeNull();
  });

  it('isolates state per name', () => {
    const a = new DumpState(db, 'a');
    const b = new DumpState(db, 'b');
    a.set({ url: 'https://a', filePath: '/tmp/a' });
    b.set({ url: 'https://b', filePath: '/tmp/b' });
    expect(a.get()!.url).toBe('https://a');
    expect(b.get()!.url).toBe('https://b');
  });
});
