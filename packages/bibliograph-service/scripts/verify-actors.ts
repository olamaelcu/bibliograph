#!/usr/bin/env tsx
// End-to-end verification of `net.olamaelcu.livtet.biblio.searchActors`.
//
// Usage:
//   pnpm exec tsx --test scripts/verify-actors.ts
//
// Requires DATABASE_URL pointing at a database with migration 0034 applied and
// some `records` rows (a local snapshot is enough: the last test asserts the
// ~1.1k-DID Bookhive directory is visible). The seed rows are inserted under a
// per-run DID prefix and deleted afterwards, so the run is safe to repeat.
//
// Every call goes through the real XRPCRouter, so lexicon validation, the
// handler and the SQL are all exercised exactly as a client would hit them.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, like, sql } from 'drizzle-orm';
import { router } from '../src/lib/server/xrpc-router.js';
import { db } from '../src/lib/server/db/index.js';
import { actors, records } from '../src/lib/server/db/schema.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DID_PREFIX = 'did:plc:verifyactors';
const BOOKHIVE = 'buzz.bookhive.book';
const SHELVING = 'net.olamaelcu.livtet.biblio.bookShelving';

const ALPHA = `${DID_PREFIX}${RUN}a`;
const BETA = `${DID_PREFIX}${RUN}b`;
const CHARLIE = `${DID_PREFIX}${RUN}c`;
const DELTA = `${DID_PREFIX}${RUN}d`;

interface ActorBody {
  did: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
}

interface SearchActorsBody {
  actors: ActorBody[];
  hasMore: boolean;
  total?: number;
}

interface SeedActor {
  did: string;
  handle: string | null;
  displayName: string | null;
  collections: string[];
}

/** Alpha/Beta/Delta are on Bookhive; Charlie is unidentified and shelving-only. */
const SEED: SeedActor[] = [
  { did: ALPHA, handle: `verify${RUN}a.test`, displayName: `Alpha ${RUN}`, collections: [BOOKHIVE] },
  { did: BETA, handle: `verify${RUN}b.test`, displayName: `Beta ${RUN}`, collections: [BOOKHIVE] },
  { did: CHARLIE, handle: null, displayName: null, collections: [SHELVING] },
  { did: DELTA, handle: `verify${RUN}d.test`, displayName: null, collections: [BOOKHIVE] },
];

/** Measured before the seed, so the directory assertion is about the snapshot. */
const [baseline] = await db
  .select({ dids: sql<number>`count(distinct ${records.did})::int` })
  .from(records)
  .where(eq(records.collection, BOOKHIVE));
const SNAPSHOT_BOOKHIVE_DIDS = baseline?.dids ?? 0;
const SEEDED_BOOKHIVE_DIDS = SEED.filter((actor) => actor.collections.includes(BOOKHIVE)).length;

await db.insert(actors).values(
  SEED.map((actor) => ({
    did: actor.did,
    handle: actor.handle,
    displayName: actor.displayName,
  })),
);

await db.insert(records).values(
  SEED.flatMap((actor) =>
    actor.collections.map((collection) => ({
      uri: `at://${actor.did}/${collection}/${RUN}`,
      cid: `bafyverify${RUN}`,
      did: actor.did,
      rkey: RUN,
      collection,
      value: {},
    })),
  ),
);

after(async () => {
  await db.delete(records).where(like(records.did, `${DID_PREFIX}%`));
  await db.delete(actors).where(like(actors.did, `${DID_PREFIX}%`));
});

/** Drive the endpoint the way a client does: repeated params for arrays. */
async function search(entries: Array<[string, string]>): Promise<SearchActorsBody> {
  const query = new URLSearchParams(entries).toString();
  const res = await router.fetch(
    new Request(`http://localhost/xrpc/net.olamaelcu.livtet.biblio.searchActors?${query}`),
  );
  if (res.status !== 200) assert.fail(`${res.status}: ${await res.text()}`);
  return (await res.json()) as SearchActorsBody;
}

test('q matches a handle substring', async () => {
  const body = await search([['q', `verify${RUN}a`]]);
  assert.deepEqual(body.actors.map((actor) => actor.did), [ALPHA]);
  assert.equal(body.total, 1);
  // An actor without a resolved avatar omits the field instead of nulling it.
  assert.equal(body.actors[0]?.avatar, undefined);
});

test('q matches a display name, case-insensitively', async () => {
  const body = await search([['q', `alpha ${RUN}`]]);
  assert.deepEqual(body.actors.map((actor) => actor.did), [ALPHA]);
  assert.equal(body.actors[0]?.displayName, `Alpha ${RUN}`);
});

