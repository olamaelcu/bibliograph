# Importing BookHive patterns: field mapping and live-instance findings

What BookHive (`buzz.bookhive.*`, repo `did:plc:enu2j5xjlqsjaylv3du4myh4`) actually publishes,
what Bibliograph's BookHive ingestion currently does with it, and what is worth importing. Module
layering is in [architecture.md](architecture.md).

## Live verification (2026-11-01)

Every call below is a read; nothing was written to any repository.

| Check | Result |
| --- | --- |
| `GET https://plc.directory/did:plc:enu2j5xjlqsjaylv3du4myh4` | `alsoKnownAs: ["at://bookhive.buzz"]`, `#atproto_pds → https://bluesky.nickthesick.com`. The handle and the PDS match `BOOKHIVE_DID` / the `BOOKHIVE_PDS` default at `bookhive/keys.ts:19-20`. |
| `GET https://bluesky.nickthesick.com/xrpc/_health` | `200 {"version":"0.4.5051"}` |
| `GET .../com.atproto.repo.describeRepo?repo=<did>` | `200`; `handle: bookhive.buzz`, `handleIsCorrect: true`; collections include `buzz.bookhive.book`, `buzz.bookhive.buzz`, `buzz.bookhive.catalogBook`. |
| `GET .../buzz.bookhive.getProfile?handle=nickthesick` | `401 AuthMissing` — the profile query is authed, so an appview can never call it anonymously. Bibliograph does not (README: TAP mirror + Constellation backlinks), which is the right call. |
| `GET https://bookhive.buzz/` | **HTTP 521** (Cloudflare, origin down), 16-byte plain-text body, while the PDS above answered 200. |
| `GET .../com.atproto.repo.listRecords?collection=buzz.bookhive.catalogBook` | `200`, records carry `$type` and optional blobs; format matches `lexicons/catalogBook.json`. |
| `GET .../com.atproto.repo.listRecords?collection=buzz.bookhive.book` | `200` — and the **whole collection in the BookHive repo is 19 records**. Users' books live in *their own* repos, so `@bookhive.buzz` is the catalog plus a handful of leftovers; enumerating reviews from this repo was never an option and the TAP mirror + Constellation backlinks are the only route. All four status tokens appear: `#reading` 2, `#wantToRead` 12, `#finished` 3, `#abandoned` 2. |

Two operational facts fall out of that: the **appview origin and the PDS fail independently** (so
an appview 5xx is not a data outage, and any image URL hosted on `bookhive.buzz` — BookHive's own
`/images/books/{hiveId}` route — inherits that outage), and the PDS itself refused TCP on 443 for
~5 minutes earlier in the same session before recovering, which is why the TAP consumer's dead
letter (`ingest_dead_letter`, `tap_dead_letter`) and not a one-shot fetch is the correct ingestion
shape.

## Field census: `buzz.bookhive.catalogBook`, 1000 live records

Ten pages of 100 (the `limit` ceiling) from `com.atproto.repo.listRecords`, 2026-11-01; the
percentages are how many of those 1000 values carry the field.

| Field | Present | Bibliograph target | Current mapping (`bookhive/catalog.ts`) |
| --- | --- | --- | --- |
| `id`, `title`, `authors`, `createdAt` | 100 % | edition rkey `bh.{id}`, `title`, `contributors`, `created_at` | mapped — `authors` becomes `contributors` only where the name matches a catalog contributor (`scripts/ingest-bookhive-catalog.ts:38-87`) |
| `cover`, `thumbnail` | 100 % | `editions.cover_image_url` | mapped — `cover` preferred, `thumbnail` fallback (`catalog.ts:78`) |
| `source`, `sourceId`, `sourceUrl` | 100 % | `bookhive` + `goodreads` identifiers | mapped, but only when `source.toLowerCase() === 'goodreads'` (`catalog.ts:96`) |
| `rating` (×1000, e.g. `3090`) | 100 % | — | deliberately dropped (documented in `catalog.ts:1-30`) |
| `ratingsCount` | 100 % | — | ignored |
| `identifiers` `{hiveId, isbn10, isbn13, goodreadsId}` | 99.0 % | `editions.identifiers` | **ignored** — the ISBNs are on-protocol and unused |
| `description` | 95.4 % | `editions.description` | **ignored** — and the description backfill then spends upstream calls re-deriving it |
| `thumbnailBlob` / `coverBlob` | 87.2 % / 85.4 % | — | ignored (see decision below) |
| `genres` | 80.7 % | no edition column | ignored |
| `ratingsDistribution` | 58.3 % | — | ignored |
| `publicationYear` | 57.3 % | `editions.published_year` | **ignored** |
| `language` | 57.0 % | `editions.language` | **ignored** |
| `publisher` | 56.4 % | `editions.publisher_uri` (strongRef) | **ignored** — BookHive has a name string, and the lexicon wants a ref to a publisher record |
| `numPages` | 55.1 % | `community.lexicon.book.edition#pages` | **no target at all** — the lexicon field exists but `editions` has no `pages` column |
| `authorBio` | 46.0 % | `contributors.bio` | ignored |
| `series` | 36.6 % | — | ignored; see the discrepancy note |
| `secondaryAuthors` | 4.9 % | `editions.contributors` roles | ignored |

