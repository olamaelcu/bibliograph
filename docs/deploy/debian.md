# Debian package deployment

How Bibliograph is packaged and installed as a native Debian package, following
the same shape as the Livtet platform package (`../platform/debian`): a prebuilt
payload under `/usr/lib`, a conffile under `/etc`, systemd-owned writable paths,
and an nginx site generated around a debconf-selected port.

## Layout

| Path | Contents | Managed by |
| --- | --- | --- |
| `/usr/lib/bibliograph` | vite output, the TypeScript sources `tsx` runs, generated lexicon modules, drizzle migrations, production `node_modules` | dpkg (read-only) |
| `/etc/bibliograph/bibliograph.env` | All runtime configuration | dpkg conffile |
| `/etc/bibliograph/port.conf` | `PORT=…`, rendered from debconf | postinst |
| `/etc/nginx/sites-enabled/bibliograph-platform` | TLS server block + reverse proxy | dpkg conffile |
| `/etc/nginx/conf.d/bibliograph-upstream.conf` | `upstream bibliograph_backend` | postinst |
| `/var/lib/bibliograph/lex` | published lexicon CAR files | systemd `StateDirectory` |
| `/var/log/bibliograph` | pino per-process log files | systemd `LogsDirectory` |
| `/usr/lib/systemd/system/bibliograph.service` | web process | dpkg |
| `/usr/lib/systemd/system/bibliograph-worker.service` | TAP consumer | dpkg |
| `/usr/lib/systemd/system/bibliograph-migrate.service` | oneshot migrator | dpkg |
| `/usr/lib/sysusers.d/bibliograph.conf` | `bibliograph` system user | dpkg |

There is no state directory for the application itself: every piece of state is
in PostgreSQL. `/var/lib/bibliograph` exists only to hold the lexicon CAR files
that the XRPC lex publisher serves.

## Three units, not one

The Livtet package runs a single process. Bibliograph has three:

| Unit | Runs | Why separate |
| --- | --- | --- |
| `bibliograph.service` | `tsx server.ts` | The WebSocket label stream needs the `upgrade` event, so the package runs the custom entrypoint, not `build/index.js` |
| `bibliograph-worker.service` | `tsx worker.ts` | TAP consumption must survive web restarts and back off on its own |
| `bibliograph-migrate.service` | `tsx src/lib/server/db/migrate.ts` | `Type=oneshot`, `Requires=`d by both. No `RemainAfterExit`, so it re-runs every time either unit starts — that is how an upgrade applies new migrations |

The migrator fails closed: any unrecognized PostgreSQL error aborts it, and the
units that require it refuse to start, rather than serving traffic against a
stale schema. It is idempotent — drizzle records applied migrations in
`drizzle.__drizzle_migrations`.

### Shutdown

Both long-running units stop on SIGTERM in well under a second:

