# Lexicons

Bibliograph defines and serves every lexicon listed here under the
`community.lexicon.book.*` namespace. The source of truth for each
schema is the matching JSON file under `lexicons/community/lexicon/book/`.
This document is a tour. For required vs. optional fields, key types,
or error variants, follow the links.

| | |
|---|---|
| Authoritative namespace | `community.lexicon.book.*` |
| Schema files | [`lexicons/community/lexicon/book/`](lexicons/community/lexicon/book) (35 files) |
| Codegen | `@atcute/lex-cli`, config in [`lex.config.js`](lex.config.js) |
| Codegen output | `src/lexicons/` (runtime loaders; not currently emitted as checked-in TS) |
| Service identity | `did:web:biblio.livtet.olamaelcu.net` (driven by `ATP_SERVICE_DID`, defaults to `did:web:localhost`) |
| Service discovery | `GET /.well-known/did.json` returns the labeler service doc |
| Live lexicon JSON | `GET /lexicon/{nsid}` (raw schema, for client-side validation) |
| Hash pinning | `GET /lexicon-hashes.json` (SHA-256 of every lexicon JSON) |

## Records

Stored in user PDS repos and indexed by the AppView via Tap. All use a
`tid` record key.

| NSID | Purpose |
|---|---|
| [`community.lexicon.book.book`](lexicons/community/lexicon/book/book.json) | Core book definition (title, author, ISBN, metadata, optional contributors) |
| [`community.lexicon.book.claim`](lexicons/community/lexicon/book/claim.json) | Author/publisher claim with deduplication key; verification emits a `book:author` label |
| [`community.lexicon.book.review`](lexicons/community/lexicon/book/review.json) | User review with optional 1–5 rating |
| [`community.lexicon.book.status`](lexicons/community/lexicon/book/status.json) | Reading status (`reading`, `read`, `to-read`, `abandoned`) with optional progress and rating |
| [`community.lexicon.book.shelf`](lexicons/community/lexicon/book/shelf.json) | Named shelf owned by a user |
| [`community.lexicon.book.shelfItem`](lexicons/community/lexicon/book/shelfItem.json) | A book on a shelf, with an optional note |
| [`community.lexicon.book.contributor`](lexicons/community/lexicon/book/contributor.json) | Person or entity that worked on a book (author, illustrator, etc.) |
| [`community.lexicon.book.contributor.type`](lexicons/community/lexicon/book/contributor/type.json) | Canonical contributor role published by the AppView |

### Records owned by the AppView

The service DID also publishes records under this namespace:

- The five canonical `contributor.type` records (`author`, `illustrator`,
  `editor`, `translator`, `narrator`) are seeded at boot from
  `src/db/init.ts`. Additional roles can be created at runtime via the
  `community.lexicon.book.contributor.createType` procedure (librarian-gated).
- When the AppView mirrors `buzz.bookhive.catalogBook` records into
  Bibliograph-owned `book` records, it also creates matching
  `contributor` records under its own DID (deduped by lowercased name).

## Shared defs

[`community.lexicon.book.defs`](lexicons/community/lexicon/book/defs.json)
defines two reusable objects referenced by other lexicons in the
namespace:

| Ref | Used by |
|---|---|
| `community.lexicon.book.defs#bookRef` | `review`, `status`, `shelfItem`, `getFeed` output buckets |
| `community.lexicon.book.defs#identifier` | `book` (via `identifiers[]`), `claim`, `contributor` |

## Queries

XRPC GET `/xrpc/<nsid>`.

| NSID | What it returns |
|---|---|
| [`community.lexicon.book.book.get`](lexicons/community/lexicon/book/book/get.json) | Single book by `at-uri`; resolves the inline `contributors[]` array |
| [`community.lexicon.book.book.getMany`](lexicons/community/lexicon/book/book/getMany.json) | Batch fetch up to 25 books by `at-uri` |
| [`community.lexicon.book.book.list`](lexicons/community/lexicon/book/book/list.json) | Paginated book list |
| [`community.lexicon.book.book.search`](lexicons/community/lexicon/book/book/search.json) | Full-text search on title, author, ISBN; identifier search via `identifier=isbn,oclc,asin` |
| [`community.lexicon.book.book.feed`](lexicons/community/lexicon/book/book/feed.json) | Aggregator: `recent`, `newestBooks`, `trending {day, week, month}`, optional `following` and `crossUser` buckets (feature-flagged via `ATP_FEATURE_FEED_GENERATOR=1`) |
| [`community.lexicon.book.review.get`](lexicons/community/lexicon/book/review/get.json) | Single review by `at-uri` or by `did + bookUri` |
| [`community.lexicon.book.review.getMany`](lexicons/community/lexicon/book/review/getMany.json) | Paginated reviews for a book |
| [`community.lexicon.book.status.list`](lexicons/community/lexicon/book/status/list.json) | Reading statuses for a user, filterable by book/status |
| [`community.lexicon.book.claim.getMany`](lexicons/community/lexicon/book/claim/getMany.json) | Claims attached to a book |
| [`community.lexicon.book.shelf.get`](lexicons/community/lexicon/book/shelf/get.json) | Single shelf by `at-uri` |
| [`community.lexicon.book.shelf.list`](lexicons/community/lexicon/book/shelf/list.json) | A user's shelves (paginated) |
| [`community.lexicon.book.shelfItem.list`](lexicons/community/lexicon/book/shelfItem/list.json) | Books on a shelf |
| [`community.lexicon.book.contributor.get`](lexicons/community/lexicon/book/contributor/get.json) | Single contributor by `at-uri` |
| [`community.lexicon.book.contributor.list`](lexicons/community/lexicon/book/contributor/list.json) | Paginated list of known contributors |
| [`community.lexicon.book.contributor.search`](lexicons/community/lexicon/book/contributor/search.json) | Full-text search over contributor name and alt names |
| [`community.lexicon.book.contributor.listTypes`](lexicons/community/lexicon/book/contributor/listTypes.json) | List canonical contributor roles |

