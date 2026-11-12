# Architecture: two planes

Bibliograph is an AppView with a deliberately narrow seam:

- **Catalog/authoring plane (TypeScript).** Catalog tables are the mutable source
  of truth. Provider clients, enrichment, edition publication, the labeler, the
  feed generator, image routes and the public `/xrpc` gateway run here.
- **Activity plane (HappyView).** Jetstream + backfill index activity
  collections into `happyview_records`; Lua query scripts serve every activity
  query from that index.

One Postgres database holds both planes, in two schemas: `public` for the
catalog, `happyview` for HappyView's tables (its `labels` table collides with the
labeler's otherwise). Activity scripts join `appview_book_lua`, a text projection
of `appview_book` over the catalog tables, because HappyView's `db.raw` cannot
decode jsonb or timestamptz columns. No other catalog coupling exists at read
time. Catalog editions are published to the publisher PDS by an outbox
worker; activity records stay in each reader's own PDS.

## Catalog identity

Editions are the record type. Contributors and publishers are entities linked
through `edition_contributors` / `edition_publishers`, and identifiers live in
`edition_identifiers` as exact `(issuer, value)` pairs. The inline
contributor/publisher/identifier arrays exist only in two places:

- `buildEditionRecord` in `packages/worker/lib/edition-record.js` when
  publishing `community.lexicon.media.book.edition`;
- `appview_book`, the read model HappyView joins against.

That keeps a contributor rename or merge to one row instead of every edition
that credits it.

The storage columns predate lexicon.community PR #18: `contributors.name` holds
the display name and `edition_contributors.role` may hold either an ONIX
Codelist 17 code or a legacy kebab-case token (`author`, `foreword`, …). No
migration rewrites them. Every lexicon boundary maps to the current shape:
`buildEditionRecord` emits `displayName` and a code, the edge's
`editionView` (`contributor-roles.ts`) does the same, and HappyView's
`prelude.lua` applies the identical table. Unknown role tokens pass through
because the lexicon's `knownValues` list is open.

New editions always get a TID rkey from `editions_next_tid()` (a 13-character
base32-sortable `[234567abcdefghijklmnopqrstuvwxyz]` string), minted in
`packages/worker/lib/ingest.js`; the rkey is never derived from a provider id or
an ISBN. Identity is the identifier bag: an ingest first looks up
`edition_identifiers` and updates any edition that owns one of the incoming
`(issuer, value)` pairs in place, adding the new pairs. Two different identifier
bags therefore mint two different TIDs, while re-resolving the same identifier
always lands on the same edition URI.

## Publication

Triggers on `editions` and its child tables write `pds_outbox` rows. The
`pds-publish` graphile task drains them into the publisher PDS with
`com.atproto.repo.applyWrites`; `pds_cids` records the last published CID so the
worker chooses create/update without a read. Only editions are published — there
are no work, contributor or publisher records.

The record value is rebuilt from the catalog at publish time
(`packages/worker/lib/edition-record.js`), not stored in `pds_outbox.value`.
Identifiers come from `edition_identifiers`, contributors from
`edition_contributors` + `contributors` in `position` order, and the single
publisher from the lowest-position `edition_publishers` row. `coverUrl` is a
URL only; catalog editions never embed blobs, so the publisher repo does not own
cover bytes. An edition without an identifier row is not lexicon-valid and the
publish is retried as a failure (the outbox row names the reason).

The authority in the URI is the publisher identity: `ATP_SERVICE_DID`, else
`did:web:<ATP_SERVICE_HOST>`. New editions mint their URI from that identity,
so it must not change once the catalog is populated. Production must set
`ATP_SERVICE_DID` to the `did:plc` publisher account; the `did:web` form is the
fallback for local and test environments.

Fresh-start policy: this deployment uses the `did:plc` publisher authority.
Editions and `pds_outbox` rows minted under a previous `did:web` authority
belong to a different repo and are not migrated. `pds-publish` refuses any row
whose URI authority is not the configured publisher DID, so discard them: start
from a fresh database, or clear the catalog tables and `pds_outbox`. No seed or
import is performed. The catalog grows organically through XRPC traffic — a
miss queues worker hydration, which mints editions under the configured
authority — so publication needs only the configured publisher account.

