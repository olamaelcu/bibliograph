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
  const written = { claims: [], publishers: [], identifiers: [] };
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const text = sql.trim();
      statements.push(text);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      if (text.includes('FROM edition_identifiers i')) return { rows: [] };
      if (text.includes('editions_next_tid()')) return { rows: [{ rkey: '3probe' }] };
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
        return { rows: [{ id: written.identifiers.length, at_uri: 'at://contributor/1' }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO edition_contributors')) return { rows: [], rowCount: 1 };
      if (text.startsWith('INSERT INTO publishers')) {
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