### Free wins (field present on-protocol, dropped on ingest)

1. `identifiers.isbn13` / `isbn10` → `editions.identifiers`, using the existing
   `isbnIdentifier(raw)` (`isbn/merge.ts:40`), which already picks `isbn13` vs `isbn10` from the
   length and produces the `{ uri: 'isbn:…', resource: 'isbn13' }` shape `edition_isbn_enrichment`
   scans for. BookHive is an ISBN source Bibliograph currently does not use for a book it already
   has in hand — 99 % of the catalog carries it.
2. `identifiers.goodreadsId` → `goodreads` identifier, replacing the `source`/`sourceId` guess
   that silently drops every non-Goodreads-sourced record.
3. `description` → `editions.description`, which also removes those editions from
   `jobs/description-backfill.ts`'s scan.
4. `language`, `publicationYear` → existing columns.
5. `numPages` → needs an `editions.pages` column before the lexicon's `pages` field can be served
   at all: today `getRecord` and the stored CID omit a field the lexicon declares.

### Discrepancies to document, not to model

- `series` is a **JSON string**, not a series name:
  `"{\"title\":\"B.P.R.D.\",\"position\":\"\",\"webUrl\":\"https://www.goodreads.com/series/55298-b-p-r-d\"}"`.
  `lexicons/catalogBook.json` types it as `string` "Series name"; the payload is Goodreads'
  serialised object. No column until the lexicon and the payload agree.
- `publisher` is a display name, so it cannot become `editions.publisher_uri` without minting a
  publisher record per name — the same gap that keeps `authors` out of `contributors` unless the
  names resolve against the catalog.

### `thumbnailBlob` — decision: keep ignoring it

Both blobs are stored on the BookHive PDS from the same Goodreads URLs (`services/
catalogBookService.ts:136-181` re-uploads `freshBook.thumbnail`/`cover`). The external CDN URLs
are present on 100 % of records, while the blobs are present on 85–87 %. Importing blobs would
mean fetching a ~2 MB cover per edition from a PDS (the exact host that refused connections
during this check), re-encoding it and serving it ourselves, in exchange for a field Bibliograph
already fills from a CDN and already refreshes through `jobs/cover-backfill.ts`. The ID-keyed
image pattern BookHive uses is worth copying — and Bibliograph already has it:
`getImageForBook` resolves `editions.cover_image_url` at request time and enqueues a backfill when
it is missing (`xrpc-router.ts:812-844`), which is BookHive's `coverImageUrl(hiveId)` idea without
depending on BookHive being up.

## Field mapping: `buzz.bookhive.book` → `bookReview` / shelving

One user record carries the review, the rating and the reading status at once; Bibliograph never
rewrites it and derives both views at read time in `bookhive/records.ts`.

