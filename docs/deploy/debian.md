# Debian package deployment

How Bibliograph is packaged and installed as a native Debian package, following
the same shape as the Livtet platform package (`../platform/debian`): a prebuilt
payload under `/usr/lib`, a conffile under `/etc`, systemd-owned writable paths,
and an nginx site generated around a debconf-selected port.

> **The combined `bibliograph` package is retired.** Its drizzle migrator and
> `bibliograph-migrate.service` no longer exist, and a fresh database does not
> need them. Current deployments install `bibliograph-web`,
> `bibliograph-worker` and `bibliograph-happyview`. The catalog schema is
> bootstrapped once from the versioned SQL in `packages/worker/sql/` — see
> [`../operations/fresh-database.md`](../operations/fresh-database.md). The rest
> of this page documents the retired package and the packages that replaced it;
> where it mentions migrations, treat those as historical.

## Layout

| Path | Contents | Managed by |
| --- | --- | --- |
| `/usr/lib/bibliograph` | retired combined payload; current packages use `/usr/lib/bibliograph-web` and `/usr/lib/bibliograph-worker` | dpkg (read-only) |
| `/etc/bibliograph/bibliograph.env` | All runtime configuration | dpkg conffile |
| `/etc/bibliograph/port.conf` | `PORT=…`, rendered from debconf | postinst |
| `/etc/nginx/sites-enabled/bibliograph-platform` | TLS server block + reverse proxy | dpkg conffile |
| `/etc/nginx/conf.d/bibliograph-upstream.conf` | `upstream bibliograph_backend` | postinst |
| `/var/lib/bibliograph/lex` | published lexicon CAR files | systemd `StateDirectory` |
| `/var/log/bibliograph` | pino per-process log files | systemd `LogsDirectory` |
| `/usr/lib/systemd/system/bibliograph.service` | web process | dpkg |
| `/usr/lib/systemd/system/bibliograph-worker.service` | catalog jobs + PDS outbox | dpkg |
| `/usr/lib/sysusers.d/bibliograph.conf` | `bibliograph` system user | dpkg |

There is no state directory for the application itself: every piece of state is
in PostgreSQL. `/var/lib/bibliograph` exists only to hold the lexicon CAR files
that the XRPC lex publisher serves.

## Units

The retired combined package ran one process plus a drizzle migrator. Current
deployments install separate packages:

| Unit | Runs | Why separate |
| --- | --- | --- |
| `bibliograph-web.service` | adapter-node `build/index.js` | the public edge; binds loopback and is proxied by nginx |
| `bibliograph-worker.service` | `node index.js` | catalog hydration and the PDS outbox must survive edge restarts and back off on their own |
| `happyview.service` | HappyView's host binary | activity index and Lua queries; loopback only |

There is **no `bibliograph-migrate.service` and no drizzle migrator**. A fresh
database is bootstrapped once with the versioned SQL (`mise run
catalog-schema`, or the documented `psql` command in
[`../operations/fresh-database.md`](../operations/fresh-database.md)). Later
numbered SQL files are applied the same way. Neither long-running unit migrates
on start, and no unit refuses to start because a migration is pending.

### Shutdown

Both long-running units stop on SIGTERM in well under a second:

| Process | What it does |
| --- | --- |
| `bibliograph-worker` | stops the outbox interval and lets graphile finish the current job, then exits 0 |
| `bibliograph-web` | `server.close()` + `closeAllConnections()`, then exits 0; a 10 s timer exits 1 if sockets refuse to go |

Signal handlers are registered *before* the dependency graph is imported — the
worker therefore uses `await import()` for its two internal modules, since a
static import would evaluate the whole graph (tsx loader, pino, `@atcute/tap`,
pg, graphile-worker) before any handler existed. That boot window was the source
of the `exit 143` / `Failed with result 'exit-code'` noise during upgrades.

Two related decisions:

- `SuccessExitStatus=143 130` is set on both units. A SIGTERM arriving in the
  first few hundred milliseconds, before the interpreter has loaded our module,
  still hits the default disposition; this keeps systemd from calling that a
  failure.