A fresh deployment needs no old database and no old service: the catalog schema
is created from `packages/worker/sql/` (`mise run catalog-schema`), which also
creates the `appview_book`/`appview_book_lua` read models. See
[`operations/fresh-database.md`](operations/fresh-database.md).

The public `/xrpc` gateway serves the two read-only books-wg procedures
(`resolveEditions`, `searchEditions`) anonymously from the catalog tables, with
CORS because Livtet calls them from the browser; every `editionView` they
return carries the edition's atproto URI as an `atproto` identifier. GET
`com.atproto.repo.getRecord` and `com.atproto.repo.listRecords` are proxied to
`PDS_URL`, so clients read publisher records through the edge. Everything else
is forwarded to HappyView, including the remaining `com.atproto.*` methods
(HappyView's own com.atproto proxy is authority-bound).

Because those two procedures are anonymous and each queued hydration job can
spend up to 50 paid provider lookups, the edge caps enqueueing at 10 hydration
jobs per request (`MAX_HYDRATION_JOBS_PER_REQUEST`). The 100-identifier input
cap is unchanged and every identifier is still matched; only the first 10
misses are queued per call. The cap is per request, not a global quota, so it
bounds the provider cost of a single body but does not rate-limit the caller.

## Feed generator

`com.atproto.feed.describeFeedGenerator` and `com.atproto.feed.getFeedSkeleton` are served by the
edge (`packages/web/src/lib/server/feeds/`), not HappyView: a skeleton is one SQL query over
`happyview.happyview_records` for `community.lexicon.media.book.review` and
`net.olamaelcu.livtet.biblio.bookStatus`, ordered newest first by the record's own `createdAt` and
then `uri`. There is no worker task and no Lua script for feeds.

The generator DID is `FEED_GENERATOR_DID`; it is required configuration with no code default, and
its feed URIs are `at://<FEED_GENERATOR_DID>/net.olamaelcu.livtet.biblio.feed.generator/<kind>` for
`public`, `following`, `extended` and `dynamic`; `recommendations` is dropped. `public` is
anonymous. The other three require an atproto service JWT whose compact signature verifies against
the issuer DID document's `#atproto` Multikey (ES256K/ES256), with `aud` exactly
`<FEED_GENERATOR_DID>#atproto_feed` and `lxm` exactly `com.atproto.feed.getFeedSkeleton`; `did:plc`
issuers resolve through `PLC_URL`, which is required for those feeds and has no code default,
`did:web` through its standard document URL, and both are cached
briefly. When `FEED_GENERATOR_DID` is unset both feed methods answer `503 ServiceUnavailable`;
when `PLC_URL` is unset the three personalized feeds answer `503` while `public` keeps working.
A missing or invalid token is `401`, never a silent public page. `following` pages records
by DIDs the viewer follows (excluding the viewer), `extended` adds their followees (capped at 500
DIDs), and `dynamic` is the viewer plus their follow set.

`packages/worker/sql/0003-feed-read.sql` adds the
`(collection, (record::jsonb->>'createdAt') DESC, uri DESC)` and follow-subject indexes and grants
the web role `USAGE`/`SELECT`; it is conditional on HappyView having created the table, so a fresh
catalog-only database skips it.

## Catalog worker

`packages/worker` is the only long-running catalog process. Graphile Worker owns
its job table (`graphile_worker.jobs`) and the edge enqueues jobs there when
`catalog_enqueue_marks` exists; without the worker the edge still serves reads
and skips enqueueing. The edge queues at most 10 hydration jobs per request, so
one anonymous call cannot turn its full identifier list into paid provider work.

| Task | Trigger | Work |
| --- | --- | --- |
| `catalog.resolve` | edge on a resolution miss (`job_key` deduped, 24 h TTL) | provider lookup → ingest up to 50 candidates into the identifier bag |
| `catalog.search` | edge on a catalog search (`job_key` deduped, 1 h TTL) | provider search → ingest up to 50 candidates |
| `catalog.isbn` | edge on `searchEditions` with ISBN identifiers (`job_key` `isbn:<isbn13>` deduped, 24 h TTL) | direct ISBNdb by-ISBN lookup → ingest up to 50 candidates; falls back to the resolve chain when ISBNdb is unconfigured or returns nothing |
| `pds-publish` | graphile cron every minute, plus once at boot | drain `pds_outbox` into the publisher PDS |

Provider precedence is ISBNdb → Google Books → Goodreads for ISBN lookups, and
ISBNdb → Google Books → Goodreads for text searches, stopping at the first
provider that returns candidates (no fan-out merge across providers). When
`ISBNDB_API_KEY` is unset the chain starts at Google Books. `googlebooks` and
`goodreads` identifiers still resolve directly against their own provider.
`CANDIDATES_PER_TASK = 50` in `packages/worker/lib/tasks.js` bounds each task;
Google Books asks for its maximum page (`maxResults=40`) and ISBNdb search asks
for `pageSize=50` (the API's default is 20), so a single provider call can be
shorter than the cap.

ISBNdb is the only metered provider, so it has a hard daily cap. After a cache
miss and before the HTTP request, the client atomically reserves one call in
`provider_daily_usage` (`provider`, UTC `day`, `calls`) with
`INSERT … ON CONFLICT (provider, day) DO UPDATE SET calls = calls + 1 WHERE calls < $limit RETURNING calls`.
The primary key makes the reservation safe across worker processes and
restarts, and an empty `RETURNING` means the quota is exhausted. In that case
the provider makes no network call, logs one warning per process per UTC day,
and returns an empty result so the normal fallback chain continues with Google
Books then Goodreads. Cache hits do not reserve anything, and a failed HTTP
attempt keeps its reservation because the call was attempted (billing
semantics). `ISBNDB_DAILY_LIMIT` defaults to `5000` and must be a positive
integer; `0`/negative is invalid and falls back to `5000` with a warning — it is
not an "unlimited" switch.

The worker starts a dependency-free Prometheus endpoint on
`WORKER_METRICS_HOST:WORKER_METRICS_PORT` (default `127.0.0.1:9464`) serving
`/metrics`. `bibliograph_worker_up` is `1` while the process answers. Each
scrape reads the database and exposes the ISBNdb quota gauges
`bibliograph_isbndb_calls_today`, `bibliograph_isbndb_daily_limit` and
`bibliograph_isbndb_calls_remaining` (`max(0, limit - calls)`), plus the outbox
backlog for the configured publisher DID: `bibliograph_pds_outbox_ready`
(claimable now: same collection, `attempts < 10`, due and unleased),
`bibliograph_pds_outbox_parked` (`attempts >= 10`) and
`bibliograph_pds_outbox_oldest_age_seconds` (age of the oldest claimable row,
`0` when none). In-memory provider attempt/retry/request counters and breaker
states are rendered by the same worker. A scrape that cannot query the
database answers `500`; a port that cannot be bound is logged and leaves the
worker running. The default loopback bind keeps the endpoint off the network;
set `WORKER_METRICS_HOST=0.0.0.0` only for a container/host scraper and
firewall the port accordingly (see `prometheus.yml`).

The web edge serves its own dependency-free `/metrics` on the same loopback
listener as the app (`127.0.0.1:5176`); it is not exposed by the public vhost,
whose nginx config denies an exact-match `/metrics` `location`. The SvelteKit
`handle` hook records `bibliograph_http_requests_total` and
`bibliograph_http_request_duration_seconds` with the matched route id, verb and
status; the XRPC surface records `bibliograph_happyview_requests_total`,
`bibliograph_pds_proxy_requests_total`, `bibliograph_catalog_queries_total`,
`bibliograph_catalog_query_duration_seconds` and
`bibliograph_feed_requests_total`. Each scrape also collects process gauges
(`bibliograph_process_resident_memory_bytes`,
`bibliograph_process_cpu_seconds_total`, `bibliograph_process_uptime_seconds`,
`bibliograph_nodejs_heap_used_bytes`). Labels are bounded: route ids come from
the route manifest, XRPC methods outside a fixed allowlist collapse to `other`,
and no metric carries a URL, identifier, query or other user input. Prometheus
scrapes both loopback endpoints directly; no new environment variable is
required.

`pds-publish` claims at most 25 ready rows for its configured publisher DID per
batch with `FOR UPDATE SKIP LOCKED` and a five-minute lease, so several worker
processes can share the database. Claiming writes `claimed_at`; the PDS call happens outside a
transaction. Completion deletes the outbox row and upserts `pds_cids` from the
returned CID in one transaction, guarded by the row's `updated_at`, so a trigger
that rewrites the row mid-publish leaves the newer state queued instead of
swallowing it. A failed publish increments `attempts`, clears `claimed_at`,
records `last_error`, and schedules `next_at = now() + 60s × 2^attempts` (capped
at one hour). `attempts < 10` is part of the claim predicate, matching the
partial `pds_outbox_ready_idx`: after ten failures the row is parked and stays
visible for an operator. Requeue it with:

```sql
UPDATE pds_outbox SET attempts = 0, next_at = now(), last_error = NULL
 WHERE uri = 'at://…';
```

Publishing authenticates as an account on `PDS_URL`, not with a repository
signing key: the PDS already owns that key. Set `PDS_ACCOUNT_DID` and
`PDS_ACCOUNT_PASSWORD` (an app password) for a `com.atproto.server.createSession`
session, or `PDS_ACCESS_TOKEN` (+ optional `PDS_REFRESH_TOKEN`) for a
provisioned session. The session account must be the publisher DID, because
`applyWrites` writes to that account's repo. With credentials missing the
worker logs `pds-publish is DISABLED` with the exact missing settings, still
runs the hydration tasks, and leaves rows queued; the task itself fails loudly
if invoked. It never no-ops or reports fake success.

Local development runs the worker against the local Postgres with `mise run
worker` (or `pnpm worker:dev`). The local tranquil PDS issues `did:plc`
accounts and has `selfHostedDidWebEnabled: false`, so set `ATP_SERVICE_DID` to
that account to mint edition URIs under it; the default `did:web` authority
cannot be hosted there. Hydration works without publisher credentials, while a
live `pds-publish` also needs the publisher account provisioned on the PDS.
Rows minted under a previous authority are discarded, not migrated (see the
fresh-start policy above). Publisher behaviour is tested against a stub PDS in
`packages/worker/test/publish.test.js`.

Packaging: `mise run package-worker-payload` stages plain ESM plus its
production dependencies with `pnpm deploy --prod`, and `mise run
package-worker-deb` builds `bibliograph-worker`, which installs the payload at
`/usr/lib/bibliograph-worker` and its conffile at
`/etc/bibliograph/worker.env`. The unit runs it with the host's nodejs and
`StateDirectory=bibliograph`; the payload needs no pnpm, tsx or build toolchain.

## Activity

Indexed collections: `net.olamaelcu.livtet.biblio.{bookStatus,shelf,shelfItem,follow,readingGoal}`,
`net.olamaelcu.livtet.actor.profile` and `community.lexicon.media.book.review`.
Query scripts lived in the deleted package's `happyview/scripts/`; uploads now
go through HappyView's admin API (see `docs/happyview.md`).

No request path reads a user's PDS or a backlink service. A record missing from
the index is reported missing and repaired by backfill/reconcile, not by an
inline fallback.

## Authentication

- `X-Client-Key` identifies the calling application and is the rate-limit
  bucket. It is not user authentication.
- Personalized feed skeletons authenticate with an atproto service JWT
  (`lxm = com.atproto.feed.getFeedSkeleton`). The edge verifies the signature against the issuer's
  `#atproto` Multikey and enforces `aud`, `lxm`, `iss` and `exp`/`iat`; it never trusts a
  caller-supplied viewer DID header.
- The admin UI is gated on `ADMIN_TOKEN`; there is no end-user login and no
  AppView write procedure. Its provider search and ingest calls go to the
  worker's loopback admin API (`WORKER_ADMIN_HOST`:`WORKER_ADMIN_PORT`,
  default `127.0.0.1:9465`) with the same token. Edition merges run in a web
  server transaction against the catalog; the base keeps its URI, identifiers
  are unioned, and the duplicate editions are deleted only after every chosen
  field and link is applied.
- The admin UI also searches ISBNdb publisher names, previews one publisher's
  books through `GET /publisher/{name}` (paged, filtered by `publishedFrom`,
  `publishedTo` and `language`), and ingests either the selected candidates or
  1–5 whole pages per request. A bulk import is bounded and synchronous: each
  book commits in its own transaction, and the response reports how many were
  created, already indexed or failed, plus the page to resume from.
  Books without a checksum-valid ISBN-13 are excluded, because the ISBNdb
  candidate parser requires one.
