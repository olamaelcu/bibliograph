import { expect, test, afterAll, beforeAll } from 'vitest';

import pg from 'pg';

import {
  BookEditError,
  deleteAdminBook,
  loadBookForEdit,
  updateAdminBook
} from '../src/lib/server/admin/book-edit.ts';
import type { BookEditIdentifier } from '../src/lib/admin/book-edit.ts';
import type { AdminEdition } from '../src/lib/admin/types.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:editionedit${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

let pool: pg.Pool | undefined;
let ready = false;
let sequence = 0;

function label(): string {
  sequence += 1;
  return `edit${RUN.replace(/[^a-z0-9]/gi, '')}${sequence}`;
}

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!ready || !pool) {
    t.skip('DATABASE_URL is not reachable; skipping catalog integration tests');
    return null;
  }
  return pool;
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  const prefix = `at://${AUTHORITY}/%`;
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE at_uri LIKE $1 OR name LIKE $2', [
    prefix,
    `${RUN}%`
  ]);
  await pool.query('DELETE FROM publishers WHERE at_uri LIKE $1 OR name LIKE $2', [
    prefix,
    `${RUN}%`
  ]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
}

async function createContributor(name: string): Promise<number> {
  const result = await (pool as pg.Pool).query<{ id: string }>(
    `INSERT INTO contributors (name, identifiers, at_uri)
     VALUES ($1, '[]'::jsonb, 'at://' || $2 || '/' || $3 || '/' || editions_next_tid())
     RETURNING id`,
    [name, AUTHORITY, CONTRIBUTOR_COLLECTION]
  );
  return Number(result.rows[0]?.id);
}

async function createPublisher(name: string): Promise<number> {
  const result = await (pool as pg.Pool).query<{ id: string }>(
    `INSERT INTO publishers (name, identifiers, at_uri)
     VALUES ($1, '[]'::jsonb, 'at://' || $2 || '/' || $3 || '/' || editions_next_tid())
     RETURNING id`,
    [name, AUTHORITY, PUBLISHER_COLLECTION]
  );
  return Number(result.rows[0]?.id);
}

async function seedEdition(
  title = 'Original title'
): Promise<{ uri: string; rkey: string; contributorId: number; publisherId: number }> {
  const rkey = label();
  const uri = `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;
  await (pool as pg.Pool).query(
    `INSERT INTO books (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, $3, '2020-01-02T03:04:05.000Z', '2020-01-02T03:04:05.000Z')`,
    [uri, rkey, title]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     VALUES ($1, 'isbn13', '9780000000001')`,
    [uri]
  );
  const contributorId = await createContributor(`${RUN} Author ${rkey}`);
  const publisherId = await createPublisher(`${RUN} Press ${rkey}`);
  await (pool as pg.Pool).query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
     VALUES ($1, $2, 1, 'A01', NULL)`,
    [uri, contributorId]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     SELECT $1, i.issuer, i.value, $2, 1
       FROM edition_identifiers i
      WHERE i.edition_uri = $1`,
    [uri, publisherId]
  );
  return { uri, rkey, contributorId, publisherId };
}

function bodyFrom(edition: AdminEdition, overrides: Record<string, unknown> = {}) {
  return {
    title: edition.title,
    subtitle: edition.subtitle,
    chapters: edition.chapters,
    series: edition.series,
    bookEdition: edition.bookEdition,
    coverUrl: edition.coverUrl,
    identifiers: edition.identifiers,
    contributors: edition.contributors.map((contributor) => ({
      id: contributor.id,
      role: contributor.role,
      ref: contributor.ref
    })),
    expectedRevision: edition.revision,
    ...overrides
  };
}

async function loaded(ref: string): Promise<AdminEdition> {
  const edition = await loadBookForEdit(pool as pg.Pool, ref);
  expect(edition, 'expected the seeded edition to load').toBeTruthy();
  return edition;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  try {
    await pool.query('SELECT 1');
    ready = true;
    await cleanup();
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  if (pool) {
    await cleanup().catch(() => {});
    await pool.end();
  }
});

