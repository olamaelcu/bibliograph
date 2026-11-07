#!/usr/bin/env tsx
// End-to-end verification of the searchEditions / searchWorks / searchContributors
// endpoints with stubbed external APIs.
//
// Usage:
//   pnpm exec tsx --test scripts/verify-search.ts
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

import { SearchService, type SearchServiceDeps } from '../src/lib/server/search/service.js';

const log = pino({ level: 'silent' });

/** Unique per run, so the shared Google Books cache cannot replay another run's body. */
const RUN = Date.now().toString(36);

function stubFetch(impl: (url: string) => Promise<Response>): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((url: string | URL | Request) => {
    calls++;
    return impl(String(url));
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls: () => calls };
}

/** One Google Books volume, shaped so both `mapGbToEdition` and `mapGbToWork` accept it. */
function stubGoogleBooks(id: string, title: string): { restore: () => void; calls: () => number } {
  return stubFetch(async (url) => {
    if (url.includes('googleapis.com/books')) {
      return new Response(JSON.stringify({
        totalItems: 1,
        items: [{ id, volumeInfo: { title, publishedDate: '1990', imageLinks: { thumbnail: 'http://x/cover.jpg' } } }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
}

/**
 * `searchEditions` is a query: the hints arrive as URL parameters and the
 * response is the `defs#editionResults` envelope. This harness returns the
 * source items unchanged (so the assertions can see which provider answered)
 * rather than mapping them to `defs#editionView`, which is the production
 * handler's job in `routes/xrpc/book-queries.ts`.
 */
function registerSearchEditions(router: XRPCRouter, svc: SearchService): void {
  router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params }) {
      const limit = params.limit ?? 20;
      // `identifiers` travel as `<type>:<value>` strings; the production handler
      // parses them the same way.
      const identifiers = (params.identifiers ?? []).flatMap((hint) => {
        const separator = hint.indexOf(':');
        if (separator <= 0 || separator === hint.length - 1) return [];
        return [{ type: hint.slice(0, separator), value: hint.slice(separator + 1) }];
      });
      const r = await svc.searchEditions({
        q: params.q,
        title: params.title,
        author: params.author,
        identifiers,
        limit,
        offset: params.offset ?? 0,
      });
      return Response.json({
        items: r.items,
        hasMore: r.items.length >= limit,
        ...(r.total > 0 ? { total: r.total } : {}),
      });
    },
  });
}

/** `POST` a procedure with its JSON input. */
function procedureRequest(nsid: string, input: Record<string, unknown>): Request {
  return new Request(`http://localhost/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** The production dependency graph, minus nothing: every remaining source and enricher is wired. */
function buildService(): SearchServiceDeps {
  return {
    postgres: new PostgresSource(log),
    googleBooksSource: new GoogleBooksSource(log),
    isbndbSource: new IsbndbSource(log),
    googleBooks: new GoogleBooksEnricher(),
    isbndbEnricher: new IsbndbEnricher(),
    isbndbWorkEnricher: new IsbndbWorkEnricher(),
    authorWikipedia: new AuthorWikipediaEnricher(),
    wikidataEdition: new WikidataEditionEnricher(),
  };
}

function buildRouter(): { router: XRPCRouter; restore: () => void } {
  const stub = stubGoogleBooks('gb-verify-1', 'GB Edition');
  const router = new XRPCRouter();
  const svc = new SearchService(buildService(), log);
  registerSearchEditions(router, svc);
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
  return { router, restore: stub.restore };
}

test('searchEditions serves Google Books results on a Postgres miss', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(procedureRequest('community.lexicon.book.searchEditions', { q: `verify-${RUN}-editions` }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ title: string; uri: string; coverImageUrl?: string }>;
      hasMore: boolean;
      total?: number;
    };
    assert.ok(body.items.length >= 1, 'expected Google Books primary to return at least one edition');
    assert.equal(body.items[0]?.title, 'GB Edition');
    assert.equal(body.items[0]?.coverImageUrl, 'https://x/cover.jpg');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/did:web:biblio\.livtet\.olamaelcu\.net\/community\.lexicon\.book\.edition\/gb\./);
    assert.equal(body.hasMore, false, 'one hit under the page limit must not claim more pages');
  } finally { restore(); }
});

test('searchWorks serves Google Books results on a Postgres miss', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const stub = stubGoogleBooks('gb-verify-2', 'GB Work');
  const router = new XRPCRouter();
  const svc = new SearchService(buildService(), log);
  router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
    async handler({ params }: { params: { q?: string; id?: string[]; limit?: number; cursor?: string } }) {
      const r = await svc.searchWorks({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const res = await router.fetch(new Request(`http://localhost/xrpc/community.lexicon.book.searchWorks?q=verify-${RUN}-works`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ title: string; uri: string }>; total?: number };
    assert.ok(body.items.length >= 1);
    assert.equal(body.items[0]?.title, 'GB Work');
    assert.match(body.items[0]?.uri ?? '', /^at:\/\/did:web:biblio\.livtet\.olamaelcu\.net\/community\.lexicon\.book\.work\/gb\./);
  } finally { stub.restore(); }
});

test('searchEditions degrades when GOOGLE_BOOKS_API_KEY is missing', async () => {
  delete process.env.GOOGLE_BOOKS_API_KEY;
  const { router, restore } = buildRouter();
  try {
    const res = await router.fetch(procedureRequest('community.lexicon.book.searchEditions', { q: `verify-${RUN}-no-key` }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ coverImageUrl?: string }>; hasMore: boolean };
    assert.equal(body.items[0]?.coverImageUrl, undefined);
  } finally { restore(); }
});

test('searchContributors is answered from Postgres with no upstream request', async () => {
  const stub = stubFetch(async () => new Response('not found', { status: 404 }));
  const router = new XRPCRouter();
  const svc = new SearchService(buildService(), log);
  router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params }: { params: { q?: string; id?: string[]; limit?: number; cursor?: string } }) {
      const r = await svc.searchContributors({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const res = await router.fetch(new Request(`http://localhost/xrpc/community.lexicon.book.searchContributors?q=verify-${RUN}-contributor`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ name: string }>; total?: number };
    assert.ok(Array.isArray(body.items), 'the index is the answer, matched or not');
    assert.equal(stub.calls(), 0, 'contributors must not consult any upstream');
  } finally { stub.restore(); }
});
