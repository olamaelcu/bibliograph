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
Activity Lua reads a single `appview_book` view; no other catalog coupling exists
at read time.

## Contexts and records

Catalog records use the books-wg namespace:

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
- `following` — activity by accounts the viewer follows;
- `extended` — two-hop follow graph;
- `dynamic` — same graph, service-JWT required.

Personalized feeds authenticate with an atproto service JWT
(`lxm = com.atproto.feed.getFeedSkeleton`). There is no browser session and no
end-user OAuth.

## Development

```bash
mise run db-migrate     # apply drizzle migrations
mise run hv-deploy      # upload lexicons/scripts, apply activity indexes
mise run stack          # Postgres + mock PLC + disposable local PDS
mise run hv-extract     # extract the pinned HappyView binary into .cache
mise run hv-dev-auth    # seed local HappyView admin/client credentials
mise run dev-seed       # create reader.test and write a shelf (no network account)
mise run dev            # HappyView + worker + web
```

`PLC_DIRECTORY_URL` points `did:plc` resolution at the mock PLC; see
[`docs/dev-environment.md`](docs/dev-environment.md). The web process serves `/xrpc/*` in both dev and production; HappyView is an
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
