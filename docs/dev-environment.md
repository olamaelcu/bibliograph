# Local development

The local stack is Postgres, a local PLC directory, an rsky PDS, Mailtrap Local,
Caddy, and HappyView. Identity resolution, dashboard sign-in and email all
resolve inside it: no `plc.directory`, no public relay, no account on the public
network, no outbound mail. `docs/happyview.md` has the reasoning behind each
setting; this page is the day-to-day loop.

## Bringing it up

```bash
docker compose up -d          # postgres, plc, pds, mailtrap, caddy, happyview, prometheus
mise run hv-account           # mint the provisional account on the local PDS
mise run hv-seed              # make it superuser, write the admin key + XRPC client
mise run hv-ca                # trust Caddy's CA in Chrome and Firefox
mise run hv-deploy            # upload the lexicons, query scripts and indexes
mise run hv-fixtures          # seed-01 … seed-08 plus activity, then verify
mise run hv-space             # permissioned-data space for the provisional account
mise run web                  # SvelteKit edge on http://127.0.0.1:5176
```

| Address | What |
| --- | --- |
| `http://127.0.0.1:3000` | HappyView dashboard and admin API |
| `https://pds.127-0-0-1.sslip.io` | the local PDS (HTTPS, Caddy's internal CA) |
| `https://<handle>.pds.127-0-0-1.sslip.io` | handle resolution: `/.well-known/atproto-did` and `/xrpc/*`; every other path 301s to the canonical PDS host |
| `http://127.0.0.1:2582` | the local PLC directory |
| `http://127.0.0.1:3550` | Mailtrap Local inbox and JSON API |
| `smtp://127.0.0.1:3535` | Mailtrap Local SMTP sink (the PDS uses `mailtrap:3535` inside the compose network) |
| `postgres://bibliograph:bibliograph@127.0.0.1:5432/bibliograph` | the catalog + `happyview` schema |

`mise run sql` opens psql against the same database.

## Local email

The PDS relays every notification it sends — password reset, email
verification, welcome — to the pinned Mailtrap Local container instead of
resolving recipient MX records. Nothing leaves the machine: the sandbox accepts
every sender and recipient, so fixture addresses such as
`seed-01@example.invalid` are fine. `docker-compose.yml` sets
`PDS_EMAIL_SMTP_URL=smtp://mailtrap:3535?ignoreTLS=true` plus
`PDS_EMAIL_FROM_ADDRESS`, a plain SMTP session with no credentials and no TLS.
Captured mail lives in the `mailtrapdata` volume across restarts.

Open `http://127.0.0.1:3550` for the inbox, or drive it over the JSON API. The
end-to-end check is the confirmation email. `requestEmailConfirmation` is scoped
to the caller's own account email, so it takes a session:

```bash
JWT=$(curl -sk -X POST https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"seed-01.pds.127-0-0-1.sslip.io","password":"Dev-account-password1"}' |
  jq -r .accessJwt)
curl -sk -X POST https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.server.requestEmailConfirmation \
  -H "authorization: Bearer $JWT"

curl -s 'http://127.0.0.1:3550/api/v1/messages' |
  jq '.messages[] | {id, from: .from.address, to: [.to[].address], subject}'
```

The code is in the message body, so refetch by `id` when you need it.
`requestPasswordReset` delivers for any account that has an email address, and
takes no session:

```bash
curl -sk -X POST https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.server.requestPasswordReset \
  -H 'content-type: application/json' \
  -d '{"email":"seed-01@example.invalid"}'
```

Fetch one message in full by the `id` above (its `text` carries the code):

```bash
curl -s http://127.0.0.1:3550/api/v1/message/<id> | jq '{subject, text}'
```

The inbox is unauthenticated and published on loopback only.
`curl -s -X DELETE http://127.0.0.1:3550/api/v1/messages -d '{"all":true}'`
wipes it when stale messages get in the way.

## Seeding test accounts and activity

`hv-account` mints one account (`alice`, the dashboard superuser) and leaves the
network at that. `hv-fixtures` seeds a small lived-in network: eight accounts,
their social records, and the Livtet records the activity queries read. It runs
the whole loop — accounts, records, backfill, verify — and fails unless the
seeded data comes back through `/xrpc`.

```bash
mise run hv-accounts          # create seed-01 … seed-08 on the PDS
mise run hv-fixtures          # records → backfill → verify
mise run hv-fixtures --reset  # delete the seed records, then seed again
```

Both commands are idempotent: a second run resolves the existing accounts and
updates the same record keys in place. `mise run hv-fixtures` implies
`hv-accounts`; run `hv-accounts` alone when you only want the identities.

### The catalog comes first

The catalog owns no data of its own: every edition arrives through the worker's
ingest from a provider. `hv-fixtures` reads catalog editions and joins them to
`pds_cids`, so the catalog seed runs first; against an empty catalog it stops
with `the catalog has no editions with identifiers, contributors, a cover and a
published CID`.

```bash
mise run catalog-schema       # containers, triggers, read views
mise run catalog-seed 10      # the ten most-downloaded Project Gutenberg ebooks
mise run hv-fixtures          # now there are editions to shelve
```

`catalog-seed` takes the count as its first argument (default 10) and reads
each ebook's Dublin Core record from gutenberg.org: title, creator agents,
language, summary, cover, and the publisher. Editions are ingested with the same
path hydration uses, so the catalog trigger queues their records and the
worker's `pds-publish` task publishes them within a minute — which is when
`pds_cids` gains the rows the fixtures need. It is idempotent: identity is the
ebook id (`gutenberg:<id>`), so a re-run updates the same editions in place
rather than minting new ones.

`GUTENBERG_BASE_URL` overrides the upstream. The provider tests inject their own
`fetch`, so the suite never reaches the network.

### Accounts

| | |
| --- | --- |
| handles | `seed-01.pds.127-0-0-1.sslip.io` … `seed-08.pds.127-0-0-1.sslip.io` |
| emails | `seed-01@example.invalid` … |
| password | `Dev-account-password1` (`HV_SEED_PASSWORD` overrides it) |
| count | 8 (`HV_SEED_ACCOUNTS` overrides it) |

The suffix is `PDS_SERVICE_HANDLE_DOMAINS` (`.pds.127-0-0-1.sslip.io`) in
`docker-compose.yml`: `createAccount` derives the handle domain from the PDS
hostname. Every account's DID is a real `did:plc` registered with the local PLC
by `POST /xrpc/com.atproto.server.createAccount`. Emails and handles are fixed
so re-runs converge on the same identities.

Both commands print the handle/DID table and the password at the end; copy a
handle from there. Livtet disables handle typeahead against this PLC
(`onPublicNetwork()` is false when `plcDirectoryBase()` is not
`https://plc.directory`), because the accounts live only in the local
directory.

Existence checks use `com.atproto.identity.resolveHandle` per fixed handle.
`com.atproto.admin.searchAccounts` answers HTTP Basic auth as
`admin:<PDS_ADMIN_PASS>` (the dev literal is in `docker-compose.yml`).

### Records

`scripts/dev-seed.py` writes the records through the PDS (a
`com.atproto.server.createSession` token per account, then batched
`com.atproto.repo.applyWrites`), and reads the catalog editions it references
from Postgres. Per account:

| Collection | Records |
| --- | --- |
| `net.olamaelcu.livtet.actor.profile` | 1 (`self`) |
| `app.bsky.actor.profile` | 1 (`self`) |
| `net.olamaelcu.livtet.biblio.shelf` | 5 (the four fixed shelves + one custom) |
| `net.olamaelcu.livtet.biblio.bookStatus` | 6 (edition rkeys from the fixture, TIDs from the app) |
| `net.olamaelcu.livtet.biblio.shelfItem` | 3 on the custom shelf |
| `community.lexicon.media.book.review` | 2 |
| `net.olamaelcu.livtet.biblio.follow` | 2 (TID rkeys) |
| `app.bsky.graph.follow` | 2 |
| `app.bsky.feed.post` | 3 |
| `app.bsky.feed.like` | 1 |
| `net.olamaelcu.livtet.biblio.readingGoal` | 1 (`current`) |

That is 26 records per account, 208 across the eight, plus a batched write for
each like once its target post's CID is known. Timestamps are fixed offsets
from a fixture epoch and rkeys are derived from the account index, so the same
fixture list always produces the same records. The editions come from
`public.appview_book_lua` joined to `public.pds_cids` — real catalog URIs with
a published CID, read with `psql` from `DATABASE_URL` — because the read views
drop activity whose edition is not in the catalog. Run `mise run
catalog-schema` first on a database without the read model.

Follow records use TID rkeys. Before writing them, the seed reconciles the
account's existing follows by subject: a subject-DID-rkey row or a duplicate
for the same target is deleted and the TID-keyed record written, so a rerun
converges on one record.

### Backfill is mandatory

Jetstream is closed (`ws://127.0.0.1:1`), so records written straight to the PDS
stay invisible to HappyView until a backfill indexes them. `hv-fixtures` calls
`POST /admin/backfill` with `{"did": …}` for every seed account — one job per
repo, because HappyView filters the walk to the collections it has lexicons for
— then polls `happyview.happyview_records` until the expected counts land.
Without that step every query answers empty.

The compose stack also runs `hv-backfill`, which repeats that call on a 15 s
cadence for any repo whose head moved, so records another client writes to the
PDS (the desktop, a manual `putRecord`) reach the index within a pass. It keeps
the last-seen head per repo in the `hv_backfill_state` volume; an idle pass is
one `listRepos`. The profile pages read through the app's five-minute actor
cache, so a change can take that long to paint.

### Reset

```bash
mise run hv-fixtures --reset
```

`--reset` deletes every record the fixtures wrote from each seed repo
(`applyWrites#delete`), deletes those DIDs' rows from
`happyview.happyview_records` and `happyview.happyview_record_refs`, then seeds
and backfills again. The accounts themselves are kept, so their DIDs stay
stable. Plain `hv-fixtures` never deletes anything.

## Spaces (permissioned data)

The PDS serves both halves of the permissioned-data proposal:
`com.atproto.simplespace.*` manages spaces anchored on the caller's DID, and
`com.atproto.space.*` is the host surface for their records. Space records live
under the space URI, not in the account's repo:

```text
at://did:plc:…/space/community.lexicon.test.space/main
at://did:plc:…/space/community.lexicon.test.space/main/did:plc:…/community.lexicon.test.post/smoke
```

```bash
mise run hv-space                                        # create, write, then read through a credential
mise run hv-space --type community.example.feed --skey main --handle alice.pds.127-0-0-1.sslip.io
```

`hv-space` runs `scripts/space-smoke.mjs` and is idempotent: the space
(`community.lexicon.test.space/main`, policy `public`, app access `open`) and
its `community.lexicon.test.post/smoke` record keep their URIs across runs. It
walks both access paths and fails on the first step that does not hold:

| Step | Call | Who |
| --- | --- | --- |
| manage | `simplespace.createSpace`, `listSpaces` | account session |
| write | `space.putRecord`, `listRecords`, `getLatestCommit` | account session (owner) |
| grant | `space.getDelegationToken` | account session covering `read` |
| exchange | `space.getSpaceCredential` | grant + DPoP issuance proof |
| read | `space.getSpace`, `space.listRecords` | `Authorization: DPoP <credential>` + `ath`-bound proof |

A space credential is a grant over every repo in the space, so the PDS accepts
it only under the `DPoP` scheme, next to a proof from the key it was minted
for; the delegation token it is exchanged from is single-use, and proofs carry
`htu` as origin + path with no query. `hv-space` asserts all three: a request
without a proof and a request with a proof from a fresh key are both refused.

Configuration: `PDS_URL` / `HV_CA` for the endpoint and Caddy's root
certificate, `--handle` / `--password` / `--type` / `--skey` for the account and
space. `PDS_SPACE_OPLOG_WINDOW` bounds how many repo ops each space keeps for
`space.listRepoOps` (default 10000 rows); the compose file leaves the default.

Space records stay outside the AppView: HappyView indexes the account repos it
walks through `com.atproto.sync.listRepos`, so a space write does not appear in
the dashboard or in any `/xrpc` query. A space anchored on a community DID
rather than an account is served by the workspace's `rsky-space-host` binary
(`SPACEHOST_*` configuration, one typed space per authority); the local stack
exercises the account-anchored `simplespace` path.

## Admin curation

`/admin` is an operator-only area reachable by URL only: provider search +
ingest, edition merge, and the dedicated edition, contributor and publisher
editors. Set the same `ADMIN_TOKEN` on the worker and the edge (`.env` or the
packaged `worker.env`/`web.env`):

```bash
export ADMIN_TOKEN=dev-admin-token
export WORKER_ADMIN_URL=http://127.0.0.1:9465
```

The worker serves a loopback admin API on `WORKER_ADMIN_HOST`:`WORKER_ADMIN_PORT`
(default `127.0.0.1:9465`). Without `ADMIN_TOKEN` the worker logs that the admin
API is disabled and the edge answers every `/admin` path with 404. Sign in at
`http://127.0.0.1:5176/admin/login`; the token becomes an HttpOnly,
SameSite=Strict cookie and is never rendered into the page.

Provider search uses exactly the selected provider (Google Books, ISBNdb or
Goodreads) and sends ISBN-shaped queries to that provider's ISBN lookup. Ingest
revalidates the candidate server-side in the worker before minting an edition.
The merge workbench unions identifiers, copies the chosen scalar fields from the
chosen records, applies the contributor/publisher source or union, deletes the
duplicate editions (their outbox rows become `delete`) and keeps the base URI.
Reader activity records that referenced deleted URIs stay untouched by design.

## Database schemas

HappyView creates unqualified tables, including a `labels` table, so it runs in
its own schema and those tables stay out of the catalog's `public` schema:

- App: `DATABASE_URL=…/bibliograph` (public only).
- HappyView: `HAPPYVIEW_DATABASE_URL=postgres://happyview_app:happyview@…/bibliograph`.

`happyview_app` is a login role whose default `search_path` is
`happyview,public`; sqlx ignores `?options=…` in the URL, so the role is what
keeps the two apart. `docker/postgres-init.sql` provisions the role, the schema
and the `plc` database. The PDS holds its state in SQLite plus a disk blobstore
under `PDS_DATA_DIRECTORY` (the `pdsdata` volume), so Postgres carries the PLC,
the catalog and HappyView only.

HappyView stores `record` as **text JSON** and `created_at` as text, and its
`db.raw` cannot decode jsonb or timestamptz columns. Lua scripts that join
catalog data therefore read a text projection rather than the catalog tables
directly.

## Dashboard login

Open `http://127.0.0.1:3000` (redirects to `/dashboard/`) and sign in with the
provisional account:

```
alice.pds.127-0-0-1.sslip.io / Dev-account-password1
```

The PDS account pages run on the canonical host; a handle host redirects there,
so `https://alice.pds.127-0-0-1.sslip.io/account` lands on
`https://pds.127-0-0-1.sslip.io/account`.

The redirect chain crosses to `https://pds.127-0-0-1.sslip.io/oauth/authorize`,
so trust Caddy's root CA first: `mise run hv-ca` installs it into Chrome's and
Firefox's user stores, and `mise run hv-ca --system` adds it to the system store
for curl and friends. Until it is trusted the authorize page fails TLS.

`mise run hv-seed` has already inserted the account into `happyview_users` as a
superuser, so there is no post-login bootstrap. An account that is not seeded is
refused, and the refusal names its DID.

## Deploying lexicons/scripts

```bash
mise run hv-deploy
```

Uploads the lexicons under `happyview/lexicons/` and the Lua query and procedure
scripts under `happyview/scripts/xrpc/`, each with the `target_collection` from
the original deploy script, then applies `happyview/sql/indexes.sql` through the
compose Postgres. Re-running is safe: HappyView bumps the revision instead of
erroring, and the index SQL is `IF NOT EXISTS`.

It talks to the admin API with `HAPPYVIEW_ADMIN_KEY` (`hv_dev_admin` by default;
see `.env.example`). Query scripts are keyed `xrpc.query:<nsid>` and receive the
lexicon's `params`, `db.raw`, and the helpers that `happyview/lib/prelude.lua`
inlines into each script.

## Calling HappyView from the frontend

`/xrpc/*` is served by HappyView, not by the SvelteKit app, and it is not the
public origin: `packages/web` proxies it server-side with
`HAPPYVIEW_CLIENT_KEY` and `HAPPYVIEW_CLIENT_SECRET`, and strips those headers
from anything a caller sends. Queries answer anonymous callers; procedures take
a DPoP session. `docs/happyview.md` has the header contract, the DPoP
provisioning flow and the error mapping.