test('loads an edition by rkey and by a URL-encoded at-uri', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Loadable');

  const byRkey = await loadBookForEdit(db, seeded.rkey);
  expect(byRkey).toBeTruthy();
  expect(byRkey.uri).toBe(seeded.uri);
  expect(byRkey.title).toBe('Loadable');
  expect(byRkey.contributors.length).toBe(1);
  expect(byRkey.identifiers[0]?.publishers.length).toBe(1);
  expect(byRkey.identifiers[0]?.value).toBe('9780000000001');
  expect(byRkey.revision).toMatch(/^[a-f0-9]{64}$/);

  const byUri = await loadBookForEdit(db, encodeURIComponent(seeded.uri));
  expect(byUri).toBeTruthy();
  expect(byUri.uri).toBe(seeded.uri);
});

test('updates scalars, identifiers, contributor order/roles and publisher order atomically', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const secondContributor = await createContributor(`${RUN} Second Author ${seeded.rkey}`);
  const secondPublisher = await createPublisher(`${RUN} Second Press ${seeded.rkey}`);
  const ref = `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/override${sequence}`;

  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(original, {
    title: 'Edited title',
    subtitle: 'An edited subtitle',
    chapters: 12,
    series: { name: 'Saga', position: '2', display: 'Vol. II' },
    bookEdition: '2nd revised',
    coverUrl: 'https://example.org/edited.jpg',
    identifiers: [
      {
        issuer: 'isbn13',
        value: '9780000000002',
        info: {
          format: 'ebook',
          language: 'en',
          publishedDate: '2024-02-29',
          pages: 320,
          description: 'Edited description',
          durationSeconds: 3600
        },
        publishers: [{ id: secondPublisher }]
      },
      { issuer: 'oclc', value: '12345' }
    ],
    contributors: [
      { id: secondContributor, role: 'B01', ref },
      { id: seeded.contributorId, role: 'A01', ref: null }
    ],
  }));

  expect(saved.uri).toBe(original.uri);
  expect(saved.rkey).toBe(original.rkey);
  expect(saved.createdAt).toBe(original.createdAt);
  expect(saved.title).toBe('Edited title');
  expect(saved.series).toEqual({ name: 'Saga', position: '2', display: 'Vol. II' });
  expect(saved.identifiers.map((identifier) => identifier.value).sort()).toEqual([
    '12345',
    '9780000000002'
  ]);
  const claimed = saved.identifiers.find((identifier) => identifier.issuer === 'isbn13');
  expect(claimed?.info).toEqual({
    format: 'ebook',
    language: 'en',
    publishedDate: '2024-02-29',
    pages: 320,
    description: 'Edited description',
    // 0013: an ebook is not audio, so the submitted duration is pruned.
    durationSeconds: null
  });
  expect(claimed?.publishers.map((publisher) => publisher.id)).toEqual([secondPublisher]);
  expect(saved.identifiers.find((identifier) => identifier.issuer === 'oclc')?.publishers, 'an identifier without links reads back an empty list').toEqual([]);
  expect(saved.identifiers.find((identifier) => identifier.issuer === 'oclc')?.info, 'an identifier without a claim reads back null').toBe(null);
  expect(saved.contributors[0]?.id).toBe(secondContributor);
  expect(saved.contributors[0]?.role).toBe('B01');
  expect(saved.contributors[0]?.ref).toBe(ref);
  expect(saved.contributors[1]?.id).toBe(seeded.contributorId);
  const row = await db.query<{ title: string; created_at: Date; rkey: string }>(
    'SELECT title, created_at, rkey FROM books WHERE uri = $1',
    [seeded.uri]
  );
  expect(row.rows[0]?.title).toBe('Edited title');
  expect(row.rows[0]?.rkey).toBe(seeded.rkey);
  expect(row.rows[0]?.created_at.toISOString()).toBe('2020-01-02T03:04:05.000Z');

  const identifiers = await db.query<{ issuer: string; value: string }>(
    'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer, value',
    [seeded.uri]
  );
  expect(identifiers.rows).toEqual([
    { issuer: 'isbn13', value: '9780000000002' },
    { issuer: 'oclc', value: '12345' }
  ]);

  const claims = await db.query(
    `SELECT issuer, value, format, language, published_date, pages, description,
            duration_seconds, extent
       FROM edition_identifier_info WHERE edition_uri = $1`,
    [seeded.uri]
  );
  expect(claims.rows).toEqual([
    {
      issuer: 'isbn13',
      value: '9780000000002',
      extent: { format: 'ebook', pages: 320 },
      format: 'ebook',
      language: 'en',
      published_date: '2024-02-29',
      pages: 320,
      description: 'Edited description',
      duration_seconds: null
    }
  ]);

  const links = await db.query<{ issuer: string; value: string; publisher_id: string }>(
    `SELECT issuer, value, publisher_id FROM edition_identifier_publishers
      WHERE edition_uri = $1`,
    [seeded.uri]
  );
  expect(links.rows.map((row) => [row.issuer, row.value, Number(row.publisher_id)])).toEqual([['isbn13', '9780000000002', secondPublisher]]);

  const shape = await db.query(
    'SELECT format, language, pages, duration_seconds FROM edition_identifier_shape WHERE edition_uri = $1',
    [seeded.uri]
  );
  expect(shape.rows[0]).toEqual({
    format: 'ebook',
    language: 'en',
    pages: 320,
    duration_seconds: null
  });

  const publisher = await db.query<{ publisher: { name: string } }>(
    'SELECT publisher FROM appview_book WHERE uri = $1',
    [seeded.uri]
  );
  expect(publisher.rows[0]?.publisher.name).toBe(`${RUN} Second Press ${seeded.rkey}`);

  const queued = await db.query<{ op: string }>(
    'SELECT op FROM pds_outbox WHERE uri = $1',
    [seeded.uri]
  );
  expect(queued.rows[0], 'the edition trigger must queue the edition').toBeTruthy();
});

