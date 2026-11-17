import test from 'node:test';
import assert from 'node:assert/strict';

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
      if (text.startsWith('INSERT INTO editions')) return { rows: [{ uri: EDITION }], rowCount: 1 };
      if (text.startsWith('UPDATE editions')) return { rows: [], rowCount: 0 };
      if (text.startsWith('INSERT INTO edition_identifiers')) {
        written.identifiers.push({ issuer: params[1], value: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO edition_identifier_info')) {
        written.claims.push({ issuer: params[1], value: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO contributors')) {
        written.contributorBags.push(params[3]);
        return { rows: [{ id: written.identifiers.length, at_uri: 'at://contributor/1' }], rowCount: 1 };
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

  assert.deepEqual(
    written.claims.map((row) => `${row.issuer}:${row.value}`),
    ['bookhive.buzz:bk_scopeprobe', 'isbn13:9780441013593']
  );
  assert.equal(written.publishers.length, 1);
  assert.deepEqual(written.publishers[0].issuers, ['bookhive.buzz', 'isbn13']);
});

test('a source identifier keeps claims and the publisher on that identifier alone', async () => {
  const { pool, written } = fakeClient();
  await createIngest({ pool, publisherDid: AUTHORITY })(
    candidate({ sourceIdentifier: BOOKHIVE_PAIR })
  );

  // The edition still owns both identifiers; only the attribution is scoped.
  assert.deepEqual(
    written.identifiers.map((row) => `${row.issuer}:${row.value}`),
    ['bookhive.buzz:bk_scopeprobe', 'isbn13:9780441013593']
  );
  assert.deepEqual(
    written.claims.map((row) => `${row.issuer}:${row.value}`),
    ['bookhive.buzz:bk_scopeprobe']
  );
  assert.equal(written.publishers.length, 1);
  assert.deepEqual(written.publishers[0].issuers, ['bookhive.buzz']);
  assert.deepEqual(written.publishers[0].values, ['bk_scopeprobe']);
});

test('a source identifier outside the candidate bag is a rejected candidate', async () => {
  const { pool, written, statements } = fakeClient();
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });

  await assert.rejects(
    ingest(candidate({ sourceIdentifier: { issuer: 'bookhive.buzz', value: 'bk_other' } })),
    /is not one of the candidate's identifiers/
  );
  assert.deepEqual(written.identifiers, [], 'nothing is written before the scope check');
  // The check runs before a connection is taken, so a malformed candidate never
  // opens a transaction at all.
  assert.deepEqual(statements, []);
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
  assert.equal(forward.contributorBags.length, 1);
  assert.equal(forward.contributorBags[0], reversed.contributorBags[0]);
  assert.equal(forward.publisherBags[0], reversed.publisherBags[0]);
  assert.deepEqual(JSON.parse(forward.contributorBags[0]), [BOOKHIVE_PAIR, ISBN_PAIR]);
  assert.deepEqual(JSON.parse(forward.publisherBags[0]), [BOOKHIVE_PAIR, ISBN_PAIR]);
});
