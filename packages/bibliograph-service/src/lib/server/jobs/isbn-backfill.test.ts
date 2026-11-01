import test from 'node:test';
import assert from 'node:assert/strict';
import { planIsbnEnrichment, type IsbnEnrichmentDeps } from './isbn-backfill';
import type { EditionRow } from '../db/schema';
import type { EditionItem, Identifier } from '../search/types';

const AUTHOR_URI = 'at://did:plc:author/community.lexicon.book.contributor/ol.A1';

const OL_ONLY: Identifier[] = [{ uri: 'https://openlibrary.org/books/OL3292288M', resource: 'openlibrary' }];
const OL_WITH_ISBN: Identifier[] = [
  ...OL_ONLY,
  { uri: 'isbn:1578067057', resource: 'isbn10' },
];

function row(overrides: Partial<EditionRow> = {}): EditionRow {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL3292288M',
    cid: 'bafyreiexample',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'ol.OL3292288M',
    title: 'The Dispossessed',
    subtitle: null,
    workUri: null,
    workCid: null,
    workLinkSource: null,
    publisherUri: null,
    publisherCid: null,
    place: null,
    publishedYear: 1974,
    language: 'eng',
    contributors: [{ subject: { uri: AUTHOR_URI, cid: 'bafyauthor' }, role: 'author' }],
    identifiers: OL_ONLY,
    description: null,
    coverImageUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    indexedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as EditionRow;
}

function editionItem(overrides: Partial<EditionItem> = {}): EditionItem {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL3292288M',
    title: 'The Dispossessed',
    publishedYear: 1974,
    contributors: [{ subject: { uri: AUTHOR_URI, cid: 'bafyauthor' }, role: 'author' }],
    identifiers: OL_WITH_ISBN,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as EditionItem;
}

function deps(overrides: Partial<IsbnEnrichmentDeps> = {}): IsbnEnrichmentDeps {
  const never = async () => null;
  return {
    fetchOlEdition: never,
    fetchGbEdition: never,
    searchOl: async () => [],
    searchGb: async () => [],
    authorNames: async () => new Map([[AUTHOR_URI, 'Ursula K. Le Guin']]),
    ...overrides,
  };
}

test('tier 1 writes the ISBN the authority already knows', async () => {
  const plan = await planIsbnEnrichment(row(), deps({ fetchOlEdition: async () => editionItem() }));

  assert.equal(plan.action, 'write');
  assert.equal(plan.result, 'found');
  assert.deepEqual(plan.added, ['1578067057']);
  assert.deepEqual(plan.identifiers?.at(-1), { uri: 'isbn:1578067057', resource: 'isbn10' });
});

test('an ISBNdb rkey carries its ISBN without any fetch', async () => {
  const plan = await planIsbnEnrichment(
    row({
      rkey: 'isbndb.9781469612881',
      identifiers: [{ uri: 'https://api2.isbndb.com/book/9781469612881', resource: 'isbndb' }],
    }),
    deps(),
  );

  assert.equal(plan.action, 'write');
  assert.deepEqual(plan.added, ['9781469612881']);
});

test('an edition that already has an ISBN is left alone', async () => {
  let fetched = false;
  const plan = await planIsbnEnrichment(
    row({ identifiers: OL_WITH_ISBN }),
    deps({
      fetchOlEdition: async () => {
        fetched = true;
        return editionItem();
      },
    }),
  );

  assert.equal(plan.action, 'already_has_isbn');
  assert.equal(fetched, false, 'no upstream call when there is nothing to do');
});

test('tier 2 records a shadow match without writing identifiers', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      // The authority record exists but carries no ISBN.
      fetchOlEdition: async () => editionItem({ identifiers: OL_ONLY }),
      searchOl: async () => [editionItem()],
    }),
  );

  assert.equal(plan.action, 'shadow');
  assert.equal(plan.result, 'shadow');
  assert.equal(plan.identifiers, undefined, 'shadow mode never proposes an identifier write');
  assert.equal(plan.candidates?.filter((candidate) => candidate.accepted).length, 1);
});

test('two shadow candidates that both survive are ambiguous', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      fetchOlEdition: async () => editionItem({ identifiers: OL_ONLY }),
      searchOl: async () => [
        editionItem({ identifiers: [{ uri: 'isbn:1578067057', resource: 'isbn10' }] }),
        editionItem({ identifiers: [{ uri: 'isbn:9781578067053', resource: 'isbn13' }] }),
      ],
    }),
  );

  assert.equal(plan.action, 'none');
  assert.equal(plan.result, 'ambiguous');
});

test('a shadow candidate is only rejected for an unknown author, never written', async () => {
  const plan = await planIsbnEnrichment(
    row({ contributors: [] }),
    deps({
      fetchOlEdition: async () => editionItem({ identifiers: OL_ONLY, contributors: [] }),
      searchOl: async () => [editionItem()],
      authorNames: async () => new Map(),
    }),
  );

  assert.equal(plan.action, 'none');
  assert.equal(plan.result, 'none');
  const rejected = plan.candidates?.filter((candidate) => !candidate.accepted) ?? [];
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reject, 'author_unknown');
});

test('no candidates at all records none', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({ fetchOlEdition: async () => editionItem({ identifiers: OL_ONLY }) }),
  );

  assert.equal(plan.action, 'none');
  assert.equal(plan.result, 'none');
});

test('a failing search does not fail the plan', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      fetchOlEdition: async () => editionItem({ identifiers: OL_ONLY }),
      searchOl: async () => {
        throw new Error('upstream down');
      },
      searchGb: async () => {
        throw new Error('upstream down');
      },
    }),
  );

  assert.equal(plan.result, 'none');
});
