# HappyView greenfield AppView plan

## Context

Bibliograph's core AppView job is to own two things the network cannot: **book identity** (canonical edition records, identifier bags, inline contributors/publishers, enrichment) and **cross-user reading activity views** (shelf, shelving, shelf items, reviews, follows, goals). Everything else — UI, writing a reader's records — belongs to clients.

`HAPPYVIEW_REBUILD_PLAN.md` treats the whole app as AppView logic and ports catalog enrichment, provider clients, nine background jobs and every query into Lua. Reconsidered as a greenfield build on HappyView, that is the wrong seam: the catalog/provider half is not record-shaped and cannot be expressed as lexicons, while the activity half is exactly what HappyView indexes and serves. The rebuild is therefore split by data ownership, not by transport.

This plan supersedes `HAPPYVIEW_REBUILD_PLAN.md`. It also produces `docs/xrpc.md`, which records what every existing XRPC endpoint does today, so the port/delete decisions are explicit.

**No data is carried over.** This is a greenfield deployment, not a migration: no catalog rows, published records, labels, votes, users, HappyView index, or PDS repo contents from this repository or its current database are imported. Every table starts empty; the first deploy creates the first records. Code is reused where it earns its keep, but nothing in the plan reads or copies existing rows.

End state:

- **Catalog/authoring plane (TypeScript, edge + graphile worker).** Catalog tables are the mutable source of truth; provider clients, enrichment, edition publication to a real PDS, labeler, feed generator, image routes and the XRPC gateway stay here.
- **Activity plane (HappyView 2.17.4).** Jetstream + backfill index the activity collections into `happyview_records`; Lua query scripts serve every activity query from that index. HappyView owns no user-write procedure and no Bibliograph browser session.
- **General PDS (`rsky-pds` 1.14.18).** Hosts `did:web:biblio.livtet.olamaelcu.net`, `did:web:olamaelcu.net`, and the published catalog records; one multi-account PDS on lescayes.
- **One Postgres database.** HappyView's `happyview_*` tables and the app's public tables share it. Activity Lua joins a single `appview_book` SQL view over the catalog tables; no other catalog coupling exists at read time.

The books-wg edition record inlines contributors and one publisher on the wire, but the database does not: `contributors` and `publishers` are entities, linked to editions through `edition_contributors` and `edition_publishers` many-to-many tables. The inline array/object is materialized only in `editionRecordValue` (publication) and `appview_book` (read model), so a contributor or publisher can be renamed, merged or linked without duplicating rows.

## Target architecture

| Component | Public origin | Owns |
| --- | --- | --- |
| `bibliograph-service` (SvelteKit, `adapter-node`) | `https://biblio.livtet.olamaelcu.net` | UI/SSR, XRPC gateway and edge handlers, catalog tables + enrichment, edition lookup procedures, provider ingestion, PDS publisher, labeler, feed generator, cover/image proxy, DID documents, PDS proxy |
| `happyview` (Debian package `2.17.4`, `BASE_PATH=/~/hv`) | internal `127.0.0.1:3000`, proxied at `/~/hv` | Jetstream ingestion, backfill, `happyview_records`, activity query lexicons + Lua, dashboard OAuth |
| `pds` (`rsky-pds` 1.14.18, Debian package from the pinned infra submodule) | `https://pds.olamaelcu.net` | multi-account PDS: publisher repo, `olamaelcu.net`, and published catalog records |
| `postgres` | localhost:5432 | one database, `public` schema |

Routing at the public origin:

```
/xrpc/<nsid>
  ├─ edge handlers:
  │    com.atproto.label.*, com.atproto.feed.*,
  │    com.atproto.lexicon.resolveLexicon,
  │    community.lexicon.book.* (search*, resolveEditions, compatibility),
  │    net.olamaelcu.livtet.biblio.getImageForBook,
  │    net.olamaelcu.livtet.biblio.getImageForContributor,
  │    net.olamaelcu.livtet.biblio.searchActors,
  │    net.olamaelcu.livtet.biblio.getBooks,
  │    net.olamaelcu.livtet.biblio.getEditionsByContributor
  ├─ com.atproto.repo.*, com.atproto.sync.*, com.atproto.identity.*,
  │  com.atproto.server.describeServer
  │  → PDS proxy (publisher DID) or generic PDS proxy (other DIDs)
  └─ everything else
       → HappyView /~/hv/xrpc/<nsid> with X-Client-Key/Secret
```

### Locked decisions

1. **HappyView stable `2.17.4`, not the 3.x beta.** Its script contract is the v2 globals (`handle()`, `db`, `Record`, `http`, `env`, `params`, `input`, `caller_did`), the documented admin upload APIs, and cookie login. `3.0.0-beta.10` changes scripts to `handle(input, ctx)` + `require("happyview.*")`; writing against a two-day-old beta before a first deploy is avoidable risk. Scripts are written so the shipped v3 codemod can rewrite them mechanically later.
2. **Activity reads in HappyView; catalog reads at the edge.** No catalog/provider code is reimplemented in Lua. This is the greenfield seam: lexicons describe activity records, not enrichment jobs.
3. **HappyView's index is the only activity source.** The mirror→Constellation→PDS tiers in the current handlers are deleted. HappyView Jetstream + backfill + `POST /admin/records/collection/reconcile` replace them. No request path reads a user's PDS or Constellation.
4. **Catalog writes stay TypeScript.** HappyView never writes `editions`/`edition_identifiers`/`edition_contributors`.
5. **Publication stays a TypeScript outbox worker.** Only `community.lexicon.media.book.edition` records are published; there is no Lua record builder or `applyWrites`.
6. **No external record storage.** HappyView runs its default local storage so Lua `db.raw` can join `happyview_records` to `appview_book`. `RecordStorage`/shared record stores are not configured.
7. **Query error envelope.** HappyView query scripts always answer HTTP 200. A script that must signal a non-200 returns `{ __bib_http = { status = N, body = { error = "...", message = "..." } } }`; the edge gateway unwraps it and returns `body` with status `N`. Success bodies pass through unchanged.
8. **No end-user OAuth.** Bibliograph has no login, no session cookie and no write procedure. HappyView's OAuth is only for its own dashboard at `/~/hv/`; XRPC calls are identified by `X-Client-Key`, and personalized feeds by a service JWT. `oauth_sessions`, `oauth_states`, `web_sessions` and `@atproto/oauth-client-node` are deleted.
9. **Delete TAP and the old mirror.** `records`, `follows`, `tap_dead_letter`, `ingest_dead_letter` and the TAP consumer go away.

### Authentication model

- `X-Client-Key` identifies the calling application and is the rate-limit bucket. It is **not** user authentication.
- HappyView OAuth authenticates a user for two things only: procedures that write to that user's PDS, and the HappyView dashboard. The target surface has no user-write procedure, so Bibliograph never obtains an end-user OAuth session. OAuth is therefore internal HappyView access, not how XRPC calls are authenticated.
- The admin API uses separate `hv_` API keys (`HAPPYVIEW_ADMIN_KEY`), never an XRPC client key.
- Personalized feed skeletons authenticate with an atproto service JWT (`Authorization: Bearer`, `lxm = com.atproto.feed.getFeedSkeleton`); they do not use a cookie.

## Step 1 — Write `docs/xrpc.md`

Create `docs/xrpc.md` with the content below. It is the behavioral spec for the port: every statement is drawn from the current implementation, and the final section says where each endpoint runs in the target. Write it before any code change.

### 1.1 Structure

```
# XRPC surface: current logic

## Conventions
## Inventory
## com.atproto.* (publisher repo and protocol)
## community.lexicon.book.* (catalog)
## net.olamaelcu.livtet.biblio.* (reading activity)
## Feed generator
## Error shapes, caching and identity
## Target disposition (HappyView greenfield)
## Target surface
```

### 1.2 Conventions section (write verbatim, adjusted only for headings)

- Transport: `GET /xrpc/<nsid>` for queries, `POST /xrpc/<nsid>` for procedures. JSON bodies; CAR responses for the `com.atproto.sync.*` endpoints.
- Auth today: most queries are anonymous. A viewer is proved two ways only (`viewerDidFromRequest` in `xrpc-router.ts`): a service JWT in `Authorization: Bearer` whose `lxm` matches the method (`verifyFeedAuth`), or the storefront cookie `bib_session` looked up in `web_sessions`. A bare `x-viewer-did` header is deliberately not honored. The feed's `dynamic` and `recommendations` generators require `requireFeedAuth`.
- Pagination: cursors are opaque. The shared parser accepts `<tier>:<value>` (`tap:`, `con:`, `pds:`) and keeps pre-tagging cursors working: a bare number is a mirror offset, anything else a Constellation cursor. `listRecentShelving` uses a base64url `{t,u}` keyset cursor on `(recordCreatedAt, uri)`. `listShelvesWithBooks` uses `tap:<last shelf uri>`.
- Errors: `{ "error": string, "message": string }` with 400 (`InvalidRequest`, `InvalidQuery`, `InvalidContributor`, `RecordNotFound`, `RepoNotFound`, `HandleNotFound`, `DidNotFound`, `LexiconNotFound`), 401, 403, 404, 429 (`RateLimited`, `retry-after: 60`), 502 (`UpstreamUnavailable`). A missing optional record is usually `200` with `null` (`getReadingGoal`, `getActorProfile`) or an empty field (`getImageForContributor`), not an error.
- Record provenance: `records` is the TAP mirror (`collection`, `did`, `value`, `created_at`, `record_created_at`). `PDS` means a direct `com.atproto.repo.getRecord/listRecords` read of the owner's PDS. `Constellation` is the backlink service. `follows` is the materialized follow index. Those three fallback tiers exist only because the mirror can lag; they are removed in the target.
- Caching: `hooks.server.ts` applies `public, max-age=60, stale-while-revalidate=300` to unauthenticated GET XRPC responses that did not set their own `cache-control`. CAR responses set `public, max-age=60, s-maxage=300`.
- Rate limiting: per-IP for anonymous traffic, per-DID for authenticated feed calls. The key is the last `x-forwarded-for` hop (or `x-real-ip`).

### 1.3 Inventory table (write all rows)

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
| `com.atproto.feed.getFeedSkeleton` | query | service JWT for `dynamic`/`following`/`extended` | `records`, follow PDS reads, catalog | edge; no `recommendations` |
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

Do not list `net.olamaelcu.livtet.biblio.getActor`: its lexicon exists but no handler is registered. Do not list `com.atproto.server.describeServer`: deliberately unimplemented.

### 1.4 Per-query logic

Write one subsection per NSID using the facts below, grouped by family in the order the document's sections list them.

#### `com.atproto.identity.resolveHandle`

Input `handle`. The lex publisher resolves only the configured handle (`LEX_PUBLISHER_HANDLE`, default `biblio.livtet.olamaelcu.net`) and returns `{ did }` (`LEX_PUBLISHER_DID` or `did:web:<handle>`). Any other handle is `400 HandleNotFound`. No DNS.

#### `com.atproto.identity.resolveDid`

Input `did`. Returns `{ didDoc: getDidDocument() }` only when `did` equals the configured publisher DID; otherwise `400 DidNotFound`.

#### `com.atproto.identity.resolveIdentity`

Input `identifier`. A `did:` input goes through `resolveDid`, otherwise `resolveHandle`. Returns `{ did, handle, didDoc }`; the error key is `DidNotFound` or `HandleNotFound` according to the input shape.

#### `com.atproto.sync.getRecord`

Params `did`, `collection`, `rkey`. Only `collection = com.atproto.lexicon.schema` is served; reads `data/lex/<nsid with . → _>.car` and returns it as `application/vnd.ipld.car`. Anything else, or a missing slice, is `400 RecordNotFound` (note: not 404).

#### `com.atproto.sync.getRepo`

Params `did`, optional `since`. Only the publisher DID. `since` is rejected with `400 InvalidRequest` — answering with the full repo would look like a valid diff. Otherwise returns `data/lex/full.car`.

#### `com.atproto.sync.getRepoStatus`

Only the publisher DID. Parses `full.car`'s root commit and returns `{ did, rev, active: true }`; missing repo/commit is `400 RepoNotFound`.

#### `com.atproto.sync.getLatestCommit`

Only the publisher DID. Returns the root commit's `{ cid, rev }`; `400 RepoNotFound` when there is no repo.

#### `com.atproto.sync.getBlocks`

Params `did`, `cids[]`. Only the publisher DID. Parses `full.car` once per build (cache keyed by file size+mtime), indexes block CIDs by string, and returns a multi-block CAR containing only the requested blocks that exist (missing CIDs are omitted, no root). `400 RepoNotFound` when the repo is absent.

#### `com.atproto.repo.getRecord`

