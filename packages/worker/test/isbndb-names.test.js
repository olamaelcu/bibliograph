import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';

import { parseIsbndbAuthor } from '../lib/isbndb-names.js';
import { candidateFromIsbndb } from '../lib/providers/isbndb.js';
import { createIngest } from '../lib/ingest.js';
import {
  describeDatabase,
  identityKey,
  normalizeAuthors,
  parseArgs
} from '../scripts/normalize-isbndb-author-names.mjs';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const SCRATCH_URL = process.env.CATALOG_SCHEMA_TEST_DATABASE_URL;
const SCRATCH_SKIP = SCRATCH_URL
  ? false
  : 'set CATALOG_SCHEMA_TEST_DATABASE_URL to an empty scratch database';

const AUTHORITY = 'did:plc:isbndbnamesprobe';
const PROBE_IDENTIFIERS = [{ issuer: 'probe', value: 'isbndb-author-names' }];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const PARSED = [
  // Plain inverted name.
  ['Le Guin, Ursula K.', 'Ursula K. Le Guin', 'Le Guin, Ursula K.'],
  // A surname particle at the start keeps its case and position.
  ['van Gogh, Vincent', 'Vincent van Gogh', 'van Gogh, Vincent'],
  ['de la Chevotière, Robert', 'Robert de la Chevotière', 'de la Chevotière, Robert'],
  ['Du Bois, W. E. B.', 'W. E. B. Du Bois', 'Du Bois, W. E. B.'],
  ['St. John, Henry', 'Henry St. John', 'St. John, Henry'],
  // A particle trailing the given-name side moves in front of the surname.
  ['Andrade, Carlos Drummond de', 'Carlos Drummond de Andrade', 'Andrade, Carlos Drummond de'],
  ['Beethoven, Ludwig van', 'Ludwig van Beethoven', 'Beethoven, Ludwig van'],
  ['Dijck, José van', 'José van Dijck', 'Dijck, José van'],
  ['Waal, F. B. M. de', 'F. B. M. de Waal', 'Waal, F. B. M. de'],
  ['Duras, Claire de Durfort duchesse de', 'Claire de Durfort duchesse de Duras', 'Duras, Claire de Durfort duchesse de'],
  // `Waal, de` has no given name to keep; the particle is not moved twice.
  ['Waal, de', 'de Waal', 'Waal, de'],
  // A particle already in front is not duplicated.
  ['van Berg, Jan van', 'Jan van Berg', 'van Berg, Jan van'],
  // Suffixes as their own comma segment.
  ['King, Martin Luther, Jr.', 'Martin Luther King Jr.', 'King, Martin Luther, Jr.'],
  ['Doe, John, Ph.D.', 'John Doe Ph.D.', 'Doe, John, Ph.D.'],
  ['Roe, Jane, M.D.', 'Jane Roe M.D.', 'Roe, Jane, M.D.'],
  ['Poe, Edgar, II', 'Edgar Poe II', 'Poe, Edgar, II'],
  ['Doe, Jane, Esq.', 'Jane Doe Esq.', 'Doe, Jane, Esq.'],
  ['Smith, John, Jr., PhD', 'John Smith Jr. PhD', 'Smith, John, Jr., PhD'],
  // A suffix inside the given-name side moves after the surname.
  ['King, Martin Luther Jr.', 'Martin Luther King Jr.', 'King, Martin Luther Jr.'],
  ['Smith, John II', 'John Smith II', 'Smith, John II'],
  // Apostrophes and hyphens are name punctuation.
  ["O'Brien, Flann", "Flann O'Brien", "O'Brien, Flann"],
  ['Phillips-Fein, Kim', 'Kim Phillips-Fein', 'Phillips-Fein, Kim'],
  ['Àbíké-Íyímídé, Faridah', 'Faridah Àbíké-Íyímídé', 'Àbíké-Íyímídé, Faridah'],
  ["D'Avanzo, Giuseppe", "Giuseppe D'Avanzo", "D'Avanzo, Giuseppe"],
  ["L'Engle, Madeleine", "Madeleine L'Engle", "L'Engle, Madeleine"],
  ['Le Carré, John', 'John Le Carré', 'Le Carré, John'],
  ['Sève, Lucien', 'Lucien Sève', 'Sève, Lucien'],
  ['Barabási, Albert-László', 'Albert-László Barabási', 'Barabási, Albert-László'],
  ['du Maurier, Daphne', 'Daphne du Maurier', 'du Maurier, Daphne'],
  // Cyrillic names normalize the same way; the script leaves rendering alone.
  ['Герберт, Френк', 'Френк Герберт', 'Герберт, Френк'],
  // A missing space after the comma is still one inverted name.
  ['Parks,Susan Lori', 'Susan Lori Parks', 'Parks, Susan Lori'],
  // Lowercase display names are intentional.
  ['hooks, bell', 'bell hooks', 'hooks, bell'],
  // Invisible marks are dropped from the inverted form.
  ['Garvey, Marcus,\u200f', 'Marcus Garvey', 'Garvey, Marcus'],
  ['Palmer, Colin A. ', 'Colin A. Palmer', 'Palmer, Colin A.'],
  // A stray trailing comma is collapsed away, not carried into the record.
  ['Smith, John,', 'John Smith', 'Smith, John']
];

