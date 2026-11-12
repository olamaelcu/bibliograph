# Local development

The local stack is Postgres, a local PLC directory, a local PDS, Caddy, and
HappyView. Identity resolution and dashboard sign-in happen entirely against
that local network — no `plc.directory`, no public relay, no real ATProto
account. `docs/happyview.md` has the reasoning behind each setting; this page is
the day-to-day loop.

## Bringing it up

```bash
docker compose up -d          # postgres, plc, pds, caddy, happyview, prometheus
mise run hv-account           # mint the provisional account on the local PDS
mise run hv-seed              # make it superuser, write the admin key + XRPC client
mise run hv-ca                # trust Caddy's CA in Chrome and Firefox
mise run hv-deploy            # upload the lexicons, query scripts and indexes
mise run hv-fixtures          # seed-01 … seed-08 plus activity, then verify
mise run web                  # SvelteKit edge on http://127.0.0.1:5176
```

| Address | What |
| --- | --- |
| `http://127.0.0.1:3000` | HappyView dashboard and admin API |
| `https://pds.127-0-0-1.sslip.io` | the local PDS (HTTPS, Caddy's internal CA) |
| `http://127.0.0.1:2582` | the local PLC directory |
| `postgres://bibliograph:bibliograph@127.0.0.1:5432/bibliograph` | the catalog + `happyview` schema |

`mise run sql` opens psql against the same database.

## Seeding test accounts and activity

`hv-account` mints one account (`alice`, the dashboard superuser) and nothing
else, so a fresh stack has no activity to render. `hv-fixtures` seeds a small
lived-in network: eight accounts, their social records, and the Livtet records
the activity queries read. It runs the whole loop — accounts, records,
backfill, verify — and fails if the seeded data does not come back through
`/xrpc`.

```bash
mise run hv-accounts          # create seed-01 … seed-08 on the PDS
mise run hv-fixtures          # records → backfill → verify
mise run hv-fixtures --reset  # delete the seed records, then seed again
```

Both commands are idempotent: a second run resolves the existing accounts and
updates the same record keys in place. `mise run hv-fixtures` implies
`hv-accounts`; run `hv-accounts` alone when you only want the identities.

### Accounts

| | |
| --- | --- |
| handles | `seed-01.pds.127-0-0-1.sslip.io` … `seed-08.pds.127-0-0-1.sslip.io` |
| emails | `seed-01@example.invalid` … |
| password | `Dev-account-password1` (`HV_SEED_PASSWORD` overrides it) |
| count | 8 (`HV_SEED_ACCOUNTS` overrides it) |

The suffix is the PDS's `hostname` (`docker/pds-config.toml`), not a free
choice: `createAccount` derives the handle domain from it, and a reserved TLD
such as `.localhost` is rejected outright. Every account's DID is a real
`did:plc` registered with the local PLC, minted with
`POST /xrpc/com.atproto.server.createAccount`; no `plc.directory` call is
involved. Emails and handles are fixed so re-runs converge instead of piling
up identities.

Both commands print the handle/DID table and the password at the end; copy a
handle from there. A client pointed at this PLC has no handle suggestions: the
accounts exist only in the local directory, so Livtet's typeahead is disabled
by design (`onPublicNetwork()` is false when `plcDirectoryBase()` is not
`https://plc.directory`).

Existence checks use `com.atproto.identity.resolveHandle` per fixed handle.
The PDS also exposes `com.atproto.admin.searchAccounts`, but it answers `401
AuthenticationRequired` here: this stack provisions no admin credential, so
there is nothing to authenticate with.

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
| `net.olamaelcu.livtet.biblio.bookStatus` | 6 (rkey = the edition rkey) |
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
drop activity whose edition is not in the catalog. On a database without the
read model, run `mise run catalog-schema` first.

Follow records use TID rkeys. Before writing them, the seed reconciles the
account's existing follows by subject, deleting a legacy subject-DID-rkey row
or duplicate for the same target so a rerun converges on one record. Rows left
over from an earlier seed are not rewritten in place: a fixture run deletes the
legacy/duplicate row and writes the TID-keyed record. Until then they remain
readable through `graph.listFollowees` and deletable through `graph.unfollow`.

### Backfill is mandatory

Jetstream is deliberately closed (`ws://127.0.0.1:1`), so records written
straight to the PDS are invisible to HappyView until a backfill indexes them.
`hv-fixtures` calls `POST /admin/backfill` with `{"did": …}` for every seed
account — one job per repo, because HappyView filters the walk to the
collections it has lexicons for — then polls `happyview.happyview_records`
until the expected counts land. Without that step every query answers empty.

### Reset

```bash
mise run hv-fixtures --reset
```

`--reset` deletes every record the fixtures wrote from each seed repo
(`applyWrites#delete`), deletes those DIDs' rows from
`happyview.happyview_records` and `happyview.happyview_record_refs`, then seeds
and backfills again. The accounts themselves are kept, so their DIDs stay
stable. Plain `hv-fixtures` never deletes anything.

## Admin curation

`/admin` is an operator-only area: provider search + ingest, and edition merge.
It is not linked from the public navigation. Set the same `ADMIN_TOKEN` on the
worker and the edge (`.env` or the packaged `worker.env`/`web.env`):

```bash
export ADMIN_TOKEN=dev-admin-token
export WORKER_ADMIN_URL=http://127.0.0.1:9465
```

The worker starts a loopback admin API on `WORKER_ADMIN_HOST`:`WORKER_ADMIN_PORT`
(default `127.0.0.1:9465`). Without `ADMIN_TOKEN` it logs that the admin API is
disabled, and the edge answers every `/admin` path with 404. Sign in at
`http://127.0.0.1:5176/admin/login`; the token becomes an HttpOnly,
SameSite=Strict cookie and is never rendered into the page.

Provider search uses exactly the selected provider (Google Books, ISBNdb or
Goodreads) and sends ISBN-shaped queries to that provider's ISBN lookup. Ingest
revalidates the candidate server-side in the worker before minting an edition.
The merge workbench unions identifiers, copies the chosen scalar fields from the
chosen records, applies the contributor/publisher source or union, deletes the
duplicate editions (their outbox rows become `delete`) and keeps the base URI.
Reader activity records that referenced deleted URIs are intentionally left
untouched.

## Database schemas

HappyView creates unqualified tables, including a `labels` table. It therefore
runs in its own schema so those tables stay out of the catalog's `public`
schema:

- App: `DATABASE_URL=…/bibliograph` (public only).
- HappyView: `HAPPYVIEW_DATABASE_URL=postgres://happyview_app:happyview@…/bibliograph`.

`happyview_app` is a login role whose default `search_path` is
`happyview,public`; sqlx ignores `?options=…` in the URL, so the role is what
keeps the two apart. `docker/postgres-init.sql` creates the role, the schema and
the `plc`/`pds` databases for the compose Postgres.

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

The redirect chain crosses to `https://pds.127-0-0-1.sslip.io/oauth/authorize`,
so Caddy's root CA has to be trusted first: `mise run hv-ca` installs it into
Chrome's and Firefox's user stores, and `mise run hv-ca --system` adds it to the
system store for curl and friends. Until it is trusted the authorize page fails
TLS.

`mise run hv-seed` has already inserted the account into `happyview_users` as a
superuser, so no post-login bootstrap is involved. An account that is *not*
seeded is refused, and the refusal names its DID.

## Deploying lexicons/scripts

```bash
mise run hv-deploy
```

Uploads the 24 lexicons in `happyview/lexicons/` and the 17 Lua queries in
`happyview/scripts/xrpc/query/`, each with the `target_collection` from the
original deploy script, then applies `happyview/sql/indexes.sql` through the
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
from anything a caller sends. Queries answer anonymous callers; procedures need
a DPoP session. `docs/happyview.md` has the header contract, the DPoP
provisioning flow and the error mapping.
