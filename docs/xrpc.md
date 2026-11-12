# XRPC surface: current behavior

This document is the behavioral spec of the XRPC surface the AppView serves today: what each
method accepts, what it reads, how it paginates, what it writes, and which errors it can produce.
It is drawn from the deployed lexicons in `happyview/lexicons` and the handler scripts in
`happyview/scripts/xrpc/{query,procedure}`. The same lexicons generate the public page in
`packages/web`.

The surface is the set of uploaded lexicons plus the book lexicons imported from
[lexicon.community PR #18](https://tangled.org/lexicon.community/lexicons/pulls/18/latest) into
`happyview/lexicons/community/lexicon/media/book/` and the edge-served entity lexicons under
`happyview/lexicons/net/olamaelcu/livtet/biblio/`: **22 queries, 19 procedures and 10 record
types**. Nine methods are anonymous catalog reads served by the edge in `packages/web`: the two
books-wg procedures (`community.lexicon.media.book.resolveEditions` and `searchEditions`) and the
seven entity methods under `net.olamaelcu.livtet.biblio.*` (`getContributor`, `getPublisher`,
`listEditionsByContributor`, `resolveContributors`, `resolvePublishers`, `searchContributors`,
`searchPublishers`). The other 15
procedures are HappyView procedures that write to a caller's PDS. Everything except the review and
edition record types lives under
`net.olamaelcu.livtet.biblio.*`. HappyView's built-in `com.atproto.*` routes are not part of this
surface — they proxy to an authority DID that the local network does not resolve. The edge proxies
exactly two read-only `com.atproto` methods, `repo.getRecord` and `repo.listRecords`, to the PDS.

## Conventions

**Transport.** Queries are `GET /xrpc/<nsid>`; procedures are `POST /xrpc/<nsid>` with a JSON body.
Every call reaches HappyView through the SvelteKit edge (`packages/web/src/routes/xrpc/[...method]`),
which:

- accepts `GET` and `POST`; `OPTIONS` is answered as a `204` CORS preflight for every valid NSID,
  including methods that are only forwarded, and other verbs are `405 MethodNotAllowed`;
- rejects a path that is not a plausible NSID with `400 InvalidRequest`;
- relays only `content-type`, `accept`, `authorization` and `dpop` upstream, and adds its own
  `X-Client-Key`/`X-Client-Secret` from the environment (the browser cannot choose them);
- returns the upstream status and body unchanged, with only `content-type` and `dpop-nonce` relayed
  back — except a script's failure envelope. A handler cannot choose an HTTP status, so `fail()`
  returns `{ __bib_http: { status, body } }` and HappyView writes that table as a `200`. The edge
  unwraps exactly that shape — a `200` whose whole body is the single key, whose `status` is a
  4xx/5xx integer, and whose `body` is an object — and answers with the status it names, which is
  what makes every error in the tables below reach a caller as the status it says;
- answers `502 UpstreamUnavailable` when HappyView cannot be reached.

Read-only publisher-record calls are the one exception to the HappyView path: `GET
com.atproto.repo.getRecord` and `GET com.atproto.repo.listRecords` are proxied to
`${PDS_URL}/xrpc/<nsid>` with the caller's query string verbatim, relaying only `accept` and
`content-type` upstream and returning the PDS's status, body and content type. A network failure or
timeout is `502 UpstreamUnavailable`; an unset `PDS_URL` is `503 ServiceUnavailable` with a message
naming the missing setting. Every other `com.atproto.*` method still goes to HappyView.

**CORS.** CORS covers the entire gateway, not only the edge-served catalog methods: a browser
preflights a forwarded HappyView procedure too, because the call sends `Authorization` and `DPoP`.
`OPTIONS /xrpc/<nsid>` on any valid NSID answers `204` with `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: content-type,
authorization, dpop, accept`, `Access-Control-Max-Age: 86400`, `Access-Control-Expose-Headers:
dpop-nonce` and `Vary: Origin`. Every response from the route — catalog, entity, feed generator,
PDS proxy, HappyView proxy, and the `400`/`404`/`405`/`502`/`503` errors — carries
`Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: dpop-nonce` and `Vary: Origin`.
The origin is never reflected: the value is always `*`. No credentials are allowed
(`Access-Control-Allow-Credentials` is never sent and no cookie is needed); the surface
authenticates with the `Authorization`/`DPoP` headers, which CORS permits without credentialed
mode. A path that is not an NSID remains `400 InvalidRequest`, and that JSON error carries the
headers as well.

The two books-wg procedures never reach HappyView: the edge dispatches them on NSID and answers them
from the catalog tables (`editions`, `edition_identifiers`, `edition_contributors`,
`edition_publishers`). They are `POST` by lexicon and reject `GET` with `405 MethodNotAllowed`.
They never write catalog rows; when the local catalog cannot answer, they may queue a hydration job
and mark it in `catalog_enqueue_marks`.

The seven entity methods never reach HappyView either. They read `contributors` / `publishers` /
`edition_contributors` (plus `pds_cids` for the last published CID on the two getters) and never
read a PDS or write a row. The two getters, the editions-by-contributor listing and the two searches
are `GET`; the two resolvers are `POST` because the identifier array travels in a JSON body. A wrong
verb is `405 MethodNotAllowed`. They do not queue hydration: contributor and publisher rows are only
populated by ingest and catalog curation.

The feed generator is also served at the edge, from `happyview.happyview_records`, never from
HappyView. `GET com.atproto.feed.describeFeedGenerator` is anonymous and advertises exactly four
feeds; `GET com.atproto.feed.getFeedSkeleton` serves their skeletons. Both are `GET`-only — `POST`
on either NSID is `405 MethodNotAllowed` like every other non-GET verb. The generator DID is
`FEED_GENERATOR_DID`, which is required and has no code default; the feed URIs are
`at://<FEED_GENERATOR_DID>/net.olamaelcu.livtet.biblio.feed.generator/<kind>` for `public`,
`following`, `extended` and `dynamic`. When `FEED_GENERATOR_DID` is unset both methods answer
`503 ServiceUnavailable`. There is no `recommendations` feed.

**Auth.** Queries are anonymous. HappyView procedures require a DPoP-bound session:
`Authorization: DPoP <token>` plus a fresh `DPoP` proof. The edge holds no session and cannot mint
one; it relays both headers untouched, and the token needs `transition:generic` because the write is
proxied to the caller's PDS. Without a session those 15 procedures answer `401` with
`XRPC procedures require DPoP authentication` before the handler runs. Handlers see the session as
`caller_did`; every procedure that names an existing review or shelf compares it against
`caller_did` and answers `403 Forbidden` on a mismatch.

The nine catalog methods are the exception: they are read-only and anonymous, and they never
require or read a session. They also need `DATABASE_URL`; when it is unset or the catalog is
unreachable they answer `503 ServiceUnavailable` instead of proxying anywhere.

Feed skeletons have their own contract: `public` is anonymous, while `following`, `extended` and
`dynamic` require an atproto service JWT in `Authorization: Bearer <jwt>`. The edge verifies the
compact JWT against the issuer DID document's `#atproto` Multikey (ES256K or ES256), requires
`iss` to be a DID, `aud` exactly `<FEED_GENERATOR_DID>#atproto_feed`, `lxm` exactly
`com.atproto.feed.getFeedSkeleton`, and sane `iat`/`exp`. `did:plc` issuers resolve through
`PLC_URL`, a required setting with no code default (`did:web` through its standard document URL),
and both are cached briefly. When `PLC_URL` is unset or blank the three personalized feeds answer
`503 ServiceUnavailable` before authentication or any query; `public` does not need it.
A missing or invalid token is `401 AuthRequired`; the request never falls back
to the public feed. No `x-viewer-did` header is trusted.

Anonymous queries are still attributed to the edge's XRPC client key, which is the rate-limiting
and attribution identity.

**Data source.** Queries read only the index, `happyview_records`
(`uri`, `did`, `collection`, `rkey`, `record` as JSON text, `created_at`). They never read a PDS.
Anything the index has not seen yet is absent until a backfill or reconcile indexes it; a procedure
does not have that gap because it indexes the record it just wrote in the same request.

`resolveEditions` and `searchEditions` are the other exception: they read the catalog tables, not
`happyview_records`, and they never write catalog rows. Provider fan-out (Google Books, ISBNdb,
Goodreads) runs asynchronously in the worker (`catalog.resolve` / `catalog.search` / `catalog.isbn`),
not in the request; the response is the local catalog only and says nothing about that queued work.

**Catalog dependency.** Book-rendering views join `public.appview_book_lua`, the catalog read model:

- `bookShelfView` needs a resolvable catalog edition, a resolvable shelf record persisted in
  `happyview_records`, and a status (`metadata.status`, or the fixed-shelf rkey);
- `shelfItemView` needs the edition and the shelf.

A row whose edition or shelf cannot be resolved is **dropped** from list responses; where a single
record is named (`getBookOnShelf`), it is a `404 RecordNotFound`. A status whose `metadata.status` is
missing is inferred from the fixed shelf rkey (`reading`, `read`, `to-read`, `dnf`) when the
record's shelf is one of them.

**Cursors.** Cursors are base64url-encoded JSON objects. A malformed cursor decodes to `{}` and
starts at the beginning rather than erroring — except the feed generator's cursor, which is strict
and answers `400 InvalidRequest` when it is not the expected `{c,u}` object.

| Encoding | Meaning | Methods |
| --- | --- | --- |
| `{ "o": <offset> }` | offset, advanced by the number of **emitted** rows (`limit`); the `limit + 1` probe row only decides whether another page exists | `getReviewsByBook`, `listReviewsByActor`, `listShelfItems`, `listShelfItemsByBook`, `getShelvingOfBook` |
| `{ "t": <created_at>, "u": <uri> }` | keyset over `(created_at, uri)`, descending | `listBooksOnShelf`, `listRecentShelving` |
| `{ "u": <uri> }` | keyset over `uri`, ascending; for `getShelversOfBook` it is the smallest URI seen per DID | `listShelves`, `listShelvesWithBooks`, `getShelversOfBook` |
| `{ "o": <offset> }` | offset, advanced by the emitted page size | `listEditionsByContributor`, `searchContributors`, `searchPublishers` |
| raw DID | keyset over the follower DID, ascending | `graph.listFollowers` |
| raw rkey | keyset over the follow record's opaque TID rkey, ascending | `graph.listFollowees` |
| `{ "c": <createdAt>, "u": <uri> }` | keyset over the record's own `createdAt` (text order) and `uri`, descending; `c` may be `null` for a row without `createdAt` | `com.atproto.feed.getFeedSkeleton` |

A cursor is emitted only when the `limit + 1` probe row exists. An offset cursor advances by
`limit`, the page size actually emitted: the next call starts at the probe row instead of skipping
it. Because list mapping can drop unbuildable rows, a page can return fewer than `limit` views while
the next call still continues from the same scanned page boundary; keyset cursors likewise advance
from the last scanned row, not the last emitted view. A decoded offset that is negative, NaN or
non-numeric restarts at 0, and a float is floored and capped by `MAX_OFFSET` before it reaches SQL.

**Limits.** Every `limit` is clamped to the lexicon's range by the handler (`clamp_int(value,
default, min, max)`), so an out-of-range number is adjusted, not rejected. A non-finite value falls
back to the default. The feed generator defaults to 20 and clamps to 1–100; a non-integer `limit` is
`400 InvalidRequest`.

**Errors.** The envelope is `{ "error": string, "message": string }`.

| Status | Error | Origin |
| --- | --- | --- |
| 400 | `InvalidRequest` | a required parameter is missing, or a value violates its contract: non-DID `subject`, self-follow, non-AT-URI shelf/review URI, wrong collection, bad enum (`status`, `period`), out-of-range integer, empty update, invalid `editionRef`, non-strongRef `book` |
| 400 | `InvalidQuery` | `searchEditions` without a nonblank `q`, `title`, `author` or identifier; `searchContributors` / `searchPublishers` without a nonblank `q` |
| 401 | `XRPC procedures require DPoP authentication` | the 15 HappyView procedures, until a DPoP session is presented |
| 401 | `AuthRequired` | a personalized feed (`following`/`extended`/`dynamic`) without a valid service JWT |
| 403 | `Forbidden` | the named review or shelf belongs to another DID |
| 404 | `NotFound` | a procedure targets a follow, review, shelf, `bookStatus` or `shelfItem` that does not exist |
| 404 | `RecordNotFound` | `getShelf` / `getBookOnShelf` record missing; `getBookOnShelf` also when the catalog edition is missing; `getContributor` / `getPublisher` / `listEditionsByContributor` when no catalog row has the URI |
| 405 | `MethodNotAllowed` | the edge, for any verb other than GET/POST/OPTIONS, for `POST` on the two feed methods, and for `GET` on the two books-wg procedures and the two entity resolvers |
| 502 | `UpstreamFailure` | any procedure when the PDS rejects a save, delete or batch |
| 502 | `UpstreamUnavailable` | the edge, when HappyView is unreachable, or when a PDS-proxied read fails or times out |
| 503 | `ServiceUnavailable` | the edge, when `DATABASE_URL` is unset or the catalog query fails (the two books-wg procedures, the seven entity methods, `getFeedSkeleton`), or when `PDS_URL` is unset (`repo.getRecord` / `listRecords` only) |

Queries, the nine catalog methods and the `public` feed never answer `401`. Missing optional
records are not errors: `getActorProfile` and `getReadingGoal` answer `200` with `null`.

**Views.** Responses embed the lexicon's view types from `net.olamaelcu.livtet.biblio.defs`:
`shelfView` (`uri`, `name`, optional `description`/timestamps), `bookView` (`uri`, `edition`),
`bookShelfView` (`uri`, `shelf`, `book`, `metadata`, `did`, optional timestamps), `shelfItemView`
(same shape), `shelfWithBooksView` (`shelf`, `books`), and `reviewView`
(`uri`, `did`, `record`). `edition` is the `community.lexicon.media.book.defs#editionView` built
from the catalog.

