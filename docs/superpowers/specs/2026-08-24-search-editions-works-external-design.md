# searchEditions, searchWorks, searchContributors with OpenLibrary / Google Books / Wikipedia

**Date:** 2026-08-24
**Status:** Design approved, awaiting spec review

## Goal

Make `community.lexicon.book.searchEditions`, `searchWorks`, and `searchContributors` useful endpoints:

- Search the locally indexed ATProto records first (Postgres tables populated by TAP ingestion).
- On miss, fall back to OpenLibrary (`/search.json`) to find candidates.
- Enrich each result with Google Books (description + cover for editions) and Wikipedia (author bios).
- Persist the discovered items to the local typed tables so future queries hit Postgres first.
- Always log every stage with the request correlation ID.

## Architecture

Strategy pattern. Each stage lives in its own module and takes a required `Logger`. `SearchService` orchestrates the chain for each kind (`edition`, `work`, `contributor`).

```
xrpc-router handler (searchEditions | searchWorks | searchContributors)
  └─→ SearchService.{searchEditions|searchWorks|searchContributors}(q)
        ├─ PostgresSource.search(q, log)
        ├─ if items.length === 0:
        │     ├─ OpenLibrarySource.searchEditions|searchWorks|searchContributors(q, log)
        │     ├─ GoogleBooksEnricher.enrich(items, log)        (editions only)
        │     ├─ WikipediaEnricher.enrich(items, log)          (all three kinds)
        │     └─ LocalPostgresIngestor.ingest(items)           (fire-and-forget, owns its own logger)
        └─ return SearchResult
```

The XRPC handlers stay thin: parameter validation, cursor decode/encode, calling `SearchService`, mapping to the lex output shape.

## Files

```
packages/bibliograph-service/
├── src/lib/server/
│   ├── api/
│   │   ├── open-library.ts        # searchEditions / searchWorks / searchContributors
│   │   ├── google-books.ts        # enrichEditions
│   │   ├── wikipedia.ts           # enrichAuthorsOnWorksOrEditions + enrichContributorBios
│   │   └── timeout.ts             # UPSTREAM_TIMEOUT_MS
│   ├── search/
│   │   ├── types.ts               # SearchSource, Enricher, Ingestor, EditionItem, WorkItem, ContributorItem
│   │   ├── service.ts             # SearchService with three public methods
│   │   ├── postgres-source.ts     # PostgresSource<EditionItem | WorkItem | ContributorItem>
│   │   ├── open-library-source.ts # thin wrapper around api/open-library.ts
│   │   ├── google-books-enricher.ts
│   │   ├── wikipedia-enricher.ts  # AuthorWikipediaEnricher + ContributorWikipediaEnricher
│   │   └── local-postgres-ingestor.ts
│   └── xrpc-router.ts             # handlers wired to SearchService
├── lexicons/community/lexicon/book/
│   ├── defs.json                  # NEW shared contribution + identifier defs
│   ├── edition.json               # +coverImageUrl field; inline defs → NSID refs
│   ├── work.json                  # NEW
│   ├── contributor.json           # NEW
│   ├── searchEditions.json        # unchanged lex
│   ├── searchWorks.json           # null body → full schema
│   └── searchContributors.json    # null body → full schema
└── scripts/
    └── verify-search.ts           # NEW end-to-end verification
```

## Lex schema changes

### New `community/lexicon/book/defs.json`

NSID `community.lexicon.book.defs`. Houses the shared `contribution` and `identifier` defs currently inlined in `edition.json`. Same pattern Bibliograph already uses for `net.olamaelcu.livtet.biblio.defs`. References by NSID: `community.lexicon.book.defs#contribution`, `community.lexicon.book.defs#identifier`.

### `community/lexicon/book/edition.json`

- Add `coverImageUrl: { type: string, format: uri, maxLength: 2048 }` (optional).
- Replace inline `contribution` and `identifier` defs with NSID refs to `community.lexicon.book.defs`.

### New `community/lexicon/book/work.json`

NSID `community.lexicon.book.work`. Mirrors the `works` Postgres table:

