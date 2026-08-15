# Bibliograph

A collection of tools in one:

- An [ATProto AppView][1] that provides a means of finding information about
  books, reviews folks have made in the Atmosphere
- An [ATProto feed generator][2] that aggregates user behavior for the purpose
  of discovery
- A thin [ATProto PDS][3] whose records are about the books and authors it knows about.

## Setup

```bash
pnpm install
pnpm run dev   # Vite dev server with Hono as middleware on http://localhost:5176

# Or use `mise`
mise dev
```

Check it's alive: `curl http://localhost:5176/health`.

The web UI is served from Eta templates on disk (`src/pages/templates/`):
`/` lists the service overview with counts, `/queries` documents every XRPC
query, `/procedures` every procedure, and `/stats` shows live catalog counts,
open import issues, and backfill state. Pages are server-side rendered with
[Web Awesome](https://webawesome.com) components and hydrated on the client.

## Environment

| Variable              | Default                       | Description                                |
| --------------------- | ----------------------------- | ------------------------------------------ |
| `PORT`                | `3000`                        | HTTP server port                           |
| `NODE_ENV`            | _(unset)_                     | `production` enables pino JSON logs        |
| `DB_PATH`             | `data/bibliograph.db`         | SQLite database path                       |
| `OL_EDITIONS_DUMP_URL` | `https://openlibrary.org/data/ol_dump_editions_latest.txt.gz` | OL editions dump URL  |
| `OL_WORKS_DUMP_URL`   | `https://openlibrary.org/data/ol_dump_works_latest.txt.gz`    | OL works dump URL     |
| `OL_AUTHORS_DUMP_URL` | `https://openlibrary.org/data/ol_dump_authors_latest.txt.gz`  | OL authors dump URL   |
| `OL_DUMP_PATH`        | `data/dumps`                  | Directory for downloaded dump files        |
| `BLOB_STORE_SCHEME`   | `s3`                          | Blob store backend: `s3` or `memory`       |
| `AWS_BUCKET`          | _(unset)_                     | S3 bucket for blobs                         |
| `AWS_S3_ENDPOINT`     | _(unset)_                     | S3-compatible endpoint                      |
| `AWS_S3_REGION`       | _(unset)_                     | S3 region                                   |
| `AWS_ACCESS_KEY_ID`   | _(unset)_                     | S3 access key                               |
| `AWS_SECRET_ACCESS_KEY` | _(unset)_                   | S3 secret key                               |
| `BLOB_PUBLIC_BASE_URL` | _(unset)_                    | Public URL base for blob keys (e.g. `https://cdn.example.com/`) |
| `BOOKHIVE_PDS_URL`    | `https://pds.bookhive.buzz`   | PDS to read the BookHive catalog from       |
| `BOOKHIVE_CATALOG_DID` | `did:web:bookhive.buzz`     | DID hosting the BookHive catalog record     |

## Scripts

- `pnpm run dev` — development (Vite + Hono dev server)
- `pnpm run check` — typecheck
- `pnpm run test` — vitest
- `pnpm run build` — compile server to `dist/`
- `pnpm run start` — production server (runs migrations on startup)
- `pnpm run db:generate` — generate Drizzle migrations
- `pnpm run db:migrate` — apply pending Drizzle migrations
- `pnpm run dump:openlibrary` — import the OL editions dump
- `pnpm run dump:works` — import the OL works dump
- `pnpm run dump:contributors` — import the OL authors dump
- `pnpm run bookhive:catalog` — import the BookHive catalog
- `pnpm run review` — review/release CLI
- `pnpm run images:refresh` — backfill cover/portrait images for released records
- `pnpm run lex:gen` / `lex:check` — regenerate / validate lexicon codegen

## Backfill (OpenLibrary & BookHive)

Import real catalog data into the staged review pipeline. Each command
streams its dump, resumes from the last processed record, and stores every
record as `staged` until reviewed.

```bash
pnpm run dump:openlibrary    # OL editions dump
pnpm run dump:works          # OL works dump (run before editions)
pnpm run dump:contributors   # OL authors dump (run before editions)
pnpm run bookhive:catalog    # BookHive catalog records
```

Run the three dumps in dependency order: `dump:contributors` →
`dump:works` → `dump:openlibrary`.

Flags (all four commands accept the same set):

| Flag                  | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `--reset`             | Clear the resume cursor and restart from the first record  |
| `--no-download`       | Reuse an existing local dump file instead of downloading   |
| `--keep-dump`         | Keep the downloaded `.gz` after import (default: delete)   |
| `--path=DIR`          | Dump directory (default `$OL_DUMP_PATH` or `data/dumps`)   |
| `--batch-size=N`      | Records per batch (default `500`)                          |

Imported rows are `staged` and hidden from XRPC until released via the
review workflow below.

## Review / release workflow

```bash
pnpm run review list --entity=book [--status=staged] [--issues=true]
pnpm run review show book <pk>
pnpm run review edit book <pk> --field=title --value="New title"
pnpm run review approve book <pk> [--keep-issues] [--yes]
pnpm run review reject book <pk>
pnpm run review issue list book <pk>          # open issues for a record
pnpm run review issue resolve <issue-pk>
pnpm run review issue dismiss <issue-pk>
```

Entities: `book`, `work`, `contributor`, `genre`, `contributorRole`.

Lifecycle: every imported row starts `staged`. `approve` promotes it to
`released` (making it visible via XRPC); `reject` marks it `rejected`.

- **Dependency gate:** approving a `book` fails if its work/contributors/
genres are still `staged` — pass `--yes` to approve anyway.
- **Issue gate:** approving fails while the record has open import issues —
  pass `--keep-issues` to override, or resolve/dismiss the issues first.
- Staged (and rejected) records are hidden from the XRPC/PDS router; the
  release-status gate applies at query time.

## Images

Backfill cover and portrait images for released records that are missing
them:

```bash
pnpm run images:refresh [--batch-size=N]
```

Covers are derived from OL identifiers (cover OLID or ISBN) or fetched by
name, then stored as blobs. Blobs are served via the blob proxy.

Storage backend is configured with the `BLOB_STORE_SCHEME` / `AWS_*` /
`BLOB_PUBLIC_BASE_URL` variables (see the Environment table). A local S3
compatible store is available via docker:

```bash
docker compose up -d storage   # rustfs S3-compatible blob storage
```

## Migrations

```bash
pnpm run db:migrate    # apply pending migrations from drizzle/
```

New schema versions are generated with `pnpm run db:generate`. The web
process (`pnpm start`) applies pending migrations itself on startup, so
`db:migrate` is only needed for local development.

## Deployment

Dokku via `git push dokku main`; `app.json` healthcheck targets `/health`.

[1]: https://atproto.com/guides/glossary#app-view
[2]: https://atproto.com/guides/feeds
[3]: https://atproto.com/specs/repository