for (const [input, name, nameInverted] of PARSED) {
  test(`parses ${JSON.stringify(input)}`, () => {
    assert.deepEqual(parseIsbndbAuthor(input), { name, nameInverted });
  });
}

const UNPARSED = [
  // Already a display name: nothing to rewrite.
  'Ursula K. Le Guin',
  'Logic Magazine',
  // Organizations and institutional strings.
  'Institute of Electrical and Electronics Engineers, Inc. Staff',
  'Hall, Tanya (CEO of Greenleaf Book Group)',
  'MacDonald, Brian (Editor)',
  'Publishing, Workwoman',
  'Books, Hephaestus',
  // Display-order names with a suffix after the comma.
  'Devon Price, PhD',
  'Tim Groseclose, PhD',
  // Cataloging artifacts: a title in the given side, a stray period, or an
  // appended translator after a space before the comma.
  'Hoby, Thomas Sir',
  'Pope-Hennessy, James.',
  'Vatsyayana , A.N.D. Haksar',
  // Lost bytes cannot be reordered safely.
  'Moraga, Cherr\ufffDe',
  // Multiple authors in one value.
  'Wilson, Greg; Oram, Andy',
  'Smith, John et al.',
  // Dates, cataloger notes and ambiguous extra commas.
  'Takaki, Ronald T., 1939-',
  'Palmer,ColinA.,1942-',
  'Smith, John, Mary',
  'hooks, bell poète, critique littéraire et essayiste',
  // A suffix with no given name.
  'Dr. Martin Luther King, Jr.',
  // Empty/garbage input.
  '',
  ', John',
  'Smith,'
];

for (const input of UNPARSED) {
  test(`leaves ${JSON.stringify(input)} unchanged`, () => {
    assert.equal(parseIsbndbAuthor(input), null);
  });
}

test('ignores non-string values', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(parseIsbndbAuthor(value), null);
  }
});

// ---------------------------------------------------------------------------
// Provider mapping
// ---------------------------------------------------------------------------

test('ISBNdb candidates normalize inverted authors and keep display names', () => {
  const candidate = candidateFromIsbndb({
    title: 'Author Mapping Probe',
    isbn13: '9780306406157',
    authors: [
      'Le Guin, Ursula K.',
      'Ursula K. Le Guin',
      'King, Martin Luther, Jr.',
      'Logic Magazine',
      '   '
    ]
  });
  assert.deepEqual(candidate.contributors, [
    { name: 'Ursula K. Le Guin', role: 'A01', nameInverted: 'Le Guin, Ursula K.' },
    { name: 'Martin Luther King Jr.', role: 'A01', nameInverted: 'King, Martin Luther, Jr.' },
    { name: 'Logic Magazine', role: 'A01' }
  ]);
});

test('ISBNdb author order and repeated raw values are preserved once', () => {
  const candidate = candidateFromIsbndb({
    title: 'Author Order Probe',
    isbn13: '9780306406157',
    authors: ['hooks, bell', '  hooks, bell  ', 'Le Guin, Ursula K.']
  });
  assert.deepEqual(
    candidate.contributors.map((contributor) => contributor.name),
    ['bell hooks', 'Ursula K. Le Guin']
  );
});

// ---------------------------------------------------------------------------
// Ingest persistence
// ---------------------------------------------------------------------------

/** Build a checksum-valid ISBN-13 so `candidateFromIsbndb` accepts it. */
function ingestCandidate(title, identifier, contributor) {
  return {
    title,
    identifiers: [{ issuer: 'probe', value: identifier }],
    contributors: [contributor]
  };
}

