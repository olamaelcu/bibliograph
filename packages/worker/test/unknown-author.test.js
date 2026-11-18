import { expect, test, beforeAll, afterAll } from 'vitest';

import fs from 'node:fs/promises';
import pg from 'pg';

import { createIngest } from '../lib/ingest.js';

/**
 * `Unknown Author` is a feed placeholder, not a person.
 *
 * `lib/ingest.js` drops it at preparation time so it never becomes a
 * contributor row; `sql/0029-drop-unknown-author.sql` removes the rows earlier
 * ingests already wrote. The tests below run the real ingest and replay the
 * real migration file against the suite's schema.
 */

// `catalog-schema-check` points the integration files at its own scratch
// database; a plain `vitest run` gets the suite's throwaway container through
// `DATABASE_URL` (vitest.global-setup.js).
const DATABASE_URL =
  process.env.CATALOG_SCHEMA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SKIP = DATABASE_URL
  ? false
  : 'needs DATABASE_URL (vitest.global-setup.js) or CATALOG_SCHEMA_TEST_DATABASE_URL';

const AUTHORITY = 'did:plc:unknownauthorprobe';
const PREFIX = `at://${AUTHORITY}/%`;
const MIGRATION_URL = new URL('../sql/0029-drop-unknown-author.sql', import.meta.url);
const PLACEHOLDER = 'unknown author';
const COLLECTION = 'community.lexicon.media.book.edition';

// Unassigned, checksum-valid ISBNs: a real identifier would resolve to the
// edition that owns it instead of minting one under the test authority.
function isbn13For(index) {
  const base = `97800000${String(index).padStart(4, '0')}`;
  let sum = 0;
  for (let position = 0; position < 12; position += 1) {
    sum += Number(base[position]) * (position % 2 ? 3 : 1);
  }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

let pool;

async function cleanup() {
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [PREFIX]);
  await pool.query(
    `DELETE FROM contributors c
      WHERE c.at_uri LIKE $1
        AND NOT EXISTS (
          SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id
        )`,
    [PREFIX]
  );
  // After the entity rows: deleting one queues its outbox delete.
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [PREFIX]);
}

async function placeholderRows() {
  const result = await pool.query(
    'SELECT id FROM contributors WHERE lower(btrim(name)) = $1',
    [PLACEHOLDER]
  );
  return result.rows.length;
}

async function applyMigration() {
  await pool.query(await fs.readFile(MIGRATION_URL, 'utf8'));
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await cleanup();
});

afterAll(async () => {
  if (!pool) return;
  await cleanup();
  await pool.end();
});

test(
  'a candidate crediting the placeholder in any case and spacing mints no credit and no contributor row',
  { skip: SKIP },
  async () => {
    const ingest = createIngest({ pool, publisherDid: AUTHORITY });
    const before = await placeholderRows();

    const result = await ingest({
      identifiers: [{ issuer: 'isbn13', value: isbn13For(7001) }],
      title: 'Placeholder Probe Edition',
      language: 'en',
      contributors: [{ name: '\tUnKnOwN   Author\n' }]
    });

    expect(result.uri.startsWith(`at://${AUTHORITY}/${COLLECTION}/`)).toBe(true);

    const credits = await pool.query(
      `SELECT ec.position, c.name
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE ec.edition_uri = $1`,
      [result.uri]
    );
    expect(credits.rows).toEqual([]);
    expect(await placeholderRows(), 'no contributor row is minted for the placeholder').toBe(
      before
    );
  }
);

test(
  'the placeholder takes no position, so a filtered credit leaves the positions dense',
  { skip: SKIP },
  async () => {
    const ingest = createIngest({ pool, publisherDid: AUTHORITY });

    const result = await ingest({
      identifiers: [{ issuer: 'isbn13', value: isbn13For(7002) }],
      title: 'Dense Position Probe Edition',
      contributors: [{ name: 'Unknown Author' }, { name: 'Dense Probe Author' }]
    });

    const credits = await pool.query(
      `SELECT ec.position, c.name
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE ec.edition_uri = $1
        ORDER BY ec.position`,
      [result.uri]
    );
    expect(credits.rows).toEqual([{ position: 1, name: 'Dense Probe Author' }]);
  }
);

