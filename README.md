# Bibliograph

An [ATProto AppView][1] for books. Bibliograph owns two things the network cannot:

- **book identity** — canonical catalog editions, identifier bags, inline
  contributors/publishers, provider enrichment, and publication of each edition
  to a real PDS;
- **cross-user reading activity views** — shelves, shelving, shelf items,
  reviews, follows and reading goals, indexed from readers' own PDSes.

It is the AppView [Livtet][] uses, and is published in the open for
interoperability.

The complete endpoint contract — the old surface, its history, and the target
surface — is in [`docs/xrpc.md`](docs/xrpc.md).

## Structure

| Plane | Runs | Owns |
| --- | --- | --- |
| Catalog (TypeScript, this repo) | SvelteKit edge + graphile worker | catalog tables, provider enrichment, PDS publisher, labeler, feed generator, image routes, `/xrpc` gateway |
| Activity (HappyView) | Debian package, loopback only | Jetstream/backfill index (`happyview_records`), activity query lexicons + Lua |
| PDS (rsky-pds) | Debian package | publisher repo, lexicons, catalog edition records |

One Postgres database serves both the catalog tables and HappyView's index.
Activity Lua reads a single `appview_book_lua` view (a text projection of
`appview_book`); no other catalog coupling exists
at read time.

## Contexts and records

Catalog records use the shared book namespace, imported from
[lexicon.community PR #18](https://tangled.org/lexicon.community/lexicons/pulls/18/latest)
(the books-wg working set with ONIX contributor roles):

- `community.lexicon.media.book.edition` — an edition, published by the
  publisher account. Contributors and one publisher are inlined on the wire but
  stored as entities linked by join tables.
- `community.lexicon.media.book.review` — a reader's review, written to their
  own PDS and indexed by HappyView.

Reading activity stays in each reader's PDS under
`net.olamaelcu.livtet.biblio.*` (`shelf`, `shelfItem`, `bookShelving`, `follow`,
`readingGoal`) and `net.olamaelcu.livtet.actor.profile`.

No AppView write procedure exists: clients write their own records, and the
AppView only publishes catalog editions.

## Publication

Triggers on the catalog tables write `pds_outbox`. The `pds-publish` worker
drains it into the publisher PDS with `com.atproto.repo.applyWrites`, using the
account session from `PDS_ACCOUNT_DID` / `PDS_ACCOUNT_PASSWORD`; `pds_cids`
remembers the last published CID so create/update is chosen without a read.

`/xrpc/com.atproto.{repo,sync,identity}.*` and
`/xrpc/com.atproto.server.describeServer` are proxied to that PDS. Lexicons are
published as `com.atproto.lexicon.schema` records with
`pnpm --filter bibliograph-service pds:publish-lexicons`.

## Providers

Catalog ingestion and enrichment use Google Books, ISBNdb and Goodreads.
Google Books and ISBNdb answers are cached in Postgres (hits and negative
answers), because the quota is charged against one key shared by the web and
worker processes.

```bash
mise run backfill:covers
mise run backfill:descriptions
mise run backfill:formats
mise run backfill:isbns
```

The admin import UI lives at `/admin/import/isbn` and is gated on `ADMIN_TOKEN`.

## Feeds

`com.atproto.feed.describeFeedGenerator` advertises four feeds:

- `public` — newest reviews and shelving across the index;
- `following` — records by accounts the viewer follows, excluding the viewer;
- `extended` — the follow graph two hops deep, capped at 500 DIDs;
- `dynamic` — the viewer plus the accounts they follow (the per-viewer ladder).

`public` needs no token. The other three authenticate with an atproto service
JWT (`lxm = com.atproto.feed.getFeedSkeleton`) whose signature is verified
against the issuer DID document's `#atproto` Multikey, with `aud` exactly
`<FEED_GENERATOR_DID>#atproto_feed`. Both `FEED_GENERATOR_DID` and `PLC_URL`
are required configuration with no code default: a deployment must set them
explicitly. Without `FEED_GENERATOR_DID` both feed methods answer
`503 ServiceUnavailable`; without `PLC_URL` the personalized feeds
(`following`, `extended`, `dynamic`) answer `503` while `public` keeps working.
`did:plc` signers resolve through `PLC_URL`. There is no browser session and no
end-user OAuth, and no `recommendations` feed.

## Development

```bash
mise run catalog-schema # create/upgrade the catalog schema (idempotent, no data loss)
mise run hv-deploy      # upload lexicons/scripts, apply activity indexes
mise run hv-extract     # extract the pinned HappyView binary into .cache
mise run hv-dev-auth    # seed local HappyView admin/client credentials
mise run dev            # HappyView + worker + web
```

A fresh database needs no migration or seed: `mise run catalog-schema` creates
the catalog tables and read views, and the catalog grows from XRPC traffic. The
old combined package and its drizzle migrator are retired. See
[`docs/operations/fresh-database.md`](docs/operations/fresh-database.md).

Identity resolution uses the public PLC; the HappyView dashboard signs in with a
real ATProto handle. See [`docs/dev-environment.md`](docs/dev-environment.md).
The web process serves `/xrpc/*` in both dev and production; HappyView is an
internal upstream at `HAPPYVIEW_URL`. `.env.example` is the canonical
configuration schema.

Static checks:

```bash
pnpm --filter bibliograph-service check
pnpm --filter bibliograph-service lint
pnpm --filter bibliograph-service build
```

## Labeler

`net.olamaelcu.livtet.biblio` remains the label authority for librarian and
administrator labels. Sign labels with `ATP_LABEL_SIGNING_KEY` and publish the
public half under `#atproto_label` in the DID document. The admin UI issues and
revokes labels; `pnpm --filter bibliograph-service labels:seniority` grants
`senior-librarian` after the configured tenure.

[1]: https://atproto.com/guides/glossary#app-view
[Livtet]: https://livtet.olamaelcu.net