test('creates a contributor from name and identifiers, then dedupes it', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const name = `${RUN} Deduped Person ${seeded.rkey}`;
  const identifiers = [{ issuer: 'isni', value: '0000000123456789' }];

  const first = await updateAdminBook(db, seeded.rkey, bodyFrom(original, {
    contributors: [
      { name, identifiers, role: 'B01', ref: `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/edge` },
      { id: seeded.contributorId, role: 'A01', ref: null }
    ]
  }));
  const created = first.contributors.find((contributor) => contributor.name === name);
  expect(created).toBeTruthy();
  expect(created.id > 0).toBeTruthy();

  const second = await updateAdminBook(db, seeded.rkey, bodyFrom(first, {
    contributors: [
      { name, identifiers, role: 'B01', ref: `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/edge` },
      { id: seeded.contributorId, role: 'A01', ref: null }
    ]
  }));

  const matching = await db.query<{ id: string; at_uri: string | null }>(
    'SELECT id, at_uri FROM contributors WHERE lower(name) = lower($1) AND identifiers = $2::jsonb',
    [name, JSON.stringify(identifiers)]
  );
  expect(matching.rowCount).toBe(1);
  expect(Number(matching.rows[0]?.id)).toBe(created.id);
  expect(matching.rows[0]?.at_uri ?? '').toMatch(new RegExp(`^at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/`));
  expect(second.contributors.length).toBe(2);
  expect(second.contributors[0]?.id).toBe(created.id);
});

