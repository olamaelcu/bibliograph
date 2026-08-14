import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { books, contributors, works } from '../db/schema.js';

describe('images:refresh cover derivation', () => {
  const origArgv = process.argv;
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let fetchBookCoverCalls: unknown[][] = [];
  let fetchPortraitCalls: unknown[][] = [];
  let defaultDb: unknown;

  beforeEach(() => {
    vi.resetModules();
    fetchBookCoverCalls = [];
    fetchPortraitCalls = [];
  });
  afterEach(() => {
    process.argv = origArgv;
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    vi.restoreAllMocks();
  });

  async function run(cmdArgs: string[], dbOverride?: unknown) {
    if (dbOverride) defaultDb = dbOverride;
    vi.doMock('../storage/store.js', () => ({
      BlobStore: class { async put() { return { url: 'blob://x' }; } },
      blobStoreConfigFromEnv: () => ({ scheme: 'memory' }),
    }));
    vi.doMock('../images/fetch.js', () => ({
      fetchBookCover: (...args: unknown[]) => { fetchBookCoverCalls.push(args as unknown[]); return Promise.resolve({ fetched: true, url: 'blob://x' }); },
      fetchContributorPortrait: (...args: unknown[]) => { fetchPortraitCalls.push(args as unknown[]); return Promise.resolve({ fetched: false, url: null }); },
    }));
    vi.doMock('../db/connection.js', () => ({ db: defaultDb }));
    const logger = await import('../logger.js');
    vi.spyOn(logger.logger, 'info').mockImplementation(() => {});
    (process as { exit: unknown }).exit = ((c: number) => { throw new Error('exit:' + c); }) as never;
    process.argv = ['node', 'x', ...cmdArgs] as never;
    const cli = await import('./cli.js');
    await cli.main();
  }

  it('derives olid URL from openlibrary identifier', async () => {
    const { db, sqlite } = createTestDb();
    db.insert(works).values({ pk: 'work-dune', title: 'Dune', createdAt: 0, releaseStatus: 'released' }).run();
    db.insert(books).values({ pk: 'books/ol123m', title: 'Dune', workPk: 'work-dune', createdAt: 0, releaseStatus: 'released' }).run();
    db.insert(contributors).values({ pk: 'c1', name: 'N', createdAt: 0, releaseStatus: 'released' }).run();
    sqlite.prepare('INSERT INTO book_identifiers (book_pk, resource, url) VALUES (?, ?, ?)')
      .run('books/ol123m', 'openlibrary:books/OL123M', 'https://openlibrary.org/books/OL123M');

    await run(['images:refresh', '--batch-size=1'], db);

    expect(fetchBookCoverCalls).toHaveLength(1);
    const args = fetchBookCoverCalls[0] as [unknown, unknown, string, string];
    expect(args[2]).toBe('books/ol123m');
    expect(args[3]).toBe('https://covers.openlibrary.org/b/olid/OL123M-L.jpg');
  });

  it('falls back to isbn when no openlibrary id exists', async () => {
    const { db, sqlite } = createTestDb();
    db.insert(works).values({ pk: 'work-dune', title: 'Dune', createdAt: 0, releaseStatus: 'released' }).run();
    db.insert(books).values({ pk: 'books/ol456w', title: 'We', workPk: 'work-dune', createdAt: 0, releaseStatus: 'released' }).run();
    db.insert(contributors).values({ pk: 'c1', name: 'N', createdAt: 0, releaseStatus: 'released' }).run();
    sqlite.prepare('INSERT INTO book_identifiers (book_pk, resource, url) VALUES (?, ?, ?)')
      .run('books/ol456w', 'isbn:9780000000001', 'https://openlibrary.org/isbn/9780000000001');

    await run(['images:refresh', '--batch-size=1'], db);

    expect(fetchBookCoverCalls).toHaveLength(1);
    const args = fetchBookCoverCalls[0] as [unknown, unknown, string, string];
    expect(args[3]).toBe('https://covers.openlibrary.org/b/isbn/9780000000001-L.jpg');
  });
});