| Process | What it does |
| --- | --- |
| `bibliograph-worker` | flushes the TAP batch buffers, asks the subscription to close its websocket (bounded at 200 ms, because the iterator's `return()` does not settle a pending `next()`), then exits 0 |
| `bibliograph.service` | `server.close()` + `closeAllConnections()`, then exits 0; a 10 s timer exits 1 if sockets refuse to go |

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
- If the TAP subscription ends *without* a signal, the worker throws and exits
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

or point `DATABASE_URL` at a remote server and open the firewall. Migrations run
automatically on service start.

### TAP

The worker consumes an ATProto TAP service. Set `TAP_URL` and
`TAP_ADMIN_PASSWORD`; without them the worker exits and restarts in a loop, and
the index stops advancing. The web process is unaffected.

## Install and operate

```bash
apt-get install -y ./bibliograph_0.1.0_amd64.deb
$EDITOR /etc/bibliograph/bibliograph.env   # fill in the REQUIRED entries
systemctl restart bibliograph bibliograph-worker
systemctl status bibliograph bibliograph-worker
journalctl -u bibliograph -u bibliograph-worker -f
```

Required entries have no defaults: `DATABASE_URL`, `TAP_URL`,
`TAP_ADMIN_PASSWORD`, `ATP_SIGNING_KEY`, `ATP_LABEL_SIGNING_KEY`. The conffile
marks each one.

## Signing keys

Two independent K-256 keypairs. Generate them **on the host** so the private
halves never leave it, and never commit them:

```bash
cd /usr/lib/bibliograph/packages/bibliograph-service
export LEX_PUBLISHER_HOSTNAME=biblio.livtet.olamaelcu.net

# repository / lex publisher:  ATP_SIGNING_KEY + ATP_SERVICE_KEY_MULTIBASE
./node_modules/.bin/tsx scripts/gen-lex-publisher-key.ts

# labeler:                     ATP_LABEL_SIGNING_KEY + ATP_LABEL_KEY_MULTIBASE
./node_modules/.bin/tsx scripts/gen-label-key.ts
```

Each script prints a **private** half (`*_SIGNING_KEY`, 64 hex chars) and the
matching **public** half (`*_MULTIBASE`, `zQ3s…`). They are two halves of one
keypair: the private key signs, the public key is what verifiers resolve. Note
the asymmetry in the variable names — the DID document publishes `#atproto`
from `ATP_SERVICE_KEY_MULTIBASE` and `#atproto_label` from
`ATP_LABEL_KEY_MULTIBASE`, so setting `ATP_SIGNING_KEY` alone leaves `#atproto`
at the placeholder.

Put all four values in `/etc/bibliograph/bibliograph.env`, then
`systemctl restart bibliograph`. The keys are exposed at
`https://biblio.livtet.olamaelcu.net/.well-known/did.json`; until they are set,
`did.ts` serves `z6Mkplaceholder…` and logs a `[did] … is not set` warning per
missing variable.

Keep the two pairs distinct: the labeler key must be rotatable without touching
repository signing, and the blast radii differ. A wrong public half makes every
label signature invalid, because verifiers check each label against the key
resolved from the DID document. Changing either key therefore invalidates
everything signed with the old one.

## Lexicon publication

The DID document advertises `#atproto_pds` because that is the only discovery
hook ATProto offers for fetching a DID's repository. The chain a resolver walks
is:

```
com.atproto.lexicon.resolveLexicon
  -> resolve did:web:biblio.livtet.olamaelcu.net
  -> service #atproto_pds  (this host)
  -> com.atproto.sync.getRecord for com.atproto.lexicon.schema/<nsid>
```

The app does not run a PDS. It serves a **read-only, single-repo** surface built
offline from `lexicons/**/*.json` and signed with `ATP_SIGNING_KEY`:

```bash
mise run publish-lex     # also runs automatically from deploy-deb once a key exists
```

That writes into `LEX_OUT_DIR` (`/var/lib/bibliograph/lex`):

| File | Contents |
| --- | --- |
| `full.car` | commit + MST + every schema record (`sync.getRepo`) |
| `<nsid_safe>.car` | commit + MST proof + one record (`sync.getRecord`) |

The directory is a systemd `StateDirectory` (`StateDirectory=bibliograph
bibliograph/lex`), so it is created with the right ownership; the publisher
reads the files per request, so publishing needs no restart.

Implemented verbs: `sync.getRepo`, `getRepoStatus`, `getLatestCommit`,
`getBlocks`, `getRecord` (only for `com.atproto.lexicon.schema`),
`repo.getRecord`, `repo.describeRepo`, `identity.resolveHandle/resolveDid/
resolveIdentity` (only this DID), and `server.describeServer`. There are **no
write paths** — `createRecord`, `uploadBlob`, `createAccount` are absent, so
anything treating this as a general PDS will fail on account operations.

Publishing is what makes the DID claim true. Without CARs, every `sync.*` and
`repo.*` call answers `400 RepoNotFound` — which is what a fresh install looks
like before the first publish. Verify end to end with the canonical resolver
(it walks the local lexicon sources, resolves over https, and checks signatures):

```bash
pnpm --filter bibliograph-service exec tsx scripts/verify-resolver.ts
```

`apt upgrade` treats `/etc/bibliograph/bibliograph.env` as a conffile and prompts
instead of overwriting local edits. debhelper's generated `postinst` restarts
both long-running units after an upgrade, which re-runs the migrator.

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

## What differs from the Docker/Dokku path

| Before (Docker + Procfile) | Now (Debian package) |
| --- | --- |
| `ENTRYPOINT` ran the migrator then exec'd the web process | dedicated oneshot unit, `Requires=`d by both long-running units |
| `Procfile` `worker:` line | `bibliograph-worker.service` |
| `ENV` baked into the image | `/etc/bibliograph/bibliograph.env` conffile, 0640 root:root, read by PID 1 |
| `EXPOSE 5000`, `HOST=0.0.0.0` behind Dokku's proxy | unit binds `127.0.0.1`; the package ships the nginx site that proxies to it |
| `docker save` + `rsync` + `docker load` | `apt install`, previous version kept in the apt cache |
| logs to stdout captured by Docker | pino files under `/var/log/bibliograph` plus stdout in the journal |

## Upgrade and rollback

```bash
apt-get update && apt-get install -y --only-upgrade bibliograph
apt-get install -y bibliograph=0.1.0   # rollback is a version pin
apt-mark hold bibliograph
```

Schema changes are forward-only: an older package must not be run against a
database a newer one has migrated.