The entity methods use `defs#contributorView` and `defs#publisherView`: `uri` plus the record's
fields (`displayName`/`name`, optional `description`, `imageUrl`, `identifiers`, the strict
`YYYY-MM-DD` dates, `createdAt`). The two getters also return `cid`, the last published record CID
from `pds_cids`; list responses omit it. `image` is present only when the published record carries
a blob the publishing repo owns (the catalog emits `imageUrl` only).

`listEditionsByContributor` items use `defs#bookView` (`uri` plus the edition's `editionView`), the
same shape the activity queries embed, so the client can render and link the edition directly.

Every `editionView` in `resolveEditions` / `searchEditions` carries the edition's atproto URI as an
identifier: `{ "issuer": "atproto", "value": "at://<did>/community.lexicon.media.book.edition/<rkey>" }`,
first in `identifiers` and exactly once. The view type has no `uri` field, so this identifier is the
link back to the record and resolves through `com.atproto.repo.getRecord` with
`collection=community.lexicon.media.book.edition`; clients derive display routes such as
`/book/<did>/<rkey>` from it (the display path may drop the collection, but the at-uri is the
authoritative record reference). Stored identifiers follow it unchanged (`issuer`/`value`, no
bookkeeping columns).

Contributors in every `editionView` (and in a review's `subject`) use the PR #18 shape:
`displayName` is required, `nameInverted` is optional, and `role` is an ONIX Codelist 17 code
(default `A01`). Rows ingested under the old draft carried `name` and kebab-case roles; the edge
and HappyView map them on output, so clients never need to know the storage form.

`editionResults` is exactly the upstream envelope: `{ items, hasMore, total? }`, with no
`pending`/`degraded` field, so a response cannot tell a client that catalog hydration is
outstanding. The two catalog procedures still queue `catalog.resolve` / `catalog.search` work for
unmatched input (hydration enqueueing is capped at 10 jobs per request; see the catalog discovery
section), and that work may add editions matching a later identical request, but the only way to
learn about it is to re-call: there is no ETag, conditional-request, stream, or subscription
signal. Queued work is not a promise that anything will be found.

## Inventory

### Queries

| NSID | Params | Returns |
| --- | --- | --- |
| `getActorProfile` | `did` | `{ profile }` — raw `net.olamaelcu.livtet.actor.profile` record or `null` |
| `getReadingGoal` | `did` | `{ goal }` — raw `readingGoal` record or `null` |
| `getShelf` | `uri` | `{ shelf }` |
| `listShelves` | `did`, `limit` 50 (≤100), `cursor` | `{ shelves, cursor? }` |
| `listShelvesWithBooks` | `did?`, `limit` 50 (≤100), `booksPerShelf` 25 (≤100), `cursor` | `{ shelves: [{ shelf, books }], cursor? }` |
| `getBookOnShelf` | `uri` | `{ bookShelf }` |
| `listBooksOnShelf` | `shelf`, `limit` 50 (≤100), `cursor` | `{ bookShelves, cursor? }` |
| `getShelvingOfBook` | `book`, `did`, `limit` 50 (≤100), `cursor` | `{ bookShelves, cursor? }` |
| `getShelversOfBook` | `bookUri`, `shelvingRkey?` (≤512), `limit` 50 (≤100), `cursor` | `{ bookUri, dids, cursor? }` |
| `listRecentShelving` | `limit` 50 (≤100), `cursor` | `{ bookShelves, cursor? }` |
| `listShelfItems` | `shelf`, `limit` 50 (≤100), `cursor` | `{ items, cursor? }` |
| `listShelfItemsByBook` | `book`, `did`, `limit` 50 (≤100), `cursor` | `{ items, cursor? }` |
| `getReviewsByBook` | `book`, `limit` 25 (≤100), `cursor` | `{ reviews, cursor? }` |
| `listReviewsByActor` | `did`, `limit` 25 (≤100), `cursor` | `{ reviews, cursor? }` |
| `graph.isFollowing` | `follower`, `followed` | `{ following }` |
| `graph.listFollowers` | `did`, `limit` 100 (≤1000), `cursor` | `{ followers, total, cursor? }` |
| `graph.listFollowees` | `did`, `limit` 100 (≤1000), `cursor` | `{ followees, total, cursor? }` |
| `getContributor` | `uri` (at-uri) | `{ contributor }` |
| `getPublisher` | `uri` (at-uri) | `{ publisher }` |
| `listEditionsByContributor` | `contributor` (at-uri), `limit` 25 (≤100), `cursor` | `{ items, cursor?, total? }` |
| `searchContributors` | `q`, `limit` 25 (≤100), `cursor` | `{ items, cursor? }` |
| `searchPublishers` | `q`, `limit` 25 (≤100), `cursor` | `{ items, cursor? }` |

### Procedures

The nine catalog methods are anonymous reads over the catalog tables. The other fifteen require a
DPoP session and write to the caller's PDS, then index the accepted record in `happyview_records` in
the same request.

| NSID | Input | Returns |
| --- | --- | --- |
| `community.lexicon.media.book.resolveEditions` | `identifiers[]` (required), `offset` 0, `limit` 25 (≤100) | `editionResults` |
| `community.lexicon.media.book.searchEditions` | `q?`, `title?`, `author?`, `identifiers[]?`, `offset` 0, `limit` 25 (≤100) | `editionResults` |
| `resolveContributors` | `identifiers[]` (required, ≤100), `offset` 0, `limit` 25 (≤100) | `{ items, hasMore, total? }` |
| `resolvePublishers` | `identifiers[]` (required, ≤100), `offset` 0, `limit` 25 (≤100) | `{ items, hasMore, total? }` |
| `graph.follow` | `subject` (DID) | `{ uri, created }` |
| `graph.unfollow` | `subject` (DID) | `{ uri }` |
| `profile.set` | `displayName?` (≤640), `description?` (≤256), `avatarCid?` | `{ uri }` |
| `readingGoal.set` | `period`, `year`, `booksGoal` | `{ uri, period, year, booksGoal }` |
| `shelf.create` | `name` (≤128), `description?` | `{ uri }` |
| `shelf.update` | `shelf`, `name?` (≤128), `description?` | `{ uri, updated }` |
| `shelf.delete` | `shelf` | `{ deleted }` |
| `shelf.addItem` | `shelf`, `book` (strongRef), `metadata?` | `{ uri }` |
| `shelf.removeItem` | `shelf`, `book` (strongRef or `{uri}`) | `{ uri }` |
| `shelf.addBooks` | `shelf`, `books[]` (≤100 strongRefs) | `{ added, failed }` |
| `status.set` | `book` (strongRef), `status`, `shelf?`, `metadata?` | `{ uri, status }` |
| `status.clear` | `book` (strongRef or `{uri}`) | `{ uri }` |
| `review.create` | `subject` (editionRef), `rating?`, `textContent?`, `subjectRecord?`, `content?`, `flags?` | `{ uri }` |
| `review.update` | `uri`, plus any of the `review.create` fields | `{ uri, updated }` |
| `review.delete` | `uri` | `{ uri }` |

## Query behavior

### Reader records

#### `getActorProfile`

Reads the index at `at://<did>/net.olamaelcu.livtet.actor.profile/self` and returns the decoded record
object as `profile`. A missing (or unparseable) record is `200 { profile: null }`; no PDS read
happens, so a profile the index has not seen is reported missing. `did` is required and may not be
an empty string. The lexicon's optional `handle` is not served today: the handler emits only
`profile`.

#### `getReadingGoal`

Reads the index at `at://<did>/net.olamaelcu.livtet.biblio.readingGoal/current` and returns the
decoded record object as `goal`, or `null`. `did` is required and may not be empty.

### Follow graph

Follow rows are `net.olamaelcu.livtet.biblio.follow` records. The record key is an opaque TID;
`graph.follow` enforces uniqueness by looking up `subject` before writing. The lexicon types
`subject` as a DID, but legacy rows may store the full `at://<did>` form and may keep the subject DID
as their rkey; the read queries match either spelling against the indexed full-subject expression.
`listFollowees` pages on `rkey` but derives the followed DID from `subject`.

#### `graph.isFollowing`

One probe of the follower's follow collection filtered by either subject spelling returns
`{ following }`. Both DIDs are required and may not be empty. The graph is public data; `follower`
and `followed` name whose edge to read, not the caller.

#### `graph.listFollowers`

Rows whose `subject` is `did` or `at://did`, ordered by the follower DID (`record.did`) ascending,
keyset `did > cursor`. `total` is the full follower count and is emitted on every page, including
pages with a cursor and empty pages; a full page emits the last follower DID as the cursor.

#### `graph.listFollowees`

Rows whose record DID equals `did`, ordered by the record's opaque TID rkey ascending, keyset on the
same column. The emitted `did` is read from `record.subject` (legacy `at://did` is normalized to
`did`); a row without a DID-shaped subject is omitted from the page. `total` is the full followee
count over the same DID-shaped subject rows and is emitted on every page. A full page emits the
last TID rkey as the cursor. `followedAt` falls back to the indexed `created_at` when the record
body has no `createdAt`. A cursor that is not a 13-character TID (for example a pre-TID DID cursor)
restarts the page instead of skipping rows.

### Shelves

#### `getShelf`

Looks up `net.olamaelcu.livtet.biblio.shelf` at `uri` and returns `{ shelf }` as a `shelfView`.
A `name` is not required in storage: the view falls back to the fixed-shelf label for the rkeys
`reading`, `read`, `to-read`, `dnf`, then to the record's `name`, then to the rkey. Missing record:
`404 RecordNotFound`.

#### `listShelves`

Pages the DID's shelf records ordered by `uri` ascending, keyset `uri > cursor`, and returns
`{ shelves, cursor? }`. Fixed reading-status shelves appear only when a record exists at their
fixed rkey; nothing is derived.

#### `listShelvesWithBooks`

Pages shelf records ordered by `uri` ascending (optionally scoped to `did`), then runs one query per
shelf for its `bookStatus` rows ordered by `uri`, capped at `booksPerShelf`, and sorts each shelf's
books by `metadata.position` ascending (positions absent sort last), then `uri` ascending. Returns
`{ shelves: [{ shelf, books }], cursor? }`. Rows whose edition or shelf cannot be resolved are
dropped.

### Shelf items

#### `listShelfItems`

Pages `net.olamaelcu.livtet.biblio.shelfItem` rows whose `record.shelf` equals `shelf`, scoped to the
DID parsed from the shelf URI, ordered `uri` ascending, offset cursor, and returns `{ items }` of
`shelfItemView`. The handler validates that `shelf` is an AT-URI (`400 InvalidRequest`).

#### `listShelfItemsByBook`

The same page, filtered by `record.book.uri` and the explicit `did`, ordered `uri` ascending, offset
cursor.

### Shelving (book status)

`net.olamaelcu.livtet.biblio.bookStatus` is the reading-status record: one per (reader, edition),
rkey = the edition rkey. `metadata.status` is required by the view.

#### `getBookOnShelf`

Looks up the `bookStatus` record at `uri` and returns `{ bookShelf }`. Missing record is
`404 RecordNotFound`; an unresolvable catalog edition or shelf record is also `404 RecordNotFound`,
with the book URI in the message.

#### `listBooksOnShelf`

Pages the DID's `bookStatus` rows whose `record.shelf` equals `shelf` (the DID is parsed from the
shelf URI), keyset `(created_at, uri)` descending, and returns `{ bookShelves, cursor? }`. The
lexicon declares `NotFound`; the handler returns an empty page instead.

#### `getShelvingOfBook`

Pages one reader's `bookStatus` rows where `record.book.uri` equals `book`, ordered `uri` ascending,
offset cursor. Returns `{ bookShelves, cursor? }`.

#### `getShelversOfBook`

Groups `bookStatus` rows by `did` for a `(shelvingRkey, book URI)` pair and pages the groups by
`min(uri)` ascending, returning `{ bookUri, dids, cursor? }`. `shelvingRkey` defaults to the last
path segment of `bookUri` (the edition rkey), matching the record-key contract.

#### `listRecentShelving`

The network-wide activity read: `bookStatus` rows across all readers, keyset `(created_at, uri)`
descending, `{ bookShelves, cursor? }`. It takes no DID parameter and is not scoped by account.

### Reviews

Reviews are `community.lexicon.media.book.review` records; `reviewView` returns the raw record.

#### `getReviewsByBook`

Pages reviews that either name the book in `subjectRecord` or share an identifier with the edition's
`identifiers` bag in `appview_book_lua`, ordered `created_at` descending, `uri` descending, offset
cursor. Returns `{ reviews, cursor? }`. The activity plane reads no other catalog table. The lexicon
declares `NotFound`; the handler returns an empty page.

#### `listReviewsByActor`

Pages one DID's reviews, same ordering and cursor. Returns `{ reviews, cursor? }`.

### Feed generator (edge)

Both `com.atproto.feed.*` methods are answered by the edge from `happyview.happyview_records`,
over exactly `community.lexicon.media.book.review` and `net.olamaelcu.livtet.biblio.bookStatus`.
They never call HappyView, the PDS or a worker task, and they read no catalog table.

#### `com.atproto.feed.describeFeedGenerator`

Anonymous. Returns `{ did, feeds: [{ uri }] }` for exactly `public`, `following`, `extended` and
`dynamic`, all under `at://<FEED_GENERATOR_DID>/net.olamaelcu.livtet.biblio.feed.generator/`.

#### `com.atproto.feed.getFeedSkeleton`

Params: `feed` (required, one of the four URIs), `limit` (20, clamped 1–100) and `cursor` (the
feed's own opaque `{c,u}`). Skeleton items are `{ post, reason? }`: `post` is the record URI (`cid`
is omitted) and `reason` is the book URI when the record names one — a review's `subjectRecord`,
else the first `subject.identifiers[]` entry with `issuer: "atproto"`; a `bookStatus`'s
`book.uri`. `reason` is omitted when it cannot be resolved.

Ordering is newest first by the record's own `record::jsonb->>'createdAt'` as text, then `uri`
descending; `limit + 1` rows decide whether a cursor is returned. A missing, malformed or foreign
`feed`, and a malformed cursor, are `400 InvalidRequest`. An unavailable `DATABASE_URL` or a failed
query is `503 ServiceUnavailable`.

| Feed | Auth | Records |
| --- | --- | --- |
| `public` | none | every indexed review and `bookStatus` |
| `following` | service JWT | records by DIDs the viewer follows, excluding the viewer |
| `extended` | service JWT | followed DIDs plus their followees, capped at 500 DIDs, excluding the viewer |
| `dynamic` | service JWT | the viewer plus followed DIDs (the per-viewer ladder) |

The viewer is the JWT's `iss`; the `follow` collection's `subject` field is the follow graph. A
viewer who follows nobody gets an empty personalized page, not the public feed. `following` always
excludes the viewer's own records; `dynamic` is the feed that includes them.

**Feed backfill.** There is no feed-specific table, cursor store or worker task: a feed is a view
over whatever HappyView has indexed. A fresh deployment starts empty and fills through Jetstream,
the HappyView procedures (which index the record they just wrote) and HappyView's normal
backfill/reconcile. If `happyview_records` is missing a reader's review, `bookStatus` or `follow`,
run HappyView's existing `/admin/backfill` for that DID and collection; the next feed call sees it:

```bash
for collection in \
  community.lexicon.media.book.review \
  net.olamaelcu.livtet.biblio.bookStatus \
  net.olamaelcu.livtet.biblio.follow
do
  curl -sS -X POST "$HAPPYVIEW_URL/admin/backfill" \
    -H "Authorization: Bearer $HAPPYVIEW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d "{\"did\":\"$DID\",\"collection\":\"$collection\"}"
done
```

`HAPPYVIEW_URL` is the upstream base (`http://127.0.0.1:3000` by default) and
`HAPPYVIEW_ADMIN_KEY` is the `hv_…` key from `mise run hv-seed`. This is HappyView's existing
backfill, not a feed job: feeds never queue worker work and keep no cursor state beyond the opaque
page cursor.

## Procedure behavior

Shared rules: the body must be a JSON object; ownership is checked against `caller_did` (`403`); a
missing target is `404`; successful writes go through the PDS and are indexed in the same request.

### Catalog discovery (edge)

These two are `POST` by lexicon but never write catalog rows and never authenticate. They are dispatched by the
edge, read the catalog tables, and answer `503 ServiceUnavailable` when `DATABASE_URL` is unset or
the query fails. Both cap `identifiers` at 100 entries and clamp `offset`/`limit`; a duplicate
`(issuer, value)` pair is collapsed before the query. Identifier comparison is exact — no
normalization — per the lexicon. Both may queue background hydration instead of writing catalog
rows; the response does not report whether that work is outstanding (see above).

**Enqueue cap.** Both procedures cap each hydration enqueue list at 10 jobs per request
(`MAX_HYDRATION_JOBS_PER_REQUEST` in the edge route): `resolveEditions` queues at most 10 unmatched
identifiers, and `searchEditions` at most 10 ISBN hydration jobs, plus its single `catalog.search`
job when the local page is empty. A body may still name 100 identifiers; those beyond the cap are
validated and matched normally, they are just not queued on this call, and a later call that
repeats the miss can queue them. The cap is per request, not a global quota: the TTL marks only
dedupe repeats across calls. Each queued job can spend up to 50 paid provider lookups in the
worker, so operators should also rate-limit this anonymous surface at the reverse proxy.

#### `community.lexicon.media.book.resolveEditions`

`identifiers[]` is required and may match several editions; an edition qualifies when **any**
supplied `(issuer, value)` pair matches exactly. Results are ordered `indexed_at ASC, uri ASC`,
paged by `offset`/`limit`, with `LIMIT limit + 1` deciding `hasMore`; `total` is counted on the
first page only. No match is an empty page (the lexicon declares no errors). Every item is an
`editionView` whose `identifiers` begin with the atproto URI identifier.

Each identifier with no matching edition in the response is enqueued as a `catalog.resolve` job,
up to `MAX_HYDRATION_JOBS_PER_REQUEST` (10) enqueues per request (deduplicated by a TTL mark, so a
repeat while the first job is still outstanding does not queue again). The response carries no
flag for this: the client can only re-call with the same body later. Queued work is not a promise
that the provider will resolve the identifier, and a stopped worker leaves the work outstanding
without any response signal.

#### `community.lexicon.media.book.searchEditions`

At least one nonblank `q`, `title`, `author` or a non-empty `identifiers` array is required;
otherwise `400 InvalidQuery`. The catalog pass ORs the supplied hints: exact identifier pairs,
`title ILIKE`, contributor name for `author`, and for `q` a broader match over title, description,
contributor names and identifier values. Local ranking is `identifier > title > author > text`,
then `indexed_at DESC, uri ASC`. Provider search and ingestion happen asynchronously in the worker
(`catalog.search`: ISBNdb first, then Google Books when ISBNdb is empty, then Goodreads as
gap-fill, stopping at the first provider that returns candidates and ingesting at most 50 of them);
newly ingested editions appear in later calls. The ranking above is this catalog's relevance
order, which the lexicon allows providers to define.

Text/identifier hydration (`catalog.search`) is queued only when the local result is empty
(`items.length === 0`), and a repeated query is deduplicated by its TTL mark. The response carries
no flag for it, so a client can only re-call with the same body later; an empty page may stay
empty on every later call. As with `resolveEditions`, there is no signal for worker liveness or
for a stopped worker.

ISBN identifiers (`isbn13`, `isbn10`, `isbn`, case-insensitive, normalized to a checksum-valid
ISBN-13) follow a separate rule: they queue a direct ISBNdb lookup (`catalog.isbn`)
**unconditionally — even when the local result is non-empty** — because the goal is to enrich and
ingest the edition from the provider, not to fill an empty page. Only the first
`MAX_HYDRATION_JOBS_PER_REQUEST` (10) distinct normalized ISBN-13s queue per request, after dedupe;
each is deduplicated by its own TTL mark. No response field signals queued work: the response shape
is unchanged (`items`/`hasMore`/`total`; `editionResults` has no `pending` or `degraded` field), so
clients learn of new editions only by re-calling later.

### Entity records (edge)

The seven entity methods are anonymous catalog reads like the books-wg pair: the edge
dispatches them on NSID, they read `contributors` / `publishers` (never a PDS), and they answer
`503 ServiceUnavailable` when `DATABASE_URL` is unset or the query fails. They never queue
hydration — contributor and publisher rows are populated by ingest and catalog curation, not by a
provider lookup — and they never write a row. `getContributor`, `getPublisher`,
`listEditionsByContributor`, `searchContributors` and
`searchPublishers` are `GET`; `resolveContributors` / `resolvePublishers` are `POST` because the
identifier array travels in a JSON body.

**Identity.** The only accepted URI is
`at://<did>/net.olamaelcu.livtet.biblio.contributor/<rkey>` (or `.publisher`). A missing, malformed
or wrong-collection `uri` is `400 InvalidRequest`, never a lookup; a well-formed URI with no catalog
row is `404 RecordNotFound`. The two getters return `cid` (the last CID from `pds_cids`) so a caller
can build a strongRef without a second read; list items omit it. Empty optional fields are omitted
from the view rather than sent as `null`. Dates are the stored strict `YYYY-MM-DD` values; the
method does not re-validate them, because the builder rejected an invalid one at publish time.

**Resolvers.** `identifiers[]` is required, capped at 100 pairs, and each pair matches by exact
`(issuer, value)` containment in the row's identifier array — no normalization. A row matching
several pairs appears once. Results are ordered `lower(name), uri`, paged by `offset`/`limit`, with
`LIMIT limit + 1` deciding `hasMore`; `total` is counted on the first page only. No match is an
empty page (the lexicon declares no `RecordNotFound` for a resolver). Because identifiers are
sparse in the current catalog, a resolver usually answers empty until curation adds pairs.

**Search.** `q` is required and trimmed; blank is `400 InvalidQuery` and longer than 256 characters
is `400 InvalidRequest`. Matching is an escaped `ILIKE` over the display name and every identifier
value. Ranking is exact name (case-insensitive) first, then name prefix, then substring, with a
stable `lower(name), uri` tie-break. Pagination is the offset cursor `{ "o": <offset> }`; an
emitted cursor advances by the number of items returned, and a malformed cursor restarts at 0.

**Editions by contributor.** `contributor` must be a contributor record at-uri, validated like the
getter: a malformed URI or another collection is `400 InvalidRequest`, and a URI with no catalog row
is `404 RecordNotFound`. The query resolves the contributor, then matches `edition_contributors` to
`editions`. Every credited edition is returned **regardless of role** (author, translator,
illustrator, … appear together), and `EXISTS` keeps a person credited twice on one edition from
duplicating it. Items are `defs#bookView` (`uri` + `editionView`). Order is
`editions.created_at DESC, uri ASC`; `total` is the distinct credited-edition count on the first
page; `limit` defaults to 25 (max 100) and `cursor` is the same offset cursor as the searches.

### Follow

#### `graph.follow`

`subject` must be a DID (`did:<method>:<identifier>`), and a reader cannot follow themselves. The
procedure looks up an existing follow by subject (both `did:` and legacy `at://did` spellings, plus
the old subject-DID URI) before writing: an existing follow returns `{ uri, created: false }`
unchanged, and a new one is written at a fresh TID rkey with `{ subject, createdAt }` and returns
`{ uri, created: true }`.

#### `graph.unfollow`

Finds the caller's follow records whose subject is that DID (both spellings, plus the legacy
subject-DID rkey), deletes every match, and returns the first deleted URI. A follow that does not
exist is `404 NotFound`, not a silent success.

