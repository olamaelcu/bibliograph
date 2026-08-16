import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { eq } from 'drizzle-orm';
import { bookContributorStaging, bookContributors, books, contributorIdentifiers, contributorRoles, contributors } from '../db/schema.js';
import { hydrateBookContributorsFromEdition, hydrateBookContributorsByName, stageEditionAuthors, resolveBookContributors, ensureContributorRole } from './book-contributors.js';

describe('hydrateBookContributorsFromEdition', () => {
  it('links existing contributors and skips missing ones', async () => {
    const { db, seed } = createTestDb();
    seed(); // provides the 'author' contributor_role row
    const now = Math.floor(Date.now() / 1000);
    db.insert(books)
      .values({ pk: 'books-ol123m', title: 'Dune', createdAt: now, releaseStatus: 'staged' })
      .run();
    db.insert(contributors)
      .values({ pk: 'authors-ol123a', name: 'Frank Herbert', createdAt: now, releaseStatus: 'staged' })
      .run();
    const linked = hydrateBookContributorsFromEdition(db, '/books/OL123M', [
      { key: '/authors/OL999A' },
      { key: '/authors/OL123A' },
    ]);
    expect(linked).toBe(1);
    const rows = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books-ol123m')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].contributorPk).toBe('authors-ol123a');

    const relinked = hydrateBookContributorsFromEdition(db, '/books/OL123M', [{ key: '/authors/OL123A' }]);
    expect(relinked).toBe(1);
    const after = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books-ol123m')).all();
    expect(after).toHaveLength(1);
  });

  it('falls back to contributor_identifiers when the slug lookup misses', async () => {
    const { db, seed } = createTestDb();
    seed(); // provides the 'author' contributor_role row
    const now = Math.floor(Date.now() / 1000);
    db.insert(books)
      .values({ pk: 'books-ol999m', title: 'Barry Larson', createdAt: now, releaseStatus: 'staged' })
      .run();
    // Contributor exists under a NAME-based pk, bridged to the OL author key
    // via contributor_identifiers.
    db.insert(contributors)
      .values({ pk: 'barry-larson', name: 'Barry Larson', createdAt: now, releaseStatus: 'staged' })
      .run();
    db.insert(contributorIdentifiers)
      .values({
        contributorPk: 'barry-larson',
        resource: 'openlibrary:authors/OL456A',
        url: 'https://openlibrary.org/authors/OL456A',
      })
      .run();

    const linked = hydrateBookContributorsFromEdition(db, '/books/OL999M', [{ key: '/authors/OL456A' }]);
    expect(linked).toBe(1);
    const rows = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books-ol999m')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].contributorPk).toBe('barry-larson');
  });

  it('skips a contributor with neither a slug match nor an identifier row', async () => {
    const { db, seed } = createTestDb();
    seed(); // provides the 'author' contributor_role row
    const now = Math.floor(Date.now() / 1000);
    db.insert(books)
      .values({ pk: 'books-ol888m', title: 'Ghost Book', createdAt: now, releaseStatus: 'staged' })
      .run();

    const linked = hydrateBookContributorsFromEdition(db, '/books/OL888M', [{ key: '/authors/OL777A' }]);
    expect(linked).toBe(0);
    const rows = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books-ol888m')).all();
    expect(rows).toHaveLength(0);
  });
});

