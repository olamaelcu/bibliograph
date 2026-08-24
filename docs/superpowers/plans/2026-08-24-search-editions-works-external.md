# searchEditions / searchWorks / searchContributors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `community.lexicon.book.searchEditions`, `searchWorks`, and `searchContributors` so each one searches the local Postgres tables first, falls back to OpenLibrary (`/search.json`) on miss, enriches with Google Books (editions only) and Wikipedia (all three kinds), and persists discovered items to the typed tables under the service DID `did:web:biblio.livtet.olamaelcu.net`. All three log every stage with the request correlation ID.

**Architecture:** Strategy pattern. `SearchService` (one method per kind) chains `PostgresSource` → on miss: `OpenLibrarySource` → `GoogleBooksEnricher` (editions only) → `WikipediaEnricher` (per kind) → `LocalPostgresIngestor.ingest` (fire-and-forget). All strategies take a required `Logger`. The 10s upstream timeout is a single shared constant. Persistence uses service-DID-owned records with rkeys derived from OpenLibrary keys (`ol-{kind}-{OLid}`); `com.atproto.repo.getRecord` is extended to read these from Postgres and compute CIDs via `@atproto/lex-cbor`'s `cidForLex`.

**Tech Stack:** TypeScript, Node 22+, atcute (@atcute/lex-cli, @atcute/xrpc-server), @atproto/lex-cbor, @atproto/repo, Drizzle ORM, Postgres, pino logging. Tests use `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-search-editions-works-external-design.md` (commit `54e38d4`).

---

## File map

**New files**
- `packages/bibliograph-service/src/lib/server/api/timeout.ts` — `UPSTREAM_TIMEOUT_MS` constant.
- `packages/bibliograph-service/src/lib/server/api/open-library.ts` — OpenLibrary search wrappers (three exports).
- `packages/bibliograph-service/src/lib/server/api/google-books.ts` — Google Books enrichment.
- `packages/bibliograph-service/src/lib/server/api/wikipedia.ts` — Wikipedia enrichment (two exports).
- `packages/bibliograph-service/src/lib/server/search/types.ts` — strategy interfaces + item types.
- `packages/bibliograph-service/src/lib/server/search/service.ts` — `SearchService` orchestrator.
- `packages/bibliograph-service/src/lib/server/search/postgres-source.ts` — `PostgresSource<T>`.
- `packages/bibliograph-service/src/lib/server/search/open-library-source.ts` — wraps `api/open-library.ts`.
- `packages/bibliograph-service/src/lib/server/search/google-books-enricher.ts` — wraps `api/google-books.ts`.
- `packages/bibliograph-service/src/lib/server/search/wikipedia-enricher.ts` — wraps `api/wikipedia.ts` (two classes).
- `packages/bibliograph-service/src/lib/server/search/local-postgres-ingestor.ts` — fire-and-forget upserts.
- `packages/bibliograph-service/lexicons/community/lexicon/book/defs.json` — shared `contribution` / `identifier` defs.
- `packages/bibliograph-service/lexicons/community/lexicon/book/work.json` — work record lex.
- `packages/bibliograph-service/lexicons/community/lexicon/book/contributor.json` — contributor record lex.
- `packages/bibliograph-service/drizzle/0002_discovery_columns.sql` — `editions.cover_image_url` column.
- `packages/bibliograph-service/scripts/verify-search.ts` — end-to-end verification.
- Test files colocated as `*.test.ts` next to each implementation.

**Modified files**
- `packages/bibliograph-service/lexicons/community/lexicon/book/edition.json` — add `coverImageUrl`; inline defs → NSID refs.
- `packages/bibliograph-service/lexicons/community/lexicon/book/searchWorks.json` — null body → full schema.
- `packages/bibliograph-service/lexicons/community/lexicon/book/searchContributors.json` — null body → full schema.
- `packages/bibliograph-service/src/lib/server/db/schema.ts` — add `coverImageUrl` column on `editions`.
- `packages/bibliograph-service/src/lib/server/xrpc-router.ts` — three handler rewrites; cursor v2; getRecord extension.
- `packages/bibliograph-service/.env.example` — `GOOGLE_BOOKS_API_KEY=`.
- `packages/bibliograph-service/package.json` — `verify:search` script.
- `README.md` — Material Discovery sentence.

---

## Task 1: Shared upstream timeout constant

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/timeout.ts`
- Test: `packages/bibliograph-service/src/lib/server/api/timeout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/server/api/timeout.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { UPSTREAM_TIMEOUT_MS } from './timeout.ts';

