import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, clearSqliteTables } from '../test-utils/db.js';
import { schema } from '../db/connection.js';
import { BookhiveCatalogState } from './state.js';
import { runCatalogImport } from './index.js';
import type { ListRecordsFn, ListRecordsResponse } from './streamer.js';
import { COLLECTIONS, makeRecordUri } from '../records.js';
import { generateRkey } from '../rkey.js';

const SERVICE_DID = 'did:plc:service';
const CATALOG_DID = 'did:plc:bookhive';
const STATE_NAME = 'bookhive_catalog';
process.env.ATP_SERVICE_DID = SERVICE_DID;

const { db } = createTestDb();

function seedAuthorRole(): void {
  const rkey = generateRkey();
  db.insert(schema.contributorTypes)
    .values({
      uri: makeRecordUri(SERVICE_DID, COLLECTIONS.contributorType, rkey),
      did: SERVICE_DID,
      name: 'author',
      description: 'Original writer of the work.',
      createdAt: new Date().toISOString(),
    })
    .run();
}

function fixtureRecords(count: number): ListRecordsResponse {
  const records = [];
  for (let i = 0; i < count; i++) {
    const id = `BK${String(i).padStart(4, '0')}`;
    records.push({
      uri: `at://${CATALOG_DID}/buzz.bookhive.catalogBook/${id}`,
      cid: `cid-${id}`,
      value: {
        $type: 'buzz.bookhive.catalogBook',
        id: `hive-${id}`,
        title: `Book ${id}`,
        authors: i % 2 === 0 ? 'Frank Herbert' : 'Isaac Asimov',
        thumbnail: `https://bookhive.buzz/c/${id}.jpg`,
        identifiers: { isbn13: `97804411727${String(i).padStart(2, '0')}` },
        createdAt: '2026-01-15T12:00:00.000Z',
        updatedAt: '2026-02-20T18:30:00.000Z',
      },
    });
  }
  return { records, cursor: undefined };
}

const paginatedListRecords = (page: number): ListRecordsFn => {
  return async (opts) => {
    const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const totalCount = 25; // 25 fixture records total
    const end = Math.min(start + page, totalCount);
    const response = fixtureRecords(totalCount);
    if (end >= totalCount) {
      return { records: response.records.slice(start), cursor: undefined };
    }
    return { records: response.records.slice(start, end), cursor: String(end) };
  };
};

beforeEach(() => {
  clearSqliteTables((db as any).$sqlite);
  seedAuthorRole();
});

