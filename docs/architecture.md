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
  (`lxm = com.atproto.feed.getFeedSkeleton`).
- The admin UI is gated on `ADMIN_TOKEN`; there is no end-user login and no
  AppView write procedure.