| Field | Type | Required |
|---|---|---|
| `title` | string (1..2048, maxGraphemes 200) | yes |
| `subtitle` | string (maxLength 1024, maxGraphemes 100) | no |
| `originalLanguage` | string (format: language) | no |
| `firstPublishedYear` | integer (0..9999) | no |
| `subjects` | array<string> | no |
| `contributors` | array<ref community.lexicon.book.defs#contribution> | no |
| `identifiers` | array<ref community.lexicon.book.defs#identifier> | no |
| `description` | string (maxLength 8192, maxGraphemes 1024) | no |
| `createdAt` | string (format: datetime) | yes |

Reuses `community.lexicon.book.defs#contribution` and `#identifier`.

### New `community/lexicon/book/contributor.json`

NSID `community.lexicon.book.contributor`. Mirrors the `contributors` Postgres table:

| Field | Type | Required |
|---|---|---|
| `name` | string (1..256, maxGraphemes 200) | yes |
| `aliases` | array<string> | no |
| `bio` | string (maxLength 16384, maxGraphemes 2048) | no |
| `bornYear` | integer (0..9999) | no |
| `diedYear` | integer (0..9999) | no |
| `linkedDid` | string (format: did) | no |
| `identifiers` | array<ref community.lexicon.book.defs#identifier> | no |
| `createdAt` | string (format: datetime) | yes |

### `community/lexicon/book/searchWorks.json`

Replace null body with the full query schema. Output `items` reference `community.lexicon.book.work`. `errors` declare `InvalidQuery`. Params mirror `searchEditions.json` (`q`, `id`, `limit`, `cursor`).

### `community/lexicon/book/searchContributors.json`

Same treatment. Output `items` reference `community.lexicon.book.contributor`. Handler becomes real (was a 501 stub).

## Strategy interfaces (`search/types.ts`)

```ts
import type { Logger } from 'pino';

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

// Items (mapped from Postgres rows AND from OpenLibrary search responses)

export interface Identifier {
  uri: string;
  resource: string;
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
  contributors: Array<{ subject: { uri: string; cid: string }; role: string }>;
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
  contributors: Array<{ subject: { uri: string; cid: string }; role: string }>;
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
```

`SearchService` exposes three methods, one per kind. Each method takes a `SearchQuery`, sources its logger from `getCorrelationLog()`, and:

1. Calls the kind-specific `PostgresSource.search`.
2. If `items.length === 0`, calls the kind-specific `OpenLibrarySource.search`.
3. Runs `GoogleBooksEnricher` (editions only).
4. Runs the appropriate `WikipediaEnricher` (`AuthorWikipediaEnricher` for editions/works; `ContributorWikipediaEnricher` for contributors).
5. Fires `LocalPostgresIngestor.ingest()` without awaiting.
6. Returns the final `SearchResult`.

`searchContributors` with only `id` (no `q`) skips the OpenLibrary call: matches identifiers on Postgres rows, returns `items: []` with `total: 0` on miss.

## API wrappers

Each wrapper logs at every stage boundary using the passed `Logger`. All use `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`.

### `api/timeout.ts`

```ts
export const UPSTREAM_TIMEOUT_MS = 10_000;
```

Documented as: "10s covers p95 of OpenLibrary / Google Books / Wikipedia under typical load. Increase via env if upstream quotas tighten."

### `api/open-library.ts`

```ts
searchEditions(query: SearchQuery, log: Logger, signal?: AbortSignal): Promise<SearchResult<EditionItem>>;
searchWorks(query: SearchQuery, log: Logger, signal?: AbortSignal): Promise<SearchResult<WorkItem>>;
searchContributors(query: SearchQuery, log: Logger, signal?: AbortSignal): Promise<SearchResult<ContributorItem>>;
```

- `GET https://openlibrary.org/search.json?q={q}&type={edition|work|author}&limit={limit}&page={page}`.
- `User-Agent: Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)`.
- Maps response: doc fields → item fields; `key` → identifier (`resource: 'openlibrary'`); `numFound` → `total`; `nextPage` → cursor (`src: 'openlibrary'`).

Log events:
- `info` entry: `{ stage: 'open-library-source', q, limit, page }`
- `info` success: `{ stage: 'open-library-source', items: count, total, durationMs }`
- `warn` non-2xx: `{ stage: 'open-library-source', status, body }`
- `error` throw: `{ stage: 'open-library-source', err, durationMs }`

