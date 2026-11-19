/**
 * The three `giveaway.*` reads, against real rows in `happyview_records`.
 *
 * The page, the detail card and the author's report all read the activity index
 * and nothing else, so these tests build records the way the app writes them and
 * assert what each query answers. Two properties matter beyond "it returns the
 * row": the `status` filter is a time comparison both ways (an open giveaway is
 * excluded once it closes, and a closed one is excluded from `status=open`), and
 * the report's counts are of distinct entrants, joined to whatever those entrants
 * did with the edition afterwards.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';

import pg from 'pg';

import {
  GIVEAWAY_ENTRIES,
  GIVEAWAY_EVENT_COLLECTION,
  GIVEAWAY_ENTRY_COLLECTION,
  GIVEAWAY_LIST,
  GIVEAWAY_REPORT,
  getGiveaway,
  getGiveawayReport,
  listEntries,
  listGiveaways
} from '../src/lib/server/catalog/giveaway.ts';
import {
  EDGE_PROCEDURES,
  ENTITY_QUERIES,
  GIVEAWAY_DRAW
} from '../src/lib/server/catalog/entity-methods.ts';

const RUN = `${process.pid}-${Date.now()}`;
const AUTHOR = 'did:plc:giveawayauthor';
const EDITION = `at://did:plc:catalogue/community.lexicon.media.book.edition/gw${RUN}`;
const OPEN_URI = `at://${AUTHOR}/${GIVEAWAY_EVENT_COLLECTION}/open${RUN}`;
const CLOSED_URI = `at://${AUTHOR}/${GIVEAWAY_EVENT_COLLECTION}/closed${RUN}`;
const EMPTY_URI = `at://${AUTHOR}/${GIVEAWAY_EVENT_COLLECTION}/empty${RUN}`;
const EVENT_CID = 'bafyreigiveawayeventcid';

const ENTRANT_READ = 'did:plc:giveawayentrant-read';
const ENTRANT_SHELVED = 'did:plc:giveawayentrant-shelved';
const ENTRANT_PLAIN = 'did:plc:giveawayentrant-plain';

let pool: pg.Pool | undefined;

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!pool) {
    t.skip('DATABASE_URL is not reachable; skipping giveaway integration tests');
    return null;
  }
  return pool;
}

function eventRecord(options: {
  uri: string;
  opensAt: string;
  closesAt: string;
  createdAt: string;
}): string {
  return JSON.stringify({
    $type: GIVEAWAY_EVENT_COLLECTION,
    edition: EDITION,
    title: `Giveaway probe ${RUN}`,
    coverUrl: 'https://example.test/cover.jpg',
    prizeType: 'print',
    prizeQuantity: 2,
    countries: ['FR', 'BE'],
    rulesText: 'One entry per reader.',
    opensAt: options.opensAt,
    closesAt: options.closesAt,
    createdAt: options.createdAt
  });
}

function entryRecord(giveaway: string, createdAt: string, country?: string): string {
  return JSON.stringify({
    $type: GIVEAWAY_ENTRY_COLLECTION,
    giveaway: { uri: giveaway, cid: EVENT_CID },
    ...(country === undefined ? {} : { country }),
    createdAt
  });
}

async function insertRow(
  db: pg.Pool,
  row: { uri: string; did: string; collection: string; record: string; createdAt: string }
): Promise<void> {
  await db.query(
    `INSERT INTO happyview.happyview_records
       (uri, did, collection, rkey, record, cid, indexed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      row.uri,
      row.did,
      row.collection,
      row.uri.slice(row.uri.lastIndexOf('/') + 1),
      row.record,
      `cid${row.uri.slice(-8)}`,
      row.createdAt
    ]
  );
}

const HOUR = 60 * 60 * 1000;
const now = Date.now();

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') return;
  const candidate = new pg.Pool({ connectionString });
  try {
    await candidate.query('SELECT 1');
  } catch {
    await candidate.end();
    return;
  }
  pool = candidate;

  // One open giveaway with three entries, one that closed an hour ago, and one
  // nobody entered.
  await insertRow(candidate, {
    uri: OPEN_URI,
    did: AUTHOR,
    collection: GIVEAWAY_EVENT_COLLECTION,
    record: eventRecord({
      uri: OPEN_URI,
      opensAt: new Date(now - HOUR).toISOString(),
      closesAt: new Date(now + HOUR).toISOString(),
      createdAt: new Date(now - HOUR).toISOString()
    }),
    createdAt: new Date(now - HOUR).toISOString()
  });
  await insertRow(candidate, {
    uri: CLOSED_URI,
    did: AUTHOR,
    collection: GIVEAWAY_EVENT_COLLECTION,
    record: eventRecord({
      uri: CLOSED_URI,
      opensAt: new Date(now - 4 * HOUR).toISOString(),
      closesAt: new Date(now - HOUR).toISOString(),
      createdAt: new Date(now - 4 * HOUR).toISOString()
    }),
    createdAt: new Date(now - 4 * HOUR).toISOString()
  });
  await insertRow(candidate, {
    uri: EMPTY_URI,
    did: AUTHOR,
    collection: GIVEAWAY_EVENT_COLLECTION,
    record: eventRecord({
      uri: EMPTY_URI,
      opensAt: new Date(now - 2 * HOUR).toISOString(),
      closesAt: new Date(now + 2 * HOUR).toISOString(),
      createdAt: new Date(now - 2 * HOUR).toISOString()
    }),
    createdAt: new Date(now - 2 * HOUR).toISOString()
  });

  // Two entrants in one country, one with none, entered in this order.
  await insertRow(candidate, {
    uri: `at://${ENTRANT_READ}/${GIVEAWAY_ENTRY_COLLECTION}/a${RUN}`,
    did: ENTRANT_READ,
    collection: GIVEAWAY_ENTRY_COLLECTION,
    record: entryRecord(OPEN_URI, new Date(now - 3 * HOUR).toISOString(), 'FR'),
    createdAt: new Date(now - 3 * HOUR).toISOString()
  });
  await insertRow(candidate, {
    uri: `at://${ENTRANT_SHELVED}/${GIVEAWAY_ENTRY_COLLECTION}/b${RUN}`,
    did: ENTRANT_SHELVED,
    collection: GIVEAWAY_ENTRY_COLLECTION,
    record: entryRecord(OPEN_URI, new Date(now - 2 * HOUR).toISOString(), 'FR'),
    createdAt: new Date(now - 2 * HOUR).toISOString()
  });
  await insertRow(candidate, {
    uri: `at://${ENTRANT_PLAIN}/${GIVEAWAY_ENTRY_COLLECTION}/c${RUN}`,
    did: ENTRANT_PLAIN,
    collection: GIVEAWAY_ENTRY_COLLECTION,
    record: entryRecord(OPEN_URI, new Date(now - HOUR).toISOString()),
    createdAt: new Date(now - HOUR).toISOString()
  });

  // What two of those three did with the edition afterwards: one read and
  // reviewed it, the other only shelved it.
  await insertRow(candidate, {
    uri: `at://${ENTRANT_READ}/net.olamaelcu.livtet.biblio.bookStatus/read${RUN}`,
    did: ENTRANT_READ,
    collection: 'net.olamaelcu.livtet.biblio.bookStatus',
    record: JSON.stringify({
      book: { uri: EDITION, cid: 'bafybookcid' },
      shelf: `at://${ENTRANT_READ}/net.olamaelcu.livtet.biblio.shelf/read`,
      metadata: { status: 'read' },
      createdAt: new Date(now - 30 * 60 * 1000).toISOString()
    }),
    createdAt: new Date(now - 30 * 60 * 1000).toISOString()
  });
  await insertRow(candidate, {
    uri: `at://${ENTRANT_READ}/community.lexicon.media.book.review/r${RUN}`,
    did: ENTRANT_READ,
    collection: 'community.lexicon.media.book.review',
    record: JSON.stringify({
      subjectRecord: EDITION,
      textContent: 'Read it for the giveaway, stayed for the prose.',
      createdAt: new Date(now - 20 * 60 * 1000).toISOString()
    }),
    createdAt: new Date(now - 20 * 60 * 1000).toISOString()
  });
  await insertRow(candidate, {
    uri: `at://${ENTRANT_SHELVED}/net.olamaelcu.livtet.biblio.shelfItem/si${RUN}`,
    did: ENTRANT_SHELVED,
    collection: 'net.olamaelcu.livtet.biblio.shelfItem',
    record: JSON.stringify({
      book: { uri: EDITION, cid: 'bafybookcid' },
      shelf: `at://${ENTRANT_SHELVED}/net.olamaelcu.livtet.biblio.shelf/winter`,
      metadata: { position: 1 },
      createdAt: new Date(now - 40 * 60 * 1000).toISOString()
    }),
    createdAt: new Date(now - 40 * 60 * 1000).toISOString()
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM happyview.happyview_records WHERE uri LIKE '%${RUN}%'`);
  await pool.query('DELETE FROM giveaway_draws WHERE giveaway LIKE $1', [`%${RUN}%`]);
  await pool.end();
  pool = undefined;
});

test('all four methods are registered on their dispatch surface', () => {
  for (const nsid of [GIVEAWAY_LIST, GIVEAWAY_ENTRIES, GIVEAWAY_REPORT]) {
    expect(ENTITY_QUERIES.has(nsid)).toBe(true);
  }
  expect(GIVEAWAY_DRAW).toBe('net.olamaelcu.livtet.biblio.giveaway.draw');
  expect(EDGE_PROCEDURES.has(GIVEAWAY_DRAW)).toBe(true);
  expect(ENTITY_QUERIES.has(GIVEAWAY_DRAW)).toBe(false);
});

test('one giveaway answers with its record fields and its entry count', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const page = await listGiveaways(db, { uri: OPEN_URI });
  expect(page.giveaways).toHaveLength(1);
  const giveaway = page.giveaways[0]!;
  expect(giveaway.uri).toBe(OPEN_URI);
  expect(giveaway.author).toBe(AUTHOR);
  expect(giveaway.edition).toBe(EDITION);
  expect(giveaway.prizeType).toBe('print');
  expect(giveaway.prizeQuantity).toBe(2);
  expect(giveaway.countries).toEqual(['FR', 'BE']);
  expect(giveaway.coverUrl).toBe('https://example.test/cover.jpg');
  expect(giveaway.entries).toBe(3);
  expect(giveaway.draw).toBeUndefined();
  expect(page.cursor).toBeUndefined();
});

test('an unknown uri answers an empty list, not an error', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const page = await listGiveaways(db, {
    uri: `at://${AUTHOR}/${GIVEAWAY_EVENT_COLLECTION}/nothing${RUN}`
  });
  expect(page.giveaways).toEqual([]);
  expect(await getGiveaway(db, `at://${AUTHOR}/${GIVEAWAY_EVENT_COLLECTION}/gone${RUN}`)).toBeNull();
});

test('status=open excludes a giveaway whose close time has passed', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const open = await listGiveaways(db, { author: AUTHOR, status: 'open', limit: 50 });
  const openUris = open.giveaways.map((giveaway) => giveaway.uri);
  expect(openUris).toContain(OPEN_URI);
  expect(openUris).toContain(EMPTY_URI);
  expect(openUris).not.toContain(CLOSED_URI);

  const closed = await listGiveaways(db, { author: AUTHOR, status: 'closed', limit: 50 });
  expect(closed.giveaways.map((giveaway) => giveaway.uri)).toEqual([CLOSED_URI]);
});

test('the edition filter finds a giveaway from its book page', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const page = await listGiveaways(db, { edition: EDITION, status: 'open', limit: 1 });
  expect(page.giveaways).toHaveLength(1);
  expect(page.giveaways[0]!.entries).toBe(3);
});

test('entries page oldest first and stop when the probe row is absent', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const first = await listEntries(db, { giveaway: OPEN_URI, limit: 2 });
  expect(first.entries.map((entry) => entry.did)).toEqual([ENTRANT_READ, ENTRANT_SHELVED]);
  expect(first.entries[0]!.country).toBe('FR');
  expect(first.entries[1]!.country).toBe('FR');
  expect(first.cursor).toBeTypeOf('string');

  const second = await listEntries(db, { giveaway: OPEN_URI, limit: 2, cursor: first.cursor });
  expect(second.entries.map((entry) => entry.did)).toEqual([ENTRANT_PLAIN]);
  expect(second.entries[0]!.country).toBeUndefined();
  expect(second.cursor).toBeUndefined();
});

test('the report counts entrants who shelved, read and reviewed afterwards', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const report = await getGiveawayReport(db, OPEN_URI, EDITION);
  expect(report).toMatchObject({
    giveaway: OPEN_URI,
    entries: 3,
    shelved: 2,
    read: 1,
    reviewed: 1
  });
  expect(report.byCountry).toEqual([
    { country: 'FR', count: 2 },
    { country: null, count: 1 }
  ]);
});

test('a giveaway nobody entered reports zero everywhere', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const report = await getGiveawayReport(db, EMPTY_URI, EDITION);
  expect(report.entries).toBe(0);
  expect(report.shelved).toBe(0);
  expect(report.read).toBe(0);
  expect(report.reviewed).toBe(0);
  expect(report.byCountry).toEqual([]);
});

test('a stored draw reaches the view, so a closed giveaway names its winners', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const drawnAt = new Date(now - 30 * 60 * 1000);
  await db.query(
    `INSERT INTO giveaway_draws (giveaway, author_did, seed, entrant_dids, winners, drawn_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (giveaway) DO NOTHING`,
    [
      CLOSED_URI,
      AUTHOR,
      'deadbeef',
      JSON.stringify([ENTRANT_READ, ENTRANT_PLAIN]),
      JSON.stringify([ENTRANT_PLAIN]),
      drawnAt
    ]
  );

  const giveaway = await getGiveaway(db, CLOSED_URI);
  expect(giveaway?.draw).toEqual({
    drawnAt: drawnAt.toISOString(),
    seed: 'deadbeef',
    winners: [ENTRANT_PLAIN]
  });
});
