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
import { OpenLibrarySource } from '../src/lib/server/search/open-library-source.js';
import { GoogleBooksEnricher } from '../src/lib/server/search/google-books-enricher.js';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from '../src/lib/server/search/wikipedia-enricher.js';

import { SearchService } from '../src/lib/server/search/service.js';

const log = pino({ level: 'silent' });

function stubEverything() {
  return stubFetch(async (url: string) => {
    if (url.includes('openlibrary.org/search') && (url.endsWith('.json') || url.includes('?'))) {
      if (url.includes('/search/authors.json')) {
        return new Response(JSON.stringify({
          numFound: 1,
          docs: [{ key: '/authors/OL12345A', author_name: 'OL Author', birth_date: '1800-01-01' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const type = new URL(url).searchParams.get('type');
      const docs = type === 'work'
        ? [{ key: '/works/OL66554W', title: 'OL Work', first_publish_year: 1850 }]
        : [{ key: '/books/OL12345M', title: 'OL Edition', isbn: ['9780123456789'] }];
      return new Response(JSON.stringify({ numFound: 1, docs }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('googleapis.com/books')) {
      return new Response(JSON.stringify({
        items: [{ volumeInfo: { description: 'A book.', imageLinks: { thumbnail: 'http://x/cover.jpg' } } }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('wikipedia.org')) {
      return new Response(JSON.stringify({ query: { pages: { '1': { extract: 'A person.', title: 'OL Author' } } } }),
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

function buildRouter(): { router: XRPCRouter; restore: () => void } {
  const restore = stubEverything();
  const router = new XRPCRouter();
  const pg = new PostgresSource(log);
  const ol = new OpenLibrarySource(log);
  const gb = new GoogleBooksEnricher();
  const aw = new AuthorWikipediaEnricher();
  const cw = new ContributorWikipediaEnricher();
  const svc = new SearchService(
    { postgres: pg, openLibrary: ol, googleBooks: gb, authorWikipedia: aw, contributorWikipedia: cw },
    log,
  );
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

test('searchEditions returns OpenLibrary results on Postgres miss', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=anything'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string; coverImageUrl?: string }>; total?: number };
    assert.ok(body.items.length >= 1, 'expected OpenLibrary fallback to return at least one edition');
    assert.equal(body.items[0]?.title, 'OL Edition');
    assert.equal(body.items[0]?.coverImageUrl, 'http://x/cover.jpg');
  } finally { restore(); }
});

test('searchWorks returns OpenLibrary work results', async () => {
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchWorks?q=work'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string }>; total?: number };
    assert.ok(body.items.length >= 1);
    assert.equal(body.items[0]?.title, 'OL Work');
  } finally { restore(); }
});

test('searchContributors returns OpenLibrary author results with Wikipedia bio', async () => {
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchContributors?q=author'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ name: string; bio?: string }> };
    assert.ok(body.items.length >= 1);
    assert.equal(body.items[0]?.name, 'OL Author');
    assert.equal(body.items[0]?.bio, 'A person.');
  } finally { restore(); }
});

test('searchEditions degrades when GOOGLE_BOOKS_API_KEY is missing', async () => {
  delete process.env.GOOGLE_BOOKS_API_KEY;
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=anything'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ coverImageUrl?: string }> };
    assert.equal(body.items[0]?.coverImageUrl, undefined);
  } finally { restore(); }
});
