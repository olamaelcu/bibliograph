# XRPC surface: current logic

This document is the behavioral spec of the XRPC surface Bibliograph serves today: what each
registered method accepts, what it reads, how it paginates, which errors it can produce, and how
caching and identity work. It is drawn from the handlers in
`packages/bibliograph-service/src/lib/server/xrpc-router.ts` and
`packages/bibliograph-service/src/routes/xrpc/book-queries.ts`.

The router registers 42 methods: 14 under `com.atproto.*`, 6 under `community.lexicon.book.*`,
20 under `net.olamaelcu.livtet.biblio.*`, plus the two feed generator methods counted with the
`com.atproto.*` group. The final two sections record where each of them runs in the HappyView
greenfield target.

## Conventions

**Transport.** Queries are `GET /xrpc/<nsid>`, procedures are `POST /xrpc/<nsid>`. Bodies are JSON
except for the `com.atproto.sync.*` methods, which return CAR (`application/vnd.ipld.car`).

**Auth.** Most queries are anonymous. A viewer is proved two ways only, through `viewerDidFromRequest`
in `xrpc-router.ts`: a service JWT in `Authorization: Bearer` whose `lxm` matches the method
(`verifyFeedAuth`), or the storefront cookie `bib_session`, whose opaque id is looked up in
`web_sessions`. A bare `x-viewer-did` header is deliberately not honored — nothing verified it, so
it would let any caller act as any DID. The feed's `dynamic` and `recommendations` generators call
`requireFeedAuth` and reject anonymous callers.

**Pagination.** Cursors are opaque. The shared parser accepts `<tier>:<value>` where the tier is
`tap:` (the mirror), `con:` (Constellation) or `pds:` (a repo scan), and it keeps pre-tagging cursors
working: a bare number is a mirror offset, anything else a Constellation cursor. `listRecentShelving`
uses a base64url `{t,u}` keyset cursor over `(recordCreatedAt, uri)`. `listShelvesWithBooks` uses
`tap:<last shelf uri>`. Everything else is a numeric offset, a last-DID keyset, or an opaque upstream
cursor.

**Errors.** The envelope is `{ "error": string, "message": string }`. Status codes in use: 400
(`InvalidRequest`, `InvalidQuery`, `InvalidContributor`, `RecordNotFound`, `RepoNotFound`,
`HandleNotFound`, `DidNotFound`, `LexiconNotFound`), 401, 403, 404, 429 (`RateLimited`, with
`retry-after: 60`) and 502 (`UpstreamUnavailable`). A missing *optional* record is usually a 200 with
`null` (`getReadingGoal`, `getActorProfile`) or an empty field (`getImageForContributor`), not an
error.

**Record provenance.** Four sources appear throughout the handlers and are named explicitly in the
per-method notes:

- `records` — the TAP mirror. Columns `collection`, `did`, `value`, `created_at`,
  `record_created_at`.
- `PDS` — a direct `com.atproto.repo.getRecord` / `listRecords` read of the owner's PDS.
- `Constellation` — the backlink service.
- `follows` — the materialized follow index.

The PDS and Constellation tiers exist only because the mirror can lag, and they return a `pds:` or
`con:` cursor so a continuation resumes the same tier. They are removed in the target.

**Caching.** `hooks.server.ts` applies `public, max-age=60, stale-while-revalidate=300` to
unauthenticated GET XRPC responses that did not set their own `cache-control`. CAR responses set
`public, max-age=60, s-maxage=300`.

**Rate limiting.** Per-IP for anonymous traffic, per-DID for authenticated feed calls. The IP key is
the last `x-forwarded-for` hop appended by our own proxy (or `x-real-ip` when present), not the first
hop, which the caller controls.

## Inventory