Params `repo`, `collection`, `rkey`. Only the publisher DID.

- `community.lexicon.book.edition`: load the `editions` row, wire contributor refs, build `editionRecordValue`; an edition with no identifiers has no valid record and answers `404 RecordNotFound`; computes the CID with `cidForLex` and returns `{ uri, cid, value }`. Enqueues a description backfill when `description` is missing.
- `community.lexicon.book.work` / `.contributor` / `.publisher`: load the matching row and return `workRecordValue` / `contributorRecordValue` / `publisherRecordValue`, CID computed the same way.
- `com.atproto.lexicon.schema`: read the per-rkey CAR slice, walk the MST for `collection/rkey`, take the last CID, CBOR-decode the block, return `{ uri, cid, value }`.
- Any other collection or repo: `400 RecordNotFound` / `RepoNotFound`.

#### `com.atproto.repo.describeRepo`

Params `repo` (DID or handle). Only the publisher identity resolves. Returns `{ did, didDoc, handle, handleIsCorrect, collections }` where `collections` is exactly `["com.atproto.lexicon.schema"]`. `handleIsCorrect` probes `https://<publisher-host>/.well-known/atproto-did` at most once per 5 minutes, serves the last known answer on failure, and defaults to `true` when it has never succeeded.

#### `com.atproto.lexicon.resolveLexicon`

Params `nsid`. Serves only lexicons this host publishes, via `resolvePublishedLexicon`: returns `{ uri, cid, schema }` computed from the local lexicon files/CAR. Unknown NSID is `400 LexiconNotFound`. It performs no network lookup by design.

#### `com.atproto.label.queryLabels`

Params `uriPatterns[]`, `sources[]`, `cursor` (numeric string), `limit`. Reads the `labels` table through `queryLabels`, maps rows with `labelToJson`, returns `{ labels, cursor }` where the cursor is the next numeric `seq`.

#### `community.lexicon.book.compatibility`

No params. Returns a static `{ queries: [{ nsid, type }] }` for `compatibility`, `searchEditions`, `resolveEditions` (procedure), `searchWorks`, `searchContributors`, `searchPublishers`.

#### `community.lexicon.book.searchEditions`

Params: `q`, `title`, `author`, `identifiers[]` (`<type>:<value>`), `offset` (default 0), `limit` (default 25, max 100). No cursor.

Logic:

1. Trim inputs. Reject with `400 InvalidQuery` when `q`, `title`, `author` and identifiers are all empty. Drop identifier hints that lack both halves.
2. Fold `q`, or `title + " " + author` when `q` is absent, into one text query.
3. `SearchService.searchEditions` runs three sources in parallel: Postgres (`editions.title ILIKE %text%`, plus identifier containment for each hint, plus language filter, ordered `indexed_at DESC, uri ASC`, `LIMIT limit+1`, count only on the first page), Google Books, and Goodreads HTML search.
4. Remote editions run enrichers in order Google Books → ISBNdb → Wikidata. If Google Books returns nothing and the query is an ISBN, ISBNdb is tried. Goodreads results are enriched in parallel; items whose normalized title already exists in the Google/ISBNdb set are dropped. Remote items are sliced to `limit`.
5. Merge remote over local by `uri` (remote wins title/subtitle/description/cover/place/year/language/identifiers; local wins contributors and `indexedAt`), slice to `limit`.
6. Cursor is remote's or Postgres's; `total` is the max defined total; `hasMore` is true if any source says so; `degraded` from the first source that reported it.
7. Remote items are synchronously ingested into the catalog (`syncIngestEditions`) before returning.
8. Handler maps each item to `editionViewFromItem` with contributor names, drops items with no identifiers, and enqueues edition/contributor backfills. Empty contributor names increment `invalidContributorResponsesTotal`.

#### `community.lexicon.book.resolveEditions`

Procedure input: `identifiers[]` (required), `offset` (0), `limit` (25, max 100). No auth check today.

Logic: each identifier becomes `editions.identifiers @> [{type,value}]`; the predicates are OR-ed (a row qualifies if any pair matches; `url` is ignored). Rows are ordered `indexed_at ASC, uri ASC`, `LIMIT limit+1`, mapped with `editionItemFromRow`, then `editionViewFromItem`; rows with no identifiers are dropped. `hasMore` from the extra row. Enqueues edition/contributor backfills. Empty identifiers is `400 InvalidQuery`.

#### `community.lexicon.book.searchWorks`

Params `q`, `id[]`, `limit` (20, max 100), `cursor`. `SearchService.searchWorks`: Postgres `works.title ILIKE %q%` + identifier containment, ordered `indexed_at DESC, uri ASC` with keyset cursor `(indexedAt, uri)` encoded as deflated base64url JSON; Google Books works in parallel; enrich with ISBNdb work + Wikidata; ISBNdb fallback when Google Books is empty and `q` is an ISBN; merge remote over local by `uri`; cursor from remote or Postgres; `total` is always counted for works; `hasMore` from any source. Remote items are synchronously ingested (`syncIngestWorks`). Handler maps to `community.lexicon.book.work` and wires contributors.

#### `community.lexicon.book.searchContributors`

Params `q`, `id[]`, `limit` (20, max 100), `cursor`. Local only: `contributors.name ILIKE %q%`, identifier containment, `btrim(name) <> ''`, ordered `indexed_at DESC, uri ASC`, keyset cursor, `total` always. Handler filters `validContributorName` again (lexicon `minLength: 1`), maps to `community.lexicon.book.contributor`, enqueues contributor backfills.

#### `community.lexicon.book.searchPublishers`

Params `q`, `id[]`, `limit` (20, max 100), `cursor`. Local only: `publishers.name ILIKE %q%`, identifier containment, ordered `indexed_at DESC, uri ASC`, `total` always. The handler forwards the service cursor, but the service currently returns none, so only the first page is reachable by cursor. Maps `imprintOf` only when it is a canonical AT-URI.

#### `net.olamaelcu.livtet.biblio.graph.isFollowing`

Params `follower`, `followed` (DIDs). One primary-key probe of `follows(follower_did, followed_did)`; returns `{ following: boolean }`.

#### `graph.listFollowers`

Params `did` (the followed actor), `cursor` (last follower DID), `limit` (100, max 1000). Selects `follows.followed_did = did` ordered by `follower_did ASC`, keyset `follower_did > cursor`, `LIMIT limit`. `total` is counted on the first page only, in parallel. Cursor emitted when the page is full.

#### `graph.listFollowees`

Params `did`, `cursor` (last followee DID), `limit` (100, max 1000). Selects `follows.follower_did = did` ordered by `followed_did ASC`, keyset, page and first-page total in parallel.

#### `getReadingGoal`

Param `did`. Reads `com.atproto.repo.getRecord` at `net.olamaelcu.livtet.biblio.readingGoal/current` from the subject's PDS, anonymously, 10 s timeout. `RecordNotFound` → `{ goal: null }`; a malformed response also → `{ goal: null }`; any other failure → `502 UpstreamUnavailable`. Returns the raw record value as `goal`.

#### `getActorProfile`

Param `did`. Reads `com.atproto.repo.getRecord` at `net.olamaelcu.livtet.actor.profile/self` from the subject's PDS. Same error mapping as `getReadingGoal`; returns `{ profile: value | null }`. Note the collection: Livtet writes `net.olamaelcu.livtet.actor.profile`, not the vendored `...biblio.actorProfile` lexicon.

#### `searchActors`

Params `q` (3–200 chars), `hasRecords[]` (≤8 NSIDs), `offset` (0), `limit` (25, max 100). Reads the `actors` table. `q` matches exact `did`, or `handle ILIKE %q%`, or `display_name ILIKE %q%` with `%`, `_`, `\` escaped; `hasRecords` is a correlated `EXISTS` over `records(did, collection)` in the same WHERE. Order `coalesce(handle, did) ASC, did ASC`, `LIMIT limit+1`, `OFFSET`. `hasMore` from the extra row; `total` counted on the first page. `actorView` emits `did`, optional `handle`/`displayName`/`description`, and an `avatar` URL built as `https://cdn.bsky.app/img/avatar/plain/<did>/<avatarCid>`. Bounds violations are `400 InvalidQuery`.

#### `getShelf`

Param `uri` (shelf AT-URI). Parses the DID from the URI, reads `net.olamaelcu.livtet.biblio.shelf/<rkey>` from that PDS. `RecordNotFound` → `404 RecordNotFound`; other upstream failure → `502`. Builds `defs#shelfView` with `shelfViewFromValue` (required `name`; `description` and timestamps only when declared) and returns `{ shelf }`.

#### `listShelves`

Params `did`, `limit` (50), `cursor`.

- First page: `com.atproto.repo.listRecords` for the `shelf` collection on the reader's PDS; each row becomes a `shelfView`; the PDS cursor is tagged `pds:<cursor>`. If the PDS scan throws, fall back to the mirror.
- `pds:` continuation resumes the PDS scan from its cursor.
- Legacy/mirror continuation: `tap:<offset>` pages `records` for `(did, shelf)` ordered `record_created_at DESC, uri DESC` with `LIMIT limit+1 OFFSET offset`.
- On the first page only, append derived Bookhive shelf containers: distinct `buzz.bookhive.book.status` values for the DID map to the fixed shelf rkeys (`reading`, `read`, `to-read`, `dnf`); a real shelf record with the same URI wins; the derived list is sorted by URI.
- Returns `{ shelves, cursor }`.

#### `getShelvingOfBook`

Params `book` (AT-URI), `did`, `limit` (50, max 100), `cursor` (interpreted as an offset).

Logic, in order:

1. Mirror: `records` where `(did, bookShelving, value->'book'->>'uri' = book)`, ordered `uri ASC`, `OFFSET cursor LIMIT limit+1`.
2. If the page is short and there is no cursor: Constellation backlinks with `subject = book`, source `net.olamaelcu.livtet.biblio.bookShelving`, `did` filter, `limit`; each backlink is fetched from its PDS with concurrency 6. If Constellation returns a cursor and the page is full, return it as the cursor.
3. If still short and no cursor: scan the reader's PDS `bookShelving` collection page by page, keeping records whose `book.uri` equals `book`.
4. If still short and no cursor: resolve the edition's Bookhive catalog subject (`bh.` rkey or the `bookhive` identifier URL), fetch Constellation backlinks with source `buzz.bookhive.book:hiveBookUri`, read each `buzz.bookhive.book` record from its PDS, and keep those with a shelf/status.
5. Hydrate everything to `defs#bookShelfView` (book from the catalog; Bookhive rows synthesize a book view from their own title/authors when the catalog row is absent).
6. Cursor is emitted only for the mirror tier, as `offset + number of returned rows` (hydration drops unresolvable rows).

#### `getShelversOfBook`

Params `bookUri`, optional `shelvingRkey` (default: last path segment of `bookUri`), `limit` (50), `cursor`.

- Bookhive DIDs are read on every page: mirror rows matching `shelfEntryConditions({ apps: ['bookhive'], bookhiveSubject })`; there is no shelf record to resolve, so they cannot be expressed by the shelving cursor. They are unioned into the answer.
- `con:` cursor resumes Constellation backlinks for `bookUri` (source `net.olamaelcu.livtet.biblio.bookShelving`) and returns distinct DIDs from the records' authorities/rkeys, in record order.
- `tap:<offset>` pages the mirror for `(collection = bookShelving, rkey = shelvingRkey, book.uri = bookUri)` ordered `uri ASC`, `LIMIT limit+1`.
- If the mirror page is full, emit `tap:offset+limit`; otherwise take the remainder from Constellation, with `con:` cursor when Constellation has more.
- Returns `{ bookUri, dids, cursor }`.

#### `listBooksOnShelf`

Params `shelf` (AT-URI; its DID is the reader), `limit` (50), `cursor`.

- `con:` continuation: Constellation backlinks `subject = shelf`, source `net.olamaelcu.livtet.biblio.bookShelving:shelf`, `did`; fetch each record from its PDS (concurrency 6); hydrate.
- `pds:` continuation: scan the reader's PDS `bookShelving` collection, up to 40 pages per request, keeping `shelf === shelfUri`; whole pages are consumed so no match is skipped; cursor resumes the repo cursor.
- `tap:<offset>`: mirror `shelfEntryConditions({ shelfUris: [shelf], did })` ordered `record_created_at DESC, uri DESC`, `LIMIT limit+1 OFFSET offset`.
- First page only: after the mirror page, if it is short, scan the PDS; if the merged page is still empty, pull Constellation backlinks. The PDS scan is preferred because per-record backlink reads trip the PDS rate limit.
- Hydrate `bookShelves`; the cursor belongs to the tier that still has records.

