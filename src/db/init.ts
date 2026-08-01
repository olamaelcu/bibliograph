import { db } from './connection.js';

/**
 * Creates a full-text search virtual table on books and keeps it
 * synchronised via INSERT, DELETE, and UPDATE triggers.
 */
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

/**
 * Search the full-text index and return matching books ordered by relevance.
 */
export function searchBooks(
  query: string,
): Array<{ uri: string; title: string; author: string; rank: number }> {
  const sanitized = query
    .replace(/['"]/g, '')
    .trim()
    .split(/\s+/)
    .join(' AND ');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.all(
    `SELECT b.uri, b.title, b.author, rank FROM books_fts fts
     JOIN books b ON b.rowid = fts.rowid
     WHERE books_fts MATCH '${sanitized}'
     ORDER BY rank`,
  ) as any;
}

/**
 * Run initialisation steps needed before the app starts.
 */
export async function runMigrations(): Promise<void> {
  // Ensure tables exist (drizzle-kit push equivalent via raw SQL)
  // In production, use drizzle-kit generate + migrate instead
  createTables();
  setupFts();
  bootstrapLibrarian();
}

function createTables(): void {
  db.run(`CREATE TABLE IF NOT EXISTS books (
    uri TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    isbn TEXT UNIQUE,
    published_date TEXT,
    description TEXT,
    page_count INTEGER,
    language TEXT DEFAULT 'en',
    categories TEXT DEFAULT '[]',
    identifiers TEXT DEFAULT '[]',
    cover_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS books_title_idx ON books(title)`);
  db.run(`CREATE INDEX IF NOT EXISTS books_author_idx ON books(author)`);
  db.run(`CREATE INDEX IF NOT EXISTS books_status_idx ON books(status)`);

  db.run(`CREATE TABLE IF NOT EXISTS claims (
    uri TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    book_uri TEXT NOT NULL REFERENCES books(uri) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    identifier_type TEXT NOT NULL,
    claimed_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(book_uri, claimed_by)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS claims_book_uri_idx ON claims(book_uri)`);
  db.run(`CREATE INDEX IF NOT EXISTS claims_status_idx ON claims(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS claims_claimed_by_idx ON claims(claimed_by)`);
  db.run(`CREATE INDEX IF NOT EXISTS claims_identifier_idx ON claims(identifier)`);

  db.run(`CREATE TABLE IF NOT EXISTS reviews (
    uri TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    book_uri TEXT NOT NULL REFERENCES books(uri) ON DELETE CASCADE,
    text TEXT NOT NULL,
    rating REAL CHECK(rating >= 1 AND rating <= 5),
    created_at TEXT NOT NULL
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS reviews_book_uri_idx ON reviews(book_uri)`);
  db.run(`CREATE INDEX IF NOT EXISTS reviews_did_idx ON reviews(did)`);

  db.run(`CREATE TABLE IF NOT EXISTS reading_statuses (
    uri TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    book_uri TEXT NOT NULL REFERENCES books(uri) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'to-read',
    progress REAL CHECK(progress >= 0 AND progress <= 100),
    rating REAL CHECK(rating >= 1 AND rating <= 5),
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS reading_statuses_book_uri_idx ON reading_statuses(book_uri)`);
  db.run(`CREATE INDEX IF NOT EXISTS reading_statuses_did_idx ON reading_statuses(did)`);
  db.run(`CREATE INDEX IF NOT EXISTS reading_statuses_status_idx ON reading_statuses(status)`);

  db.run(`CREATE TABLE IF NOT EXISTS book_labels (
    src TEXT NOT NULL,
    uri TEXT NOT NULL,
    val TEXT NOT NULL,
    cts TEXT NOT NULL,
    neg INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (src, uri, val)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS book_labels_uri_idx ON book_labels(uri)`);
  db.run(`CREATE INDEX IF NOT EXISTS book_labels_val_idx ON book_labels(val)`);
}

/**
 * Bootstraps the first librarian from the ATP_LIBRARIAN_DID env var.
 * This is a reference implementation: label authority is self-contained,
 * no external labeler service dependency.
 */
function bootstrapLibrarian(): void {
  const did = process.env.ATP_LIBRARIAN_DID;
  if (!did) return;

  const now = new Date().toISOString();
  const safeSrc = did.replace(/'/g, "''");
  const safeUri = did.replace(/'/g, "''");
  db.run(
    `INSERT OR IGNORE INTO book_labels (src, uri, val, cts, neg) VALUES ('${safeSrc}', '${safeUri}', 'book:librarian', '${now}', 0)`,
  );
  console.log(`Bootstrapped librarian: ${did}`);
}
