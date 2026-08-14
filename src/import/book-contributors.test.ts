import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { eq } from 'drizzle-orm';
import { bookContributors, books, contributors } from '../db/schema.js';
import { hydrateBookContributorsFromEdition } from './book-contributors.js';

describe('hydrateBookContributorsFromEdition', () => {
  it('links existing contributors and skips missing ones', async () => {
    const { db, seed } = createTestDb();
    seed(); // provides the 'author' contributor_role row
    const now = Math.floor(Date.now() / 1000);
    db.insert(books)
      .values({ pk: 'books/ol123m', title: 'Dune', createdAt: now, releaseStatus: 'staged' })
      .run();
    db.insert(contributors)
      .values({ pk: 'authors/ol123a', name: 'Frank Herbert', createdAt: now, releaseStatus: 'staged' })
      .run();
    const linked = hydrateBookContributorsFromEdition(db, '/books/OL123M', [
      { key: '/authors/OL999A' },
      { key: '/authors/OL123A' },
    ]);
    expect(linked).toBe(1);
    const rows = db.select().from(bookContributors).where(eq(bookContributors.bookPk, 'books/ol123m')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].contributorPk).toBe('authors/ol123a');
  });
});
