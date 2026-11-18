import { expect, test } from 'vitest';

import {
  EDITION_COLLECTION,
  getBookIdentifiedFormats
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

test('getBookIdentifiedFormats answers null when the edition is not in the catalog', async () => {
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
  expect(await getBookIdentifiedFormats(pool, EDITION_URI)).toBe(null);
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

  expect(await getBookIdentifiedFormats(pool, EDITION_URI)).toEqual({
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

  expect(await getBookIdentifiedFormats(pool, EDITION_URI)).toEqual({
    uri: EDITION_URI,
    identifiers: [{ issuer: 'isbn13', value: '9781635575637' }]
  });
});

test('both queries bind the URI and nothing else', async () => {
  const { pool, calls } = fakePool({ present: true, identifiers: [] });
  expect(await getBookIdentifiedFormats(pool, EDITION_URI)).toEqual({
    uri: EDITION_URI,
    identifiers: []
  });

  expect(calls.length).toBe(2);
  for (const call of calls) expect(call.values).toEqual([EDITION_URI]);
  expect(calls[0].sql).toMatch(/FROM books WHERE uri = \$1/);
  // The claims query must not depend on `identifier_shape_rank` existing: the
  // rank is inline, so this read works on a database that predates 0007.
  expect(calls[1].sql).toMatch(/WHEN 'isbn13' THEN 0/);
  expect(calls[1].sql).not.toMatch(/identifier_shape_rank/);
  expect(calls[1].sql).toMatch(/LEFT JOIN edition_identifier_info/);
});