### Reader

#### `profile.set`

Merge-patch of `net.olamaelcu.livtet.actor.profile/self`: `displayName` (≤640), `description`
(≤256) and `avatarCid` are validated and copied; fields the input omits keep their stored value, and
the create path stamps `createdAt`/`updatedAt`. At least one field is required (`400`). Returns
`{ uri }`.

#### `readingGoal.set`

Upsert of `readingGoal/current`: `period` ∈ `weekly|monthly|annual`, `year` 1900–9999, `booksGoal`
≥ 1, all required integers. Returns `{ uri, period, year, booksGoal }`.

### Shelves

#### `shelf.create`

`name` is required and at most 128 characters; `description` is optional. The rkey is a fresh TID.
Returns `{ uri }`.

#### `shelf.update`

Merge-patch of an owned shelf: `name` (≤128) and `description` are applied only when present;
`updatedAt` is always bumped. Returns `{ uri, updated }` where `updated` says whether a field was
supplied. Missing shelf: `404 NotFound`.

#### `shelf.delete`

Cascading delete of an owned shelf: every `shelfItem` and every `bookStatus` whose `record.shelf`
equals the shelf URI is selected through the partial expression index on `(record::jsonb)->>'shelf'`,
loaded in one `Record.load_all` batch, and deleted first; then the shelf itself. A missing shelf is
`404 NotFound`. Returns `{ deleted }`, counting the cascade plus the shelf record.