test('q carrying an exact DID matches that actor alone', async () => {
  const body = await search([['q', BETA]]);
  assert.deepEqual(body.actors.map((actor) => actor.did), [BETA]);
  assert.equal(body.hasMore, false);
});

test('hasRecords filters and hasMore is right at the boundary', async () => {
  const first = await search([['q', RUN], ['hasRecords', BOOKHIVE], ['limit', '2']]);
  assert.equal(first.actors.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, 3);

  const second = await search([
    ['q', RUN],
    ['hasRecords', BOOKHIVE],
    ['limit', '2'],
    ['offset', '2'],
  ]);
  assert.equal(second.actors.length, 1);
  assert.equal(second.hasMore, false);
  // The total is a first-page cost only.
  assert.equal(second.total, undefined);

  const exactlyFull = await search([['q', RUN], ['hasRecords', BOOKHIVE], ['limit', '3']]);
  assert.equal(exactlyFull.actors.length, 3);
  assert.equal(exactlyFull.hasMore, false);
});

test('an actor with no record in the collection is not matched', async () => {
  const shelvingOnly = await search([['q', RUN], ['hasRecords', SHELVING]]);
  assert.deepEqual(shelvingOnly.actors, []);
  assert.equal(shelvingOnly.total, 0);

  // No q: Charlie is listed by the shelving half of the directory, which is
  // what proves the filter is applied to the directory, not to the page.
  const shelving = await search([['hasRecords', SHELVING], ['limit', '100']]);
  assert.ok(shelving.actors.some((actor) => actor.did === CHARLIE));
  assert.ok(!shelving.actors.some((actor) => actor.did === ALPHA));
});

test('hasRecords is OR across the supplied collections', async () => {
  const body = await search([
    ['q', RUN],
    ['hasRecords', BOOKHIVE],
    ['hasRecords', SHELVING],
    ['limit', '10'],
  ]);
  assert.deepEqual(
    body.actors.map((actor) => actor.did).sort(),
    [ALPHA, BETA, DELTA].sort(),
  );
});

test('the profile collection answers honestly while it is not ingested', async () => {
  const body = await search([
    ['q', RUN],
    ['hasRecords', 'net.olamaelcu.livtet.actor.profile'],
  ]);
  assert.deepEqual(body.actors, []);
  assert.equal(body.hasMore, false);
  assert.equal(body.total, 0);
});

test('a page past the end is empty, not an error', async () => {
  const body = await search([['q', RUN], ['limit', '2'], ['offset', '10']]);
  assert.deepEqual(body.actors, []);
  assert.equal(body.hasMore, false);
  assert.equal(body.total, undefined);
});

test('paging with limit=1 walks every actor exactly once', async () => {
  const seen: string[] = [];
  for (let offset = 0; offset < 10; offset += 1) {
    const page = await search([
      ['q', RUN],
      ['hasRecords', BOOKHIVE],
      ['limit', '1'],
      ['offset', String(offset)],
    ]);
    seen.push(...page.actors.map((actor) => actor.did));
    if (!page.hasMore) break;
  }
  assert.deepEqual(seen.sort(), [ALPHA, BETA, DELTA].sort());
  assert.equal(new Set(seen).size, seen.length);
});

test('q shorter than 3 characters is rejected', async () => {
  const res = await router.fetch(
    new Request('http://localhost/xrpc/net.olamaelcu.livtet.biblio.searchActors?q=ab'),
  );
  assert.equal(res.status, 400);
});

test('the Bookhive directory is 1,124 DIDs at snapshot scale', async () => {
  const body = await search([['hasRecords', BOOKHIVE], ['limit', '1']]);
  const [counted] = await db
    .select({ dids: sql<number>`count(distinct ${records.did})::int` })
    .from(records)
    .where(eq(records.collection, BOOKHIVE));

  console.log(
    `bookhive snapshot: ${SNAPSHOT_BOOKHIVE_DIDS} distinct DIDs; `
      + `directory answered ${(body.total ?? 0) - SEEDED_BOOKHIVE_DIDS} before this run's seed`,
  );
  assert.ok(SNAPSHOT_BOOKHIVE_DIDS >= 1000, `snapshot DIDs was ${SNAPSHOT_BOOKHIVE_DIDS}`);
  // The directory covers every Bookhive DID, not just a page of them.
  assert.equal((body.total ?? 0) - SEEDED_BOOKHIVE_DIDS, SNAPSHOT_BOOKHIVE_DIDS);
  assert.equal((counted?.dids ?? 0) - SEEDED_BOOKHIVE_DIDS, SNAPSHOT_BOOKHIVE_DIDS);
});
