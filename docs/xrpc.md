# XRPC surface: current behavior

This document is the behavioral spec of the XRPC surface the AppView serves today: what each
method accepts, what it reads, how it paginates, what it writes, and which errors it can produce.
It is drawn from the deployed lexicons in `happyview/lexicons` and the handler scripts in
`happyview/scripts/xrpc/{query,procedure}`. The same lexicons generate the public page in
`packages/web`.

The surface is the set of uploaded lexicons plus the books-wg working set vendored at
`vendor/books-wg-lexicons`: **17 queries, 17 procedures and 8 record types**. Two procedures
(`community.lexicon.media.book.resolveEditions` and `searchEditions`) are anonymous catalog reads
served by the edge in `packages/web`; the other 15 are HappyView procedures that write to a caller's
PDS. Everything except the review and edition record types lives under
`net.olamaelcu.livtet.biblio.*`. HappyView's built-in `com.atproto.*` routes are not part of this
surface — they proxy to an authority DID that the local network does not resolve.

## Conventions

**Transport.** Queries are `GET /xrpc/<nsid>`; procedures are `POST /xrpc/<nsid>` with a JSON body.
Every call reaches HappyView through the SvelteKit edge (`packages/web/src/routes/xrpc/[...method]`),
which:

- accepts only `GET` and `POST`; anything else is `405 MethodNotAllowed`;
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

The two books-wg procedures never reach HappyView: the edge dispatches them on NSID and answers them
from the catalog tables (`editions`, `edition_identifiers`, `edition_contributors`,
`edition_publishers`). They are `POST` by lexicon and reject `GET` with `405 MethodNotAllowed`.
They never write catalog rows; when the local catalog cannot answer, they may queue a hydration job
and mark it in `catalog_enqueue_marks`.

**Auth.** Queries are anonymous. HappyView procedures require a DPoP-bound session:
`Authorization: DPoP <token>` plus a fresh `DPoP` proof. The edge holds no session and cannot mint
one; it relays both headers untouched, and the token needs `transition:generic` because the write is
proxied to the caller's PDS. Without a session those 15 procedures answer `401` with
`XRPC procedures require DPoP authentication` before the handler runs. Handlers see the session as
`caller_did`; every procedure that names an existing review or shelf compares it against
`caller_did` and answers `403 Forbidden` on a mismatch.

The two catalog procedures are the exception: they are read-only and anonymous, and they never
require or read a session. They also need `DATABASE_URL`; when it is unset or the catalog is
unreachable they answer `503 ServiceUnavailable` instead of proxying anywhere.

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
starts at the beginning rather than erroring.

| Encoding | Meaning | Methods |
| --- | --- | --- |
| `{ "o": <offset> }` | offset, advanced by the number of **scanned** rows (`limit + 1` when another page exists) | `getReviewsByBook`, `listReviewsByActor`, `listShelfItems`, `listShelfItemsByBook`, `getShelvingOfBook` |
| `{ "t": <created_at>, "u": <uri> }` | keyset over `(created_at, uri)`, descending | `listBooksOnShelf`, `listRecentShelving` |
| `{ "u": <uri> }` | keyset over `uri`, ascending; for `getShelversOfBook` it is the smallest URI seen per DID | `listShelves`, `listShelvesWithBooks`, `getShelversOfBook` |
| raw DID | keyset over the follower DID / subject DID, ascending | `graph.listFollowers`, `graph.listFollowees` |

A cursor is emitted only when the `limit + 1` probe row exists. Because list mapping can drop
unbuildable rows, an offset cursor can return fewer than `limit` views while still pointing past
all scanned rows; the keyset cursors share the same property (they advance from the last scanned
row, not the last emitted view).