#### `listShelfItems`

Params `shelf` (AT-URI), `limit` (50, clamped 1–100), `cursor`.

- `pds:` continuation scans the reader's `shelfItem` collection, up to 40 pages, keeping `isShelfItemOf(record, shelfUri)`.
- First page always scans the PDS and returns immediately, because a delete is not visible to the mirror until TAP consumes it. If the scan throws, fall back to the mirror.
- `tap:<offset>` pages `records` with `shelfItemConditions` ordered `uri ASC`, `LIMIT limit+1`.
- Hydration: shelf view from the mirror or one PDS read; books batched from the catalog; missing editions are lazily resolved (≤6 per request, 2.5 s budget, 10 min negative cache), rows still missing are dropped.

#### `listShelfItemsByBook`

Params `book` (AT-URI), `did`, `limit` (50, clamped 1–100), `cursor`. Same PDS-first policy as `listShelfItems`, but the collection filter is `book.uri = book` and the mirror predicate is `shelfItemBookConditions`. Hydration batches shelf views, reads missing shelf records from the PDS (concurrency 6), resolves the book once, and drops rows whose shelf or book cannot be built.

#### `getReviewsByBook`

Params `book` (AT-URI), `limit` (25, max 100), `cursor` (offset).

- Resolve the edition's Bookhive catalog subject.
- Mirror query: `(collection = bookReview AND book in {string, book.uri, book.ref})` OR `(collection = buzz.bookhive.book AND hiveBookUri = subject AND coalesce(review,'') <> '')`, ordered `record_created_at DESC, uri DESC`, `LIMIT limit+1 OFFSET cursor`.
- Map native rows with `reviewViewFromRow` (folds all three book ref shapes; `text` defaults to `''`; `createdAt` defaults to now) and Bookhive rows with `reviewViewFromBookhiveRow` (text/rating from the inline `review`, `createdAt` from the record or the review).
- First page only, when the page is short and a Bookhive subject exists: Constellation backlinks for the subject (source `buzz.bookhive.book:hiveBookUri`), fetch each record from its PDS (concurrency 6), keep those with a review, append unseen ones.
- Returns `{ reviews, cursor }`.

#### `listReviewsByActor`

Params `did`, `limit` (25), `cursor`.

- Mirror rows for `did` in `[bookReview, buzz.bookhive.book]` where the row is either a native review or a Bookhive record with non-empty `review` or a `stars` field; ordered `record_created_at DESC, uri DESC`, `LIMIT limit+1 OFFSET offset`.
- Map to `reviewView`; rows with no book URI are dropped.
- First page only, when short: read `com.atproto.repo.listRecords` for each collection from the actor's PDS, apply the same Bookhive predicate, skip URIs already rendered, and `fillEmptyMirrorRow` for rows TAP stored as `{}`.

#### `getEditionsByContributor`

Param `contributor` (must be a `community.lexicon.book.contributor` AT-URI), `limit` (default 20).