| NSID | Kind | Auth | Current source | Target |
| --- | --- | --- | --- | --- |
| `com.atproto.identity.resolveHandle` | query | none | lex publisher config | edge (PDS proxy) |
| `com.atproto.identity.resolveDid` | query | none | `did.ts` document | edge (PDS proxy) |
| `com.atproto.identity.resolveIdentity` | query | none | either of the above | edge (PDS proxy) |
| `com.atproto.sync.getRecord` | query | none | per-rkey CAR slice | edge (PDS proxy) |
| `com.atproto.sync.getRepo` | query | none | `full.car` | edge (PDS proxy) |
| `com.atproto.sync.getRepoStatus` | query | none | `full.car` commit | edge (PDS proxy) |
| `com.atproto.sync.getLatestCommit` | query | none | `full.car` commit | edge (PDS proxy) |
| `com.atproto.sync.getBlocks` | query | none | parsed `full.car` | edge (PDS proxy) |
| `com.atproto.repo.getRecord` | query | none | Postgres catalog or CAR | edge (PDS proxy) |
| `com.atproto.repo.describeRepo` | query | none | DID document | edge (PDS proxy) |
| `com.atproto.lexicon.resolveLexicon` | query | none | local CAR slices | edge |
| `com.atproto.label.queryLabels` | query | none | `labels` table | edge |
| `com.atproto.feed.describeFeedGenerator` | query | none | static | edge |
| `com.atproto.feed.getFeedSkeleton` | query | none; optional viewer JWT/cookie for `following`/`extended`; required service JWT for `dynamic`/`recommendations` | `records`, follow PDS reads, catalog | edge; no `recommendations` |
| `community.lexicon.book.compatibility` | query | none | static | drop (no WG equivalent) |
| `community.lexicon.book.searchEditions` | query | none | `editions` + providers | replace with `community.lexicon.media.book.searchEditions` (procedure, catalog lookup) |
| `community.lexicon.book.resolveEditions` | procedure | none today | `editions.identifiers` | replace with `community.lexicon.media.book.resolveEditions` |
| `community.lexicon.book.searchWorks` | query | none | `works` + providers | drop (no works) |
| `community.lexicon.book.searchContributors` | query | none | `contributors` | drop (contributors are inline) |
| `community.lexicon.book.searchPublishers` | query | none | `publishers` | drop (publishers are inline) |
| `net.olamaelcu.livtet.biblio.graph.isFollowing` | query | none | `follows` | HappyView |
| `net.olamaelcu.livtet.biblio.graph.listFollowers` | query | none | `follows` | HappyView |
| `net.olamaelcu.livtet.biblio.graph.listFollowees` | query | none | `follows` | HappyView |
| `net.olamaelcu.livtet.biblio.getReadingGoal` | query | none | reader PDS | HappyView |
| `net.olamaelcu.livtet.biblio.getActorProfile` | query | none | reader PDS | HappyView |
| `net.olamaelcu.livtet.biblio.searchActors` | query | none | `actors` + `records` | drop (use `app.bsky.actor.searchActors`) |
| `net.olamaelcu.livtet.biblio.getShelf` | query | none | reader PDS | HappyView |
| `net.olamaelcu.livtet.biblio.listShelves` | query | none | PDS first, mirror fallback | HappyView |
| `net.olamaelcu.livtet.biblio.getImageForBook` | query | none | `editions`, `records` | edge (edition `coverUrl` only) |
| `net.olamaelcu.livtet.biblio.getImageForContributor` | query | none | `contributors` | drop (no contributor records) |
| `net.olamaelcu.livtet.biblio.getShelvingOfBook` | query | none | mirror + Constellation + PDS + Bookhive | HappyView; no tiers, no Bookhive |
| `net.olamaelcu.livtet.biblio.getShelversOfBook` | query | none | mirror + Constellation + Bookhive | HappyView; no tiers, no Bookhive |
| `net.olamaelcu.livtet.biblio.listBooksOnShelf` | query | none | mirror + PDS + Constellation | HappyView |
| `net.olamaelcu.livtet.biblio.listShelfItems` | query | none | PDS first, mirror fallback | HappyView |
| `net.olamaelcu.livtet.biblio.listShelfItemsByBook` | query | none | PDS first, mirror fallback | HappyView |
| `net.olamaelcu.livtet.biblio.getReviewsByBook` | query | none | mirror + Constellation | HappyView; reads `community.lexicon.media.book.review` |
| `net.olamaelcu.livtet.biblio.getEditionsByContributor` | query | none | `editions.contributors` | drop (use `searchEditions.author`) |
| `net.olamaelcu.livtet.biblio.getBooks` | query | none | `editions` + aliases | replace with `net.olamaelcu.livtet.biblio.getEditions` (batch) |
| `net.olamaelcu.livtet.biblio.listShelvesWithBooks` | query | none | mirror + catalog | HappyView |
| `net.olamaelcu.livtet.biblio.listReviewsByActor` | query | none | mirror + PDS fallback | HappyView; reads `community.lexicon.media.book.review` |
| `net.olamaelcu.livtet.biblio.listRecentShelving` | query | none | mirror | HappyView |
| `net.olamaelcu.livtet.biblio.getBookOnShelf` | query | none | PDS record + catalog | HappyView |

Two absences are deliberate and are not endpoints:

- `net.olamaelcu.livtet.biblio.getActor` has a lexicon but no handler is registered, so it 404s at
  the router and does not appear above.
- `com.atproto.server.describeServer` is deliberately unimplemented.

`net.olamaelcu.livtet.biblio.getEditions` likewise has a lexicon in
`packages/bibliograph-service/lexicons` but no registered handler; it is a new method in the target,
not part of the current surface.

## com.atproto.* (publisher repo and protocol)

These methods make the host look like the PDS of a single publisher DID. They serve prebuilt CAR
files produced by `scripts/build-lex-repo.ts`; the DID document at `/.well-known/did.json` advertises
this host as the `#atproto_pds` for the publisher DID.

#### `com.atproto.identity.resolveHandle`

Input `handle`. Only the configured handle (`LEX_PUBLISHER_HANDLE`, default
`biblio.livtet.olamaelcu.net`) resolves, to `{ did }` where the DID is `LEX_PUBLISHER_DID` or
`did:web:<handle>`. Any other handle is `400 HandleNotFound`. There is no DNS lookup.

#### `com.atproto.identity.resolveDid`

Input `did`. Returns `{ didDoc: getDidDocument() }` only when `did` equals the configured publisher
DID; otherwise `400 DidNotFound`.

#### `com.atproto.identity.resolveIdentity`

Input `identifier`. A `did:` input is routed through `resolveDid`, anything else through
`resolveHandle`. Returns `{ did, handle, didDoc }`. The error key follows the input shape:
`DidNotFound` for a DID, `HandleNotFound` for a handle.

#### `com.atproto.sync.getRecord`

Params `did`, `collection`, `rkey`. Only `collection = com.atproto.lexicon.schema` is served: the
handler reads `data/lex/<nsid with . → _>.car` and returns it as `application/vnd.ipld.car`. Any
other collection, or a missing slice, is `400 RecordNotFound` — note the 400, not 404.

#### `com.atproto.sync.getRepo`

Params `did`, optional `since`. Only the publisher DID is served. `since` is rejected with
`400 InvalidRequest`, because answering `since` with the full repo would look like a valid diff.
Otherwise the response is `data/lex/full.car`.

#### `com.atproto.sync.getRepoStatus`

Only the publisher DID. Parses the root commit of `full.car` and returns `{ did, rev, active: true }`.
A missing repo or commit is `400 RepoNotFound`.

#### `com.atproto.sync.getLatestCommit`

Only the publisher DID. Returns the root commit's `{ cid, rev }`; `400 RepoNotFound` when there is no
repo.

#### `com.atproto.sync.getBlocks`

Params `did`, `cids[]`. Only the publisher DID. `full.car` is parsed once per build (cache keyed by
file size and mtime) and block CIDs are indexed by string, so the response is a multi-block CAR
containing only the requested blocks that exist. Missing CIDs are omitted and no root is emitted.
`400 RepoNotFound` when the repo is absent.