- If the task list ends *without* a signal, the worker throws and exits
  non-zero on purpose. Exiting 0 there would look like a clean stop and
  `Restart=on-failure` would never bring the consumer back.


## Host prerequisites

### Node.js is not bundled

The package `Depends: nodejs (>= 22.0.0)` and ships no runtime. Install it from
NodeSource:

```bash
install -d /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

cat > /etc/apt/sources.list.d/nodesource.sources <<'EOF'
Types: deb
URIs: https://deb.nodesource.com/node_22.x/
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
EOF

apt-get update
apt-get install -y nodejs
node --version   # must be >= v22.0.0
```

The distro's own `nodejs` (18.x on Debian 12 and Ubuntu 24.04) does **not**
satisfy the dependency, and apt reports the conflict instead of silently
running on 18.x.

### PostgreSQL

Only `Recommends: postgresql`, so a managed or remote instance is fine. Either
install it locally and create a role:

```bash
apt-get install -y postgresql
su - postgres -c "createuser bibliograph --pwprompt"
su - postgres -c "createdb -O bibliograph bibliograph"
```

or point `DATABASE_URL` at a remote server and open the firewall. Nothing
migrates automatically on service start: apply the catalog schema once with
`mise run catalog-schema` (or the `psql` command in
[`../operations/fresh-database.md`](../operations/fresh-database.md)).

### Activity plane and PDS

HappyView and rsky-pds are separate Debian packages installed by the infra
repository. The app process only needs their loopback origins and credentials:
`HAPPYVIEW_URL`, `HAPPYVIEW_CLIENT_KEY`, `HAPPYVIEW_CLIENT_SECRET`,
`HAPPYVIEW_ADMIN_KEY`, `PDS_URL`, `PDS_ACCOUNT_DID` and
`PDS_ACCOUNT_PASSWORD`. Without them the edge still serves catalog reads, but
activity queries answer `502 UpstreamUnavailable` and the outbox cannot publish.

## Install and operate

```bash
apt-get install -y ./bibliograph_0.5.16_amd64.deb
$EDITOR /etc/bibliograph/bibliograph.env   # fill in the REQUIRED entries
systemctl restart bibliograph bibliograph-worker
systemctl status bibliograph bibliograph-worker
journalctl -u bibliograph -u bibliograph-worker -f
```

Required entries have no defaults: `DATABASE_URL`, `ATP_LABEL_SIGNING_KEY`,
`HAPPYVIEW_CLIENT_KEY`, `HAPPYVIEW_CLIENT_SECRET`, `HAPPYVIEW_ADMIN_KEY`,
`PDS_ACCOUNT_DID`, `PDS_ACCOUNT_PASSWORD` and `ADMIN_TOKEN`. The conffile marks
each one.

## Signing keys

The publisher repo is written through the PDS session, so the app no longer
holds a repo-signing key. It holds one K-256 labeler key:

```bash
pnpm --filter bibliograph-service label-keygen
```

Publish the public half in the DID document under `#atproto_label`. Lexicons are
published to the PDS with:

```bash
pnpm --filter bibliograph-service pds:publish-lexicons
```

`com.atproto.lexicon.resolveLexicon` is served at the edge from the build-time
lexicon map; the protocol endpoints (`com.atproto.repo.*`, `sync.*`,
`identity.*`) are proxied to the PDS.

`apt upgrade` treats `/etc/bibliograph/bibliograph.env` as a conffile and prompts
instead of overwriting local edits. debhelper's generated `postinst` restarts
both long-running units after an upgrade. Catalog schema upgrades, when a release
ships a new numbered SQL file, are applied with `mise run catalog-schema`.

## nginx and TLS

The package depends on `nginx` and installs one conffile,
`/etc/nginx/sites-available/bibliograph-platform`, for
`biblio.livtet.olamaelcu.net`: port 80 redirects to HTTPS and serves the
`/.well-known/acme-challenge/` path from `/var/lib/certbot` (the host's certbot
`webroot_path`); port 443 terminates TLS and proxies to `127.0.0.1`.