test('dedupes a contributor whose identifier bag arrives in another order', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const name = `${RUN} Reordered Person ${seeded.rkey}`;
  const isni = { issuer: 'isni', value: '0000000987654321' };
  const viaf = { issuer: 'viaf', value: '987654321' };
  const credits = (identifiers: BookEditIdentifier[]) => [
    { name, identifiers, role: 'B01', ref: null },
    { id: seeded.contributorId, role: 'A01', ref: null }
  ];

  const first = await updateAdminBook(
    db,
    seeded.rkey,
    bodyFrom(original, { contributors: credits([isni, viaf]) })
  );
  const created = first.contributors.find((contributor) => contributor.name === name);
  expect(created).toBeTruthy();

  // The same identity, bag reversed: `(lower(name), identifiers)` compares the
  // stored jsonb positionally, so the row must not fork into a second address.
  const second = await updateAdminBook(
    db,
    seeded.rkey,
    bodyFrom(first, { contributors: credits([viaf, isni]) })
  );
  expect(second.contributors[0]?.id, 'a reordered identity bag minted a second contributor').toBe(created.id);

  const rows = await db.query<{ id: string }>(
    'SELECT id FROM contributors WHERE lower(name) = lower($1)',
    [name]
  );
  expect(rows.rowCount).toBe(1);
});

test('removes a credit without deleting the shared contributor or publisher', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const secondContributor = await createContributor(`${RUN} Unlinked Author ${seeded.rkey}`);
  const secondPublisher = await createPublisher(`${RUN} Unlinked Press ${seeded.rkey}`);

  await updateAdminBook(db, seeded.rkey, bodyFrom(original, {
    contributors: [
      { id: seeded.contributorId, role: 'A01', ref: null },
      { id: secondContributor, role: 'B01', ref: null }
    ],
    identifiers: [
      {
        issuer: 'isbn13',
        value: '9780000000001',
        publishers: [{ id: seeded.publisherId }, { id: secondPublisher }]
      }
    ]
  }));

  const mid = await loaded(seeded.rkey);
  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(mid, {
    contributors: [{ id: seeded.contributorId, role: 'A01', ref: null }],
    identifiers: [
      { issuer: 'isbn13', value: '9780000000001', publishers: [{ id: seeded.publisherId }] }
    ]
  }));

  expect(saved.contributors.length).toBe(1);
  expect(saved.identifiers[0]?.publishers.map((entry) => entry.id)).toEqual([seeded.publisherId]);
  const contributor = await db.query('SELECT id FROM contributors WHERE id = $1', [
    secondContributor
  ]);
  const publisher = await db.query('SELECT id FROM publishers WHERE id = $1', [secondPublisher]);
  expect(contributor.rowCount).toBe(1);
  expect(publisher.rowCount).toBe(1);
});

test('rejects an unknown contributor id and rolls back the scalar change', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Unchanged title');
  const original = await loaded(seeded.rkey);

  await expect(updateAdminBook(db, seeded.rkey, bodyFrom(original, {
      title: 'Must roll back',
      contributors: [{ id: 9_000_000_000_000, role: 'A01', ref: null }]
    }))).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError &&
      error.status === 400 &&
      error.code === 'UnknownContributor');

  const row = await db.query<{ title: string }>('SELECT title FROM books WHERE uri = $1', [
    seeded.uri
  ]);
  expect(row.rows[0]?.title).toBe('Unchanged title');
});

test('rejects a stale revision with 409', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Revision A');
  const original = await loaded(seeded.rkey);

  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(original, {
    title: 'Revision B'
  }));
  expect(saved.title).toBe('Revision B');

  await expect(updateAdminBook(db, seeded.rkey, bodyFrom(original, { title: 'Revision C' }))).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError && error.status === 409 && error.code === 'EditionChanged');
  const row = await db.query<{ title: string }>('SELECT title FROM books WHERE uri = $1', [
    seeded.uri
  ]);
  expect(row.rows[0]?.title).toBe('Revision B');
});

test('accepts the current revision with no changes', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Stable revision');
  const first = await loaded(seeded.rkey);
  const second = await loaded(seeded.rkey);
  expect(first.revision).toBe(second.revision);

  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(second));
  expect(saved.title).toBe('Stable revision');
  expect(saved.revision).toBe(second.revision);
});

