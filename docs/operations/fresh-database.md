# Fresh database

A new deployment starts from an empty PostgreSQL database. There is **no data
migration, no import and no seed**: the catalog is built organically from XRPC
traffic after the worker and edge are running. This is the supported
"fresh-start catalog" policy described in
[`../architecture.md`](../architecture.md#publication), and it is why the did:plc
publisher authority is fixed before the first edition is minted.

The retired `packages/bibliograph-service` package — and its drizzle migrator,
`drizzle.__drizzle_migrations` and `bibliograph-migrate.service` — is **not**
required. It no longer exists in this repository. Graphile creates its own
schema; the worker creates `catalog_enqueue_marks` and `provider_daily_usage`
at boot; the catalog tables come from the versioned SQL below.

## 1. Create the database

PostgreSQL 14 or newer is required (`CREATE OR REPLACE TRIGGER` in the schema).
Create a role and an empty database owned by it:

```bash
sudo -u postgres createuser --pwprompt bibliograph
sudo -u postgres createdb -O bibliograph bibliograph
export DATABASE_URL=postgres://bibliograph:CHANGE_ME@localhost:5432/bibliograph
```

The role needs no extension privileges: the bootstrap does not install
`pg_trgm` or any other extension. It does need `CREATEDB` only for
`catalog-schema-check`, which creates a throwaway database.

## 2. Apply the catalog schema

The schema is versioned under `packages/worker/sql/`. Apply every file in
lexical order:

```bash
mise run catalog-schema
```

`mise.toml` pins `DATABASE_URL` for local development, so an exported
`DATABASE_URL` cannot retarget the task. Use `CATALOG_DATABASE_URL` for staging
or any database other than the pinned local one:

```bash
CATALOG_DATABASE_URL=postgres://bibliograph:…@db.example/booklog mise run catalog-schema
```

or, on a host without mise:

```bash
for f in packages/worker/sql/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -f "$f"
done
```

The `bibliograph-worker` package ships the same files at
`/usr/lib/bibliograph-worker/sql/`; use that path on an installed host.

`mise run deploy` applies them on a host automatically: after installing the
worker package and before restarting the units (see
[`../deploy/debian.md`](../deploy/debian.md)).

Most files are **idempotent and additive**:

- `CREATE TABLE / SEQUENCE / INDEX IF NOT EXISTS`;
- `CREATE OR REPLACE FUNCTION / VIEW / TRIGGER`.

Re-running them on a live catalog is safe. They are **forward-only**, though, not
purely additive: a migration file may backfill rows and then drop a column or
table behind a guard — `0007`/`0008` moved the edition shape claims and publisher
links onto `edition_identifiers` and dropped the five `editions` columns and
`edition_publishers`. Each file is one transaction, so a failing file rolls back
on its own while earlier files stay applied; those drops are not reversible, so
take a `pg_dump` before a release that adds one. Files do not
alter a table that already exists — a new column belongs in a new numbered SQL
file.

### Feed read path

`0003-feed-read.sql` is the one file that targets HappyView's schema: it adds
the feed-order and follow-subject indexes on `happyview.happyview_records`, plus
`USAGE`/`SELECT` for the edge role. That table is created by HappyView's own
migrations, so on a fresh host the first catalog pass runs before it exists and
0003 logs its conditional skip.

`mise run deploy` re-applies only that file after `happyview.service` and
`bibliograph-happyview-deploy.service` have restarted (the latter's
`--wait 120` is the migration/readiness barrier). Re-running it is safe: it
creates missing indexes and repeats the grants, and never touches a row.

The grant goes to the applying role (`DATABASE_URL` in `worker.env`) and, when
that role exists, to `bibliograph-web`. Create `bibliograph-web` before the
deploy if `web.env` uses it as its read-only role; without `USAGE` on `happyview`
and `SELECT` on `happyview.happyview_records` the edge answers
`com.atproto.feed.describeFeedGenerator` / `getFeedSkeleton` with
`503 ServiceUnavailable` while the rest of the edge keeps working. The feed
methods also require `FEED_GENERATOR_DID` in `web.env` (and `PLC_URL` for
`following`/`extended`/`dynamic`); neither has a code default, and a missing
value answers `503` the same way.

There is no feed backfill table or worker task either: feeds read the HappyView
index, so a fresh deployment's feeds are empty until Jetstream, a HappyView
procedure write, or HappyView's existing `/admin/backfill` indexes activity for
a DID (see [`../xrpc.md`](../xrpc.md#feed-generator-edge)).

### Entity records

`0004-entity-records.sql` adds the contributor/publisher record columns, their
outbox triggers and the ref-bearing read models. It is additive and queues
nothing on its own: the trigger skips a NULL `at_uri`, and existing rows stay
NULL until the worker mints them.

After the schema is applied and the worker has the publisher credentials, run
the one-off rollout once:

```bash
node index.js --prepare-entities                   # mint + queue records and editions
node index.js --prepare-entities --phase=editions  # post-publish republish pass
```

The task (also enqueueable as `entities.prepare` with `{ "phase": "mint" }`)
mints `at://<ATP_SERVICE_DID>/net.olamaelcu.livtet.biblio.{contributor,publisher}/<tid>`
for every row that has no URI, queues the records, and queues the editions that
credit them. It is idempotent: a second run finds nothing to mint. Neither
phase publishes; `pds-publish` does, so the publisher session must be healthy
first. A row parks after ten failed publishes, and a stale token parks the
whole backlog (`ExpiredToken` parked 84 edition rows before this feature), so
renew `PDS_ACCESS_TOKEN`/the app password before running the entity pass.
Watch `bibliograph_pds_outbox_parked` while it drains.

What is created:

- `editions`, `edition_identifiers`, `contributors`, `edition_contributors`,
  `publishers`;
- `0007-edition-identifier-info.sql` adds `edition_identifier_info` (one shape
  claim row per identifier, cascading from `edition_identifiers`) and the
  `edition_identifier_shape` view, backfills each edition's language,
  publication date, format, pages and description onto its identifiers, and
  then drops those five columns from `editions`;
- `0008-edition-identifier-publishers.sql` adds `edition_identifier_publishers`
  (FK to `publishers`, cascading from `edition_identifiers`) and the
  `edition_publishers_shape` view, backfills each edition's publisher links onto
  every identifier, drops `edition_publishers`, and recreates the read models;
- `editions_tid_seq`, `editions_tid_encode()` and `editions_next_tid()` (new
  editions get a 13-character TID rkey, never an ISBN);
- `pds_outbox` (+ the ready index) and `pds_cids`;
- the provider caches `google_books_cache` and `isbndb_cache`;
- `provider_daily_usage` (`provider`, UTC `day`, `calls`), the per-provider
  daily call counter the worker reserves ISBNdb requests in;
- the outbox triggers for editions, identifiers, contributors, publishers and
  contributor/publisher renames;
- `0004-entity-records.sql` adds `contributors.at_uri` / `name_inverted` /
  `description` / `image_url` / `born` / `died` and `publishers.at_uri` /
  `description` / `image_url` / `started` / `ended`, the partial unique URI
  indexes, the identifier GIN indexes, and the generic `pds_enqueue_entity()`
  trigger for contributor/publisher records;
- `appview_book` and `appview_book_lua`.

### Why two read views

`appview_book` is the typed read model over the catalog tables (it exposes
`jsonb` and `timestamptz`). `appview_book_lua` is a text projection of it,
because HappyView's `db.raw`/Any driver cannot decode `jsonb` or
`timestamptz`: `series`, `contributors`, `publisher`, `publishers`,
`identifiers` and `created_at` arrive as JSON/timestamp **text**. The Lua
scripts (`happyview/lib/views.lua`, `edition_view`) read
`appview_book_lua`; the web catalog queries read the tables directly. Keep
both: they are different contracts over the same rows.

### HappyView read access

If the `happyview_app` role exists when the schema is applied, the bootstrap
grants it `USAGE` on `public`, `SELECT` on all tables/views, and default
`SELECT` privileges for future tables. If the role is created afterwards, run
the schema again (idempotent) or grant it explicitly:

```bash
psql "$DATABASE_URL" -c "GRANT USAGE ON SCHEMA public TO happyview_app"
psql "$DATABASE_URL" -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO happyview_app"
```

`packaging/happyview/db-init.sql` creates the role and the `happyview` schema;
run it before applying the catalog schema for a one-pass setup.

## 3. Start the processes

```bash
# worker: creates graphile_worker + catalog_enqueue_marks + provider_daily_usage,
# drains pds_outbox
DATABASE_URL=… ATP_SERVICE_DID=did:plc:… PDS_URL=… \
  PDS_ACCOUNT_DID=did:plc:… PDS_ACCOUNT_PASSWORD=… \
  pnpm --filter worker start

# edge: reads the catalog tables and proxies the public XRPC surface
DATABASE_URL=… HAPPYVIEW_URL=… pnpm --filter web start

# HappyView: owns the happyview schema and its activity tables
DATABASE_URL=postgres://happyview_app:…@localhost:5432/bibliograph …
```

The worker creates its own support objects (`catalog_enqueue_marks` and
`provider_daily_usage`); do not create Graphile's schema by hand. Without
publisher credentials the worker still hydrates the catalog and queues
`pds_outbox` rows — it logs that `pds-publish` is disabled and retries nothing
until credentials are supplied.

### Publisher credentials

Set these on the worker (and `PDS_URL` on the edge for record reads):

- `ATP_SERVICE_DID` — the `did:plc` account whose repo carries the editions. It
  is also the authority in every edition URI; fix it before the catalog grows.
- `PDS_URL` — the PDS that owns that account.
- `PDS_ACCOUNT_DID` — must equal `ATP_SERVICE_DID`.
- `PDS_ACCOUNT_PASSWORD` (app password) **or** `PDS_ACCESS_TOKEN`.

The PDS owns the repo signing key; no `ATP_SIGNING_KEY` is needed for catalog
publication. `ATP_SERVICE_HOST` is only the local/test `did:web` fallback when
`ATP_SERVICE_DID` is unset.

## 4. Verify the bootstrap

`mise run catalog-schema-check` creates a throwaway database, applies the SQL,
runs the worker ingest/claim/publish pieces against it, and drops it again. It
never touches `DATABASE_URL`'s own database beyond `CREATE/DROP DATABASE`:

```bash
mise run catalog-schema-check
```

In CI, pass the same explicit target: `CATALOG_DATABASE_URL=… mise run
catalog-schema-check`. The scratch database name includes the task's PID and is
dropped even when a test fails.

Expected result: 7 passing tests covering idempotent application, TID shape,
ingestion with contributor/publisher rows, the `appview_book_lua` text shape,
`claimBatch`/`completeEntry`/`pds_cids`, the outbox triggers for manifest edits,
and the delete path that clears the CID.

## 5. Let the catalog grow

No seed is loaded. The first client `community.lexicon.media.book.resolveEditions`
or `searchEditions` call either answers from the empty catalog or queues
worker hydration (`catalog.resolve` / `catalog.search` / `catalog.isbn`). The
worker fetches the provider responses, inserts an edition with a fresh TID,
links identifiers/contributors/publishers, and the triggers queue one
`pds_outbox` row. The minute cron (or the boot drain) publishes it to the
publisher PDS with `com.atproto.repo.applyWrites` and records the CID in
`pds_cids`.

There is no dependency on the previous production database, its drizzle
migrations, or the deleted combined package. The only external state is the
publisher account on `PDS_URL` and HappyView's own `happyview` schema.