### Membership

#### `shelf.addItem`

Upsert of one membership edge. `shelf` must be an owned, existing shelf (`404` when it does not
exist, `403` when it belongs to another DID). `book` must be a strongRef with a CID;
`metadata.position` must be an integer ≥ 1, `metadata.notes` and `metadata.emoji` strings. The rkey is derived as
`<shelf rkey>-<edition rkey>` (rejected if longer than 512 characters), so the pair always maps to
one record. On an existing record the metadata is merged key-by-key (omitted keys keep their value)
and `updatedAt` is bumped; on create the metadata object is stored as given. Returns `{ uri }`.

#### `shelf.removeItem`

Deletes the derived `<shelf rkey>-<edition rkey>` record. `book` may be a strongRef or a bare
`{ uri }`. Not on the shelf: `404 NotFound`.

#### `shelf.addBooks`

Batch upsert of up to 100 strongRefs into an owned, existing shelf (`404`/`403` as in
`shelf.addItem`). Each entry is validated independently; invalid entries
(missing CID, malformed URI, duplicate derived rkey inside the request, rkey over 512 characters)
are counted in `failed` instead of failing the call. Valid entries are written in parallel with
`Record.save_all`; an existing record has its `shelf`, `book` and `updatedAt` refreshed (its
`metadata` is left alone, unlike `shelf.addItem`). A PDS rejection is `502 UpstreamFailure`. Returns
`{ added, failed }`.

