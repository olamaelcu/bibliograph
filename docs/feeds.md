# Book Reviews Feed Implementation

## Overview
Implemented an ATProto feed generator using Constellation to expose content made
of editions as a consumable feed for ATProto clients. The generator is
`net.olamaelcu.livtet.biblio.feed.generator`; callers hit
`com.atproto.feed.getFeedSkeleton` / `com.atproto.feed.describeFeedGenerator`
(the endpoints are `com.atproto.*`, not `app.bsky.*`). Nothing about the
pre-`biblio` review NSID is read any more; the pre-`biblio` collection is
deliberately not mirrored.

## Implementation Summary

### 1. Constellation Client Extension (`packages/bibliograph-service/src/lib/server/constellation/client.ts`)
- `ReviewSource = 'net.olamaelcu.livtet.biblio.bookReview:book.uri' | BookhiveSource`
  where `BookhiveSource = 'buzz.bookhive.book:hiveBookUri'`
- `GetBacklinksParams.source` accepts `BacklinkSource = ShelvingSource | ReviewSource | SocialSource`
- This enables the feed to query reviews via Constellation backlinks

### 2. DID Document Service (`packages/bibliograph-service/src/lib/server/did.ts`)
- The DID document carries a `#atproto_feed` entry:
  - `id: '#atproto_feed'`
  - `type: 'AtprotoFeedGenerator'`
  - `serviceEndpoint: `${PROTO}://${HOSTNAME}``

### 3. ATProto Feed Generator (`packages/bibliograph-service/src/lib/server/xrpc-router.ts`)

#### Describe Feed Generator (`com.atproto.feed.describeFeedGenerator`)
Returns the publisher DID and five feeds (display names as registered):

| rkey | displayName | requiresAuth |
| --- | --- | --- |
| `public` | Bibliograph Static Feed | no |
| `dynamic` | Bibliograph Dynamic Feed | yes (JWT) |
| `following` | Bibliograph Following Feed | yes |
| `extended` | Bibliograph Extended Network | yes |
| `recommendations` | Bibliograph For You | yes |

#### Get Feed Skeleton (`com.atproto.feed.getFeedSkeleton`)
Dispatches on the rkey in the `feed` param
(`at://<did>/net.olamaelcu.livtet.biblio.feed.generator/<rkey>`):
- `public` (alias `static`), `following`, `extended` — newest-first pages over
  `FEED_COLLECTIONS = [net.olamaelcu.livtet.biblio.bookReview, net.olamaelcu.livtet.biblio.bookShelving, buzz.bookhive.book]`
  from the mirror. Social feeds additionally filter by the viewer's follow set
  (PDS-authoritative; see below).
- `dynamic` — requires a service JWT (`requireFeedAuth`); per-DID rate limit, 429 + `retry-after: 60`.
- `recommendations` — requires auth; per-DID rate limit; ranked catalog page, no cursor (see "For You" below).
- `edition/{rkey}` — Constellation-first: merges `net.olamaelcu.livtet.biblio.bookReview:book.uri`
  backlinks for the edition (plus `buzz.bookhive.book:hiveBookUri` Bookhive reviews),
  falling back to the mirror only when backlinks are empty.
- Returns `{feed, cursor?, skeleton: [{post, reason?}]}`; `reason` is the book
  at-uri for reviews, `shelving:<shelf-rkey>|<book-uri>` for shelving, and
  `bookhive:<shelf-rkey>|<edition-uri>` for Bookhive records (pipe-separated,
  not `+`).

### 4. Feed URI Pattern
- `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/{public|dynamic|following|extended|recommendations}`
- Edition-specific: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/edition/{rkey}`

### 5. Compatibility
- `getReviewsByBook` handler unchanged
- Feed gracefully falls back to DB-only pagination when Constellation queries fail (edition feed only)

## Verification Commands

```bash
# Describe feed generator metadata
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/com.atproto.feed.describeFeedGenerator'

# Get feed skeleton (public feed)
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/com.atproto.feed.getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed.generator/public&limit=5'

# Get feed skeleton for a specific edition
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/com.atproto.feed.getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed.generator/edition/abc123&limit=5'
```


## Bookhive entries

`buzz.bookhive.book` records are feed content alongside Bibliograph's own
reviews and shelving. One Bookhive record carries a review *and* a reading
status, so it is mirrored through TAP and rendered by collection:

| Collection | `reason` |
| --- | --- |
| `net.olamaelcu.livtet.biblio.bookReview` | the reviewed book at-uri |
| `net.olamaelcu.livtet.biblio.bookShelving` | `shelving:<shelf-rkey>\|<book-uri>` |
| `buzz.bookhive.book` | `bookhive:<shelf-rkey>\|<edition-uri>` |

The edition-specific feed additionally merges Bookhive reviews of the same
edition through Constellation source `buzz.bookhive.book:hiveBookUri`, resolving
the edition's `bookhive` identifier to the catalog record that is the backlink
subject.

## Ordering

Feed and listing queries sort by the record's own `value.createdAt`, newest
first, with the record `uri` breaking ties. Ordering by the mirror's
`records.indexed_at` ordered by *when TAP reached us*, so a replay or a backfill
pushed year-old records to the head of the feed; the writer's stamp is the order
a feed claims to have.

The key is the `records.record_created_at` **generated column** (`coalesce(value->>'createdAt', '')`),
shared by `getFeedSkeleton`, `listRecentShelving`, `listBooksOnShelf`, `listShelves`,
`getReviewsByBook` and `listReviewsByActor` through
`src/lib/server/db/record-recency.ts`. `getEditionsByContributor` sorts on
`editions.created_at`, which ingest already writes from the catalog record, with
its own index. The key is a column rather than an expression
because sorting on `value->>'createdAt'` cannot use an index: the cast to
`timestamptz` is STABLE, so Postgres accepts it in neither a generated column nor
an index expression, and the guard that made casting safe turned every request
into a scan and sort of the whole table (45-50 ms locally, 2-4 s on a loaded
host) against 0.4 ms for the index scan.

Canonical atproto `datetime` values are UTC ISO-8601, whose lexicographic order is
chronological order — the column stores that text for exactly this reason. A
record without a `createdAt` gets a blank key, which sorts after every dated one
under `desc`, so the order stays total and `listRecentShelving` can always take
its keyset cursor from the last row.

## Social feeds and the follow graph

`at://…/feed.generator/{following,extended}` are filtered by who the viewer
follows, so they need the follow graph the reader actually maintains. Those
edges are `net.olamaelcu.livtet.biblio.follow` records in the **reader's own
repo** — livtet-service's FollowButton writes them there. TAP subscribes to
`net.olamaelcu.livtet.biblio.*` and mirrors these into `records` like any other
collection, from which `follows` is materialized (one row per follower →
followed pair) for the `graph.listFollowers` / `graph.listFollowees` queries.