#### `com.atproto.repo.getRecord`

Params `repo`, `collection`, `rkey`. Only the publisher DID is served.

- `community.lexicon.book.edition`: load the `editions` row, wire contributor refs, build
  `editionRecordValue`. An edition with no identifiers has no valid record form and answers
  `404 RecordNotFound`. The CID is computed with `cidForLex`; the response is
  `{ uri, cid, value }`. A description backfill is enqueued when `description` is missing.
- `community.lexicon.book.work` / `.contributor` / `.publisher`: load the matching row and return
  `workRecordValue` / `contributorRecordValue` / `publisherRecordValue`, with the CID computed the
  same way.
- `com.atproto.lexicon.schema`: read the per-rkey CAR slice, walk the MST for `collection/rkey`, take
  the last CID, CBOR-decode the block and return `{ uri, cid, value }`.
- Any other collection or repo: `400 RecordNotFound` / `400 RepoNotFound`.

#### `com.atproto.repo.describeRepo`

Params `repo` (DID or handle). Only the publisher identity resolves. Returns
`{ did, didDoc, handle, handleIsCorrect, collections }`, where `collections` is exactly
`["com.atproto.lexicon.schema"]`. `handleIsCorrect` probes
`https://<publisher-host>/.well-known/atproto-did` at most once per 5 minutes, serves the last known
answer on failure, and defaults to `true` when it has never succeeded.

#### `com.atproto.lexicon.resolveLexicon`

Params `nsid`. Serves only lexicons this host publishes, through `resolvePublishedLexicon`, returning
`{ uri, cid, schema }` computed from the local lexicon files and CAR. An unknown NSID is
`400 LexiconNotFound`. It performs no network lookup by design.

#### `com.atproto.label.queryLabels`

Params `uriPatterns[]`, `sources[]`, `cursor` (a numeric string), `limit`. Reads the `labels` table
through `queryLabels`, maps rows with `labelToJson`, and returns `{ labels, cursor }` where the cursor
is the next numeric `seq`.

## community.lexicon.book.* (catalog)

The catalog namespace. Handlers live in `book-queries.ts`; the search handlers delegate to
`SearchService`, which owns the provider fan-out and the merge rules. Most responses carry
`hasMore`/`total`/`degraded` flags from the sources rather than from a post-filter count.

#### `community.lexicon.book.compatibility`

No params. Returns a static `{ queries: [{ nsid, type }] }` listing `compatibility`,
`searchEditions`, `resolveEditions` (procedure), `searchWorks`, `searchContributors`,
`searchPublishers`.

#### `community.lexicon.book.searchEditions`

Params: `q`, `title`, `author`, `identifiers[]` (each `<type>:<value>`), `offset` (default 0),
`limit` (default 25, max 100). No cursor.

1. Trim the inputs. `400 InvalidQuery` when `q`, `title`, `author` and all identifiers are empty.
   Identifier hints that lack both halves are dropped — they name nothing a row can match.
2. Fold `q`, or `title + " " + author` when `q` is absent, into one text query.
3. `SearchService.searchEditions` runs three sources in parallel: Postgres
   (`editions.title ILIKE %text%`, plus identifier containment for each hint, plus the language
   filter, ordered `indexed_at DESC, uri ASC`, `LIMIT limit+1`, count only on the first page),
   Google Books, and Goodreads HTML search.
4. Remote editions run enrichers in order Google Books → ISBNdb → Wikidata. If Google Books returns
   nothing and the query is an ISBN, ISBNdb is tried. Goodreads results are enriched in parallel;
   items whose normalized title already exists in the Google/ISBNdb set are dropped. Remote items
   are sliced to `limit`.
5. Merge remote over local by `uri`: remote wins title/subtitle/description/cover/place/year/
   language/identifiers, local wins contributors and `indexedAt`. Slice to `limit`.
6. Cursor is remote's or Postgres's; `total` is the maximum defined total; `hasMore` is true if any
   source says so; `degraded` comes from the first source that reported it.
7. Remote items are synchronously ingested into the catalog (`syncIngestEditions`) before returning.
8. The handler maps each item to `editionViewFromItem` with contributor names, drops items with no
   identifiers (a `defs#editionView` requires one), and enqueues edition and contributor backfills.
   Empty contributor names increment `invalidContributorResponsesTotal`.

#### `community.lexicon.book.resolveEditions`

Procedure (`POST`). Input: `identifiers[]` (required), `offset` (default 0), `limit` (default 25,
max 100). There is no auth check today. Empty `identifiers` is `400 InvalidQuery`.

Each identifier becomes `editions.identifiers @> [{type,value}]`; the predicates are OR-ed, so a row
qualifies when any supplied pair matches exactly (`url` is display-only and ignored). Rows are
ordered `indexed_at ASC, uri ASC` with `LIMIT limit+1`, mapped with `editionItemFromRow`, then
`editionViewFromItem`; rows with no identifiers are dropped. `hasMore` comes from the extra row.
Edition and contributor backfills are enqueued.

#### `community.lexicon.book.searchWorks`

Params `q`, `id[]`, `limit` (default 20, max 100), `cursor`. `SearchService.searchWorks` queries
Postgres (`works.title ILIKE %q%` plus identifier containment, ordered `indexed_at DESC, uri ASC`
with a keyset cursor `(indexedAt, uri)` encoded as deflated base64url JSON) and Google Books works in
parallel, enriches with ISBNdb work + Wikidata, falls back to ISBNdb when Google Books is empty and
`q` is an ISBN, merges remote over local by `uri`, takes the cursor from remote or Postgres, always
counts `total` for works, and reports `hasMore` from any source. Remote items are synchronously
ingested (`syncIngestWorks`). The handler maps to `community.lexicon.book.work` and wires
contributors.

#### `community.lexicon.book.searchContributors`