### Reading status

#### `status.set`

Upsert of `bookStatus` at the edition rkey. Requires a strongRef `book` (CID included) and a
`status` ∈ `to-read|reading|read|dnf`; `shelf` is optional, but when present it must exist and belong
to the caller (`404`/`403`), so the read views never receive a dangling shelf reference.
`metadata` may carry `startedAt`/`finishedAt` (strings), `position` (integer ≥ 1), `notes` and
`emoji` (strings). On an existing record the metadata is merged, `status` is overwritten,
`createdAt` survives and `updatedAt` is bumped. Returns `{ uri, status }`.

#### `status.clear`

Deletes the `bookStatus` at the edition rkey derived from `book` (strongRef or bare `{ uri }`). No
status: `404 NotFound`. Returns `{ uri }`.

### Reviews

#### `review.create`

Creates a review at a fresh TID, so rereads can be separate records. `subject` must be an
`editionRef` with a non-empty `title`, a non-empty `identifiers` array and a `contributors` array
(it may be empty). At least one of `rating` (integer 1–20) or non-empty `textContent` is required.
`subjectRecord` must be an AT-URI when present; `content` and `flags` must be objects. Returns
`{ uri }`.

#### `review.update`

Merge-patch of an owned review (otherwise `403`). Any of `subject`, `rating`, `textContent`,
`subjectRecord`, `content`, `flags` may be supplied and are validated as in `review.create`; omitted
fields keep their value. The resulting record must still carry a rating or non-empty text content.
The review lexicon has no `updatedAt`, so `createdAt` is left unchanged. Returns `{ uri, updated }`
where `updated` is whether any field was supplied.

