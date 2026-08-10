import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('./db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

import { db, schema } from './db/connection.js';
import { clearSqliteTables } from './test-utils/db.js';
const _d = db as any;
const _s = schema;

import { runBackfill } from './backfill-contributors.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function seedBook(opts: {
  uri?: string;
  contributors?: Array<{ contributor: { uri: string; cid: string }; role: { uri: string; cid: string }; order?: number }>;
}) {
  const uri = opts.uri || `at://did:plc:test/community.lexicon.book.book/${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.insert(_s.books).values({
    uri,
    did: 'did:plc:test',
    title: 'Test',
    author: 'Tester',
    status: 'active',
    contributors: opts.contributors ?? [],
    createdAt: now,
    updatedAt: now,
  }).run();
  return uri;
}

describe('backfill-contributors', () => {
  beforeEach(() => {
    clearTables();
  });

  it('inserts join rows for books with valid contributors', () => {
    const bookUri = seedBook({
      contributors: [
        {
          contributor: { uri: 'at://did:plc:a/community.lexicon.book.contributor/c1', cid: 'cid-c1' },
          role:        { uri: 'at://did:web:localhost/community.lexicon.book.contributorType/r1', cid: 'cid-r1' },
          order: 0,
        },
        {
          contributor: { uri: 'at://did:plc:b/community.lexicon.book.contributor/c2', cid: 'cid-c2' },
          role:        { uri: 'at://did:web:localhost/community.lexicon.book.contributorType/r2', cid: 'cid-r2' },
          order: 1,
        },
      ],
    });

    const summary = runBackfill();
    expect(summary.errors).toBe(0);
    expect(summary.booksWithContributors).toBe(1);
    expect(summary.joinRowsCreated).toBe(2);

    const rows = db.select().from(_s.bookContributors).all();
    expect(rows).toHaveLength(2);
    const forBook = rows.filter((r: { bookUri: string }) => r.bookUri === bookUri);
    expect(forBook).toHaveLength(2);
    expect(forBook[0].contributorUri).toBe('at://did:plc:a/community.lexicon.book.contributor/c1');
    expect(forBook[0].contributorCid).toBe('cid-c1');
    expect(forBook[0].roleUri).toBe('at://did:web:localhost/community.lexicon.book.contributorType/r1');
    expect(forBook[0].ordering).toBe(0);
    expect(forBook[1].ordering).toBe(1);
  });

  it('skips books without contributors and reports correct totals', () => {
    seedBook({});
    seedBook({});
    const summary = runBackfill();
    expect(summary.totalBooks).toBe(2);
    expect(summary.booksWithContributors).toBe(0);
    expect(summary.joinRowsCreated).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it('counts malformed entries as errors and skips them', () => {
    seedBook({
      uri: 'at://did:plc:test/community.lexicon.book.book/malformed',
      contributors: [
        // missing contributor.uri
        {
          contributor: { uri: '', cid: '' } as any,
          role: { uri: 'at://x/y/z', cid: 'cid' },
        },
        // missing role.uri
        {
          contributor: { uri: 'at://did:plc:a/contributor/c1', cid: 'cid' },
          role: { uri: '', cid: '' } as any,
        },
      ] as any,
    });

    const summary = runBackfill();
    expect(summary.booksWithContributors).toBe(1);
    expect(summary.errors).toBe(2);
    expect(summary.joinRowsCreated).toBe(0);
  });

  it('is idempotent (re-running does not duplicate)', () => {
    seedBook({
      contributors: [
        {
          contributor: { uri: 'at://did:plc:a/contributor/c1', cid: 'cid' },
          role: { uri: 'at://did:web:localhost/contributorType/r1', cid: 'cid' },
        },
      ],
    });

    const first = runBackfill();
    expect(first.joinRowsCreated).toBe(1);

    const second = runBackfill();
    expect(second.joinRowsCreated).toBe(0);
    expect(second.errors).toBe(0);

    const rows = db.select().from(_s.bookContributors).all();
    expect(rows).toHaveLength(1);
  });

  it('dry-run counts rows without writing', () => {
    seedBook({
      contributors: [
        {
          contributor: { uri: 'at://did:plc:a/contributor/c1', cid: 'cid' },
          role: { uri: 'at://did:web:localhost/contributorType/r1', cid: 'cid' },
        },
      ],
    });

    const summary = runBackfill({ dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.joinRowsCreated).toBe(1);

    const rows = db.select().from(_s.bookContributors).all();
    expect(rows).toHaveLength(0);
  });

  it('reset wipes book_contributors before populating', () => {
    seedBook({
      contributors: [
        {
          contributor: { uri: 'at://did:plc:a/contributor/c1', cid: 'cid' },
          role: { uri: 'at://did:web:localhost/contributorType/r1', cid: 'cid' },
        },
      ],
    });
    seedBook({
      contributors: [
        {
          contributor: { uri: 'at://did:plc:b/contributor/c2', cid: 'cid' },
          role: { uri: 'at://did:web:localhost/contributorType/r2', cid: 'cid' },
        },
      ],
    });

    const initial = runBackfill();
    expect(initial.joinRowsCreated).toBe(2);
    expect(initial.resetDeleted).toBeUndefined();

    const summary = runBackfill({ reset: true });
    expect(summary.resetDeleted).toBe(2);
    expect(summary.joinRowsCreated).toBe(2);

    const rows = db.select().from(_s.bookContributors).all();
    expect(rows).toHaveLength(2);
    const uris = rows.map((r: { contributorUri: string }) => r.contributorUri).sort();
    expect(uris).toEqual([
      'at://did:plc:a/contributor/c1',
      'at://did:plc:b/contributor/c2',
    ]);
  });
});
