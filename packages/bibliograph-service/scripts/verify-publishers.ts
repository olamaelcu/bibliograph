#!/usr/bin/env tsx
// End-to-end verification of the searchPublishers endpoint and PostgresSource.
// Requires DATABASE_URL pointing at a database with the publishers table.
// Uses no external APIs (Postgres-only by design), so no fetch stub needed.
//
// Usage:
//   pnpm exec tsx --test scripts/verify-publishers.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/server/db';
import { publishers } from '../src/lib/server/db/schema';
import { PostgresSource } from '../src/lib/server/search/postgres-source';
import type { SearchQuery } from '../src/lib/server/search/types';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const log = pino({ level: 'silent' });
const FIXTURE_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.publisher/verify-fixture-001';
const FIXTURE_NAME = 'VerifyFixturePublisher';
const FIXTURE_IDENT = { uri: 'https://openlibrary.org/publishers/VerifyFixturePublisher', resource: 'openlibrary' as const };

async function insertFixture() {
  await db.delete(publishers).where(eq(publishers.uri, FIXTURE_URI));
  await db.insert(publishers).values({
    uri: FIXTURE_URI,
    cid: 'bafyplaceholder',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'verify-fixture-001',
    name: FIXTURE_NAME,
    identifiers: [FIXTURE_IDENT],
    createdAt: new Date(),
  });
}

async function cleanup() {
  await db.delete(publishers).where(eq(publishers.uri, FIXTURE_URI));
}

const source = new PostgresSource(log);

test('searchPublishers matches by ilike on name', async () => {
  await insertFixture();
  try {
    const query: SearchQuery = { q: 'VerifyFixture', limit: 20 };
    const result = await source.searchPublishers(query);
    assert.ok(result.items.length >= 1, 'expected at least one result');
    const hit = result.items.find((r) => r.uri === FIXTURE_URI);
    assert.ok(hit, 'expected fixture row in results');
    assert.equal(hit!.name, FIXTURE_NAME);
    assert.ok(hit!.identifiers.some((id) => id.uri === FIXTURE_IDENT.uri));
  } finally { await cleanup(); }
});

test('searchPublishers returns empty on miss', async () => {
  const result = await source.searchPublishers({ q: 'zzz-no-such-publisher-zzz', limit: 20 });
  assert.equal(result.items.length, 0);
});

test('searchPublishers matches by identifier (jsonb @>)', async () => {
  await insertFixture();
  try {
    const result = await source.searchPublishers({ id: [FIXTURE_IDENT.uri], limit: 20 });
    assert.ok(result.items.length >= 1, 'expected at least one result');
    const hit = result.items.find((r) => r.uri === FIXTURE_URI);
    assert.ok(hit, 'expected fixture row in id-based results');
  } finally { await cleanup(); }
});
