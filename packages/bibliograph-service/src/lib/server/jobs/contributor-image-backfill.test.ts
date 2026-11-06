import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Logger } from 'pino';
import { backfillContributorImageForUri, type BackfillDb } from './contributor-image-backfill';
import { UpstreamDeferred } from '../api/deferred';
import type { ContributorImageResolver } from '../contributor-image/resolver';
import type { ContributorRow } from '../db/schema';

const log: Logger = pino({ level: 'silent' });

const URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A26459A';

interface Capture {
  sets: Array<Record<string, unknown>>;
}

function row(overrides: Partial<ContributorRow> = {}): ContributorRow {
  return {
    uri: URI,
    cid: 'bafytest',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'ol.A26459A',
    name: 'Langston Hughes',
    aliases: [],
    linkedDid: null,
    bio: null,
    bioCheckedAt: null,
    bornYear: null,
    diedYear: null,
    identifiers: [],
    imageUrl: null,
    imageSource: null,
    imageArtist: null,
    imageLicense: null,
    imageLicenseUrl: null,
    imageAttributionRequired: false,
    imageCheckedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    indexedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as ContributorRow;
}

function makeDb(existing: ContributorRow | undefined, capture: Capture): BackfillDb {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (existing ? [existing] : []),
  };
  const updateChain = {
    set: (values: Record<string, unknown>) => {
      capture.sets.push(values);
      return updateChain;
    },
    where: async () => undefined,
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as BackfillDb;
}

const never = (async () => undefined) as ContributorImageResolver;

test('deferred upstream leaves the contributor unchecked', async () => {
  const capture: Capture = { sets: [] };
  const deferred = (async () => {
    throw new UpstreamDeferred('wikidata', 'breaker-open');
  }) as ContributorImageResolver;

  const result = await backfillContributorImageForUri(URI, log, makeDb(row(), capture), deferred);

  assert.equal(result.reason, 'deferred');
  assert.equal(capture.sets.length, 0, 'no permanent-miss stamp may be written on a deferral');
});

test('an authoritative miss stamps the row', async () => {
  const capture: Capture = { sets: [] };

  const result = await backfillContributorImageForUri(URI, log, makeDb(row(), capture), never);

  assert.equal(result.reason, 'no_image_found');
  assert.equal(capture.sets.length, 1);
  assert.ok(capture.sets[0]?.imageCheckedAt instanceof Date, 'stamp is what keeps a rerun from re-asking');
});

test('a resolved image persists url and license metadata', async () => {
  const capture: Capture = { sets: [] };
  const found = (async () => ({
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Ursula_K_Le_Guin.jpg/440px-Ursula_K_Le_Guin.jpg',
    source: 'wikidata' as const,
    attributionRequired: false,
  })) as ContributorImageResolver;

  const result = await backfillContributorImageForUri(URI, log, makeDb(row(), capture), found);

  assert.equal(result.updated, true);
  assert.equal(
    capture.sets[0]?.imageUrl,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Ursula_K_Le_Guin.jpg/440px-Ursula_K_Le_Guin.jpg',
  );
});

test('an already-checked row is skipped without a second lookup', async () => {
  const capture: Capture = { sets: [] };
  const checked = row({ imageCheckedAt: new Date('2026-01-02T00:00:00.000Z') });

  const result = await backfillContributorImageForUri(URI, log, makeDb(checked, capture), never);

  assert.equal(result.reason, 'already_checked');
  assert.equal(capture.sets.length, 0);
});