The site is **staged, not enabled**. The `postinst` symlinks it into
`sites-enabled` only once the certificate exists, because an enabled server
block pointing at a missing `ssl_certificate` makes `nginx -t` fail globally and
keeps nginx from starting after a reboot — taking every other vhost on the host
with it. This is the same arrangement the Livtet package uses.

Certificates are the host's job — this package never calls certbot. To bootstrap
one and enable the vhost:

```bash
mise run enable-tls     # obtain the cert, re-run the postinst, verify HTTPS
```

That task issues the certificate with the webroot authenticator against
`/var/lib/certbot`, using a temporary :80 server block for this name only (the
host's `:80` default server answers 444 for unknown names, so the challenge
needs somewhere to land before the real vhost can be enabled). It then runs
`dpkg-reconfigure bibliograph`, which is the hook that performs the symlink, and
verifies `https://<host>/health` through loopback and from the caller. Renewal
afterwards belongs to the host's `certbot.timer`.

To enable the site by hand, once a certificate is in place:

```bash
dpkg-reconfigure bibliograph
```

### The label stream needs an Upgrade

`location = /xrpc/com.atproto.label.subscribeLabels` is a dedicated proxy block
that forwards `Upgrade`/`Connection` and uses HTTP/1.1. Without it the handshake
is proxied as a plain GET and every label consumer sees a 404. This is also why
the units run `server.ts`: adapter-node's generated `build/index.js` builds its
own `http.Server` internally and offers no `upgrade` hook.

The ordinary `location /` block clears `Connection`, so normal requests stay
poolable instead of asking for an upgrade.

### Application port (debconf)

The port the app binds is the debconf question `bibliograph/port`, default
`5000`. It is the single source of truth for both sides of the proxy:

| Generated file | Contents |
| --- | --- |
| `/etc/bibliograph/port.conf` | `PORT=5000`, read by `bibliograph.service` |
| `/etc/nginx/conf.d/bibliograph-upstream.conf` | `upstream bibliograph_backend { server 127.0.0.1:5000; }` |

Neither is a conffile; the `postinst` renders both from
`/usr/share/bibliograph/bibliograph-upstream.conf.in`. The site file stays a
conffile and only says `proxy_pass http://bibliograph_backend;`.

```bash
dpkg-reconfigure bibliograph          # re-renders both, validates nginx, restarts on change
echo "bibliograph bibliograph/port string 5001" | debconf-set-selections   # unattended
```

`PORT` in `bibliograph.env` is deliberately ignored: the unit reads `port.conf`
after the env file, so the debconf answer wins.

## Building the package

```bash
mise run package-payload     # stage ./packaging/payload/app
mise run package-deb         # payload, then dpkg-buildpackage → dist/bibliograph_*.deb
mise run package-verify-deb  # layout, conffiles, maintainer scripts, units, nginx wiring
mise run deploy-deb          # install on DEPLOY_HOST, provision PostgreSQL
mise run enable-tls          # certificate + enable the nginx vhost
```

The tasks are file-based Mise tasks in `.mise/tasks/`; `package-deb` declares
`depends=["package-payload"]`, so the two steps cannot be run in the wrong
order. The `pnpm pkg:*` scripts in the root `package.json` forward to them for
callers that only know pnpm.

Requirements: Mise, `debhelper (>= 13)`, `dpkg-dev`, `fakeroot`, `rsync`,
Node, pnpm.

Unlike the Livtet payload, this one is **not** built in a container. There is no
native addon: the only ELF object is esbuild's bundled binary, which arrives
prebuilt per architecture from the npm registry via `tsx`. The package is
therefore `Architecture: any` and is built for the host's architecture.

`mise run package-payload` builds with the full dev dependency set (the build
regenerates the gitignored lexicon modules into `src/`), stages the runtime
files, then runs `pnpm install --prod --ignore-scripts --frozen-lockfile` inside
the payload so the shipped `node_modules` holds production dependencies only. It
fails closed if `build/handler.js`, the generated lexicons, the drizzle journal,
or `node_modules/.bin/tsx` is missing, and if a build-only devDependency is
linked as a direct dependency.

Note that `typescript` *is* present in the production tree, transitively via
`cosmiconfig` (graphile-worker) and `valibot`. That is unavoidable and harmless.