describe('runCatalogImport', () => {
  it('imports all 25 records across pages into the books table', async () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    const summary = await runCatalogImport(db, {
      state,
      catalogDid: CATALOG_DID,
      pdsUrl: 'https://bookhive.buzz',
      pageSize: 10,
      batchSize: 5,
      listRecords: paginatedListRecords(10),
    });

    expect(summary.imported).toBe(25);
    expect(summary.failed).toBe(0);

    const bookCount = db.select().from(schema.books).all().length;
    expect(bookCount).toBe(25);

    const contributors = db.select().from(schema.contributors).all();
    expect(contributors).toHaveLength(2); // dedup by name across all 25 records
    const contributorNames = contributors.map((c) => c.name).sort();
    expect(contributorNames).toEqual(['Frank Herbert', 'Isaac Asimov']);

    // join rows: 13 even-indexed for Frank Herbert + 12 odd for Asimov = 25
    const join = db.select().from(schema.bookContributors).all();
    expect(join).toHaveLength(25);
  });

  it('writes the catalogDid into state and marks complete on finish', async () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    const listRecords: ListRecordsFn = async () => ({
      records: [
        {
          uri: `at://${CATALOG_DID}/buzz.bookhive.catalogBook/AAA`,
          cid: 'cid-a',
          value: {
            $type: 'buzz.bookhive.catalogBook',
            id: 'hive-AAA',
            title: 'Alpha',
            authors: 'Alice',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
      cursor: undefined,
    });

    await runCatalogImport(db, {
      state,
      catalogDid: CATALOG_DID,
      pdsUrl: 'https://bookhive.buzz',
      pageSize: 100,
      batchSize: 500,
      listRecords,
    });

    const row = state.get();
    expect(row).not.toBeNull();
    expect(row!.catalogDid).toBe(CATALOG_DID);
    expect(row!.complete).toBe(true);
    expect(row!.totalProcessed).toBe(1);
  });

  it('is idempotent: a re-run with the same already-complete state is a no-op', async () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    state.set({ catalogDid: CATALOG_DID, lastRkey: 'AAA', totalProcessed: 1, complete: true });

    let listCalls = 0;
    const listRecords: ListRecordsFn = async () => {
      listCalls++;
      return { records: [], cursor: undefined };
    };

    const summary = await runCatalogImport(db, {
      state,
      catalogDid: CATALOG_DID,
      pdsUrl: 'https://bookhive.buzz',
      pageSize: 100,
      batchSize: 500,
      listRecords,
    });

    expect(summary.imported).toBe(0);
    expect(listCalls).toBe(0); // short-circuited, never reached the network
  });

  it('aborts between batches when the signal fires', async () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    const controller = new AbortController();

    const summary = await runCatalogImport(db, {
      state,
      catalogDid: CATALOG_DID,
      pdsUrl: 'https://bookhive.buzz',
      pageSize: 5,
      batchSize: 5,
      listRecords: paginatedListRecords(5),
      batchCheckpoint: () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    expect(summary.imported).toBeGreaterThan(0);
    expect(summary.aborted).toBe(true);

    // checkpoint is persisted (rkey of last seen record)
    const row = state.get();
    expect(row).not.toBeNull();
    expect(row!.complete).toBe(false);
  });

  it('resumes from the last persisted cursor', async () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    // simulate prior progress: cursor was 'resume-token-xyz', 10 records imported
    state.set({ catalogDid: CATALOG_DID, lastRkey: 'resume-token-xyz', totalProcessed: 10 });

    let firstCallCursor: string | undefined;
    const listRecords: ListRecordsFn = async (opts) => {
      if (firstCallCursor === undefined) firstCallCursor = opts.cursor;
      // First call: returning just 3 records (the remainder), then cursor=null
      return {
        records: [
          {
            uri: `at://${CATALOG_DID}/buzz.bookhive.catalogBook/BK0022`,
            cid: 'cid-22',
            value: {
              $type: 'buzz.bookhive.catalogBook',
              id: 'hive-BK0022',
              title: 'Book BK0022',
              authors: 'Frank Herbert',
              identifiers: { isbn13: '9780441172799' },
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          },
          {
            uri: `at://${CATALOG_DID}/buzz.bookhive.catalogBook/BK0023`,
            cid: 'cid-23',
            value: {
              $type: 'buzz.bookhive.catalogBook',
              id: 'hive-BK0023',
              title: 'Book BK0023',
              authors: 'Frank Herbert',
              identifiers: { isbn13: '9780441172812' },
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          },
          {
            uri: `at://${CATALOG_DID}/buzz.bookhive.catalogBook/BK0024`,
            cid: 'cid-24',
            value: {
              $type: 'buzz.bookhive.catalogBook',
              id: 'hive-BK0024',
              title: 'Book BK0024',
              authors: 'Frank Herbert',
              identifiers: { isbn13: '9780441172829' },
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
        cursor: undefined,
      };
    };

    const summary = await runCatalogImport(db, {
      state,
      catalogDid: CATALOG_DID,
      pdsUrl: 'https://bookhive.buzz',
      pageSize: 25,
      batchSize: 5,
      listRecords,
    });

    expect(firstCallCursor).toBe('resume-token-xyz');
    expect(summary.imported).toBe(3); // 3 records returned on resume
    expect(summary.failed).toBe(0);
  });

  it('skips records whose hiveId identifier already exists in the books table', async () => {
    const state = new BookhiveCatalogState(db, STATE_NAME);
    // simulate a previously-imported hiveId
    const priorUri = `at://${SERVICE_DID}/community.lexicon.book.book/${'prior11111'.padEnd(13, 'x')}`;
    db.insert(schema.books)
      .values({
        uri: priorUri,
        did: SERVICE_DID,
        title: 'Existing',
        author: 'Frank Herbert',
        isbn: '9780441172726',
        status: 'active',
        identifiers: [{ type: 'hiveId', value: 'hive-BK0001' }],
        categories: [],
        contributors: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const listRecords: ListRecordsFn = async () => fixtureRecords(25);

    const summary = await runCatalogImport(db, {
      state,
      catalogDid: CATALOG_DID,
      pdsUrl: 'https://bookhive.buzz',
      pageSize: 100,
      batchSize: 500,
      listRecords,
    });

    expect(summary.imported).toBe(24); // 25 - 1 already-imported hiveId
  });
});