The feed therefore reads them from the viewer's PDS:
`com.atproto.repo.listRecords` on `net.olamaelcu.livtet.biblio.follow`, up to
20 pages of 100, anonymously (the collection is public). `subject` is the
followed actor's at-uri; the DID is the first path segment.

The feed reads the **repo**, not `follows`, because the repo is authoritative
and cannot lag: a follow made a second ago counts immediately, and a follow
written by a repo this TAP instance never registered is still seen. An
unreadable repo yields an empty follow set and the feed degrades to the general
one.

`follows` exists for the reverse direction, which the PDS cannot answer at all:
"who follows me" would otherwise mean scanning every repo. It was first created
as `0021_follows.sql`, which never entered `meta/_journal.json` (the migrator
plans from the journal) so no environment ever executed it, and
`0022_drop_follows` retired it. `0028_follows_restore` brings it back with a
one-time `INSERT … SELECT` over `records`; `scripts/backfill-follows.ts` fills
gaps from Constellation for repos outside this TAP's subscription; and
`tapRecordUpsert{,Batch}Task` / `tapRecordDelete{,Batch}Task` keep it in step.

## "For You" recommendations

`at://…/feed.generator/recommendations` answers a different question from the
activity feeds: which catalog books should this reader pick up next? It reads
the reader's own shelf, ranks the catalog by shared genres, and returns books
they have never shelved.

**Reading data.** `bookShelving` (`metadata.status`, falling back to the shelf
rkey), `shelfItem` (custom shelves, exclusion only) and `bookReview` (a review
is proof the book was read) are read from the viewer's PDS, not the mirror —
same reason as the follow graph above. Three bounded `listRecords` scans, 100
per page, 10 pages each, cached per DID for 60 s (512 entries). An unreadable
repo yields an empty feed rather than the whole catalog.

**Ranking.** `works.subjects` is the genre/tag vocabulary the catalog ingests
from Google Books. For each seed set — books in `reading`, then
books in `read` — the query collects the seeds' subjects, scores every work that
shares at least one by how many it shares, and joins back to that work's
editions. Active-read matches lead the page, the past-read matches follow, and a
book reachable from both lists appears once.

Embeddings would rank better, but this service has no model runtime and no
vector column: every embedding path would mean an in-process download plus a
full catalog re-embed on deploy. Subject overlap is the documented fallback and
needs only the catalog already in Postgres. The join back to editions is indexed
by `editions_work_uri_idx` (migration `0025`); without it every "For You" read
scanned the catalog. A work with no edition linked is skipped before the cap, so
link-less works cannot fill the page.

**Skeleton shape.** This is the one generator whose `post` is a catalog edition
rather than a record in someone's repo — a recommendation has no author and no
`createdAt`. `reason` is the literal `recommendation`, and the client renders a
book card instead of hydrating a repo record. It is a single page of at most 30
books with no cursor: the answer is a ranked set, not a stream.

**Auth.** `requiresAuth: true`; `getFeedSkeleton` calls `requireFeedAuth` and
the same per-DID rate limit as the `dynamic` generator.

## How a caller names the viewer

`following` and `extended` need a DID, and two proofs supply one
(`viewerDidFromRequest`):

| Caller | Mechanism |
| --- | --- |
| livtet-service (server-to-server) | `Authorization: Bearer <service JWT>` |
| Bibliograph storefront (same origin) | `bib_session` cookie set by `/oauth/callback` |

livtet-service holds no Bibliograph cookie. It mints a service auth token on the
**reader's own PDS** with `com.atproto.server.getServiceAuth`
(`aud=<publisher>#atproto_feed`, `lxm=com.atproto.feed.getFeedSkeleton`), which
requires the `rpc:com.atproto.feed.getFeedSkeleton?aud=<publisher>#atproto_feed`
OAuth grant, and attaches it as a bearer token in `graph-client.ts`
`upstreamRequest`. Both paths converge on the same DID before any feed query
runs.

`extended` adds 2 hops: the follow sets of the hop-1 members, read from their
own PDSes in batches of 8 and cut off at 500 candidates, unioned with any
hop-1 edges in the local table and minus the viewer and hop-1 members.
Successful reads are memoised for 60 s (capped at 512 DIDs) because one
request can touch hundreds of repos; a failed read is never memoised as an
empty follow set.

### Error Handling
- Constellation backlink errors are logged but don't break the feed
- Database queries handle missing or malformed review data gracefully
- Pagination continues working even with partial data sources
- An unreadable or unresolvable PDS degrades the social feeds to the general
  feed — never to an error

## Open item
- No `feed.generator` declaration record is published for any of the six rkeys
  yet; `describeFeedGenerator` is discovery enough for now.