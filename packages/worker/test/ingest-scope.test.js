import { expect, test } from 'vitest';

import { createIngest } from '../lib/ingest.js';

/**
 * Where a candidate's claims and publisher credit land.
 *
 * `sourceIdentifier` is what a third-party catalog uses: its description, page
 * count or publisher describe the identifier it came through, not every pair in
 * the merged bag. The statements ingest issues are the contract, so the fake
 * client records which `(issuer, value)` rows were written and which pairs the
 * publisher link covers.
 */

const AUTHORITY = 'did:plc:scopeprobe';
const EDITION = `at://${AUTHORITY}/community.lexicon.media.book.edition/3probe`;

function fakeClient() {
  const written = {
    claims: [],
    publishers: [],
    identifiers: [],
    contributorBags: [],
    publisherBags: []
  };
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const text = sql.trim();
      statements.push(text);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      if (text.includes('FROM edition_identifiers i')) return { rows: [] };
      // Only the TID query. The entity inserts call `editions_next_tid()` too,
      // to mint their `at_uri`, so a loose match would answer for them.
      if (text.startsWith('SELECT editions_next_tid()')) return { rows: [{ rkey: '3probe' }] };
      if (text.startsWith('INSERT INTO books')) return { rows: [{ uri: EDITION }], rowCount: 1 };
      if (text.startsWith('UPDATE books')) return { rows: [], rowCount: 0 };
      if (text.startsWith('INSERT INTO edition_identifiers')) {
        // The statement carries the whole bag: parallel issuer/value arrays.
        params[1].forEach((issuer, index) => {
          written.identifiers.push({ issuer, value: params[2][index] });
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO edition_identifier_info')) {
        params[1].forEach((issuer, index) => {
          written.claims.push({ issuer, value: params[2][index] });
        });
        return { rows: [], rowCount: 1 };
      }
      // The batched identity upsert is a `WITH … INSERT`, so it is found by its
      // insert rather than by its first token. The returned rows are what the
      // credit statement is mapped back through, so they carry the name and the
      // jsonb bag exactly as Postgres would parse them.
      if (text.includes('INSERT INTO contributors')) {
        const names = params[2];
        const bags = params[5];
        bags.forEach((bag) => written.contributorBags.push(bag));
        return {
          rows: names.map((name, index) => ({
            id: index + 1,
            name,
            identifiers: JSON.parse(bags[index])
          })),
          rowCount: names.length
        };
      }
      if (text.startsWith('INSERT INTO edition_contributors')) return { rows: [], rowCount: 1 };
      if (text.startsWith('INSERT INTO publishers')) {
        written.publisherBags.push(params[1]);
        return { rows: [{ id: 7, at_uri: 'at://publisher/7' }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO edition_identifier_publishers')) {
        written.publishers.push({ issuers: params[2], values: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('DELETE FROM edition_cover_fetches')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${text.slice(0, 80)}`);
    },
    release() {}
  };
  return { pool: { async connect() { return client; } }, written, statements };
}

const BOOKHIVE_PAIR = { issuer: 'bookhive.buzz', value: 'bk_scopeprobe' };
const ISBN_PAIR = { issuer: 'isbn13', value: '9780441013593' };

function candidate(overrides = {}) {
  return {
    title: 'Scope Probe',
    identifiers: [BOOKHIVE_PAIR, ISBN_PAIR],
    contributors: [{ name: 'A. Author' }],
    description: 'A description from the Bookhive catalog',
    pages: 320,
    language: 'en',
    publishedDate: '2005',
    publisher: { name: 'Ace Books' },
    series: { name: 'Scope Cycle' },
    ...overrides
  };
}

test('without a source identifier the claims and publisher cover the whole bag', async () => {
  const { pool, written } = fakeClient();
  await createIngest({ pool, publisherDid: AUTHORITY })(candidate());

  expect(written.claims.map((row) => `${row.issuer}:${row.value}`)).toEqual(['bookhive.buzz:bk_scopeprobe', 'isbn13:9780441013593']);
  expect(written.publishers.length).toBe(1);
  expect(written.publishers[0].issuers).toEqual(['bookhive.buzz', 'isbn13']);
});

test('a source identifier keeps claims and the publisher on that identifier alone', async () => {
  const { pool, written } = fakeClient();
  await createIngest({ pool, publisherDid: AUTHORITY })(
    candidate({ sourceIdentifier: BOOKHIVE_PAIR })
  );

  // The edition still owns both identifiers; only the attribution is scoped.
  expect(written.identifiers.map((row) => `${row.issuer}:${row.value}`)).toEqual(['bookhive.buzz:bk_scopeprobe', 'isbn13:9780441013593']);
  expect(written.claims.map((row) => `${row.issuer}:${row.value}`)).toEqual(['bookhive.buzz:bk_scopeprobe']);
  expect(written.publishers.length).toBe(1);
  expect(written.publishers[0].issuers).toEqual(['bookhive.buzz']);
  expect(written.publishers[0].values).toEqual(['bk_scopeprobe']);
});

test('a source identifier outside the candidate bag is a rejected candidate', async () => {
  const { pool, written, statements } = fakeClient();
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });

  await expect(ingest(candidate({ sourceIdentifier: { issuer: 'bookhive.buzz', value: 'bk_other' } }))).rejects.toThrow(/is not one of the candidate's identifiers/);
  expect(written.identifiers, 'nothing is written before the scope check').toEqual([]);
  // The check runs before a connection is taken, so a malformed candidate never
  // opens a transaction at all.
  expect(statements).toEqual([]);
});

test('the entity identity bag is stored canonically, whatever order it arrives in', async () => {
  const bag = [BOOKHIVE_PAIR, ISBN_PAIR];
  const ingestBag = async (identifiers) => {
    const run = fakeClient();
    await createIngest({ pool: run.pool, publisherDid: AUTHORITY })(
      candidate({
        contributors: [{ name: 'A. Author', identifiers }],
        publisher: { name: 'Ace Books', identifiers }
      })
    );
    return run.written;
  };

  const forward = await ingestBag(bag);
  const reversed = await ingestBag([...bag].reverse());

  // `(lower(name), identifiers)` is a jsonb comparison, so it is positional:
  // one identity set has to reach the row as one string, in every order.
  expect(forward.contributorBags.length).toBe(1);
  expect(forward.contributorBags[0]).toBe(reversed.contributorBags[0]);
  expect(forward.publisherBags[0]).toBe(reversed.publisherBags[0]);
  expect(JSON.parse(forward.contributorBags[0])).toEqual([BOOKHIVE_PAIR, ISBN_PAIR]);
  expect(JSON.parse(forward.publisherBags[0])).toEqual([BOOKHIVE_PAIR, ISBN_PAIR]);
});
