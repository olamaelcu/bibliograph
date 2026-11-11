# books-wg lexicons (vendored) and how they are served

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
| `lexicons/resolveEditions.json` | procedure (read-only) | served by the edge; see below |
| `lexicons/searchEditions.json` | procedure (read-only) | served by the edge; see below |

Both new methods are `type: procedure` with a JSON body and `application/json` output, but they are
**read-only**: `resolveEditions` has no declared errors, `searchEditions` declares
`InvalidQuery` for a blank cross-field input. Neither takes an attestation or writes a record.

## They cannot live in HappyView

HappyView's procedure path is the write path: every uploaded procedure requires a DPoP session
before the script runs (`401 XRPC procedures require DPoP authentication`), and handlers receive
`caller_did` to proxy the write to that caller's PDS (`docs/happyview.md`,
`happyview/scripts/xrpc/procedure/*.lua`). Neither property fits anonymous catalog discovery:

- clients resolving an edition have no session, and the method must not require one;
- there is nothing to write to the caller's PDS — the result is catalog data;
- HappyView Lua scripts are the query surface (`type: query`, `GET`), and uploading a procedure as
  a query would contradict the published lexicon.

## Where the code lives

- **Dispatch**: `packages/web/src/routes/xrpc/[...method]/+server.ts` answers the two NSIDs before
  `forward()`, so the passthrough proxy stays the default. `GET` on either NSID is
  `405 MethodNotAllowed`.
- **Catalog layer**: `packages/web/src/lib/server/catalog/{db,editions}.ts`. `db.ts` owns one pooled
  `pg` client (`DATABASE_URL`, cached on `globalThis` across dev reloads); `editions.ts` maps rows
  from `editions`, `edition_identifiers`, `edition_contributors` and `edition_publishers` to
  `community.lexicon.media.book.defs#editionView`, including the `series` object and contributor
  `role`.
- **Configuration**: `DATABASE_URL` is declared in `packages/web/src/env.ts`; the deployment
  template is `packaging/web/web.env` (unset → the two methods answer `503 ServiceUnavailable`
  instead of taking the edge down).
- **Public catalogue**: `packages/web/scripts/generate-catalog.mjs` now reads both
  `happyview/lexicons` and the vendored directory (de-duplicated by NSID), so the generated page
  lists the two procedures and the `edition` record type.

## Edition identifiers point back at the record

`editionView` has no `uri` field, so every item returned by `resolveEditions` / `searchEditions`
carries the edition's atproto URI as an identifier:

```json
{ "issuer": "atproto", "value": "at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.media.book/gb.efdyneVzATwC" }
```

It is first in `identifiers`, exactly once, and stored identifiers follow unchanged (`issuer` and
`value` only — no bookkeeping columns leak). Clients derive display routes from it, e.g.
`/book/did:web:biblio.livtet.olamaelcu.net/gb.efdyneVzATwC`. `atproto` is the issuer token for the
protocol namespace; identifier comparison stays exact and no normalization is applied on read.

## `resolveEditions`

- `identifiers[]` is required; each entry needs a non-empty `issuer` and `value`. Duplicate pairs are
  collapsed, and at most 100 identifiers are accepted per request (`400 InvalidRequest` beyond it).
- An edition qualifies when **any** pair matches exactly (`edition_identifiers` is the identity bag:
  the lexicon compares `issuer`/`value` exactly, so the handler does not trim, lower-case or
  ISBN-normalize).
- Results are ordered `editions.indexed_at ASC, edition uri ASC`, `LIMIT limit + 1` decides
  `hasMore`, and `offset` pages. `total` is counted on the first page only.
- Returns `editionResults { items, hasMore, total }`; no match is an empty page, not `404`.

## `searchEditions`

- At least one non-blank `q`, `title`, `author`, or a non-empty `identifiers` array is required;
  otherwise `400 InvalidQuery` (the only declared error).
- The catalog pass ORs the supplied hints: exact identifier pairs, `title ILIKE`, contributor name
  for `author`; `q` matches title, description, contributor names and identifier values.
- Local ranking (provider-defined per the lexicon): identifier exact > title > author > broad text,
  then `indexed_at DESC, uri ASC`, with `LIMIT limit + 1` and `offset`.

## Not implemented yet: provider resolution

Network providers must not run in the request path (quota, latency, retries). The remaining work:

- add a job enqueue path from the edge for missing identifiers and provider searches, using the
  worker's job table and a stable `jobKey` so concurrent identical calls collapse;
- a worker task with the old service's order and cost model — Google Books first; ISBNdb only when
  Google Books is empty and the input is an ISBN; Goodreads as gap-fill with title de-duplication;
  Wikidata for enrichment;
- ingest via the identifier bag (`editions_next_tid()` for new rows), which triggers `pds_outbox`;
  `pds-publish` publishes the editions;
- a resolution-miss row with a TTL so repeated calls cannot hot-loop the queue. Until the working
  group adds a `pending`/`degraded` field, resolution is eventual: the client re-calls and gets the
  edition once the worker has ingested it.

## Publication and schema registration

- The catalog publisher must publish `community.lexicon.media.book.edition` records against the
  vendored `edition.json`. Our tree lost that lexicon with `packages/bibliograph-service`, so the
  submodule is now the only copy; reference it from the publication pipeline instead of re-adding a
  hand-maintained duplicate.
- Publish the two procedure lexicons and the defs/review lexicons as `com.atproto.lexicon.schema`
  records from the same vendored source, so `com.atproto.lexicon.resolveLexicon` answers for them.

## Tests and contract gaps

- Verified against fixture rows (since removed): required `editionView` fields, identifier shape,
  exactly one `atproto` identifier equal to the record URI, pagination/`hasMore`/`total`, exact and
  identifier-bag matching, `InvalidQuery`, `InvalidRequest`, `405` on `GET`, and the derived
  `/book/<did>/<rkey>` path.
- Contract tests should validate responses against the vendored schemas; `editionResults` requires
  `items` and `hasMore`, `total` is optional. CI must initialise the submodule and fail if the pin is
  missing.
- Open items to raise upstream: `editionResults` has no `pending`/`degraded` field for asynchronous
  resolution; array bounds use `minLength` instead of `minItems`; `editionView` carries no CID, while
  writes such as `shelf.addItem` need `{ uri, cid }` strongRefs, so a resolving client still has to
  fetch the record for the CID.