describe('stageEditionAuthors + resolveBookContributors', () => {
  it('stages links, resolves them into book_contributors, and empties the table', () => {
    const { db, seed } = createTestDb();
    seed();
    const now = Math.floor(Date.now() / 1000);
    for (const pk of ['books-ol1m', 'books-ol2m']) {
      db.insert(books).values({ pk, title: 'Book', createdAt: now, releaseStatus: 'staged' }).run();
    }
    for (const [pk, name] of [['authors-ol1a', 'Alpha'], ['authors-ol2a', 'Beta']] as const) {
      db.insert(contributors).values({ pk, name, createdAt: now, releaseStatus: 'staged' }).run();
    }

    stageEditionAuthors(db, [
      { editionKey: '/books/OL1M', authorKey: '/authors/OL1A' },
      { editionKey: '/books/OL2M', authorKey: '/authors/OL2A' },
    ]);
    stageEditionAuthors(db, [{ editionKey: '/books/OL1M', authorKey: '/authors/OL1A' }]); // dup

    const staged = db.select().from(bookContributorStaging).all();
    expect(staged).toHaveLength(2);

    const linked = resolveBookContributors(db);
    expect(linked).toBe(2);
    expect(db.select().from(bookContributorStaging).all()).toHaveLength(0);
    expect(db.select().from(bookContributors).all()).toHaveLength(4); // 2 seeded links + 2 resolved
    const rows = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books-ol1m')).all();
    expect(rows).toHaveLength(1);
  });

  it('drops staged links whose book or contributor never materialized', () => {
    const { db, seed } = createTestDb();
    seed();
    const now = Math.floor(Date.now() / 1000);
    db.insert(books).values({ pk: 'books-ol1m', title: 'Book', createdAt: now, releaseStatus: 'staged' }).run();
    stageEditionAuthors(db, [
      { editionKey: '/books/OL1M', authorKey: '/authors/OL1A' }, // contributor missing
      { editionKey: '/books/OL9M', authorKey: '/authors/OL9A' }, // book + contributor missing
    ]);

    const linked = resolveBookContributors(db);
    expect(linked).toBe(0);
    expect(db.select().from(bookContributorStaging).all()).toHaveLength(0); // dropped, not retried forever
    expect(db.select().from(bookContributors).all()).toHaveLength(2); // only seeded links remain
  });

  it('resolves a contributor bridged via contributor_identifiers', () => {
    const { db, seed } = createTestDb();
    seed();
    const now = Math.floor(Date.now() / 1000);
    db.insert(books).values({ pk: 'books-ol1m', title: 'Book', createdAt: now, releaseStatus: 'staged' }).run();
    db.insert(contributors).values({ pk: 'barry-larson', name: 'Barry Larson', createdAt: now, releaseStatus: 'staged' }).run();
    db.insert(contributorIdentifiers).values({
      contributorPk: 'barry-larson',
      resource: 'openlibrary:authors/OL456A',
      url: 'https://openlibrary.org/authors/OL456A',
    }).run();

    stageEditionAuthors(db, [{ editionKey: '/books/OL1M', authorKey: '/authors/OL456A' }]);
    const linked = resolveBookContributors(db);
    expect(linked).toBe(1);
    const rows = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books-ol1m')).all();
    expect(rows[0].contributorPk).toBe('barry-larson');
  });

  it('is idempotent across re-runs (a repeat resolve creates nothing new)', () => {
    const { db, seed } = createTestDb();
    seed();
    const now = Math.floor(Date.now() / 1000);
    db.insert(books).values({ pk: 'books-ol1m', title: 'Book', createdAt: now, releaseStatus: 'staged' }).run();
    db.insert(contributors).values({ pk: 'authors-ol1a', name: 'Alpha', createdAt: now, releaseStatus: 'staged' }).run();
    stageEditionAuthors(db, [{ editionKey: '/books/OL1M', authorKey: '/authors/OL1A' }]);

    expect(resolveBookContributors(db)).toBe(1);
    expect(resolveBookContributors(db)).toBe(0); // table empty -> nothing to do
    expect(db.select().from(bookContributors).all()).toHaveLength(3); // 2 seeded + 1 resolved
  });
});

describe('ensureContributorRole', () => {
  it('seeds the author role when absent and is a no-op when present', () => {
    const { db } = createTestDb(); // no seed(): role table is empty
    ensureContributorRole(db);
    const role = db.select().from(contributorRoles).where(eq(contributorRoles.pk, 'author')).get();
    expect(role?.name).toBe('Author');

    ensureContributorRole(db);
    const all = db.select().from(contributorRoles).all();
    expect(all).toHaveLength(1);
  });
});

describe('hydrateBookContributorsByName', () => {
  it('links contributors matched by name, skips missing/ambiguous, and is idempotent', () => {
    const { db, seed } = createTestDb();
    seed(); // provides contributors author-herbert (Frank Herbert) and author-algernon (Daniel Keyes)
    const now = Math.floor(Date.now() / 1000);
    db.insert(books)
      .values({ pk: 'bk-new', title: 'New Book', createdAt: now, releaseStatus: 'staged' })
      .run();
    db.insert(contributors)
      .values({ pk: 'new-author', name: 'Jane Doe', createdAt: now, releaseStatus: 'staged' })
      .run();
    db.insert(contributors)
      .values({ pk: 'dup-a', name: 'Dup Name', createdAt: now, releaseStatus: 'staged' })
      .run();
    db.insert(contributors)
      .values({ pk: 'dup-b', name: 'dup name', createdAt: now, releaseStatus: 'staged' })
      .run();

    const linked = hydrateBookContributorsByName(db, 'bk-new', [
      { name: 'Jane Doe' },
      { name: 'frank herbert' }, // case-insensitive match
      { name: 'Ghost Writer' }, // missing -> skipped
      { name: 'Dup Name' }, // ambiguous (2 rows) -> skipped
    ]);
    expect(linked).toBe(2);
    const rows = db
      .select()
      .from(bookContributors)
      .where(eq(bookContributors.bookPk, 'bk-new'))
      .orderBy(bookContributors.contributorPk)
      .all();
    expect(rows.map((r) => r.contributorPk)).toEqual(['author-herbert', 'new-author']);
    expect(new Set(rows.map((r) => r.rolePk))).toEqual(new Set(['author']));

    const relinked = hydrateBookContributorsByName(db, 'bk-new', [{ name: 'Jane Doe' }]);
    const after = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'bk-new')).all();
    expect(after).toHaveLength(2);
  });

  it('returns 0 and writes nothing when the book does not exist', () => {
    const { db } = createTestDb();
    const linked = hydrateBookContributorsByName(db, 'no-such-book', [{ name: 'Jane Doe' }]);
    expect(linked).toBe(0);
    expect(db.select().from(bookContributors).all()).toHaveLength(0);
  });
});