Params `q`, `id[]`, `limit` (default 20, max 100), `cursor`. Local only:
`contributors.name ILIKE %q%`, identifier containment, `btrim(name) <> ''`, ordered
`indexed_at DESC, uri ASC`, keyset cursor, `total` always counted. The handler re-filters with
`validContributorName` (the lexicon requires `minLength: 1`), reports the dropped count,
maps to `community.lexicon.book.contributor`, and enqueues contributor backfills.

#### `community.lexicon.book.searchPublishers`

Params `q`, `id[]`, `limit` (default 20, max 100), `cursor`. Local only:
`publishers.name ILIKE %q%`, identifier containment, ordered `indexed_at DESC, uri ASC`, `total`
always counted. The handler forwards the service cursor, but the service currently returns none, so
only the first page is reachable by cursor. `imprintOf` is emitted only when it is a canonical
AT-URI.

## net.olamaelcu.livtet.biblio.* (reading activity)

### Follow graph

#### `net.olamaelcu.livtet.biblio.graph.isFollowing`

Params `follower`, `followed` (DIDs). One primary-key probe of `follows(follower_did,
followed_did)` returns `{ following: boolean }`. No viewer token: the follow graph is public data and
`did` names whose edges to read.

#### `net.olamaelcu.livtet.biblio.graph.listFollowers`

Params `did` (the followed actor), `cursor` (last follower DID), `limit` (default 100, max 1000).
Selects `follows.followed_did = did`, ordered `follower_did ASC`, keyset `follower_did > cursor`,
`LIMIT limit`. `total` is counted on the first page only and runs in parallel with the page query.
A cursor is emitted when the page is full.

#### `net.olamaelcu.livtet.biblio.graph.listFollowees`

Params `did`, `cursor` (last followee DID), `limit` (default 100, max 1000). Selects
`follows.follower_did = did`, ordered `followed_did ASC`, same keyset, with the first-page total
computed in parallel with the page.

### Reader records

#### `net.olamaelcu.livtet.biblio.getReadingGoal`

Param `did`. Reads `com.atproto.repo.getRecord` at
`net.olamaelcu.livtet.biblio.readingGoal/current` from the subject's PDS, anonymously, with a 10 s
timeout. `RecordNotFound` answers `{ goal: null }`; a malformed response also answers
`{ goal: null }`; any other failure is `502 UpstreamUnavailable`. The raw record value is returned as
`goal`.

#### `net.olamaelcu.livtet.biblio.getActorProfile`

Param `did`. Reads `com.atproto.repo.getRecord` at `net.olamaelcu.livtet.actor.profile/self` from the
subject's PDS, with the same error mapping as `getReadingGoal`, and returns
`{ profile: value | null }`. Note the collection: Livtet writes
`net.olamaelcu.livtet.actor.profile`, not the vendored `...biblio.actorProfile` lexicon.

#### `net.olamaelcu.livtet.biblio.searchActors`

Params `q` (3–200 characters), `hasRecords[]` (at most 8 NSIDs), `offset` (default 0), `limit`
(default 25, max 100). Reads the `actors` table. `q` matches an exact `did`, `handle ILIKE %q%`, or
`display_name ILIKE %q%` with `%`, `_` and `\` escaped. `hasRecords` is a correlated `EXISTS` over
`records(did, collection)` inside the same WHERE. Order `coalesce(handle, did) ASC, did ASC`,
`LIMIT limit+1`, `OFFSET`. `hasMore` comes from the extra row; `total` is counted on the first page.
`actorView` emits `did`, optional `handle`/`displayName`/`description`, and an `avatar` URL built as
`https://cdn.bsky.app/img/avatar/plain/<did>/<avatarCid>`. Bounds violations are `400 InvalidQuery`.

### Shelves

#### `net.olamaelcu.livtet.biblio.getShelf`

Param `uri` (shelf AT-URI). The DID is parsed from the URI and
`net.olamaelcu.livtet.biblio.shelf/<rkey>` is read from that PDS. `RecordNotFound` maps to
`404 RecordNotFound`; other upstream failure is 502. Builds `defs#shelfView` with
`shelfViewFromValue` (required `name`; `description` and timestamps only when declared) and returns
`{ shelf }`.

#### `net.olamaelcu.livtet.biblio.listShelves`

Params `did`, `limit` (default 50), `cursor`.

- First page: `com.atproto.repo.listRecords` for the `shelf` collection on the reader's PDS; each row
  becomes a `shelfView`; the PDS cursor is tagged `pds:<cursor>`. If the PDS scan throws, the handler
  falls back to the mirror.
- A `pds:` continuation resumes the PDS scan from its cursor.
- Legacy and mirror continuation: `tap:<offset>` pages `records` for `(did, shelf)` ordered
  `record_created_at DESC, uri DESC` with `LIMIT limit+1 OFFSET offset`.
- On the first page only, derived Bookhive shelf containers are appended: distinct
  `buzz.bookhive.book.status` values for the DID map to the fixed shelf rkeys (`reading`, `read`,
  `to-read`, `dnf`); a real shelf record with the same URI wins, and the derived list is sorted by
  URI.
- Returns `{ shelves, cursor }`.

#### `net.olamaelcu.livtet.biblio.listShelvesWithBooks`

Params `did` (optional), `limit` (default 50), `booksPerShelf` (default 25, clamped 1–100), `cursor`
which must be `tap:<shelf-uri>`; any other tier or a non-AT-URI value is `400 InvalidRequest`.

- Select `shelf` records ordered `uri ASC`, keyset `uri > cursor`, `LIMIT limit+1`, scoped to `did`
  when given.
- First page only: derive Bookhive shelf containers from the DID's `buzz.bookhive.book` statuses and
  append only URIs not already present.
- For each shelf, inside one transaction with `statement_timeout = 4s` and a 5 s JS deadline, select
  shelf entries (`shelfEntryConditions`) ordered `uri ASC`, `LIMIT booksPerShelf`. The deadline can
  truncate the preview.