test('editing the cover URL clears the cover ledger, so the sweep refetches at once', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Cover source change');
  // A terminal rejection would otherwise keep the sweep away for a whole week:
  // the outcome describes the URL, not the edition.
  await db.query(
    `INSERT INTO edition_cover_fetches (edition_uri, outcome, source_url)
     VALUES ($1, 'rejected', 'https://covers.example/placeholder.jpg')`,
    [seeded.uri]
  );
  const original = await loaded(seeded.rkey);

  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(original, {
    coverUrl: 'https://covers.example/real.jpg'
  }));

  expect(saved.coverUrl).toBe('https://covers.example/real.jpg');
  const claims = await db.query<{ n: string }>(
    'SELECT count(*)::int AS n FROM edition_cover_fetches WHERE edition_uri = $1',
    [seeded.uri]
  );
  expect(Number(claims.rows[0]?.n), 'the ledger row is gone').toBe(0);
});

test('rejects invalid bodies before opening a transaction', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Valid title');
  const original = await loaded(seeded.rkey);

  await expect(updateAdminBook(db, seeded.rkey, bodyFrom(original, { title: '   ' }))).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError && error.status === 400 && error.code === 'InvalidEdition');
  await expect(updateAdminBook(db, seeded.rkey, bodyFrom(original, {
      coverUrl: 'javascript:alert(1)'
    }))).rejects.toSatisfy((error: unknown) => error instanceof BookEditError && error.status === 400);
});

test('claims are kept when omitted, cleared with null and written per identifier', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Claim editing');
  const isbn = { issuer: 'isbn13', value: '9780000000001' };
  const claimRow = async () => {
    const result = await db.query<{
      format: string | null;
      language: string | null;
      pages: number | null;
      duration_seconds: number | null;
      extent: Record<string, unknown> | null;
      updated_at: Date;
    }>(
      `SELECT format, language, pages, duration_seconds, extent, updated_at FROM edition_identifier_info WHERE edition_uri = $1 AND issuer = 'isbn13'`,
      [seeded.uri]
    );
    return result.rows[0];
  };

  await db.query(
    `INSERT INTO edition_identifier_info (edition_uri, issuer, value, language, extent) VALUES ($1, 'isbn13', '9780000000001', 'en-GB', '{"format":"hardcover","pages":320,"durationSeconds":5400}')`,
    [seeded.uri]
  );
  const seededClaim = await claimRow();
  expect({
      // 0013: the trigger pruned the audio duration from a print claim.
      extent: seededClaim?.extent,
      format: seededClaim?.format,
      language: seededClaim?.language,
      pages: seededClaim?.pages,
      duration_seconds: seededClaim?.duration_seconds
    }).toEqual({
      extent: { format: 'hardcover', pages: 320 },
      format: 'hardcover',
      language: 'en-GB',
      pages: 320,
      duration_seconds: null
    });

  // Invalid claim field: rejected before the transaction, nothing changes.
  await expect(updateAdminBook(
      db,
      seeded.rkey,
      bodyFrom(await loaded(seeded.rkey), {
        identifiers: [{ ...isbn, info: { language: 'en_US' } }]
      })
    )).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError && error.status === 400 && error.code === 'InvalidEdition');
  await expect(updateAdminBook(
      db,
      seeded.rkey,
      bodyFrom(await loaded(seeded.rkey), {
        contributors: [{ id: seeded.contributorId, role: 'A55', ref: null }]
      })
    )).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError && error.status === 400 && error.code === 'InvalidEdition');
  expect((await claimRow())?.format).toBe('hardcover');

  // An unchanged claim is not rewritten: `updated_at` survives a plain save.
  const reloaded = await loaded(seeded.rkey);
  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(reloaded, {
    title: 'Claim editing 2'
  }));
  expect(saved.title).toBe('Claim editing 2');
  expect((await claimRow())?.updated_at.toISOString()).toBe(seededClaim?.updated_at.toISOString());

  // An identifier with no `info` key keeps the stored claim untouched.
  const omitted = await updateAdminBook(db, seeded.rkey, bodyFrom(saved, {
    identifiers: [isbn]
  }));
  expect(omitted.identifiers[0]?.info?.format).toBe('hardcover');
  expect((await claimRow())?.pages).toBe(320);

  // A new identifier carries its own claim.
  const added = await updateAdminBook(db, seeded.rkey, bodyFrom(omitted, {
    identifiers: [
      isbn,
      {
        issuer: 'isbn10',
        value: '0441013597',
        info: { format: 'paperback', pages: 288, publishedDate: '2024-02' }
      }
    ]
  }));
  expect(added.identifiers.find((identifier) => identifier.issuer === 'isbn10')?.info).toEqual({
      format: 'paperback',
      language: null,
      publishedDate: '2024-02',
      pages: 288,
      description: null,
      durationSeconds: null
    });
  const shape = await db.query<{ format: string; pages: number }>(
    'SELECT format, pages, duration_seconds FROM edition_identifier_shape WHERE edition_uri = $1',
    [seeded.uri]
  );
  expect(shape.rows[0]).toEqual({ format: 'hardcover', pages: 320, duration_seconds: null });

  // Null clears the row; the isbn13 claim still wins the union.
  const cleared = await updateAdminBook(db, seeded.rkey, bodyFrom(added, {
    identifiers: [
      { ...isbn, info: null },
      { issuer: 'isbn10', value: '0441013597' }
    ]
  }));
  expect(cleared.identifiers.find((identifier) => identifier.issuer === 'isbn13')?.info).toBe(null);
  expect(await claimRow()).toBe(undefined);

  // Canonicalisation happens on the claim, exactly as it did on the edition.
  const canonical = await updateAdminBook(db, seeded.rkey, bodyFrom(cleared, {
    identifiers: [{ ...isbn, info: { language: 'EN-us' } }]
  }));
  expect(canonical.identifiers.find((identifier) => identifier.issuer === 'isbn13')?.info?.language).toBe('en-US');
  expect((await claimRow())?.language).toBe('en-US');
});