### `api/google-books.ts`

```ts
enrichEditions(items: EditionItem[], log: Logger, signal?: AbortSignal): Promise<EditionItem[]>;
```

- For each item, lookup by `isbn13`/`isbn10` first via `GET https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}&key={GOOGLE_BOOKS_API_KEY}`.
- Fall back to `intitle:{title}+inauthor:{author}` if no ISBN match.
- Fill `description` and `coverImageUrl` only if missing on the item.
- If `GOOGLE_BOOKS_API_KEY` is unset: log a single `warn` at boot and skip Google Books (request still completes via OpenLibrary + Wikipedia).
- Quota-friendly: one call per item, no retries on 429.

### `api/wikipedia.ts`

```ts
enrichAuthorsOnWorksOrEditions(items: ReadonlyArray<EditionItem | WorkItem>, log: Logger, signal?: AbortSignal):
  Promise<Array<EditionItem | WorkItem>>;

enrichContributorBios(items: ContributorItem[], log: Logger, signal?: AbortSignal):
  Promise<ContributorItem[]>;
```

- `enrichAuthorsOnWorksOrEditions`: collects unique author names from `items[i].contributors[].subject.uri` lookup OR `items[i].contributors[]` entries' author metadata; one batched `GET https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles={name}&format=json&redirects=1` per name; writes extract into the corresponding contributor entry's `bio` (new field on the `contribution` shape OR stored in a sibling field — see Open question 1 below).
- `enrichContributorBios`: writes extract directly to `contributor.bio`.
- Dedupe per call (no name queried twice).

### Author bio placement on `contribution` (decided: option B)

The existing `community.lexicon.book.defs#contribution` def has `subject` (strongRef to a contributor) and `role` only. Author bios live on the referenced `community.lexicon.book.contributor` record (which already has a `bio` field), NOT on the `contribution` def.

`enrichAuthorsOnWorksOrEditions` writes the Wikipedia extract into the contributor record (via `LocalPostgresIngestor.ingest` on the `contributors` table); the contributor's `bio` is then served alongside each `contribution` strongRef by the `ComAtprotoRepoGetRecord` extension when callers resolve the reference.

This keeps `contribution` a pure relationship shape, matches the ATProto pattern (strongRef to a record; contributor record is authoritative), and avoids mutating the shared def.

## Persistence

Service DID `did:web:biblio.livtet.olamaelcu.net` (existing `PUBLISHER_DID` from `lib/server/did.ts`) owns every discovered record.

| OpenLibrary key prefix | Lex collection | rkey | Postgres table |
|---|---|---|---|
| `/works/OL…W` | `community.lexicon.book.work` | `ol-work-OL…W` | `works` |
| `/books/OL…M` | `community.lexicon.book.edition` | `ol-edition-OL…M` | `editions` |
| `/authors/OL…A` | `community.lexicon.book.contributor` | `ol-author-OL…A` | `contributors` |

`LocalPostgresIngestor.ingest(items)`:

- Resolves the service DID from `lib/server/did.ts`.
- Builds `uri = at://{PUBLISHER_DID}/{collection}/{rkey}`.
- Upserts by `(did, rkey)`. Existing `editions` / `works` / `contributors` tables already have all required columns; `editions.cover_image_url` is added via a small new migration `drizzle/0002_discovery_columns.sql` that adds `cover_image_url text` to `editions`. The other tables need no migration.
- Errors logged at `error`, never propagated.

## `getRecord` extension (`ComAtprotoRepoGetRecord`)

Currently `xrpc-router.ts:361` only serves the lex collection from CAR slices. Extend it to route by collection:

```
collection === 'community.lexicon.book.edition'    → SELECT * FROM editions WHERE uri = $1
collection === 'community.lexicon.book.work'       → SELECT * FROM works WHERE uri = $1
collection === 'community.lexicon.book.contributor'→ SELECT * FROM contributors WHERE uri = $1
anything else                                      → existing CAR path
```

