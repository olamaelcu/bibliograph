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
| `lexicons/defs.json` (`community.lexicon.media.book.defs`) | defs | upstream copy; our `happyview/lexicons/community/lexicon/media/book/defs.json` is identical to it at this pin |
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
- **Worker**: `packages/worker` (`index.js`, `lib/providers`, `lib/ingest.js`, `lib/tasks.js`,
  `lib/publish.js`) consumes `catalog.resolve` / `catalog.search` / `pds-publish`. The Debian unit
  is `packaging/worker/bibliograph-worker.service`, running
  `/usr/bin/node /usr/lib/bibliograph-worker/index.js` with `/etc/bibliograph/worker.env`.
- **Public catalogue**: `packages/web/scripts/generate-catalog.mjs` now reads both
  `happyview/lexicons` and the vendored directory (de-duplicated by NSID), so the generated page
  lists the two procedures and the `edition` record type.

## Edition identifiers point back at the record

`editionView` has no `uri` field, so every item returned by `resolveEditions` / `searchEditions`
carries the edition's atproto URI as an identifier:

```json
{ "issuer": "atproto", "value": "at://did:plc:e2x3ihw2ntxt7pcgzmtu3abi/community.lexicon.media.book.edition/3n22xzi7cyz23" }
```

It is first in `identifiers`, exactly once, and stored identifiers follow unchanged (`issuer` and
`value` only — no bookkeeping columns leak). Clients derive display routes from it, e.g.
`/book/did:plc:e2x3ihw2ntxt7pcgzmtu3abi/3n22xzi7cyz23`. The record key is always a TID minted by
`editions_next_tid()` (13 characters from atproto's base32-sortable alphabet), never a
provider-prefixed key. `atproto` is the issuer token for the
protocol namespace; identifier comparison stays exact and no normalization is applied on read.

## `resolveEditions`

- `identifiers[]` is required; each entry needs a non-empty `issuer` and `value`. Duplicate pairs are
  collapsed, and at most 100 identifiers are accepted per request (`400 InvalidRequest` beyond it).
- An edition qualifies when **any** pair matches exactly (`edition_identifiers` is the identity bag:
  the lexicon compares `issuer`/`value` exactly, so the handler does not trim, lower-case or
  ISBN-normalize).
- Results are ordered `editions.indexed_at ASC, edition uri ASC`, `LIMIT limit + 1` decides
  `hasMore`, and `offset` pages. `total` is counted on the first page only.
- Returns `editionResults { items, hasMore, total? }`; no match is an empty page, not `404`.
  Unmatched identifiers queue `catalog.resolve` work (deduplicated by a TTL mark), but the
  response has no field reporting it: a client learns of new editions only by re-calling.

## `searchEditions`

- At least one non-blank `q`, `title`, `author`, or a non-empty `identifiers` array is required;
  otherwise `400 InvalidQuery` (the only declared error).
- The catalog pass ORs the supplied hints: exact identifier pairs, `title ILIKE`, contributor name
  for `author`; `q` matches title, description, contributor names and identifier values.
- Local ranking (provider-defined per the lexicon): identifier exact > title > author > broad text,
  then `indexed_at DESC, uri ASC`, with `LIMIT limit + 1` and `offset`.
- An empty local result queues `catalog.search` work (a repeated query is deduplicated by its TTL
  mark); the response does not report that. Queued work does not mean the provider will find a
  match, and it is not a signal about worker liveness.

## Provider hydration (worker)

Network providers must not run in the request path (quota, latency, retries), so the edge only
queues work and `packages/worker` performs it:

- the edge enqueue path is `packages/web/src/lib/server/catalog/jobs.ts`: missing identifiers and
  empty searches queue via the worker's job table with a stable `job_key` and a TTL mark in
  `catalog_enqueue_marks`, so concurrent identical calls collapse;
- `catalog.resolve` / `catalog.search` (`lib/tasks.js`, `lib/providers`) try ISBNdb → Google Books
  → Goodreads and stop at the first provider that returns candidates: for an ISBN, ISBNdb by ISBN,
  then Google Books by ISBN, then Goodreads by identifier; for a text search, an ISBNdb search (by
  ISBN when the input carries one, otherwise by the query text), then Google Books, then Goodreads.
  A `googlebooks` or `goodreads` identifier resolves directly against its own provider only (no
  cross-provider cascade). Candidates from one provider are merged and de-duplicated. Without
  `ISBNDB_API_KEY` the chain starts at Google Books.
- each task ingests at most 50 candidates (`CANDIDATES_PER_TASK` in `lib/tasks.js`). Google Books
  search requests its API maximum of 40 results; ISBNdb search requests `pageSize=50` (the API
  default is 20, capped at 100), so a single provider call may return fewer than 50 and the cap is
  an upper bound, not a target;
- `catalog.isbn` backs `searchEditions` ISBN identifiers: it calls ISBNdb directly by ISBN, even
  when the local catalog already answered, and ingests up to 50 candidates. Without
  `ISBNDB_API_KEY` (so no ISBNdb provider) it logs a warning and falls back to the normal
  `catalog.resolve` provider chain; a configured ISBNdb that returns no record also falls back to
  that chain (ISBNdb is asked again there and answers from its cache), so hydration still happens
  either way and the direct-lookup contract is not silently skipped;
- `lib/ingest.js` ingests via the identifier bag, minting new rows under the publisher authority
  (`ATP_SERVICE_DID`, else `did:web:<ATP_SERVICE_HOST>`) with a TID rkey from
  `editions_next_tid()` and extending the identifier bag of an existing edition. The rkey is never
  derived from a provider id: a new identifier bag mints a new TID, while any stored identifier
  pair updates its edition in place. The edition trigger queues `pds_outbox`;
- `pds-publish` (`lib/publish.js`) drains `pds_outbox` with `com.atproto.repo.applyWrites` in
  batches; the worker schedules it every minute plus a boot drain, and one publisher runs at a
  time;
- the TTL mark keeps repeated requests from hot-looping. Resolution is still eventual: the client
  re-calls and gets the edition once the worker has ingested and published it. `editionResults`
  has no `pending`/`degraded` field (as upstream defines it), so the response cannot tell a client
  that work is outstanding; re-calling is the only way.

Honest limits:

- No provider was exercised live in this environment: Google Books and ISBNdb need API keys
  (`GOOGLE_BOOKS_API_KEY`, `ISBNDB_API_KEY`) and third-party consent, so tests use fixtures/fakes;
- Catalog hydration and outbox queueing work without publisher credentials, but live PDS
  publishing does not: the local dev PDS issues `did:plc` accounts and cannot host a `did:web`
  publisher, so set `ATP_SERVICE_DID` to the local account (it is also the edition URI authority).
  A provisioned publisher account must supply `PDS_URL`, the publisher DID (`PDS_ACCOUNT_DID`,
  or `ATP_SERVICE_DID` / `ATP_SERVICE_HOST`), and either `PDS_ACCOUNT_PASSWORD` (app password) or
  `PDS_ACCESS_TOKEN`; otherwise the worker logs `pds-publish is DISABLED` and rows stay queued in
  `pds_outbox` without being lost. Rows minted under a previous authority are not migrated or
  re-ingested: this deployment uses the `did:plc` publisher identity, so old `did:web` rows are
  intentionally dropped (a fresh database, or a cleared catalog and outbox). There is no seed or
  import step — the catalog is rebuilt organically by XRPC traffic and worker hydration;
- Wikidata enrichment is not part of the worker yet.

## Publication and schema registration

- The catalog publisher must publish `community.lexicon.media.book.edition` records against the
  vendored `edition.json`. Our tree lost that lexicon with `packages/bibliograph-service`, so the
  submodule is now the only copy; reference it from the publication pipeline instead of re-adding a
  hand-maintained duplicate.
- Publish the two procedure lexicons and the defs/review lexicons as `com.atproto.lexicon.schema`
  records from the same vendored source, so `com.atproto.lexicon.resolveLexicon` answers for them.
- The publisher identity is the configured `did:plc` account (`ATP_SERVICE_DID`; the
  `did:web:<ATP_SERVICE_HOST>` form is a local/test fallback). Publication requires that account to
  be provisioned on the PDS; the catalog itself is not seeded, imported or migrated from a previous
  publisher authority.

## Tests and contract gaps

- Verified against fixture rows (since removed): required `editionView` fields, identifier shape,
  exactly one `atproto` identifier equal to the record URI, pagination/`hasMore`/`total`, exact and
  identifier-bag matching, `InvalidQuery`, `InvalidRequest`, `405` on `GET`, and the derived
  `/book/<did>/<rkey>` path.
- Contract tests should validate responses against the vendored schemas; `editionResults` requires
  `items` and `hasMore`, `total` is optional. CI must initialise the submodule and fail if the pin is
  missing.
- Open items to raise upstream: an asynchronous-hydration signal for `editionResults`; array bounds
  use `minLength` instead of `minItems`; `editionView` carries no CID, while
  writes such as `shelf.addItem` need `{ uri, cid }` strongRefs, so a resolving client still has to
  fetch the record for the CID.
