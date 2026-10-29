# search-contributors documentation

## XRPC Query Schema

**Endpoint**: `POST /xrpc/community.lexicon.book.searchContributors`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | No | Free-form text query (max 1024 chars) |
| `id` | array of strings | No | Identifiers to match (URI or URN form) |
| `limit` | integer | No | Results count (1-100, default 20) |
| `cursor` | string | No | Pagination cursor |

### Output Schema

```json
{
  "items": [
    {
      "$type": "community.lexicon.book.contributor",
      "uri": "string (at:// URI)",
      "name": "string (minLength: 1)",
      "aliases": ["string"],
      "identifiers": [
        {
          "uri": "string",
          "resource": "string"
        }
      ],
      "createdAt": "string (datetime)"
    }
  ],
  "cursor": "string",
  "total": "integer"
}
```

### Live Example Response

```json
{
  "items": [
    {
      "$type": "community.lexicon.book.contributor",
      "uri": "at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A14286376A",
      "name": "Trivium Test Trivium Test Prep",
      "aliases": [],
      "identifiers": [
        {
          "uri": "https://openlibrary.org/authors/OL14286376A",
          "resource": "openlibrary"
        }
      ],
      "createdAt": "2026-10-25T00:13:18.838Z"
    }
  ],
  "total": 1682
}
```

## Contributor Record Schema

The contributor record requires:
- `name` (string, minLength: 1, maxLength: 256)
- `createdAt` (datetime)
- `uri` (string, format: uri)

## Where Book Search Returns Contributors

Based on the codebase:
1. **`searchEditions`** - may include contributor URIs in edition records
2. **`searchWork`** - may include contributor URIs in work records
3. **`searchContributors`** - dedicated endpoint for finding contributors

## Empty-name invariant

`community.lexicon.book.contributor` declares `name` with `minLength: 1`, and the
`contributors.name` column is `NOT NULL` — but `NOT NULL` still admits `''` and
whitespace-only values. That gap was reachable: `searchContributors` with neither
`q` nor `id` omitted every filter, so it scanned and paged the whole table
including any empty-name row.

Closed at four layers, all keyed off one predicate,
`validContributorName(name)` in
`src/lib/server/search/contributor-name.ts`:

| Layer | Location | Effect |
|---|---|---|
| Database | `contributors_name_non_empty` CHECK (`btrim(name) <> ''`), migration `0010` | Empty/whitespace names cannot be written |
| SQL read | `PostgresSource.searchContributors` | `btrim(name) <> ''` predicate, so `items` and `total` agree |
| Service | `SearchService.searchContributors` | Drops invalid names from local **and** remote results before merge and before `syncIngestContributors` |
| XRPC handler | `routes/xrpc/book-queries.ts` | Final filter + `invalid_contributor_responses_total{nsid=…searchContributors,reason=empty_name}` |

Live data is already clean — 2639 rows locally and 410 sampled over the wire had
zero empty names — so this is invariant enforcement, not a data repair.

## Verification

Live production (GET, not POST — the endpoint rejects POST with
`invalid http method (expected GET)`):

```bash
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/community.lexicon.book.searchContributors?q=test&limit=1'
```

- `total` 1682, every `items[].name` non-empty, zero `"name":""` occurrences.
- Six unfiltered pages (510 records) also returned zero empty names.

Deployed `bibliograph 0.1.1` to `veve@lescayes` (`mise run deploy-deb`).
`bibliograph-migrate` applied migration #10 (`applied=0 skipped=10` on the
subsequent restart), the constraint is live, and `GET …?limit=100` with no `q`
now reports `total` **420** — the exact table row count — where the previous
build reported `0`, because it only computed `total` when a filter existed. That
number is the observable proof the SQL predicate is in the counted set.

Local end-to-end through the real SvelteKit route with a deliberately injected
empty-name row (`''`, newest `indexed_at` so it sorts first):

| Query | items | total | empty names | probe leaked |
|---|---|---|---|---|
| `limit=100`, no `q` | 100 | 2639 | 0 | no |
| same, table held 2640 rows incl. 1 empty | 100 | 2639 | 0 | no |

`total` stayed 2639 while the table held 2640 rows, confirming the predicate is
part of the counted set rather than a post-count filter. The injected row was
removed and the constraint restored afterwards.

Direct check that the constraint bites:

```sql
-- both rejected with 23514 contributors_name_non_empty
INSERT INTO contributors (uri,cid,did,rkey,name,created_at)
  VALUES ('at://probe/c/empty','bafy','did:web:probe','empty','',now());
INSERT INTO contributors (uri,cid,did,rkey,name,created_at)
  VALUES ('at://probe/c/ws','bafy','did:web:probe','ws','   ',now());
```

## Worktree comparison (`backfill-edition-contributors`)

`.worktrees/backfill-edition-contributors/` is an **unmerged feature branch**,
not a data source: it has no `data/` directory, and `d3c6d31`, `3829212`,
`6b12459` are all absent from `main`. Its 13 commits add `coverImageUrl` on
contributors (lexicon, `cover_image_url` column, OL/Wikipedia image lookups) plus
`backfill-contributors` / `backfill:reconcile-contributors` CLIs.

The lexicons have **diverged**, so neither side is a superset:

| File | Worktree | Main |
|---|---|---|
| `book/contributor.json` | has `coverImageUrl`, no `uri` | has `uri` (required), no `coverImageUrl` |
| `book/edition.json`, `book/work.json`, `book/search*.json` | older | newer |
| `net/olamaelcu/livtet/biblio/defs.json` | older | newer |
| `book/publisher.json`, `editionWorkLink.json`, `getEditionsByContributor.json`, `getReviewsByBook.json` | absent | present |

No contributor-edition link data exists in the worktree, so there was nothing to
backfill: `main` already ships `scripts/backfill-edition-contributors.ts`
(re-enqueues editions whose `contributors` is `[]` so the OL/GB/ISBNdb resolvers
repopulate them). Dry run is clean and exits 0:

```bash
pnpm backfill:edition-contributors -- --dry --limit=5
# {"stage":"backfill-edition-contributors:summary","scanned":5,"enqueued":0,"skipped":5,"failed":0}
```

The worktree was left untouched.

## Files Referenced

1. `packages/bibliograph-service/lexicons/community/lexicon/book/searchContributors.json` — Lexicon definition (unchanged)
2. `packages/bibliograph-service/lexicons/community/lexicon/book/contributor.json` — Lexicon definition (unchanged)
3. `packages/bibliograph-service/src/routes/xrpc/book-queries.ts` — `searchContributors` handler
4. `packages/bibliograph-service/src/lib/server/search/service.ts` — service implementation
5. `packages/bibliograph-service/src/lib/server/search/contributor-name.ts` — `validContributorName`
6. `packages/bibliograph-service/src/lib/server/search/postgres-source.ts` — SQL predicate
7. `packages/bibliograph-service/drizzle/0010_contributor_name_nonempty.sql` — CHECK constraint