import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasedEditionUris, resolveEditions } from './edition-lookup';
import { editionAliases, editions, type EditionRow } from './db/schema';
import type { DbExecutor } from './stats';

const PUBLISHER = 'at://did:web:biblio.test/community.lexicon.book.edition';
const OL = `${PUBLISHER}/ol.OL1W`;
const GB = `${PUBLISHER}/gb.0yvmzgEACAAJ`;
const BH = `${PUBLISHER}/bh.bk_abc123`;
const UNKNOWN = `${PUBLISHER}/ol.OL9999999W`;

function makeRow(uri: string, tid: string, overrides: Partial<EditionRow> = {}): EditionRow {
  const base: EditionRow = {
    uri,
    cid: `bafy${tid}`,
    did: 'did:web:biblio.test',
    rkey: uri.slice(uri.lastIndexOf('/') + 1),
    tid,
    title: `Title ${tid}`,
    subtitle: null,
    workUri: null,
    workCid: null,
    workLinkSource: null,
    publisherUri: null,
    publisherCid: null,
    place: null,
    publishedYear: null,
    language: null,
    contributors: [],
    identifiers: [],
    description: null,
    coverImageUrl: null,
    format: null,
    pages: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    descriptionCheckedAt: null,
  };
  return Object.assign(base, overrides);
}

/** drizzle binds params as objects carrying the literal value; columns carry none. */
function sqlStringParams(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) sqlStringParams(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const candidate = node as { value?: unknown; queryChunks?: unknown };
  if (typeof candidate.value === 'string') out.push(candidate.value);
  if (Array.isArray(candidate.queryChunks)) sqlStringParams(candidate.queryChunks, out);
  return out;
}

/**
 * Stands in for the three reads `resolveEditions` makes, filtered by whatever
 * the WHERE clause bound — the point of the module is which rows those clauses
 * reach, so the fake must not answer a fixed set.
 */
function createLookupDb(
  rows: EditionRow[],
  aliases: Array<{ uri: string; tid: string }>,
): DbExecutor {
  return {
    select(projection?: unknown) {
      return {
        from(table: unknown) {
          return {
            where: async (condition: unknown) => {
              const bound = sqlStringParams(condition);
              if (table === editionAliases) return aliases.filter((a) => bound.includes(a.uri));
              if (table !== editions) throw new Error('unexpected table in lookup');
              const matched = rows.filter((row) => bound.includes(row.uri) || bound.includes(row.tid));
              return projection === undefined ? matched : matched.map((row) => ({ uri: row.uri, tid: row.tid }));
            },
          };
        },
      };
    },
  } as unknown as DbExecutor;
}

// OL and BH describe one book: BH was merged into OL, so BH's uri is retired.
const OL_ROW = makeRow(OL, '3mzkolbookaa1');
const BH_ROW = makeRow(BH, '3mzkbhbookaa1', { title: 'A different book' });

test('resolveEditions maps a live uri to its row and keys the canonical uri too', async () => {
  const db = createLookupDb([OL_ROW, BH_ROW], []);
  const resolved = await resolveEditions([OL], db);

  assert.equal(resolved.get(OL)?.tid, '3mzkolbookaa1');
  assert.equal(resolved.get(OL)?.uri, OL);
});

test('resolveEditions answers a retired uri with the book that absorbed it', async () => {
  const db = createLookupDb([OL_ROW], [{ uri: GB, tid: '3mzkolbookaa1' }]);
  const resolved = await resolveEditions([GB], db);

  const row = resolved.get(GB);
  assert.equal(row?.uri, OL);
  assert.equal(row?.tid, '3mzkolbookaa1');
  // A caller that only knew the retired uri still learns what to link at.
  assert.equal(resolved.get(OL)?.uri, OL);
});

test('resolveEditions collapses two uris of one book to one row', async () => {
  const db = createLookupDb([OL_ROW], [{ uri: GB, tid: '3mzkolbookaa1' }]);
  const resolved = await resolveEditions([OL, GB], db);

  // Same object, not two equal copies: deduping callers key on identity as well
  // as on `uri`, and one book must never come back as two rows.
  assert.equal(resolved.get(OL), resolved.get(GB));
  assert.equal(new Set(resolved.values()).size, 1);
});

test('resolveEditions leaves unknown uris out instead of guessing', async () => {
  const db = createLookupDb([OL_ROW], []);
  const resolved = await resolveEditions([UNKNOWN], db);

  assert.equal(resolved.size, 0);
  assert.equal(resolved.get(UNKNOWN), undefined);
});

test('resolveEditions reads nothing for an empty request', async () => {
  const db = {
    select() {
      throw new Error('no query expected');
    },
  } as unknown as DbExecutor;
  assert.equal((await resolveEditions([], db)).size, 0);
});

test('aliasedEditionUris reports only the uris a merge retired', async () => {
  const db = createLookupDb([OL_ROW], [{ uri: GB, tid: '3mzkolbookaa1' }]);
  const aliased = await aliasedEditionUris([OL, GB, UNKNOWN], db);

  assert.deepEqual([...aliased], [GB]);
});