**Limits.** Every `limit` is clamped to the lexicon's range by the handler (`int(value, default,
min, max)`), so an out-of-range number is adjusted, not rejected.

**Errors.** The envelope is `{ "error": string, "message": string }`.

| Status | Error | Origin |
| --- | --- | --- |
| 400 | `InvalidRequest` | a required parameter is missing, or a value violates its contract: non-DID `subject`, self-follow, non-AT-URI shelf/review URI, wrong collection, bad enum (`status`, `period`), out-of-range integer, empty update, invalid `editionRef`, non-strongRef `book` |
| 400 | `InvalidQuery` | `searchEditions` without a nonblank `q`, `title`, `author` or identifier |
| 401 | `XRPC procedures require DPoP authentication` | the 15 HappyView procedures, until a DPoP session is presented |
| 403 | `Forbidden` | the named review or shelf belongs to another DID |
| 404 | `NotFound` | a procedure targets a follow, review, shelf, `bookStatus` or `shelfItem` that does not exist |
| 404 | `RecordNotFound` | `getShelf` / `getBookOnShelf` record missing; `getBookOnShelf` also when the catalog edition is missing |
| 405 | `MethodNotAllowed` | the edge, for any verb other than GET/POST |
| 502 | `UpstreamFailure` | `shelf.addBooks` when the PDS rejects the batch |
| 502 | `UpstreamUnavailable` | the edge, when HappyView is unreachable |
| 503 | `ServiceUnavailable` | the edge, when `DATABASE_URL` is unset or the catalog query fails; `resolveEditions` / `searchEditions` only |

Queries and the two catalog procedures never answer `401`. Missing optional records are not errors:
`getActorProfile` and `getReadingGoal` answer `200` with `null`.

**Views.** Responses embed the lexicon's view types from `net.olamaelcu.livtet.biblio.defs`:
`shelfView` (`uri`, `name`, optional `description`/timestamps), `bookView` (`uri`, `edition`),
`bookShelfView` (`uri`, `shelf`, `book`, `metadata`, `did`, optional timestamps), `shelfItemView`
(same shape), `shelfWithBooksView` (`shelf`, `books`), and `reviewView`
(`uri`, `did`, `record`). `edition` is the `community.lexicon.media.book.defs#editionView` built
from the catalog.

Every `editionView` in `resolveEditions` / `searchEditions` carries the edition's atproto URI as an
identifier: `{ "issuer": "atproto", "value": "at://<did>/community.lexicon.media.book/<rkey>" }`,
first in `identifiers` and exactly once. The view type has no `uri` field, so this identifier is the
link back to the record; clients derive display routes such as
`/book/<did>/<rkey>` from it. Stored identifiers follow it unchanged (`issuer`/`value`, no
bookkeeping columns).

`editionResults` is exactly the upstream envelope: `{ items, hasMore, total? }`, with no
`pending`/`degraded` field, so a response cannot tell a client that catalog hydration is
outstanding. The two catalog procedures still queue `catalog.resolve` / `catalog.search` work for
unmatched input, and that work may add editions matching a later identical request, but the only
way to learn about it is to re-call: there is no ETag, conditional-request, stream, or
subscription signal. Queued work is not a promise that anything will be found.

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
| `graph.listFollowers` | `did`, `limit` 100 (≤1000), `cursor` | `{ followers, total?, cursor? }` |
| `graph.listFollowees` | `did`, `limit` 100 (≤1000), `cursor` | `{ followees, total?, cursor? }` |

### Procedures

The two catalog procedures are anonymous reads over the catalog tables. The other fifteen require a
DPoP session and write to the caller's PDS, then index the accepted record in `happyview_records` in
the same request.

| NSID | Input | Returns |
| --- | --- | --- |
| `community.lexicon.media.book.resolveEditions` | `identifiers[]` (required), `offset` 0, `limit` 25 (≤100) | `editionResults` |
| `community.lexicon.media.book.searchEditions` | `q?`, `title?`, `author?`, `identifiers[]?`, `offset` 0, `limit` 25 (≤100) | `editionResults` |
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

Reads the index at `at://<did>/net.olamaelcu.livtet.actor.profile/self` and returns the stored record
as `profile`. A missing record is `200 { profile: null }`; no PDS read happens, so a profile the
index has not seen is reported missing. The lexicon's optional `handle` is not served today: the
handler emits only `profile`.

#### `getReadingGoal`

Reads the index at `at://<did>/net.olamaelcu.livtet.biblio.readingGoal/current` and returns the
stored record as `goal`, or `null`.

### Follow graph

Follow rows are `net.olamaelcu.livtet.biblio.follow` records; the subject DID is the first path
segment of `record.subject`, and the rkey is the subject DID too.

#### `graph.isFollowing`

One probe of the follower's follow collection filtered by the subject DID returns `{ following }`.
The graph is public data; `follower` and `followed` name whose edge to read, not the caller.

#### `graph.listFollowers`

Rows whose `subject` DID equals `did`, ordered by the follower DID (`record.did`) ascending, keyset
`did > cursor`. `total` is counted only when no cursor is given; a full page emits the last
follower DID as the cursor.

