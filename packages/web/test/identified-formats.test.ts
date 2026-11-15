import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITION_COLLECTION,
  getEditionIdentifiedFormats
} from '../src/lib/server/catalog/identified-formats.ts';
import type { EntityQueryable } from '../src/lib/server/catalog/entities.ts';

const EDITION_URI = `at://did:plc:formattest/${EDITION_COLLECTION}/3abc`;

type Call = { sql: string; values?: unknown[] };

type IdentifierRow = {
  chapters: number | null;
  issuer: string;
  value: string;
  format: string | null;
  pages: number | null;
  duration_seconds: number | null;
};

/** A test double exposing only `query`, which is all the module uses. */
function fakePool(answers: {
  present?: boolean;
  identifiers?: IdentifierRow[];
}): { pool: EntityQueryable; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      const rows = sql.includes('EXISTS')
        ? [{ present: answers.present === true }]
        : (answers.identifiers ?? []);
      return { rows, rowCount: rows.length };
    }
  } as unknown as EntityQueryable;
  return { pool, calls };
}

test('getEditionIdentifiedFormats answers null when the edition is not in the catalog', async () => {
  const { pool } = fakePool({
    present: false,
    identifiers: [
      {
        chapters: null,
        issuer: 'isbn13',
        value: '9781635575637',
        format: 'physical',
        pages: 320,
        duration_seconds: null
      }
    ]
  });
  assert.equal(await getEditionIdentifiedFormats(pool, EDITION_URI), null);
});

test('a print identifier and an audio identifier keep rank order and their own units', async () => {
  const { pool } = fakePool({
    present: true,
    identifiers: [
      {
        chapters: 12,
        issuer: 'isbn13',
        value: '9781635575637',
        format: 'physical',
        pages: 320,
        duration_seconds: null
      },
      {
        chapters: 12,
        issuer: 'asin',
        value: 'B08N5WRWNW',
        format: 'audio',
        pages: null,
        duration_seconds: 32400
      }
    ]
  });

  assert.deepEqual(await getEditionIdentifiedFormats(pool, EDITION_URI), {
    uri: EDITION_URI,
    chapters: 12,
    identifiers: [
      {
        issuer: 'isbn13',
        value: '9781635575637',
        format: 'physical',
        pages: 320,
        progressUnit: 'page'
      },
      {
        issuer: 'asin',
        value: 'B08N5WRWNW',
        format: 'audio',
        durationSeconds: 32400,
        progressUnit: 'timestamp'
      }
    ]
  });
});

test('an identifier with no provider claim is listed with no medium and no extent', async () => {
  const { pool } = fakePool({
    present: true,
    identifiers: [
      {
        chapters: null,
        issuer: 'isbn13',
        value: '9781635575637',
        format: null,
        pages: null,
        duration_seconds: null
      }
    ]
  });

  assert.deepEqual(await getEditionIdentifiedFormats(pool, EDITION_URI), {
    uri: EDITION_URI,
    identifiers: [{ issuer: 'isbn13', value: '9781635575637' }]
  });
});

test('both queries bind the URI and nothing else', async () => {
  const { pool, calls } = fakePool({ present: true, identifiers: [] });
  assert.deepEqual(await getEditionIdentifiedFormats(pool, EDITION_URI), {
    uri: EDITION_URI,
    identifiers: []
  });

  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.values, [EDITION_URI]);
  assert.match(calls[0].sql, /FROM editions WHERE uri = \$1/);
  // The claims query must not depend on `identifier_shape_rank` existing: the
  // rank is inline, so this read works on a database that predates 0007.
  assert.match(calls[1].sql, /WHEN 'isbn13' THEN 0/);
  assert.doesNotMatch(calls[1].sql, /identifier_shape_rank/);
  assert.match(calls[1].sql, /LEFT JOIN edition_identifier_info/);
});
