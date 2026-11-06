import test from 'node:test';
import assert from 'node:assert/strict';
import { planIsbnEnrichment, type IsbnEnrichmentDeps } from './isbn-backfill';
import type { EditionRow } from '../db/schema';
import type { EditionItem, Identifier } from '../search/types';
import { providerIdentifier } from '../identifiers';

const AUTHOR_URI = 'at://did:plc:author/community.lexicon.book.contributor/gb.GhPSEAAAQBAJ';

const GB_ONLY: Identifier[] = [
  providerIdentifier('googlebooks', 'https://books.google.com/books?id=GhPSEAAAQBAJ'),
];
const GB_WITH_ISBN: Identifier[] = [
  ...GB_ONLY,
  { type: 'isbn', value: '9781578067053' },
];

function row(overrides: Partial<EditionRow> = {}): EditionRow {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/gb.GhPSEAAAQBAJ',
    cid: 'bafyreiexample',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'gb.GhPSEAAAQBAJ',
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
    identifiers: GB_ONLY,
    description: null,
    coverImageUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    indexedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as EditionRow;
}

function editionItem(overrides: Partial<EditionItem> = {}): EditionItem {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/gb.GhPSEAAAQBAJ',
    title: 'The Dispossessed',
    publishedYear: 1974,
    contributors: [{ subject: { uri: AUTHOR_URI, cid: 'bafyauthor' }, role: 'author' }],
    identifiers: GB_WITH_ISBN,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as EditionItem;
}

function deps(overrides: Partial<IsbnEnrichmentDeps> = {}): IsbnEnrichmentDeps {
  const never = async () => null;
  return {
    fetchGbEdition: never,
    searchGb: async () => [],
    searchOl: async () => [],
    searchGr: async () => [],
    authorNames: async () => new Map([[AUTHOR_URI, 'Ursula K. Le Guin']]),
    ...overrides,
  };
}

test('tier 1 writes the ISBN the authority already knows', async () => {
  const plan = await planIsbnEnrichment(row(), deps({ fetchGbEdition: async () => editionItem() }));

  assert.equal(plan.action, 'write');
  assert.equal(plan.result, 'found');
  assert.deepEqual(plan.added, ['9781578067053']);
  assert.deepEqual(plan.identifiers?.at(-1), { type: 'isbn', value: '9781578067053' });
});

test('an ISBNdb rkey carries its ISBN without any fetch', async () => {
  const plan = await planIsbnEnrichment(
    row({
      rkey: 'isbndb.9781469612881',
      identifiers: [providerIdentifier('isbndb', 'https://api2.isbndb.com/book/9781469612881')],
    }),
    deps(),
  );

  assert.equal(plan.action, 'write');
  assert.deepEqual(plan.added, ['9781469612881']);
});

test('an edition that already has an ISBN is left alone', async () => {
  let fetched = false;
  const plan = await planIsbnEnrichment(
    row({ identifiers: GB_WITH_ISBN }),
    deps({
      fetchGbEdition: async () => {
        fetched = true;
        return editionItem();
      },
    }),
  );

  assert.equal(plan.action, 'already_has_isbn');
  assert.equal(fetched, false, 'no upstream call when there is nothing to do');
});

test('tier 2 writes the ISBN the authority did not already know', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      // The authority record exists but carries no ISBN.
      fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY }),
      searchGb: async () => [editionItem()],
    }),
  );

  assert.equal(plan.action, 'write');
  assert.equal(plan.result, 'found');
  assert.deepEqual(plan.added, ['9781578067053']);
  assert.deepEqual(plan.identifiers?.at(-1), { type: 'isbn', value: '9781578067053' });
  assert.equal(plan.candidates?.filter((candidate) => candidate.accepted).length, 1);
});

test('tier 2 takes an ISBN from an OpenLibrary title search', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY }),
      searchOl: async () => [editionItem()],
    }),
  );

  assert.equal(plan.action, 'write');
  assert.deepEqual(plan.added, ['9781578067053']);
});

test('tier 2 takes an ISBN from a Goodreads title search', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY }),
      searchGr: async () => [editionItem()],
    }),
  );

  assert.equal(plan.action, 'write');
  assert.deepEqual(plan.added, ['9781578067053']);
});

test('two shadow candidates that both survive are ambiguous', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY }),
      searchGb: async () => [
        editionItem({ identifiers: [{ type: 'isbn', value: '9781578067053' }] }),
        editionItem({ identifiers: [{ type: 'isbn', value: '9780060512750' }] }),
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
      fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY, contributors: [] }),
      searchGb: async () => [editionItem()],
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
    deps({ fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY }) }),
  );

  assert.equal(plan.action, 'none');
  assert.equal(plan.result, 'none');
});

test('a failing search does not fail the plan', async () => {
  const plan = await planIsbnEnrichment(
    row(),
    deps({
      fetchGbEdition: async () => editionItem({ identifiers: GB_ONLY }),
      searchGb: async () => {
        throw new Error('upstream down');
      },
    }),
  );

  assert.equal(plan.result, 'none');
});