#### `graph.listFollowees`

Rows whose record DID equals `did`, ordered by the subject DID ascending, keyset on the same value.
`total` is counted on the first page only, and the first page is the only one that emits it. A full
page emits the last subject DID as the cursor.

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

Pages reviews that either name the book in `subjectRecord` or share an identifier with the edition
(`edition_identifiers` of `book`), ordered `created_at` descending, `uri` descending, offset cursor.
Returns `{ reviews, cursor? }`. The lexicon declares `NotFound`; the handler returns an empty page.

#### `listReviewsByActor`

Pages one DID's reviews, same ordering and cursor. Returns `{ reviews, cursor? }`.

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

#### `community.lexicon.media.book.resolveEditions`

`identifiers[]` is required and may match several editions; an edition qualifies when **any**
supplied `(issuer, value)` pair matches exactly. Results are ordered `indexed_at ASC, uri ASC`,
paged by `offset`/`limit`, with `LIMIT limit + 1` deciding `hasMore`; `total` is counted on the
first page only. No match is an empty page (the lexicon declares no errors). Every item is an
`editionView` whose `identifiers` begin with the atproto URI identifier.

Each identifier with no matching edition in the response is enqueued as a `catalog.resolve` job
(deduplicated by a TTL mark, so a repeat while the first job is still outstanding does not queue
again). The response carries no flag for this: the client can only re-call with the same body
later. Queued work is not a promise that the provider will resolve the identifier, and a stopped
worker leaves the work outstanding without any response signal.

#### `community.lexicon.media.book.searchEditions`

At least one nonblank `q`, `title`, `author` or a non-empty `identifiers` array is required;
otherwise `400 InvalidQuery`. The catalog pass ORs the supplied hints: exact identifier pairs,
`title ILIKE`, contributor name for `author`, and for `q` a broader match over title, description,
contributor names and identifier values. Local ranking is `identifier > title > author > text`,
then `indexed_at DESC, uri ASC`. Provider search and ingestion happen asynchronously in the worker
(`catalog.search`, Google Books then ISBNdb for an ISBN when Google Books is empty, then Goodreads
as gap-fill); newly ingested editions appear in later calls. The ranking above is this catalog's
relevance order, which the lexicon allows providers to define.

Hydration is queued only when the local result is empty, and a repeated query is deduplicated by
its TTL mark. The response carries no flag for it, so a client can only re-call with the same body
later; an empty page may stay empty on every later call. As with `resolveEditions`, there is no
signal for worker liveness or for a stopped worker.

ISBN identifiers (`isbn13`, `isbn10`, `isbn`, case-insensitive, normalized to a checksum-valid
ISBN-13) additionally queue a direct ISBNdb lookup (`catalog.isbn`) **even when the local result is
non-empty** — the goal is to enrich and ingest the edition from the provider, not to fill an empty
page. That enqueue is deduplicated by its own TTL mark. No response field signals it: the response
shape is unchanged (`items`/`hasMore`/`total`; `editionResults` has no `pending` or `degraded`
field), so clients learn of new editions only by re-calling later.

### Follow

#### `graph.follow`

`subject` must be a DID (`did:<method>:<identifier>`), and a reader cannot follow themselves.
The record is keyed by the subject DID, so this is an idempotent upsert: an existing follow returns
`{ uri, created: false }` unchanged; a new one writes `{ subject, createdAt }` and returns
`{ uri, created: true }`.

#### `graph.unfollow`

Deletes the follow at the subject-DID rkey. A follow that does not exist is `404 NotFound`, not a
silent success.

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
equals the shelf URI is deleted first, then the shelf itself. Child records are found by scanning the
caller's rows in both collections and comparing the decoded `shelf` field. Returns
`{ deleted }`, counting the cascade plus the shelf record.

### Membership

#### `shelf.addItem`

Upsert of one membership edge. `book` must be a strongRef with a CID; `metadata.position` must be an
integer ≥ 1, `metadata.notes` and `metadata.emoji` strings. The rkey is derived as
`<shelf rkey>-<edition rkey>` (rejected if longer than 512 characters), so the pair always maps to
one record. On an existing record the metadata is merged key-by-key (omitted keys keep their value)
and `updatedAt` is bumped; on create the metadata object is stored as given. Returns `{ uri }`.

#### `shelf.removeItem`

Deletes the derived `<shelf rkey>-<edition rkey>` record. `book` may be a strongRef or a bare
`{ uri }`. Not on the shelf: `404 NotFound`.