#### `review.delete`

Deletes an owned review. Wrong collection or non-AT-URI: `400`; another DID's review: `403`; missing:
`404 NotFound`. Returns `{ uri }`.

## Record types

| Collection | Key | Required fields | Written by |
| --- | --- | --- | --- |
| `net.olamaelcu.livtet.biblio.shelf` | `any` — TID for custom shelves, fixed `reading`/`read`/`to-read`/`dnf` for the reading-status shelves | `name` (≤128), `createdAt`, `updatedAt`; optional `description` | `shelf.create`, `shelf.update` |
| `net.olamaelcu.livtet.biblio.shelfItem` | `any` — `<shelf rkey>-<edition rkey>` by contract | `shelf`, `book`, `createdAt`, `updatedAt`; optional `metadata` (`position` ≥ 1, `notes`, `emoji`) | `shelf.addItem`, `shelf.addBooks` |
| `net.olamaelcu.livtet.biblio.bookStatus` | `any` — the edition rkey by contract | no record-level `required`; the view needs `metadata.status` (`to-read`/`reading`/`read`/`dnf`) plus a resolvable `book` and `shelf`; `book` is a strongRef; optional `startedAt`, `finishedAt`, `position`, `notes`, `emoji` | `status.set` |
| `net.olamaelcu.livtet.biblio.follow` | `tid` — a fresh TID minted by `graph.follow`; legacy rows may use the subject DID | `subject` (DID), `createdAt` | `graph.follow` |
| `net.olamaelcu.livtet.biblio.readingGoal` | `literal:current` | `period` (`weekly`/`monthly`/`annual`), `year` 1900–9999, `booksGoal` ≥ 1, `createdAt`, `updatedAt` | `readingGoal.set` |
| `net.olamaelcu.livtet.actor.profile` | `literal:self` | `createdAt`, `updatedAt`; optional `displayName` (≤640), `description` (≤256), `avatarCid` | `profile.set` |
| `community.lexicon.media.book.review` | `tid` | `subject` (`editionRef`; contributors have `displayName` + ONIX `role`), `createdAt`; optional `rating` 1–20, `textContent` (≥1), `subjectRecord` (AT-URI), `content` (union), `flags` | `review.create`, `review.update` |
| `community.lexicon.media.book.edition` | `tid` — always a TID minted by `editions_next_tid()`; never provider-prefixed | `title`, `identifiers`, `contributors` (`displayName` + ONIX `role`), `createdAt`; optional subtitle/language/publishedDate/publisher/format/pages/durationSeconds/chapters/series/bookEdition/description/cover/coverUrl | catalog publisher (outbox worker); no write procedure |

