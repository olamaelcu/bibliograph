# Architecture: two planes

Bibliograph is an AppView with a deliberately narrow seam:

- **Catalog/authoring plane (TypeScript).** Catalog tables are the mutable source
  of truth. Provider clients, enrichment, edition publication, the labeler, the
  feed generator, image routes and the public `/xrpc` gateway run here.
- **Activity plane (HappyView).** Jetstream + backfill index activity
  collections into `happyview_records`; Lua query scripts serve every activity
  query from that index.

One Postgres database holds both planes, in two schemas: `public` for the
catalog, `happyview` for HappyView's tables (its `labels` table collides with the
labeler's otherwise). Activity scripts join `appview_book_lua`, a text projection
of `appview_book` over the catalog tables, because HappyView's `db.raw` cannot
decode jsonb or timestamptz columns. No other catalog coupling exists at read
time. Catalog editions are published to the publisher PDS by an outbox
worker; activity records stay in each reader's own PDS.

## Catalog identity

Editions are the record type. Contributors and publishers are entities linked
through `edition_contributors` / `edition_publishers`, and identifiers live in
`edition_identifiers` as exact `(issuer, value)` pairs. The inline
contributor/publisher/identifier arrays exist only in two places:

- `editionRecordValue` when publishing `community.lexicon.media.book.edition`;
- `appview_book`, the read model HappyView joins against.

That keeps a contributor rename or merge to one row instead of every edition
that credits it.

`editions.rkey` is minted by `editions_next_tid()`. Identity lookup is the
identifier bag: an ingest that finds a stored pair updates that edition in place,
otherwise a fresh TID is minted.

## Publication

Triggers on `editions` and its child tables write `pds_outbox` rows. The
`pds-publish` graphile task drains them into the publisher PDS with
`com.atproto.repo.applyWrites`; `pds_cids` records the last published CID so the
worker chooses create/update without a read. Only editions are published — there
are no work, contributor or publisher records.

The public `/xrpc` gateway proxies `com.atproto.{repo,sync,identity}` and
`com.atproto.server.describeServer` to the PDS, serves catalog/label/feed
endpoints at the edge, and forwards everything else to HappyView.

## Activity

Indexed collections: `net.olamaelcu.livtet.biblio.{bookShelving,shelf,shelfItem,follow,readingGoal}`,
`net.olamaelcu.livtet.actor.profile` and `community.lexicon.media.book.review`.
Query scripts lived in the deleted package's `happyview/scripts/`; uploads now
go through HappyView's admin API (see `docs/happyview.md`).

No request path reads a user's PDS or a backlink service. A record missing from
the index is reported missing and repaired by backfill/reconcile, not by an
inline fallback.

## Authentication

- `X-Client-Key` identifies the calling application and is the rate-limit
  bucket. It is not user authentication.
- Personalized feed skeletons authenticate with an atproto service JWT
  (`lxm = com.atproto.feed.getFeedSkeleton`).
- The admin UI is gated on `ADMIN_TOKEN`; there is no end-user login and no
  AppView write procedure.
