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
mise run web                  # SvelteKit edge on http://127.0.0.1:5176
```

| Address | What |
| --- | --- |
| `http://127.0.0.1:3000` | HappyView dashboard and admin API |
| `https://pds.127-0-0-1.sslip.io` | the local PDS (HTTPS, Caddy's internal CA) |
| `http://127.0.0.1:2582` | the local PLC directory |
| `postgres://bibliograph:bibliograph@127.0.0.1:5432/bibliograph` | the catalog + `happyview` schema |

`mise run sql` opens psql against the same database.

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

HappyView creates unqualified tables, including a `labels` table that collides
with the AppView's labeler table. It therefore runs in its own schema:

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
