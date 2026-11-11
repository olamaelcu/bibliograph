# Local identity + activity stack

Development and E2E runs must not mint accounts on the public network, and the
activity plane must run against a real HappyView binary. The local stack
therefore replaces two public services and pins a real third:

- **Mock PLC** (`scripts/mock-plc.ts`) — a disposable DID registry. It answers
  `GET /:did`, accepts `POST /:did` from a PDS, and exposes `POST /admin/dids`.
  It does not validate PLC operations or signatures.
- **Disposable PDS** — the Bluesky dev image in `docker-compose.yml`, configured
  with `PDS_DID_PLC_URL=http://plc:2582` and `.test` handles.
- **HappyView** — the published image, extracted into `packages/bibliograph-service/.cache/happyview` by
  `mise run hv-extract` (Docker is used only to obtain the binary).

The app reads `PLC_DIRECTORY_URL` in `did-document-resolver.ts`. Unset, `did:plc`
resolution goes through `plc.directory`.

Inside the compose network, HappyView must address the PLC by service name:
`PLC_URL=http://plc:2582`. Loopback (`127.0.0.1`) inside that container is the
container itself. The compose `happyview` service sets this; a host-run binary
reads `PLC_DIRECTORY_URL` (or `HAPPYVIEW_PLC_URL`) instead.

## Database schemas

HappyView creates unqualified tables, including a `labels` table that collides
with the AppView's labeler table. Run HappyView with a dedicated schema:

```sql
CREATE SCHEMA happyview;
```

- App: `DATABASE_URL=…/bibliograph` (public only).
- HappyView: `HAPPYVIEW_DATABASE_URL=…/bibliograph?options=-csearch_path%3Dhappyview%2Cpublic`.

Its `record` column is **text JSON**, not jsonb, and `created_at` is text. Lua
reads `appview_book_lua`, a text projection of `appview_book`, because
HappyView's Any driver cannot decode jsonb/timestamptz columns in `db.raw`.
The TS feed queries the `happyview.happyview_records` table directly.

## Run it

```bash
mise run stack          # postgres + mock PLC + disposable PDS
# or, containerized HappyView:
docker compose up -d postgres plc happyview
mise run hv-extract     # copy the pinned HappyView binary/static/migrations into .cache
mise run hv-dev-auth    # seed a local admin key + XRPC client (prints env values)
mise run db-migrate
mise run hv-deploy
mise run hv-dev         # run the extracted binary
mise run dev-seed       # create reader.test and write a shelf
```

The postgres init script creates the `happyview` schema and the
`happyview_app` role. It runs only on a fresh `pgdata` volume; to re-run it,
`docker compose down -v` first.

`hv-dev-auth` prints `HAPPYVIEW_ADMIN_KEY`, `HAPPYVIEW_CLIENT_KEY` and
`HAPPYVIEW_CLIENT_SECRET`; put them in `.env` for `hv:deploy` and the edge.

`dev-seed` prints the DID and shelf URI. Add `-- --book=<edition-uri>` to also
write a `bookShelving` record. Nothing is sent to the public PLC or a public
PDS.

## Limits

- Handles under `.test` are not publicly resolvable. Address accounts by DID.
- The mock PLC keeps one document per DID, not a PLC operation log.
- The compose PDS is a development target, not rsky-pds. Protocol behavior the
  AppView relies on is shared; production deploys still use rsky.
- The dashboard needs the static sentinel replaced; `hv-extract` does that.
