# Book Reviews Feed Implementation

## Overview
Implemented an ATProto feed generator using Constellation to expose reviews made of editions via `net.olamaelcu.livtet.bookReview` as a consumable feed for ATProto clients.

## Implementation Summary

### 1. Constellation Client Extension (`packages/bibliograph-service/src/lib/server/constellation/client.ts`)
- Added `ReviewSource = 'net.olamaelcu.livtet.bookReview:book'`
- Extended `GetBacklinksParams.source` to accept `ShelvingSource | ReviewSource`
- This enables the feed to query reviews via Constellation backlinks

### 2. DID Document Service (`packages/bibliograph-service/src/lib/server/did.ts`)
- Added `#atproto_feed` service entry to DID document:
  - `id: '#atproto_feed'`
  - `type: 'AtprotoFeedGenerator'`
  - `serviceEndpoint: `${PROTO}://${HOSTNAME}``

### 3. ATProto Feed Generator Endpoints (`packages/bibliograph-service/src/lib/server/xrpc-router.ts`)

#### Describe Feed Generator (`app.bsky.feed.describeFeedGenerator`)
- Registers feed generator metadata endpoint
- Returns publisher DID and feed URI: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed/reviews`
- Display name: "Book Reviews"
- Description: "Reviews of editions using net.olamaelcu.livtet.bookReview"

#### Get Feed Skeleton (`app.bsky.feed.getFeedSkeleton`)
- Returns paginated skeleton feed posts for reviews
- **DB-first approach**: Queries `net.olamaelcu.livtet.bookReview` and `net.olamaelcu.livtet.biblio.bookReview` collections
- **Constellation merge**: If feed URI contains a subject (edition), merges constellation backlinks with DB results using `getBacklinks({source:'net.olamaelcu.livtet.bookReview:book'})`
- Returns array of `{post: reviewURI, reason?: description}` with cursor for pagination

### 4. Feed URI Pattern
- General feed URI: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed/reviews`
- Subject-specific feed (optional): `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed/reviews/${editionRkey}`

### 5. Compatibility
- Existing `getReviewsByBook` handler unchanged
- Constellation backlinks support both shelving and review sources
- Feed gracefully falls back to DB-only pagination when Constellation queries fail

## Verification Commands

Run these commands against a running bibliograph service:

```bash
# Describe feed generator metadata
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/app.bsky.feed.describeFeedGenerator'

# Get feed skeleton (general reviews)
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed/reviews&limit=5'

# Get feed skeleton for specific edition (if Constellation backlink exists)
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed/reviews/abc123&limit=5'
```


## Bookhive entries

`buzz.bookhive.book` records are feed content alongside Bibliograph's own
reviews and shelving. One Bookhive record carries a review *and* a reading
status, so it is mirrored through TAP and rendered by collection:

| Collection | `reason` |
| --- | --- |
| `net.olamaelcu.livtet.bookReview`, `net.olamaelcu.livtet.biblio.bookReview` | the reviewed book at-uri |
| `net.olamaelcu.livtet.biblio.bookShelving` | `shelving:<shelf-rkey>` + `<book-uri>` |
| `buzz.bookhive.book` | `bookhive:<shelf-rkey>` + `<bh-edition-uri>` |

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

## Technical Details

### Schema Definitions
- Feed generator endpoints use inline valibot schemas from `@atcute/lexicons/validations`
- Schemas include proper NSID, parameter validation, and XRPC output types
- Follows existing bibliograph code patterns

### Data Sources
1. **Database**: Direct queries to `records` table for book reviews
2. **Constellation**: Backlink queries for edition-specific reviews
3. **Fallback**: DB-only pagination ensures reliability
4. **Reader PDS**: the follow graph behind `following` and `extended` (below)

## Social feeds and the follow graph

`at://…/feed.generator/{following,extended}` are filtered by who the viewer
follows, so they need the follow graph the reader actually maintains. Those
edges are `net.olamaelcu.livtet.biblio.follow` records in the **reader's own
repo** — livtet-service's FollowButton writes them there — and nothing mirrors
them into `records`: TAP subscribes to `net.olamaelcu.livtet.biblio.*` but the
consumer only persists `buzz.bookhive.book`.

The feed therefore reads them from the viewer's PDS:
`com.atproto.repo.listRecords` on `net.olamaelcu.livtet.biblio.follow`, up to
20 pages of 100, anonymously (the collection is public). `subject` is the
followed actor's at-uri; the DID is the first path segment.

The PDS read is the **only** source of the follow graph. There is no local
index: an unreadable repo yields an empty follow set and the feed degrades to
the general one.

There used to be one. A `follows` table, written by a
`net.olamaelcu.livtet.biblio.graph.follow` procedure that livtet-service called
after `writeFollowRecord` returned, was meant to keep the graph warm. It never
did: its DDL was written as `0011_follows.sql` but never entered
`meta/_journal.json`, and the migrator plans from the journal — so no
environment ever created the table, every `graph.follow` call failed with
`42P01`, and the platform swallowed it as a best-effort mirror failure.
`0021_follows` created it, then the feed moved to the repo as the sole source
and `0022_drop_follows` removed the table and the procedure with it.

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

## Future Considerations

### Feed Declaration Record
- A feed declaration record in the lex repo could provide canonical AT-URI
- Optional but recommended for production feed discovery

### Enhanced Constellation Integration
- Could pre-process Constellation backlink results for better merging with DB data
- Could support more complex edition-based filtering

### Performance Optimizations
- Pagination caching for general feed requests
- Pre-compiled edition-to-review mappings

## Files Modified

1. `packages/bibliograph-service/src/lib/server/constellation/client.ts`
2. `packages/bibliograph-service/src/lib/server/did.ts`
3. `packages/bibliograph-service/src/lib/server/xrpc-router.ts`

All changes are backward compatible and follow existing bibliograph code patterns.