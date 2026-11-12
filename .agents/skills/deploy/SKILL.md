# deploy Skill

Build and deploy Bibliograph as three Debian packages, then verify the host and
the public site. The packages are installed dependency-first:
`bibliograph-happyview` → `bibliograph-worker` (+ catalog SQL) →
`bibliograph-web`.

One command drives the whole release:

```bash
mise run deploy                          # build all three, install on veve@lescayes.ts.olamaelcu.net
mise run deploy -- alice@server          # another host
DEPLOY_HOST=alice@server mise run deploy
mise run deploy -- --dry-run             # select debs, print the plan; no ssh
```

This is a fresh-start deployment: no data migration, no import, no seed. The
catalog grows from XRPC traffic after the worker and edge run. There is no
staging/canary flow; rollback is a version pin (see [Rollback](#rollback)).

## Packages, payloads and install order

| Package | Payload / conffiles | Units | Depends |
| --- | --- | --- | --- |
| `bibliograph-happyview` | `/usr/lib/bibliograph-happyview` (binary, migrations, dashboard, lexicons, scripts, `sql/`), `/usr/share/bibliograph-happyview/db-init.sql`, conffile `/etc/bibliograph/happyview.env` | `happyview.service`, `bibliograph-happyview-client.service` (oneshot), `bibliograph-happyview-deploy.service` (oneshot) | `libc6`, `libssl3`, `postgresql-client`, `python3`, … |
| `bibliograph-worker` | `/usr/lib/bibliograph-worker` (ESM + production `node_modules` + `sql/`), conffile `/etc/bibliograph/worker.env` | `bibliograph-worker.service` | `nodejs (>= 22)` |
| `bibliograph-web` | `/usr/lib/bibliograph-web/build` (adapter-node output), conffiles `/etc/bibliograph/web.env` and `/etc/nginx/sites-available/bibliograph-web` | `bibliograph-web.service` | `nodejs (>= 20)`, **`bibliograph-happyview`** |

`bibliograph-web` depends on HappyView, which fixes the order: the edge is
never exposed before its upstream exists. The worker's catalog schema is
applied immediately after it installs, before any unit from the new set starts.

Ports: HappyView `127.0.0.1:3000`, web edge `127.0.0.1:5176` (nginx proxies
here), worker metrics `127.0.0.1:9464`, worker admin API `127.0.0.1:9465`.

## Version sources (do not guess)

- **worker** — `packaging/worker/build-deb.sh` reads
  `packages/worker/package.json` → `version`, then appends `-${WORKER_REVISION:-1}`.
  `WORKER_VERSION` / `WORKER_REVISION` override.
- **web** — `packaging/web/build-deb.sh` reads `packages/web/package.json`
  → `version`, then appends `-${WEB_REVISION:-1}`. `WEB_VERSION` /
  `WEB_REVISION` override.
- **happyview** — `packaging/happyview/build-deb.sh` uses
  `${HAPPYVIEW_VERSION:-2.17.4}` + `${HAPPYVIEW_REVISION:-1}`. This tracks the
  pinned HappyView container image, **not** the Bibliograph release semver.
  Never "sync" it to the app version; bump it only when the extracted image
  changes.
- **root** `package.json` — metadata only; no build path reads it.
- Each split package has a static changelog under `packaging/<name>/changelog`,
  gzipped into the deb as documentation. The build scripts do **not** read it,
  so it must be updated by hand to agree with `package.json`.
- The `debian/` debhelper tree and its `debian/changelog` belong to the retired
  combined package and are unused by this flow.

So a `0.2.0` release means `packages/{worker,web}/package.json` → `0.2.0`,
each split changelog gets a `0.2.0-1` entry, and the produced files are
`dist/bibliograph-worker_0.2.0-1_all.deb` and
`dist/bibliograph-web_0.2.0-1_all.deb`. HappyView stays at its image version
(e.g. `2.17.4-1`).

## Build

`.mise/tasks/deploy` declares the three build tasks as dependencies; mise may
run them concurrently, and all must succeed before anything is uploaded:

```bash
mise run package-hv-deb      # package-hv-payload (docker pull pinned image) -> dpkg-deb
mise run package-worker-deb  # package-worker-payload (pnpm deploy --prod) -> dpkg-deb
mise run package-web-deb     # package-web-payload (pnpm build) -> dpkg-deb
```

`deploy.sh` selects the newest `dist/bibliograph-{happyview,worker,web}_*.deb`
by version sort. `DIST_DIR` changes the directory; `HV_PKG`, `WORKER_PKG`,
`WEB_PKG` pin exact files. A missing deb aborts with the task to run.

## What `mise run deploy` does

`deploy.sh` is the single implementation; the mise task only adds the three
build dependencies and `exec`s it.

### 1. Local preflight

- Requires `dpkg-deb`, `sha256sum`, `ssh`, `scp`.
- Reads `Package`, `Version`, `Architecture` from each deb and hashes it.
- Rejects filenames that are unsafe to pass through ssh.
- Remote preflight (passwordless sudo required): systemd, `apt-get`, `curl`,
  Node.js **≥ 22**, architecture compatibility (`worker`/`web` are `all`,
  HappyView is the host arch), nginx/psql presence, free memory/disk warnings,
  and the legacy detection below.
- `--dry-run` stops here and prints the plan.

### 2. Legacy detection (preflight, before any upload)

The host is checked for the retired combined install: a `bibliograph` dpkg
entry/version, active legacy units, or
`/etc/nginx/sites-enabled/bibliograph-platform` (file or symlink).

- Found and no `--replace-legacy` → **abort before uploading**, non-zero, with
  the removal commands. Nothing changes.
- `--replace-legacy` → continue only if the replacement prerequisites exist:
  - `/etc/bibliograph/worker.env` with a parseable `DATABASE_URL`
    (`postgres://` or `postgresql://`);
  - `/etc/bibliograph/web.env` with a valid `HAPPYVIEW_URL`; `PORT` optional
    (default `5176`) but valid if set;
  - nginx installed and `nginx -t` passing;
  - the certificate referenced by the new vhost (normally
    `/etc/letsencrypt/live/biblio.livtet.olamaelcu.net/fullchain.pem`).

  Missing publisher config, web `DATABASE_URL` or web `PDS_URL` only warn.
  Any hard failure exits before scp/apt and leaves the legacy package/site
  untouched. The remote script repeats these checks before its first install.

### 3. Upload

`scp` all three debs to `HOST:/tmp/`, then re-verifies each remote sha256.
A mismatch aborts before any install.

### 4. Install and database stages (one remote script)

Each install uses:

```bash
apt-get install -y --reinstall \
  -o Dpkg::Options::=--force-confdef \
  -o Dpkg::Options::=--force-confold /tmp/<package>.deb
```

`--reinstall` makes a same-version re-run a real redeploy; `--force-confold`
keeps local edits to the env conffiles and the nginx vhost.

1. **HappyView** install → `verify_version`. Then, unless `--skip-db`, the
   HappyView database gate: `DATABASE_URL` from `happyview.env` (overridden by
   `happyview.local` if set) must connect, and either the `happyview` schema or
   `public.happyview_records` must exist. `db-init.sql` is a one-time superuser
   step with a password placeholder, so the script gates instead of running it.
   A failure here stops before the worker/web are installed (and before a
   legacy purge).
2. **Legacy cutover**, only with `--replace-legacy` and after the gate:
   stop/disable the legacy units, remove the legacy `sites-enabled` symlink,
   **purge `bibliograph` before installing the worker** (both packages ship
   `bibliograph-worker.service`; installing first makes dpkg refuse the
   overwrite and purging after would delete the new unit), remove a now
   unowned `sites-available/bibliograph-platform`, `daemon-reload`, `nginx -t`,
   reload nginx.
3. **Worker** install → stop the worker (so a fresh database is not hit before
   its tables exist) → `verify_version`. Then, unless `--skip-db`, apply every
   `/usr/lib/bibliograph-worker/sql/*.sql` in lexical order with `psql`, from
   `worker.env`'s `DATABASE_URL`. The files are idempotent and additive
   (`IF NOT EXISTS`, `CREATE OR REPLACE`, no DROP/TRUNCATE); `0003-feed-read.sql`
   skips itself when `happyview.happyview_records` does not exist yet.
4. **Web** install last → `verify_version`.

### 5. Ordered restarts and the 0003 re-apply

```bash
systemctl restart bibliograph-happyview-client.service
systemctl restart happyview.service
systemctl restart bibliograph-happyview-deploy.service
# re-apply 0003-feed-read.sql now that HappyView has created its tables
systemctl restart bibliograph-worker.service
systemctl restart bibliograph-web.service
```

- The client seeder runs before HappyView because HappyView loads its XRPC
  client registry into memory at boot.
- The deploy oneshot is awaited so lexicon/script/index upload has finished.
- `0003-feed-read.sql` is re-applied (unless `--skip-db`) only after HappyView
  migrated and `hv-deploy --wait 120` confirmed readiness; it adds the feed
  indexes and grants to `happyview.happyview_records`. Fatal on error, because
  the feed generator answers `503` without it.
- On a `--replace-legacy` run, the web postinst is re-run if
  `sites-enabled/bibliograph-web` is absent; the cutover then requires it.

### 6. nginx and verification

- Unless `--skip-nginx`: checks `nginx -t`, warns if the vhost upstream port
  differs from `web.env`'s `PORT` (would 502), reloads nginx. Reports whether
  the site is enabled or only staged (no certificate).
- Polls `http://127.0.0.1:<PORT>/` for up to 30 s and prints `HTTP`.
- If the new vhost is enabled, checks `https://<server_name>/` through
  `127.0.0.1:443`; this is fatal only under `--replace-legacy`.
- `POST /xrpc/community.lexicon.media.book.searchEditions` probe (best effort).
- Prints `PKG_VERSION`, `HTTP`, `XRPC`, one `SERVICE_STATE` line per unit, and
  `DEPLOY_OK`. Non-zero on a version mismatch, a non-`200` loopback, or any
  unit not `active`.

### Options

| Option | Effect |
| --- | --- |
| `--replace-legacy` | Explicitly stop/purge the retired combined package and remove its vhost, then cut over. Destructive to that package's conffile edits; PostgreSQL data untouched. Without it, a detected legacy install aborts before upload. |
| `--skip-db` | Skip the HappyView role/schema gate, the catalog schema, and the 0003 re-apply. Use only when another tool owns the database. |
| `--skip-nginx` | Skip `nginx -t`/reload. Replacement checks under `--replace-legacy` still apply. |
| `--dry-run` | Select/validate packages and print the plan; no ssh. |
| `--print-remote` | Print the remote install/verify script (review or `bash -n`). |
| `-h`, `--help` | Usage. |

## Configuration / required env

Conffiles are preserved across upgrades; write configuration there, never into
the packaged defaults. All are `0640 root:bibliograph`-style rooted files.

### `/etc/bibliograph/happyview.env`

- `DATABASE_URL` — **required**. Role must default to
  `search_path = happyview, public` for the shared-database layout.
- `SESSION_SECRET` — ≥ 64 chars; signs dashboard cookies.
- `TOKEN_ENCRYPTION_KEY` — base64, exactly 32 bytes; DPoP/OAuth at rest.
- `PUBLIC_URL`, `HOST`, `PORT`, `STATIC_DIR` — shipped loopback defaults; the
  app is the public origin.
- Optional: `JETSTREAM_URL`, `RELAY_URL`, `PLC_URL` (commented),
  `HAPPYVIEW_ADMIN_KEY_FILE`, `HV_ADMIN_DID`.

`/etc/bibliograph/happyview.local`, if present, loads after the conffile and
wins (Ansible-managed hosts use it).

### `/etc/bibliograph/worker.env`

- `DATABASE_URL` — **required**; write access to catalog tables.
- Publisher identity for `pds-publish`: `ATP_SERVICE_DID`, `PDS_URL`,
  `PDS_ACCOUNT_DID`, and `PDS_ACCOUNT_PASSWORD` **or** `PDS_ACCESS_TOKEN`.
  Without them hydration still runs but publishing is disabled and rows stay
  in `pds_outbox`; the unit logs that at boot.
- Optional provider keys: `GOOGLE_BOOKS_API_KEY`, `ISBNDB_API_KEY`,
  `ISBNDB_DAILY_LIMIT`, `GOODREADS_BASE_URL`.
- `WORKER_METRICS_HOST`/`PORT` (default `127.0.0.1:9464`).
- `ADMIN_TOKEN` enables the worker admin API (disabled when unset);
  `WORKER_ADMIN_HOST`/`PORT` default `127.0.0.1:9465`.

### `/etc/bibliograph/web.env`

- `HOST=127.0.0.1`, `PORT=5176` (must match the nginx upstream),
  `HAPPYVIEW_URL` — **required** (`http://127.0.0.1:3000`).
- `FEED_GENERATOR_DID` — **required** for the feed methods; no code default,
  empty answers `503`.
- `PLC_URL` — **required for `following`/`extended`/`dynamic`**; `public` does
  not need it.
- `DATABASE_URL` — read-only catalog role for `resolveEditions` /
  `searchEditions`; unset answers `503`.
- `PDS_URL` — publisher record reads; unset answers `503`.
- `ADMIN_TOKEN` — same value as `worker.env`; unset disables `/admin` and
  `/admin/api/*` (404). `WORKER_ADMIN_URL` — default `http://127.0.0.1:9465`.
- `ORIGIN` (e.g. `https://biblio.livtet.olamaelcu.net`) or
  `PROTOCOL_HEADER=x-forwarded-proto` + `HOST_HEADER=x-forwarded-host` for
  absolute URLs behind nginx.

`/etc/bibliograph/happyview-client.env` is generated by
`bibliograph-happyview-client.service` and loaded after `web.env`; it supplies
the edge's `HAPPYVIEW_CLIENT_KEY`/`SECRET`. Set them in `web.env` only to
override.

## Verification (every deploy)

`DEPLOY_OK` means the deploy landed; it is not the end of a release. Run and
read:

```bash
ssh veve@lescayes.ts.olamaelcu.net \
  'dpkg-query -W -f="${Package} ${Version}\n" bibliograph-happyview bibliograph-worker bibliograph-web'
ssh veve@lescayes.ts.olamaelcu.net \
  'systemctl is-active happyview bibliograph-happyview-client bibliograph-happyview-deploy bibliograph-worker bibliograph-web'
ssh veve@lescayes.ts.olamaelcu.net \
  'systemctl status bibliograph-happyview-deploy --no-pager -n 5'
ssh veve@lescayes.ts.olamaelcu.net 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5176/'
curl -s -o /dev/null -w '%{http_code}\n' https://biblio.livtet.olamaelcu.net/
ssh veve@lescayes.ts.olamaelcu.net 'journalctl -u happyview -n 30 --no-pager'
ssh veve@lescayes.ts.olamaelcu.net 'journalctl -u bibliograph-happyview-deploy -n 20 --no-pager'
ssh veve@lescayes.ts.olamaelcu.net 'journalctl -u bibliograph-worker -n 30 --no-pager'
ssh veve@lescayes.ts.olamaelcu.net 'journalctl -u bibliograph-web -n 30 --no-pager'
```

What each must show:

- `dpkg-query` versions equal the built debs — `0.2.0-1` for worker/web and the
  HappyView image version (e.g. `2.17.4-1`). A different version means the host
  installed a different file.
- All five units `active`. The deploy oneshot is `oneshot` with
  `RemainAfterExit=yes`; `inactive (dead)` is not correct for it after a
  successful deploy.
- Local and public `/` both `200`; a loopback 200 with a public failure points
  at nginx/TLS, not the app.
- Journals: HappyView migration/readiness lines, the deploy oneshot's
  lexicon/script/index upload, the worker's graphile boot, and the edge's
  listener. An unconfigured publisher says so once; that is expected noise.
  Other errors, panics or `status:5xx` access entries are not.

Exercise the surface, not just liveness:

```bash
# catalog query
curl -s -X POST -H 'content-type: application/json' \
  -d '{"q":"dune","limit":1}' \
  https://biblio.livtet.olamaelcu.net/xrpc/community.lexicon.media.book.searchEditions
# resolve
curl -s -X POST -H 'content-type: application/json' \
  -d '{"identifiers":[{"issuer":"isbn","value":"9780441013593"}]}' \
  https://biblio.livtet.olamaelcu.net/xrpc/community.lexicon.media.book.resolveEditions
# feed generator
curl -s https://biblio.livtet.olamaelcu.net/xrpc/com.atproto.feed.describeFeedGenerator
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/com.atproto.feed.getFeedSkeleton?feed=at://<FEED_GENERATOR_DID>/net.olamaelcu.livtet.biblio.feed.generator/public'
```

The edge has no `/health` route; `GET /` is the liveness check (the deploy
script and the public curl above both use it).

Read the bodies: `503` on catalog methods means `web.env` has no catalog
`DATABASE_URL`; `503` on feeds means `FEED_GENERATOR_DID` (or `PLC_URL` for
personalized feeds) is unset, or `0003` lacked the grants. An empty skeleton is
valid on a fresh catalog. Also confirm the change is in the installed build,
e.g. grep the installed bundle for a new symbol:

```bash
ssh veve@lescayes.ts.olamaelcu.net \
  'grep -rlo "<new symbol>" /usr/lib/bibliograph-web/build/ | head'
```

nginx access/error logs are `/var/log/nginx/bibliograph.access.log` and
`.error.log`; they carry the query string, so a 4xx can be replayed verbatim.

## Downtime and rollback

- Every restart is stop-then-start, so the edge returns bare `502` for a few
  seconds; a HappyView migration on restart extends the window.
- `--replace-legacy` downtime runs from stopping the old units until the new
  vhost answers `200`; the purge discards edits to the old package's
  conffiles. PostgreSQL data and roles are untouched. Because certificate and
  nginx are preflight prerequisites, a missing certificate aborts before the
  old site is removed.
- The catalog schema is forward-only: apply new numbered files before running
  units from a newer package; never run an older package against a database a
  newer one has migrated.
- Rollback is a pin to an older package set, e.g.
  `apt-get install -y bibliograph-web=<old-version> bibliograph-worker=<old-version>`;
  keep the old debs in `dist/`. No automated rollback/staging is provided.
  A purged legacy install is not restored by a rollback.

## Troubleshooting

- **`--replace-legacy` aborts before upload** — read which precondition failed
  (worker/web env, nginx `-t`, certificate). Nothing was changed. Stage the
  conffiles from the built debs, fill them, then re-run:
  `dpkg-deb -x dist/bibliograph-worker_*.deb /tmp/bpkg-worker` and install
  `/tmp/bpkg-worker/etc/bibliograph/worker.env` to `/etc/bibliograph/`, likewise
  for `web.env`.
- **A plain deploy aborts with "retired combined package/site is present"** —
  the host still has the old install; use `--replace-legacy` or remove it
  manually (`apt-get purge bibliograph`, remove the legacy symlink, `nginx -t`,
  reload).
- **Worker install fails with a file conflict on
  `bibliograph-worker.service`** — the legacy package was not purged first.
  Re-run `--replace-legacy`; the purge is deliberately before the worker
  install.
- **`nginx -t` fails after the web install** — the deploy stops. Usually a
  missing certificate (site staged, not enabled) or a hand-edited vhost; fix
  nginx, then `dpkg-reconfigure bibliograph-web` to retry enablement.
- **Public 502 while loopback is 200** — the vhost upstream port and
  `web.env`'s `PORT` disagree (default `5176`). The deploy warns about this.
- **Feeds answer `503`** — set `FEED_GENERATOR_DID`; for
  `following`/`extended`/`dynamic` also `PLC_URL`. Ensure the web role has
  `USAGE` on `happyview` and `SELECT` on `happyview.happyview_records`
  (re-run `0003-feed-read.sql`).
- **HappyView will not start** — `DATABASE_URL` unset in `happyview.env`, or
  the role/schema is missing. Run
  `sudo -u postgres psql -v db=<database> -f /usr/share/bibliograph-happyview/db-init.sql`
  once, set the URL, restart.
- **Worker restarts in a loop** — no usable `DATABASE_URL`; the start limit
  trips after five attempts. Publisher credentials are optional and only
  disable `pds-publish`.
- **`/admin` returns 404** — `ADMIN_TOKEN` is unset in `web.env` (and
  `worker.env` must carry the same value for the API call).
- **`ERROR: … installed version … != package version …`** — a stale `/tmp`
  copy or `PKG=` pin selected a different build; the script refuses to report
  success.
- **`No space left on device` while packaging** — payloads are staged under
  `packaging/payload/` and `dist/` keeps every package; prune old debs/payloads.

## Key files

- `deploy.sh` — full implementation: package selection, preflight, legacy
  detection/cutover, upload + checksum, install/DB stages, ordered restarts,
  nginx and verification.
- `.mise/tasks/deploy` — thin wrapper with the three build dependencies.
- `.mise/tasks/package-{hv,worker,web}-{payload,deb}` — build/stage steps.
- `packaging/{happyview,worker,web}/build-deb.sh` — version reading,
  `dpkg-deb` assembly, payload/unit/conffile install.
- `packaging/{happyview,worker,web}/debian/` — maintainer scripts, control,
  conffiles.
- `packaging/{happyview,worker,web}/changelog` — documentation changelog per
  package (not a version source).
- `packaging/{happyview,worker,web}/*.env` and `packaging/web/nginx/` — shipped
  conffile defaults.
- `docs/deploy/debian.md` — the long-form deploy/legacy/cutover reference.
- `docs/operations/fresh-database.md` — database/prerequisite detail.
