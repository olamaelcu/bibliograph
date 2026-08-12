import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { upsertAuthorBatch, type ContributorRecord } from './upsert.js';
import { createTestDb } from '../../test-utils/db.js';
import * as schema from '../../db/schema.js';

function parseIdents(row: schema.Contributor): Array<{ type: string; value: string }> {
  const raw = row.identifiers;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
}

function makeRecord(over: Partial<ContributorRecord> = {}): ContributorRecord {
  return {
    name: 'Frank Herbert',
    altNames: ['Frank H.'],
    bio: 'American SF author.',
    identifiers: [{ type: 'openlibrary', value: '/authors/OL12345A' }],
    ...over,
  };
}

let db: ReturnType<typeof createTestDb>['db'];

beforeEach(() => {
  db = createTestDb().db;
});

describe('upsertAuthorBatch', () => {
  it('inserts a new contributor when no match exists', async () => {
    const summary = await upsertAuthorBatch(db, [makeRecord()]);
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);

    const rows = db.select().from(schema.contributors).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Frank Herbert');
    expect(parseIdents(rows[0]!)).toEqual([{ type: 'openlibrary', value: '/authors/OL12345A' }]);
    expect(rows[0]!.altNames).toEqual(['Frank H.']);
    expect(rows[0]!.bio).toBe('American SF author.');
  });

  it('generates a deterministic at-uri using COLLECTIONS.contributor', async () => {
    await upsertAuthorBatch(db, [makeRecord()]);
    const row = db.select().from(schema.contributors).get()!;
    expect(row.uri).toMatch(
      /^at:\/\/[^/]+\/community\.lexicon\.book\.contributor\/[a-z0-9]{13}$/,
    );
  });

  it('returns imported but skips duplicate OL keys within the same batch', async () => {
    const r1 = makeRecord({ name: 'Author A' });
    const r2 = makeRecord({ name: 'Author B' });
    const summary = await upsertAuthorBatch(db, [r1, r2]);
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(schema.contributors).all()).toHaveLength(1);
  });

  it('updates the existing contributor when an OL key already exists', async () => {
    await upsertAuthorBatch(db, [makeRecord({ altNames: ['Original'] })]);

    const summary = await upsertAuthorBatch(
      db,
      [makeRecord({ altNames: ['Alias 1', 'Alias 2'], bio: 'New bio from later dump' })],
    );
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);

    const row = db.select().from(schema.contributors).get()!;
    expect(row.altNames).toEqual(['Original', 'Alias 1', 'Alias 2']);
    expect(row.bio).toBe('American SF author.');
  });

  it('fills in bio when the existing row has no bio but the incoming record does', async () => {
    await upsertAuthorBatch(db, [makeRecord({ bio: undefined })]);

    const summary = await upsertAuthorBatch(db, [makeRecord({ bio: 'New bio from later dump' })]);
    expect(summary.failed).toBe(0);

    const row = db.select().from(schema.contributors).get()!;
    expect(row.bio).toBe('New bio from later dump');
  });

  it('does not overwrite an existing bio with a later one', async () => {
    await upsertAuthorBatch(db, [makeRecord({ bio: 'Original bio' })]);

    await upsertAuthorBatch(db, [makeRecord({ bio: 'Second-pass bio' })]);
    const row = db.select().from(schema.contributors).get()!;
    expect(row.bio).toBe('Original bio');
  });

  it('looks up by case-insensitive name and adds the OL key identifier', async () => {
    db.insert(schema.contributors)
      .values({
        uri: 'at://did:web:localhost/community.lexicon.book.contributor/manual',
        did: 'did:web:localhost',
        name: 'Philip K. Dick',
        altNames: [],
        images: [],
        identifiers: [],
        createdAt: new Date().toISOString(),
      })
      .run();
    const before = db.select().from(schema.contributors).get()!;
    expect(before.identifiers).toEqual([]);
    expect(before.name).toBe('Philip K. Dick');

    const summary = await upsertAuthorBatch(db, [
      makeRecord({ name: 'philip k. dick', identifiers: [{ type: 'openlibrary', value: '/authors/OL7A' }] }),
    ]);
    expect(summary.imported).toBe(0);
    expect(summary.failed).toBe(0);

    const after = db.select().from(schema.contributors).get()!;
    expect(after.name).toBe('Philip K. Dick');
    expect(parseIdents(after)).toEqual([{ type: 'openlibrary', value: '/authors/OL7A' }]);
  });

  it('merges by case-insensitive name match and attaches the new OL key identifier', async () => {
    await upsertAuthorBatch(db, [makeRecord({ name: 'Alice' })]);
    const summary = await upsertAuthorBatch(db, [
      makeRecord({ name: 'alice', identifiers: [{ type: 'openlibrary', value: '/authors/OL2A' }] }),
    ]);
    expect(summary.imported).toBe(0);

    const rows = db.select().from(schema.contributors).all();
    expect(rows).toHaveLength(1);
    expect(parseIdents(rows[0]!)).toEqual([
      { type: 'openlibrary', value: '/authors/OL12345A' },
      { type: 'openlibrary', value: '/authors/OL2A' },
    ]);
  });

  it('prefers OL key match over name match when both could apply', async () => {
    await upsertAuthorBatch(db, [
      makeRecord({ name: 'Bob', identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }] }),
    ]);
    const summary = await upsertAuthorBatch(db, [
      makeRecord({ name: 'Robert', identifiers: [{ type: 'openlibrary', value: '/authors/OL1A' }] }),
    ]);
    expect(summary.imported).toBe(0);
    const rows = db.select().from(schema.contributors).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Bob');
  });

  it('handles a mixed batch of inserts and updates atomically', async () => {
    await upsertAuthorBatch(db, [
      makeRecord({ name: 'Existing By Key', identifiers: [{ type: 'openlibrary', value: '/authors/OL100A' }] }),
      makeRecord({ name: 'Existing By Name', identifiers: [{ type: 'openlibrary', value: '/authors/OL200A' }] }),
    ]);
    db.delete(schema.contributors)
      .where(eq(schema.contributors.name, 'Existing By Name'))
      .run();
    db.insert(schema.contributors)
      .values({
        uri: 'at://did:web:localhost/community.lexicon.book.contributor/manual',
        did: 'did:web:localhost',
        name: 'Existing By Name',
        altNames: [],
        images: [],
        identifiers: [],
        createdAt: new Date().toISOString(),
      })
      .run();

    const summary = await upsertAuthorBatch(db, [
      makeRecord({ name: 'Brand New', identifiers: [{ type: 'openlibrary', value: '/authors/OL300A' }] }),
      makeRecord({ name: 'Existing By Key', identifiers: [{ type: 'openlibrary', value: '/authors/OL100A' }] }),
      makeRecord({ name: 'existing by name', identifiers: [{ type: 'openlibrary', value: '/authors/OL200A' }] }),
    ]);

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);

    const rows = db.select().from(schema.contributors).all();
    expect(rows).toHaveLength(3);

    const byKey = db.select().from(schema.contributors).where(sql`json_extract(identifiers, '$[0].value') = '/authors/OL100A'`).get()!;
    expect(byKey.name).toBe('Existing By Key');
    const byName = db.select().from(schema.contributors).where(sql`name = 'Existing By Name'`).get()!;
    expect(parseIdents(byName)).toEqual([{ type: 'openlibrary', value: '/authors/OL200A' }]);
    const fresh = db.select().from(schema.contributors).where(sql`name = 'Brand New'`).get()!;
    expect(parseIdents(fresh)).toEqual([{ type: 'openlibrary', value: '/authors/OL300A' }]);
  });
});