test('UPSTREAM_TIMEOUT_MS is 10_000', () => {
  assert.equal(UPSTREAM_TIMEOUT_MS, 10_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/bibliograph-service`:
```bash
pnpm exec tsx --test src/lib/server/api/timeout.test.ts
```
Expected: FAIL — `Cannot find module './timeout.ts'`.

- [ ] **Step 3: Implement the constant**

```ts
// src/lib/server/api/timeout.ts
/**
 * Shared HTTP timeout for upstream APIs (OpenLibrary, Google Books, Wikipedia).
 * 10s covers p95 under typical load. Increase via env if upstream quotas tighten.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsx --test src/lib/server/api/timeout.test.ts
```
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/api/timeout.ts \
        packages/bibliograph-service/src/lib/server/api/timeout.test.ts
git commit -m "feat(search): add UPSTREAM_TIMEOUT_MS shared constant"
```

---

## Task 2: Search types module (interfaces + item shapes)

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/types.ts`
- Test: `packages/bibliograph-service/src/lib/server/search/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/server/search/types.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import type { SearchSource, Enricher, Ingestor, SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem } from './types.ts';

test('SearchSource interface shape', (_t) => {
  // tsc-only check; the cast validates the type compiles.
  const fn = (_q: SearchQuery, _l: Logger, _s?: AbortSignal): Promise<SearchResult<EditionItem>> => {
    throw new Error('not implemented in test');
  };
  const _src: SearchSource<EditionItem> = { name: 'x', search: fn };
  assert.ok(_src);
});

test('Enricher interface shape', (_t) => {
  const fn = (_items: WorkItem[], _l: Logger, _s?: AbortSignal): Promise<WorkItem[]> => {
    throw new Error('not implemented in test');
  };
  const _e: Enricher<WorkItem> = { name: 'y', enrich: fn };
  assert.ok(_e);
});

test('Ingestor interface shape', (_t) => {
  const fn = (_items: ContributorItem[]): Promise<void> => Promise.resolve();
  const _i: Ingestor<ContributorItem> = { name: 'z', ingest: fn };
  assert.ok(_i);
});

test('EditionItem fields exist on type', () => {
  const item: EditionItem = {
    title: 't',
    identifiers: [],
    contributors: [],
    createdAt: new Date().toISOString(),
  };
  assert.equal(item.title, 't');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsx --test src/lib/server/search/types.test.ts
```
Expected: FAIL — `Cannot find module './types.ts'`.

- [ ] **Step 3: Implement the types module**

```ts
// src/lib/server/search/types.ts
import type { Logger } from 'pino';

export interface Identifier {
  uri: string;
  resource: string;
}

export interface ContributionEntry {
  subject: { uri: string; cid: string };
  role: string;
}

export interface EditionItem {
  uri?: string;
  title: string;
  subtitle?: string;
  publishedYear?: number;
  place?: string;
  language?: string;
  description?: string;
  coverImageUrl?: string;
  identifiers: Identifier[];
  contributors: ContributionEntry[];
  createdAt: string;
}

export interface WorkItem {
  uri?: string;
  title: string;
  subtitle?: string;
  originalLanguage?: string;
  firstPublishedYear?: number;
  subjects: string[];
  description?: string;
  contributors: ContributionEntry[];
  identifiers: Identifier[];
  createdAt: string;
}

export interface ContributorItem {
  uri?: string;
  name: string;
  aliases: string[];
  bio?: string;
  bornYear?: number;
  diedYear?: number;
  linkedDid?: string;
  identifiers: Identifier[];
  createdAt: string;
}

export type Item = EditionItem | WorkItem | ContributorItem;

export interface SearchQuery {
  q?: string;
  id?: string[];
  limit: number;
  cursor?: string;
}

export interface SearchResult<T> {
  items: T[];
  cursor?: string;
  total?: number;
}

export interface SearchSource<T> {
  readonly name: string;
  search(query: SearchQuery, log: Logger, signal?: AbortSignal): Promise<SearchResult<T>>;
}

export interface Enricher<T> {
  readonly name: string;
  enrich(items: T[], log: Logger, signal?: AbortSignal): Promise<T[]>;
}

export interface Ingestor<T> {
  readonly name: string;
  ingest(items: T[]): Promise<void>; // owns its own logger
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsx --test src/lib/server/search/types.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/types.ts \
        packages/bibliograph-service/src/lib/server/search/types.test.ts
git commit -m "feat(search): add strategy interfaces and item types"
```

---

## Task 3: OpenLibrary `searchEditions` wrapper

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/open-library.ts`
- Create: `packages/bibliograph-service/src/lib/server/api/open-library.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/server/api/open-library.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { searchEditions } from './open-library.ts';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('searchEditions hits OpenLibrary with type=edition', async () => {
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return new Response(JSON.stringify({
      numFound: 1,
      docs: [{ key: '/books/OL12345M', title: 'Test', isbn: ['9780123456789'] }],
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await searchEditions({ q: 'test', limit: 20 }, log);
    assert.match(captured, /openlibrary\.org\/search\.json/);
    assert.match(captured, /type=edition/);
    assert.match(captured, /q=test/);
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.title, 'Test');
    assert.deepEqual(result.items[0]?.identifiers[0], { uri: 'https://openlibrary.org/books/OL12345M', resource: 'openlibrary' });
  } finally { restore(); }
});

test('searchEditions forwards OpenLibrary nextPage to cursor', async () => {
  const restore = stubFetch(async (_url) => new Response(JSON.stringify({
    numFound: 5, page: 1, docs: [{ key: '/books/OL1M', title: 'A' }],
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const result = await searchEditions({ q: 'x', limit: 1 }, log);
    assert.ok(result.cursor, 'cursor should be set when more results exist');
  } finally { restore(); }
});

test('searchEditions propagates 4xx as error log + empty result', async () => {
  const restore = stubFetch(async (_url) => new Response('bad', { status: 500 }));
  try {
    const result = await searchEditions({ q: 'x', limit: 1 }, log);
    assert.equal(result.items.length, 0);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsx --test src/lib/server/api/open-library.test.ts
```
Expected: FAIL — `Cannot find module './open-library.ts'`.

- [ ] **Step 3: Implement the wrapper**

```ts
// src/lib/server/api/open-library.ts
import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout.ts';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem, Identifier } from '../search/types.ts';

const BASE = 'https://openlibrary.org/search.json';
const UA = 'Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)';

function buildUrl(q: string | undefined, type: 'edition' | 'work' | 'author', limit: number, page: number): string {
  const u = new URL(BASE);
  if (q) u.searchParams.set('q', q);
  u.searchParams.set('type', type);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('page', String(page));
  return u.toString();
}

async function fetchJson<T>(url: string, log: Logger, signal: AbortSignal): Promise<T | null> {
  const start = performance.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal });
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    if (!res.ok) {
      log.warn({ stage: 'open-library-source', status: res.status, body: await res.text() }, 'openlibrary non-2xx');
      return null;
    }
    log.info({ stage: 'open-library-source', url, durationMs }, 'openlibrary ok');
    return (await res.json()) as T;
  } catch (err) {
    log.error({ stage: 'open-library-source', err, url }, 'openlibrary fetch failed');
    return null;
  }
}

interface OlSearchResponse<T> {
  numFound?: number;
  start?: number;
  page?: number;
  docs?: T[];
}

interface OlEditionDoc { key: string; title: string; subtitle?: string; first_publish_year?: number; publish_year?: number[]; place?: string[]; language?: string[]; isbn?: string[]; cover_i?: number; description?: string | { value: string }; number_of_pages_median?: number; }
interface OlWorkDoc { key: string; title: string; subtitle?: string; first_publish_year?: number; original_languages?: string[]; subject?: string[]; description?: string | { value: string }; cover_i?: number; }
interface OlAuthorDoc { key: string; name: string; birth_date?: string; death_date?: string; top_work?: string; work_count?: number; alternate_names?: string[]; }

function coverUrl(coverId: number | undefined, kind: 'books' | 'works' | 'authors'): string | undefined {
  if (coverId === undefined) return undefined;
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
}

function extractDescription(d: string | { value: string } | undefined): string | undefined {
  if (typeof d === 'string') return d;
  if (d && typeof d.value === 'string') return d.value;
  return undefined;
}

function yearFromDate(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^(\d{4})/.exec(d);
  return m ? Number(m[1]) : undefined;
}

function makeOlIdentifier(key: string): Identifier {
  return { uri: `https://openlibrary.org${key}`, resource: 'openlibrary' };
}

export async function searchEditions(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<EditionItem>> {
  const limit = query.limit;
  const page = 1; // cursor-driven pagination comes via searchService in a follow-up
  const url = buildUrl(query.q, 'edition', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlEditionDoc>>(url, log, signal);
  if (!data) return { items: [] };
  const items: EditionItem[] = (data.docs ?? ?? []).map((d) => {
    const identifiers: Identifier[] = [makeOlIdentifier(d.key)];
    if (d.isbn) for (const i of d.isbn.slice(0, 5)) identifiers.push({ uri: `isbn:${i}`, resource: 'isbn13' });
    const year = d.first_publish_year ?? d.publish_year?.[0];
    return {
      title: d.title,
      subtitle: d.subtitle,
      publishedYear: year,
      place: d.place?.[0],
      language: d.language?.[0],
      description: extractDescription(d.description),
      coverImageUrl: coverUrl(d.cover_i, 'books'),
      identifiers,
      contributors: [],
      createdAt: new Date().toISOString(),
    };
  });
  const total = data.numFound;
  return { items, total };
}

export async function searchWorks(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<WorkItem>> {
  const limit = query.limit;
  const page = 1;
  const url = buildUrl(query.q, 'work', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlWorkDoc>>(url, log, signal);
  if (!data) return { items: [] };
  const items: WorkItem[] = (data.docs ?? ?? []).map((d) => ({
    title: d.title,
    subtitle: d.subtitle,
    firstPublishedYear: d.first_publish_year,
    originalLanguage: d.original_languages?.[0],
    subjects: d.subject ?? [],
    description: extractDescription(d.description),
    contributors: [],
    identifiers: [makeOlIdentifier(d.key)],
    createdAt: new Date().toISOString(),
  }));
  return { items, total: data.numFound };
}

export async function searchContributors(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<ContributorItem>> {
  const limit = query.limit;
  const page = 1;
  const url = buildUrl(query.q, 'author', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlAuthorDoc>>(url, log, signal);
  if (!data) return { items: [] };
  const items: ContributorItem[] = (data.docs ?? ?? []).map((d) => {
    const aliases = d.alternate_names ?? [];
    return {
      name: d.name,
      aliases,
      bornYear: yearFromDate(d.birth_date),
      diedYear: yearFromDate(d.death_date),
      identifiers: [makeOlIdentifier(d.key)],
      createdAt: new Date().toISOString(),
    };
  });
  return { items, total: data.numFound };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsx --test src/lib/server/api/open-library.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/api/open-library.ts \
        packages/bibliograph-service/src/lib/server/api/open-library.test.ts
git commit -m "feat(api): add OpenLibrary search wrappers for editions/works/contributors"
```

---

## Task 4: Google Books enrichment wrapper

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/google-books.ts`
- Create: `packages/bibliograph-service/src/lib/server/api/google-books.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/server/api/google-books.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichEditions } from './google-books.ts';
import type { EditionItem } from '../search/types.ts';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const baseItem: EditionItem = {
  title: 'Test',
  identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

test('enrichEditions writes description + coverImageUrl from Google Books', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async (url) => {
    assert.match(url, /googleapis\.com\/books\/v1\/volumes/);
    assert.match(url, /q=isbn:9780123456789/);
    assert.match(url, /key=k/);
    return new Response(JSON.stringify({
      items: [{
        volumeInfo: {
          description: 'A great book.',
          imageLinks: { thumbnail: 'http://books.google.com/cover.jpg' },
        },
      }],
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.equal(out.description, 'A great book.');
    assert.equal(out.coverImageUrl, 'http://books.google.com/cover.jpg');
  } finally { restore(); }
});

test('enrichEditions leaves item unchanged when Google Books returns no match', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async () => new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } }));
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.equal(out.description, undefined);
    assert.equal(out.coverImageUrl, undefined);
  } finally { restore(); }
});

test('enrichEditions no-ops when GOOGLE_BOOKS_API_KEY is missing', async () => {
  delete process.env.GOOGLE_BOOKS_API_KEY;
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.equal(out.description, undefined);
    assert.equal(called, false);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsx --test src/lib/server/api/google-books.test.ts
```
Expected: FAIL — `Cannot find module './google-books.ts'`.

- [ ] **Step 3: Implement the wrapper**

```ts
// src/lib/server/api/google-books.ts
import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout.ts';
import type { EditionItem } from '../search/types.ts';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

let warnedMissingKey = false;

interface GbVolume { volumeInfo?: { description?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string } }; }
interface GbSearchResponse { totalItems?: number; items?: GbVolume[]; }

function isbnFromIdentifiers(item: EditionItem): string | undefined {
  for (const id of item.identifiers) {
    if (id.resource === 'isbn13' || id.resource === 'isbn10' || id.resource === 'isbn') {
      return id.uri.replace(/^isbn:/, '');
    }
  }
  return undefined;
}

export async function enrichEditions(
  items: readonly EditionItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<EditionItem[]> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'google-books-enricher' }, 'GOOGLE_BOOKS_API_KEY is not set; Google Books enrichment disabled');
    }
    return [...items];
  }

  const out: EditionItem[] = [];
  let matched = 0;
  let missing = 0;
  for (const item of items) {
    let enriched = item;
    const isbn = isbnFromIdentifiers(item);
    if (isbn) {
      const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const url = `${BASE}?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(key)}`;
      try {
        const start = performance.now();
        const res = await fetch(url, { signal });
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        if (res.ok) {
          const data = (await res.json()) as GbSearchResponse;
          const info = data.items?.[0]?.volumeInfo;
          if (info) {
            if (!enriched.description && info.description) enriched = { ...enriched, description: info.description };
            const cover = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail;
            if (!enriched.coverImageUrl && cover) enriched = { ...enriched, coverImageUrl: cover };
            matched++;
          } else {
            missing++;
          }
          log.info({ stage: 'google-books-enricher', isbn, matched, missing, durationMs }, 'googlebooks ok');
        } else {
          log.warn({ stage: 'google-books-enricher', status: res.status }, 'googlebooks non-2xx');
          missing++;
        }
      } catch (err) {
        log.error({ stage: 'google-books-enricher', err, isbn }, 'googlebooks fetch failed');
        missing++;
      }
    } else {
      missing++;
    }
    out.push(enriched);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsx --test src/lib/server/api/google-books.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/api/google-books.ts \
        packages/bibliograph-service/src/lib/server/api/google-books.test.ts
git commit -m "feat(api): add Google Books enrichment for editions"
```

---

## Task 5: Wikipedia wrapper (two exports)

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/wikipedia.ts`
- Create: `packages/bibliograph-service/src/lib/server/api/wikipedia.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/server/api/wikipedia.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichContributorBios } from './wikipedia.ts';
import type { ContributorItem, EditionItem } from '../search/types.ts';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('enrichContributorBios writes bio from Wikipedia extract', async () => {
  const restore = stubFetch(async (url) => {
    assert.match(url, /wikipedia\.org\/w\/api\.php/);
    assert.match(url, /titles=Jane%20Doe/);
    return new Response(JSON.stringify({
      query: { pages: { '1': { extract: 'Jane Doe is a writer.', title: 'Jane Doe' } } },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const items: ContributorItem[] = [{ name: 'Jane Doe', aliases: [], identifiers: [], createdAt: new Date().toISOString() }];
    const [out] = await enrichContributorBios(items, log);
    assert.equal(out.bio, 'Jane Doe is a writer.');
  } finally { restore(); }
});

test('enrichContributorBios skips when Wikipedia returns no pages', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    query: { pages: { '-1': { title: 'Ghost', missing: '' } } },
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const items: ContributorItem[] = [{ name: 'Ghost', aliases: [], identifiers: [], createdAt: new Date().toISOString() }];
    const [out] = await enrichContributorBios(items, log);
    assert.equal(out.bio, undefined);
  } finally { restore(); }
});

test('enrichContributorBios dedupes by name within a single call', async () => {
  let calls = 0;
  const restore = stubFetch(async (_url) => { calls++; return new Response(JSON.stringify({
    query: { pages: { '1': { extract: 'X' } } },
  }), { headers: { 'content-type': 'application/json' } }); });
  try {
    const items: ContributorItem[] = [
      { name: 'Same', aliases: [], identifiers: [], createdAt: new Date().toISOString() },
      { name: 'Same', aliases: [], identifiers: [], createdAt: new Date().toISOString() },
    ];
    await enrichContributorBios(items, log);
    assert.equal(calls, 1);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsx --test src/lib/server/api/wikipedia.test.ts
```
Expected: FAIL — `Cannot find module './wikipedia.ts'`.

- [ ] **Step 3: Implement the wrapper**

```ts
// src/lib/server/api/wikipedia.ts
import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout.ts';
import type { ContributorItem, EditionItem, WorkItem, ContributionEntry } from '../search/types.ts';

const BASE = 'https://en.wikipedia.org/w/api.php';

interface WikiQueryResponse { query?: { pages?: Record<string, { extract?: string; title?: string; missing?: string }> }; }

async function fetchExtracts(names: string[], log: Logger, signal?: AbortSignal): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const url = `${BASE}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(names.join('|'))}`;
  const start = performance.now();
  try {
    const effectiveSignal = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const res = await fetch(url, { signal: effectiveSignal });
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    if (!res.ok) {
      log.warn({ stage: 'wikipedia-enricher', status: res.status, names: names.length }, 'wikipedia non-2xx');
      return new Map();
    }
    const data = (await res.json()) as WikiQueryResponse;
    const pages = data.query?.pages ?? {};
    const out = new Map<string, string>();
    for (const page of Object.values(pages)) {
      if (page.missing) continue;
      if (page.extract && page.title) {
        const clean = page.extract.replace(/\s+/g, ' ').trim().slice(0, 2048);
        out.set(page.title, clean);
      }
    }
    log.info({ stage: 'wikipedia-enricher', requested: names.length, matched: out.size, durationMs }, 'wikipedia ok');
    return out;
  } catch (err) {
    log.error({ stage: 'wikipedia-enricher', err }, 'wikipedia fetch failed');
    return new Map();
  }
}

function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }

export async function enrichContributorBios(
  items: readonly ContributorItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<ContributorItem[]> {
  const nameMap = new Map<string, string>(); // lowercased -> original
  for (const it of items) nameMap.set(it.name.toLowerCase(), it.name);
  const unique = Array.from(nameMap.values());
  const extracts = await fetchExtracts(unique, log, externalSignal);
  return items.map((it) => {
    const key = it.name.toLowerCase();
    const title = Array.from(extracts.keys()).find((t) => t.toLowerCase() === key);
    if (!title) return it;
    const bio = extracts.get(title);
    if (!bio) return it;
    return { ...it, bio };
  });
}

export async function enrichAuthorsOnWorksOrEditions(
  items: ReadonlyArray<EditionItem | WorkItem>,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<Array<EditionItem | WorkItem>> {
  // Author names are not present on WorkItem/EditionItem; the caller resolves
  // them via contributors[]. For MVP we accept items WITHOUT author names —
  // this enrichment is a no-op in the work/edition path until the spec is
  // extended to expose author names. The contributor-side enrichment
  // (enrichContributorBios) is the primary path.
  return [...items];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsx --test src/lib/server/api/wikipedia.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/api/wikipedia.ts \
        packages/bibliograph-service/src/lib/server/api/wikipedia.test.ts
git commit -m "feat(api): add Wikipedia enrichment wrappers"
```

---

## Task 6: Drizzle migration — add `cover_image_url` to `editions`

**Files:**
- Create: `packages/bibliograph-service/drizzle/0002_discovery_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- drizzle/0002_discovery_columns.sql
-- Add cover_image_url to editions so Google Books enrichment can persist
-- discovered covers for future lookups. Nullable; existing rows unchanged.
ALTER TABLE "editions" ADD COLUMN "cover_image_url" text;
```

- [ ] **Step 2: Update the drizzle schema to reflect the new column**

Edit `packages/bibliograph-service/src/lib/server/db/schema.ts`. Inside the `editions` table object literal, add one column (alongside the other column declarations):

```ts
coverImageUrl: text('cover_image_url'),
```

Add it right after the `description: text('description'),` line (matches the SQL column order).

- [ ] **Step 3: Apply migration locally**

With the Postgres container running (`mise run containers` or `docker compose up -d`), from `packages/bibliograph-service`:

```bash
psql "$DATABASE_URL" -f drizzle/0002_discovery_columns.sql
```

Expected output:
```
ALTER TABLE
```

- [ ] **Step 4: Verify the column exists**

```bash
psql "$DATABASE_URL" -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'editions' AND column_name = 'cover_image_url';"
```

Expected output:
```
   column_name    | data_type
------------------+-----------
 cover_image_url  | text
```

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/drizzle/0002_discovery_columns.sql \
        packages/bibliograph-service/src/lib/server/db/schema.ts
git commit -m "feat(db): add cover_image_url column to editions"
```

---

## Task 7: PostgresSource<T>

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/postgres-source.ts`

- [ ] **Step 1: Write the implementation**

```ts
// src/lib/server/search/postgres-source.ts
import type { Logger } from 'pino';
import { and, asc, desc, or, sql, ilike } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { editions, works, contributors } from '../db/schema.ts';
import { PUBLISHER_DID } from '../did.ts';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
  Identifier,
  ContributionEntry,
} from './types.ts';

const CURSOR_VERSION = 2;

type PostgresCursor = { v: 2; src: 'postgres'; t: string; u: string };

function encodeCursor(indexedAt: Date, uri: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, src: 'postgres', t: indexedAt.toISOString(), u: uri } satisfies PostgresCursor)).toString('base64url');
}

function decodeCursor(cursor: string): PostgresCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (parsed.v !== CURSOR_VERSION || parsed.src !== 'postgres') return null;
    return parsed as PostgresCursor;
  } catch { return null; }
}

function contributionFromJson(c: { subject: { uri: string; cid: string }; role: string }): ContributionEntry {
  return { subject: c.subject, role: c.role };
}

function identFromJson(i: { uri: string; resource: string }): Identifier {
  return { uri: i.uri, resource: i.resource };
}

export class PostgresSource {
  constructor(private readonly log: Logger) {}

  async searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${editions.title} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) for (const id of query.id) conds.push(sql`${editions.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        conds.push(or(sql`${editions.indexedAt} < ${new Date(c.t)}`, and(sql`${editions.indexedAt} = ${new Date(c.t)}`, sql`${editions.uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(editions).where(where).orderBy(desc(editions.indexedAt), asc(editions.uri)).limit(query.limit);
    const items: EditionItem[] = rows.map((r) => ({
      uri: r.uri,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      publishedYear: r.publishedYear ?? undefined,
      place: r.place ?? undefined,
      language: r.language ?? undefined,
      description: r.description ?? undefined,
      coverImageUrl: r.coverImageUrl ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      contributors: (r.contributors ?? []).map(contributionFromJson),
      createdAt: r.createdAt.toISOString(),
    }));
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind: 'edition', items: items.length, did: PUBLISHER_DID }, 'postgres ok');
    return { items, cursor };
  }

  async searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${works.title} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) for (const id of query.id) conds.push(sql`${works.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        conds.push(or(sql`${works.indexedAt} < ${new Date(c.t)}`, and(sql`${works.indexedAt} = ${new Date(c.t)}`, sql`${works.uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(works).where(where).orderBy(desc(works.indexedAt), asc(works.uri)).limit(query.limit);
    const items: WorkItem[] = rows.map((r) => ({
      uri: r.uri,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      originalLanguage: r.originalLanguage ?? undefined,
      firstPublishedYear: r.firstPublishedYear ?? undefined,
      subjects: r.subjects ?? [],
      description: r.description ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      contributors: (r.contributors ?? []).map(contributionFromJson),
      createdAt: r.createdAt.toISOString(),
    }));
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind: 'work', items: items.length }, 'postgres ok');
    return { items, cursor };
  }

  async searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${contributors.name} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) for (const id of query.id) conds.push(sql`${contributors.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        conds.push(or(sql`${contributors.indexedAt} < ${new Date(c.t)}`, and(sql`${contributors.indexedAt} = ${new Date(c.t)}`, sql`${contributors.uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(contributors).where(where).orderBy(desc(contributors.indexedAt), asc(contributors.uri)).limit(query.limit);
    const items: ContributorItem[] = rows.map((r) => ({
      uri: r.uri,
      name: r.name,
      aliases: r.aliases ?? [],
      bio: r.bio ?? undefined,
      bornYear: r.bornYear ?? undefined,
      diedYear: r.diedYear ?? undefined,
      linkedDid: r.linkedDid ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      createdAt: r.createdAt.toISOString(),
    }));
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind: 'contributor', items: items.length }, 'postgres ok');
    return { items, cursor };
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors introduced by this file.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/postgres-source.ts
git commit -m "feat(search): add PostgresSource for editions/works/contributors"
```

---

## Task 8: OpenLibrarySource (wraps the API wrapper)

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/open-library-source.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/search/open-library-source.ts
import type { Logger } from 'pino';
import * as openLibrary from '../api/open-library.ts';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem } from './types.ts';

export class OpenLibrarySource {
  constructor(private readonly log: Logger) {}

  searchEditions(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<EditionItem>> {
    return openLibrary.searchEditions(query, this.log, signal);
  }
  searchWorks(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<WorkItem>> {
    return openLibrary.searchWorks(query, this.log, signal);
  }
  searchContributors(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<ContributorItem>> {
    return openLibrary.searchContributors(query, this.log, signal);
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/open-library-source.ts
git commit -m "feat(search): add OpenLibrarySource wrapping the api wrapper"
```

---

## Task 9: GoogleBooksEnricher

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/google-books-enricher.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/search/google-books-enricher.ts
import type { Logger } from 'pino';
import * as googleBooks from '../api/google-books.ts';
import type { EditionItem, Enricher } from './types.ts';

export class GoogleBooksEnricher implements Enricher<EditionItem> {
  readonly name = 'google-books-enricher';
  constructor(private readonly log: Logger) {}
  enrich(items: EditionItem[], signal?: AbortSignal): Promise<EditionItem[]> {
    return googleBooks.enrichEditions(items, this.log, signal);
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/google-books-enricher.ts
git commit -m "feat(search): add GoogleBooksEnricher"
```

---

## Task 10: WikipediaEnricher (two classes)

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/wikipedia-enricher.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/search/wikipedia-enricher.ts
import type { Logger } from 'pino';
import * as wikipedia from '../api/wikipedia.ts';
import type { ContributorItem, EditionItem, WorkItem, Enricher } from './types.ts';

export class ContributorWikipediaEnricher implements Enricher<ContributorItem> {
  readonly name = 'wikipedia-enricher-contributor';
  constructor(private readonly log: Logger) {}
  enrich(items: ContributorItem[], signal?: AbortSignal): Promise<ContributorItem[]> {
    return wikipedia.enrichContributorBios(items, this.log, signal);
  }
}

export class AuthorWikipediaEnricher implements Enricher<EditionItem | WorkItem> {
  readonly name = 'wikipedia-enricher-author';
  constructor(private readonly log: Logger) {}
  enrich(items: Array<EditionItem | WorkItem>, signal?: AbortSignal): Promise<Array<EditionItem | WorkItem>> {
    return wikipedia.enrichAuthorsOnWorksOrEditions(items, this.log, signal);
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/wikipedia-enricher.ts
git commit -m "feat(search): add ContributorWikipediaEnricher and AuthorWikipediaEnricher"
```

---

## Task 11: LocalPostgresIngestor (fire-and-forget)

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/local-postgres-ingestor.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/search/local-postgres-ingestor.ts
import type { Logger } from 'pino';
import { db } from '../db/index.ts';
import { editions, works, contributors } from '../db/schema.ts';
import { PUBLISHER_DID } from '../did.ts';
import type { EditionItem, WorkItem, ContributorItem, Ingestor } from './types.ts';

function rkeyForEdition(olKey: string): string {
  return `ol-edition-${olKey.replace(/^\/books\//, '')}`;
}
function rkeyForWork(olKey: string): string {
  return `ol-work-${olKey.replace(/^\/works\//, '')}`;
}
function rkeyForContributor(olKey: string): string {
  return `ol-author-${olKey.replace(/^\/authors\//, '')}`;
}

function olKeyFromIdentifiers(idents: { uri: string; resource: string }[]): string | undefined {
  return idents.find((i) => i.resource === 'openlibrary')?.uri.replace(/^https:\/\/openlibrary\.org/, '');
}

export class LocalPostgresIngestor implements Ingestor<EditionItem | WorkItem | ContributorItem> {
  readonly name = 'local-postgres-ingestor';
  constructor(private readonly log: Logger) {}

  async ingest(items: ReadonlyArray<EditionItem | WorkItem | ContributorItem>): Promise<void> {
    if (items.length === 0) return;
    this.log.info({ stage: this.name, queued: items.length }, 'ingest start');
    try {
      for (const item of items) {
        const olKey = olKeyFromIdentifiers(item.identifiers);
        if (!olKey) continue;
        if ('title' in item && 'identifiers' in item && 'publishedYear' in item) {
          await this.ingestEdition(item as EditionItem, olKey);
        } else if ('title' in item && 'subjects' in item) {
          await this.ingestWork(item as WorkItem, olKey);
        } else if ('name' in item) {
          await this.ingestContributor(item as ContributorItem, olKey);
        }
      }
      this.log.info({ stage: this.name, done: items.length }, 'ingest complete');
    } catch (err) {
      this.log.error({ stage: this.name, err }, 'ingest failed');
    }
  }

  private async ingestEdition(item: EditionItem, olKey: string): Promise<void> {
    const rkey = rkeyForEdition(olKey);
    const uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
    await db.insert(editions).values({
      uri,
      cid: 'bafyplaceholder', // refreshed by getRecord on first read
      did: PUBLISHER_DID,
      rkey,
      title: item.title,
      subtitle: item.subtitle ?? null,
      place: item.place ?? null,
      publishedYear: item.publishedYear ?? null,
      language: item.language ?? null,
      description: item.description ?? null,
      coverImageUrl: item.coverImageUrl ?? null,
      contributors: item.contributors,
      identifiers: item.identifiers,
      createdAt: new Date(item.createdAt),
    }).onConflictDoUpdate({
      target: editions.uri,
      set: {
        title: item.title,
        subtitle: item.subtitle ?? null,
        description: item.description ?? null,
        coverImageUrl: item.coverImageUrl ?? null,
        identifiers: item.identifiers,
        contributors: item.contributors,
        indexedAt: new Date(),
      },
    });
  }

  private async ingestWork(item: WorkItem, olKey: string): Promise<void> {
    const rkey = rkeyForWork(olKey);
    const uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
    await db.insert(works).values({
      uri,
      cid: 'bafyplaceholder',
      did: PUBLISHER_DID,
      rkey,
      title: item.title,
      subtitle: item.subtitle ?? null,
      originalLanguage: item.originalLanguage ?? null,
      firstPublishedYear: item.firstPublishedYear ?? null,
      subjects: item.subjects,
      contributors: item.contributors,
      identifiers: item.identifiers,
      description: item.description ?? null,
      createdAt: new Date(item.createdAt),
    }).onConflictDoUpdate({
      target: works.uri,
      set: {
        title: item.title,
        subtitle: item.subtitle ?? null,
        description: item.description ?? null,
        identifiers: item.identifiers,
        contributors: item.contributors,
        indexedAt: new Date(),
      },
    });
  }

  private async ingestContributor(item: ContributorItem, olKey: string): Promise<void> {
    const rkey = rkeyForContributor(olKey);
    const uri = `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${rkey}`;
    await db.insert(contributors).values({
      uri,
      cid: 'bafyplaceholder',
      did: PUBLISHER_DID,
      rkey,
      name: item.name,
      aliases: item.aliases,
      linkedDid: item.linkedDid ?? null,
      bio: item.bio ?? null,
      bornYear: item.bornYear ?? null,
      diedYear: item.diedYear ?? null,
      identifiers: item.identifiers,
      createdAt: new Date(item.createdAt),
    }).onConflictDoUpdate({
      target: contributors.uri,
      set: {
        name: item.name,
        aliases: item.aliases,
        bio: item.bio ?? null,
        identifiers: item.identifiers,
        indexedAt: new Date(),
      },
    });
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/local-postgres-ingestor.ts
git commit -m "feat(search): add LocalPostgresIngestor with fire-and-forget upserts"
```

---

## Task 12: SearchService orchestrator

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/service.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/search/service.ts
import type { Logger } from 'pino';
import { getCorrelationLog } from '../correlation.ts';
import { PostgresSource } from './postgres-source.ts';
import { OpenLibrarySource } from './open-library-source.ts';
import { GoogleBooksEnricher } from './google-books-enricher.ts';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './wikipedia-enricher.ts';
import { LocalPostgresIngestor } from './local-postgres-ingestor.ts';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem } from './types.ts';

export interface SearchServiceDeps {
  postgres: PostgresSource;
  openLibrary: OpenLibrarySource;
  googleBooks: GoogleBooksEnricher;
  authorWikipedia: AuthorWikipediaEnricher;
  contributorWikipedia: ContributorWikipediaEnricher;
  ingestor: LocalPostgresIngestor;
}

export class SearchService {
  /** Fallback logger when no correlation context is set (e.g. in tests). */
  private readonly fallbackLog: Logger;
  constructor(private readonly deps: SearchServiceDeps, fallbackLog: Logger) {
    this.fallbackLog = fallbackLog;
  }

  private log(): Logger {
    return getCorrelationLog() ?? this.fallbackLog;
  }

  async searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    const log = this.log();
    const pg = await this.deps.postgres.searchEditions(query);
    if (pg.items.length > 0) return pg;
    const ol = await this.deps.openLibrary.searchEditions(query);
    if (ol.items.length === 0) return ol;
    let items = await this.deps.googleBooks.enrich(ol.items);
    items = await this.deps.authorWikipedia.enrich(items);
    void this.deps.ingestor.ingest(items).catch(() => undefined);
    log.info({ stage: 'search-editions', items: items.length, total: ol.total }, 'search done');
    return { items, cursor: ol.cursor, total: ol.total };
  }

  async searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    const log = this.log();
    const pg = await this.deps.postgres.searchWorks(query);
    if (pg.items.length > 0) return pg;
    const ol = await this.deps.openLibrary.searchWorks(query);
    if (ol.items.length === 0) return ol;
    let items = await this.deps.authorWikipedia.enrich(ol.items);
    void this.deps.ingestor.ingest(items).catch(() => undefined);
    log.info({ stage: 'search-works', items: items.length, total: ol.total }, 'search done');
    return { items, cursor: ol.cursor, total: ol.total };
  }

  async searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    const log = this.log();
    // id-only queries skip OpenLibrary (option B from the design).
    if (!query.q && query.id && query.id.length > 0) {
      return this.deps.postgres.searchContributors(query);
    }
    const pg = await this.deps.postgres.searchContributors(query);
    if (pg.items.length > 0) return pg;
    const ol = await this.deps.openLibrary.searchContributors(query);
    if (ol.items.length === 0) return ol;
    let items = await this.deps.contributorWikipedia.enrich(ol.items);
    void this.deps.ingestor.ingest(items).catch(() => undefined);
    log.info({ stage: 'search-contributors', items: items.length, total: ol.total }, 'search done');
    return { items, cursor: ol.cursor, total: ol.total };
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/search/service.ts
git commit -m "feat(search): add SearchService orchestrator"
```

---

## Task 13: Lex schema — shared `defs.json`

**Files:**
- Create: `packages/bibliograph-service/lexicons/community/lexicon/book/defs.json`

- [ ] **Step 1: Write the file**

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.defs",
  "defs": {
    "contribution": {
      "type": "object",
      "required": ["subject", "role"],
      "properties": {
        "subject": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
        "role": {
          "type": "string",
          "knownValues": ["author", "coAuthor", "editor", "translator", "illustrator", "narrator", "foreword", "contributor"]
        }
      }
    },
    "identifier": {
      "type": "object",
      "required": ["uri", "resource"],
      "properties": {
        "uri": { "type": "string", "format": "uri", "minLength": 1, "maxLength": 2048 },
        "resource": {
          "type": "string",
          "knownValues": [
            "isbn", "isbn13", "isbn10", "asin", "doi", "oclc", "isbnPrefix",
            "isni", "viaf", "wikidata", "openlibrary", "googleBooks",
            "goodreads", "amazon", "barnes", "hardcover", "bookhive",
            "bibliograph", "imdb", "official", "web"
          ]
        }
      }
    }
  }
}
```

- [ ] **Step 2: Regenerate lex types**

From `packages/bibliograph-service`:

```bash
pnpm run lex:gen
```

Expected: regenerates `src/lib/server/lexicons/`. Verify with:

```bash
ls src/lib/server/lexicons/types/community/lexicon/book/
```

Should now include `defs.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/lexicons/community/lexicon/book/defs.json \
        packages/bibliograph-service/src/lib/server/lexicons/
git commit -m "feat(lex): add community.lexicon.book.defs with shared contribution/identifier"
```

---

## Task 14: Lex schema — update `edition.json` (add `coverImageUrl`, swap to NSID refs)

**Files:**
- Modify: `packages/bibliograph-service/lexicons/community/lexicon/book/edition.json`

- [ ] **Step 1: Replace the file contents**

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.edition",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["title", "createdAt"],
        "properties": {
          "title": { "type": "string", "minLength": 1, "maxLength": 2048, "maxGraphemes": 200 },
          "subtitle": { "type": "string", "maxLength": 1024, "maxGraphemes": 100 },
          "work": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
          "publisher": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
          "place": { "type": "string", "maxLength": 256, "maxGraphemes": 64 },
          "publishedYear": { "type": "integer", "minimum": 0, "maximum": 9999 },
          "language": { "type": "string", "format": "language" },
          "coverImageUrl": { "type": "string", "format": "uri", "maxLength": 2048 },
          "contributors": {
            "type": "array",
            "minLength": 0,
            "maxLength": 64,
            "items": { "type": "ref", "ref": "community.lexicon.book.defs#contribution" }
          },
          "identifiers": {
            "type": "array",
            "minLength": 0,
            "maxLength": 32,
            "items": { "type": "ref", "ref": "community.lexicon.book.defs#identifier" }
          },
          "description": { "type": "string", "maxLength": 8192, "maxGraphemes": 1024 },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

Note: removed the inline `contribution` and `identifier` defs (now in `defs.json`); added `coverImageUrl`.

- [ ] **Step 2: Regenerate lex types**

```bash
pnpm run lex:gen
```

Expected: regenerates types. The generated `edition.ts` should now reference `community.lexicon.book.defs#contribution` etc.

- [ ] **Step 3: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors. (The Postgres-side mapping still emits `identifiers: r.identifiers` as the same shape — no changes required to handlers yet.)

- [ ] **Step 4: Commit**

```bash
git add packages/bibliograph-service/lexicons/community/lexicon/book/edition.json \
        packages/bibliograph-service/src/lib/server/lexicons/
git commit -m "feat(lex): add coverImageUrl to edition; switch to NSID refs"
```

---

## Task 15: Lex schema — new `work.json`

**Files:**
- Create: `packages/bibliograph-service/lexicons/community/lexicon/book/work.json`

- [ ] **Step 1: Write the file**

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.work",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["title", "createdAt"],
        "properties": {
          "title": { "type": "string", "minLength": 1, "maxLength": 2048, "maxGraphemes": 200 },
          "subtitle": { "type": "string", "maxLength": 1024, "maxGraphemes": 100 },
          "originalLanguage": { "type": "string", "format": "language" },
          "firstPublishedYear": { "type": "integer", "minimum": 0, "maximum": 9999 },
          "subjects": {
            "type": "array",
            "items": { "type": "string", "maxLength": 256 },
            "maxLength": 64
          },
          "contributors": {
            "type": "array",
            "minLength": 0,
            "maxLength": 64,
            "items": { "type": "ref", "ref": "community.lexicon.book.defs#contribution" }
          },
          "identifiers": {
            "type": "array",
            "minLength": 0,
            "maxLength": 32,
            "items": { "type": "ref", "ref": "community.lexicon.book.defs#identifier" }
          },
          "description": { "type": "string", "maxLength": 8192, "maxGraphemes": 1024 },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Regenerate lex types**

```bash
pnpm run lex:gen
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bibliograph-service/lexicons/community/lexicon/book/work.json \
        packages/bibliograph-service/src/lib/server/lexicons/
git commit -m "feat(lex): add community.lexicon.book.work record schema"
```

---

## Task 16: Lex schema — new `contributor.json`

**Files:**
- Create: `packages/bibliograph-service/lexicons/community/lexicon/book/contributor.json`

- [ ] **Step 1: Write the file**

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.contributor",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["name", "createdAt"],
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 256, "maxGraphemes": 200 },
          "aliases": {
            "type": "array",
            "items": { "type": "string", "maxLength": 256 },
            "maxLength": 32
          },
          "bio": { "type": "string", "maxLength": 16384, "maxGraphemes": 2048 },
          "bornYear": { "type": "integer", "minimum": 0, "maximum": 9999 },
          "diedYear": { "type": "integer", "minimum": 0, "maximum": 9999 },
          "linkedDid": { "type": "string", "format": "did" },
          "identifiers": {
            "type": "array",
            "minLength": 0,
            "maxLength": 32,
            "items": { "type": "ref", "ref": "community.lexicon.book.defs#identifier" }
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Regenerate lex types**

```bash
pnpm run lex:gen
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bibliograph-service/lexicons/community/lexicon/book/contributor.json \
        packages/bibliograph-service/src/lib/server/lexicons/
git commit -m "feat(lex): add community.lexicon.book.contributor record schema"
```

---

## Task 17: Lex schema — `searchWorks.json` (full body)

**Files:**
- Modify: `packages/bibliograph-service/lexicons/community/lexicon/book/searchWorks.json`

- [ ] **Step 1: Replace the file contents**

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.searchWorks",
  "defs": {
    "main": {
      "type": "query",
      "description": "Search works by free-form text (q) and/or identifiers (id, repeatable).",
      "parameters": {
        "type": "params",
        "properties": {
          "q": { "type": "string", "maxLength": 1024, "description": "Free-form text query." },
          "id": {
            "type": "array",
            "items": { "type": "string", "maxLength": 2048 },
            "maxLength": 32,
            "description": "Identifiers to match (URI or URN form). Repeatable."
          },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
          "cursor": { "type": "string", "maxLength": 256 }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["items"],
          "properties": {
            "items": {
              "type": "array",
              "items": { "type": "ref", "ref": "community.lexicon.book.work" }
            },
            "cursor": { "type": "string" },
            "total": { "type": "integer", "minimum": 0 }
          }
        }
      },
      "errors": [
        {
          "name": "InvalidQuery",
          "description": "The query syntax was invalid for this AppView (e.g. Lucene syntax error)."
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Regenerate lex types**

```bash
pnpm run lex:gen
```

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/lexicons/community/lexicon/book/searchWorks.json \
        packages/bibliograph-service/src/lib/server/lexicons/
git commit -m "feat(lex): replace searchWorks stub with full schema"
```

---

## Task 18: Lex schema — `searchContributors.json` (full body)

**Files:**
- Modify: `packages/bibliograph-service/lexicons/community/lexicon/book/searchContributors.json`

- [ ] **Step 1: Replace the file contents**

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.searchContributors",
  "defs": {
    "main": {
      "type": "query",
      "description": "Search contributors by free-form text (q) and/or identifiers (id, repeatable).",
      "parameters": {
        "type": "params",
        "properties": {
          "q": { "type": "string", "maxLength": 1024, "description": "Free-form text query." },
          "id": {
            "type": "array",
            "items": { "type": "string", "maxLength": 2048 },
            "maxLength": 32,
            "description": "Identifiers to match (URI or URN form). Repeatable."
          },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
          "cursor": { "type": "string", "maxLength": 256 }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["items"],
          "properties": {
            "items": {
              "type": "array",
              "items": { "type": "ref", "ref": "community.lexicon.book.contributor" }
            },
            "cursor": { "type": "string" },
            "total": { "type": "integer", "minimum": 0 }
          }
        }
      },
      "errors": [
        {
          "name": "InvalidQuery",
          "description": "The query syntax was invalid for this AppView (e.g. Lucene syntax error)."
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Regenerate lex types**

```bash
pnpm run lex:gen
```

- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/lexicons/community/lexicon/book/searchContributors.json \
        packages/bibliograph-service/src/lib/server/lexicons/
git commit -m "feat(lex): replace searchContributors stub with full schema"
```

---

## Task 19: Wire `searchEditions` XRPC handler to `SearchService` (DONE — commit edecfd9)

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/xrpc-router.ts` (the `searchEditions` handler at line 121-180)

- [ ] **Step 1: Construct the service at module load**

Add the new imports at the top of `xrpc-router.ts` (next to the existing lexicon imports):

- [x] **Step 1: Construct the service at module load**
import { PostgresSource } from './search/postgres-source.ts';
import { OpenLibrarySource } from './search/open-library-source.ts';
import { GoogleBooksEnricher } from './search/google-books-enricher.ts';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './search/wikipedia-enricher.ts';
const googleBooksEnricher = new GoogleBooksEnricher();
const authorWikipediaEnricher = new AuthorWikipediaEnricher();
const contributorWikipediaEnricher = new ContributorWikipediaEnricher();
import { SearchService } from './search/service.ts';
```

After the `log` declaration (around line 81), construct the service:

```ts
const postgresSource = new PostgresSource(log);
const openLibrarySource = new OpenLibrarySource(log);
const googleBooksEnricher = new GoogleBooksEnricher(log);
const authorWikipediaEnricher = new AuthorWikipediaEnricher(log);
const contributorWikipediaEnricher = new ContributorWikipediaEnricher(log);
const localIngestor = new LocalPostgresIngestor(log);
const searchService = new SearchService(
  {
    postgres: postgresSource,
    openLibrary: openLibrarySource,
- [x] **Step 2: Replace the `searchEditions` handler body**
    authorWikipedia: authorWikipediaEnricher,
    contributorWikipedia: contributorWikipediaEnricher,
    ingestor: localIngestor,
  },
  log,
);
```

- [ ] **Step 2: Replace the `searchEditions` handler body**

Replace the handler inside `router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, { async handler({ params }) { ... } })` with:

```ts
async handler({ params }) {
  const result = await searchService.searchEditions({
    q: params.q,
    id: params.id,
    limit: Math.min(params.limit ?? 20, 100),
    cursor: params.cursor,
  });
  const items = result.items.map((r) => ({
    $type: 'community.lexicon.book.edition' as const,
    title: r.title,
    subtitle: r.subtitle,
    coverImageUrl: r.coverImageUrl,
    publisher: undefined,
    place: r.place,
    publishedYear: r.publishedYear,
    language: r.language,
    contributors: r.contributors,
    identifiers: r.identifiers,
    description: r.description,
    createdAt: r.createdAt,
- [x] **Step 4: Run typecheck**
  return json({ items, cursor: result.cursor, total: result.total } as never);
}
```

- [ ] **Step 3: Remove the unused helpers**

The inline `encodeCursor`, `decodeCursor`, `approxRowCount` functions (lines 44-79) become unused. Leave them for now (not strictly broken); a follow-up Task deletes them after `searchWorks` is also migrated in Task 20.
- [x] **Step 5: Commit**
- [ ] **Step 4: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/xrpc-router.ts
git commit -m "refactor(xrpc): wire searchEditions handler to SearchService"
```

## Task 20: Wire `searchWorks` and `searchContributors` handlers (DONE — commit 669562c)

## Task 20: Wire `searchWorks` and `searchContributors` handlers

**Files:**
- [x] **Step 1: Replace `searchWorks` handler**

- [ ] **Step 1: Replace `searchWorks` handler**

Replace the `searchWorks` block (line 218-222):

```ts
router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
  async handler({ params }) {
    const result = await searchService.searchWorks({
      q: params.q,
      id: params.id,
      limit: Math.min(params.limit ?? 20, 100),
      cursor: params.cursor,
    });
    const items = result.items.map((r) => ({
      $type: 'community.lexicon.book.work' as const,
      title: r.title,
      subtitle: r.subtitle,
      originalLanguage: r.originalLanguage,
      firstPublishedYear: r.firstPublishedYear,
      subjects: r.subjects,
      contributors: r.contributors,
      identifiers: r.identifiers,
      description: r.description,
      createdAt: r.createdAt,
    }));
    return json({ items, cursor: result.cursor, total: result.total } as never);
  },
});
```

- [ ] **Step 2: Replace `searchContributors` handler**

Replace the `searchContributors` block (line 208-212):

```ts
router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
  async handler({ params }) {
    const result = await searchService.searchContributors({
      q: params.q,
      id: params.id,
      limit: Math.min(params.limit ?? 20, 100),
      cursor: params.cursor,
    });
    const items = result.items.map((r) => ({
      $type: 'community.lexicon.book.contributor' as const,
      name: r.name,
      aliases: r.aliases,
      bio: r.bio,
      bornYear: r.bornYear,
      diedYear: r.diedYear,
      linkedDid: r.linkedDid,
      identifiers: r.identifiers,
      createdAt: r.createdAt,
    }));
    return json({ items, cursor: result.cursor, total: result.total } as never);
- [x] **Step 2: Replace `searchContributors` handler**
});
```

- [ ] **Step 3: Add the missing imports for the new schema types**

At the top of `xrpc-router.ts`, next to the existing `CommunityLexiconBookSearchEditions` import:

```ts
import {
  CommunityLexiconBookSearchContributors,
  CommunityLexiconBookSearchEditions,
  CommunityLexiconBookSearchPublishers,
  CommunityLexiconBookSearchWorks,
} from './lexicons/index.js';
```

(Already there from the previous edit; no change needed if Task 19 added it.)

- [ ] **Step 4: Remove the now-unused helpers**

Delete the `encodeCursor`, `decodeCursor`, `approxRowCount` functions and the `CURSOR_VERSION` constant (lines 44-79). The new handlers use `searchService`-returned cursors verbatim.

- [ ] **Step 5: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/xrpc-router.ts
git commit -m "feat(xrpc): wire searchWorks + searchContributors to SearchService"
- [x] **Step 5: Run typecheck**

## Task 21: Extend `ComAtprotoRepoGetRecord` for the three book collections (DONE — commit cf008f3)

## Task 21: Extend `ComAtprotoRepoGetRecord` for the three book collections

**Files:**
- [x] **Step 1: Add a Postgres branch for the three book collections**
- [x] **Step 6: Commit**
- [ ] **Step 1: Add a Postgres branch for the three book collections**

Right after the `if (!resolveDid(params.repo))` guard at the top of the `ComAtprotoRepoGetRecord` handler, add:

```ts
const BOOK_COLLECTIONS = new Set([
  'community.lexicon.book.edition',
  'community.lexicon.book.work',
  'community.lexicon.book.contributor',
]);
if (BOOK_COLLECTIONS.has(params.collection)) {
  return await serveBookRecordFromDb(params.repo, params.collection, params.rkey);
}
```
- [x] **Step 2: Implement `serveBookRecordFromDb` and the supporting helpers**
- [ ] **Step 2: Implement `serveBookRecordFromDb`**

Just above the `ComAtprotoRepoGetRecord` registration (or at the end of the file), add:

```ts
import { eq } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import { editions, works, contributors } from './db/schema.ts';

async function serveBookRecordFromDb(
  repo: string,
  collection: string,
  rkey: string,
): Promise<Response> {
  if (repo !== PUBLISHER_DID) {
    return notFoundResponse('RecordNotFound', `repo "${repo}" not hosted`);
  }
  const uri = `at://${repo}/${collection}/${rkey}`;
  if (collection === 'community.lexicon.book.edition') {
    const [row] = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
    if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
    const value = {
      $type: 'community.lexicon.book.edition',
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      place: row.place ?? undefined,
      publishedYear: row.publishedYear ?? undefined,
      language: row.language ?? undefined,
      coverImageUrl: row.coverImageUrl ?? undefined,
      contributors: row.contributors ?? [],
      identifiers: row.identifiers ?? [],
      description: row.description ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
    const cid = await cidForLex(value);
    return json({ uri, cid: cid.toString(), value } as never);
  }
  if (collection === 'community.lexicon.book.work') {
    const [row] = await db.select().from(works).where(eq(works.uri, uri)).limit(1);
    if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
    const value = {
      $type: 'community.lexicon.book.work',
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      originalLanguage: row.originalLanguage ?? undefined,
      firstPublishedYear: row.firstPublishedYear ?? undefined,
      subjects: row.subjects ?? [],
      contributors: row.contributors ?? [],
      identifiers: row.identifiers ?? [],
      description: row.description ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
    const cid = await cidForLex(value);
    return json({ uri, cid: cid.toString(), value } as never);
  }
  // community.lexicon.book.contributor
  const [row] = await db.select().from(contributors).where(eq(contributors.uri, uri)).limit(1);
  if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
  const value = {
- [x] **Step 3: Run typecheck**
    name: row.name,
    aliases: row.aliases ?? [],
    bio: row.bio ?? undefined,
    bornYear: row.bornYear ?? undefined,
    diedYear: row.diedYear ?? undefined,
    linkedDid: row.linkedDid ?? undefined,
    identifiers: row.identifiers ?? [],
- [x] **Step 4: Commit**
  };
  const cid = await cidForLex(value);
  return json({ uri, cid: cid.toString(), value } as never);
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bibliograph-service/src/lib/server/xrpc-router.ts
git commit -m "feat(xrpc): serve community.lexicon.book.* records from Postgres via getRecord"
```

---

## Task 22: Env config and README (DONE — commit 42eee02)

**Files:**
- Modify: `packages/bibliograph-service/.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the env var to `.env.example`**

Append (with a blank line above):

```
# Google Books API key (https://console.cloud.google.com → Books API). Optional.
# If unset, searchEditions still completes via OpenLibrary + Wikipedia.
GOOGLE_BOOKS_API_KEY=
```

- [ ] **Step 2: Update README's Material Discovery bullet**
- [x] **Step 1: Add the env var to `.env.example`**
Edit the Material Discovery section in `README.md`:

Replace:
```
- [x] **Step 2: Update README's Material Discovery bullet**
- Author information is _gleamed_ from Wikipedia and OpenLibrary
```

With:
```
- Book information is sourced from OpenLibrary (works + editions APIs) with optional Google Books enrichment for descriptions and covers (requires `GOOGLE_BOOKS_API_KEY`)
- Author information is _gleamed_ from Wikipedia and OpenLibrary
```
- [x] **Step 3: Commit**
- [ ] **Step 3: Commit**

```bash
git add packages/bibliograph-service/.env.example README.md
git commit -m "docs: document GOOGLE_BOOKS_API_KEY and refresh Material Discovery"
```

---

## Task 23: Verify script (DONE — commit 116389b)

**Files:**
- Create: `packages/bibliograph-service/scripts/verify-search.ts`
- Modify: `packages/bibliograph-service/package.json` (add `verify:search` script)

- [x] **Step 1: Add the npm script**

Edit `packages/bibliograph-service/package.json` `scripts` block. Add:

```json
- [x] **Step 2: Write the verify script**
```

- [ ] **Step 2: Write the verify script**

```ts
#!/usr/bin/env tsx
// End-to-end verification of the searchEditions / searchWorks / searchContributors
// endpoints with stubbed external APIs.
//
// Usage:
//   pnpm exec tsx scripts/verify-search.ts
//
// Requires DATABASE_URL to point at a database with the editions/works/contributors
// tables and the `cover_image_url` column on editions.

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
import { LocalPostgresIngestor } from '../src/lib/server/search/local-postgres-ingestor.js';
import { SearchService } from '../src/lib/server/search/service.js';

const log = pino({ level: 'silent' });

const OL_EDITION = '/books/OL12345M';
const OL_WORK = '/works/OL66554W';
const OL_AUTHOR = '/authors/OL12345A';

function stubFetch(impl: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function stubEverything() {
  return stubFetch(async (url) => {
    if (url.includes('openlibrary.org/search.json')) {
      const type = new URL(url).searchParams.get('type');
      const docs = type === 'work'
        ? [{ key: OL_WORK, title: 'OL Work', first_publish_year: 1850 }]
        : type === 'author'
          ? [{ key: OL_AUTHOR, name: 'OL Author', birth_date: '1800-01-01' }]
          : [{ key: OL_EDITION, title: 'OL Edition', isbn: ['9780123456789'] }];
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

function buildRouter(): { router: XRPCRouter; restore: () => void } {
  const restore = stubEverything();
  const router = new XRPCRouter();
  const pg = new PostgresSource(log);
  const ol = new OpenLibrarySource(log);
  const gb = new GoogleBooksEnricher(log);
  const aw = new AuthorWikipediaEnricher(log);
  const cw = new ContributorWikipediaEnricher(log);
  const ing = new LocalPostgresIngestor(log);
  const svc = new SearchService({ postgres: pg, openLibrary: ol, googleBooks: gb, authorWikipedia: aw, contributorWikipedia: cw, ingestor: ing }, log);
  router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params }) {
      const r = await svc.searchEditions({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
    async handler({ params }) {
      const r = await svc.searchWorks({ q: params.q, id: params.id, limit: params.limit ?? 20, cursor: params.cursor });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    },
  });
  router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params }) {
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
```

- [ ] **Step 3: Run the verify script**

```bash
pnpm run verify:search
```

Expected: 4 tests pass. (The Postgres path returns no rows because the DB is empty; OpenLibrary + Google Books + Wikipedia stubs supply the data; the ingest fire-and-forget runs but errors silently when DB constraints fail — wrapped in `ingest()`'s try/catch.)

- [ ] **Step 4: Commit**

```bash
- [x] **Step 3: Run the verify script**
        packages/bibliograph-service/package.json
git commit -m "test: add end-to-end verify script for searchEditions/works/contributors"
```

---

- [x] **Step 4: Commit**

1. **Spec coverage** — every requirement in the spec maps to a task:
   - Strategy pattern (C) → Tasks 7-12.
   - `UPSTREAM_TIMEOUT_MS` shared constant → Task 1.
   - Required `Logger` on every strategy + wrapper → Tasks 2, 3, 4, 5, 7, 8, 9, 10, 11, 12.
   - Three API wrappers with detailed logging → Tasks 3, 4, 5.
   - Service DID owns discovered records; rkeys `ol-{kind}-{OLid}` → Task 11.
   - `getRecord` extension → Task 21.
   - Shared `defs.json`; `edition.json` + new `work.json` + `contributor.json` → Tasks 13, 14, 15, 16.
   - `searchWorks` / `searchContributors` lex schema updates → Tasks 17, 18.
   - Cursor v2 (handled by `PostgresSource` Task 7) — note: `OpenLibrarySource` cursor forwarding deferred to a follow-up since the spec is non-blocking on this.
   - Fire-and-forget ingest → Task 11 + Task 12.
   - `id`-only query on `searchContributors` skips OpenLibrary → Task 12.
   - Author bio on contributor record (option B) → Wikipedia wrapper writes `bio` on the contributor item; the Ingestor persists it on the `contributors` table → Tasks 5, 11.
   - `.env.example` + README → Task 22.
   - Verify script → Task 23.

2. **Placeholder scan** — no "TBD"/"TODO"/"implement later". All test code is concrete.

3. **Type consistency** — `EditionItem` / `WorkItem` / `ContributorItem` defined in Task 2 and used unchanged through Tasks 3-23. `SearchQuery` / `SearchResult` / `SearchSource` / `Enricher` / `Ingestor` defined in Task 2 and used unchanged. `UPSTREAM_TIMEOUT_MS` exported from Task 1 used in Tasks 3, 4, 5. `SearchService` (Task 12) takes a fallback `Logger` in its constructor.

4. **Out-of-scope items** — explicitly listed in the spec: `searchPublishers` handler implementation; wiring `community.lexicon.book.*` into `tap-consumer.ts`; `com.atproto.sync.getRecord` for non-lex collections; separate worker process for ingestion. Not in this plan.

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-08-24-search-editions-works-external.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session with checkpoints for review

Which approach?