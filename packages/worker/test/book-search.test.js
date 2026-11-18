/**
 * `book_search` maintenance.
 *
 * The document is what `searchEditions` matches free text against, so it has to
 * carry every contributing table's lexemes and nothing stale. These assertions
 * are deliberately about visibility (`document @@ query`) rather than about the
 * tsvector's text: the configuration is an implementation detail, the match is
 * the contract.
 *
 * Runs against the throwaway Postgres the vitest global setup starts, with the
 * whole `sql/` directory applied.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = process.hrtime.bigint().toString(36);
const URI = `at://did:plc:booksearchprobe/community.lexicon.media.book.edition/${RUN}`;

let pool;

async function matches(term) {
  const { rows } = await pool.query(
    `SELECT document @@ websearch_to_tsquery('english', $1) AS hit
       FROM book_search WHERE uri = $2`,
    [term, URI]
  );
  return rows[0]?.hit === true;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await pool.query(
    `INSERT INTO books (uri, rkey, title, created_at)
     VALUES ($1, $2, 'Erewhon Probe', now())`,
    [URI, RUN]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM books WHERE uri = $1', [URI]);
  await pool.query(
    `DELETE FROM contributors c
      WHERE c.name = $1
        AND NOT EXISTS (SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id)`,
    [`Book Search Probe Author ${RUN}`]
  );
  await pool.end();
});

test('a book insert produces a searchable document', async () => {
  expect(await matches('erewhon')).toBe(true);
});

test('contributor, identifier and description lexemes land in the document', async () => {
  const author = `Book Search Probe Author ${RUN}`;
  await pool.query('INSERT INTO contributors (name) VALUES ($1)', [author]);
  await pool.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position)
     SELECT $1, id, 0 FROM contributors WHERE name = $2`,
    [URI, author]
  );
  await pool.query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     VALUES ($1, 'isbn13', '9780000000${RUN.slice(0, 2)}')`,
    [URI]
  );
  await pool.query(
    `INSERT INTO edition_shape (edition_uri, description)
     VALUES ($1, 'A satirical utopia about machines')`,
    [URI]
  );

  expect(await matches(author.split(' ').at(-1))).toBe(true);
  expect(await matches('satirical')).toBe(true);
  expect(await matches('machines')).toBe(true);
});

test('a title update replaces the old lexemes and keeps one row', async () => {
  await pool.query('UPDATE books SET title = $2 WHERE uri = $1', [URI, 'Erewhon Revised']);

  expect(await matches('revised')).toBe(true);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM book_search WHERE uri = $1', [
    URI
  ]);
  expect(rows[0].n).toBe(1);
});

test('deleting the book cascades the document away', async () => {
  await pool.query('DELETE FROM books WHERE uri = $1', [URI]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM book_search WHERE uri = $1', [
    URI
  ]);
  expect(rows[0].n).toBe(0);
});
