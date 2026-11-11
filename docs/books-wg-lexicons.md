# books-wg lexicons (vendored) and how to serve them

`vendor/books-wg-lexicons` is a submodule of the upstream working set for the book/bibliographic
lexicons:

- upstream: https://tangled.org/books-wg.tngl.sh/lexicons
- pinned commit: `3bcee8e344681fc5251abf43537d2c13ba85ff94` (`main`, 2026-11-11)
- declared in `.gitmodules`; CI, `mise` tasks and the Debian build must run
  `git submodule update --init --recursive` before anything reads it.

The submodule tracks the upstream, not the local clone used while reviewing it. Updating is
`git -C vendor/books-wg-lexicons fetch && git -C vendor/books-wg-lexicons checkout <sha>`, then
commit the gitlink.

## What it provides

| File | Type | Status in this repo |
| --- | --- | --- |
| `lexicons/defs.json` (`community.lexicon.media.book.defs`) | defs | identical to `happyview/lexicons/community/lexicon/media/book/defs.json` at this pin |
| `lexicons/review.json` (`community.lexicon.media.book.review`) | record | identical to our deployed copy |
| `lexicons/edition.json` (`community.lexicon.media.book.edition`) | record | **not present** in `happyview/lexicons`; the catalog publisher owns this record type |
| `lexicons/resolveEditions.json` | procedure (read-only) | no handler anywhere today |
| `lexicons/searchEditions.json` | procedure (read-only) | no handler anywhere today |

Both new methods are `type: procedure` with a JSON body and `application/json` output, but they are
**read-only**: `resolveEditions` has no declared errors, `searchEditions` declares
`InvalidQuery` for a blank cross-field input. Neither takes an attestation or writes a record.

## They cannot live in HappyView

HappyView's procedure path is the write path: every uploaded procedure requires a DPoP session
before the script runs (`401 XRPC procedures require DPoP authentication`), and handlers receive
`caller_did` to proxy the write to that caller's PDS (`docs/happyview.md`,
`happyview/scripts/xrpc/procedure/*.lua`). Neither property fits anonymous catalog discovery:

- clients resolving an edition have no session, and the method must not require one;
- there is nothing to write to the caller's PDS — the result is provider data;
- the output is `editionResults`; HappyView Lua scripts are the query surface (`type: query`,
  `GET`), and uploading a procedure as a query would contradict the published lexicon.

So both methods belong to the **catalog plane at the edge**, which is where `docs/architecture.md`
already puts catalog, provider and `/xrpc` gateway work.

## Where the code goes

`packages/web` currently proxies every `/xrpc/*` call to HappyView
(`src/routes/xrpc/[...method]/+server.ts` → `$lib/server/happyview.ts`) and has no database client.
Implementing the two methods needs:

1. **A catalog access module** in `packages/web/src/lib/server/catalog/` with a pooled Postgres
   client (`DATABASE_URL`, least-privileged catalog role) and an `editionView` mapper over
   `editions`, `edition_identifiers`, `edition_contributors` and `edition_publishers`. The mapper
   must emit exactly `community.lexicon.media.book.defs#editionView`, including the vendored
   `series` object and contributor `role`.
2. **Dispatch before the proxy**: in the existing `[...method]` handler, switch on the NSID for
   `community.lexicon.media.book.resolveEditions` and `community.lexicon.media.book.searchEditions`
   before calling `forward()`. Keeping one entry point avoids relying on route precedence and keeps
   the passthrough proxy as the default.
3. **A job enqueue path** for provider work. Use the worker's own job table
   (`graphile_worker.add_job` or equivalent) with a stable `jobKey`, so concurrent identical
   requests collapse into one job.

## `resolveEditions`

- Validate `identifiers`: at least one entry, each with non-empty `issuer` and `value`; normalize
  (trim, lower-case issuer, ISBN-10 → ISBN-13) and de-duplicate. The lexicon spells array bounds as
  `minLength`; enforce a length check in code and treat it as `minItems`.
- Look up exact equality on **any** supplied pair (`edition_identifiers` is the identity bag:
  `(issuer, value)` → edition). Order deterministically (`editions.indexed_at ASC, edition uri ASC`
  as the old method did), `LIMIT limit + 1`, and page with `offset`.
- Return `editionResults { items, hasMore, total }`; no match is an empty page, not `404`. Count
  `total` on the first page only.
- For every identifier that matched nothing, enqueue a resolution job and return immediately.
  Store a resolution-miss row with a TTL so repeated calls cannot hot-loop the queue.
- The response has no field for in-flight work. Until the working group adds one, document that
  resolution is eventual: the client re-calls and gets the edition once the worker has ingested it.

## `searchEditions`

- Validate the cross-field rule: at least one non-blank `q`, `title`, `author`, or non-empty
  `identifiers`; otherwise `400 InvalidQuery` (the only declared error).
- Local pass over the catalog: `title ILIKE`, contributor-name match for `author`, exact identifier
  pairs, deterministic relevance order, `LIMIT limit + 1`. Return what exists now.
- Enqueue a provider search job keyed by a hash of the normalized query. Fuzzy matching and ranking
  are provider-defined per the lexicon, so the local ranking must stay simple and documented
  (identifier exact > title phrase > title > author).
- Provider fan-out happens in the worker with the old service's order and cost model: Google Books
  first; ISBNdb only when Google Books is empty and the input is an ISBN; Goodreads as gap-fill with
  title de-duplication; Wikidata for enrichment. Remote hits are ingested into the catalog, which
  writes `pds_outbox`; `pds-publish` publishes the editions.

## Publication and schema registration

- The catalog publisher must publish `community.lexicon.media.book.edition` records against the
  vendored `edition.json`. Our tree lost that lexicon with `packages/bibliograph-service`, so the
  submodule is now the only copy; copy or reference it from the publication pipeline instead of
  re-adding a hand-maintained duplicate.
- Publish the two procedure lexicons and the defs/review lexicons as `com.atproto.lexicon.schema`
  records from the same vendored source, so `com.atproto.lexicon.resolveLexicon` answers for them.
- Extend `packages/web/scripts/generate-catalog.mjs` to read both `happyview/lexicons` and the
  vendored directory (edge-served methods included), or keep the page limited to HappyView's
  surface and document the omission. The current generator reads only `happyview/lexicons`.

## Tests and contract gaps

- Contract tests validate `resolveEditions` / `searchEditions` responses against the vendored
  schemas; `editionResults` requires `items` and `hasMore`, `total` is optional.
- CI must initialise the submodule and fail if the pinned gitlink is missing.
- Open items to raise upstream: `editionResults` has no `pending`/`degraded` field for asynchronous
  resolution; array bounds use `minLength` instead of `minItems`; `editionView` carries no CID, while
  writes such as `shelf.addItem` need `{ uri, cid }` strongRefs, so a resolving client still has to
  fetch the record for the CID.
