# Bibliograph

Bibliograph is the book catalog and [ATProto AppView][appview] for
[Livtet][livtet]. It owns **book identity** — canonical edition, contributor and
publisher records in `community.lexicon.media.book`, with identifier bags,
provider enrichment and publication from a `did:plc` publisher account — and it
indexes **cross-user reading activity** (shelves, shelf items, statuses,
reviews, follows, reading goals) from readers' own PDSes. Publishing editions is
one output of the catalog, not the whole product: the goal is a shared catalog
plus an activity view over records that readers already own.

## Planes and ownership

| Plane | Code | Owns |
| --- | --- | --- |
| Edge | `packages/web` | SvelteKit (`adapter-node`): public `/xrpc` gateway, catalog and entity reads, feed generator, admin UI, `com.atproto.repo` read proxy, metrics |
| Catalog worker | `packages/worker` | graphile-worker: provider hydration, ingest, entity preparation, `pds-publish`, loopback admin API |
| Activity | `happyview/` | HappyView 2.17.4: Jetstream/backfill indexing and Lua activity queries/procedures |
| PDS | external | the publisher repo (catalog records) and each reader's repo (activity records) |
| Database | one Postgres | `public` catalog tables; `happyview` activity index |

The separation is deliberate. Catalog tables are the mutable source of truth
for book identity; the publisher PDS holds a published projection. Each
reader's PDS is the source of truth for their activity, and `happyview_records`
is a rebuildable index, never authoritative. No activity query reads a PDS
inline: missing rows are repaired by backfill/reconcile. There is no catalog
write XRPC method; only the activity procedures write records, to the caller's
PDS.

## Architecture

One Postgres database holds two schemas. `public` contains `editions` and its
identifier/contributor/publisher tables, the provider caches and usage counter,
`pds_outbox`, `pds_cids`, and the typed `appview_book` view with its text
projection `appview_book_lua`. `happyview` contains HappyView's tables,
including `happyview_records` (`uri`, `did`, `collection`, `rkey`, `record` as
JSON text, `created_at`).

The seam exists because HappyView's `db.raw`/Any driver cannot decode `jsonb`
or `timestamptz`, so Lua joins `appview_book_lua` (text series, contributors,
publishers, identifiers and timestamps) while web catalog queries read the
relational tables directly. It also matches shapes: mutable relational identity
with enrichment versus record-shaped activity HappyView already indexes and
pages. No other catalog coupling exists at read time.

Publishing is an outbox flow: catalog triggers queue `pds_outbox`; the
`pds-publish` worker rebuilds each record from the catalog, writes it to the
publisher PDS, and records the CID in `pds_cids`. Activity procedures write to
the caller's PDS and HappyView indexes the accepted record in the same request;
records written straight to a PDS arrive through Jetstream or a backfill.

## Records

| Collection | Key strategy | Writer | Source of truth |
| --- | --- | --- | --- |
| `community.lexicon.media.book.edition` | `tid` (minted by `editions_next_tid()`) | publisher worker | `editions` + identifier/contributor/publisher tables |
| `net.olamaelcu.livtet.biblio.contributor` | `tid` | publisher worker | `contributors` + `edition_contributors` |
| `net.olamaelcu.livtet.biblio.publisher` | `tid` | publisher worker | `publishers` + `edition_publishers` |
| `net.olamaelcu.livtet.biblio.shelf` | `any`; custom shelves use TID, fixed status shelves are virtual rkeys | reader / `shelf.create` | reader PDS |
| `net.olamaelcu.livtet.biblio.shelfItem` | `tid`; one edge per (shelf, book), found by `record.shelf` + `record.book.uri` | reader / `shelf.addItem` | reader PDS |
| `net.olamaelcu.livtet.biblio.bookStatus` | `tid`; one status per (reader, edition), found by `record.book.uri` | reader / `status.set` | reader PDS |
| `net.olamaelcu.livtet.biblio.follow` | `tid`; unique by `subject` | reader / `graph.follow` | reader PDS |
| `net.olamaelcu.livtet.biblio.readingGoal` | literal `current` | reader / `readingGoal.set` | reader PDS |
| `net.olamaelcu.livtet.actor.profile` | literal `self` | reader / `profile.set` | reader PDS |
| `community.lexicon.media.book.review` | `tid` | reader / `review.*` | reader PDS |

Catalog identifiers are exact `(issuer, value)` pairs in
`edition_identifiers`; an ingest updates an existing edition when any incoming
pair is already owned, otherwise it mints a new TID. The edition record inlines
contributors and one publisher on the wire, but the catalog stores them as
entities linked by join tables, so a rename or merge touches one row. Edition
records link entities with plain at-URI `ref` values, not strongRefs, so an
entity edit does not force every crediting edition to republish.

