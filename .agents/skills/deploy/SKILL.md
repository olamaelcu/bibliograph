# deploy Skill
Deploy the Debian `.deb` package (built by `mise run package-deb`) to a remote
host, install it, restart the `bibliograph` units, and verify the installed
version and service state.

## Release flow (order matters)

1. **Bump `debian/changelog`.** It is the only version source: `debian/rules`
   compiles nothing and bakes no version file, so `dpkg-buildpackage` takes the
   version straight from the changelog. Add a top entry —
   `bibliograph (X.Y.Z) unstable; urgency=medium`, change list, then a real
   trailer line ` -- Bibliograph Maintainers <maintainers@olamaelcu.net>  <RFC-2822 date>`.
   An entry without its trailer makes every `dpkg-parsechangelog` call warn.

   Verify: `dpkg-parsechangelog -S Version` prints `X.Y.Z` with no warning.

   `packages/bibliograph-service/package.json` still says `0.1.0` and is *not*
   read by the packaging path. Do not treat the two as a pair that must agree —
   and do not "fix" the package version by editing it.

2. `mise run package-deb` — depends on `package-payload`, which builds the
   service, stages `packaging/payload/app` with a production-only
   `node_modules` tree, and then runs `dpkg-buildpackage -b -us -uc -d`, moving
   `bibliograph_*.deb` / `.buildinfo` / `.changes` into `dist/`.

3. `mise run package-verify-deb` — checks payload layout, conffiles, maintainer
   scripts, debconf wiring, the three units (`systemd-analyze verify`), the
   nginx site, and that no build toolchain leaked in. Do not deploy a package
   that has not passed this.

4. Deploy, one of two paths:
   - `mise run deploy` (or `./deploy.sh [host]`) — package only: upload,
     install, restart, verify. This is the routine upgrade.
   - `mise run deploy-deb` — builds first and also provisions what the package
     cannot: PostgreSQL, the application role and database, `DATABASE_URL`, the
     OAuth client id derived from `OAUTH_PUBLIC_ORIGIN`, and the lexicon publish.

## Usage

```bash
mise run deploy                                  # newest dist/*.deb -> veve@lescayes
./deploy.sh alice@server                         # another host
PKG=dist/bibliograph_0.1.3_amd64.deb ./deploy.sh # pin an exact package
DEPLOY_HOST=alice@server mise run deploy         # env form
```

`.mise/tasks/deploy` only `exec`s `deploy.sh`, so both entry points share one
implementation and one verification, and neither names a version: the package
is picked by `ls -1 dist/bibliograph_*.deb | sort -V | tail -1`.

## What `deploy.sh` does

1. Selects the newest `dist/bibliograph_*.deb` by version sort unless `PKG=` is
   set.
2. Reads `Version` and `Architecture` from the package with `dpkg-deb -f` and
   hashes it with `sha256sum`.
3. Preflight: `ssh … 'sudo -n true'`, then the remote
   `dpkg --print-architecture` must equal the package's `Architecture`.
4. `scp` to `/tmp`, then compares the remote `sha256sum` against the local one
   and aborts on a mismatch.
5. On the host: `apt-get install --reinstall -o Dpkg::Options::=--force-confdef
   -o Dpkg::Options::=--force-confold`, removes
   `/etc/bibliograph/bibliograph.env.dpkg-dist`, restarts `bibliograph.service`
   (the migrator re-runs through `Requires=bibliograph-migrate.service`) and
   `bibliograph-worker.service` / `bibliograph-jobs.service` when present, then
   polls the debconf-rendered port from `/etc/bibliograph/port.conf` for up to
   30 s.
6. Reports `INSTALLED_VERSION` (from `dpkg-query`), `SERVICE_STATE:` per unit
   and `HTTP:` for the local socket, and exits non-zero when the installed
   version differs from the package or a unit is not `active`. `SERVICE_OK`
   therefore means the deploy actually landed.

## Verification

After deploy, check the remote host:

```bash
ssh veve@lescayes 'dpkg-query -W -f="${Version}\n" bibliograph'
ssh veve@lescayes 'systemctl is-active bibliograph bibliograph-worker bibliograph-jobs'
ssh veve@lescayes 'systemctl status bibliograph-migrate --no-pager'
ssh veve@lescayes 'cat /etc/bibliograph/port.conf'
ssh veve@lescayes 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5000/'
ssh veve@lescayes 'journalctl -u bibliograph -n 30 --no-pager'
curl -s -o /dev/null -w '%{http_code}\n' https://biblio.livtet.olamaelcu.net/
```

