import { db } from './connection.js';
import { logger } from '../logger.js';

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
    VALUES ('delete', old.rowid, old.title, old.author, old.description, old.isbn);
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
    .join(' AND ');

  return db.all(
    `SELECT b.uri, b.title, b.author, rank FROM books_fts fts
     JOIN books b ON b.rowid = fts.rowid
     WHERE books_fts MATCH '${sanitized}'
     ORDER BY rank`,
  ) as any;
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
