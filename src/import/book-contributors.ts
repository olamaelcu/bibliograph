import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { bookContributors, contributorRoles, books, contributors } from '../db/schema.js';
import { sourceKeySlug } from './slugs.js';

const AUTHOR_ROLE_PK = 'author';

/**
 * Link an OL edition's author keys to the book via book_contributors.
 * Skips missing contributors or the book itself; idempotent on the composite PK.
 */
export function hydrateBookContributorsFromEdition(
  db: BetterSQLite3Database,
  editionKey: string,
  authorKeys: Array<{ key?: string }>,
): number {
  const bookPk = sourceKeySlug(editionKey);
  const bookExists = db.select().from(books).where(eq(books.pk, bookPk)).get();
  if (!bookExists) return 0;

  // Ensure the author role exists (seed data normally provides it).
  const role = db.select().from(contributorRoles).where(eq(contributorRoles.pk, AUTHOR_ROLE_PK)).get();
  if (!role) return 0;

  const now = Math.floor(Date.now() / 1000);
  let linked = 0;
  for (const a of authorKeys) {
    if (!a.key) continue;
    const contributorPk = sourceKeySlug(a.key);
    const exists = db.select().from(contributors).where(eq(contributors.pk, contributorPk)).get();
    if (!exists) continue; // contributor row missing; skip (stays unlinked)
    db.insert(bookContributors)
      .values({ bookPk, contributorPk, rolePk: AUTHOR_ROLE_PK, createdAt: now })
      .onConflictDoNothing()
      .run();
    linked += 1;
  }
  return linked;
}
