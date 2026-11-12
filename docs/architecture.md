# Architecture: two planes

Bibliograph is an AppView with a deliberately narrow seam:

- **Catalog/authoring plane (TypeScript).** Catalog tables are the mutable source
  of truth. Provider clients, enrichment, catalog publication, the feed
  generator and the public `/xrpc` gateway run here.
- **Activity plane (HappyView).** Jetstream + backfill index activity
  collections into `happyview_records`; Lua query scripts serve every activity
  query from that index.

One Postgres database holds both planes, in two schemas: `public` for the
catalog, `happyview` for HappyView's tables (a separate schema keeps
HappyView's unqualified tables, including `labels`, out of `public`).
Activity scripts join `appview_book_lua`, a text projection
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
`lib/views.lua` applies the identical table. Unknown role tokens pass through
because the lexicon's `knownValues` list is open.

New editions always get a TID rkey from `editions_next_tid()` (a 13-character
base32-sortable `[234567abcdefghijklmnopqrstuvwxyz]` string), minted in
`packages/worker/lib/ingest.js`; the rkey is never derived from a provider id or
an ISBN. Identity is the identifier bag: an ingest first looks up
`edition_identifiers` and updates any edition that owns one of the incoming
`(issuer, value)` pairs in place, adding the new pairs. Two different identifier
bags therefore mint two different TIDs, while re-resolving the same identifier
always lands on the same edition URI.

## Entity records

Contributors and publishers are published records too:
`net.olamaelcu.livtet.biblio.contributor` and
`net.olamaelcu.livtet.biblio.publisher`, both `key: tid`, both under the same
publisher authority as editions. Their fields mirror
`community.lexicon.media.book.defs#contributor` / `#publisher` (`displayName`,
`name`, `identifiers`) and add `description`, `imageUrl`, an optional `image`
blob (the catalog publishes the URL only; it does not own image bytes), and
strict `YYYY-MM-DD` dates (`born`/`died`, `started`/`ended`). Lexicon strings
cannot carry a regex, so the builders validate the pattern *and* the calendar
and reject `2023-02-29`, a partial date or a non-http image URL; the row parks
with the reason instead of publishing an invalid record.

A contributor or publisher row gets its address the first time it is written:
`linkContributors` / `linkPublisher` mint
`at://<authority>/<collection>/<tid>` in the same transaction as the row, and
the entity trigger queues the record. Rows that predate the feature have a NULL
`at_uri` and are minted once by `node index.js --prepare-entities` (the
`entities.prepare` worker task), which also queues the editions crediting them.
The task is idempotent; `--phase=editions` is the post-publish republish pass
for editions whose records were published before the refs existed.

Editions link to the records with `defs#contributor.ref` (already in the shared
lexicon) and a local `defs#publisher.ref` extension mirroring it. Both are
plain at-uris, not strongRefs: a CID would change on every entity edit and
force a republish of every edition that credits the entity. The per-edge
`edition_contributors.ref` override wins over the entity URI
(`COALESCE(ec.ref, c.at_uri)` in the read models). Renaming an entity changes
only its record; merging keeps the base row's URI, repoints the links, and
queues a delete for the absorbed record.

## Publication

Triggers on `editions`, its child tables, `contributors` and `publishers` write
`pds_outbox` rows for three collections: the edition record, the contributor
record and the publisher record. The `pds-publish` graphile task drains every
collection in one pass with `com.atproto.repo.applyWrites`; `pds_cids` records
the last published CID so the worker chooses create/update without a read. An
entity trigger skips a NULL `at_uri`, so applying the schema queues nothing by
itself.

The record value is rebuilt from the catalog at publish time — editions with
`buildEditionRecord` (`packages/worker/lib/edition-record.js`), entities with
`buildContributorRecord` / `buildPublisherRecord` (`entity-record.js`) — not
stored in `pds_outbox.value`.
Identifiers come from `edition_identifiers`, contributors from
`edition_contributors` + `contributors` in `position` order, and the single
publisher from the lowest-position `edition_publishers` row. `coverUrl` is a
URL only; catalog editions never embed blobs, so the publisher repo does not own
cover bytes. An edition without an identifier row is not lexicon-valid and the
publish is retried as a failure (the outbox row names the reason).