async function contributorRow(pool) {
  const result = await pool.query(
    `SELECT id, name, name_inverted, identifiers, at_uri, created_at
       FROM contributors
      WHERE identifiers @> $1::jsonb`,
    [JSON.stringify(PROBE_IDENTIFIERS)]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function cleanupIngest(pool) {
  const prefix = `at://${AUTHORITY}/%`;
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE identifiers @> $1::jsonb', [
    JSON.stringify(PROBE_IDENTIFIERS)
  ]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
}

test('ingest persists name_inverted and never overwrites a curated value', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const contributor = {
    name: 'Florence Q. Nightingale',
    nameInverted: 'Nightingale, Florence Q.',
    identifiers: PROBE_IDENTIFIERS,
    role: 'A01'
  };

  try {
    await cleanupIngest(pool);

    await ingest(ingestCandidate('Probe Volume One', 'ingest-name-1', contributor));
    const first = await contributorRow(pool);
    assert.equal(first.name, 'Florence Q. Nightingale');
    assert.equal(first.name_inverted, 'Nightingale, Florence Q.');
    assert.ok(first.at_uri, 'ingest mints the entity URI');

    // A curated value is not provider metadata: later hydration leaves it.
    await pool.query("UPDATE contributors SET name_inverted = 'Manual, Value' WHERE id = $1", [
      first.id
    ]);
    await ingest(
      ingestCandidate('Probe Volume Two', 'ingest-name-2', {
        ...contributor,
        nameInverted: 'Provider, Reattempt'
      })
    );
    const second = await contributorRow(pool);
    assert.equal(second.id, first.id, 'identity is still (name, identifiers)');
    assert.equal(second.name_inverted, 'Manual, Value');
    assert.equal(second.at_uri, first.at_uri);
    assert.equal(second.created_at.getTime(), first.created_at.getTime());

    // A NULL column is filled from the provider value.
    await pool.query('UPDATE contributors SET name_inverted = NULL WHERE id = $1', [first.id]);
    await ingest(ingestCandidate('Probe Volume Three', 'ingest-name-3', contributor));
    assert.equal((await contributorRow(pool)).name_inverted, 'Nightingale, Florence Q.');

    // A caller without nameInverted leaves an existing value alone.
    await pool.query("UPDATE contributors SET name_inverted = 'Manual, Value' WHERE id = $1", [
      first.id
    ]);
    await ingest(
      ingestCandidate('Probe Volume Four', 'ingest-name-4', {
        name: 'Florence Q. Nightingale',
        identifiers: PROBE_IDENTIFIERS,
        role: 'A01'
      })
    );
    assert.equal((await contributorRow(pool)).name_inverted, 'Manual, Value');

    const outbox = await pool.query('SELECT collection FROM pds_outbox WHERE uri = $1', [
      first.at_uri
    ]);
    assert.deepEqual(outbox.rows, [
      { collection: 'net.olamaelcu.livtet.biblio.contributor' }
    ]);
  } finally {
    await cleanupIngest(pool);
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Backfill script
// ---------------------------------------------------------------------------

test('backfill arguments and connection descriptions are safe', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    includeIdentified: false,
    limit: Infinity,
    sample: 8
  });
  assert.deepEqual(parseArgs(['--apply', '--limit', '10', '--include-identified', '--sample=3']), {
    apply: true,
    includeIdentified: true,
    limit: 10,
    sample: 3
  });
  assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);

  assert.equal(
    describeDatabase('postgres://user:secret@db.example:5432/booklog'),
    'db.example:5432/booklog'
  );
  assert.equal(describeDatabase('not a url'), '(unparseable DATABASE_URL)');
  assert.doesNotMatch(
    describeDatabase('postgres://user:secret@db.example/booklog'),
    /secret|user/
  );

  assert.equal(
    identityKey('Smith, John', [
      { issuer: 'b', value: '2' },
      { issuer: 'a', value: '1' }
    ]),
    identityKey('smith, john', [
      { issuer: 'a', value: '1' },
      { issuer: 'b', value: '2' }
    ])
  );
});

const SCRATCH_SCHEMA_URL = new URL('../sql/', import.meta.url);

const SCRATCH_ROWS = [
  { name: 'Waal, Frans de', nameInverted: null, atUri: null },
  {
    name: 'King, Martin Luther, Jr.',
    nameInverted: null,
    atUri: 'at://did:plc:isbndbnamestest/net.olamaelcu.livtet.biblio.contributor/scratch'
  },
  { name: 'Smith, John', nameInverted: null, atUri: null },
  { name: 'John Smith', nameInverted: null, atUri: null },
  { name: 'Institute of Electrical and Electronics Engineers, Inc. Staff', nameInverted: null, atUri: null },
  { name: 'Le Guin, Ursula K.', nameInverted: 'Le Guin, Ursula K.', atUri: null },
  { name: 'Logic Magazine', nameInverted: null, atUri: null }
];
// Include the post-apply names so a failed earlier run is cleaned up too.
const SCRATCH_NAMES = [
  ...SCRATCH_ROWS.map((row) => row.name),
  'Frans de Waal',
  'Martin Luther King Jr.'
];