test('returns 404 for an unknown edition', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  expect(await loadBookForEdit(db, `missing${RUN}`)).toBe(null);
  await expect(updateAdminBook(db, `missing${RUN}`, {
      title: 'x',
      identifiers: [{ issuer: 'isbn13', value: '1' }],
      contributors: [{ name: 'A' }]
    })).rejects.toSatisfy((error: unknown) => error instanceof BookEditError && error.status === 404);
});

test('queues new contributor and publisher entity rows through triggers', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const name = `${RUN} Outbox Person ${seeded.rkey}`;
  const publisherName = `${RUN} Outbox Press ${seeded.rkey}`;

  const saved = await updateAdminBook(db, seeded.rkey, bodyFrom(original, {
    contributors: [
      { id: seeded.contributorId, role: 'A01', ref: null },
      { name, identifiers: [{ issuer: 'isni', value: '999' }], role: 'B01', ref: null }
    ],
    identifiers: [
      {
        issuer: 'isbn13',
        value: '9780000000001',
        publishers: [{ id: seeded.publisherId }, { name: publisherName, identifiers: [] }]
      }
    ]
  }));

  const contributor = saved.contributors.find((credit) => credit.name === name);
  const publisher = saved.identifiers[0]?.publishers.find((entry) => entry.name === publisherName);
  expect(contributor).toBeTruthy();
  expect(publisher).toBeTruthy();

  const contributorOutbox = await db.query<{ collection: string; op: string }>(
    'SELECT collection, op FROM pds_outbox WHERE uri LIKE $1',
    [`at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/%`]
  );
  expect(contributorOutbox.rows.some(
      (row) => row.collection === CONTRIBUTOR_COLLECTION && ['create', 'update'].includes(row.op)
    )).toBeTruthy();
  const publisherOutbox = await db.query<{ collection: string; op: string }>(
    'SELECT collection, op FROM pds_outbox WHERE uri LIKE $1',
    [`at://${AUTHORITY}/${PUBLISHER_COLLECTION}/%`]
  );
  expect(publisherOutbox.rows.some(
      (row) => row.collection === PUBLISHER_COLLECTION && ['create', 'update'].includes(row.op)
    )).toBeTruthy();
  const editionOutbox = await db.query<{ op: string }>(
    `SELECT op FROM pds_outbox
      WHERE uri = $1 AND collection = 'community.lexicon.media.book.edition'`,
    [seeded.uri]
  );
  expect(editionOutbox.rows[0], 'the edition row must be queued by the catalog trigger').toBeTruthy();
});