Ordering between collections is irrelevant: a missing `ref` target is optional
enrichment and self-heals on the next edition republish. Publication can only
drain while the publisher session is healthy; after ten failed attempts a row
parks, and the 0004 rollout therefore starts by renewing the PDS token (84 rows
were parked on `ExpiredToken` before this change).

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
(`resolveEditions`, `searchEditions`) and the seven entity methods
(`getContributor`, `getPublisher`, `listEditionsByContributor`,
`resolveContributors`, `resolvePublishers`, `searchContributors`,
`searchPublishers`) anonymously from the catalog tables; every `editionView`
they return carries the edition's atproto URI as an `atproto` identifier.
Entity reads include the last published CID on the two getters and never read a
PDS.
GET
`com.atproto.repo.getRecord` and `com.atproto.repo.listRecords` are proxied to
`PDS_URL`, so clients read publisher records through the edge. Everything else
is forwarded to HappyView, including the remaining `com.atproto.*` methods
(HappyView's own com.atproto proxy is authority-bound).

CORS covers the whole gateway, not just the edge-served reads: every valid
NSID gets a `204` preflight on `OPTIONS` (`Authorization`, `DPoP`, `content-type`
and `accept` allowed, `dpop-nonce` exposed) and every response — forwarded
HappyView and PDS calls included — carries `Access-Control-Allow-Origin: *`,
`Access-Control-Expose-Headers: dpop-nonce` and `Vary: Origin`. The headers are
applied once around the route's dispatch, grant no credentials (no cookies, no
`Access-Control-Allow-Credentials`), and never reflect the request origin.

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

Provider precedence is ISBNdb → Google Books → Goodreads → OpenLibrary, for
both ISBN lookups and text searches, stopping at the first provider that
returns candidates (no fan-out merge across providers). OpenLibrary's public
API needs no key, so it is the final fallback after the two keyed providers
and Goodreads. When `ISBNDB_API_KEY` is unset the chain starts at Google Books.
`googlebooks`, `openlibrary` and `goodreads` identifiers still resolve directly
against their own provider; OpenLibrary accepts edition (`OL…M`) and work
(`OL…W`) keys and expands a work through its editions endpoint.
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
Books, Goodreads then OpenLibrary. Cache hits do not reserve anything, and a failed HTTP
attempt keeps its reservation because the call was attempted (billing
semantics). `ISBNDB_DAILY_LIMIT` defaults to `5000` and must be a positive
integer; `0`/negative is invalid and falls back to `5000` with a warning — it is
not an "unlimited" switch.

OpenLibrary is keyless and uses `OPENLIBRARY_BASE_URL` (default
`https://openlibrary.org`). Edition search requests 40 documents with an
explicit `fields` list; `/isbn/<isbn>.json` and `/books/<key>.json` provide
editions, and a missing edition description is filled from the work record.
Author keys are expanded through `/authors/<key>.json` (bounded to ten names
per lookup, cached within that lookup). Requests carry a descriptive
User-Agent and pass through one serializing politeness gate; timeouts, retries
and the `openlibrary` breaker come from the shared provider HTTP layer. Author
search (`/search/authors.json`) and detail (`/authors/<key>.json`) both normalize
to read-only contributor candidates: `displayName`, optional `nameInverted`,
description, image URL, full `born`/`died` dates, an `openlibrary` author-key
identifier and reliable `remote_ids` (Wikidata, VIAF, ISNI, Goodreads, etc.).
The admin contributor search calls only the author-search endpoint; the detail
lookup (`author()`/`byAuthorKey()`) is provider-only and has no admin route or
UI. Search documents may therefore omit bio, photos and `remote_ids`. Partial
or ambiguous dates are omitted, and contributor candidates never carry edition
roles.

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
`0` when none). The same scrape collects process gauges
(`bibliograph_process_resident_memory_bytes`,
`bibliograph_process_cpu_seconds_total`, `bibliograph_process_uptime_seconds`,
`bibliograph_nodejs_heap_used_bytes`). In-memory provider
attempt/retry/request counters and breaker states are rendered by the same
worker. A scrape that cannot query the database answers `500`; a port that
cannot be bound is logged and leaves the worker running. The default loopback
bind keeps the endpoint off the network;
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
Query and procedure scripts live in `happyview/scripts/xrpc/`; `mise run hv-deploy`
runs `happyview/bin/hv-deploy` to upload the lexicons and scripts through
HappyView's admin API and apply the activity indexes (see `docs/happyview.md`).

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
- The admin UI is gated on `ADMIN_TOKEN`; there is no end-user login. Activity
  procedures require a DPoP session and write to the caller's PDS. The admin
  UI's provider search and ingest calls go to the
  worker's loopback admin API (`WORKER_ADMIN_HOST`:`WORKER_ADMIN_PORT`,
  default `127.0.0.1:9465`) with the same token. Edition merges run in a web
  server transaction against the catalog; the base keeps its URI, identifiers
  are unioned, and the duplicate editions are deleted only after every chosen
  field and link is applied.
