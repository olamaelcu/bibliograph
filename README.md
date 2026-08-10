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
| `community.lexicon.book.contributorType` | record | Canonical contributor role published by Bibliograph (author, illustrator, editor, translator, narrator) |

### XRPC Endpoints

**Queries** (GET `/xrpc/nsid`):

| Endpoint | Description |
|----------|-------------|
| `getBook` | Fetch a single book by AT-URI (returns joined contributors) |
| `getBooks` | Batch fetch books by URIs (returns joined contributors) |
| `getReviews` | Paginated reviews for a book |
| `getReview` | Fetch a single review by AT-URI or user+book |
| `getUserStatus` | Reading statuses for a user |
| `searchBooks` | Full-text search on title, author, ISBN |
| `getClaims` | Claims attached to a book |
| `getFeed` | Home feed: recent status updates, newest books, trending, following, cross-user |
| `listContributors` | Paginated list of all known contributors |
| `searchContributors` | Full-text search over contributor name and alt names |
| `listContributorTypes` | List canonical contributor roles seeded by Bibliograph |

**Procedures** (POST `/xrpc/nsid`):

| Endpoint | Description |
|----------|-------------|
| `createBook` | Create a book definition (requires ISBN for dedup) |
| `createReview` | Post a review |
| `createStatus` | Record reading status |
| `createClaim` | Claim a book as author/curator |
| `createContributor` | Create a contributor record (requires at least one identifier) |
| `updateContributor` | Patch or add/remove identifiers, images, altNames, bio (creator or librarian) |
| `createContributorType` | Create a canonical contributor role (librarian only) |

### Other endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/tap/event` | POST | Tap webhook — receives firehose events |
| `/api/lookup/book` | GET | Open Library lookup by ISBN or title |

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

## Book data lookup

The `/api/lookup/book` endpoint queries Open Library:

```bash
curl "http://localhost:3000/api/lookup/book?isbn=9780140328721"
curl "http://localhost:3000/api/lookup/book?title=Dune&author=Frank+Herbert"
```

Google Books support is available via `GoogleBooksProvider` but requires an API key passed to the constructor.

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
        "uri": "at://did:web:biblio.example/community.lexicon.book.contributorType/author",
        "cid": "bafy…",
        "did": "did:web:biblio.example",
        "record": { "$type": "community.lexicon.book.contributorType", "name": "author", ... }
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

## Connecting Tap

Run Tap with the book lexicon signal collection:

```bash
tap run \
  --signal-collection=community.lexicon.book.book \
  --collection-filters=community.lexicon.book.* \
  --webhook-url=http://localhost:3000/tap/event \
  --admin-password=secret
```

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

## Project structure

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
    init.ts        Table creation, FTS5 setup, search helper
  providers/
    interface.ts   BookProvider interface
    openlibrary.ts Open Library API provider
    googlebooks.ts Google Books API provider
lexicons/
  community/lexicon/book/
    *.json         14 ATProto lexicon schema definitions
```

## License

MPL-2.0
