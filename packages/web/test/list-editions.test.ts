/**
 * `listEditions` is the enumeration surface: the one catalog read a crawler can
 * walk end to end. Its correctness is a keyset walk, so the tests here are the
 * two things a walk can get wrong — a cursor that resumes at the wrong row (the
 * crawl skips or repeats editions) and an off-by-one at the page boundary (the
 * last page grows a cursor that leads nowhere).
 */

import { expect, test } from 'vitest';

import { listEditions } from '../src/lib/server/catalog/editions.ts';
import { decodeKeysetCursor, encodeKeysetCursor } from '../src/lib/server/catalog/sql.ts';

const PREFIX = 'at://did:plc:e2x3ihw2ntxt7pcgzmtu3abi/community.lexicon.media.book.edition/';

function edition(uri: string, title: string) {
  return { uri, title, indexed_at: new Date('2026-11-16T12:00:00.000Z') };
}

/** A pool that answers every `editions` page from `rows` and records the SQL. */
function fakePool(rows: Array<ReturnType<typeof edition>>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    pool: {
      async query(sql: string, values: unknown[]) {
        calls.push({ sql, values });
        return { rows };
      }
    } as never
  };
}

test('a first page has no WHERE clause and probes one row past the limit', async () => {
  const { pool, calls } = fakePool([
    edition(`${PREFIX}a`, 'A'),
    edition(`${PREFIX}b`, 'B')
  ]);

  const page = await listEditions({ after: null, limit: 1 }, pool);

  expect(page.items.map((item) => item.title)).toEqual(['A']);
  // The probe row proves there is another page without a count over 282k rows.
  expect(calls[0]?.values.at(-1)).toBe(2);
  expect(calls[0]?.sql ?? '').not.toMatch(/WHERE/);
  // The date is serialised the way every other edition read serialises it.
  expect(page.items[0]?.indexedAt).toBe('2026-11-16T12:00:00.000Z');
});

test('the cursor resumes strictly after the last uri of the page', async () => {
  const rows = [edition(`${PREFIX}a`, 'A'), edition(`${PREFIX}b`, 'B')];
  const { pool } = fakePool(rows);

  const first = await listEditions({ after: null, limit: 1 }, pool);
  expect(first.cursor, 'a full page with a probe row carries a cursor').toBeTruthy();
  expect(decodeKeysetCursor(first.cursor)).toBe(`${PREFIX}a`);

  const next = fakePool([edition(`${PREFIX}b`, 'B')]);
  await listEditions({ after: decodeKeysetCursor(first.cursor), limit: 1 }, next.pool);
  expect(next.calls[0]?.sql ?? '').toMatch(/WHERE uri > \$1/);
  expect(next.calls[0]?.values).toEqual([`${PREFIX}a`, 2]);
});

test('the last page carries no cursor, and a malformed one restarts at the beginning', async () => {
  const { pool } = fakePool([edition(`${PREFIX}a`, 'A')]);
  const page = await listEditions({ after: null, limit: 5 }, pool);
  expect(page.cursor).toBe(undefined);
  expect(page.items.length).toBe(1);

  // A cursor the edge did not mint is not an error: the walk restarts, which is
  // the same contract the offset cursors keep.
  for (const malformed of ['', 'not-base64-json', encodeKeysetCursor('')]) {
    expect(decodeKeysetCursor(malformed), `${malformed} starts over`).toBe(null);
  }
});
