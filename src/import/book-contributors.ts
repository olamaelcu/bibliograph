import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { bookContributors, bookContributorStaging, contributorRoles, books, contributors } from '../db/schema.js';
import { sourceKeySlug } from './slugs.js';
import { contributorIdentifiersAdapter } from './identifiers.js';
import { logger } from '../logger.js';

const AUTHOR_ROLE_PK = 'author';

const AUTHOR_ROLE_FIELDS = {
  pk: AUTHOR_ROLE_PK,
  name: 'Author',
  description: 'Wrote the book',
  iconImageUrl: null,
};

/** Ensure the author contributor role exists (importer seeds it if absent). */
export function ensureContributorRole(db: BetterSQLite3Database): void {
  const now = Math.floor(Date.now() / 1000);
  db.insert(contributorRoles)
    .values({ ...AUTHOR_ROLE_FIELDS, createdAt: now, releaseStatus: 'released', releasedAt: now })
    .onConflictDoNothing()
    .run();
}

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
    let contributorPk = sourceKeySlug(a.key);
    const exists = db.select().from(contributors).where(eq(contributors.pk, contributorPk)).get();
    if (!exists) {
      // The contributor may exist under a name-derived pk, bridged to the OL
      // author key via contributor_identifiers; fall back to that lookup.
      const viaId = contributorIdentifiersAdapter.findByResource(
        db,
        `openlibrary:${a.key.replace(/^\//, '')}`,
      );
      if (viaId === null) continue; // contributor row missing; skip (stays unlinked)
      contributorPk = viaId;
    }
    db.insert(bookContributors)
      .values({ bookPk, contributorPk, rolePk: AUTHOR_ROLE_PK, createdAt: now })
      .onConflictDoNothing()
      .run();
    linked += 1;
  }
  return linked;
}

/** Raw edition→author link waiting to be resolved into book_contributors. */
export interface StagedAuthorLink {
  editionKey: string;
  authorKey: string;
}

/**
 * Batch-append edition→author links to the staging table. Called after the
 * merge batch transaction commits, so the staging writes never contend with
 * the merge loop. Deduplicated by the composite PK; the referenced books and
 * contributors need not exist yet (they are created by the same import pass).
 */
export function stageEditionAuthors(db: BetterSQLite3Database, links: StagedAuthorLink[]): void {
  if (links.length === 0) return;
  const CHUNK = 500;
  db.transaction((tx) => {
    for (let i = 0; i < links.length; i += CHUNK) {
      tx.insert(bookContributorStaging)
        .values(links.slice(i, i + CHUNK).map((l) => ({ editionOlKey: l.editionKey, authorOlKey: l.authorKey, rolePk: 'author' })))
        .onConflictDoNothing()
        .run();
    }
  });
}

/**
 * Resolve staged edition→author links into book_contributors rows. Same
 * resolution hydrate uses (book/contributor slug, contributor_identifiers
 * fallback). Rows whose book or contributor is missing are dropped: in the OL
 * flow every staged link's lineage exists by resolve time, or the record
 * failed to import and has nothing to link. Returns the number of links created.
 */
export function resolveBookContributors(db: BetterSQLite3Database, opts: { batchSize?: number } = {}): number {
  const batchSize = opts.batchSize ?? 10_000;
  ensureContributorRole(db);
  const now = Math.floor(Date.now() / 1000);
  let linked = 0;

  while (true) {
    // Cursor on rowid so the delete boundary below is exact: the rows fetched
    // are exactly those with the batchSize smallest rowids.
    const rows = db.all(sql`
      SELECT rowid AS r, edition_ol_key, author_ol_key, role_pk
      FROM book_contributor_staging
      ORDER BY rowid
      LIMIT ${batchSize}
    `) as Array<{ r: number; edition_ol_key: string; author_ol_key: string; role_pk: string }>;
    if (rows.length === 0) break;

    db.transaction((tx) => {
      for (const row of rows) {
        const bookPk = sourceKeySlug(row.edition_ol_key);
        const book = tx.select().from(books).where(eq(books.pk, bookPk)).get();
        if (!book) continue;

        let contributorPk = sourceKeySlug(row.author_ol_key);
        const exists = tx.select().from(contributors).where(eq(contributors.pk, contributorPk)).get();
        if (!exists) {
          const viaId = contributorIdentifiersAdapter.findByResource(
            tx,
            `openlibrary:${row.author_ol_key.replace(/^\//, '')}`,
          );
          if (viaId === null) continue;
          contributorPk = viaId;
        }

        const res = tx
          .insert(bookContributors)
          .values({ bookPk, contributorPk, rolePk: row.role_pk, createdAt: now })
          .onConflictDoNothing()
          .run();
        if (res.changes > 0) linked += 1;
      }

      tx.run(sql`DELETE FROM book_contributor_staging WHERE rowid <= ${rows[rows.length - 1].r}`);
    });
  }

  logger.info({ linked }, 'book contributors resolved from staging');
  return linked;
}

/**
 * Link a book to contributors by name (BookHive catalog has author names,
 * not OL keys). Resolves each name to an existing contributor via a
 * case-insensitive exact match; skips missing or ambiguous names. Seeds the
 * 'author' role if absent, and is idempotent on the composite PK.
 */
export function hydrateBookContributorsByName(
  db: BetterSQLite3Database,
  bookPk: string,
  authorNames: Array<{ name: string; role?: string }>,
): number {
  const bookExists = db.select().from(books).where(eq(books.pk, bookPk)).get();
  if (!bookExists) return 0;
  if (authorNames.length === 0) return 0;

  const rolePk = AUTHOR_ROLE_PK;
  ensureContributorRole(db);

  const now = Math.floor(Date.now() / 1000);
  let linked = 0;
  for (const { name } of authorNames) {
    if (!name?.trim()) continue;
    const rows = db
      .select({ pk: contributors.pk })
      .from(contributors)
      .where(sql`lower(${contributors.name}) = lower(${name})`)
      .all() as Array<{ pk: string }>;
    if (rows.length !== 1) continue; // missing or ambiguous contributor; skip
    db.insert(bookContributors)
      .values({ bookPk, contributorPk: rows[0].pk, rolePk, createdAt: now })
      .onConflictDoNothing()
      .run();
    linked += 1;
  }
  return linked;
}
