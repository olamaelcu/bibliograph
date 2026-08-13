import { db, sqliteHandle } from './connection.js';
import { logger } from '../logger.js';
import { COLLECTIONS, makeRecordUri } from '../records.js';
import { cidForRecord } from '../pds/cid.js';
import { serializeContributorType } from '../pds/records.js';
import { generateRkey } from '../rkey.js';
import { books, contributorTypes } from './schema.js';
import { eq } from 'drizzle-orm';

export function setupIdentifiersView(): void {
  db.run(`CREATE VIEW IF NOT EXISTS books_identifiers AS
    SELECT 
      b.uri,
      b.title,
      b.author,
      b.isbn,
      json_extract(json_each.value, '$.type') as identifier_type,
      json_extract(json_each.value, '$.value') as identifier_value,
      'json' as claim_status
    FROM books b
    JOIN json_each(b.identifiers) json_each
    WHERE json_extract(json_each.value, '$.value') IS NOT NULL AND json_extract(json_each.value, '$.value') != ''
    UNION ALL
    SELECT 
      b.uri,
      b.title,
      b.author,
      b.isbn,
      c.identifierType as identifier_type,
      c.identifier as identifier_value,
      c.status as claim_status
    FROM books b
    JOIN claims c ON c.bookUri = b.uri`);
}

/**
 * Create the cover-variant views used by the cover worker. Idempotent
 * (`CREATE VIEW IF NOT EXISTS`). The migration files in drizzle/ also
 * declare these, but running them at boot ensures the views exist even
 * on databases that were set up before the migrations landed.
 */
export function setupCoverViews(): void {
  db.run(`CREATE VIEW IF NOT EXISTS books_missing_cover_variants AS
    SELECT
      uri,
      cover,
      substr(uri, -13) AS rkey
    FROM books
    WHERE cover IS NOT NULL
      AND (
        json_extract(cover, '$.small')      IS NULL OR
        json_extract(cover, '$.large')      IS NULL OR
        json_extract(cover, '$.smallAvif')  IS NULL OR
        json_extract(cover, '$.mediumAvif') IS NULL OR
        json_extract(cover, '$.largeAvif')  IS NULL
      )`);

  db.run(`CREATE VIEW IF NOT EXISTS shelves_missing_cover_variants AS
    SELECT
      uri,
      cover,
      substr(uri, -13) AS rkey
    FROM shelves
    WHERE cover IS NOT NULL
      AND (
        json_extract(cover, '$.small')      IS NULL OR
        json_extract(cover, '$.large')      IS NULL OR
        json_extract(cover, '$.smallAvif')  IS NULL OR
        json_extract(cover, '$.mediumAvif') IS NULL OR
        json_extract(cover, '$.largeAvif')  IS NULL
      )`);
}