#### `shelf.addBooks`

Batch upsert of up to 100 strongRefs. Each entry is validated independently; invalid entries
(missing CID, malformed URI, duplicate derived rkey inside the request, rkey over 512 characters)
are counted in `failed` instead of failing the call. Valid entries are written in parallel with
`Record.save_all`; an existing record has its `shelf`, `book` and `updatedAt` refreshed (its
`metadata` is left alone, unlike `shelf.addItem`). A PDS rejection is `502 UpstreamFailure`. Returns
`{ added, failed }`.

### Reading status

#### `status.set`

Upsert of `bookStatus` at the edition rkey. Requires a strongRef `book` (CID included) and a
`status` ∈ `to-read|reading|read|dnf`; `shelf` is optional but must be one of the caller's shelves.
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
| `net.olamaelcu.livtet.biblio.follow` | `any` — the subject DID by contract | `subject` (DID), `createdAt` | `graph.follow` |
| `net.olamaelcu.livtet.biblio.readingGoal` | `literal:current` | `period` (`weekly`/`monthly`/`annual`), `year` 1900–9999, `booksGoal` ≥ 1, `createdAt`, `updatedAt` | `readingGoal.set` |
| `net.olamaelcu.livtet.actor.profile` | `literal:self` | `createdAt`, `updatedAt`; optional `displayName` (≤640), `description` (≤256), `avatarCid` | `profile.set` |
| `community.lexicon.media.book.review` | `tid` | `subject` (`editionRef`), `createdAt`; optional `rating` 1–20, `textContent` (≥1), `subjectRecord` (AT-URI), `content` (union), `flags` | `review.create`, `review.update` |
| `community.lexicon.media.book.edition` | `any` — provider-prefixed (`gb.`/`isbn.`/`gr.`) or `tid`; the lexicon declares `tid` | `title`, `identifiers`, `contributors`, `createdAt`; optional subtitle/language/publishedDate/publisher/format/pages/durationSeconds/chapters/series/bookEdition/description/cover/coverUrl | catalog publisher (outbox worker); no write procedure |

The record keys are part of the contract: the queries resolve records by them. `bookStatus` derives
from the edition URI, `shelfItem` from the shelf and edition rkeys, `readingGoal` and
`actor.profile` from their literal keys, and the follow graph from the subject DID. A writer that
invents its own scheme produces records the queries cannot see. `shelf.delete` and `status.clear`
also rely on these derivations (and on `record.shelf`/`record.book`), so records written directly to
a PDS with a different shape are not found by them.

## What the surface does not do

- No PDS reads on the query path, no Constellation, no tiered cursors (`tap:`/`con:`/`pds:`), no
  Bookhive branches: the index is the only activity source.
- No `com.atproto.*` or `community.lexicon.book.*` handlers are exposed here; the activity queries
  read the catalog through `appview_book_lua` only, and edition discovery is the two edge
  procedures.
- No request-path writes other than the 15 procedures; the worker writes catalog rows and
  publishes editions out of band. A client that writes records to its own PDS directly is indexed
  only when a backfill or reconcile runs, not per request.
- Provider hydration is worker work, not request-path work: the edge queues `catalog.resolve` /
  `catalog.search` (deduplicated by a TTL mark); `packages/worker` then
  queries Google Books, then ISBNdb for an ISBN only when Google Books is empty, then Goodreads as
  gap-fill, and ingests candidates through the identifier bag. New editions queue in `pds_outbox`
  and the worker's `pds-publish` cron task drains it with `com.atproto.repo.applyWrites`. Neither
  the providers nor the publisher are verified live in this environment: Google Books/ISBNdb need
  API keys and consent, and the local dev PDS cannot host the `did:web` publisher, so live PDS
  publishing needs a provisioned publisher account (`PDS_URL`, publisher DID,
  `PDS_ACCOUNT_PASSWORD` or `PDS_ACCESS_TOKEN`). Without a provisioned publisher the worker still
  hydrates and rows queue in `pds_outbox`. `editionResults` has no `pending`/`degraded` field (as
  upstream defines it), so a client cannot be told via the response that work is outstanding; it
  can only re-call. Without the hydration queue installed the edge skips enqueueing.
- No cache headers are set by the edge, and no cache-control is relayed from HappyView.
- No works/contributors/publishers records, no feed generator, and no label or lexicon endpoints on
  this surface.