For each DB row, build the atproto JSON record (matching the lex schema), CBOR-encode via `@atproto/lex-cbor` (already imported), compute CID via `@atcute/car`, return `{ uri, cid, value }`.

`ComAtprotoSyncGetRecord` stays unchanged (CAR-only). Future work if needed.

## Cursor format (v2)

```ts
type Cursor =
  | { v: 1 | 2; src: 'postgres'; t: string; u: string }
  | { v: 2; src: 'openlibrary'; p: number };
```

Encoded as the existing base64url JSON envelope. The XRPC handlers decode, dispatch by `src`, and encode the next-page cursor on output.

## Logging contract

`getCorrelationLog()` (from `correlation.ts`) propagates the request correlation ID. Each stage receives `requestLog.child({ stage: 'open-library-source' })` (or equivalent) so logs include both correlation and stage.

Example from a Postgres-miss searchEditions:
```
{ component: "access", nsid: "community.lexicon.book.searchEditions", status: 200, durationMs: 412 }
{ stage: "postgres-source", items: 0, durationMs: 12 }
{ stage: "open-library-source", q: "harry potter", items: 10, total: 1024, durationMs: 188 }
{ stage: "google-books-enricher", matched: 6, missing: 4, durationMs: 201 }
{ stage: "wikipedia-enricher", matched: 9, missing: 1, durationMs: 167 }
{ stage: "ingestor-fire-and-forget", queued: 10 }
```

## Env config

`.env.example` adds:
```
# Google Books API key (https://console.cloud.google.com → Books API). Optional.
# If unset, searchEditions still completes via OpenLibrary + Wikipedia.
GOOGLE_BOOKS_API_KEY=
```

`README.md` Material Discovery section gains one sentence noting the optional key.

## XRPC handler changes (`xrpc-router.ts`)

- **searchEditions (line 121)**: replace inline Postgres query with `searchService.searchEditions({q, id, limit, cursor})`.
- **searchWorks (line 218)**: replace `notImplemented` stub with `searchService.searchWorks(...)`.
- **searchContributors (line 208)**: replace `notImplemented` stub with `searchService.searchContributors(...)`. Skip OpenLibrary on `id`-only queries (return empty items + total:0 on Postgres miss).
- **searchPublishers (line 213)**: keep `notImplemented`; lex file already declares a proper output schema.
- **ComAtprotoRepoGetRecord (line 361)**: add the three-collection Postgres branch.
- **Cursor helpers (line 46-60)**: bump `CURSOR_VERSION` to 2; new shape with `src` discriminator; v1 cursors decode as `src: 'postgres'` for back-compat.

## Testing

`scripts/verify-search.ts` (new, follows `verify-server.ts` pattern):

- Boots the `router` in-process; stubs `globalThis.fetch` to return canned OpenLibrary / Google Books / Wikipedia responses.
- Cases:
  - Postgres hit → no external calls; logs show only `postgres-source`.
  - Postgres miss + OpenLibrary hit → external calls fire, items returned, ingest fires (verify Postgres upsert).
  - Google Books key unset → enrichment skipped, single boot `warn`.
  - Cursor round-trip: Postgres source (v1 cursor → v2 cursor) and OpenLibrary source (v2 cursor with `src: 'openlibrary'`).
  - `getRecord` returns a valid CID for each of the three collections after ingest.

`pnpm verify:search` script entry added to `packages/bibliograph-service/package.json`.

## Out of scope

- `searchPublishers` handler implementation (lex shape updated; handler still 501).
- Wiring `community.lexicon.book.*` into `tap-consumer.ts` (still skipped).
- `com.atproto.sync.getRecord` for non-lex collections (CAR-only path stays).
- A separate worker process for ingestion (fire-and-forget runs in the web process).
- Migration of existing rows beyond adding `cover_image_url` to `editions`.
- Author bio on `contribution` (resolved via option (b): the referenced contributor record holds the bio).

## Open questions for follow-up after spec review

1. **OpenLibrary author search `type=author` vs `type=person`** — the OpenLibrary docs accept both. We standardize on `author`. Confirm at impl time.
2. **Rkey encoding** — `ol-work-OL66554W` keeps the OL prefix; confirm no atproto rkey restriction against uppercase + digits.