## HappyView as its own package

`bibliograph-happyview` ships HappyView's host binary, its Postgres migrations
and the built dashboard, extracted from the pinned container image — no Node or
container runtime is needed. It installs beside `bibliograph`, not instead of
it.

```bash
mise run package-hv-payload   # binary + migrations + dashboard from the pinned image
mise run package-hv-deb       # dpkg-deb → dist/bibliograph-happyview_2.17.4-1_amd64.deb
```

It is deliberately not built by `debian/rules`: that tree assembles the
application package from a Node payload staged by `package-payload`, which
needs the SvelteKit server sources. HappyView has no Node payload and must be
installable on its own, so `packaging/happyview/build-deb.sh` assembles it with
`dpkg-deb` while keeping the same conventions — `/usr/lib/bibliograph-happyview`,
`/etc/bibliograph/happyview.env`, the shared `bibliograph` sysuser.

| Path | Contents |
| --- | --- |
| `/usr/lib/bibliograph-happyview/happyview` | server binary; the unit's WorkingDirectory, because migrations load from `./migrations/postgres` |
| `…/migrations`, `…/static` | schema migrations, built dashboard |
| `…/lexicons`, `…/scripts`, `…/lib`, `…/sql` | exactly what the deploy oneshot uploads, from this checkout |
| `…/bin/hv-deploy` | the same tool `mise run hv-deploy` runs |
| `/etc/bibliograph/happyview.env` | conffile; `DATABASE_URL` is the only required entry |
| `/usr/share/bibliograph-happyview/db-init.sql` | one-time role + `happyview` schema creation |

```bash
sudo apt install ./dist/bibliograph-happyview_2.17.4-1_amd64.deb
# once, if the role and schema do not exist yet:
sudo -u postgres psql -v db=<database> -f /usr/share/bibliograph-happyview/db-init.sql
# then set DATABASE_URL, SESSION_SECRET and TOKEN_ENCRYPTION_KEY in
# /etc/bibliograph/happyview.env and restart:
sudo systemctl restart happyview bibliograph-happyview-deploy
```

`happyview.service` binds `127.0.0.1:3000`; the application stays the public
origin and proxies `/xrpc` to it. `bibliograph-happyview-deploy.service` runs at
install and on every upgrade: with `--seed` it mints an admin key into
`/etc/bibliograph/happyview-admin.key` on first run (a fresh HappyView has no
credentials with which to accept an upload), then uploads the lexicons and
scripts and applies the activity indexes. `DATABASE_URL` doubles as its SQL
connection; set `HV_DATABASE_URL` only to deploy against a different database
than the server uses.

`bibliograph-happyview-client.service` runs **before** HappyView starts
(`Before=happyview.service` in the client unit, `After=`/`Wants=` in
`happyview.service`). It seeds the edge's XRPC client: on first run it mints an
`hvc_`/`hvs_` pair, writes it 0640 root:bibliograph to
`/etc/bibliograph/happyview-client.env`, and stores only the secret's SHA-256.
The ordering is not cosmetic — HappyView loads client identities into memory at
boot, so a row inserted afterwards is invisible until a restart. Re-running
reuses the pair; `hv-client --force` mints a new one, after which the edge needs
a restart.

For a host whose configuration is managed outside this package (Ansible, in
`infra/`), the units also load `/etc/bibliograph/happyview.local` **after** the
conffile, so that file wins. Put `DATABASE_URL` and the two secrets there and
leave `happyview.env` untouched — a dpkg conffile edited by a configuration
manager turns every upgrade into a prompt. `hv-client`, `happyview` and the
deploy oneshot all load it, so the value is shared by everything that talks to
the database.

The package is `Architecture: any` because the binary links the host's glibc and
`libssl3`, but it is only correct for the architecture of the image it was
extracted from. It builds clean under `lintian` apart from the
initial-upload-with-no-bug warning.

## The web edge as its own package

`bibliograph-web` ships the adapter-node build of `packages/web`: the public
SvelteKit origin, which proxies `/xrpc` to HappyView. It bundles no runtime —
the output is self-contained JavaScript (~2 MB, 320 KB packaged) and the package
depends on the host's `nodejs` — so it is `Architecture: all`.

