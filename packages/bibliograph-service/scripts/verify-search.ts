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
import { GoogleBooksSource } from '../src/lib/server/search/google-books-source.js';
import { OpenLibraryEnricher } from '../src/lib/server/search/open-library-enricher.js';
import { IsbndbEnricher, IsbndbWorkEnricher } from '../src/lib/server/search/isbndb-enricher.js';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from '../src/lib/server/search/wikipedia-enricher.js';

import { SearchService } from '../src/lib/server/search/service.js';

const log = pino({ level: 'silent' });

function stubEverything() {
  return stubFetch(async (url: string) => {
    if (url.includes('openlibrary.org/search') && (url.endsWith('.json') || url.includes('?'))) {
      if (url.includes('/search/authors.json')) {
        return new Response(JSON.stringify({
          numFound: 1,
          docs: [{ key: '/authors/OL12345A', name: 'OL Author', birth_date: '1800-01-01', top_work: 'OL Work', work_count: 5 }],
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
    const gb = new GoogleBooksSource(log);
    const gbe = new GoogleBooksEnricher();
    const ole = new OpenLibraryEnricher();
    const ibe = new IsbndbEnricher();
    const ibwe = new IsbndbWorkEnricher();
    const aw = new AuthorWikipediaEnricher();
    const cw = new ContributorWikipediaEnricher();
    const svc = new SearchService(
      { postgres: pg, openLibrary: ol, publisherSource: { searchPublishers: async () => ({ items: [], total: 0 }) } as never, googleBooksSource: gb, googleBooks: gbe, openLibraryEnricher: ole, isbndbEnricher: ibe, isbndbWorkEnricher: ibwe, authorWikipedia: aw, contributorWikipedia: cw },
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

test('searchEditions returns Google Books primary results on Postgres miss', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=anything'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string; uri: string; coverImageUrl?: string }>; total?: number };
    assert.ok(body.items.length >= 1, 'expected Google Books primary to return at least one edition');
    assert.equal(body.items[0]?.title, 'OL Edition');
    assert.equal(body.items[0]?.coverImageUrl, 'https://x/cover.jpg');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/did:web:biblio\.livtet\.olamaelcu\.net\/community\.lexicon\.book\.edition\/ol\./);
  } finally { restore(); }
});

test('searchEditions falls back to OpenLibrary when Google Books is empty', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async (url: string) => {
    if (url.includes('googleapis.com/books')) {
      return new Response(JSON.stringify({ totalItems: 0, items: [] }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('openlibrary.org/search') && (url.endsWith('.json') || url.includes('?'))) {
      return new Response(JSON.stringify({
        numFound: 1,
        docs: [{ key: '/books/OL999M', title: 'OL Fallback Edition', isbn: ['9780123456789'] }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  try {
    const router = new XRPCRouter();
    const svc = new SearchService(
      { postgres: new PostgresSource(log), openLibrary: new OpenLibrarySource(log), publisherSource: { searchPublishers: async () => ({ items: [], total: 0 }) } as never, googleBooksSource: new GoogleBooksSource(log), googleBooks: new GoogleBooksEnricher(), openLibraryEnricher: new OpenLibraryEnricher(), isbndbEnricher: new IsbndbEnricher(), isbndbWorkEnricher: new IsbndbWorkEnricher(), authorWikipedia: new AuthorWikipediaEnricher(), contributorWikipedia: new ContributorWikipediaEnricher() },
      log,
    );
    router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
      async handler({ params }: { params: { q?: string } }) {
        const r = await svc.searchEditions({ q: params.q, id: undefined, limit: 20, cursor: undefined });
        return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
      },
    });
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=fallback'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string; uri: string }> };
    assert.equal(body.items[0]?.title, 'OL Fallback Edition');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/did:web:biblio\.livtet\.olamaelcu\.net\/community\.lexicon\.book\.edition\/ol\./);
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

test('searchContributors parses bare OpenLibrary author OLIDs (no /authors/ prefix)', async () => {
  const restore = stubFetch(async (url: string) => {
    if (url.includes('/search/authors.json')) {
      return new Response(JSON.stringify({
        numFound: 1,
        docs: [{ key: 'OL28885A', name: 'Maya Angelou', birth_date: 'April 4, 1928' }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('wikipedia.org')) {
      return new Response(JSON.stringify({ query: { pages: { '1': { extract: 'Bio.', title: 'Maya Angelou' } } } }),
        { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  const router = new XRPCRouter();
  const svc = new SearchService(
    { postgres: new PostgresSource(log), openLibrary: new OpenLibrarySource(log), publisherSource: { searchPublishers: async () => ({ items: [], total: 0 }) } as never, googleBooksSource: new GoogleBooksSource(log), googleBooks: new GoogleBooksEnricher(), openLibraryEnricher: new OpenLibraryEnricher(), isbndbEnricher: new IsbndbEnricher(), isbndbWorkEnricher: new IsbndbWorkEnricher(), authorWikipedia: new AuthorWikipediaEnricher(), contributorWikipedia: new ContributorWikipediaEnricher() },
    log,
  );
  router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params }: { params: { q?: string } }) {
      const r = await svc.searchContributors({ q: params.q, id: undefined, limit: 20, cursor: undefined });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchContributors?q=Maya+Angelou'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ name: string; uri: string }> };
    assert.ok(body.items.length >= 1, 'bare OLID must parse, not be skipped');
    assert.equal(body.items[0]?.name, 'Maya Angelou');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/did:web:biblio\.livtet\.olamaelcu\.net\/community\.lexicon\.book\.contributor\/ol\.A28885A$/);
  } finally { restore(); }
});

test('searchEditions skips work-only docs with no cover edition (no /books/ key)', async () => {
  const restore = stubFetch(async (url: string) => {
    if (url.includes('openlibrary.org/search') && url.includes('type=edition')) {
      return new Response(JSON.stringify({
        numFound: 2,
        docs: [
          { key: '/works/OL80021W', title: 'No Cover Edition' },
          { key: '/books/OL3321378M', title: 'With Edition', isbn: ['9780123456789'] },
        ],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('googleapis.com/books')) {
      return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  const router = new XRPCRouter();
  const pg = new PostgresSource(log);
  const svc = new SearchService(
      { postgres: pg, openLibrary: new OpenLibrarySource(log), publisherSource: { searchPublishers: async () => ({ items: [], total: 0 }) } as never, googleBooksSource: new GoogleBooksSource(log), googleBooks: new GoogleBooksEnricher(), openLibraryEnricher: new OpenLibraryEnricher(), isbndbEnricher: new IsbndbEnricher(), isbndbWorkEnricher: new IsbndbWorkEnricher(), authorWikipedia: new AuthorWikipediaEnricher(), contributorWikipedia: new ContributorWikipediaEnricher() },
    log,
  );
  router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params }: { params: { q?: string } }) {
      const r = await svc.searchEditions({ q: params.q, id: undefined, limit: 20, cursor: undefined });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const res = await router.fetch(new Request('http://localhost/xrpc/community.lexicon.book.searchEditions?q=work-unique-xyz'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string }>; total: number };
    assert.equal(body.items.length, 1, 'work-only doc must be skipped, not synthesized');
    assert.equal(body.items[0]?.title, 'With Edition');
    assert.equal(body.total, 2, 'total reflects OpenLibrary numFound, not the filtered set');
  } finally { restore(); }
});