Follows are the one activity key with legacy history. New records use a TID
rkey and `graph.follow` enforces one follow per subject. Older rows may store
the subject as `did:…` or `at://did:…` and may use the subject DID as the rkey;
reads accept both spellings, and `graph.unfollow`/the dev seed can still remove
them.

## XRPC surface

The lexicon set is **22 queries, 19 procedures and 10 record types**. Nine
methods are anonymous, edge-served catalog reads:

- `community.lexicon.media.book.resolveEditions` and `searchEditions` — the
  shared books-wg procedures, answered from catalog tables;
- `net.olamaelcu.livtet.biblio.getContributor`, `getPublisher`,
  `listEditionsByContributor`, `resolveContributors`, `resolvePublishers`,
  `searchContributors` and `searchPublishers` — the contributor/publisher
  methods added with entity records. The getters and listings/searches are
  `GET`; the resolvers are `POST`. They read catalog tables (the two getters
  also read `pds_cids`) and never a PDS.

CORS covers the whole XRPC gateway, not only those nine methods. Any valid
NSID answers `OPTIONS` with a `204` preflight allowing `content-type`,
`authorization`, `dpop` and `accept`, exposing `dpop-nonce`, and every response
— catalog, feed generator, PDS proxy, forwarded HappyView call, or an error —
carries `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers:
dpop-nonce` and `Vary: Origin`. The origin is never reflected and no
credentials are allowed; an invalid NSID is still `400 InvalidRequest` (with
the headers).

The remaining methods are HappyView's **17 activity queries** and **15 activity
procedures** (profiles, goals, shelves, shelf items, statuses, reviews, follow
graph). Each procedure requires a DPoP-bound caller session, writes to that caller's PDS, and indexes the accepted record in the same request.

`com.atproto.feed.describeFeedGenerator` and `getFeedSkeleton` are also served
at the edge from `happyview_records`: `public` is anonymous, and `following`,
`extended` and `dynamic` require a service JWT whose `aud` is
`<FEED_GENERATOR_DID>#atproto_feed`. `FEED_GENERATOR_DID` and (for the
personalized feeds) `PLC_URL` are required configuration with no code default.

Only `GET com.atproto.repo.getRecord` and `GET com.atproto.repo.listRecords`
are proxied to `PDS_URL`. Every other `com.atproto.*` method goes to
HappyView. The full request/response contract is in
[`docs/xrpc.md`](docs/xrpc.md).

## Providers

Catalog hydration uses **ISBNdb → Google Books → Goodreads → OpenLibrary**,
stopping at the first provider that returns candidates, for both ISBN lookups
and text searches. OpenLibrary is keyless and public, so it is the final
fallback after the two keyed providers and Goodreads. `googlebooks`,
`openlibrary` and `goodreads` identifiers
resolve directly against their own provider (`openlibrary` accepts edition
`OL…M` and work `OL…W` keys); without `ISBNDB_API_KEY` the chain starts at
Google Books. Each worker task ingests at most 50 candidates.

OpenLibrary uses `https://openlibrary.org` by default (override with
`OPENLIBRARY_BASE_URL`), needs no API key, sends a descriptive User-Agent and
serializes requests through a polite gate. Edition search asks for 40 results
with an explicit field list; an ISBN lookup expands the edition's work for a
missing description and its author keys for contributor names. Author search
(`/search/authors.json`) and author detail (`/authors/<key>.json`) both normalize
to contributor candidates. The read-only admin search at
`POST /admin/api/contributor-search` calls the author-search endpoint only, so
its results may lack bio, photo and external identifiers; author detail is
exposed by the provider (for a later lookup) but has no admin route or UI. The
endpoint returns descriptive candidates and cannot import or publish
contributors. Date fields accept only unambiguous full dates; a partial or
unparseable birth/death date is omitted.

Google Books and ISBNdb answers are cached in Postgres (`google_books_cache` /
`isbndb_cache`). ISBNdb is metered: after a cache miss the worker atomically
reserves a call in `provider_daily_usage` for the UTC day, and
`ISBNDB_DAILY_LIMIT` (default `5000`) is a hard cap; exhaustion skips the
network call and falls through. Tasks are `catalog.resolve`, `catalog.search`
and `catalog.isbn`; the edge caps request-triggered hydration at 10 jobs per
call. Operator curation is at `/admin` (gated by `ADMIN_TOKEN`) and calls the
worker's loopback admin API.

## Development

The local stack is Postgres, a local PLC directory, a local PDS, Mailtrap Local,
Caddy and HappyView, all from `docker compose`; the edge listens on
`http://127.0.0.1:5176`, the HappyView dashboard on
`http://127.0.0.1:3000`, and the Mailtrap Local inbox on
`http://127.0.0.1:3550`.