```bash
mise run package-web-payload   # pnpm --filter web build → packaging/payload/web/build
mise run package-web-deb       # dpkg-deb → dist/bibliograph-web_0.1.0-1_all.deb
```

| Path | Contents |
| --- | --- |
| `/usr/lib/bibliograph-web/build` | adapter-node output: `index.js`, `handler.js`, `client/`, `server/` |
| `/etc/bibliograph/web.env` | conffile: `HOST`/`PORT`, `HAPPYVIEW_URL`; client credentials are read from HappyView's generated file |
| `/usr/lib/systemd/system/bibliograph-web.service` | `/usr/bin/node …/build/index.js`, binds `127.0.0.1:5176` |

```bash
# HappyView first: `apt install ./bibliograph-web_*.deb` on its own fails on the
# unsatisfied dependency rather than installing an edge with no upstream.
sudo apt install ./dist/bibliograph-happyview_*.deb
sudo apt install ./dist/bibliograph-web_*.deb
# nothing to configure: the unit also loads /etc/bibliograph/happyview-client.env,
# which the HappyView package generated
```

The edge's unit loads two environment files, in order:
`/etc/bibliograph/web.env` then `/etc/bibliograph/happyview-client.env`. The
second is written by `bibliograph-happyview-client.service` and wins, so the
`hvc_`/`hvs_` pair exists without any manual copy step. Setting the pair in
`web.env` still overrides it, which is the escape hatch when pointing an edge at
a HappyView elsewhere.

`bibliograph-web` **Depends** on `bibliograph-happyview` — the edge has no
upstream without it, and the pair is configured in that order (HappyView before
the edge). `apt-get install ./bibliograph-web_*.deb` on its own fails with an
unsatisfiable dependency rather than installing a service that cannot proxy
anything.

The edge holds no state and no user session: it injects the configured XRPC
client identity and relays `Authorization`/`DPoP` untouched, so procedures still
require the caller to bring a session (see `docs/happyview.md`). The unit binds
loopback only; terminate TLS in front of it.

The dependency is `nodejs (>= 20)`. Debian 12 and Ubuntu 24.04 ship 18, so
install a newer Node from the NodeSource repository before installing this
package (the same constraint the retired application package documented).

`bibliograph-web` and `bibliograph-happyview` install side by side: distinct
trees under `/usr/lib`, distinct conffiles, one shared `bibliograph` sysuser that
either package creates if it is missing. Extracting both into one root shows no
path collisions outside the standard directories. The dependency is one-way —
HappyView does not know about the edge — so HappyView can be installed, deployed
and tested on its own, and only the edge requires the pair.

## Why a package instead of a container

The Dokku/Docker path (image build, `Procfile`, push-to-deploy) was retired with
0.1.5. Nothing in the repository builds a container any more; this table is the
rationale for what replaced it.

| Container deploy (before) | Debian package (now) |
| --- | --- |
| `ENTRYPOINT` ran the old migrator then exec'd the web process | no migrator; the schema is applied once from `packages/worker/sql/`, then separate web/worker units start |
| process types declared in a `Procfile` | `bibliograph-worker.service` (catalog jobs + PDS outbox) |
| environment baked into the image | `/etc/bibliograph/bibliograph.env` conffile, 0640 root:root, read by PID 1 |
| `EXPOSE 5000`, `HOST=0.0.0.0` behind the platform proxy | unit binds `127.0.0.1`; the package ships the nginx site that proxies to it |
| `docker save` + `rsync` + `docker load` | `apt install`, previous version kept in the apt cache |
| logs to stdout captured by the container runtime | pino files under `/var/log/bibliograph` plus stdout in the journal |

## Upgrade and rollback

```bash
apt-get update && apt-get install -y --only-upgrade bibliograph
apt-get install -y bibliograph=0.5.15   # rollback is a version pin
apt-mark hold bibliograph
```

Schema changes are forward-only: an older package must not be run against a
database a newer one has migrated. Apply new numbered files from
`packages/worker/sql/` before starting the new units; the files are additive and
idempotent, and never drop existing data.
