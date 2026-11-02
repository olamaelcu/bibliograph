import test from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BOOKHIVE_STATUS_BY_SHELF_RKEY,
  bookhiveStatusForShelfRkey,
  shelfEntryConditions,
  shelfRkeyForBookhiveStatus,
  shelfRkeyOf,
} from './shelf-rows.js';

const SHELF = (rkey: string) =>
  `at://did:plc:reader/net.olamaelcu.livtet.biblio.shelf/${rkey}`;

const dialect = new PgDialect();

/** The SQL and bound parameters drizzle would run for a condition. */
function compiled(condition: SQL) {
  const { sql, params } = dialect.sqlToQuery(condition);
  return { sql: sql.replace(/\s+/g, ' '), params };
}

test('shelfRkeyOf: last path segment of a shelf uri, empty otherwise', () => {
  assert.equal(shelfRkeyOf(SHELF('to-read')), 'to-read');
  // Not a shelf uri, so there is no rkey to read rather than a guess.
  assert.equal(shelfRkeyOf('to-read'), '');
  assert.equal(shelfRkeyOf(''), '');
});

test('bookhiveStatusForShelfRkey: every Livtet shelf has a Bookhive peer', () => {
  for (const rkey of ['reading', 'read', 'to-read', 'dnf']) {
    assert.equal(typeof bookhiveStatusForShelfRkey(rkey), 'string');
  }
  assert.equal(bookhiveStatusForShelfRkey('owned'), null);
});

test('shelfRkeyForBookhiveStatus: inverts the status map, unknown status is null', () => {
  for (const [rkey, status] of Object.entries(BOOKHIVE_STATUS_BY_SHELF_RKEY)) {
    assert.equal(shelfRkeyForBookhiveStatus(status), rkey);
  }
  assert.equal(shelfRkeyForBookhiveStatus('buzz.bookhive.defs#owned'), null);
  assert.equal(shelfRkeyForBookhiveStatus(undefined), null);
});

test('shelfEntryConditions: one shelf selects both apps and books them to it', () => {
  const { sql, params } = compiled(
    shelfEntryConditions({ shelfUris: [SHELF('to-read')], did: 'did:plc:reader' }),
  );

  // Both collections are eligible, so a Bookhive reader is not invisible here.
  assert.match(sql, /"records"\."collection" in \(\$\d+, \$\d+\)/);
  assert.deepEqual(params.slice(0, 2), [
    'net.olamaelcu.livtet.biblio.bookShelving',
    'buzz.bookhive.book',
  ]);
  // The Livtet half matches on the shelf uri, the Bookhive half on the status
  // token that uri names, and only rows carrying a status count.
  assert.match(sql, /"records"\."value"->>'shelf' in \(\$\d+\)/);
  assert.match(sql, /"records"\."value"->>'status' in \(\$\d+\)/);
  assert.match(sql, /"records"\."value"->>'status' IS NOT NULL/);
  assert.ok(params.includes(SHELF('to-read')));
  assert.ok(params.includes('buzz.bookhive.defs#wantToRead'));
  assert.ok(params.includes('did:plc:reader'));
});

test('shelfEntryConditions: a shelf with no Bookhive peer keeps only the Livtet half', () => {
  const { sql, params } = compiled(
    shelfEntryConditions({ shelfUris: [SHELF('owned')] }),
  );
  assert.match(sql, /"records"\."value"->>'shelf' in \(\$\d+\)/);
  // No status token to match, so the Bookhive branch narrows to nothing.
  assert.match(sql, /false/);
  assert.ok(!params.includes('buzz.bookhive.defs#wantToRead'));
});

test('shelfEntryConditions: no shelf filter means every shelf of both apps', () => {
  const { sql, params } = compiled(shelfEntryConditions());
  assert.match(sql, /"records"\."collection" in \(\$\d+, \$\d+\)/);
  assert.doesNotMatch(sql, /->>'shelf'/);
  assert.match(sql, /"records"\."value"->>'status' IS NOT NULL/);
  // One collection filter, then one branch per app: both collections named, and
  // nothing else bound, so no shelf or book narrows the page.
  assert.deepEqual(new Set(params), new Set([
    'net.olamaelcu.livtet.biblio.bookShelving',
    'buzz.bookhive.book',
  ]));
});

test('shelfEntryConditions: bookhive-only scoping leaves the Livtet rows out', () => {
  const { sql, params } = compiled(
    shelfEntryConditions({
      apps: ['bookhive'],
      bookhiveSubject: 'at://did:plc:x/buzz.bookhive.catalogBook/bk_1',
    }),
  );
  assert.match(sql, /"records"\."collection" in \(\$\d+\)/);
  assert.match(sql, /coalesce/);
  assert.ok(params.includes('buzz.bookhive.book'));
  assert.ok(!params.includes('net.olamaelcu.livtet.biblio.bookShelving'));
});

test('shelfEntryConditions: a book scopes the Livtet half by its edition ref', () => {
  const { sql, params } = compiled(
    shelfEntryConditions({
      apps: ['shelving'],
      bookUri: 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1W',
    }),
  );
  assert.match(sql, /"records"\."value"->'book'->>'uri' = \$\d+/);
  assert.ok(
    params.includes('at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1W'),
  );
});