- Hydrate books in one batch, resolve each entry (`resolveBookShelf`), drop unresolvable rows, and
  sort with `compareShelfBooks`: `metadata.position` ascending first (a row with no position sorts
  after every positioned row), then `uri` ascending.
- Output `shelves: defs#shelfWithBooksView[]`; the cursor is `tap:<last shelf uri>` when another
  shelf exists.

### Shelving

#### `net.olamaelcu.livtet.biblio.getShelvingOfBook`

Params `book` (AT-URI), `did`, `limit` (default 50, max 100), `cursor` (interpreted as an offset).

1. Mirror: `records` where `(did, bookShelving, value->'book'->>'uri' = book)`, ordered `uri ASC`,
   `OFFSET cursor LIMIT limit+1`.
2. If the page is short and there is no cursor: Constellation backlinks with `subject = book`, source
   `net.olamaelcu.livtet.biblio.bookShelving` and a `did` filter, `limit` records; each backlink is
   fetched from its PDS with concurrency 6. If Constellation returns a cursor and the page is full, it
   is returned as the cursor.
3. If the page is still short and there is no cursor: scan the reader's PDS `bookShelving` collection
   page by page, keeping records whose `book.uri` equals `book`.
4. If it is still short and there is no cursor: resolve the edition's Bookhive catalog subject (the
   `bh.` rkey or the `bookhive` identifier URL), fetch Constellation backlinks with source
   `buzz.bookhive.book:hiveBookUri`, read each `buzz.bookhive.book` record from its PDS, and keep
   those with a shelf or status.
5. Hydrate everything to `defs#bookShelfView` (book from the catalog; Bookhive rows synthesize a book
   view from their own title and authors when the catalog row is absent).
6. The cursor is emitted only for the mirror tier, as `offset + number of returned rows` —
   hydration drops unresolvable rows, so the emitted count is not the scanned count.

#### `net.olamaelcu.livtet.biblio.getShelversOfBook`

Params `bookUri`, optional `shelvingRkey` (default: the last path segment of `bookUri`), `limit`
(default 50), `cursor`.

- Bookhive DIDs are read on every page: mirror rows matching `shelfEntryConditions({ apps:
  ['bookhive'], bookhiveSubject })`. There is no shelf record to resolve, so they cannot be expressed
  by the shelving cursor; they are unioned into the answer.
- A `con:` cursor resumes Constellation backlinks for `bookUri` (source
  `net.olamaelcu.livtet.biblio.bookShelving`) and returns distinct DIDs from the records'
  authorities and rkeys, in record order.
- `tap:<offset>` pages the mirror for `(collection = bookShelving, rkey = shelvingRkey,
  book.uri = bookUri)` ordered `uri ASC`, `LIMIT limit+1`.
- If the mirror page is full the handler emits `tap:offset+limit`; otherwise it takes the remainder
  from Constellation, with a `con:` cursor when Constellation has more.
- Returns `{ bookUri, dids, cursor }`.

#### `net.olamaelcu.livtet.biblio.listBooksOnShelf`

Params `shelf` (AT-URI; its DID is the reader), `limit` (default 50), `cursor`.

- `con:` continuation: Constellation backlinks with `subject = shelf`, source
  `net.olamaelcu.livtet.biblio.bookShelving:shelf` and a `did` filter; each record is fetched from its
  PDS with concurrency 6, then hydrated.
- `pds:` continuation: scan the reader's PDS `bookShelving` collection, up to 40 pages per request,
  keeping `shelf === shelfUri`. Whole pages are consumed so no match is skipped; the cursor resumes
  the repo cursor.
- `tap:<offset>`: mirror `shelfEntryConditions({ shelfUris: [shelf], did })` ordered
  `record_created_at DESC, uri DESC`, `LIMIT limit+1 OFFSET offset`.
- First page only: after the mirror page, if it is short, the handler scans the PDS; if the merged
  page is still empty, it pulls Constellation backlinks. The PDS scan is preferred because
  per-record backlink reads trip the PDS rate limit.
- Hydrates `bookShelves`; the cursor belongs to the tier that still has records.

#### `net.olamaelcu.livtet.biblio.listRecentShelving`

Params `limit` (default 50), `cursor` (base64url `{t,u}` keyset). Selects `shelfEntryConditions()`
(both `bookShelving` and Bookhive `book` with a status) where `(recordCreatedAt, uri) <
(cursor.t, cursor.u)`, ordered `record_created_at DESC, uri DESC`, `LIMIT limit+1`. Hydrates
`bookShelfView`s. The cursor is taken from the last *scanned* row, not the last emitted view, because
hydration drops unresolvable books.

#### `net.olamaelcu.livtet.biblio.getBookOnShelf`

Param `uri` (AT-URI of the shelving record). The DID is parsed from the URI; if the URI names
`buzz.bookhive.book` the handler fetches that record from the PDS, otherwise it fetches
`bookShelving`. A missing record is `404 RecordNotFound`. A Bookhive copy with no reading status is
owned, not shelved, and answers `404` with that message. Hydrates to a `bookShelfView`; if the book
cannot be resolved, the error names the catalog URI derived from the rkey.

### Shelf items

#### `net.olamaelcu.livtet.biblio.listShelfItems`

Params `shelf` (AT-URI), `limit` (default 50, clamped 1–100), `cursor`.

- A `pds:` continuation scans the reader's `shelfItem` collection, up to 40 pages, keeping
  `isShelfItemOf(record, shelfUri)`.
- The first page always scans the PDS and returns immediately, because a delete is not visible to the
  mirror until TAP consumes it. If the scan throws, the handler falls back to the mirror.
- `tap:<offset>` pages `records` with `shelfItemConditions` ordered `uri ASC`, `LIMIT limit+1`.
- Hydration: the shelf view comes from the mirror or from one PDS read; books are batched from the
  catalog; missing editions are lazily resolved (at most 6 per request, 2.5 s budget, 10 min negative
  cache), and rows still missing are dropped.