export function setupFts(): void {
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
    title, author, description, isbn,
    content='books', content_rowid='rowid'
  )`);

  db.run(`CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, title, author, description, isbn)
    VALUES (new.rowid, new.title, new.author, new.description, new.isbn);
  END`);

  db.run(`CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, author, description, isbn)
    VALUES ('delete', old.rowid, old.title, old.title, old.author, old.description, old.isbn);
  END`);

  db.run(`CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, author, description, isbn)
    VALUES ('delete', old.rowid, old.title, old.author, old.description, old.isbn);
    INSERT INTO books_fts(rowid, title, author, description, isbn)
    VALUES (new.rowid, new.title, new.author, new.description, new.isbn);
  END`);
}

export function searchBooks(
  query: string,
): Array<{ uri: string; title: string; author: string; rank: number }> {
  const sanitized = query
    .replace(/['"]/g, '')
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join(' AND ');

  if (!sanitized) return [];

  return sqliteHandle.prepare(
    `SELECT b.uri, b.title, b.author, rank FROM books_fts fts
     JOIN books b ON b.rowid = fts.rowid
     WHERE books_fts MATCH ?
     ORDER BY rank`,
  ).all(sanitized) as Array<{ uri: string; title: string; author: string; rank: number }>;
}

export function ftsSearchBooks(
  query: string,
  limit: number,
  offset: number,
): Array<typeof books.$inferSelect> {
  const sanitized = query
    .replace(/['"]/g, '')
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join(' AND ');

  if (!sanitized) return [];

  return sqliteHandle.prepare(
    `SELECT b.* FROM books_fts fts
     JOIN books b ON b.rowid = fts.rowid
     WHERE books_fts MATCH ?
     ORDER BY rank
     LIMIT ? OFFSET ?`,
  ).all(sanitized, limit, offset) as Array<typeof books.$inferSelect>;
}

/**
 * Anchor a numeric query on the FTS5 prefix index. Avoids the
 * `WHERE isbn LIKE '%x%' OR title LIKE '%x%'` full table scan that
 * `EXPLAIN QUERY PLAN` confirms on a multi-million-row books table.
 *
 * The match expression uses the FTS5 column-restricted prefix form:
 * `isbn:Q* OR title:Q*`. Both columns are indexed in the `books_fts`
 * virtual table, so the query plan is index-only.
 *
 * The original `LIKE '%Q%'` semantic accepted substring matches inside
 * the title (e.g. "12345" matching "Volume 12345 Edition"). Anchoring
 * on prefix is a deliberate trade-off — substring matches forced a
 * SCAN; prefix matches stay index-only. Clients that want substring
 * behavior should use the search-fallback path on miss.
 */
export function ftsSearchBooksNumeric(
  query: string,
  limit: number,
  offset: number,
): Array<typeof books.$inferSelect> {
  const sanitized = query
    .replace(/[^0-9-]+/g, '')
    .trim();

  if (!sanitized) return [];

  // FTS5 special-codes `-` as a NOT operator unless the term is wrapped in
  // double quotes. ISBN values contain dashes, so we quote the prefix
  // expression: `"<sanitized>"*` means "match any token sequence starting
  // with this phrase". This stays index-only — no full scan.
  const match = `isbn:"${sanitized}"* OR title:"${sanitized}"*`;

  return sqliteHandle.prepare(
    `SELECT b.* FROM books_fts fts
     JOIN books b ON b.rowid = fts.rowid
     WHERE books_fts MATCH ?
     ORDER BY rank
     LIMIT ? OFFSET ?`,
  ).all(match, limit, offset) as Array<typeof books.$inferSelect>;
}

export function bootstrapLibrarian(): void {
  const did = process.env.ATP_LIBRARIAN_DID;
  if (!did) return;

  const now = new Date().toISOString();
  const safeSrc = did.replace(/'/g, "''");
  const safeUri = did.replace(/'/g, "''");
  db.run(
    `INSERT OR IGNORE INTO book_labels (src, uri, val, cts, neg) VALUES ('${safeSrc}', '${safeUri}', 'book:librarian', '${now}', 0)`,
  );
  logger.info({ did }, 'bootstrapped librarian');
}

export function bootstrapFeatures(): void {
  const enabled = process.env.ATP_FEATURE_FEED_GENERATOR === '1' ? 1 : 0;
  db.run(
    `INSERT OR IGNORE INTO features (name, enabled) VALUES ('feedGenerator', ${enabled})`,
  );
  logger.info({ enabled }, 'bootstrapped feature feedGenerator');
}

const SEED_CONTRIBUTOR_TYPES: Array<{ name: string; description?: string }> = [
  { name: 'author', description: 'Original writer of the work.' },
  { name: 'illustrator', description: 'Provided the artwork or interior illustrations.' },
  { name: 'editor', description: 'Edited or curated the work.' },
  { name: 'translator', description: 'Translated the work into another language.' },
  { name: 'narrator', description: 'Performed the audiobook version.' },
];

/**
 * Seed the canonical contributor types Bibliograph publishes under its service DID.
 * Idempotent: unique constraint on `name` ensures re-runs are safe.
 */
export async function bootstrapContributorTypes(): Promise<void> {
  const did = process.env.ATP_SERVICE_DID ?? 'did:web:localhost';
  const now = new Date().toISOString();

  let inserted = 0;
  let backfilledCid = 0;
  for (const seed of SEED_CONTRIBUTOR_TYPES) {
    const existing = db
      .select()
      .from(contributorTypes)
      .where(eq(contributorTypes.name, seed.name))
      .all();
    const uri = makeRecordUri(did, COLLECTIONS.contributorType, generateRkey());

    if (existing.length > 0) {
      // Backfill any missing CIDs on existing rows. Idempotent.
      const row = existing[0];
      if (!row.cid) {
        const cid = await cidForRecord(
          serializeContributorType({
            uri: row.uri,
            did: row.did,
            name: row.name,
            description: row.description ?? null,
            cid: null,
            createdAt: row.createdAt,
          }),
        );
        db.update(contributorTypes).set({ cid }).where(eq(contributorTypes.uri, row.uri)).run();
        backfilledCid++;
      }
      continue;
    }

    const cid = await cidForRecord(
      serializeContributorType({
        uri,
        did,
        name: seed.name,
        description: seed.description ?? null,
        cid: null,
        createdAt: now,
      }),
    );
    db.insert(contributorTypes)
      .values({
        uri,
        did,
        name: seed.name,
        description: seed.description,
        cid,
        createdAt: now,
      })
      .run();
    inserted++;
  }
  logger.info(
    { seeded: SEED_CONTRIBUTOR_TYPES.length, inserted, backfilledCid },
    'bootstrapped contributor types',
  );
}
