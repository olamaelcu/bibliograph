# Local development

The local stack is Postgres plus HappyView. Identity resolution uses the public
PLC (`https://plc.directory`); the dashboard signs in with a real ATProto handle.
There is no local PLC, no disposable PDS and no `.test` account flow.

## Database schemas

HappyView creates unqualified tables, including a `labels` table that collides
with the AppView's labeler table. It therefore runs in its own schema:

- App: `DATABASE_URL=…/bibliograph` (public only).
- HappyView: `HAPPYVIEW_DATABASE_URL=postgres://happyview_app:happyview@…/bibliograph`.

`happyview_app` is a login role whose default `search_path` is
`happyview,public`; sqlx ignores `?options=…` in the URL, so the role is what
keeps the two apart. `docker/postgres-init.sql` creates it for the compose
Postgres, and `hv-local` provisions it for a host-run binary.

HappyView stores `record` as **text JSON** and `created_at` as text. The Lua
scripts read `appview_book_lua`, a text projection of `appview_book`, because
HappyView's Any driver cannot decode jsonb/timestamptz columns in `db.raw`.
The TS feed queries `happyview.happyview_records` directly.

## Run it

```bash
mise run dev            # migrate, extract/start HappyView, seed local admin key,
                        # deploy lexicons/scripts, then run worker + Vite
```

`mise run dev` uses the host binary in
`packages/bibliograph-service/.cache/happyview` (extracted from the pinned image
by `hv:extract`). To run HappyView itself as a container instead:

```bash
docker compose up -d postgres happyview
```

The compose HappyView uses the public PLC and the same Postgres role. The image
entrypoint substitutes its static base path; no host-side rewrite is needed.

Ports are overridable: `HAPPYVIEW_PORT` and `WEB_PORT` for the host path.

## Dashboard login

Open `http://127.0.0.1:3000/~/hv` (redirects to `/~/hv/dashboard/`) and sign in
with a **real ATProto handle** you control, e.g. `yourname.bsky.social` or your
own domain. A DID also works if its DID document exposes `#atproto_pds`.

The dashboard only admits accounts with a `happyview_users` row. On a completely
empty instance the first login bootstraps that row; `hv:dev-auth` creates a
local API-key user, so a later real login is refused until you authorize it:

```bash
mise run hv-authorize -- --handle=yourname.bsky.social
# or: --did=did:plc:...
```

That marks the account as a superuser. The "not authorized" redirect names the
DID that was refused.

The local `.test` handles from the old mock stack cannot work: OAuth resolves a
handle through `https://<handle>/.well-known/atproto-did`, and `.test` does not
resolve in public DNS. That is why the mock PLC/PDS were removed.

## Deploying lexicons/scripts

`dev:stack` (run by `mise dev`) seeds a local `hv_` admin key and a confidential
XPC client, then runs `hv:deploy`. To do it manually:

```bash
mise run hv-dev-auth
HAPPYVIEW_URL=http://127.0.0.1:3000 HAPPYVIEW_ADMIN_KEY=hv_dev_admin \
  DATABASE_URL=… pnpm --filter bibliograph-service hv:deploy
```

`hv:deploy` uploads the lexicons and Lua scripts and applies
`happyview/sql/indexes.sql`.