```bash
docker compose up -d          # postgres, plc, pds, mailtrap, caddy, happyview, prometheus
mise run catalog-schema       # apply packages/worker/sql/*.sql (idempotent)
mise run catalog-seed 10      # ten public-domain editions from Project Gutenberg
mise run hv-account && mise run hv-seed && mise run hv-ca  # account, keys, CA
mise run hv-deploy            # upload HappyView lexicons/scripts, apply indexes
mise run hv-fixtures          # seed accounts + activity, backfill, verify
mise run dev                  # edge (:5176) + catalog worker
```

`mise run web` and `mise run worker` start one process each; `mise run sql` opens psql. HappyView creates its activity tables; `catalog-schema` creates the catalog/read views, and the feed-index SQL no-ops until `happyview_records` exists.

`catalog-seed` comes before `hv-fixtures` because the catalog owns no data: every
edition arrives through the worker's ingest from a provider, while `hv-fixtures`
reads catalog editions and joins them to published CIDs. On a fresh stack the
fixtures have nothing to shelve until the catalog has editions. Seeding ingests
them from Project Gutenberg; the running worker's `pds-publish` publishes each
record (and its contributors/publishers) within a minute.

```bash
mise run catalog-schema-check # scratch-database schema + worker integration tests
mise run hv-test              # syntax-check and unit-test the Lua scripts
mise run publish-lex          # publish lexicons as com.atproto.lexicon.schema records
pnpm web:check && pnpm web:test && pnpm worker:test && pnpm verify:lex
```

### Local email

Mailtrap Local is a loopback-only SMTP sink, inbox and JSON API. Compose pins
the `mailtrap/mailtrap-local` image and publishes SMTP on
`127.0.0.1:3535` and the UI/API on `127.0.0.1:3550`; there is no account,
credential or external mail service. The PDS relays every notification through
`[email.smarthost]` in `docker/pds-config.toml` (`host = "mailtrap"`,
`port = 3535`, `tls = "none"`), sends from
`noreply@pds.127-0-0-1.sslip.io`, and persists captured messages in the
`mailtrapdata` volume. The sandbox accepts `@example.invalid` recipients and
nothing leaves the machine.

Open `http://127.0.0.1:3550` for the inbox, or use
`http://127.0.0.1:3550/api/v1/messages` and
`http://127.0.0.1:3550/api/v1/message/{id}`. The seed fixtures start
unverified, so trigger verification rather than password reset; the PDS only
sends password-reset mail to a verified address.

```bash
DID=$(curl -sk 'https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.identity.resolveHandle?handle=seed-01.pds.127-0-0-1.sslip.io' | jq -r .did)
curl -sk -X POST https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.server.resendVerification \
  -H 'content-type: application/json' -d "{\"did\":\"$DID\"}"
curl -s 'http://127.0.0.1:3550/api/v1/messages' |
  jq '.messages[] | {id, subject, to: [.to[].address]}'
```

Fetch a message by `id` to read its full text, and clear the inbox with
`DELETE /api/v1/messages` when stale mail gets in the way. Full commands are in
[`docs/dev-environment.md#local-email`](docs/dev-environment.md#local-email).

## Operations and limits

- **Fresh start.** No migration, import or seed: run `mise run catalog-schema`
  on an empty database and let XRPC traffic grow the catalog. Fix the `did:plc`
  authority (`ATP_SERVICE_DID`) before the first edition; rows minted under
  another authority are not migrated.
- **Publisher prerequisites.** Publishing needs `ATP_SERVICE_DID`, `PDS_URL`,
  `PDS_ACCOUNT_DID` equal to that DID, and a password or `PDS_ACCESS_TOKEN`.
  Without them hydration still runs, `pds-publish` logs that it is disabled,
  and rows stay queued; failures back off and park after ten attempts.
- **Entity rollout.** New contributor/publisher rows mint their URI and queue a
  record at write time. Older rows need `node index.js --prepare-entities`
  (worker task `entities.prepare`), then `--phase=editions` after publishing.
- **No image blobs.** Catalog records carry `coverUrl`/`imageUrl` only. The
  publisher repo does not own image bytes, and the worker has no `uploadBlob`.
- **Legacy follows** remain readable and removable through the `subject` and
  URI fallbacks described above; new writes always use TID rkeys.
- **Deployment is explicit.** The development loop is local; `mise run deploy`
  is a separate build-and-install to a host, not part of `mise run dev`. There
  is no labeler endpoint or image-byte route in this tree.

## Documentation

See [`architecture.md`](docs/architecture.md) for the seam, publication and
lexicon provenance; [`xrpc.md`](docs/xrpc.md) for the endpoint contract;
[`operations/fresh-database.md`](docs/operations/fresh-database.md) for the
empty-database bootstrap; [`operations/backfills.md`](docs/operations/backfills.md)
for the dry-run/apply catalog rewrite scripts; and
[`dev-environment.md`](docs/dev-environment.md) for local accounts, fixtures and
admin curation.

[appview]: https://atproto.com/guides/glossary#app-view
[livtet]: https://livtet.olamaelcu.net