Unlike the platform package there is no `VERSION+SHA` stamp: the installed
version is only the changelog version, so two builds of the same version are
indistinguishable once deployed. Commit before building when the deployed
identity has to be traceable, and prefer a version bump per deploy.

`SERVICE_STATE` proves process liveness, not correctness — confirm the change
visibly renders through the public URL.

## Downtime window

`systemctl restart bibliograph` stops the old process before the new one binds,
so a deploy has a few seconds where nothing answers and clients see a bare
`502` (the site has no `error_page`/loading fallback like the platform's). The
`bibliograph-migrate` oneshot runs again as part of the restart and holds the
start until migrations finish, which extends that window on a migration release.

`/etc/nginx/sites-available/bibliograph-platform` is a **conffile**, and the
postinst only symlinks it into `sites-enabled` once
`/etc/letsencrypt/live/biblio.livtet.olamaelcu.net/fullchain.pem` exists — a
missing site after an install usually means no certificate, not a failed
deploy. If it *is* enabled and has been edited on the host, an upgrade keeps the
edited copy and drops the packaged one at `.dpkg-dist`, silently losing new
directives.

## Troubleshooting

- **`SERVICE_STATE: … inactive` / `INSTALLED_VERSION: not installed` right
  after a successful upload** — a `$(…)` inside a double-quoted `ssh "…"`
  command runs on the deploying machine. `deploy.sh` uses a quoted heredoc
  (`<<'REMOTE'`) and passes the package name and version as positional
  arguments for exactly this reason.
- **`ERROR: installed version … != package version …`** — the host installed a
  different `.deb` than the one selected: usually a stale `/tmp` copy of the
  same filename, or `PKG=` pointing at an older build while a newer one sits in
  `dist/`. The script fails rather than reporting success.
- **`systemctl restart` exits non-zero while the unit ends up `active`** — the
  old process hit its stop timeout. Liveness is judged by the polled
  `is-active`; the worker/jobs restarts are already tolerated as optional.
- **The page still serves the old bundle after an install** — the units must be
  restarted. `dpkg -i` or `apt install` alone does not do it: the postinst only
  restarts on a port change. Use this skill's script, not a bare install.
- **The worker stops a few seconds after a deploy** — `TAP_URL` /
  `TAP_ADMIN_PASSWORD` are unset and the unit's start limit trips after five
  attempts. Intentional: an unconfigured tap consumer would restart-loop.
- **Index-backed reads answer empty while the PDS has the records** — the
  Postgres `records` cache (behind `listShelves`, `listBooksOnShelf`,
  `getShelvingOfBook`) fills from the tap consumer, run by
  `bibliograph-jobs.service`. Queries fall back to per-request PDS scans, so an
  empty cache degrades latency and cursor behaviour, not correctness. Check
  `systemctl is-active bibliograph-jobs` and
  `journalctl -u bibliograph-jobs -n 50` before blaming the package.
- **`No space left on device` while packaging** — the payload is staged twice
  (build output plus `packaging/payload/app`) and `dist/` keeps every package.
  Prune `dist/bibliograph_*.deb` and `packaging/payload` before rebuilding.
-- **Edits to `/etc/bibliograph/bibliograph.env` vanish after a deploy** — it is
  a conffile installed `0640 root:root`; `--force-confold` keeps the on-disk copy,
  so write configuration there, never into the packaged default. If the file has
  lost the `Bibliograph runtime configuration` header, `deploy-deb` restores the
  packaged one (without `LOG_DIR` the logger tries to create `./logs` inside the
  read-only payload tree).

## Key files

- `deploy.sh` — deploy implementation (dynamic package selection, `scp` with a
  checksum re-verify, install, restart, version/state verification).
- `.mise/tasks/deploy` — thin wrapper: `exec bash deploy.sh "$@"`.
- `.mise/tasks/deploy-deb` — build + install + PostgreSQL/conffile/OAuth
  provisioning + lexicon publish.
- `.mise/tasks/package-deb`, `.mise/tasks/package-payload`,
  `.mise/tasks/package-verify-deb` — build and validation steps.
- `debian/changelog` — the only version source.
- `debian/rules` — installs the payload, stages the worker/jobs/migrate units
  (the main unit is picked up by `dh_installsystemd`), the nginx site and the
  upstream template; skips the systemd, missing and strip overrides.
- `debian/bibliograph.postinst` — renders `port.conf` and the nginx upstream,
  enables the site only when the certificate exists, reloads nginx after
  `nginx -t`.
- `debian/bibliograph-platform.nginx`, `debian/bibliograph.env` — the two
  conffiles.