test(
  'a name that is not on the denylist is still credited',
  { skip: SKIP },
  async () => {
    const ingest = createIngest({ pool, publisherDid: AUTHORITY });

    // The list is deliberately one name: other feed placeholders keep the
    // behaviour they had, so no one widens this by accident.
    const result = await ingest({
      identifiers: [{ issuer: 'isbn13', value: isbn13For(7003) }],
      title: 'Anonymous Credit Probe Edition',
      contributors: [{ name: 'Anonymous' }]
    });

    const credits = await pool.query(
      `SELECT ec.position, c.name
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE ec.edition_uri = $1`,
      [result.uri]
    );
    expect(credits.rows).toEqual([{ position: 1, name: 'Anonymous' }]);
  }
);

test(
  'the migration drops the placeholder credits and rows, and its replay is a no-op',
  { skip: SKIP },
  async () => {
    const editionUri = `at://${AUTHORITY}/${COLLECTION}/unknownprobe1`;
    const placeholderUri = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/unknownprobe1`;
    const spacedUri = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/unknownprobe2`;
    const knownUri = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/unknownprobe3`;

    await pool.query(
      'INSERT INTO books (uri, rkey, title, created_at) VALUES ($1, $2, $3, now())',
      [editionUri, 'unknownprobe1', 'Placeholder Migration Probe']
    );
    const contributors = await pool.query(
      `INSERT INTO contributors (name, identifiers, at_uri)
       VALUES ('Unknown Author', '[]'::jsonb, $1),
              ('  UNKNOWN AUTHOR ', '[{"issuer": "probe", "value": "variant"}]'::jsonb, $2),
              ('Known Probe Author', '[]'::jsonb, $3)
       RETURNING id, name`,
      [placeholderUri, spacedUri, knownUri]
    );
    const [placeholder, spaced, known] = contributors.rows;
    await pool.query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
       VALUES ($1, $2, 1, 'author'), ($1, $3, 2, 'author'), ($1, $4, 3, 'author')`,
      [editionUri, placeholder.id, spaced.id, known.id]
    );

    await applyMigration();

    const credits = await pool.query(
      `SELECT ec.position, c.name
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE ec.edition_uri = $1
        ORDER BY ec.position`,
      [editionUri]
    );
    expect(credits.rows).toEqual([{ position: 3, name: 'Known Probe Author' }]);

    const remaining = await pool.query(
      'SELECT count(*)::int AS n FROM contributors WHERE id = ANY($1::bigint[])',
      [[placeholder.id, spaced.id]]
    );
    expect(remaining.rows[0].n).toBe(0);

    // Removing a credit queues the edition, removing the contributor queues its
    // entity-record delete; both are how the published records stop carrying
    // the placeholder.
    const outbox = await pool.query(
      'SELECT uri, op FROM pds_outbox WHERE uri LIKE $1 ORDER BY uri',
      [PREFIX]
    );
    expect(Object.fromEntries(outbox.rows.map((row) => [row.uri, row.op]))).toMatchObject({
      [placeholderUri]: 'delete',
      [spacedUri]: 'delete',
      [knownUri]: 'create'
    });
    expect(outbox.rows.find((row) => row.uri === editionUri)).toBeDefined();

    // A replay deletes nothing, so no trigger fires and no outbox row is
    // rewritten. `updated_at` changes on every enqueue, so it proves the
    // no-op.
    const before = await pool.query(
      'SELECT uri, op, updated_at FROM pds_outbox WHERE uri LIKE $1 ORDER BY uri',
      [PREFIX]
    );
    await applyMigration();
    const after = await pool.query(
      'SELECT uri, op, updated_at FROM pds_outbox WHERE uri LIKE $1 ORDER BY uri',
      [PREFIX]
    );
    expect(after.rows).toEqual(before.rows);

    const creditsAfter = await pool.query(
      'SELECT count(*)::int AS n FROM edition_contributors WHERE edition_uri = $1',
      [editionUri]
    );
    expect(creditsAfter.rows[0].n).toBe(1);
  }
);
