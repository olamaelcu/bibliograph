import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, clearSqliteTables } from '../test-utils/db.js';
import { schema } from '../db/connection.js';
import { COLLECTIONS, makeRecordUri } from '../records.js';
import { generateRkey } from '../rkey.js';
import { hydrateBookContributors } from './hydrate-book-contributors.js';

const SERVICE_DID = 'did:web:localhost';
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

interface SeedBookInput {
  uri?: string;
  author?: string;
  identifiers?: Array<{ type: string; value: string }>;
  hasJoinRows?: boolean;
}

function seedBook(input: SeedBookInput = {}): string {
  const uri =
    input.uri ??
    `at://did:plc:test/community.lexicon.book.book/${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.insert(schema.books)
    .values({
      uri,
      did: 'did:plc:test',
      title: 'Test Book',
      author: input.author ?? 'OL Author',
      status: 'active',
      identifiers: input.identifiers ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .run();

  if (input.hasJoinRows) {
    const contribUri = makeRecordUri(
      SERVICE_DID,
      COLLECTIONS.contributor,
      generateRkey(),
    );
    db.insert(schema.contributors)
      .values({
        uri: contribUri,
        did: SERVICE_DID,
        name: 'Existing Contributor',
        altNames: [],
        images: [],
        identifiers: [],
        createdAt: now,
      })
      .run();
    const role = db
      .select()
      .from(schema.contributorTypes)
      .where(eq(schema.contributorTypes.name, 'author'))
      .get();
    db.insert(schema.bookContributors)
      .values({
        bookUri: uri,
        contributorUri: contribUri,
        contributorCid: 'cid-c',
        roleUri: role!.uri,
        roleCid: 'cid-r',
        ordering: 0,
      })
      .run();
  }

  return uri;
}

function contributorRowsFor(bookUri: string) {
  return db
    .select()
    .from(schema.bookContributors)
    .where(eq(schema.bookContributors.bookUri, bookUri))
    .all();
}

function bookRow(uri: string) {
  return db.select().from(schema.books).where(eq(schema.books.uri, uri)).get();
}

function reservationRow() {
  return db
    .select()
    .from(schema.backfillReservation)
    .where(eq(schema.backfillReservation.stateName, 'book_contributors_hydrate'))
    .get();
}

beforeEach(() => {
  clearSqliteTables((db as any).$sqlite);
  seedAuthorRole();
});

describe('hydrateBookContributors', () => {
  it('acquires and releases a backfill_reservation row around the walk', () => {
    seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });

    expect(reservationRow()).toBeUndefined();

    hydrateBookContributors(db, {});

    expect(reservationRow()).toBeUndefined();
  });

  it('throws when another active reservation holds the same stateName', () => {
    db.insert(schema.backfillReservation)
      .values({
        stateName: 'book_contributors_hydrate',
        ownerPid: 99999,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        batchSize: 1,
        status: 'active',
      })
      .run();

    expect(() => hydrateBookContributors(db, {})).toThrow(/backfill reservation/i);
  });

  it('takes over a stale active reservation', () => {
    const stale = Date.now() - 200_000;
    db.insert(schema.backfillReservation)
      .values({
        stateName: 'book_contributors_hydrate',
        ownerPid: 99999,
        acquiredAt: stale,
        heartbeatAt: stale,
        batchSize: 1,
        status: 'active',
      })
      .run();

    seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });

    const summary = hydrateBookContributors(db, {});
    expect(summary.joinRowsCreated).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it('creates a join row and a contributor for an OL-imported book with author + OL key', () => {
    const olKey = '/authors/OL42A';
    const bookUri = seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: olKey }],
    });

    const summary = hydrateBookContributors(db, {});

    expect(summary.booksWalked).toBe(1);
    expect(summary.joinRowsCreated).toBe(1);
    expect(summary.alreadyHadJoinRows).toBe(0);
    expect(summary.skippedNoAuthor).toBe(0);
    expect(summary.skippedNoOlKey).toBe(0);

    const joins = contributorRowsFor(bookUri);
    expect(joins).toHaveLength(1);
    expect(joins[0]!.ordering).toBe(0);

    const contributors = db.select().from(schema.contributors).all();
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.name).toBe('Frank Herbert');
    expect(contributors[0]!.identifiers).toEqual([
      { type: 'openlibrary', value: olKey },
    ]);

    const updatedBook = bookRow(bookUri);
    expect(updatedBook!.contributors).toEqual([
      {
        contributor: { uri: joins[0]!.contributorUri, cid: joins[0]!.contributorCid },
        role: { uri: joins[0]!.roleUri, cid: joins[0]!.roleCid },
        order: 0,
      },
    ]);
  });

  it('reuses an existing contributor matched by OL key and still populates books.contributors', () => {
    const olKey = '/authors/OL99A';
    const existing = db.insert(schema.contributors)
      .values({
        uri: makeRecordUri(SERVICE_DID, COLLECTIONS.contributor, 'preExisting'),
        did: SERVICE_DID,
        name: 'Pre-Existing Author',
        altNames: [],
        images: [],
        identifiers: [{ type: 'openlibrary', value: olKey }],
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    const bookUri = seedBook({
      author: 'Different Display Name',
      identifiers: [{ type: 'openlibrary', value: olKey }],
    });

    const summary = hydrateBookContributors(db, {});

    expect(summary.joinRowsCreated).toBe(1);
    const contributors = db.select().from(schema.contributors).all();
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.uri).toBe(existing!.uri);
    expect(contributors[0]!.name).toBe('Pre-Existing Author');

    const joins = contributorRowsFor(bookUri);
    expect(joins).toHaveLength(1);
    expect(joins[0]!.contributorUri).toBe(existing!.uri);

    expect(bookRow(bookUri)!.contributors).toEqual([
      {
        contributor: { uri: existing!.uri, cid: joins[0]!.contributorCid },
        role: { uri: joins[0]!.roleUri, cid: joins[0]!.roleCid },
        order: 0,
      },
    ]);
  });

  it('falls back to case-insensitive name match and merges the OL key', () => {
    const existing = db.insert(schema.contributors)
      .values({
        uri: makeRecordUri(SERVICE_DID, COLLECTIONS.contributor, 'preExisting'),
        did: SERVICE_DID,
        name: 'Frank Herbert',
        altNames: [],
        images: [],
        identifiers: [],
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    const bookUri = seedBook({
      author: 'frank herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });

    hydrateBookContributors(db, {});

    const after = db.select().from(schema.contributors).where(eq(schema.contributors.uri, existing!.uri)).get();
    expect(after!.identifiers).toEqual([
      { type: 'openlibrary', value: '/authors/OL1A' },
    ]);
    const joins = contributorRowsFor(bookUri);
    expect(joins).toHaveLength(1);
    expect(joins[0]!.contributorUri).toBe(existing!.uri);
  });

  it('skips books with empty author and counts them as skippedNoAuthor', () => {
    seedBook({
      uri: 'at://did:plc:test/community.lexicon.book.book/empty',
      author: '',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });

    const summary = hydrateBookContributors(db, {});

    expect(summary.booksWalked).toBe(1);
    expect(summary.skippedNoAuthor).toBe(1);
    expect(summary.joinRowsCreated).toBe(0);
    expect(db.select().from(schema.contributors).all()).toHaveLength(0);
    expect(db.select().from(schema.bookContributors).all()).toHaveLength(0);
  });

  it('skips books with no openlibrary identifier and counts them as skippedNoOlKey', () => {
    seedBook({
      uri: 'at://did:plc:test/community.lexicon.book.book/noOl',
      author: 'Some Author',
      identifiers: [{ type: 'isbn13', value: '9781234567890' }],
    });

    const summary = hydrateBookContributors(db, {});

    expect(summary.skippedNoOlKey).toBe(1);
    expect(summary.joinRowsCreated).toBe(0);
    expect(db.select().from(schema.contributors).all()).toHaveLength(0);
  });

  it('skips books that already have join rows and counts them as alreadyHadJoinRows', () => {
    const bookUri = seedBook({
      author: 'Bookhive Author',
      identifiers: [{ type: 'hiveId', value: 'M5fR8' }],
      hasJoinRows: true,
    });

    const summary = hydrateBookContributors(db, {});

    expect(summary.alreadyHadJoinRows).toBe(1);
    expect(summary.joinRowsCreated).toBe(0);
    expect(contributorRowsFor(bookUri)).toHaveLength(1);
    expect(db.select().from(schema.contributors).all()).toHaveLength(1);
  });

  it('is idempotent (re-running produces no duplicate join rows or contributor entries)', () => {
    const bookUri = seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });

    const first = hydrateBookContributors(db, {});
    expect(first.joinRowsCreated).toBe(1);
    expect(first.booksContributorsUpdated).toBe(1);

    const second = hydrateBookContributors(db, {});
    expect(second.joinRowsCreated).toBe(0);
    expect(second.booksContributorsUpdated).toBe(0);
    expect(second.alreadyHadJoinRows).toBe(1);

    expect(contributorRowsFor(bookUri)).toHaveLength(1);
    expect(bookRow(bookUri)!.contributors).toHaveLength(1);
    expect(db.select().from(schema.contributors).all()).toHaveLength(1);
  });

  it('handles a mixed batch: skip one, hydrate one, leave bookhive-imported one alone', () => {
    seedBook({
      uri: 'at://did:plc:test/community.lexicon.book.book/empty',
      author: '',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });
    const doHydrate = seedBook({
      uri: 'at://did:plc:test/community.lexicon.book.book/hydrate',
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });
    seedBook({
      uri: 'at://did:plc:test/community.lexicon.book.book/skip',
      author: 'Bookhive Author',
      identifiers: [{ type: 'hiveId', value: 'M5fR8' }],
      hasJoinRows: true,
    });

    const summary = hydrateBookContributors(db, {});

    expect(summary.booksWalked).toBe(3);
    expect(summary.skippedNoAuthor).toBe(1);
    expect(summary.alreadyHadJoinRows).toBe(1);
    expect(summary.joinRowsCreated).toBe(1);
    expect(contributorRowsFor(doHydrate)).toHaveLength(1);
  });

  it('dry-run counts rows without writing join rows, contributors, or books.contributors', () => {
    const bookUri = seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });

    const summary = hydrateBookContributors(db, { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.joinRowsCreated).toBe(1);
    expect(summary.booksContributorsUpdated).toBe(1);
    expect(db.select().from(schema.bookContributors).all()).toHaveLength(0);
    expect(db.select().from(schema.contributors).all()).toHaveLength(0);
    expect(bookRow(bookUri)!.contributors).toEqual([]);
    expect(summary.errors).toBe(0);
  });

  it('reset wipes existing join rows before hydrating', () => {
    const bookUri = seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });
    const first = hydrateBookContributors(db, {});
    expect(first.joinRowsCreated).toBe(1);
    expect(contributorRowsFor(bookUri)).toHaveLength(1);

    const second = hydrateBookContributors(db, { reset: true });
    expect(second.resetDeleted).toBeGreaterThanOrEqual(1);
    expect(contributorRowsFor(bookUri)).toHaveLength(1);
    expect(db.select().from(schema.bookContributors).all()).toHaveLength(1);
  });

  it('records the joining book row when one is processed', () => {
    const bookUri = seedBook({
      author: 'Frank Herbert',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }],
    });
    hydrateBookContributors(db, {});

    const row = bookRow(bookUri);
    expect(row).toBeDefined();
    expect(row!.author).toBe('Frank Herbert');
  });
});