The record keys are part of the contract: the queries resolve records by them. `bookStatus` derives
from the edition URI, `shelfItem` from the shelf and edition rkeys, `readingGoal` and
`actor.profile` from their literal keys, and the follow graph by its `subject` field (the follow
rkey is opaque). A writer that invents its own scheme produces records the queries cannot see.
`shelf.delete` and `status.clear` also rely on these derivations (and on
`record.shelf`/`record.book`), so records written directly to a PDS with a different shape are not
found by them.

## What the surface does not do

- No PDS reads on the query path, no Constellation, no tiered cursors (`tap:`/`con:`/`pds:`), no
  Bookhive branches: the index is the only activity source.
- No `com.atproto.*` writes are handled here. The edge serves only the two read-only PDS proxies
  (`repo.getRecord`, `repo.listRecords`), the two `com.atproto.feed.*` methods, and the two books-wg
  catalog procedures; every other `com.atproto.*` call is forwarded to HappyView. No
  `community.lexicon.book.*` handlers are exposed; the activity queries read the catalog through
  `appview_book_lua` only, and edition discovery is the two edge procedures.
- No request-path writes other than the 15 procedures; the worker writes catalog rows and
  publishes editions out of band. A client that writes records to its own PDS directly is indexed
  only when a backfill or reconcile runs, not per request.