Rejects any non-contributor AT-URI with `400 InvalidContributor`. Selects `editions.uri` where `editions.contributors @> [{ subject: { uri: contributor } }]` (GIN index), ordered `created_at DESC, uri ASC` (the record's own stamp, not `indexed_at`), `LIMIT limit`. Returns `{ uris }` and enqueues edition/contributor backfills.

#### `getBooks`

Params `uris[]` (1–100). Dedupe input, hydrate with `hydrateBooksByUri` (each URI resolves through `edition-lookup`, so a retired URI collapses onto its surviving book; contributor names are inlined; empty-name refs are dropped), and return one `bookView` per canonical `view.uri` (two input URIs naming one book produce one row). Unknown URIs are silently omitted. 502 on failure.

#### `listShelvesWithBooks`

Params `did` (optional), `limit` (50), `cursor` (must be `tap:<shelf-uri>`; any other tier or a non-AT-URI value is `400 InvalidRequest`).

- Select `shelf` records ordered `uri ASC`, keyset `uri > cursor`, `LIMIT limit+1`; scope to `did` when given.
- First page only: derive Bookhive shelf containers from the DID's `buzz.bookhive.book` statuses; append only URIs not already present.
- For each shelf, inside one transaction with `statement_timeout = 4s` and a 5s JS deadline: select shelf entries (`shelfEntryConditions`) ordered `uri ASC`, `LIMIT booksPerShelf` (25, clamped 1–100). The deadline can truncate the preview.
- Hydrate books in one batch; resolve each entry (`resolveBookShelf`), drop unresolvable rows, sort with `compareShelfBooks`: `metadata.position` ascending first (a row with no position sorts after every positioned row), then `uri` ascending.
- Output `shelves: defs#shelfWithBooksView[]`; cursor is `tap:<last shelf uri>` when there is another shelf.

#### `listRecentShelving`

Params `limit` (50), `cursor` (base64url `{t,u}` keyset).

Selects `shelfEntryConditions()` (both `bookShelving` and Bookhive `book` with a status) where `(recordCreatedAt, uri) < (cursor.t, cursor.u)`, ordered `record_created_at DESC, uri DESC`, `LIMIT limit+1`. Hydrates `bookShelfView`s. The cursor is taken from the last **scanned** row, not the last emitted view, because hydration drops unresolvable books.

#### `getBookOnShelf`

Param `uri` (AT-URI of the shelving record). Parse the DID; if the URI names `buzz.bookhive.book`, fetch that record from the PDS, otherwise fetch `bookShelving`. Missing → `404 RecordNotFound`. A Bookhive copy with no reading status is owned, not shelved → `404` with that message. Hydrate to a `bookShelfView`; if the book cannot be resolved the error names the catalog URI derived from the rkey.

#### `getImageForBook`

Param `uri`. Resolve the URI through `resolveEditions` (aliases). If no row exists, validate the rkey shape: `gb.` must be a valid Google Books rkey; `bh.` is accepted as a Bookhive mirror and returns `404 RecordNotFound` if the row is absent; anything else is `400 InvalidRequest`.

- If `cover_image_url` exists: turn it into a datacenter URL; proxy it through `/image/cover` when the source URL is allowed, otherwise return it directly.
- Else if the rkey is `bh.`: find a mirrored `buzz.bookhive.book` with a cover, first by `hiveBookUri` then by `hiveId` (three candidates each), and return `/image/bookhive/<did>/<cid>`.
- Else enqueue edition backfills (no-op in steady state) and return `{ url: undefined }`.

#### `getImageForContributor`

Param `uri` must be a `community.lexicon.book.contributor` AT-URI; anything else is `400 InvalidContributor`. Select the contributor row; missing → `404 RecordNotFound`. Return `{ url }` when `image_url` exists, otherwise enqueue the image/bio resolvers (deduped by job key; already-checked rows are not re-enqueued) and return `{}`.

#### `com.atproto.feed.describeFeedGenerator`

Returns the publisher DID and five feeds: `public` ("Bibliograph Static Feed", no auth), `dynamic` ("Bibliograph Dynamic Feed", auth), `following` ("Reviews and shelving by people you follow", auth), `extended` ("Reviews and shelving by people followed by the people you follow (2 hops)", auth), `recommendations` ("Editions readers who share your ratings also finished, layered over genre matches from your own shelf", auth).

#### `com.atproto.feed.getFeedSkeleton`

Params `feed` (AT-URI), `cursor` (numeric offset), `limit` (5, max 100). Feed type = the path segment after `net.olamaelcu.livtet.biblio.feed.generator/`.

- `public` / `static`: newest records across `bookReview`, `bookShelving`, `buzz.bookhive.book`, ordered `record_created_at DESC, uri DESC`, offset page. When a viewer is known, exclude their own records and authors blocked via `blockedAmong`.
- `following`: viewer from service JWT or session cookie. Hop 1 = DIDs the viewer follows, read from the viewer's PDS `follow` collection (20 × 100 pages max, 60 s memo, 512 entries). Filter blocked authors. Page records by those DIDs. If the viewer follows nobody on offset 0, return the global feed; an exhausted page stays empty.
- `extended`: hop 1 as above (excluding the viewer), then hop 2 = union of hop-1 follow sets, read in batches of 8, capped at 500, excluding the viewer and hop-1. Same paging and fallback rules.
- `dynamic`: requires `requireFeedAuth`; per-DID rate limit; same hop-1 follow graph and paging; fallback to global only when the viewer follows nobody at offset 0.
- First page only: after the mirror page, if it is short, scan the PDS; if the merged page is still empty, pull Constellation backlinks. The PDS scan is preferred because per-record backlink reads trip the PDS rate limit.
- `recommendations`: requires `requireFeedAuth`; per-DID rate limit. Reads the viewer's library from their PDS (`bookShelving`, `shelfItem`, `bookReview`; 10 × 100 pages, 60 s cache). Candidate sets: (a) editions of works sharing the `subjects` of currently-reading books, then of finished books; (b) linklonk vote signals; (c) books mutuals shelved/reviewed (`ORDER BY count(DISTINCT mutual) DESC, has_cover DESC`). Merge order is active → past → linklonk → mutual, de-duplicated by `tid`; an edition with a cover may replace a coverless edition of the same book in place. Excludes every book the viewer has a record for. Returns at most 30 (`RECOMMENDATION_LIMIT`), `post` = edition URI, `reason = "recommendation"`, single page (no cursor).
- `edition/<rkey>`: Constellation backlinks with `subject = at://<publisher>/net.olamaelcu.livtet.biblio.edition/<rkey>` and source `net.olamaelcu.livtet.biblio.bookReview:book.uri`, then Bookhive backlinks resolved through the edition's Bookhive subject (source `buzz.bookhive.book:hiveBookUri`), each with `reason` "Backlink from edition review" / "Bookhive review backlink"; fallback to the global DB page when both are empty.
- Unknown feed type: `{ feed: [], cursor: undefined }`.
- `reason` strings: review → the reviewed book URI; shelving → `shelving:<shelf-rkey>|<book-uri>`; Bookhive → `bookhive:<shelf-rkey>|<book-uri>`.

### 1.5 Error, caching and identity section

Restate the conventions as a table: status → error values → origin. Include the deliberate absences (`describeServer`, `net...getActor`), the two identity proofs, and the exact cache headers.

### 1.6 Target disposition section

Write two tables: current endpoint → disposition, and the target surface to build.

**Disposition.**

- **Kept at the edge, protocol:** `com.atproto.identity.*`, `com.atproto.repo.*`, `com.atproto.sync.*`, `com.atproto.lexicon.resolveLexicon`, `com.atproto.label.queryLabels`, `com.atproto.feed.describeFeedGenerator`, `com.atproto.feed.getFeedSkeleton` (four feeds; no `recommendations`).
- **Kept at the edge, catalog:** `net.olamaelcu.livtet.biblio.getImageForBook` (edition `coverUrl` only).
- **Kept at HappyView:** `graph.isFollowing` / `listFollowers` / `listFollowees`, `getReadingGoal`, `getActorProfile`, `getShelf`, `listShelves`, `getShelvingOfBook`, `getShelversOfBook`, `listBooksOnShelf`, `listShelfItems`, `listShelfItemsByBook`, `getReviewsByBook`, `listReviewsByActor`, `listShelvesWithBooks`, `listRecentShelving`, `getBookOnShelf`.
- **Replaced by the books-wg namespace:** `community.lexicon.book.searchEditions` → `community.lexicon.media.book.searchEditions` (procedure); `community.lexicon.book.resolveEditions` → `community.lexicon.media.book.resolveEditions` (procedure); both are catalog lookups over `editions`, `edition_identifiers` and `edition_contributors`.
- **Dropped entirely:** `community.lexicon.book.*` (all), `searchWorks`, `searchContributors`, `searchPublishers`, `getEditionsByContributor`, `getImageForContributor`, `searchActors`, `getBooks`, `setEditionWorkLink`, `community.lexicon.media.book.compatibility` (no WG definition), the `recommendations` feed, works, contributor records, publisher records, Bookhive, voting and edition→work linking.
- **Added:** `net.olamaelcu.livtet.biblio.getEditions` (query; batch by AT-URI, max 100, returns `{ editions }`), plus the two media procedures above. The new records `community.lexicon.media.book.edition` and `community.lexicon.media.book.review` are indexed by HappyView.
- **Procedures:** exactly `community.lexicon.media.book.searchEditions` and `community.lexicon.media.book.resolveEditions`, both read-only catalog lookups served at the edge. There are **no AppView write procedures** and therefore no end-user OAuth in this deployment; clients write their own records to their own PDS.
- **Deleted behavior:** every `tap:`/`con:`/`pds:` tier, every per-request PDS read, every Constellation call, `web_sessions` viewer resolution, `follows`/`records` projections, and every Bookhive branch. HappyView's index is the only activity source; a record missing from the index is reported missing and repaired by backfill/reconcile, not by an inline fallback.
- **Wire changes are expected:** the `community.lexicon.book.*` namespace is not served, works/contributors/publishers are gone, and `searchEditions`/`resolveEditions` move from GET/procedure to POST procedures. `docs/xrpc.md` documents the old surface only as history; the target table is the contract.

### 1.7 Target surface table

Write this table into `docs/xrpc.md` as the contract to build.

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

Procedures: exactly `searchEditions` and `resolveEditions`, both read-only. No `setEditionWorkLink`, no vote/link procedure, no write procedure of any kind.

## Step 2 — Fresh database schema

Add `packages/bibliograph-service/drizzle/0036_appview.sql` (0035 is the latest today) as the baseline for a new database. The earlier migrations still create the legacy tables on an empty database; this migration removes them before any row ever exists. No data is copied, imported, or backfilled from this repository or its current database.

```sql
DROP TABLE IF EXISTS records CASCADE;
DROP TABLE IF EXISTS follows CASCADE;
DROP TABLE IF EXISTS works CASCADE;
DROP TABLE IF EXISTS contributors CASCADE;
DROP TABLE IF EXISTS publishers CASCADE;
DROP TABLE IF EXISTS edition_aliases CASCADE;
DROP TABLE IF EXISTS edition_work_votes CASCADE;
DROP TABLE IF EXISTS actors CASCADE;
DROP TABLE IF EXISTS tap_dead_letter CASCADE;
DROP TABLE IF EXISTS ingest_dead_letter CASCADE;
DROP TABLE IF EXISTS oauth_sessions CASCADE;
DROP TABLE IF EXISTS oauth_states CASCADE;
DROP TABLE IF EXISTS web_sessions CASCADE;

CREATE TABLE pds_outbox (
  uri         text PRIMARY KEY,
  collection  text NOT NULL,
  rkey        text NOT NULL,
  op          text NOT NULL CHECK (op IN ('create','update','delete')),
  value       jsonb,
  attempts    integer NOT NULL DEFAULT 0,
  claimed_at  timestamptz,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pds_outbox_ready_idx ON pds_outbox (next_at) WHERE attempts < 10;

CREATE TABLE pds_cids (
  uri text PRIMARY KEY,
  cid text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Activity → catalog handoff. A record script inserts here; the TS worker drains it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE editions (
  uri                   text PRIMARY KEY,
  rkey                  text NOT NULL UNIQUE DEFAULT editions_next_tid(),
  title                 text NOT NULL,
  subtitle              text,
  language              text,
  published_date        text,
  format                text,
  pages                 integer,
  duration_seconds      integer,
  chapters              integer,
  series                jsonb,
  book_edition          text,
  description            text,
  cover_url             text,
  created_at            timestamptz NOT NULL,
  indexed_at            timestamptz NOT NULL DEFAULT now(),
  description_checked_at timestamptz,
  cover_checked_at      timestamptz
);
CREATE INDEX editions_created_at_idx ON editions (created_at DESC, uri);
CREATE INDEX editions_title_trgm_idx ON editions USING gin (title gin_trgm_ops);

CREATE TABLE edition_identifiers (
  edition_uri text NOT NULL REFERENCES editions(uri) ON DELETE CASCADE,
  issuer      text NOT NULL,
  value       text NOT NULL,
  url         text,
  PRIMARY KEY (edition_uri, issuer, value)
);
CREATE INDEX edition_identifiers_lookup_idx ON edition_identifiers (issuer, value);

CREATE TABLE contributors (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contributors_identity_idx ON contributors (lower(name), identifiers);
CREATE INDEX contributors_name_trgm_idx ON contributors USING gin (name gin_trgm_ops);
CREATE INDEX contributors_identifiers_idx ON contributors USING gin (identifiers);

CREATE TABLE publishers (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX publishers_identity_idx ON publishers (lower(name), identifiers);
CREATE INDEX publishers_name_trgm_idx ON publishers USING gin (name gin_trgm_ops);

CREATE TABLE edition_contributors (
  edition_uri    text NOT NULL REFERENCES editions(uri) ON DELETE CASCADE,
  contributor_id bigint NOT NULL REFERENCES contributors(id) ON DELETE RESTRICT,
  position       integer NOT NULL,
  role           text NOT NULL DEFAULT 'author',
  ref            text,
  PRIMARY KEY (edition_uri, position)
);
CREATE INDEX edition_contributors_contributor_idx ON edition_contributors (contributor_id);

CREATE TABLE edition_publishers (
  edition_uri  text NOT NULL REFERENCES editions(uri) ON DELETE CASCADE,
  publisher_id bigint NOT NULL REFERENCES publishers(id) ON DELETE RESTRICT,
  position     integer NOT NULL,
  PRIMARY KEY (edition_uri, position)
);
CREATE INDEX edition_publishers_publisher_idx ON edition_publishers (publisher_id);

-- Lua hydration reads this; it is the only catalog object exposed to HappyView.
CREATE OR REPLACE VIEW appview_book AS
SELECT
  e.uri,
  e.rkey,
  e.title,
  e.subtitle,
  e.language,
  e.published_date,
  e.format,
  e.pages,
  e.duration_seconds,
  e.chapters,
  e.series,
  e.book_edition,
  e.description,
  e.cover_url,
  e.created_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'position', ec.position, 'name', c.name, 'role', ec.role,
      'identifiers', c.identifiers, 'ref', ec.ref
    ) ORDER BY ec.position)
    FROM edition_contributors ec
    JOIN contributors c ON c.id = ec.contributor_id
    WHERE ec.edition_uri = e.uri
  ), '[]'::jsonb) AS contributors,
  (
    SELECT jsonb_build_object('name', p.name, 'identifiers', p.identifiers)
    FROM edition_publishers ep
    JOIN publishers p ON p.id = ep.publisher_id
    WHERE ep.edition_uri = e.uri
    ORDER BY ep.position
    LIMIT 1
  ) AS publisher,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', p.name, 'identifiers', p.identifiers)
                     ORDER BY ep.position)
    FROM edition_publishers ep
    JOIN publishers p ON p.id = ep.publisher_id
    WHERE ep.edition_uri = e.uri
  ), '[]'::jsonb) AS publishers,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('issuer', i.issuer, 'value', i.value, 'url', i.url)
                     ORDER BY i.issuer, i.value)
    FROM edition_identifiers i WHERE i.edition_uri = e.uri
  ), '[]'::jsonb) AS identifiers
FROM editions e;
```

Trigger. Only editions are published as records; works, contributors and publishers no longer exist as records.

```sql
CREATE OR REPLACE FUNCTION pds_enqueue_edition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO pds_outbox (uri, collection, rkey, op)
    VALUES (OLD.uri, 'community.lexicon.media.book.edition', OLD.rkey, 'delete')
    ON CONFLICT (uri) DO UPDATE SET op='delete', value=NULL, updated_at=now();
    RETURN OLD;
  END IF;
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  VALUES (NEW.uri, 'community.lexicon.media.book.edition', NEW.rkey, CASE WHEN TG_OP='INSERT' THEN 'create' ELSE 'update' END)
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op='create' THEN 'create' ELSE EXCLUDED.op END,
    value = NULL, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pds_enqueue_editions AFTER INSERT OR UPDATE OR DELETE ON editions
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition();
```

Identifiers and contributors live in child tables, so changing either must republish the parent edition:

```sql
CREATE OR REPLACE FUNCTION pds_enqueue_edition_child() RETURNS trigger AS $$
DECLARE target text;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.edition_uri ELSE NEW.edition_uri END;
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM editions e WHERE e.uri = target
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL, updated_at = now();
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pds_enqueue_identifiers AFTER INSERT OR UPDATE OR DELETE ON edition_identifiers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();
CREATE TRIGGER pds_enqueue_contributors AFTER INSERT OR UPDATE OR DELETE ON edition_contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();
CREATE TRIGGER pds_enqueue_publishers AFTER INSERT OR UPDATE OR DELETE ON edition_publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();
```

Entity edits also republish every edition that credits them:

```sql
CREATE OR REPLACE FUNCTION pds_enqueue_contributor_editions() RETURNS trigger AS $$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_contributors ec JOIN editions e ON e.uri = ec.edition_uri
   WHERE ec.contributor_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pds_enqueue_publisher_editions() RETURNS trigger AS $$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_publishers ep JOIN editions e ON e.uri = ep.edition_uri
   WHERE ep.publisher_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pds_enqueue_contributor_edits AFTER UPDATE OF name, identifiers ON contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_contributor_editions();
CREATE TRIGGER pds_enqueue_publisher_edits AFTER UPDATE OF name, identifiers ON publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_publisher_editions();
```

`appview_book` exposes the edition's identifiers and inline contributors; Lua never needs a work, contributor or publisher record.

Indexes for Lua reads on `happyview_records` (create only after HappyView has migrated; put them in `happyview/sql/indexes.sql`, applied by `hv:deploy`):

```sql
CREATE INDEX IF NOT EXISTS happyview_record_shelf_idx
  ON happyview_records ((record->>'shelf'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookShelving';
CREATE INDEX IF NOT EXISTS happyview_record_book_uri_idx
  ON happyview_records ((record->'book'->>'uri'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookShelving';
CREATE INDEX IF NOT EXISTS happyview_record_shelfitem_shelf_idx
  ON happyview_records ((record->>'shelf'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.shelfItem';
CREATE INDEX IF NOT EXISTS happyview_record_shelfitem_book_idx
  ON happyview_records ((record->'book'->>'uri'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.shelfItem';
CREATE INDEX IF NOT EXISTS happyview_record_review_subject_record_idx
  ON happyview_records ((record->>'subjectRecord'))
  WHERE collection = 'community.lexicon.media.book.review';
CREATE INDEX IF NOT EXISTS happyview_record_review_identifiers_idx
  ON happyview_records USING gin ((record->'subject'->'identifiers'))
  WHERE collection = 'community.lexicon.media.book.review';
CREATE INDEX IF NOT EXISTS happyview_record_follow_subject_idx
  ON happyview_records ((record->>'subject'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.follow';
```

Update `src/lib/server/db/schema.ts`: delete `records`, `follows`, `tapDeadLetter`, `ingestDeadLetter`, `oauthSessions`, `oauthStates`, `webSessions`, `works`, `contributors`, `publishers`, `editionAliases`, `editionWorkVotes`, `actors`; add `pdsOutbox`, `pdsCids`, `editionIdentifiers`, `editionContributors`. Keep `editions` (new columns), `labels`, `librarianApplications`, the backfill bookkeeping and provider caches (`googleBooksCache`, `isbndbCache`).

## Step 3 — HappyView service and activity plane

### 3.1 HappyView Debian package and service

HappyView is deployed like the rest of the estate: a `.deb` installed by Ansible, not a container. The package lives in the infra repo at `packaging/happyview/` and is built from the published `ghcr.io/gamesgamesgamesgamesgames/happyview:v2.17.4` image (the image is the release artifact; no local Rust build needed).

`packaging/happyview/build-deb.sh`:

1. Pulls the image manifest/layers and extracts `/usr/local/bin/happyview`, `/srv/static/**` and `/app/migrations/**` with a variant of `packaging/tap/pull-image-binary.py` (that helper only extracts one file; HappyView needs the static tree and migrations too).
2. Replaces the `__HAPPYVIEW_BP__` sentinel in the static files with `/~/hv` at build time, so the package needs no writable runtime copy.
3. Stages `/usr/bin/happyview`, `/usr/share/happyview/static`, `/usr/lib/happyview/migrations`, `/lib/systemd/system/happyview.service`, `/etc/happyview/happyview.env` (conffile), `/usr/lib/sysusers.d/happyview.conf`, `postinst`/`postrm`.
4. Builds `happyview_2.17.4_amd64.deb` and publishes it with `apt-repo-publish` (add `mise run happyview-publish`).

`happyview.service`:

```ini
[Unit]
Description=HappyView AppView
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=happyview
Group=happyview
WorkingDirectory=/usr/lib/happyview
EnvironmentFile=/etc/happyview/happyview.env
EnvironmentFile=-/etc/happyview/happyview.local
ExecStart=/usr/bin/happyview
Restart=always
RestartSec=10s
LimitNOFILE=65536
StateDirectory=happyview
MemoryHigh=512M
MemoryMax=768M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/happyview

[Install]
WantedBy=multi-user.target
```

`/etc/happyview/happyview.env` (package defaults; secrets in `happyview.local` from Ansible/SOPS):

```sh
DATABASE_URL=postgres://bibliograph:CHANGEME@127.0.0.1:5432/bibliograph
PUBLIC_URL=https://biblio.livtet.olamaelcu.net
BASE_PATH=/~/hv
STATIC_DIR=/usr/share/happyview/static
HOST=127.0.0.1
PORT=3000
JOB_WORKER_CONCURRENCY=1
DEFAULT_RATE_LIMIT_CAPACITY=10000
DEFAULT_RATE_LIMIT_REFILL_RATE=1000
```

The production unit binds loopback only; nginx terminates TLS and proxies `/~/hv/`. `HAPPYVIEW_PUBLIC_URL` is `http://127.0.0.1:5176` in dev (Vite proxies `/~/hv`) and `https://biblio.livtet.olamaelcu.net` in production. The edge calls `HAPPYVIEW_URL=http://127.0.0.1:3000` and always appends `/~/hv`.

For development, `mise run hv-dev` extracts the same binary/static tree into `.cache/happyview` (or uses an already-installed `/usr/bin/happyview`), runs it with `DATABASE_URL` pointing at the local Postgres and `BASE_PATH=/~/hv`, and Vite proxies `/~/hv`:

```ts
server: { proxy: { '/~/hv': { target: 'http://127.0.0.1:3000', changeOrigin: false } } },
```

### 3.2 Lexicons to upload

`POST /admin/lexicons` with `{ lexicon_json, backfill, target_collection }`.

Record lexicons, `backfill: true`:

- `net.olamaelcu.livtet.biblio.bookShelving`
- `net.olamaelcu.livtet.biblio.shelf`
- `net.olamaelcu.livtet.biblio.shelfItem`
- `net.olamaelcu.livtet.biblio.follow`
- `net.olamaelcu.livtet.biblio.readingGoal`
- `net.olamaelcu.livtet.actor.profile` — create `happyview/lexicons/net/olamaelcu/livtet/actor/profile.json` by copying `lexicons/net/olamaelcu/livtet/biblio/actorProfile.json` and changing `id` to `net.olamaelcu.livtet.actor.profile`; this is the collection Livtet actually writes at rkey `self`.
- `community.lexicon.media.book.review` — copy `lexicons/community/lexicon/media/book/review.json` into `happyview/lexicons/` and upload with `backfill: true`.

Do **not** index `community.lexicon.media.book.edition`: the AppView publishes it and reads it from `appview_book` (the catalog table), avoiding the did:web/Jetstream source problem.

Query lexicons, `backfill: false`, `target_collection` = the collection each reads:

- `net.olamaelcu.livtet.biblio.graph.isFollowing` / `listFollowers` / `listFollowees` → `net.olamaelcu.livtet.biblio.follow`
- `getReadingGoal` → `net.olamaelcu.livtet.biblio.readingGoal`
- `getActorProfile` → `net.olamaelcu.livtet.actor.profile`
- `getShelf` / `listShelves` / `listShelvesWithBooks` → `net.olamaelcu.livtet.biblio.shelf`
- `getShelvingOfBook` / `getShelversOfBook` / `listBooksOnShelf` / `listRecentShelving` / `getBookOnShelf` → `net.olamaelcu.livtet.biblio.bookShelving`
- `listShelfItems` / `listShelfItemsByBook` → `net.olamaelcu.livtet.biblio.shelfItem`
- `getReviewsByBook` / `listReviewsByActor` → `community.lexicon.media.book.review`

There are no procedure lexicons. The only procedures are the media `searchEditions`/`resolveEditions`, served at the edge.

Rewrite `lexicons/net/olamaelcu/livtet/biblio/defs.json` at the same time:

- `bookView` = `{ uri: at-uri, edition: ref community.lexicon.media.book.defs#editionView }`; do not duplicate the edition fields.
- `bookShelfView.book` and `shelfItemView.book` ref `defs#bookView`.
- `reviewView` = `{ uri: at-uri, did: did, record: ref community.lexicon.media.book.review }`.
- Delete `contributorView`, `bookContributorView` and the old `bookView` fields; contributors are inline in the editionView.

### 3.3 Script layout and deploy

```
packages/bibliograph-service/happyview/
  lexicons/net/olamaelcu/livtet/actor/profile.json
  lexicons/community/lexicon/media/book/review.json
  sql/indexes.sql
  lib/prelude.lua          -- cursor, fail(), view builders, SQL helpers
  scripts/xrpc/query/<nsid>.lua
  deploy.ts
```

`deploy.ts` (`pnpm --filter bibliograph-service hv:deploy`):

1. Requires `HAPPYVIEW_ADMIN_KEY`; warns and exits 0 when unset.
2. Uploads local lexicons (`POST /admin/lexicons`); no network lexicons are needed.
3. Expands `-- @include lib/...lua` recursively (v2 has no `require`) and uploads each script (`POST /admin/scripts`, `{id, script_type:"lua", body, description}`). Fail non-2xx.
4. Uploads script variables (`POST /admin/script-variables`): `PUBLISHER_DID`.
5. Applies `happyview/sql/indexes.sql` through the edge's `DATABASE_URL` (idempotent).
6. Prints lexicon/script counts.

### 3.4 Lua prelude (`lib/prelude.lua`)

v2 contract: `handle()`, globals `params`/`input`/`caller_did`/`env`, `db.raw(sql, args)`, `Record`, `http`, `json`, `jobs`. Helpers:

- `fail(status, error, message)` → `{ __bib_http = { status = status, body = { error = error, message = message } } }`.
- `int(value, default, min, max)` — v2 params arrive as strings.
- `encode_cursor(table)` / `decode_cursor(string)` — base64url of `json.encode`; `decode` returns `{}` on failure.
- `shelf_view(uri, record)` — fixed rkey names (`reading`=Currently Reading, `read`=Read, `to-read`=To Read, `dnf`=Did Not Finish); custom shelves use the record's `name`; emits `{ uri, name, description?, $type = "net.olamaelcu.livtet.biblio.defs#shelfView" }`.
- `edition_view(uri)` — `SELECT * FROM appview_book WHERE uri = $1`; returns the `community.lexicon.media.book.defs#editionView` object `{ title, identifiers, contributors, coverUrl?, createdAt, subtitle?, language?, publishedDate?, publisher?, format?, pages?, durationSeconds?, chapters?, series?, bookEdition?, description? }`, or `nil`. Pass `identifiers`/`contributors` through verbatim.
- `book_view(uri)` — `{ uri, edition = edition_view(uri) }`; `nil` when the edition is absent. This is `net.olamaelcu.livtet.biblio.defs#bookView`.
- `book_shelf_view(row, book, shelf)` — emits `defs#bookShelfView` with `metadata` from the record and `book = book_view(row's edition uri)`; drop the row when the book is absent.
- `review_view(row)` — returns `{ uri, did, record }` where `record` is the stored `community.lexicon.media.book.review` value verbatim. No field rewriting; the review is a WG record.

Return arrays with `toarray` where the list is built by hand; `db.raw` results are already arrays. No Bookhive helper exists; `buzz.bookhive.*` is not indexed.

### 3.5 Query scripts

Each returns the exact lexicon output. No PDS/Constellation tiers. Cursors are opaque; use `{t,u}` keyset for recency lists and `{u}`/`{o}` for URI/offset lists.

| Script | Logic |
| --- | --- |
| `graph.isFollowing.lua` | `SELECT 1 FROM happyview_records WHERE collection='net.olamaelcu.livtet.biblio.follow' AND did=$1 AND split_part(regexp_replace(record->>'subject', '^at://', ''), '/', 1)=$2 LIMIT 1`; `{ following = row ~= nil }`. |
| `graph.listFollowers.lua` | `follow` records whose subject DID = `params.did`, ordered by subject DID ascending, keyset `> cursor`; `LIMIT limit+1`; `total` (`count(*)`) on the first page; output `{ did, followedAt = record.createdAt }`. |
| `graph.listFollowees.lua` | `follow` records with `did = params.did`, ordered by subject DID, keyset; same output keys `followees`. |
| `getReadingGoal.lua` | `SELECT record FROM happyview_records WHERE uri = 'at://' || $1 || '/net.olamaelcu.livtet.biblio.readingGoal/current'`; `{ goal = record or nil }`. |
| `getActorProfile.lua` | Same at `net.olamaelcu.livtet.actor.profile/self`; `{ profile = record or nil }`. |
| `getShelf.lua` | `SELECT * FROM happyview_records WHERE uri=$1 AND collection='net.olamaelcu.livtet.biblio.shelf'`; 404 if absent; `{ shelf = shelf_view(...) }`. |
| `listShelves.lua` | `shelf` records for `params.did`, ordered `uri ASC`, keyset `{u}`, `LIMIT limit+1`; no derived containers. |
| `getShelvingOfBook.lua` | `bookShelving` for `(did, book.uri = book)`, order `uri ASC`, offset cursor; hydrate `book_shelf_view`; drop rows whose edition is absent from `appview_book`. |
| `getShelversOfBook.lua` | Distinct `did` from `bookShelving` where `rkey = shelvingRkey` and `book.uri = bookUri`; `SELECT did, min(uri) AS first_uri ... GROUP BY did ORDER BY first_uri`, keyset `{u}`; `{ bookUri, dids, cursor }`. |
| `listBooksOnShelf.lua` | `bookShelving` with `record->>'shelf' = shelfUri` and `did`, order `created_at DESC, uri DESC`, keyset; hydrate `book_shelf_view`; cursor `{t,u}`. |
| `listShelfItems.lua` | `shelfItem` records `record->>'shelf' = shelfUri` and `did`, ordered `uri ASC`, offset cursor; hydrate shelf (record or derived name) and book (from `appview_book`); drop items whose book is absent. |
| `listShelfItemsByBook.lua` | `shelfItem` records `record->'book'->>'uri' = book` and `did`, ordered `uri ASC`, offset cursor; same hydration; drop rows whose shelf/book cannot be built. |
| `getReviewsByBook.lua` | `community.lexicon.media.book.review` rows where `record->>'subjectRecord' = book` OR `record->'subject'->'identifiers'` contains any `(issuer,value)` pair from `edition_identifiers` for `book`; order `created_at DESC, uri DESC`, offset cursor; `{ reviews = review_view(row), cursor }`. |
| `listReviewsByActor.lua` | `community.lexicon.media.book.review` rows for `did`, order `created_at DESC, uri DESC`, offset cursor; `{ reviews = review_view(row), cursor }`. |
| `getEditionsByContributor.lua` | **Drop.** Do not create; `searchEditions` with `author` covers it. |
| `getBooks.lua` | **Drop.** Do not create; `net.olamaelcu.livtet.biblio.getEditions` is the edge batch replacement. |
| `listShelvesWithBooks.lua` | `shelf` records (optional `did`), ordered `uri ASC`, keyset; for each shelf run one `bookShelving` query ordered `uri ASC LIMIT booksPerShelf` (clamped 1–100), hydrate, sort by `metadata.position` ascending (missing last), then `uri` ascending; `{ shelves, cursor }`. |
| `listRecentShelving.lua` | `bookShelving` rows, ordered `created_at DESC, uri DESC`, keyset on the last scanned row; hydrate; `{ bookShelves, cursor }`. |
| `getBookOnShelf.lua` | `SELECT * FROM happyview_records WHERE uri=$1 AND collection='net.olamaelcu.livtet.biblio.bookShelving'`; hydrate; 404 when the edition is absent from `appview_book`. |
| `searchActors.lua` | **Drop.** Do not create. |

For every script that needs a book, query `appview_book`; do not query `editions`/`edition_*` directly. There are no Bookhive status mappings: shelf records are the only shelving source.

### 3.6 Procedures

None. The only two XRPC procedures in the final surface are `community.lexicon.media.book.searchEditions` and `resolveEditions`; both are read-only catalog lookups served at the edge (Step 4), so HappyView has no procedure lexicons and no user-write path.

### 3.7 Record scripts

None. HappyView indexes the activity collections and the WG review record as-is; it does not create catalog editions. A shelving row whose edition is absent is omitted from the hydrated view until an import or admin ingest creates the edition.

### 3.8 Startup, environment and tooling

`mise.toml` tasks:

| Task | Command |
| --- | --- |
| `db-migrate` | `pnpm --filter bibliograph-service db:migrate` |
| `hv-deploy` | `pnpm --filter bibliograph-service hv:deploy` |
| `hv-dev` | extract/run the HappyView binary locally against `.env` (see 3.1) |
| `pds-publish-lexicons` | `pnpm --filter bibliograph-service pds:publish-lexicons` |
| `web-dev` | `pnpm run dev --host` |
| `worker-dev` | `pnpm --filter bibliograph-service run worker` (catalog jobs + outbox) |
| `dev` | depends on `db-migrate`, `hv-deploy`; run = `["mise run hv-dev ::: worker-dev ::: web-dev"]` |
| `sql` | `psql "$DATABASE_URL"` |

Remove `TAP_*`, `OAUTH_*`, `ATP_SIGNING_KEY`, `LEX_OUT_DIR`, and the `lex-build`/`publish-lex` tasks. Keep `GRAPHILE_*` and the catalog backfill tasks; the graphile worker still runs them. Add package scripts `hv:deploy` (`tsx happyview/deploy.ts`) and `pds:publish-lexicons` (`tsx scripts/pds-publish-lexicons.ts`).

`.env` additions for the app: `HAPPYVIEW_URL`, `HAPPYVIEW_PUBLIC_URL`, `HAPPYVIEW_CLIENT_KEY`, `HAPPYVIEW_CLIENT_SECRET`, `HAPPYVIEW_ADMIN_KEY`, `PDS_URL` (edge: `http://127.0.0.1:2583`), `PDS_ACCOUNT_DID`, `PDS_ACCOUNT_PASSWORD`. Keep `GOOGLE_BOOKS_API_KEY` and `ISBNDB_API_KEY` for catalog ingestion; remove `BOOKHIVE_*`. PDS service keys (`PDS_JWT_KEY`, `PDS_REPO_SIGNING_KEY`, `PDS_PLC_ROTATION_KEY`, `PDS_DPOP_SECRET`, `PDS_ADMIN_PASS`) live in the infra repo's SOPS, not the app env.

Production units: keep `bibliograph.service` (labeler WS + edge), `bibliograph-worker.service` (catalog jobs), `bibliograph-migrate.service`; add `bibliograph-hv-deploy.service` (oneshot after `happyview.service` is healthy). `happyview.service` and `rsky-pds.service` are installed by the infra repo. Remove `bibliograph-tap.service` and TAP timers. `deploy.sh` runs `db:migrate`, `hv:deploy`, restarts the edge and worker; it does not start containers.

## Step 4 — Catalog edge and publisher

### 4.1 Outbox publisher (graphile task)

Add `src/lib/server/jobs/handlers/pds-publish.ts`:

- Select up to 100 rows `WHERE next_at <= now() AND attempts < 10 AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes') ORDER BY updated_at LIMIT 100`; mark `claimed_at = now()`.
- Create a PDS session (`POST ${PDS_URL}/xrpc/com.atproto.server.createSession`, `identifier = PDS_ACCOUNT_DID`, `password = PDS_ACCOUNT_PASSWORD`); reuse the access JWT for the run; on 401 recreate once.
- Build each value with the rewritten `editionRecordValue(row)`: load `edition_identifiers`, `edition_contributors` joined to `contributors`, and `edition_publishers` joined to `publishers` for the row. Emit the `community.lexicon.media.book.edition` record verbatim (title, identifiers, inline contributors from the entity rows, primary publisher from the lowest position, coverUrl, createdAt, subtitle/language/publishedDate/format/pages/durationSeconds/chapters/series/bookEdition/description). An edition with no identifier rows is not lexicon-valid: log and skip it (leave the outbox row failed/retried, or delete it with an error).
- `applyWrites` body `{"repo":PUBLISHER_DID,"validate":false,"writes":[{"$type":"com.atproto.repo.applyWrites#create","collection","rkey","value"}]}`; use `#update` when `pds_cids` has the rkey; retry `AlreadyExists` as update and `RecordNotFound` as create.
- On success delete the outbox row and upsert `pds_cids` from `results[i].cid`. A delete that returns `RecordNotFound` is success and also deletes the `pds_cids` row.
- On failure: `attempts += 1`, clear `claimed_at`, `next_at = now() + interval '1 minute' * power(2, attempts)`, `last_error`.
- Requeue itself while rows remain.

Run it every 60 s from `worker.ts`/cron; also enqueue once at boot.

### 4.2 Queue workers (none)

None. There is no activity→catalog queue: imports and admin ingestion create editions; activity rows that name an unknown edition are omitted until then.

### 4.3 Handler changes at the edge

- Replace `community/lexicon/book/searchEditions.json`, `resolveEditions.json`, `edition.json`, `review.json`, `defs.json` with the books-wg files under `lexicons/community/lexicon/media/book/`; delete every other `community/lexicon/book/*` file.
- `searchEditions` (POST procedure): matching fields are **title** and **identifiers**. Validate at least one of `q`, `title`, `author`, `identifiers`; `q` and `title` both mean `editions.title ILIKE %text%`; `identifiers` means `EXISTS (SELECT 1 FROM edition_identifiers i WHERE i.edition_uri = editions.uri AND (i.issuer, i.value) = ANY(...))` (OR across hints). `author` is accepted by the lexicon and maps to `EXISTS (SELECT 1 FROM edition_contributors ec JOIN contributors c ON c.id = ec.contributor_id WHERE ec.edition_uri = editions.uri AND c.name ILIKE %author%)`; it is not a separate provider source. Order `created_at DESC, uri ASC`; `LIMIT limit+1`; `hasMore` from the extra row; `total` on the first page only. Return `defs#editionResults` with `editionView` items built from `appview_book`. No provider calls, no ingest.
- `resolveEditions` (POST procedure): same `editionResults`, `identifiers` required, OR across pairs, `offset`/`limit`, order `created_at DESC, uri ASC`.
- Add `lexicons/net/olamaelcu/livtet/biblio/getEditions.json` (query): params `uris` = array of at-uri, 1–100 required; output `{ editions: defs#bookView[] }`. Handler loads rows from `appview_book`, returns `{ uri, edition }` items, omits unknown URIs, dedupes by URI.
- `net.olamaelcu.livtet.biblio.getImageForBook`: resolve the edition row; 404 when absent; return `{ url: cover_url }` (proxied through `/image/cover` when the URL is allowed); no Bookhive fallback, no backfill enqueue.
- Feed generator: read `community.lexicon.media.book.review` and `net.olamaelcu.livtet.biblio.bookShelving` from `happyview_records`; replace `follows`/PDS follow reads with `happyview_records` `follow` rows. Keep `public`, `following`, `extended`, `dynamic`; delete the `recommendations` generator and `recommendation.ts`.
- Delete `searchWorks`, `searchContributors`, `searchPublishers`, `getEditionsByContributor`, `getBooks`, `searchActors`, `getImageForContributor`, `edition-work-actions.ts`, `edition-work-votes.ts`, `linklonk.ts`, `recommendation.ts`, `bookhive/**`, `contributor-refs.ts`, `contributor-image/**`, `format-view.ts`, `book-wire.ts`, `edition-merge.ts`, `catalog-delete.ts`'s Bookhive branches, the works/contributor/publisher job handlers and scripts (`backfill-works.ts`, `work-description-backfill.ts`, ISBN work enrichers), and their routes/pages (`/works`, admin merge).
- Delete `tap-consumer.ts`, `follow-graph.ts`, `records`-based helpers, and the `records`/`follows` drizzle imports.
- Edition ingestion (admin import + provider jobs): look up `edition_identifiers` by the provider's unique pair; update that edition when found, otherwise mint `rkey = editions_next_tid()`, set `uri = at://PUBLISHER_DID/community.lexicon.media.book.edition/<rkey>`, insert `editions`, then insert its identifier rows. Upsert each credited contributor into `contributors` (`ON CONFLICT (lower(name), identifiers) DO UPDATE`/select) and link it in `edition_contributors` with position/role/ref; do the same for publishers and `edition_publishers`. Issuer map: Google Books volume → `googlebooks.com`; OpenLibrary → `openlibrary.org`; ISBNdb → `isbndb.com`; Goodreads → `goodreads.com`; ISBN → `isbn13` (hyphenless, ISBN-10 converted). `format` maps print bindings → `physical`, electronic → `ebook`, audio → `audio`; unknown is omitted. A shared ISBN does **not** merge two provider editions; it is a second identifier on each. No aliases and no merge operation.

### 4.4 Publication identity

Keep `lexicons/**` as the source of published lexicons. Add `scripts/pds-publish-lexicons.ts`: create a PDS session and `com.atproto.repo.putRecord` every lexicon as `com.atproto.lexicon.schema` with `rkey = <nsid>` and `validate=false`. This replaces the CAR lex-repo build; delete `scripts/build-lex-repo.ts`, `scripts/gen-lex-publisher-key.ts`, `data/lex/*.car` and the `lex-build`/`publish-lex` tasks.

Replace `lex/resolve.ts`'s CAR lookup with a build-time map of `lexicons/**/*.json` (`import.meta.glob` at build, or a generated `lexicon-map.ts`). `com.atproto.lexicon.resolveLexicon` returns `{ uri: at://PUBLISHER_DID/com.atproto.lexicon.schema/<nsid>, cid: cidForLex(schema), schema }` for NSIDs in the map; unknown NSIDs still answer `400 LexiconNotFound`. The edge no longer reads `data/lex`.

## Step 5 — Auth, gateway, UI

### 5.1 Gateway

Add `src/lib/server/xrpc-gateway.ts`, called from `hooks.server.ts` before routing:

Move the edge handlers out of the old router into `src/lib/server/xrpc-edge.ts` (one `handleEdgeXrpc(request, nsid)` with the catalog, label, feed, image and lexicon cases). The gateway calls it for the `EDGE` set; the old `xrpc-router.ts` and `routes/xrpc/**` are then deleted.

Add `src/lib/server/happyview/client.ts`:

```ts
const BASE = `${process.env.HAPPYVIEW_URL ?? 'http://127.0.0.1:3000'}/~/hv`;
export function hvUrl(path: string) { return `${BASE}${path}`; }
export function hvHeaders(extra: Record<string,string> = {}) {
  return {
    'x-client-key': process.env.HAPPYVIEW_CLIENT_KEY!,
    'x-client-secret': process.env.HAPPYVIEW_CLIENT_SECRET!,
    ...extra,
  };
}
export async function hvQuery(nsid: string, params: URLSearchParams) { /* GET */ }
export async function hvAdmin(path: string, init: RequestInit = {}) {
  return fetch(hvUrl(path), { ...init, headers: { authorization: `Bearer ${process.env.HAPPYVIEW_ADMIN_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
}
```

`hvQuery` unwraps `__bib_http` exactly as the gateway does. There is no `hvProcedure`: HappyView serves no write procedures.

```ts
const EDGE = /^(com\.atproto\.(label|feed)\.|com\.atproto\.lexicon\.resolveLexicon$|community\.lexicon\.media\.book\.|net\.olamaelcu\.livtet\.biblio\.(getEditions|getImageForBook)$)/;
const PDS  = /^com\.atproto\.(repo|sync|identity)\.|^com\.atproto\.server\.describeServer$/;
```

- `EDGE`: local handlers.
- `PDS`: forward to the publisher PDS when `repo`/`did` is `PUBLISHER_DID`; otherwise resolve the DID document and forward to its PDS. Strip hop-by-hop headers; preserve status/body/content-type.
- Otherwise: read the request body once (`await request.arrayBuffer()`) and `fetch(HAPPYVIEW_URL + '/~/hv/xrpc/' + nsid + search, { method, headers: { 'x-client-key', 'x-client-secret', authorization, 'content-type' }, body })`. Buffering avoids Node's `duplex: 'half'` stream requirement and is safe for JSON procedures. If the JSON body has `__bib_http`, return `body.body` with `body.status`.

No cookie is forwarded: the AppView has no end-user session. `authorization` is forwarded so a service auth JWT reaches the feed skeleton.

### 5.1.1 Public `/xrpc` routing (dev and production)

Invariant: **`/xrpc/<nsid>` is always served by the SvelteKit process**, in both environments. HappyView is never the public XRPC origin. The gateway owns edge dispatch, `X-Client-Key` injection, the `__bib_http` unwrap and the PDS proxy; HappyView is only an upstream reached at its internal `/~/hv/xrpc/<nsid>` path.

Development:

1. `mise run dev` starts Vite on `127.0.0.1:5176`, the HappyView container on `127.0.0.1:3000`, Postgres and the worker.
2. `hooks.server.ts` intercepts `event.url.pathname === '/xrpc/' || startsWith('/xrpc/')` before SvelteKit routing and calls `handleXrpc(event.request)`; `src/routes/xrpc/**` is deleted, so nothing shadows it.
3. Vite proxies only `/~/hv` to `http://127.0.0.1:3000`; it does **not** proxy `/xrpc`. A request to `http://127.0.0.1:5176/xrpc/...` therefore reaches the gateway.
4. The gateway fetches `http://127.0.0.1:3000/~/hv/xrpc/<nsid>` for HappyView-backed methods. `HAPPYVIEW_URL=http://127.0.0.1:3000`, `HAPPYVIEW_PUBLIC_URL=http://127.0.0.1:5176` (no base path), `BASE_PATH=/~/hv`.
5. The label WebSocket (`/xrpc/com.atproto.label.subscribeLabels`) is attached by `server.ts` in production, not by the Vite dev server; HTTP XRPC queries work in dev, and the stream is verified against the production entrypoint.

Production:

1. nginx keeps `location /` proxy-passing to the SvelteKit backend, so `/xrpc/*` reaches `hooks.server.ts`. **Do not add a `location /xrpc`** pointing at HappyView.
2. Add one location **before** `location /` for the dashboard and its internal API:

Define the upstream beside the existing `bibliograph_backend` (in `bibliograph-upstream.conf.in`):

```nginx
upstream happyview_backend { server 127.0.0.1:3000; }
```

```nginx
location /~/hv/ {
    proxy_pass         http://happyview_backend;   # 127.0.0.1:3000
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

3. Keep the existing exact WebSocket location for `/xrpc/com.atproto.label.subscribeLabels` on the SvelteKit backend (Upgrade headers), as `debian/bibliograph-platform.nginx` already does.
4. The edge process gets `HAPPYVIEW_URL=http://127.0.0.1:3000`; HappyView gets `PUBLIC_URL=https://biblio.livtet.olamaelcu.net` and `BASE_PATH=/~/hv`. HappyView's own OAuth callback is therefore `https://biblio.livtet.olamaelcu.net/~/hv/callback`.
5. `/health` and `/metrics` stay on the SvelteKit backend; HappyView's health is checked internally at `http://127.0.0.1:3000/health`.

Resulting path map:

| Public path | Backend | Handler |
| --- | --- | --- |
| `/xrpc/<nsid>` | SvelteKit | `xrpc-gateway` (edge or HappyView upstream) |
| `/xrpc/com.atproto.label.subscribeLabels` | SvelteKit `server.ts` | label WebSocket |
| `/~/hv/*` | HappyView `:3000` | dashboard, admin API, HappyView XRPC |
| everything else | SvelteKit | pages/SSR |

### 5.2 No end-user auth

There is no end-user OAuth or browser login. Delete `src/lib/server/auth/oauth.ts`, `session.ts`, `routes/login`, `routes/logout`, `routes/oauth`, `routes/oauth-client-metadata.json`, and the `@atproto/oauth-client-node` dependency. `hooks.server.ts` has no viewer lookup and no `locals.viewer`.

HappyView's OAuth remains only for logging into its own dashboard at `/~/hv/`. It does not authenticate Bibliograph's XRPC calls: those carry `X-Client-Key` (client identity/rate limit), and personalized feed calls carry a service auth JWT in `Authorization` (`requireFeedAuth`). No HappyView session cookie is read or forwarded.

### 5.3 Page loads and writes

- Public loads (`/search`, `/editions/[rkey]`, `/shelves`, `/readers`, `/stats`) call `hvQuery` for activity-backed data and keep drizzle for catalog pages. All pages are anonymous.
- Delete every vote/link action (`edition-work-actions.ts`, the vote form, `/works` pages, contributor/publisher pages, admin merge). There is no user write path.
- Admin mutations keep writing catalog tables with drizzle; keep their graphile `enqueue` calls. The outbox trigger publishes the changed rows; no HappyView job is involved.
- `/queries` and `/query/[nsid]` read `hvAdmin('/admin/lexicons')` and display the stored JSON.

### 5.4 Deletions

Before deleting `auth/oauth.ts`, move `publicOrigin()` to `src/lib/server/public-origin.ts`; the feed generator, image routes and cover proxy import it.

Delete `src/lib/server/xrpc-router.ts`, `src/routes/xrpc/**`, `record-detail.ts`, `follow-graph.ts`, `tap-consumer.ts`, the TAP path in `worker.ts`, `auth/oauth.ts`, `auth/session.ts`, `routes/login`, `routes/logout`, `routes/oauth`, `edition-work-actions.ts`, `edition-work-votes.ts`, `linklonk.ts`, `recommendation.ts`, `bookhive/**`, `contributor-refs.ts`, `contributor-image/**`, `book-records.ts`, `book-wire.ts`, `format-view.ts`, `edition-lookup.ts`, `edition-merge.ts`, `identifiers.ts` (replace with the `issuer`/`value` helpers), `catalog-delete.ts`, the works/contributor/publisher job handlers and backfill scripts, and the `/works`, `/contributors`, `/publishers` and admin merge routes.

Keep `edition-record.ts` (rewrite it for the media lexicon), `jobs/**` for catalog ingestion, `api/**`, `gb/**`, `isbn/**`, `isbndb/**`, `gr/**` for admin imports, `labeler/**`, `auth/feed-auth.ts`, `auth/replay-store.ts`, `cover-cache.ts`, `stats.ts`, `schema-render.ts`, `admin.ts`, `did.ts`, `db/**`, and add `media-book-view.ts` for the `editionView` mapping used by `searchEditions`/`resolveEditions`/`getEditions`.

## Step 6 — PDS and first deploy

### 6.1 Infra: rsky-pds package and PDS host

The PDS is installed **before** HappyView. All changes are in `~/Code/olamaelcu/infra`; there is no container runtime.

1. Pin rsky as a submodule: `git submodule add https://github.com/olamaelcu/rsky vendor/rsky`, then `git -C vendor/rsky checkout 53e740dac19e4bf23bafc84a7cdfc63c85d3ff2c` (the checkout that reports `rsky-pds` 1.14.18). Record both the URL and SHA in `packaging/rsky-pds/version` and the package changelog.
2. Add `packaging/rsky-pds/`: `version` (`1.14.18`), `build-deb.sh`, `debian/control.in`, `rsky-pds.service`, `rsky-pds.env`, `rsky-pds.sysusers`, `postinst`, `postrm`. `build-deb.sh` runs `cargo build --release --locked -p rsky-pds` in `vendor/rsky` (on the workstation or CI, not on lescayes), stages `target/release/rsky-pds` as `/usr/bin/rsky-pds`, and builds `rsky-pds_1.14.18_amd64.deb` with `dpkg-deb`. `Depends: libc6 (>= 2.36), ca-certificates`; `/etc/rsky-pds/rsky-pds.env` is the only conffile, and secrets live in `/etc/rsky-pds/rsky-pds.local` written by Ansible.
3. `rsky-pds.service` runs as `User=rsky-pds`/`Group=rsky-pds` with `StateDirectory=rsky-pds`, `WorkingDirectory=/var/lib/rsky-pds`, `EnvironmentFile=/etc/rsky-pds/rsky-pds.env` then `.../rsky-pds.local`, `ExecStart=/usr/bin/rsky-pds`, `Restart=always`, `LimitNOFILE=65536`, `MemoryHigh=768M`, `MemoryMax=1G`, and the same hardening block as `tap.service` (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `RestrictAddressFamilies`).
4. `/etc/rsky-pds/rsky-pds.env` defaults:

```sh
PDS_PORT=2583
PDS_HOSTNAME=pds.olamaelcu.net
PDS_SERVICE_DID=did:web:pds.olamaelcu.net
PDS_DATA_DIRECTORY=/var/lib/rsky-pds
PDS_BLOBSTORE_DISK_LOCATION=/var/lib/rsky-pds/blobs
PDS_SERVICE_HANDLE_DOMAINS=olamaelcu.net,biblio.livtet.olamaelcu.net,livtet.olamaelcu.net
PDS_INVITE_REQUIRED=false
PDS_ACCOUNT_SIGNUP_ENABLED=false
PDS_ACCOUNT_UI_ENABLED=true
PDS_CRAWLERS=https://bsky.network
PDS_CONTACT_EMAIL_ADDRESS=admin@olamaelcu.net
PDS_LOG_FORMAT=json
```

`PDS_JWT_KEY_K256_PRIVATE_KEY_HEX`, `PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX`, `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX`, `PDS_DPOP_SECRET`, `PDS_ADMIN_PASS`, and Mailgun credentials go in `rsky-pds.local` from SOPS.
5. Add the Ansible role `rsky_pds` after `postgres`: install `rsky-pds=1.14.18` from the infra APT repo, create the service user from sysusers, deploy the env/local files, enable/start, and wait for `127.0.0.1:2583/xrpc/com.atproto.server.describeServer`.
   `site.yml` order becomes `... apt_repo → postgres → rsky_pds → happyview → livtet → ...`; the HappyView role installs `happyview=2.17.4`, ensures the `bibliograph` database role/DB exist (the same database the edge uses), deploys `/etc/happyview/happyview.local`, and starts the unit after `rsky-pds` is healthy.
6. nginx vhost `pds.olamaelcu.net` via `common/deploy-nginx-app`: proxy to `127.0.0.1:2583`, `client_max_body_size 100m`, `proxy_request_buffering off`, `proxy_read_timeout 300s`; an exact WebSocket location for `/xrpc/com.atproto.sync.subscribeRepos` with `Upgrade`/`Connection` and a long read timeout. Serve `/etc/rsky-pds/static/did.json` at `/.well-known/did.json` with the PDS service DID (`#atproto` = repo-signing public key, `#atproto_pds` = `https://pds.olamaelcu.net`).
7. Pulumi/DNS: add `pds` A/AAAA records in `stacks/lescayes/dns.ts`; add `pds.olamaelcu.net` to `certbot_domains`; change the apex `_atproto` TXT to `did=did:web:olamaelcu.net` (it currently names a PLC DID) and serve `https://olamaelcu.net/.well-known/did.json` from the landing vhost with `#atproto_pds` pointing at `https://pds.olamaelcu.net`. Update the biblio DID document's `#atproto_pds` to the same endpoint and set `ATP_SERVICE_KEY_MULTIBASE` to the publisher account's `#atproto` key.
8. Publish the package with `mise run rsky-pds-publish` (`apt-repo-publish`); the role installs the pinned version. Data lives at `/var/lib/rsky-pds` (SQLite `account.sqlite`, `sequencer.sqlite`, `did_cache.sqlite`, `actors/<shard>/<did>/store.sqlite`, `blobs/`). No Postgres is involved.

The pinned rsky-pds 1.14.18 implements the surfaces this plan needs: `com.atproto.repo.getRecord` / `listRecords` / `describeRepo` / `applyWrites` / `putRecord` / `createRecord` / `deleteRecord` / `uploadBlob` / `importRepo`, `com.atproto.sync.getRepo` / `getRecord` / `getBlocks` / `getLatestCommit` / `subscribeRepos`, `com.atproto.identity.resolve*` / `getRecommendedDidCredentials`, `com.atproto.server.createAccount` / `activateAccount` / `createSession` / `describeServer`, and the admin/account endpoints. It does **not** implement `com.atproto.lexicon.resolveLexicon`; the edge serves that from the local lexicon map.

### 6.2 Accounts on this PDS

Yes: each repo the PDS hosts needs its own account. The PDS is multi-account; `PDS_SERVICE_HANDLE_DOMAINS` already lists `olamaelcu.net`, `biblio.livtet.olamaelcu.net` and `livtet.olamaelcu.net`.

Publisher (`did:web:biblio.livtet.olamaelcu.net`):

1. Put a temporary `#atproto` key and `#atproto_pds = https://pds.olamaelcu.net` into the biblio DID document; restart the edge.
2. `goat account service-auth-offline --atproto-signing-key "$TEMP_KEY" --lxm com.atproto.server.createAccount --iss did:web:biblio.livtet.olamaelcu.net --aud did:web:pds.olamaelcu.net --duration-sec 3600`.
3. `goat account create --pds-host https://pds.olamaelcu.net --existing-did did:web:biblio.livtet.olamaelcu.net --handle biblio.livtet.olamaelcu.net --password "$PDS_ACCOUNT_PASSWORD" --email "$PDS_ACCOUNT_EMAIL" --service-auth "$SIGNED_TOKEN"`.
4. Read the account's recommended DID credentials (`com.atproto.identity.getRecommendedDidCredentials`, also available through `goat`), copy its `atproto` verification method into `#atproto` in the biblio DID document (keep `#atproto_label` and the labeler/feed services), set `ATP_SERVICE_KEY_MULTIBASE` to that key, restart the edge, then `goat account activate`.

`olamaelcu.net` as `did:web:olamaelcu.net`:

1. Serve `https://olamaelcu.net/.well-known/did.json` from the landing vhost (or a static nginx file) with `#atproto_pds = https://pds.olamaelcu.net`; change the apex `_atproto` TXT to `did=did:web:olamaelcu.net`. This replaces the existing PLC identity at the apex, so coordinate the cutover.
2. Create the account with the same `service-auth-offline` + `goat account create --existing-did did:web:olamaelcu.net --handle olamaelcu.net` flow, using `--aud did:web:pds.olamaelcu.net`.
3. Copy the returned `#atproto` key into the apex DID document and `goat account activate`.

Both repos live on the same PDS and share its SQLite/blob storage; account policy, not a separate database, separates them. Verify with `curl https://pds.olamaelcu.net/xrpc/com.atproto.repo.describeRepo?repo=did:web:biblio.livtet.olamaelcu.net` and the same for `did:web:olamaelcu.net`.

### 6.3 Host capacity

`veve@lescayes` resolves to `lescayes.ts.olamaelcu.net` (2 vCPU x86_64, 3.8 GiB RAM with ~1.5 GiB available, 6.3 GiB swap, 47 GiB free on `/`, no Docker installed, `psql` present).

- rsky-pds alone is performance-friendly there: it is a Rust service with SQLite and a bounded actor-store cache. Build the `.deb` on the workstation/CI and install the binary; do not compile the workspace on the 2 vCPU host.
- Cap it with the unit's `MemoryHigh=768M`/`MemoryMax=1G` and `PDS_ACTOR_STORE_CACHE_SIZE=50` (the default 100 open actor stores is too much for 3.8 GiB). It shares the host with nginx, PostgreSQL, HappyView and the edge; the PDS should not be allowed to grow into their memory.
- Co-locating PDS + Postgres + HappyView + the SvelteKit edge on this host is tight but possible only with those caps and `postgres` already tuned for a 2 vCPU host. If HappyView's backfill/worker pushes memory pressure, move the PDS to its own instance; do not remove the caps.
- Disk: 47 GiB free is enough for the repo and a modest media set; `/var/lib/rsky-pds` grows with blobs and actor stores, so monitor it separately from `/`.

### 6.4 First deploy sequence

This is a new deployment, not a cutover. There is no old instance, old TAP consumer, or old database to run beside; every table, HappyView index, and PDS repo starts empty.

1. Infra: `mise run apply`, `mise run ansible`; `systemctl status rsky-pds` active, `curl https://pds.olamaelcu.net/xrpc/com.atproto.server.describeServer` 200, and the `pds.olamaelcu.net/.well-known/did.json` service document named in `PDS_SERVICE_DID`. The PDS is installed **before** HappyView.
2. Create both accounts (6.2): publisher `did:web:biblio.livtet.olamaelcu.net` and `did:web:olamaelcu.net`. Confirm `com.atproto.repo.describeRepo` and each DID document's `#atproto_pds` point at `https://pds.olamaelcu.net`.
3. Publish lexicons (`pnpm pds:publish-lexicons`); `com.atproto.lexicon.resolveLexicon` returns them from the PDS.
4. Infra: install the `happyview` `.deb` (3.1) and ensure `happyview.service` is active against the empty `bibliograph` database. Before any other user is provisioned, open `https://biblio.livtet.olamaelcu.net/~/hv/` and log in as the operator (first login becomes superuser). Create the admin API key (`HAPPYVIEW_ADMIN_KEY`) and a confidential API client (`client_uri=https://biblio.livtet.olamaelcu.net`, no scopes) for the edge (`HAPPYVIEW_CLIENT_KEY`/`HAPPYVIEW_CLIENT_SECRET`).
5. `hv:deploy`; confirm `GET /~/hv/admin/lexicons` and `GET /~/hv/admin/scripts` list everything.
6. Optionally backfill the network's public activity history: `POST /~/hv/admin/backfill` with `{"collection":"<nsid>"}` for each of `bookShelving`, `shelf`, `shelfItem`, `follow`, `readingGoal`, `net.olamaelcu.livtet.actor.profile`, `community.lexicon.media.book.review`; or rely on the `backfill:true` uploads. This indexes other users' records from their PDSes; it reads nothing from this repository or its database.
7. Start the edge and worker. Create the first catalog records through the admin import or provider ingestion; each insert enqueues `pds_outbox` and the publisher writes it to the PDS repo. There is no seed step.
8. Run the verification fixtures below. The first edition and first shelf are created by the tests.

## Critical files & anchors

- `docs/xrpc.md` — the deliverable of Step 1; the port reference for every activity script.
- `packages/bibliograph-service/src/lib/server/xrpc-router.ts` — current behavior for every endpoint; delete after the port.
- `packages/bibliograph-service/lexicons/community/lexicon/media/book/` — the books-wg `defs.json`, `edition.json`, `review.json`, `searchEditions.json`, `resolveEditions.json`; replace the old `community/lexicon/book` files.
- `packages/bibliograph-service/src/lib/server/shelving/hydrate.ts`, `shelf-rows.ts`, `shelf-items.ts` — view builders and predicates to translate to Lua/SQL.
- `packages/bibliograph-service/src/lib/server/edition-record.ts` — publisher record value; rewrite for `community.lexicon.media.book.edition` and the join tables.
- `packages/bibliograph-service/src/lib/server/db/schema.ts` + `drizzle/0036_appview.sql` — table changes and the `appview_book` view.

## Verification

Prerequisites: `.env` populated; `rsky-pds.service` and `happyview.service` active; `mise run db-migrate`; `mise run hv:deploy`.

1. **Docs**: `docs/xrpc.md` exists, lists all 42 registered endpoints (plus the two deliberate absences), and every NSID in the inventory has a subsection.
2. **Stack health**: `curl -s http://127.0.0.1:3000/health` → `ok`; `curl -s http://127.0.0.1:2583/xrpc/com.atproto.server.describeServer` → 200; `systemctl is-active rsky-pds happyview postgresql` → all `active`.
3. **HappyView activity query**: seed one follow row and query it:

   ```sh
   psql "$DATABASE_URL" -c "insert into happyview_records (uri,did,collection,rkey,record,cid,created_at) values ('at://did:plc:test/net.olamaelcu.livtet.biblio.follow/3ktest', 'did:plc:test', 'net.olamaelcu.livtet.biblio.follow', '3ktest', '{\"subject\":\"at://did:plc:other\",\"createdAt\":\"2026-01-01T00:00:00Z\"}'::jsonb, 'bafytest', now()) on conflict do nothing"
   curl -s -H 'x-client-key: <key>' 'http://127.0.0.1:3000/~/hv/xrpc/net.olamaelcu.livtet.biblio.graph.listFollowees?did=did:plc:test'
   curl -s 'http://127.0.0.1:5176/xrpc/net.olamaelcu.livtet.biblio.graph.listFollowees?did=did:plc:test'
   ```

   Both return `followees: [{ did: "did:plc:other", ... }]`; the gateway body has no `__bib_http`.
4. **Error envelope**: call `getShelf?uri=at://did:plc:missing/net.olamaelcu.livtet.biblio.shelf/reading` through the gateway → `404` with `{error:"RecordNotFound"}` (not 200).
5. **Catalog publisher from empty**: create one test edition with its identifier and contributor rows, then wait for the outbox to drain:

   ```sh
   psql "$DATABASE_URL" -c "insert into editions (uri,rkey,title,published_date,format,created_at) values ('at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.media.book.edition/testedition','testedition','Test Book','2026','physical',now())"
   psql "$DATABASE_URL" -c "insert into edition_identifiers (edition_uri,issuer,value) values ('at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.media.book.edition/testedition','isbn13','9780000000000')"
   psql "$DATABASE_URL" -c "with c as (insert into contributors (name) values ('Test Author') returning id) insert into edition_contributors (edition_uri,contributor_id,position,role) select 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.media.book.edition/testedition', id, 1, 'author' from c"
   psql "$DATABASE_URL" -c "with p as (insert into publishers (name) values ('Test Press') returning id) insert into edition_publishers (edition_uri,publisher_id,position) select 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.media.book.edition/testedition', id, 1 from p"
   sleep 2; psql "$DATABASE_URL" -c "select count(*) from pds_outbox"   # eventually 0
   curl -s 'http://127.0.0.1:5176/xrpc/com.atproto.repo.getRecord?repo=did:web:biblio.livtet.olamaelcu.net&collection=community.lexicon.media.book.edition&rkey=testedition'
   ```

   The response has `value.title = "Test Book"`, one `isbn13` identifier, one `Test Author` contributor, and a CID; the PDS `getRecord` returns the same value.
6. **Activity join**: insert one shelf and one shelving row for a fake DID against the test edition:

   ```sh
   psql "$DATABASE_URL" -c "insert into happyview_records (uri,did,collection,rkey,record,cid,created_at) values ('at://did:plc:test/net.olamaelcu.livtet.biblio.shelf/reading','did:plc:test','net.olamaelcu.livtet.biblio.shelf','reading','{\"name\":\"Currently Reading\",\"createdAt\":\"2026-01-01T00:00:00Z\"}'::jsonb,'bafytest',now()), ('at://did:plc:test/net.olamaelcu.livtet.biblio.bookShelving/testedition','did:plc:test','net.olamaelcu.livtet.biblio.bookShelving','testedition','{\"shelf\":\"at://did:plc:test/net.olamaelcu.livtet.biblio.shelf/reading\",\"book\":{\"uri\":\"at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.media.book.edition/testedition\"},\"createdAt\":\"2026-01-01T00:00:00Z\"}'::jsonb,'bafytest',now()) on conflict do nothing"
   curl -s 'http://127.0.0.1:5176/xrpc/net.olamaelcu.livtet.biblio.listBooksOnShelf?shelf=at://did:plc:test/net.olamaelcu.livtet.biblio.shelf/reading'
   ```

   `bookShelves[0].book.title` is `Test Book` from `appview_book`.
7. **Review lookup**: insert one `community.lexicon.media.book.review` row whose `subjectRecord` is the test edition, then query `getReviewsByBook?book=<testedition-uri>`; expect the review with `record.rating`/`textContent` intact. Query `listReviewsByActor?did=did:plc:test`; expect the same review.
8. **No legacy reads**: `grep -R "from '\\$lib/server/xrpc-router'\\|from './xrpc-router'" packages/bibliograph-service/src` → nothing; `pnpm --filter bibliograph-service check` and `lint` pass.
9. **Feed**: `getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed.generator/public` returns reviews and shelving from `happyview_records`; `following` with a service auth JWT returns only followed authors.

## Assumptions & contingencies

- **HappyView 2.17.4 keeps the v2 script contract.** If the deployed image rejects v2 globals, do not switch to 3.0.0-beta mid-deploy: pin the last known-good 2.x tag and use `happyview-codemod` only after the deploy is stable.
- **`db.raw` can join `happyview_records` to `appview_book`.** This requires HappyView's default local record storage; if external record storage is enabled, the query fails and must move to the edge. Do not enable `RecordStorage` on this instance.
- **HappyView serialises the `__bib_http` envelope without validating it against the query's output schema.** Verify this right after `hv:deploy` with a missing `getShelf`; if the script response is rejected, return `200 {error,message}` from the script and make the gateway map that body to a 404 only for the documented error values, accepting the wire change for these endpoints.
- **No end-user OAuth is needed.** The AppView serves anonymous queries and read-only procedures; only HappyView's dashboard login uses OAuth. If a user-write procedure is added later, re-introduce the happyview session/DPoP path then; do not add it now.
- **`POST /admin/users` accepts `{did}` with no template/permissions** (for the operator dashboard). If it does not, create the user with `template: "viewer"`; no admin permission is needed to log in.
- **An edition a shelving row names but the catalog lacks is omitted** until an import or admin ingest creates it. There is no activity→catalog queue and no provider fetch in a query path.
- **The books-wg lexicons are provisional.** Copy the exact files from the `books-wg.tngl.sh/lexicons` repo at implementation time and pin the commit (the repo is 8 commits old and moving). If `community.lexicon.media.book.edition` changes key or fields, update `edition-record.ts`, the join tables and `searchEditions` together; do not keep a compatibility alias.
- **`olamaelcu.net` is a did:web account on the same PDS.** Serve its DID document at the apex, change `_atproto` to `did:web:olamaelcu.net`, and create it with `--existing-did`. This replaces the current PLC identity; coordinate the change.
- **lescayes can host the PDS with the rest of the stack only under the caps in 6.3.** 2 vCPU/3.8 GiB is tight; `MemoryHigh=768M`/`MemoryMax=1G` and `PDS_ACTOR_STORE_CACHE_SIZE=50` are mandatory. If backfill pushes pressure, move the PDS to its own instance rather than raising limits.
- **rsky-pds 1.14.18 accepts `applyWrites`.** It implements `com.atproto.repo.applyWrites`; if the pinned build rejects it, change the outbox publisher to one `com.atproto.repo.putRecord`/`deleteRecord` per row; the outbox columns and retry logic are unchanged.
- **No works, contributor records, publisher records, Bookhive, or voting exist.** Any remaining reference is a compile error to remove; there is no compatibility path.