#### `net.olamaelcu.livtet.biblio.listShelfItemsByBook`

Params `book` (AT-URI), `did`, `limit` (default 50, clamped 1–100), `cursor`. Same PDS-first policy as
`listShelfItems`, but the collection filter is `book.uri = book` and the mirror predicate is
`shelfItemBookConditions`. Hydration batches shelf views, reads missing shelf records from the PDS
(concurrency 6), resolves the book once, and drops rows whose shelf or book cannot be built.

### Reviews

#### `net.olamaelcu.livtet.biblio.getReviewsByBook`

Params `book` (AT-URI), `limit` (default 25, max 100), `cursor` (an offset).

- Resolve the edition's Bookhive catalog subject.
- Mirror query: `(collection = bookReview AND book in {string, book.uri, book.ref})` OR
  `(collection = buzz.bookhive.book AND hiveBookUri = subject AND coalesce(review,'') <> '')`,
  ordered `record_created_at DESC, uri DESC`, `LIMIT limit+1 OFFSET cursor`.
- Native rows are mapped with `reviewViewFromRow` (folds all three book ref shapes; `text` defaults to
  `''`; `createdAt` defaults to now); Bookhive rows with `reviewViewFromBookhiveRow` (text and rating
  from the inline `review`, `createdAt` from the record or the review).
- First page only, when the page is short and a Bookhive subject exists: Constellation backlinks for
  the subject (source `buzz.bookhive.book:hiveBookUri`), each record fetched from its PDS with
  concurrency 6, keeping those with a review and appending unseen ones.
- Returns `{ reviews, cursor }`.

#### `net.olamaelcu.livtet.biblio.listReviewsByActor`

Params `did`, `limit` (default 25), `cursor`.

- Mirror rows for `did` in `[bookReview, buzz.bookhive.book]` where the row is either a native review
  or a Bookhive record with a non-empty `review` or a `stars` field; ordered
  `record_created_at DESC, uri DESC`, `LIMIT limit+1 OFFSET offset`.
- Map to `reviewView`; rows with no book URI are dropped.
- First page only, when the page is short: read `com.atproto.repo.listRecords` for each collection
  from the actor's PDS, apply the same Bookhive predicate, skip URIs already rendered, and
  `fillEmptyMirrorRow` for rows TAP stored as `{}`.

### Catalog books and images

#### `net.olamaelcu.livtet.biblio.getEditionsByContributor`

Param `contributor` (must be a `community.lexicon.book.contributor` AT-URI), `limit` (default 20).
Any non-contributor AT-URI is `400 InvalidContributor`. Selects `editions.uri` where
`editions.contributors @> [{ subject: { uri: contributor } }]` (GIN index), ordered
`created_at DESC, uri ASC` — the record's own stamp, not `indexed_at` — `LIMIT limit`. Returns
`{ uris }` and enqueues edition and contributor backfills.

#### `net.olamaelcu.livtet.biblio.getBooks`

Params `uris[]` (1–100). Dedupes the input, hydrates with `hydrateBooksByUri` (each URI resolves
through `edition-lookup`, so a retired URI collapses onto its surviving book; contributor names are
inlined; empty-name refs are dropped), and returns one `bookView` per canonical `view.uri` — two input
URIs naming one book produce one row. Unknown URIs are silently omitted. 502 on failure.

#### `net.olamaelcu.livtet.biblio.getImageForBook`

Param `uri`. The URI is resolved through `resolveEditions` (aliases included). If no row exists, the
handler validates the rkey shape: `gb.` must be a valid Google Books rkey; `bh.` is accepted as a
Bookhive mirror and answers `404 RecordNotFound` when the row is absent; anything else is
`400 InvalidRequest`.

- If `cover_image_url` exists it becomes a datacenter URL, proxied through `/image/cover` when the
  source URL is allowed, and returned directly otherwise.
- Else, if the rkey is `bh.`, the handler finds a mirrored `buzz.bookhive.book` with a cover — first
  by `hiveBookUri`, then by `hiveId`, three candidates each — and returns
  `/image/bookhive/<did>/<cid>`.
- Else it enqueues edition backfills (a no-op in steady state) and returns `{ url: undefined }`.

#### `net.olamaelcu.livtet.biblio.getImageForContributor`

Param `uri` must be a `community.lexicon.book.contributor` AT-URI; anything else is
`400 InvalidContributor`. Selects the contributor row; missing is `404 RecordNotFound`. Returns
`{ url }` when `image_url` exists, otherwise enqueues the image and bio resolvers (deduped by job key;
already-checked rows are not re-enqueued) and returns `{}`.

## Feed generator

#### `com.atproto.feed.describeFeedGenerator`

Returns the publisher DID and five feeds:

| Feed | Display name | Auth |
| --- | --- | --- |
| `public` | Bibliograph Static Feed | no auth |
| `dynamic` | Bibliograph Dynamic Feed | auth |
| `following` | Reviews and shelving by people you follow | auth |
| `extended` | Reviews and shelving by people followed by the people you follow (2 hops) | auth |
| `recommendations` | Editions readers who share your ratings also finished, layered over genre matches from your own shelf | auth |

#### `com.atproto.feed.getFeedSkeleton`

Params `feed` (AT-URI), `cursor` (a numeric offset), `limit` (default 5, max 100). The feed type is
the path segment after `net.olamaelcu.livtet.biblio.feed.generator/`.

- `public` / `static`: newest records across `bookReview`, `bookShelving` and `buzz.bookhive.book`,
  ordered `record_created_at DESC, uri DESC`, paged by offset. When a viewer is known, their own
  records and authors blocked via `blockedAmong` are excluded.
- `following`: the viewer comes from a service JWT or the session cookie. Hop 1 is the DIDs the
  viewer follows, read from the viewer's PDS `follow` collection (at most 20 × 100 pages, 60 s memo,
  512 entries). Blocked authors are filtered. Records are paged by those DIDs. If the viewer follows
  nobody on offset 0, the global feed is returned; an exhausted page stays empty.