- Provider hydration is worker work, not request-path work: the edge queues `catalog.resolve` /
  `catalog.search` (deduplicated by a TTL mark); `packages/worker` then
  queries ISBNdb first, then Google Books when ISBNdb is empty, then Goodreads as gap-fill, and
  ingests up to 50 candidates through the identifier bag; new editions get a TID rkey. New
  editions queue in `pds_outbox`
  and the worker's `pds-publish` cron task drains it with `com.atproto.repo.applyWrites`. Neither
  the providers nor the publisher are verified live in this environment: Google Books/ISBNdb need
  API keys and consent, and the local dev PDS cannot host the `did:web` publisher, so live PDS
  publishing needs a provisioned publisher account (`PDS_URL`, publisher DID,
  `PDS_ACCOUNT_PASSWORD` or `PDS_ACCESS_TOKEN`). Without a provisioned publisher the worker still
  hydrates and rows queue in `pds_outbox`. `editionResults` has no `pending`/`degraded` field (as
  upstream defines it), so a client cannot be told via the response that work is outstanding; it
  can only re-call. Without the hydration queue installed the edge skips enqueueing.
- No cache headers are set by the edge, and no cache-control is relayed from HappyView.
- No works records, and no label or lexicon endpoints on this surface. Contributor and publisher
  records exist under `net.olamaelcu.livtet.biblio.*` and are served by the edge methods above.
  The feed generator has exactly the four feeds above; there is no `recommendations` feed.