test('deletes an edition with its children and queues the record deletion', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Delete me');
  await db.query(
    `INSERT INTO edition_identifier_info (edition_uri, issuer, value, extent)
     VALUES ($1, 'isbn13', '9780000000001', '{"pages":320}')`,
    [seeded.uri]
  );
  await db.query('INSERT INTO edition_cover_fetches (edition_uri) VALUES ($1)', [seeded.uri]);
  await db.query('INSERT INTO edition_genre_fetches (edition_uri) VALUES ($1)', [seeded.uri]);
  const original = await loaded(seeded.rkey);
  expect((await db.query<{ op: string }>('SELECT op FROM pds_outbox WHERE uri = $1', [seeded.uri])).rows[0]
      ?.op, 'a fresh seeded edition is queued as a create').toBe('create');

  const deleted = await deleteAdminBook(db, seeded.rkey, original.revision);

  expect(deleted).toBe(seeded.uri);
  const counts = await db.query<{
    editions: number;
    identifiers: number;
    claims: number;
    credits: number;
    publishers: number;
    covers: number;
    genres: number;
  }>(
    `SELECT (SELECT count(*)::int FROM books WHERE uri = $1) AS editions,
            (SELECT count(*)::int FROM edition_identifiers WHERE edition_uri = $1) AS identifiers,
            (SELECT count(*)::int FROM edition_identifier_info WHERE edition_uri = $1) AS claims,
            (SELECT count(*)::int FROM edition_contributors WHERE edition_uri = $1) AS credits,
            (SELECT count(*)::int FROM edition_identifier_publishers WHERE edition_uri = $1) AS publishers,
            (SELECT count(*)::int FROM edition_cover_fetches WHERE edition_uri = $1) AS covers,
            (SELECT count(*)::int FROM edition_genre_fetches WHERE edition_uri = $1) AS genres`,
    [seeded.uri]
  );
  expect(counts.rows[0]).toEqual({
    editions: 0,
    identifiers: 0,
    claims: 0,
    credits: 0,
    publishers: 0,
    covers: 0,
    genres: 0
  });

  const outbox = await db.query<{ op: string }>('SELECT op FROM pds_outbox WHERE uri = $1', [
    seeded.uri
  ]);
  expect(outbox.rows, 'the parked create is rewritten to a delete').toEqual([{ op: 'delete' }]);
  expect(await loadBookForEdit(db, seeded.rkey)).toBe(null);
});

test('refuses to delete an edition that changed since it was loaded', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Stale delete');
  const original = await loaded(seeded.rkey);
  await updateAdminBook(
    db,
    seeded.rkey,
    bodyFrom(original, { title: 'Renamed before delete' })
  );

  await expect(() => deleteAdminBook(db, seeded.rkey, original.revision)).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError &&
      error.status === 409 &&
      error.code === 'EditionChanged');
  expect((await loadBookForEdit(db, seeded.rkey)) !== null, 'a refused delete leaves the edition in place').toBeTruthy();
});

test('reports an unknown edition as 404 on delete', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  await expect(() => deleteAdminBook(db, `missing${RUN}`, null)).rejects.toSatisfy((error: unknown) =>
      error instanceof BookEditError && error.status === 404 && error.code === 'NotFound');
});
