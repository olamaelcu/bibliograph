#!/usr/bin/env tsx
// End-to-end verification of the searchEditions / searchWorks / searchContributors
// endpoints with stubbed external APIs.
//
// Usage:
//   pnpm exec tsx scripts/verify-search.ts
//
// Requires DATABASE_URL to point at a database with the editions/works/contributors
// tables and the `cover_image_url` column on editions. Tests stub fetch globally
// so no external calls hit the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { XRPCRouter } from '@atcute/xrpc-server';
import {
  CommunityLexiconBookSearchContributors,
  CommunityLexiconBookSearchEditions,
  CommunityLexiconBookSearchWorks,
} from '../src/lib/server/lexicons/index.js';
import { PostgresSource } from '../src/lib/server/search/postgres-source.js';
import { GoogleBooksEnricher } from '../src/lib/server/search/google-books-enricher.js';
import { GoogleBooksSource } from '../src/lib/server/search/google-books-source.js';
import { IsbndbEnricher, IsbndbWorkEnricher } from '../src/lib/server/search/isbndb-enricher.js';
import { IsbndbSource } from '../src/lib/server/search/isbndb-source.js';
import { AuthorWikipediaEnricher } from '../src/lib/server/search/wikipedia-enricher.js';
import { WikidataEditionEnricher } from '../src/lib/server/search/wikidata-enricher.js';

import { SearchService } from '../src/lib/server/search/service.js';

const log = pino({ level: 'silent' });

const GB_VOLUME = {
  id: 'GhPSEAAAQBAJ',
  volumeInfo: {
    title: 'Neuromancer',
    description: 'A book.',
    publishedDate: '1984',
    language: 'en',
    imageLinks: { thumbnail: 'http://x/cover.jpg' },
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441569595' }],
  },
};

function stubEverything(sink?: string[]): () => void {
  return stubFetch(async (url: string) => {
    sink?.push(url);
    if (url.includes('googleapis.com/books')) {
      return new Response(JSON.stringify({ totalItems: 1, items: [GB_VOLUME] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('wikipedia.org')) {
      return new Response(JSON.stringify({ query: { pages: { '1': { extract: 'A person.', title: 'Neuromancer' } } } }),
        { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
}

function stubFetch(impl: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function buildService(): SearchService {
  return new SearchService(
    {
      postgres: new PostgresSource(log),
      googleBooksSource: new GoogleBooksSource(log),
      isbndbSource: new IsbndbSource(log),
      googleBooks: new GoogleBooksEnricher(),
      isbndbEnricher: new IsbndbEnricher(),
      isbndbWorkEnricher: new IsbndbWorkEnricher(),
      authorWikipedia: new AuthorWikipediaEnricher(),
      wikidataEdition: new WikidataEditionEnricher(),
    },
    log,
  );
}

function buildRouter(sink?: string[]): { router: XRPCRouter; restore: () => void } {
  const restore = stubEverything(sink);
  const router = new XRPCRouter();
  const svc = buildService();
  router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params }: { params: { q?: string; id?: string[]; limit?: number; cursor?: string } }) {
      const r = await svc.searchEditions({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
    async handler({ params }: { params: { q?: string; id?: string[]; limit?: number; cursor?: string } }) {
      const r = await svc.searchWorks({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params }: { params: { q?: string; id?: string[]; limit?: number; cursor?: string } }) {
      const r = await svc.searchContributors({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { router, restore };
}

test('searchEditions returns Google Books primary results on Postgres miss', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=anything'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string; uri: string; coverImageUrl?: string }>; total?: number };
    assert.ok(body.items.length >= 1, 'expected Google Books primary to return at least one edition');
    assert.equal(body.items[0]?.title, 'Neuromancer');
    assert.equal(body.items[0]?.coverImageUrl, 'https://x/cover.jpg');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/[^/]+\/community\.lexicon\.book\.edition\/gb\./);
  } finally { restore(); }
});

test('searchWorks returns Google Books work results', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchWorks?q=work'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string; uri: string }>; total?: number };
    assert.ok(body.items.length >= 1);
    assert.equal(body.items[0]?.title, 'Neuromancer');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/[^/]+\/community\.lexicon\.book\.work\/gb\./);
  } finally { restore(); }
});

test('searchEditions degrades when GOOGLE_BOOKS_API_KEY is missing', async () => {
  delete process.env.GOOGLE_BOOKS_API_KEY;
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=anything'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { degraded?: { upstream: string; reason: string } };
    assert.equal(body.degraded?.upstream, 'googlebooks');
    assert.equal(body.degraded?.reason, 'missing_api_key');
  } finally { restore(); }
});

test('searchContributors answers from Postgres without calling any upstream', async () => {
  const calls: string[] = [];
  const { router, restore } = buildRouter(calls);
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchContributors?q=Maya+Angelou'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    assert.ok(Array.isArray(body.items));
    assert.deepEqual(calls, [], 'contributor search must not consult an external catalog');
  } finally { restore(); }
});