- `extended`: hop 1 as above (excluding the viewer), then hop 2 is the union of the hop-1 follow
  sets, read in batches of 8, capped at 500, excluding the viewer and hop 1. Same paging and fallback
  rules.
- `dynamic`: requires `requireFeedAuth` and has a per-DID rate limit bucket. It uses the same hop-1
  follow graph and paging, falling back to the global feed only when the viewer follows nobody at
  offset 0.
- `recommendations`: requires `requireFeedAuth` and a per-DID rate limit. Reads the viewer's library
  from their PDS (`bookShelving`, `shelfItem`, `bookReview`; 10 × 100 pages, 60 s cache). Candidate
  sets: (a) editions of works sharing the `subjects` of currently-reading books, then of finished
  books; (b) linklonk vote signals; (c) books mutuals shelved or reviewed
  (`ORDER BY count(DISTINCT mutual) DESC, has_cover DESC`). Merge order is active → past → linklonk →
  mutual, de-duplicated by `tid`; an edition with a cover may replace a coverless edition of the same
  book in place. Every book the viewer has a record for is excluded. Returns at most 30 entries
  (`RECOMMENDATION_LIMIT`), each with `post` = edition URI and `reason = "recommendation"`, in a
  single page with no cursor.
- `edition/<rkey>`: Constellation backlinks with `subject =
  at://<publisher>/net.olamaelcu.livtet.biblio.edition/<rkey>` and source
  `net.olamaelcu.livtet.biblio.bookReview:book.uri`, then Bookhive backlinks resolved through the
  edition's Bookhive subject (source `buzz.bookhive.book:hiveBookUri`), with `reason` "Backlink from
  edition review" and "Bookhive review backlink" respectively; falls back to the global DB page when
  both are empty.
- Unknown feed type: `{ feed: [], cursor: undefined }`.
- `reason` strings: a review carries the reviewed book URI; shelving carries
  `shelving:<shelf-rkey>|<book-uri>`; a Bookhive record carries `bookhive:<shelf-rkey>|<book-uri>`.

## Error shapes, caching and identity

| Status | Error values | Origin |
| --- | --- | --- |
| 400 | `InvalidRequest` | `sync.getRepo` with `since`; `listShelvesWithBooks` with a non-`tap:` or non-AT-URI cursor; `getImageForBook` with an unrecognized rkey shape |
| 400 | `InvalidQuery` | `searchEditions` with no `q`/`title`/`author`/identifiers; `resolveEditions` with empty `identifiers`; `searchActors` outside `q` 3–200 or `hasRecords` > 8 |
| 400 | `InvalidContributor` | `getEditionsByContributor`, `getImageForContributor` when the URI is not a `community.lexicon.book.contributor` AT-URI |
| 400 | `RecordNotFound` | `sync.getRecord` for a non-lexicon collection or a missing CAR slice; `repo.getRecord` for an unknown collection |
| 400 | `RepoNotFound` | `sync.getRepoStatus`, `sync.getLatestCommit`, `sync.getBlocks` with no repo; `repo.getRecord` for the wrong repo |
| 400 | `HandleNotFound` | `identity.resolveHandle`, `identity.resolveIdentity` with a non-DID identifier |
| 400 | `DidNotFound` | `identity.resolveDid`, `identity.resolveIdentity` with a DID identifier |
| 400 | `LexiconNotFound` | `lexicon.resolveLexicon` for an unpublished NSID |
| 401 / 403 | auth failure envelope | `requireFeedAuth` on the `dynamic` and `recommendations` generators |
| 404 | `RecordNotFound` | `getShelf`, `getBookOnShelf`, `getImageForContributor`; `repo.getRecord` for an edition with no identifiers |
| 429 | `RateLimited`, `retry-after: 60` | the per-IP middleware, and the per-DID bucket on authenticated feeds |
| 502 | `UpstreamUnavailable` | a PDS or provider failure in the reader, catalog and image handlers |

Identity is proved in exactly two ways (`viewerDidFromRequest`): a service JWT in
`Authorization: Bearer` whose `lxm` matches the method (`verifyFeedAuth`), or the `bib_session` cookie
resolved against `web_sessions`. Nothing else names a viewer; `x-viewer-did` is not accepted.

Two methods are deliberately absent rather than broken: `com.atproto.server.describeServer` is not
implemented, and `net.olamaelcu.livtet.biblio.getActor` has a lexicon but no registered handler.

Cache headers, exactly: unauthenticated GET XRPC responses that set none of their own get
`public, max-age=60, stale-while-revalidate=300` from `hooks.server.ts`; every CAR response gets
`public, max-age=60, s-maxage=300`.

## Target disposition (HappyView greenfield)