async function applyScratchSchema(pool) {
  const files = (await fs.readdir(SCRATCH_SCHEMA_URL))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await pool.query(await fs.readFile(new URL(file, SCRATCH_SCHEMA_URL), 'utf8'));
  }
}

async function cleanupScratch(pool) {
  await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:plc:isbndbnamestest/%'");
  await pool.query('DELETE FROM contributors WHERE name = ANY($1)', [SCRATCH_NAMES]);
}

test(
  'backfill dry-run reports candidates, conflicts and skips; apply is idempotent',
  { skip: SCRATCH_SKIP },
  async () => {
    const pool = new pg.Pool({ connectionString: SCRATCH_URL, max: 2 });
    let client;
    try {
      await applyScratchSchema(pool);
      // One connection for the whole run: the apply step is a transaction.
      client = await pool.connect();
      await cleanupScratch(client);
      for (const row of SCRATCH_ROWS) {
        await client.query(
          `INSERT INTO contributors (name, name_inverted, identifiers, at_uri)
           VALUES ($1, $2, '[]'::jsonb, $3)`,
          [row.name, row.nameInverted, row.atUri]
        );
      }
      const before = await client.query(
        'SELECT id, name, name_inverted, at_uri, created_at FROM contributors ORDER BY id'
      );

      const dry = await normalizeAuthors(client, { sample: 10 });
      assert.equal(dry.apply, false);
      assert.equal(dry.selected, 4, 'comma names without name_inverted');
      assert.equal(dry.candidates.length, 2);
      assert.equal(dry.conflicts, 1);
      assert.equal(dry.skipped, 1);
      assert.equal(dry.identified, 0);
      assert.equal(dry.applied, 0);

      const emptyRun = await normalizeAuthors(client, { includeIdentified: true, sample: 10 });
      assert.equal(emptyRun.selected, 5);
      assert.equal(emptyRun.identified, 1, 'the curated inverted form is seen but untouched');

      // Dry run never writes.
      const unchanged = await client.query(
        'SELECT id, name, name_inverted, at_uri, created_at FROM contributors ORDER BY id'
      );
      assert.deepEqual(unchanged.rows, before.rows);

      const applied = await normalizeAuthors(client, { apply: true, limit: 10, sample: 10 });
      assert.equal(applied.applied, 2);
      assert.equal(applied.failures.length, 0);

      const after = await client.query(
        `SELECT name, name_inverted, at_uri, created_at FROM contributors
          WHERE name IN ('Frans de Waal', 'Martin Luther King Jr.', 'Smith, John',
                        'Le Guin, Ursula K.', 'Institute of Electrical and Electronics Engineers, Inc. Staff')
          ORDER BY name`
      );
      assert.deepEqual(
        after.rows.map((row) => [row.name, row.name_inverted]),
        [
          ['Frans de Waal', 'Waal, Frans de'],
          ['Institute of Electrical and Electronics Engineers, Inc. Staff', null],
          ['Le Guin, Ursula K.', 'Le Guin, Ursula K.'],
          ['Martin Luther King Jr.', 'King, Martin Luther, Jr.'],
          ['Smith, John', null]
        ]
      );
      // `id`, `at_uri` and `created_at` are untouched by the rewrite.
      const renamed = after.rows.find((row) => row.name === 'Martin Luther King Jr.');
      const original = before.rows.find((row) => row.name === 'King, Martin Luther, Jr.');
      assert.equal(renamed.at_uri, original.at_uri);
      assert.equal(renamed.created_at.getTime(), original.created_at.getTime());

      // The contributor trigger queued the record under the same URI.
      const outbox = await client.query('SELECT uri, op FROM pds_outbox ORDER BY uri');
      assert.ok(
        outbox.rows.some(
          (row) =>
            row.uri === original.at_uri &&
            row.op !== 'delete' &&
            row.uri.endsWith('/scratch')
        )
      );

      // Re-running selects only the still-unresolved rows and writes nothing.
      const rerun = await normalizeAuthors(client, { apply: true, sample: 10 });
      assert.equal(rerun.candidates.length, 0);
      assert.equal(rerun.applied, 0);
      assert.equal(rerun.conflicts, 1);
      assert.equal(rerun.skipped, 1);
    } finally {
      if (client) {
        await cleanupScratch(client);
        client.release();
      }
      await pool.end();
    }
  }
);