## Procedures

XRPC POST `/xrpc/<nsid>`. Auth is required for every procedure; the
AppView uses service-JWT verification (`@atcute/xrpc-server/auth`'s
`ServiceJwtVerifier`, see `src/auth.ts:39`). Authorization is
claim-owner, librarian, or actor-DID-equals-record-DID.

| NSID | Input summary | Errors |
|---|---|---|
| [`community.lexicon.book.book.create`](lexicons/community/lexicon/book/book/create.json) | `title` (required), `author` (required), plus optional ISBN, dates, description, page count, language, categories, cover URL | `DuplicateBook`, `InvalidInput` |
| [`community.lexicon.book.review.create`](lexicons/community/lexicon/book/review/create.json) | `bookUri`, `text`, optional `rating` | `BookNotFound` |
| [`community.lexicon.book.status.create`](lexicons/community/lexicon/book/status/create.json) | `status`, plus `bookUri` or `identifiers[]`, optional `progress`, `rating`, dates | `BookNotFound`, `StatusAlreadyExists` |
| [`community.lexicon.book.claim.create`](lexicons/community/lexicon/book/claim/create.json) | `bookUri`, `identifier`, `identifierType ∈ {isbn, ean, issn}` | `BookNotFound`, `ClaimAlreadyExists` |
| [`community.lexicon.book.shelf.create`](lexicons/community/lexicon/book/shelf/create.json) | `name` (required), optional `description`, `metadata`, `coverUrl` | `InvalidInput` |
| [`community.lexicon.book.shelfItem.create`](lexicons/community/lexicon/book/shelfItem/create.json) | `shelfUri`, `bookUri`, optional `note` | `ShelfNotFound`, `BookNotFound`, `Forbidden`, `DuplicateShelfItem`, `InvalidInput` |
| [`community.lexicon.book.shelfItem.delete`](lexicons/community/lexicon/book/shelfItem/delete.json) | `shelfUri`, `bookUri` | `ShelfNotFound`, `Forbidden`, `NotFound`, `InvalidInput` |
| [`community.lexicon.book.contributor.create`](lexicons/community/lexicon/book/contributor/create.json) | `name`, `identifiers[]` (≥1), optional `altNames`, `images`, `bio` | `InvalidInput`, `DuplicateContributor` |
| [`community.lexicon.book.contributor.update`](lexicons/community/lexicon/book/contributor/update.json) | `uri`, optional `patch`, add/remove identifiers, images | `InvalidInput`, `DuplicateContributor`, `NotFound`, `Forbidden` |
| [`community.lexicon.book.contributor.createType`](lexicons/community/lexicon/book/contributor/createType.json) | `name`, optional `description` (librarian-only) | `InvalidInput`, `DuplicateContributorType`, `Forbidden` |

## Service subscription

| NSID | Transport | Notes |
|---|---|---|
| [`com.atproto.label.subscribeLabels`](https://atproto.com/specs/xrpc#subscription) | WebSocket upgrade on `GET /xrpc/com.atproto.label.subscribeLabels` | The AppView is its own label authority. Initial frame is the current active-labels snapshot; subsequent frames are append-only events from `label_events`. Two label values are emitted: `book:author` (verified claim) and `book:librarian` (admin role). See `src/labeler-service.ts` and `src/labeler.ts`. |

## Third-party records also indexed

Bibliograph indexes these on behalf of the BookHive ecosystem, via Tap
streams and a `listRecords` mirror of the catalog:

- `buzz.bookhive.catalogBook`: book catalog entries from `@bookhive.buzz`
- `buzz.bookhive.book`: per-user reading statuses, ratings, and reviews
- `buzz.bookhive.activity`: user-activity feed used to discover
  BookHive users whose statuses are worth mirroring

Each is mirrored into a `community.lexicon.book.*` row in the local
SQLite index, not stored as `buzz.bookhive.*` rows.

## Endpoint wiring

All XRPC routes are mounted in [`src/app.ts`](src/app.ts). Handler
implementations live under `src/api/`:

- `get-book.ts`, `get-feed.ts`, `get-contributor.ts`: queries
- `create-book.ts`, `contributor.ts`: procedures
- `labeler-service.ts`: the `subscribeLabels` WebSocket

## Discovery and validation

```
# Service DID document (AtprotoLabeler service entry)
curl https://biblio.livtet.olamaelcu.net/.well-known/did.json

# Raw schema for any NSID (e.g. for client-side validation)
curl https://biblio.livtet.olamaelcu.net/lexicon/community.lexicon.book.book

# SHA-256 map of every lexicon JSON (pin in your client to detect drift)
curl https://biblio.livtet.olamaelcu.net/lexicon-hashes.json

# Health check
curl https://biblio.livtet.olamaelcu.net/health
```
