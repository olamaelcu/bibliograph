# Module layers and the record-shape invariant

How `packages/bibliograph-service/src` is organised today, and the invariant
that keeps the served record honest: exactly one writer of the edition record
shape. The catalog-side comparison with BookHive lives in
[bookhive-import.md](bookhive-import.md).

## What exists today

One enforced boundary, still only two levels deep and still only by convention:

```
src/routes/**            (transports: SvelteKit pages, /xrpc, /health, /metrics)
  └── src/lib/server/*   (~30 flat modules plus subsystem dirs: jobs/ search/
                           bookhive/ shelving/ constellation/ labeler/ auth/ gb/
                           gr/ isbndb/ isbn/ pds/ lex/ api/ contributor-image/)
        └── src/lib/server/db   (drizzle: schema.ts, index.ts, migrate.ts)
```

The same three issues, as they stand now:

- SQL in a transport: `src/routes/xrpc/book-queries.ts` imports `lib/server/db`
  (`db` at line 22; the schema import is `editions, follows`), and three page
  servers import it too — `routes/admin/import/isbn/+page.server.ts`,
  `routes/admin/editions/merge/+page.server.ts`, and
  `routes/editions/[rkey]/edit/+page.server.ts`.
- A transport importing the router: 8 modules under `src/routes/**` import
  `$lib/server/xrpc-router` (for `log` and `searchService`), e.g.
  `routes/editions/[rkey]/+page.server.ts:13`.
- Cache-Control: unauthenticated GET XRPC responses get
  `public, max-age=60, stale-while-revalidate=300` at the router boundary
  (`src/hooks.server.ts`); non-GET, authorized requests, and responses that set
  their own `cache-control` are left untouched. Pages and `.well-known/*` still
  have no shared rule: each route sets what it sets (`.well-known/*`, `/image/*`,
  `/stats/counts` (`no-store`), and the CAR routes do set their own).

`src/lib/server/data/` does not exist; `xrpc-router.ts` is ~3,000 lines and is
the XRPC registry.

## The edition record shape (the invariant)

`lib/server/edition-record.ts` is the only place the edition record shape is
written — its header comment says exactly that. `editionRecordValue(row,
overrides)` builds the served value; `editionRecordCid` hashes it.

Who builds on it:

- `xrpc-router.ts` (`com.atproto.repo.getRecord`, ~line 450) — builds the
  response value through `editionRecordValue(row, …)` at the read path.
- The record backfill jobs (ISBN, cover, description, work description) — all
  call it with one override per field.
- `isbn/record-value.ts#editionRecordValueForCid` — the BookHive-catalog
  recompute path (re-CID after an identifier-mapping change).
- `book-records.ts` — the work / contributor / publisher record values.
- `record-detail.ts` imports `rowIdentifiers` from it but builds its
  page-facing `EditionValue` (from `$lib/types/record-detail`) inline. That is
  an appview display shape for the record pages, not a CID input, so it is not
  a second source of record truth.

The drift the old version of this document warned about is closed: the three
job-side field lists were deleted, and `makeBookView`
(`shelving/hydrate.ts:88`) resolves contributor names through
`contributorNamesFor` and filters out refs whose name is empty (the
`defs#contributorView.name` field is required non-empty), so
`getReviewsByBook` / `getShelf` / `listShelvesWithBooks` / `getShelvingOfBook`
no longer emit `contributor: { name: '', uri }`.

## Book identity: `editions.tid` and `edition_aliases`

An edition uri is a provider namespace (`ol.*`, `gb.*`, `bh.*`, `isbndb.*`, all under
`PUBLISHER_DID`), so one book can be known by several uris — and a librarian merge
(`edition-merge.ts`) retires the losers by deleting their rows.

`editions.tid` is the book's canonical identity (migration `0020`): an ATProto TID,
13 lowercase base32 chars, minted by the `editions_next_tid()` column default so
every insert path — jobs, admin import, scripts, psql — gets one without the caller
knowing. It is `UNIQUE`, which is what makes "one record per book" enforceable rather
than hoped for.

`edition_aliases` holds the uris a merge retired, each pointing at the surviving
book's `tid` (`ON DELETE CASCADE`, so a catalog takedown takes its aliases with it).
Every reader handed an edition uri goes through `edition-lookup.ts`:

| Caller | Why it resolves instead of selecting by uri |
| --- | --- |
| `shelving/hydrate.ts` | shelving rows, reviews and shelf listings carry whatever uri the user's record named |
| `xrpc-router.ts` `getBooks` | collapses two requested uris of one book to a single `bookView` |
| `getImageForBook`, `bookhiveSubjectForEdition` | a retired uri still finds the survivor's cover / Bookhive backlinks |
| `record-detail.ts` | the edition page opens the surviving record instead of asking a provider to rebuild a duplicate |

Two write paths keep the invariant from decaying: `mergeEditionsInDb` records the
losing uris before deleting them (inside the transaction), and `ingestEditionBatch`
skips uris that are aliases, so re-ingesting a merged-away provider record cannot
resurrect the duplicate under a fresh `tid`.

## ISBN backfill: two passes

`scripts/backfill-edition-isbns.ts` enqueues a `backfill-edition-isbn` job for every
catalog edition with no ISBN and no `edition_isbn_enrichment` row, skipping rows that
already have a queued job (the row budget goes to fresh work). The job refetches the
provider authority (tier 1, deterministic) and, when that has no ISBN, searches
Google Books and writes a single surviving candidate; a tie is
recorded `ambiguous` and written nowhere.

Rows already stamped with a verdict (`shadow`, `none`) are not reached by that scan,
so `scripts/requeue-isbn-enrichment.ts --result=<verdict>` re-enqueues the ones still
missing an ISBN. Once written their result becomes `found`, which keeps the second
pass idempotent.