| `book` field | Target | Current | Note |
| --- | --- | --- | --- |
| `hiveBookUri` | the Constellation subject, then edition `bh.{hiveId}` | mapped (`records.ts:51-59`), `hiveId` fallback | 18 of 19 records in the live sample carried it; the fallback is what covers the rest |
| `status` | `defs#readingStatus` on the shelf view | mapped (`records.ts:30-34`) onto `reading`/`read`/`to-read`/`dnf` | the live tokens are the full nsids (`buzz.bookhive.defs#wantToRead`, …), so the map keys are right |
| `stars` (1–10) | `bookReview.rating` (1–10) | mapped (`records.ts:76`), range-checked | same scale; only the display conversion is missing |
| `review` | `bookReview.text` | mapped, empty string → no review | `bookReview` also requires `book` and `createdAt`, which the router fills when it builds the `reviewView` |
| `createdAt` | `bookReview.createdAt` | mapped (`records.ts:70`) | a review is dated by *record creation*, not `finishedAt`; a book finished months after being added shows the wrong date |
| `startedAt`, `finishedAt` | — | dropped | no date fields on `bookReview` beyond `createdAt` |
| `bookProgress` | — | dropped | no progress surface in the appview |
| `previousReads` | — | dropped | decision below |
| `identifiers`, `owned`, `cover`, `title`, `authors` | — | dropped | the edition and its identifiers come from `catalogBook`; the denormalised copies are only a fallback when `hiveBookUri` is absent |


## Bugs found while mapping

1. **`splitAuthors` splits the wrong separator.** `bookhive/catalog.ts:56` splits on
   `;`/`and`/`&`/`,`, but BookHive's `authors` is *tab*-separated — `lexicons/catalogBook.json`
   says "tab separated" and BookHive's own `core/authors.ts` parses on `\t`. Observed:
   `"Ann Leckie\tBecky Chambers"` → `["Ann Leckie\tBecky Chambers"]` (one author, tab intact),
   and `"Smith, John"` → `["Smith","John"]` (one author turned into two). The ingest script
   feeds exactly that output to a lowercased name lookup
   (`scripts/ingest-bookhive-catalog.ts:38-48,79-87`), so a tab-joined pair resolves to no
   contributor and a comma-inverted name resolves to two names that do not exist: the edition
   lands with an empty `contributors` array and nothing is logged. Import BookHive's
   `parseAuthors` (split on tab, trim, drop empties) and render with `join(', ')` at the edge.
2. **`HIVE_ID_RE` is stricter than BookHive's.** `bookhive/keys.ts:31` requires `bk_` + 6 or more
   characters; BookHive's `core/hiveId.ts` uses `^bk_[A-Za-z0-9]+$` and documents a `bk_none`
   sentinel. `parseCatalogBook` returns `null` for a non-matching id, so such a record is skipped
   silently rather than logged.
3. **The rating scale is already correct — do not "fix" it.** `bookReview.rating` is `integer,
   minimum 1, maximum 10` (`lexicons/net/olamaelcu/livtet/biblio/bookReview.json`), the same scale
   as BookHive's `stars`, so `records.ts:76` passing `stars` through is right. What is missing is
   the *display* conversion at the UI edge — import `core/rating.ts`'s `starsToDisplayRating`
   (÷2, so 1–10 → 0.5–5) rather than converting on ingest, which would make Bibliograph's stored
   record disagree with BookHive's for the same review.

## `previousReads` — decision: out of scope, documented

`buzz.bookhive.book#previousReads` exists live (`core/bookLifecycle.ts` archives a read when a
finished book goes back to Reading) and no Bibliograph surface consumes it:
`normalizeBookhiveBook` (`bookhive/records.ts:62-81`) derives only review text, stars, timestamp
and shelf. Bibliograph has no `reviews` table to hang a `previous_reads` column on — reviews are
read through from `records` — and `getShelvingOfBook`/`getReviewsByBook` are per-book projections
with no history view.

Keep it out. If re-read counting ever becomes a requirement (reading goals, a stats surface), the
import is the pair `core/bookLifecycle.ts` (the single reading-state transition, which owns the
rotation) plus `core/readingYear.ts` (`timesFinishedInYear`: UTC year boundaries, and re-reads
count — a re-read *is* a book read this year), together with a `previous_reads` jsonb. Importing
the year counter without the rotation would produce a number that silently ignores re-reads.

## Also worth importing (small, no schema change)

| BookHive | Why |
| --- | --- |
| `core/hiveId.ts` `isHiveId`/`asHiveId` | narrow a wire value instead of casting it; the comment there records `/books/null` reaching the database through an `as HiveId` |
| `lib/errors.ts` `errorMessage`/`toErrorPayload`/`truncateForLog` | one bounded shape for an unknown throw; Bibliograph re-derives it as `err instanceof Error ? err.message : String(err)` at five separate sites in `jobs/handlers.ts` (249, 331, 405, 469, 518) before writing `error_message` |
| `core/cacheHeaders.ts` | one signed-in/signed-out caching rule — Bibliograph sets no `Cache-Control` at all |