| Current endpoint | Disposition |
| --- | --- |
| `com.atproto.identity.resolveHandle` / `resolveDid` / `resolveIdentity` | Kept at the edge, protocol |
| `com.atproto.repo.getRecord` / `describeRepo` | Kept at the edge, protocol |
| `com.atproto.sync.getRecord` / `getRepo` / `getRepoStatus` / `getLatestCommit` / `getBlocks` | Kept at the edge, protocol |
| `com.atproto.lexicon.resolveLexicon` | Kept at the edge, protocol |
| `com.atproto.label.queryLabels` | Kept at the edge, protocol |
| `com.atproto.feed.describeFeedGenerator` | Kept at the edge, protocol |
| `com.atproto.feed.getFeedSkeleton` | Kept at the edge, protocol — four feeds only; no `recommendations` |
| feed type `recommendations` | Dropped |
| `net.olamaelcu.livtet.biblio.getImageForBook` | Kept at the edge, catalog — edition `coverUrl` only |
| `net.olamaelcu.livtet.biblio.graph.isFollowing` / `listFollowers` / `listFollowees` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.getReadingGoal` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.getActorProfile` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.getShelf` / `listShelves` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.getShelvingOfBook` / `getShelversOfBook` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.listBooksOnShelf` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.listShelfItems` / `listShelfItemsByBook` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.getReviewsByBook` / `listReviewsByActor` | Kept at HappyView |
| `net.olamaelcu.livtet.biblio.listShelvesWithBooks` / `listRecentShelving` / `getBookOnShelf` | Kept at HappyView |
| `community.lexicon.book.searchEditions` | Replaced by `community.lexicon.media.book.searchEditions` (procedure) |
| `community.lexicon.book.resolveEditions` | Replaced by `community.lexicon.media.book.resolveEditions` (procedure) |
| `net.olamaelcu.livtet.biblio.getBooks` | Replaced by `net.olamaelcu.livtet.biblio.getEditions` (batch query) |
| `community.lexicon.book.compatibility` | Dropped — no WG equivalent |
| `community.lexicon.book.searchWorks` | Dropped — no works |
| `community.lexicon.book.searchContributors` | Dropped — contributors are inline |
| `community.lexicon.book.searchPublishers` | Dropped — publishers are inline |
| `net.olamaelcu.livtet.biblio.getEditionsByContributor` | Dropped — use `searchEditions.author` |
| `net.olamaelcu.livtet.biblio.getImageForContributor` | Dropped — no contributor records |
| `net.olamaelcu.livtet.biblio.searchActors` | Dropped — use `app.bsky.actor.searchActors` |

The two replacement procedures are catalog lookups over `editions`, `edition_identifiers` and
`edition_contributors`. Both are read-only and served at the edge.

The target namespace `community.lexicon.media.book.compatibility` is also not served: there is no WG
definition for it.

Dropped along with the endpoints: works, contributor records, publisher records, Bookhive, voting and
edition→work linking. `setEditionWorkLink` belongs to that work-link surface, though no such XRPC
handler is registered today: the `net.olamaelcu.livtet.biblio.editionWorkLink` record is written by
the storefront's vote flow through OAuth, not through an XRPC procedure.

Deleted behavior: every `tap:`/`con:`/`pds:` tier, every per-request PDS read, every Constellation
call, `web_sessions` viewer resolution, the `follows` and `records` projections, and every Bookhive
branch. HappyView's index becomes the only activity source; a record missing from the index is
reported missing and repaired by backfill/reconcile, not by an inline fallback.

Wire changes are expected: the `community.lexicon.book.*` namespace is not served, works,
contributors and publishers are gone, and `searchEditions` / `resolveEditions` move from GET (and
one POST) to POST procedures. The current surface above is history; the table below is the contract.

## Target surface

| NSID | Method | Home | Behavior |
| --- | --- | --- | --- |
| `com.atproto.identity.resolveHandle` / `resolveDid` / `resolveIdentity` | GET | edge → PDS | Proxy publisher identity; no local CAR. |
| `com.atproto.repo.getRecord` / `describeRepo` | GET | edge → PDS | Proxy; catalog records are read from the PDS. |
| `com.atproto.sync.*` | GET | edge → PDS | Proxy `getRecord`, `getRepo`, `getRepoStatus`, `getLatestCommit`, `getBlocks`. |
| `com.atproto.lexicon.resolveLexicon` | GET | edge | Local lexicon map; `{uri,cid,schema}`. |
| `com.atproto.label.queryLabels` | GET | edge | `labels` table. |
| `com.atproto.feed.describeFeedGenerator` | GET | edge | Four feeds: `public`, `following`, `extended`, `dynamic`. |
| `com.atproto.feed.getFeedSkeleton` | GET | edge | Reviews (`community.lexicon.media.book.review`) and shelving; service JWT for personalized feeds. |
| `community.lexicon.media.book.searchEditions` | POST | edge | Record lookup: `q`/`title` → title ILIKE; `author` → contributor name; `identifiers` → exact `(issuer,value)`; `offset`/`limit`; returns `defs#editionResults`. |
| `community.lexicon.media.book.resolveEditions` | POST | edge | `identifiers[]` required; OR across exact pairs; returns `defs#editionResults`. |
| `net.olamaelcu.livtet.biblio.getEditions` | GET | edge | `uris[]` (1–100); batch `defs#bookView` (`{uri, edition}`); unknown omitted. |
| `net.olamaelcu.livtet.biblio.getImageForBook` | GET | edge | `uri` → edition `coverUrl`; 404 absent. |
| `net.olamaelcu.livtet.biblio.graph.isFollowing` / `listFollowers` / `listFollowees` | GET | HappyView | `happyview_records` follow rows. |
| `getReadingGoal` / `getActorProfile` | GET | HappyView | Indexed records at `readingGoal/current` and `net.olamaelcu.livtet.actor.profile/self`. |
| `getShelf` / `listShelves` | GET | HappyView | Shelf records; no Bookhive containers. |
| `getShelvingOfBook` / `getShelversOfBook` | GET | HappyView | `bookShelving` rows only; no tiers. |
| `listBooksOnShelf` / `listShelfItems` / `listShelfItemsByBook` | GET | HappyView | Shelf/shelfItem rows joined to `appview_book`. |
| `getReviewsByBook` / `listReviewsByActor` | GET | HappyView | `community.lexicon.media.book.review` rows; match by `subjectRecord` or identifier overlap. |
| `listShelvesWithBooks` / `listRecentShelving` / `getBookOnShelf` | GET | HappyView | Bookshelf views from `bookShelving` only. |
| `community.lexicon.media.book.edition` | record | PDS | Published by the outbox worker; not indexed by HappyView. |
| `community.lexicon.media.book.review` | record | user PDS | Indexed by HappyView; read by review queries. |

Procedures: exactly `searchEditions` and `resolveEditions`, both read-only. There is no
`setEditionWorkLink`, no vote/link procedure, and no write procedure of any kind, so the deployment
has no end-user OAuth: clients write their own records to their own PDS.