- The admin edition editor lives at `/admin/edition/<rkey>/edit`; the same
  route accepts a URL-encoded edition at-URI. Its page load returns the full
  admin record (scalars, identifiers, contributor credits and publisher links)
  or 404, and reads through the shared catalog loader. Saving posts the whole
  record to `/admin/api/editions/<id>`; one transaction replaces the scalars,
  identifiers, contributor credits and publisher links, preserving the edition
  URI, rkey and `createdAt` as well as any contributor/publisher entity rows
  that remain selected. A new contributor or publisher is deduped by
  `lower(name)` plus its identifier bag, exactly like ingest, and gets an
  `at_uri` under the edition's own repo authority. Removing a credit deletes
  only the join row; shared entities are never deleted. The editor never
  writes `pds_outbox`: the catalog triggers queue the edition and any new or
  newly addressed entity records. A save that carries a stale `revision`
  (returned by the page load) answers 409, and the form keeps its unsaved state
  on every validation or conflict error.
- The admin UI also searches ISBNdb publisher names, previews one publisher's
  books through `GET /publisher/{name}` (paged, filtered by `publishedFrom`,
  `publishedTo` and `language`), and ingests either the selected candidates or
  1–5 whole pages per request. A bulk import is bounded and synchronous: each
  book commits in its own transaction, and the response reports how many were
  created, already indexed or failed, plus the page to resume from.
  Books without a checksum-valid ISBN-13 are excluded, because the ISBNdb
  candidate parser requires one.
- The admin UI and worker expose a read-only contributor search:
  `POST /admin/api/contributor-search` in the web edge forwards to the worker's
  `POST /contributor-search` with a bounded `q` (200 characters) and `limit`
  (1–50, default 20). It returns OpenLibrary author-search candidates for
  inspection; it does not expand each result through author detail, so bio,
  photo and external identifiers may be absent. There is deliberately no
  contributor detail route, import or write path.

## Lexicon provenance

`happyview/lexicons/community/lexicon/media/book/` is the source of truth for
the shared book NSIDs. It imports five files from
[lexicon.community PR #18](https://tangled.org/lexicon.community/lexicons/pulls/18/latest)
(`1f246574e733dfb37ef30637b97d8bbc371820a2`), which is open, not merged; four
are verbatim and `defs.json` adds the local `publisher.ref` extension described
below.
`vendor/books-wg-lexicons` is a separate upstream working-set submodule pinned
at `3bcee8e344681fc5251abf43537d2c13ba85ff94` for provenance only; no build
reads it, and its `defs.json`/`edition.json` predate the PR, so they must not
replace the imports. Update it with
`git -C vendor/books-wg-lexicons fetch && git -C vendor/books-wg-lexicons checkout <sha>`
and commit the gitlink.

Lexicons publish as `com.atproto.lexicon.schema` records with
`mise run publish-lex`. A repo write is not a namespace claim: consumers also
need `_lexicon.<authority>` TXT to name the publisher DID.
`com.atproto.lexicon.resolveLexicon` is not implemented by the PDS and is not
served by this edge. `defs#publisher.ref` is a local extension to PR #18 and
remains to be proposed upstream.

## Residual roadmap

- **Books-wg import sync.** Keep the PR #18 imports current and re-pin or
  remove `vendor/books-wg-lexicons` when upstream lands; propose
  `defs#publisher.ref` upstream. See [Lexicon provenance](#lexicon-provenance).
- **Batch edition lookup.** `net.olamaelcu.livtet.biblio.getEditions`
  (1–100 AT-URIs → `defs#bookView`) was planned but has no lexicon or handler.
  Implement it if it is still wanted.
