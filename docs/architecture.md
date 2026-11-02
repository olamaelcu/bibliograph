# Module layers and the shared read layer

How `packages/bibliograph-service/src` is organised today, what the four-layer split in
BookHive's `ARCHITECTURE.md` (`src/{lib,core,data,services}` with one allowed import direction)
would change here, and which reads currently exist more than once. The BookHive side of that
comparison — lexicons, record fields, live endpoints — is in
[bookhive-import.md](bookhive-import.md).

## What exists today

There is one enforced boundary and it is only two levels deep:

```
src/routes/**            (transports: SvelteKit pages, /xrpc, /health, /metrics)
  └── src/lib/server/*   (~40 flat modules)
        └── src/lib/server/db   (drizzle: schema.ts, index.ts, migrate.ts)
```

`src/lib/server/` is a grab bag: DB access (`record-detail.ts`, `catalog-delete.ts`), upstream
clients (`api/`, `ol/`, `gb/`, `isbndb/`, `isbn/`), BookHive normalisation (`bookhive/`),
Discovery (`constellation/`), policy (`labeler/`, `auth/`, `rate-limit.ts`), background work
(`jobs/`) and the router itself (`xrpc-router.ts`, 1861 lines). Nothing stops a page server from
reaching the database, and two do.

BookHive's split names five buckets and allows exactly one import direction
(`routes/xrpc/pages/middleware → services → data → core → lib`). The value of importing the rule
is not the folder names; it is what the rule prevents, and all three of the following are already
happening here:

| BookHive rule | Violation here | Consequence observed |
| --- | --- | --- |
| No SQL outside `data/` — a query inside a transport is structurally unreachable by the others | `src/routes/xrpc/book-queries.ts:10-11` imports `db` + `contributors` directly; `src/routes/admin/import/isbn/+page.server.ts` and `src/routes/admin/editions/merge/+page.server.ts` import `lib/server/db` | the contributor read exists in `lib/server/book-contributor-view.ts:40` and again inline in a transport at `src/routes/xrpc/book-queries.ts:38-39`, where no feed or page server can reach it |
| A transport never imports another transport | 7 imports of `$lib/server/xrpc-router` from `src/routes/**` — e.g. `src/routes/editions/[rkey]/+page.server.ts:12` takes `log, searchService` from it | the router owns the search service and the logger, so a page cannot be built or tested without constructing the XRPC router |
| A public read has one caching rule | no `Cache-Control` header is set anywhere in `packages/bibliograph-service/src` | public `com.atproto.repo.*` and search reads are uncacheable for every intermediary; BookHive's `core/cacheHeaders.ts` is a single signed-in/signed-out rule |

## The shared read layer (proposal, not implemented)

Every read that more than one transport answers belongs in `src/lib/server/data/`, and the
transports stay thin adapters over it. The candidate files, their owners, and the sites that
collapse into them:

| Proposed file | Would own | Current duplicate sites |
| --- | --- | --- |
| `data/edition-record.ts` | `editionRecordValue(row, overrides)` — the one lexicon-shaped `community.lexicon.book.edition` value, plus the `identifiers`/`contributors` shaping | `record-detail.ts:68`, `xrpc-router.ts:386`, `jobs/isbn-backfill.ts:159`, `jobs/cover-backfill.ts:135`, `jobs/description-backfill.ts:167` — the three job-side copies are field-for-field identical to each other and differ only in which field is overridden |
| `data/edition-detail.ts` | `getEdition(uri)` / `getEditions(uris)` row reads, `editionBookView(row)` | `select().from(editions).where(eq(uri)).limit(1)` at `record-detail.ts:44`, `xrpc-router.ts:380`, `xrpc-router.ts:833`, `shelving/hydrate.ts:81`, `jobs/isbn-backfill.ts:217`, `jobs/cover-backfill.ts:155`, `jobs/description-backfill.ts:186` |
| `data/bookhive-catalog.ts` | `catalogBookToEditionItem` + the field mapping currently in `bookhive/catalog.ts`; the ingest script and any page that needs BookHive provenance read through it | `bookhive/catalog.ts` is imported by the ingest path only, but it hardcodes the mapping that `getBook`-style queries would need to re-derive |
| `data/contributor-views.ts` | `buildBookContributorViews` (already exists as `lib/server/book-contributor-view.ts`) as the only contributor-name resolution | `book-contributor-view.ts:40` vs `xrpc-router.ts:386` vs `shelving/hydrate.ts:99` |

The concrete drift this prevents — two transports already disagree about the same edition:

- `xrpc-router.ts:386` (`com.atproto.repo.getRecord`) resolves contributor names through
  `buildBookContributorViews` and emits `{bookUri, contributor, role}`.
- `shelving/hydrate.ts:99` (`makeBookView`) emits `contributor: {name: '', uri}` — every
  book view returned by `getReviewsByBook` (`xrpc-router.ts:1411`), `getShelf`/
  `listShelvesWithBooks` (`xrpc-router.ts:1426`) and `getShelvingOfBook` (`xrpc-router.ts:1435`) carries
  an empty contributor name, while the record endpoint on the same URI carries the real one.

The second consequence is the one BookHive's document warns about literally: `editionValueForCid`
carries the comment "so the CID matches what the API serves". Three copies of that field list mean
a field added to `editions` (say `pages`, which the lexicon already has — see
[bookhive-import.md](bookhive-import.md)) updates the CID in one job and leaves
`com.atproto.repo.getRecord` serving a different one.

## Suggested order of work

1. `data/edition-record.ts` — mechanical, no behaviour change, and it is the copy that silently
   changes CIDs when it drifts. Migrate the 5 record-value sites first.
2. `data/edition-detail.ts` — folds the 7 row reads; fixes `makeBookView`'s empty contributor
   names as part of the move.
3. Move SQL out of `src/routes/xrpc/book-queries.ts` into `data/contributor-views.ts`, and stop
   page servers importing `xrpc-router` (export `searchService` and `log` from their own modules).
4. `lib/server/cache-headers.ts` — one rule for public reads, applied in `hooks.server.ts` and
   the XRPC JSON responses.

Steps 1–2 are refactors with tests already in place (`record-detail.test.ts`,
`book-contributor-view.test.ts`, `shelving/hydrate.test.ts`); step 3 changes import paths only.
