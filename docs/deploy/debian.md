# Debian package deployment

Bibliograph ships as three Debian packages, installed dependency-first. One
command builds all three, uploads them, installs them in order, applies the
database prerequisites, restarts the units in order and verifies the result:

```bash
mise run deploy                          # veve@lescayes.ts.olamaelcu.net
mise run deploy -- alice@server          # another host
DEPLOY_HOST=alice@server mise run deploy
mise run deploy -- --dry-run             # select packages, print the plan, no ssh
```

> **Fresh-start deployment.** This flow provisions a new host/package set. There
> is **no data migration, no import and no seed**: the catalog grows from XRPC
> traffic after the worker and edge are running. Staging, canary and automated
> rollback are out of scope. Rollback is a pin to an older package version, and
> the catalog schema is forward-only (see [Upgrade](#upgrade)). Database roles,
> PostgreSQL, Node and TLS certificates are host prerequisites, not things the
> packages install.

> **Legacy host?** A host still running the retired combined `bibliograph`
> package is refused by a plain deploy (preflight aborts before uploading); see
> [Legacy host cutover](#legacy-host-cutover) and use `--replace-legacy`
> explicitly. The old nginx site must not keep owning the public name.

## Packages

| Package | Payload | Units | Depends |
| --- | --- | --- | --- |
| `bibliograph-happyview` | `/usr/lib/bibliograph-happyview` (binary, migrations, dashboard, lexicons/scripts, db-init SQL) | `happyview.service`, `bibliograph-happyview-client.service` (oneshot), `bibliograph-happyview-deploy.service` (oneshot) | `libc6`, `libssl3`, `postgresql-client`, `python3`, … |
| `bibliograph-worker` | `/usr/lib/bibliograph-worker` (ESM + production `node_modules` + `sql/`) | `bibliograph-worker.service` | `nodejs (>= 22)` |
| `bibliograph-web` | `/usr/lib/bibliograph-web/build` (adapter-node output) | `bibliograph-web.service` | `nodejs (>= 20)`, **`bibliograph-happyview`** |

Only `bibliograph-web` depends on another split package, and it depends on
`bibliograph-happyview`: the edge has no upstream without it. That fixes the
install order.

## Build order

`mise run deploy` declares the three build tasks as dependencies, so all of them
must succeed **before** anything is uploaded or installed. They stage separate
directories, so mise may run them concurrently; each deb is selected from
`dist/` afterwards.

```bash
mise run package-hv-deb      # package-hv-payload, then dpkg-deb
mise run package-worker-deb  # package-worker-payload, then dpkg-deb
mise run package-web-deb     # package-web-payload (pnpm build), then dpkg-deb
```

A failed build aborts the task: `deploy.sh` never runs, and no partial set is
installed. `deploy.sh` selects the newest `dist/bibliograph-happyview_*.deb`,
`dist/bibliograph-worker_*.deb` and `dist/bibliograph-web_*.deb` by version
sort; if any one is missing it stops and names the task to run. Set `DIST_DIR`
to select from another directory, or `HV_PKG`/`WORKER_PKG`/`WEB_PKG` to pin an
exact file.

## Install order

The order is dependency-first, and `deploy.sh` installs one package at a time
with:

```bash
apt-get install -y --reinstall \
  -o Dpkg::Options::=--force-confdef \
  -o Dpkg::Options::=--force-confold \
  /tmp/<package>.deb
```

1. **`bibliograph-happyview`** — the activity plane and the upstream the edge
   proxies to. Installing it makes `psql` and the one-time `db-init.sql`
   available, so the HappyView role/schema gate runs here.
2. **`bibliograph-worker`** — installed next. Its deb ships the versioned
   catalog schema at `/usr/lib/bibliograph-worker/sql/`; that schema is applied
   immediately after the install (the worker is stopped first so a fresh
   database is not hit by a worker whose tables do not exist yet).
3. **`bibliograph-web`** — installed last. It depends on `bibliograph-happyview`,
   and the public edge must not exist before its upstream and the worker.

`--reinstall` makes re-running the deploy a real redeploy of the same version.
`--force-confold` keeps local edits to the env conffiles and the nginx vhost;
new files are installed when absent.

The retired combined `bibliograph_*.deb` is never selected, uploaded or
installed.

## Legacy host cutover

A host that still runs the retired combined package cannot be upgraded in place
by the normal flow:

- both `bibliograph` and `bibliograph-worker` ship
  `/usr/lib/systemd/system/bibliograph-worker.service`, so dpkg refuses the
  split worker install (and purging the old package afterwards would delete the
  newly installed unit);
- `sites-enabled/bibliograph-platform` owns the public `:443 server_name`, and
  `bibliograph-web`'s postinst deliberately refuses to enable its vhost while
  that legacy symlink exists.

Every run checks the host during preflight (`dpkg-query -W bibliograph`,
`systemctl is-active bibliograph.service`, and
`/etc/nginx/sites-enabled/bibliograph-platform`, symlink included). If any
legacy artifact is found and `--replace-legacy` was not passed, **nothing is
uploaded or changed** and the deploy exits non-zero with the removal commands.
It never reports success while the old app can still serve.

### Preconditions checked before upload

`--replace-legacy` refuses to upload until the target already has the new
package conffiles and the services they configure can start:

- `/etc/bibliograph/worker.env` with a non-empty, parseable `DATABASE_URL`
  (`postgres://` or `postgresql://`). Publisher keys are warned about, not
  required — `pds-publish` disables itself when they are absent.
- `/etc/bibliograph/web.env` with a non-empty `HAPPYVIEW_URL`; `PORT` is
  optional (default `5176`) but must be a valid port if set. Set
  `FEED_GENERATOR_DID` and `PLC_URL` for the feed generator: neither has a code
  default, and without them the feed methods answer `503 ServiceUnavailable`.
  Missing catalog `DATABASE_URL` or `PDS_URL` are warnings (those methods answer
  `503`). The HappyView client key is generated by the package later and is not
  required.
- nginx installed and `nginx -t` passing.
- the certificate the new vhost references (or
  `/etc/letsencrypt/live/biblio.livtet.olamaelcu.net/fullchain.pem`) present.

These files do not exist yet on a host that still runs the old package, so
stage them from the built debs, then edit them. They are conffiles: dpkg
preserves them (`--force-confold`) when the packages install later.

```bash
# from this checkout, for each of worker and web:
dpkg-deb -x dist/bibliograph-worker_*.deb /tmp/bpkg-worker
scp /tmp/bpkg-worker/etc/bibliograph/worker.env <host>:/tmp/worker.env
ssh <host> 'sudo install -D -m 0640 -o root -g root /tmp/worker.env /etc/bibliograph/worker.env'

dpkg-deb -x dist/bibliograph-web_*.deb /tmp/bpkg-web
scp /tmp/bpkg-web/etc/bibliograph/web.env <host>:/tmp/web.env
ssh <host> 'sudo install -D -m 0640 -o root -g root /tmp/web.env /etc/bibliograph/web.env'
```

Then set `DATABASE_URL` (and publisher keys if publishing) in `worker.env`, and
check `HAPPYVIEW_URL`/`PORT`, set `FEED_GENERATOR_DID` and `PLC_URL` (required
for feeds), and the catalog `DATABASE_URL`/`PDS_URL` if those methods should
answer, in `web.env`. Re-run with `--replace-legacy`.

Any failure here exits before scp/apt and leaves the retired package, units and
site untouched. The HappyView DB gate still runs after the happyview install
and before the cutover, so a database failure also leaves the old app serving.
The remote install script repeats the same prerequisite checks immediately
before its first install, so a changed target cannot be purged unprepared.

`--replace-legacy` is explicit and destructive. After installing happyview and
passing the HappyView DB gate (so a database failure leaves the old app
serving), it:

1. stops and disables `bibliograph.service` and `bibliograph-worker.service`;
2. removes `sites-enabled/bibliograph-platform`;
3. purges the `bibliograph` package — this removes its units, the old
   `sites-available/bibliograph-platform` and its conffiles including
   `bibliograph.env`;
4. removes `sites-available/bibliograph-platform` if it survived, but only when
   `dpkg -S` shows no installed package owns that path;
5. runs `systemctl daemon-reload`, `nginx -t` and reloads nginx;
6. installs worker → catalog schema → web, then requires
   `sites-enabled/bibliograph-web` (re-running the web postinst if needed) and
   `https://<server_name>/` through 127.0.0.1 to answer `200`. Only then does it
   print `DEPLOY_OK`.

Downtime runs from the stop until the new vhost is enabled, and purging
discards edits to the old package's conffiles. PostgreSQL data and roles are
untouched (no migration, no seed). Because the certificate and nginx are
preflight prerequisites, a missing certificate aborts before the old site is
removed. Use `--dry-run` first; the actual legacy state is read from the host
during preflight.

The replacement checks are tied to the flag, not to finding the old package, so
re-running `--replace-legacy` after a partial failure still requires the new
vhost and HTTPS before reporting success.

## Database prerequisites (fresh host, two passes)

PostgreSQL 14+ and the application role/database are prerequisites. On a brand
new database:

```bash
sudo -u postgres createuser --pwprompt bibliograph
sudo -u postgres createdb -O bibliograph bibliograph
```

The first `mise run deploy` installs `bibliograph-happyview`, then stops at the
HappyView database gate with the exact command to run. The gate requires
`DATABASE_URL` to connect and either the `happyview` schema (shared-database
layout, created by `db-init.sql`) or HappyView's migrated tables (a dedicated
database) to exist. Stopping instead of creating the role is intentional:
`/usr/share/bibliograph-happyview/db-init.sql` creates the `happyview_app` role
with a password placeholder and is **not** safely re-runnable on the role line,
so the deploy script never invents a password for it.

After the first pass:

```bash
# once, as a Postgres superuser — change the placeholder password in the file
# first if you are creating the role with this SQL
sudo -u postgres psql -v db=bibliograph -f /usr/share/bibliograph-happyview/db-init.sql

# then the two URLs the services read (conffiles, 0640 root:bibliograph):
#   /etc/bibliograph/happyview.env  DATABASE_URL=postgres://happyview_app:…@localhost/bibliograph
#   /etc/bibliograph/worker.env     DATABASE_URL=postgres://bibliograph:…@localhost/bibliograph
```

Re-run `mise run deploy`. It installs the worker, applies every file in
`/usr/lib/bibliograph-worker/sql/` in lexical order, installs the web package,
and then restarts the units. The schema SQL is **idempotent and additive**: it
creates missing tables/sequences/indexes/functions/views, and re-running it on
an existing database is safe. It is **forward-only**, not purely additive: each
numbered file is one transaction, and a migration file may backfill data and
drop a column or table behind a guard (`0007`/`0008` moved the edition shape and
publisher links onto `edition_identifiers`, dropping the five edition columns
and `edition_publishers`). Those drops are not reversible: take a `pg_dump`
before a release that adds such a file, and never run an older package against a
database a newer one has migrated. A new column still belongs in a new numbered
file.

`0003-feed-read.sql` is re-applied after `happyview.service` (and its deploy
oneshot) has migrated, because the first catalog pass runs before
`happyview.happyview_records` exists. That re-apply is idempotent and adds only
the feed indexes and grants. If `web.env` uses the `bibliograph-web` role, create
it before deploying so 0003 can grant it `USAGE` on `happyview` and `SELECT` on
`happyview.happyview_records`; otherwise those methods answer `503`.

`web.env` needs its own read-only `DATABASE_URL` for the anonymous catalog
procedures; without it those methods answer `503 ServiceUnavailable` while the
rest of the edge still works. The HappyView role receives `SELECT` on the
catalog tables when the catalog schema is applied after `db-init.sql`.

Use `--skip-db` only when another tool owns the database (schema already
applied, or a managed service): it skips both the HappyView gate and the catalog
schema. The restart verification still runs.

## What the script verifies

On the target, after the installs:

- Preflight looks for the retired combined install (`dpkg-query -W
  bibliograph`, `bibliograph.service`, and a
  `sites-enabled/bibliograph-platform` file or symlink). If it is present and
  `--replace-legacy` was not passed, the run stops before uploading anything.
- With `--replace-legacy`, preflight also requires the staged `worker.env`
  (valid `DATABASE_URL`), `web.env` (valid `HAPPYVIEW_URL`, valid/default
  `PORT`), working nginx (`nginx -t`), and the vhost certificate. Missing
  prerequisites stop the run before upload; publisher and optional web keys
  only warn.
- `dpkg-query` reports exactly the version of each uploaded deb.
- Units are restarted in dependency order:
  `bibliograph-happyview-client` → `happyview` →
  `bibliograph-happyview-deploy` → `bibliograph-worker` → `bibliograph-web`.
  The client seed runs before HappyView because HappyView loads its XRPC client
  registry into memory at boot; the deploy oneshot is awaited so the lexicon,
  script and index upload has finished.
- `systemctl is-active` is `active` for all five units.
- `GET http://127.0.0.1:<PORT>/` answers `200`, where `<PORT>` is `PORT=` from
  `/etc/bibliograph/web.env` (default `5176`).
- Best-effort XRPC probe: `POST /xrpc/community.lexicon.media.book.searchEditions`.
  `200` is healthy; `503` is reported as "catalog database not configured in
  web.env" rather than a deploy failure.
- If nginx is installed: `nginx -t`, then a reload. A rejected configuration
  fails the deploy, and the result says whether the vhost is enabled or only
  staged (no certificate). If nginx is absent the edge is only reachable on
  loopback and the script says so.
- With `--replace-legacy`, `sites-enabled/bibliograph-web` is required after
  the web install (the postinst is re-run if needed) and `https://<server_name>/`
  through 127.0.0.1 must answer `200`; otherwise the run fails. These two
  replacement checks are **not** skipped by `--skip-nginx`.

## Options

| Option | Effect |
| --- | --- |
| `--dry-run` | Select the three debs, validate their metadata, print the plan; no ssh, no upload. |
| `--print-remote` | Print the remote install/verify script and exit (review/debug; `bash -n`-able). |
| `--replace-legacy` | Explicitly stop and purge the retired combined package, remove its nginx site, then cut over and require the new vhost + HTTPS. Destructive: purges old conffile edits; PostgreSQL data is untouched. Without it, a detected legacy install aborts before upload. |
| `--skip-db` | Skip the HappyView role/schema gate and the catalog schema. |
| `--skip-nginx` | Do not run `nginx -t`/reload after installing the web package. |
| `-h`, `--help` | Usage. |

`deploy.sh` is the single implementation; `.mise/tasks/deploy` only adds the
three build dependencies. Both can be run directly:

```bash
bash deploy.sh --help
bash deploy.sh --dry-run
bash deploy.sh --print-remote | bash -n
```

## Host prerequisites

- **Node.js ≥ 22** from NodeSource (`nodejs (>= 22)` is a hard dependency of the
  worker; the distro's 18 does not satisfy it). `apt-get` refuses the install
  otherwise.
- **PostgreSQL 14+** and `psql` on the target (the HappyView package depends on
  `postgresql-client`). PostgreSQL may be remote; `DATABASE_URL` decides.
- **nginx** (the web package recommends it) if the edge should be public.
  Certificates are the host's job; see below.
- **Passwordless sudo** for the ssh user, plus `systemd`, `apt-get`, `dpkg` and
  `curl`.
- **PDS publisher credentials** for catalog publishing (`ATP_SERVICE_DID`,
  `PDS_URL`, `PDS_ACCOUNT_DID` and `PDS_ACCOUNT_PASSWORD` or
  `PDS_ACCESS_TOKEN`). Without them the worker still hydrates the catalog, but
  `pds-publish` is disabled and rows stay in `pds_outbox`.

## Configuration after install

The packages ship these conffiles; deploy preserves local edits:

| File | Required/important values |
| --- | --- |
| `/etc/bibliograph/happyview.env` | `DATABASE_URL`; `SESSION_SECRET` (≥ 64 chars); `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes) for DPoP/OAuth |
| `/etc/bibliograph/worker.env` | `DATABASE_URL`; publisher identity and PDS credentials; optional `GOOGLE_BOOKS_API_KEY`, `ISBNDB_API_KEY`, `ISBNDB_DAILY_LIMIT`; metrics host/port (`127.0.0.1:9464` by default) |
| `/etc/bibliograph/web.env` | `HOST=127.0.0.1`, `PORT=5176`, `HAPPYVIEW_URL`; required `FEED_GENERATOR_DID` and `PLC_URL` (no code default; unset answers the feed methods with `503`); read-only catalog `DATABASE_URL`; `PDS_URL`; `ORIGIN` (or `PROTOCOL_HEADER`/`HOST_HEADER`) for absolute URLs |

The HappyView client key pair is generated by
`bibliograph-happyview-client.service` into
`/etc/bibliograph/happyview-client.env`; `bibliograph-web.service` loads it after
`web.env`, so the edge authenticates to HappyView without a manual copy. Only
set the pair in `web.env` to override it.

## nginx and TLS

`bibliograph-web` ships its vhost as the conffile
`/etc/nginx/sites-available/bibliograph-web`. Its `postinst` enables it (symlink
into `sites-enabled`) only when all of these hold: nginx is installed, a
certificate exists for `biblio.livtet.olamaelcu.net`, the retired combined
package's `bibliograph-platform` site is not still enabled, and `nginx -t`
accepts the result. If enabling would break `nginx -t`, the symlink is removed
again and the site stays staged — an enabled server block with a missing
certificate would keep nginx from starting after a reboot and take every other
vhost with it. `prerm` removes the symlink on removal.

`mise run deploy` runs `nginx -t` and reloads nginx after the web package
installs, and fails if nginx rejects the configuration. It does not create
certificates and does not edit the vhost. The vhost's `upstream` port is
`127.0.0.1:5176`; keep `PORT` in `web.env` in sync (the deploy reports a
mismatch). Certificates are obtained on the host, e.g. with the webroot
authenticator:

```bash
certbot certonly --webroot -w /var/lib/certbot -d biblio.livtet.olamaelcu.net
dpkg-reconfigure bibliograph-web   # runs postinst, enables the vhost
nginx -t && systemctl reload nginx
```

The retired combined package also shipped an `enable-tls` task; it was removed
with that package and is not part of this flow.

## Units

| Unit | Runs | Notes |
| --- | --- | --- |
| `happyview.service` | `/usr/lib/bibliograph-happyview/happyview` | loopback `127.0.0.1:3000`; migrations load from its working directory |
| `bibliograph-happyview-client.service` | `bin/hv-client` | oneshot, `Before=happyview.service`: seeds the edge's XRPC client |
| `bibliograph-happyview-deploy.service` | `bin/hv-deploy --wait --seed` | oneshot, applies lexicons/scripts/indexes; mints the admin key on first run |
| `bibliograph-worker.service` | `node /usr/lib/bibliograph-worker/index.js` | catalog hydration + `pds_outbox` drain; `/metrics` on `127.0.0.1:9464` (loopback) |
| `bibliograph-web.service` | `node /usr/lib/bibliograph-web/build/index.js` | public edge on `127.0.0.1:5176`, proxied by the packaged nginx vhost; `/metrics` on the same loopback listener, denied by the vhost |

Both `/metrics` endpoints are loopback-only. Prometheus scrapes
`127.0.0.1:5176` (web) and `127.0.0.1:9464` (worker) directly; the packaged
nginx vhost answers a public `/metrics` with `403` and never proxies it. No
extra package configuration is needed for either endpoint.

## Upgrade

```bash
mise run deploy    # rebuilds all three, reinstalls, reapplies schema, restarts
```

The catalog schema is forward-only: apply new numbered files (deploy does) before
running units from a newer package. An older package must not be run against a
database a newer one has migrated. Rollback is a version pin to an older package
set (`apt-get install -y bibliograph-web=<version> …`); automated rollback and
staging/canary workflows are not provided.

## Removed combined package

The old single `bibliograph` package and its deploy path were removed from this
tree and are not used by the current flow:

| Removed | Current replacement |
| --- | --- |
| `debian/`, `package-payload`, `package-deb`, `package-verify-deb`, `deploy-deb`, `enable-tls` → `dist/bibliograph_*.deb`, `bibliograph.service` | `packaging/{happyview,worker,web}`, `package-{hv,worker,web}-{payload,deb}` |
| `mise run deploy-deb` (combined deb + PostgreSQL provisioning) | `mise run deploy` |
| drizzle migrator / `bibliograph-migrate.service` | none; catalog schema is applied once from `/usr/lib/bibliograph-worker/sql/` |
| `bibliograph.env`, `port.conf`, debconf `bibliograph/port` | `happyview.env`, `worker.env`, `web.env`; web port is `PORT` in `web.env` (default 5176) |
| combined nginx site `bibliograph-platform` | `bibliograph-web` package's vhost conffile |

The retired combined package published under the public production publisher
identity `ATP_SERVICE_DID=did:plc:e2x3ihw2ntxt7pcgzmtu3abi` (the account whose
repo carries the catalog records). The split packages ship no value for it: set
`ATP_SERVICE_DID` explicitly in `/etc/bibliograph/worker.env`, and keep
`PDS_ACCOUNT_DID` equal to it.

`deploy.sh` itself used to install `dist/bibliograph_*.deb` and restart
`bibliograph`/`bibliograph-worker`; it now selects only the three split packages
and never touches the retired unit unless `--replace-legacy` explicitly asks it
to remove that install. If `/etc/nginx/sites-enabled/bibliograph-platform`
still exists on a host, use `mise run deploy -- --replace-legacy` (see [Legacy
host cutover](#legacy-host-cutover)) or remove the old package manually first:
both vhosts claim the same `:443 server_name`, and the web package
intentionally refuses to enable its site while the old one is enabled.
