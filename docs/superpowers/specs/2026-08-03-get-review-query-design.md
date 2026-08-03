# Design: `getReview` XRPC query

Date: 2026-08-03

## Summary

Add a `community.lexicon.book.getReview` XRPC query that fetches a single review.
The existing `getReviews` query returns paginated reviews for a book; there is no
single-review fetch. `getReview` fills that gap, mirroring the existing
`getBook` / `getShelf` single-fetch pattern.

## Identity

`getReview` supports two ways to identify the review:

- `uri` — a review at-uri, e.g. `at://did:plc:r/review/1`
- `did` + `bookUri` — the review a specific user wrote for a specific book

Precedence: if `uri` is provided it wins, even if `did` / `bookUri` are also
present. If neither `uri` nor the full `did` + `bookUri` pair is provided,
return 400 `InvalidRequest`.

## Lexicon

New file: `lexicons/community/lexicon/book/getReview.json`

```json
{
  "lexicon": 1,
  "id": "community.lexicon.book.getReview",
  "defs": {
    "main": {
      "type": "query",
      "parameters": {
        "type": "params",
        "properties": {
          "uri": { "type": "string", "format": "at-uri" },
          "did": { "type": "string", "format": "did" },
          "bookUri": { "type": "string", "format": "at-uri" }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["uri", "did", "record"],
          "properties": {
            "uri": { "type": "string", "format": "at-uri" },
            "did": { "type": "string", "format": "did" },
            "record": { "type": "object" },
            "cid": { "type": "string", "format": "cid" }
          }
        }
      }
    }
  }
}
```

The lexicon is auto-discovered by `serveLexicon` and `computeLexiconHashes` in
`src/lexicons/`, so no additional serving wiring is required.

## Handler

Add `getReview` to `src/api/get-book.ts`, following the `getBook` / `getShelf`
pattern.

```
getReview(c):
  1. Read query params: uri, did, bookUri
  2. Resolve identity:
     - uri present        → where = eq(reviews.uri, uri)
     - did + bookUri      → where = and(eq(reviews.did, did), eq(reviews.bookUri, bookUri))
     - otherwise          → 400 InvalidRequest
  3. db.query.reviews.findFirst({ where })
  4. no match             → 404 NotFound
  5. 200 { uri, did, record, cid: undefined }
```

`cid` is always `undefined`; the `reviews` table does not store a CID, matching
the behavior of `getBook` / `getReviews`.

Extract a `serializeReviewRecord(row)` helper from the inline object currently
built in `getReviews`, and use it in both `getReviews` and `getReview` so the
serialization is not duplicated. The helper emits:

```ts
{
  $type: 'community.lexicon.book.review',
  bookUri: row.bookUri,
  text: row.text,
  rating: row.rating,
  bookRef: { uri: row.bookUri, title: row.bookTitle, author: row.bookAuthor },
  createdAt: row.createdAt,
}
```

## Types

`src/types.ts`:

```ts
export interface GetReviewParams { uri?: string; did?: string; bookUri?: string; }
export interface GetReviewOutput { uri: string; did: string; record: unknown; cid?: string; }
```

## Routing and docs

- `src/app.ts`: import `getReview` alongside `getReviews`; register
  `app.get('/xrpc/community.lexicon.book.getReview', getReview)`; add
  `'getReview'` to the splash-page `queries` array.
- `README.md`: add a `getReview` row to the queries table ("Fetch a single
  review by AT-URI or user+book").

## Tests

New `describe('getReview')` block in `src/api/get-book.test.ts`, reusing
`seedBook`, `mockContext`, and `readJson` helpers:

- 400 when neither `uri` nor `did` + `bookUri` is provided
- 400 when only `did` is provided (missing `bookUri`) and vice versa
- 200 with the matching review when queried by `uri`
- 200 with the matching review when queried by `did` + `bookUri`
- 404 when no review matches
- `uri` takes precedence when both `uri` and `did` + `bookUri` are provided

## Out of scope

- No changes to `src/db/schema.ts` or `src/db/init.ts` — the `reviews` table
  already stores everything the query returns.
- No indexer changes — `community.lexicon.book.review` records are already
  indexed.
- No auth requirement — the query is public, like all other get* queries.
