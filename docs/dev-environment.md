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
```

| Address | What |
| --- | --- |
| `http://127.0.0.1:3000` | HappyView dashboard and admin API |
| `https://pds.127-0-0-1.sslip.io` | the local PDS (HTTPS, Caddy's internal CA) |
| `http://127.0.0.1:2582` | the local PLC directory |
| `postgres://bibliograph:bibliograph@127.0.0.1:5432/bibliograph` | the catalog + `happyview` schema |

`mise run sql` opens psql against the same database.

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
public origin: proxy it server-side with `HAPPYVIEW_CLIENT_KEY` and
`HAPPYVIEW_CLIENT_SECRET`. Queries answer anonymous callers; procedures need a
DPoP session. `docs/happyview.md` has the header contract, the DPoP provisioning
flow and the error mapping.
