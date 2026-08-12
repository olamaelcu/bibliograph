# Bibliograph

ATProto AppView for `community.lexicon.book` — a shared book lexicon that indexes book records, reviews, reading statuses, and author/publisher claims from the Atmosphere network.

A public reference instance is available at **[biblio.livtet.olamaelcu.net](https://biblio.livtet.olamaelcu.net/)**.

## Quick start

```bash
npm install
npm run dev
```

Server starts on `http://localhost:3000`. Visit `/` for the splash page, `/health` for a JSON status check.

## What it does

Bibliograph consumes book-related ATProto records via [Tap](https://github.com/bluesky-social/indigo/tree/main/cmd/tap), indexes them into SQLite, and serves XRPC query/procedure endpoints following the `community.lexicon.book` lexicon.

### Lexicons

| NSID | Type | Purpose |
|------|------|---------|
| `community.lexicon.book.book` | record | Core book definition (title, author, ISBN, metadata, optional contributors) |
| `community.lexicon.book.claim` | record | Author/publisher claim with deduplication key |
| `community.lexicon.book.review` | record | User review with optional rating |
| `community.lexicon.book.status` | record | Reading status (reading, read, to-read, abandoned) |
| `community.lexicon.book.contributor` | record | Person or entity that worked on a book (author, illustrator, etc.) |
| `community.lexicon.book.contributor.type` | record | Canonical contributor role published by Bibliograph (author, illustrator, editor, translator, narrator) |

### XRPC Endpoints

**Queries** (GET `/xrpc/nsid`):

| Endpoint | Description |
|----------|-------------|
| `community.lexicon.book.get` | Fetch a single book by AT-URI (returns joined contributors) |
| `community.lexicon.book.getMany` | Batch fetch books by URIs (returns joined contributors) |
| `community.lexicon.book.list` | Paginated book list |
| `community.lexicon.book.search` | Full-text search on title, author, ISBN |
| `community.lexicon.book.feed` | Home feed: recent status updates, newest books, trending, following, cross-user |
| `community.lexicon.book.review.get` | Fetch a single review by AT-URI or user+book |
| `community.lexicon.book.review.getMany` | Paginated reviews for a book |
| `community.lexicon.book.status.list` | Reading statuses for a user |
| `community.lexicon.book.claim.getMany` | Claims attached to a book |
| `community.lexicon.book.shelf.get` | Fetch a single shelf by AT-URI |
| `community.lexicon.book.shelf.list` | A user's shelves (paginated) |
| `community.lexicon.book.shelfItem.list` | Books on a shelf |
| `community.lexicon.book.contributor.get` | Fetch a single contributor by AT-URI |
| `community.lexicon.book.contributor.list` | Paginated list of all known contributors |
| `community.lexicon.book.contributor.search` | Full-text search over contributor name and alt names |
| `community.lexicon.book.contributor.listTypes` | List canonical contributor roles seeded by Bibliograph |

**Procedures** (POST `/xrpc/nsid`):

| Endpoint | Description |
|----------|-------------|
| `community.lexicon.book.create` | Create a book definition (requires ISBN for dedup) |
| `community.lexicon.book.review.create` | Post a review |
| `community.lexicon.book.status.create` | Record reading status |
| `community.lexicon.book.claim.create` | Claim a book as author/curator |
| `community.lexicon.book.shelf.create` | Create a named shelf |
| `community.lexicon.book.shelfItem.create` | Add a book to a shelf |
| `community.lexicon.book.shelfItem.delete` | Remove a book from a shelf |
| `community.lexicon.book.contributor.create` | Create a contributor record (requires at least one identifier) |
| `community.lexicon.book.contributor.update` | Patch or add/remove identifiers, images, altNames, bio (creator or librarian) |
| `community.lexicon.book.contributor.createType` | Create a canonical contributor role (librarian only) |

### Other endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/tap/event` | POST | Tap webhook — receives firehose events |

## Architecture

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│   Tap    │────▶│  /tap/event  │────▶│   Indexer    │
│ (firehose)│    │   (webhook)  │     │   (SQLite)   │
└──────────┘     └──────────────┘     └──────┬───────┘
                                             │
                                      ┌──────▼───────┐
                                      │  Hono server  │
                                      │  (XRPC API)   │
                                      └──────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Open Library    │
                                    │  Google Books    │
                                    │  (providers)     │
                                    └─────────────────┘
```

- **Hono** — HTTP server with XRPC-style routing
- **Drizzle ORM + better-sqlite3** — local index database with FTS5 search
- **Tap** — firehose consumer for ATProto record events
- **Providers** — Open Library and Google Books data enrichment

## Authorization model

Books are created in a **pending** status. An author claim record (`community.lexicon.book.claim`) ties the book to the creator's DID.

- **Claim owner** — the DID that claimed the book can edit it
- **Librarian** — users with verified claims on multiple books gain edit privileges
- **ISBN required** — book creation requires an ISBN/EAN for deduplication

## Contributors

Books can reference one or more contributor records via an inline `contributors`
array on the book record (each entry is a strongRef to a contributor + a
strongRef to a contributor role, plus an optional `order` int). The AppView
also materializes this into a `book_contributors` join table so consumers
can fetch the joined records alongside the book without an extra round trip
to the PDS.

```jsonc
{
  "uri": "at://did:plc:example/community.lexicon.book.book/abc",
  "record": { "title": "Dune", "author": "Frank Herbert", ... },
  "cid": "bafy…",
  "contributors": [
    {
      "contributor": {
        "uri": "at://did:plc:example/community.lexicon.book.contributor/x",
        "cid": "bafy…",
        "did": "did:plc:example",
        "record": { "$type": "community.lexicon.book.contributor", "name": "Frank Herbert", ... }
      },
      "role": {
        "uri": "at://did:web:biblio.example/community.lexicon.book.contributor.type/author",
        "cid": "bafy…",
        "did": "did:web:biblio.example",
        "record": { "$type": "community.lexicon.book.contributor.type", "name": "author", ... }
      },
      "order": 0
    }
  ]
}
```

Bibliograph seeds five canonical roles on boot — `author`, `illustrator`,
`editor`, `translator`, `narrator`. Librarians can publish additional roles
via `createContributorType`.

### Backfill script

For pre-existing books that landed in the index before this feature shipped,
the `book_contributors` join table may be empty even if the book record carries
a `contributors` array. Populate it with:

```bash
# Default: additive/upsert
npm run backfill:contributors

# Preview without writing
npm run backfill:contributors -- --dry-run

# Wipe book_contributors before repopulating
npm run backfill:contributors -- --reset
```

Re-running is safe: the script uses `INSERT OR IGNORE` on the composite PK
`(bookUri, contributorUri, roleUri)`. Exit code is non-zero if any rows were
skipped due to malformed JSON in `books.contributors`.

## Bulk backfill (editions dump)

For seeding the index with millions of records, the importer consumes the
monthly OpenLibrary editions TSV dump. The run is idempotent and resumable:

```bash
# one-off: download + import
npm run dump:openlibrary

# cron-friendly: skip the network download when local file is already current
npm run dump:openlibrary -- --no-download

# clear the checkpoint and re-process from byte 0
npm run dump:openlibrary -- --reset

# override the local dump directory
OL_DUMP_PATH=/var/lib/bibliograph/dumps npm run dump:openlibrary
```

The same importer is reachable through the existing dispatcher:

```bash
npx tsx src/backfill.ts openlibrary:dump [--no-download] [--reset]
```

State — including byte offset and last-processed edition key — is persisted in
`backfill_state`. An interrupted run resumes from the last checkpoint, not
from line 1.

## Bulk backfill (Bookhive catalog)

Bibliograph also consumes [`@bookhive.buzz`'s on-protocol catalog](https://nick-the-sick.pckt.blog/the-design-philosophy-of-bookhive-s23cz85)
(`buzz.bookhive.catalogBook` records). The importer paginates the catalog
over XRPC `listRecords`, mirrors each record into a Bibliograph-owned
`community.lexicon.book.book` row, and reuses contributor records keyed by
name. The catalog DID is resolved at startup via the DNS TXT record at
`_lexicon.bookhive.buzz` — overridable for tests via `BOOKHIVE_CATALOG_DID`
and `BOOKHIVE_PDS_URL`.

```bash
# one-off: import the entire catalog (resumable)
npm run bookhive:catalog

# clear the checkpoint and re-process from page 0
npm run bookhive:catalog -- --reset

# force-run even if a stale lockfile is on disk
npm run bookhive:catalog -- --force

# tune page/batch size
npm run bookhive:catalog -- --page-size=100 --batch-size=500
```

Reach the same importer through the dispatcher:

```bash
npx tsx src/backfill.ts bookhive:catalog [flags]
```

Author bylines are stored under each book's `contributors` array (each entry
references a `community.lexicon.book.contributor` record with the
`author` role), in keeping with BookHive's "store the maximally useful data"
philosophy. Live updates to BookHive catalog records are streamed via Tap
when the operator adds `buzz.bookhive.catalogBook` to the `--collection-filters`
list (see *Connecting Tap* below).

## Bookhive user reading statuses

Bibliograph also mirrors BookHive users' `buzz.bookhive.book` records — the
per-user reading statuses (reading/read/to-read/abandoned), 1–10 star ratings
(scaled to 1–5), review prose, and `bookProgress` — into the existing
`community.lexicon.book.status` and `community.lexicon.book.review` tables.

Users are discovered from two on-protocol sources:

1. `@bookhive.buzz`'s `buzz.bookhive.activity` feed (each record names the
   `userDid` who started/finished/rated a book), and
2. the `@bookhive.buzz` repo's own `buzz.bookhive.book` records (the service
   account's library is itself a backfill source).

```bash
# enumerate users into bookhive_user_discovery
npm run bookhive:activity

# backfill each discovered user's reading statuses
npm run bookhive:users

# full pipeline is reachable through the dispatcher too
npx tsx src/backfill.ts bookhive:activity
npx tsx src/backfill.ts bookhive:users
```

Records whose `hiveId` hasn't been imported into `books` yet (catalog backfill
lag) are skipped with a warn — they resolve on a later run once the catalog
catches up. Live `buzz.bookhive.book` events stream through Tap when the
operator adds `buzz.bookhive.book` to `--collection-filters`.

## Connecting Tap

Run Tap with the book lexicon signal collection:

```bash
tap run \
  --signal-collection=community.lexicon.book.book \
  --collection-filters=community.lexicon.book.*,buzz.bookhive.catalogBook,buzz.bookhive.book \
  --webhook-url=http://localhost:3000/tap/event \
  --admin-password=secret
```

The `buzz.bookhive.catalogBook` and `buzz.bookhive.book` filters let Tap
stream live catalog updates and user reading-status events from
`@bookhive.buzz` into the Bibliograph index. The bulk backfills above are
initial seeds; live edits and deletes flow through this webhook.

## Deploying to Dokku

The `Procfile` declares the AppView processes:

```text
release: tsx src/release.ts   # runs migrations before deploy
web:     tsx src/index.ts     # AppView XRPC API + labeler subscription stream
```

The `com.atproto.label.subscribeLabels` endpoint is served in-process by the
same `web` process (Dokku proxies the `web` process by default, so no custom
proxy config is needed). Clients connect to the same host as the AppView:

```text
wss://biblio.livtet.olamaelcu.net/xrpc/com.atproto.label.subscribeLabels
```

Labels written by the AppView appear in the stream via the shared `label_events`
log (same process, same SQLite database). The labeler DID document must declare
an `atproto_labeler` service entry pointing at this endpoint for clients to
discover it.

### Monthly OpenLibrary import on Dokku

The dump importer runs on a monthly schedule via Dokku's built-in `app.json`
cron support (`0 3 1 * *` — 03:00 UTC on the 1st). Two layers protect against
overlap: Dokku's `concurrency_policy: "forbid"` (no second concurrent run),
plus a `<OL_DUMP_PATH>/.import.lock` file inside the CLI itself.

Configure environment on the Dokku host:

```bash
dokku config:set bibliograph OL_DUMP_PATH=/app/data/dumps
dokku config:set bibliograph OL_DUMP_USER_AGENT="bibliograph-app/0.1 (you@example.com)"
```

`/app/data/dumps` lives on the existing `/srv/data/bibliograph/data → /app/data`
persistent volume mount — no `dokku storage:mount` work needed.

Verify the cron entry registered after each deploy:

```bash
dokku cron:list bibliograph
```

Trigger the first run manually instead of waiting for the 1st of the month:

```bash
CRON_ID=$(dokku cron:list bibliograph --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
dokku cron:run bibliograph "$CRON_ID"
dokku logs bibliograph -t
```

The CLI flags are useful for spot-checks and reruns:

```bash
# parse the local dump without inserting
npm run dump:openlibrary -- --dry-run

# force reprocessing from scratch (clears `backfill_state`)
npm run dump:openlibrary -- --reset

# keep the 9.2 GB gz on disk after the run (default is to delete it)
npm run dump:openlibrary -- --keep-dump

# override a stale lockfile (PID dead + >24h old)
npm run dump:openlibrary -- --force
```

The importer is idempotent across runs — re-running against the same dump
short-circuits in `prepareRun`, and dedup catches every previously-imported ISBN.

## Cover image pipeline

Books and shelves carry a `cover` JSON object with multi-size, multi-format
image URLs. The local AppView hosts the transcoded bytes and serves them on
demand from `/covers/{collection}/{rkey}-{size}.{ext}`.

```jsonc
{
  "cover": {
    "small":      "/covers/book/abc234567defg-S.jpg",
    "medium":     "/covers/book/abc234567defg-M.jpg",
    "large":      "/covers/book/abc234567defg-L.jpg",
    "smallAvif":  "/covers/book/abc234567defg-S.avif",
    "mediumAvif": "/covers/book/abc234567defg-M.avif",
    "largeAvif":  "/covers/book/abc234567defg-L.avif",
    "color":      "#3a4f6c",
    "width":      600,
    "height":     900,
    "source":     "openlibrary",
    "updatedAt":  "2026-08-01T18:13:52.216Z"
  }
}
```

`coverUrl` on book/shelf records remains a backward-compatible alias for
`cover.medium`. Returning `cover.medium` before the worker has run yields the
provider's original URL; after the worker, it points at the local variant.

The worker transcodes missing variants in the background:

```bash
npm run cover-worker              # one-shot run
npm run cover-worker -- --batch-size 200
```

It selects rows from the `books_missing_cover_variants` and
`shelves_missing_cover_variants` SQLite views (defined in `drizzle/0015` and
`drizzle/0016`), fetches the source once, transcodes to all six variants
(JPG + AVIF at small/medium/large), writes them to the configured storage
backend, and updates the row's `cover` JSON. Cron schedule is `0 */4 * * *`
in `app.json`.

Configure storage and optional schedules:

```bash
# default: local filesystem under ./data/covers
COVER_STORAGE_KIND=fs \
COVER_STORAGE_ROOT=/var/lib/bibliograph/covers \
  npm run cover-worker
```

The `fs` backend is the only backend currently configured. Add S3/R2 by
extending `src/cover-storage.ts` with the relevant OpenDAL scheme.

## Project structure

```
src/
  app.ts           Hono app wiring and route mounting
  index.ts         Entrypoint — runs migrations, starts server
  types.ts         TypeScript interfaces for all lexicons
  auth.ts          Authorization guard (claim ownership, librarian)
  indexer.ts       Tap event handler — indexes record creates/updates/deletes
  api/
    cover.ts       Cover image serving (GET /covers/*)
    get-book.ts    Query handlers (GET /xrpc/*)
    create-book.ts Procedure handlers (POST /xrpc/*)
  cover-storage.ts OpenDAL wrapper for cover image bytes
  cover-transcode.ts Sharp pipeline — produces all 6 variants
  cover-worker.ts  Background job — reads views, transcodes, uploads
  cover-source.ts  Source fetcher (local OpenDAL or remote URL)
  cover-types.ts   CoverCover types, helpers, type guards
  db/
    schema.ts      Drizzle ORM table definitions
    connection.ts  better-sqlite3 database singleton
    views.ts       View name constants for the cover worker
    init.ts        Table creation, FTS5 setup, view bootstrap
  providers/
    interface.ts   BookProvider interface
    openlibrary.ts Open Library API provider
    googlebooks.ts Google Books API provider
lexicons/
  community/lexicon/book/
    *.json         39 ATProto lexicon schema files + `_descriptions.json` sidecar (records and book operations at top level, other-resource operations under per-resource subdirectories)
```

```
src/
  app.ts           Hono app wiring and route mounting
  index.ts         Entrypoint — runs migrations, starts server
  types.ts         TypeScript interfaces for all lexicons
  auth.ts          Authorization guard (claim ownership, librarian)
  indexer.ts       Tap event handler — indexes record creates/updates/deletes
  api/
    get-book.ts    Query handlers (GET /xrpc/*)
    create-book.ts Procedure handlers (POST /xrpc/*)
  db/
    schema.ts      Drizzle ORM table definitions
    connection.ts  better-sqlite3 database singleton
    init.ts        Table creation, FTS5 setup, view bootstrap
  providers/
    interface.ts   BookProvider interface
    cover-variants.ts OpenLibrary cover URL helpers
    openlibrary.ts Open Library API provider
    googlebooks.ts Google Books API provider
lexicons/
  community/lexicon/book/
    *.json         39 ATProto lexicon schema files + `_descriptions.json` sidecar (records and book operations at top level, other-resource operations under per-resource subdirectories)
```

## License

MPL-2.0
