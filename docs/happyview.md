# HappyView (activity plane)

HappyView owns the `happyview` schema, indexes activity records, and serves the
activity queries. Locally it runs as a self-contained atproto network: its own
PLC directory and PDS, a Caddy that terminates TLS for the PDS, and no
dependency on `plc.directory` or any public relay.

The stack is `docker-compose.yml`; the tasks are `.mise/tasks/hv-*`.

## Topology

```mermaid
flowchart LR
  browser -->|"http://127.0.0.1:3000"| hv["happyview<br/>2.17.4"]
  browser -->|"https://pds.127-0-0-1.sslip.io"| caddy["caddy<br/>internal CA"]
  caddy --> pds["pds<br/>tranquil 0.7.1"]
  hv -->|"PLC_URL"| plc["plc<br/>did-method-plc"]
  hv -->|"DID doc → service endpoint"| caddy
  hv -->|"RELAY_URL listRepos"| pds
  pds -->|"registers did:plc"| plc
  plc --> pg[("postgres: plc")]
  pds --> pg2[("postgres: pds")]
  hv --> pg3[("postgres: bibliograph<br/>schema happyview")]
```

| Service | Host address | Notes |
| --- | --- | --- |
| `happyview` | `http://127.0.0.1:3000` | dashboard at `/`, redirects to `/dashboard/`; `/xrpc/*`, `/admin/*` |
| `pds` | `https://pds.127-0-0-1.sslip.io` | HTTPS only, via Caddy |
| `plc` | `http://127.0.0.1:2582` | `<did>` path returns the DID document |
| `caddy` | `:80`, `:443` | redirects 80→443; `pds.127-0-0-1.sslip.io` proxies the whole PDS, `*.pds.127-0-0-1.sslip.io` proxies only `/.well-known/*` and `/xrpc/*` and 301s every other path to the canonical host |
| `postgres` | `127.0.0.1:5432` | databases `bibliograph`, `plc`, `pds` |
| `prometheus` | `127.0.0.1:9090` | unchanged from before HappyView |

## Pinned images

Pinned by **index digest**, not tag. `2.17.4` never moves, but `latest` on the
`pds-test` images does; a digest is the only pin that survives an upstream
rebuild.

| Image | Digest |
| --- | --- |
| `ghcr.io/gamesgamesgamesgamesgames/happyview` | `sha256:a981c30cb2bdad83413aa3126fb0eab6782427d0565f35e8b7349c098de2c841` |
| `ghcr.io/happyproto/pds-test/plc` | `sha256:6e61dc9c59d79cbc8b6cdcaac7464ae16258849ada92dd7cbbfc6d7979a81c3a` |
| `ghcr.io/happyproto/pds-test/tranquil` | `sha256:96f4ce1f9eec42ca17e4f6d693f6ae842ffe1618f97c9f51c5604116fb9483ed` |
| `mailtrap/mailtrap-local` | `sha256:6bada103dffdec9a86e6f2fcb7631f173f0ff3af65f8c5ec80f10becb1469316` |

`plc` is did-method-plc's own server, so the DIDs the PDS mints are real
`did:plc` DIDs that anything pointed at `PLC_URL` can resolve. `tranquil` is the
PDS implementation HappyView's own e2e suite runs. `mailtrap-local` catches
every notification the PDS sends, so account flows never reach the internet;
`docs/dev-environment.md` covers its inbox and API.

## Bring-up

```bash
docker compose up -d                # postgres, plc, pds, mailtrap, caddy, happyview, prometheus
mise run hv-account                 # mint alice.pds.127-0-0-1.sslip.io
mise run hv-seed                    # make it superuser; write admin key + XRPC client
mise run hv-ca                      # trust Caddy's CA in Chrome and Firefox
```

On a volume created before the local network existed, `mise run hv-dbs` adds the
`plc` and `pds` databases. `docker/postgres-init.sql` does the same on a fresh
volume.

## Provisional account

| Value | |
| --- | --- |
| handle | `alice.pds.127-0-0-1.sslip.io` |
| password | `Dev-account-password1` (PDS login only) |
| DID | a `did:plc:…` registered in the local PLC — read it back with `mise run hv-seed` or `resolveHandle` |

`mise run hv-account` is idempotent. Password policy is the PDS's: at least one
uppercase letter and one digit.

`mise run hv-seed` runs `docker/seed-local-admin.sql`, which writes four kinds of
rows:

| Table | Row | Why |
| --- | --- | --- |
| `happyview_users` | the account DID, `is_super = 1` | dashboard admits only known DIDs; superuser can manage the instance |
| `happyview_user_permissions` | all 51 permissions | see below |
| `happyview_api_keys` | `hv_dev_admin` | `Authorization: Bearer` on `/admin/*` |
| `happyview_api_clients` | `hvc_dev_client` / `hvs_dev_secret` | `X-Client-Key` + `X-Client-Secret` on `/xrpc/*` |

The permissions are materialised on both the user and the key deliberately: the
API-key path computes `key.permissions ∩ user.permissions` and never consults
`is_super` (that short-circuit exists only for cookie sessions). A superuser
with no permission rows authenticates and then fails every request with
`Missing permission: <perm>`.

## Why each piece is shaped this way

These are not arbitrary; each one is the fix for a failure observed while
building the stack.

- **`PUBLIC_URL` is `http://127.0.0.1:3000`, a loopback name.** `is_loopback_url`
  then makes HappyView the spec's localhost OAuth client
  (`client_id=http://localhost?...`), so the PDS synthesises its client metadata
  instead of fetching it — TLS trust only has to work one way. The scheme must
  be `http`: with an `https` loopback URL HappyView panics at boot with
  `ClientMetadata(LocalhostClient(NotHttpScheme))`.
  This is the local compose stack; the lescayes deployment switches to the
  tailnet origin with `BASE_PATH=/hv` — see
  [Production: tailnet-only dashboard at `/hv`](#production-tailnet-only-dashboard-at-hv).
- **The PDS hostname is `pds.127-0-0-1.sslip.io`, not `pds.localhost`.** Handle
  domains cannot be under a reserved TLD; `createAccount` answers *"This
  server's handle domain has a reserved TLD"* for `.localhost` and `.test`.
  Every `*.127-0-0-1.sslip.io` name resolves to 127.0.0.1 through public DNS,
  so no `/etc/hosts` entry is needed, and Docker network aliases cover the
  container-to-container path.
- **Handle hosts serve resolution and XRPC only; the app surface is canonical.**
  `https://alice.pds.127-0-0-1.sslip.io/app/login` 301s to
  `https://pds.127-0-0-1.sslip.io{uri}`, as does every other handle-host path
  except `/.well-known/*` and `/xrpc/*`. The PDS account-manager SPA derives its
  OAuth `client_id` from `window.location.origin`, but the PDS publishes client
  metadata for one canonical origin, so a login started on a handle host fails
  PAR with `client_id in metadata does not match request` — the PDS fetches the
  handle host's copy of `/oauth-client-metadata.json`, which declares
  `https://pds.127-0-0-1.sslip.io/oauth-client-metadata.json`. A handle-host tab
  opened before the redirect existed still holds the old origin; reload it.
- **`ALLOW_PRIVATE_FETCH=true` on the PDS.** The PLC is a compose-network
  address; without it the PDS's SSRF guard rejects its own DNS answer
  (`no resolved address for plc is inside the allowed host reach`) and account
  creation cannot register a `did:plc`.
- **`CRAWLERS=""` on the PDS.** Unset, it announces every new repo to eight
  public relays, which then try to crawl a hostname that resolves to their own
  loopback. Empty disables the service.
- **`ALLOW_PRIVATE_DESTINATIONS=true` on HappyView.** The PDS named in a DID
  document is a private address here, which HappyView otherwise refuses to
  connect to. It logs a warning at every boot while set.
- **Caddy's CA is installed inside the HappyView container**
  (`docker/happyview-local-entrypoint.sh`): HappyView fetches PDS authorization
  metadata and DID documents over TLS. The reverse direction is not needed,
  because of the loopback client above.
- **HappyView's healthcheck probes `/health` over bash's `/dev/tcp`.** The
  runtime image ships no `wget`, `curl`, `busybox` or `nc`, so the `wget`-based
  probe the upstream dev compose uses can never pass; this is the one from the
  published production compose.
- **Jetstream is closed** (`ws://127.0.0.1:1`) so no public records enter the
  index, and `RELAY_URL` points at the local PDS's `listRepos` so backfill can
  enumerate the local repo. Expect a `jetstream disconnected` warning a minute.
- **`happyview_app` has its own `search_path` (`happyview,public`)**, so
  HappyView's unqualified migrations and `db.raw` calls land in the `happyview`
  schema instead of colliding with the catalog's `public` tables.
- **The PDS cannot reach its lexicon authority** (`extra_hosts` maps
  `biblio.livtet.olamaelcu.net` to the container's own loopback). These NSIDs
  resolve through DNS TXT to that host, and its published `follow` schema types
  `subject` as an at-uri — so every local follow write was rejected with
  `Invalid field 'subject': invalid format: AtUri`. With the fetch failing, the
  PDS records `validationStatus: unknown` and accepts the record. The cost is
  that no record in this network is validated against the deployed schemas.

## Calling it from the SvelteKit edge

Server-side only; HappyView is not the public origin. `packages/web` implements
this — `mise run web` serves the edge on `127.0.0.1:5176`, and
`src/lib/server/happyview.ts` is the only place that holds the client
credentials.

```ts
import { env } from "$env/dynamic/private";
const HAPPYVIEW = env.HAPPYVIEW_URL ?? "http://127.0.0.1:3000";

// Query
await fetch(`${HAPPYVIEW}/xrpc/net.olamaelcu.livtet.biblio.listShelves?did=${did}`, {
  headers: {
    "X-Client-Key": env.HAPPYVIEW_CLIENT_KEY!,
    "X-Client-Secret": env.HAPPYVIEW_CLIENT_SECRET!,
  },
});
```

- **The proxy owns the client identity.** Caller-supplied `X-Client-Key` and
  `X-Client-Secret` are never forwarded; the edge drops them and sets its own
  from env, so a browser cannot choose which client HappyView sees.
- **Queries** work anonymously. HappyView requires `X-Client-Key` only on
  *authenticated* (DPoP) requests, and an unknown key is a warning, not a
  rejection — so the header is there for rate limiting and caller attribution,
  not access control.
- **Procedures** need a user session, and the edge cannot supply one. The calling
  server's flow is: `POST /oauth/dpop-keys` (client key + secret), run OAuth
  against the PDS with the returned keypair, `POST /oauth/sessions`, then send
  `Authorization: DPoP <token>` plus a fresh `DPoP` proof on the proxied call.
  HappyView proxies the write to the PDS with its stored session.
- **Unknown methods return 502**, not 404. Do not map that to "upstream down".
- `BASE_PATH` is supported and moves every route under it; `/health` stays at
  the root. See [Production: tailnet-only dashboard at `/hv`](#production-tailnet-only-dashboard-at-hv).
- The seeded client's `client_uri` is `http://127.0.0.1:5176`, so the dev server
  binds `127.0.0.1` (not `localhost`, which Vite resolves to `::1`, leaving the
  origin mismatched) on port 5176; the `Origin` check then stays quiet.
- `packages/web` runs SvelteKit 3 with Vite 8. Kit 3 rejects a
  `svelte.config.js` (`config_file_unsupported`) — adapter and server settings
  live in `vite.config.ts`, and runtime variables must be declared in
  `src/env.ts` with `defineEnvVars` or `$env/dynamic/private` will not expose
  them.

## Writes

HappyView never writes a repo. Records are written to the **PDS** by whoever
holds the user's session — the calling server (Livtet), not this edge, which
only relays credentials — and the AppView indexes what it can see:

| Path | Endpoint | Indexed immediately? |
| --- | --- | --- |
| App → PDS (normal) | `com.atproto.repo.{createRecord,putRecord,applyWrites}` on `https://pds.127-0-0-1.sslip.io` | no — needs Jetstream or backfill |
| App → HappyView procedure | `POST /xrpc/<nsid>` with a DPoP session | yes — `procedure.rs` upserts `happyview_records` after the PDS accepts the write |

Fifteen procedures implement the write side, so a client calls HappyView instead
of assembling records itself. Each is a lexicon (`type: procedure`) plus a
script at `xrpc.procedure:<nsid>`; the collection travels as `target_collection`
at upload, and a successful PDS write is indexed in the same request.

| Group | NSIDs |
| --- | --- |
| Follow graph | `graph.follow`, `graph.unfollow` — the rkey is an opaque TID; `graph.follow` looks up the subject so a repeat is a no-op |
| Shelves | `shelf.create`, `shelf.update`, `shelf.delete` — delete cascades `shelfItem` and `bookStatus` rows that name the shelf |
| Membership | `shelf.addItem`, `shelf.removeItem`, `shelf.addBooks` — the rkey is a fresh TID, so the edge is found by `record.shelf` + `record.book.uri` |
| Reading status | `status.set`, `status.clear` — the rkey is a fresh TID, so the row is found by `record.book.uri`; metadata merges |
| Reader | `readingGoal.set` (rkey `current`), `profile.set` (rkey `self`) |
| Reviews | `review.create`, `review.update`, `review.delete` |

All fifteen answer `401 XRPC procedures require DPoP authentication` until the
caller presents a DPoP-bound session, because the write is proxied to the
caller's PDS. The edge holds no session of its own — it injects its XRPC client
identity and relays `Authorization` and `DPoP` untouched, so credentials are the
caller's responsibility (see Calling it from the SvelteKit edge).

The token in that session needs `transition:generic`: HappyView proxies the
write with it, and `atproto` alone grants no repo write. HappyView also refuses
a session whose scopes exceed its API client's registered ones, so the client is
registered for both.

Inline indexing was verified end to end while a local session harness existed:
`POST /xrpc/…shelf.create` returned the new shelf URI and `listShelves` included
it immediately, no backfill. Without such a session, the same data has to be
written to the PDS directly and backfilled — the sequence below:

```bash
# 1. write as the user (dev shape; in the app this is the user's OAuth session)
JWT=$(curl -sk -X POST https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"alice.pds.127-0-0-1.sslip.io","password":"…"}' | jq -r .accessJwt)

curl -sk -X POST https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.repo.putRecord \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"repo":"did:plc:…","collection":"net.olamaelcu.livtet.biblio.shelf",
       "rkey":"dev-shelf","record":{"name":"Dev shelf","createdAt":"…","updatedAt":"…"}}'

# 2. the query still answers empty, because nothing told the AppView

# 3. index it
curl -X POST -H 'Authorization: Bearer hv_dev_admin' -H 'content-type: application/json' \
  -d '{"did":"did:plc:…","collection":"net.olamaelcu.livtet.biblio.shelf"}' \
  http://127.0.0.1:3000/admin/backfill
```

The job reports `completed` with `1` record and `listShelves` then returns the
shelf. Backfill walks `RELAY_URL` (`com.atproto.sync.listRepos` on the local
PDS), so it only ever sees the local network.

Do not point the app at HappyView for `com.atproto.repo.*`: those are built-in
lexicons, and HappyView proxies them to an authority DID that does not exist in
the local PLC (see Known limits).

### Record keys

The record key is an address, not an index — every association lives in the
record body, so a writer that mints its own key scheme still produces records
every query can read. Only the literal singleton keys are part of the contract:

| Collection | rkey | Why |
| --- | --- | --- |
| `…biblio.bookStatus` | a fresh TID per (reader, edition); legacy rows may carry the edition rkey | one status per edition per reader, found by `record.book.uri`; a status change replaces the record |
| `…biblio.shelfItem` | a fresh TID per (shelf, book); legacy rows may carry `<shelf rkey>-<edition rkey>` | one membership edge per (shelf, book), found by `record.shelf` + `record.book.uri`, so re-adding is idempotent |
| `…biblio.readingGoal` | `current` | `getReadingGoal` reads `readingGoal/current` |
| `…actor.profile` | `self` | `getActorProfile` reads `actor.profile/self` |

`bookStatus.metadata.status` is required (`to-read`, `reading`, `read`, `dnf`).
Shelf membership and reading status are separate records on purpose: a book can
sit on several custom shelves while having exactly one reading status.

## Production: tailnet-only dashboard at `/hv`

On lescayes the dashboard and API are reachable at
`https://lescayes.ts.olamaelcu.net/hv/` from tailnet clients only. The name
does double duty: MagicDNS answers `100.64.0.1` inside the tailnet, while
public DNS answers `108.61.75.187`. The same TLS vhost therefore serves both
audiences and location rules decide which one reaches HappyView.

| Setting | Value |
| --- | --- |
| `PUBLIC_URL` | `https://lescayes.ts.olamaelcu.net` — the origin only; no `/hv` |
| `BASE_PATH` | `/hv` |
| `HAPPYVIEW_URL` (edge) | `http://127.0.0.1:3101/hv` — loopback adapter (below) |
| `HAPPYVIEW_URL` (deploy oneshot) | `http://127.0.0.1:3100/hv` |
| listen address | `127.0.0.1:3100` (unchanged; still not a public listener) |

`SESSION_SECRET` (64+ characters) and `TOKEN_ENCRYPTION_KEY` (base64 of 32
bytes) must both be set before switching `PUBLIC_URL` away from a loopback
name. The non-loopback OAuth client persists an encrypted key and the process
refuses to boot with `client key is encrypted but TOKEN_ENCRYPTION_KEY is not
set`. Losing the key makes the encrypted OAuth-client and attestation rows
unreadable; rotate them (they regenerate) rather than guessing the key.

Those values live in `/etc/bibliograph/happyview.local`, which the infra
`bibliograph_database` role writes from
`ansible/group_vars/all/secrets.sops.yml` (`bibliograph_session_secret`,
`bibliograph_token_encryption_key`) and its own defaults
(`bibliograph_public_url`, `bibliograph_base_path`,
`bibliograph_happyview_url`). The file loads after the packaged conffile, so it
wins. `/etc/bibliograph/happyview.env` and `/etc/bibliograph/web.env` are dpkg
conffiles, not Ansible-managed: preserve them with
`--force-confdef --force-confold` and stage them by hand on a new host. Never
regenerate the two secret values to "fix" a boot error — encrypted OAuth-client
and attestation rows become unreadable.

`BASE_PATH` moves every route: `/hv/dashboard/`, `/hv/xrpc/*`, `/hv/admin/*`,
`/hv/auth/*`, and the dashboard's `_next` assets. `/health` stays at the root.
Internal callers use the prefixed base URL — `packages/web`'s `HAPPYVIEW_URL`
and `hv-deploy`, whose health probe strips the path because health does not
move.

HappyView resolves dashboard/XRPC requests by `Host` to a registered domain,
and once `PUBLIC_URL` is not a loopback name, `127.0.0.1` is no longer one. The
edge therefore goes through a loopback listener
(`/etc/nginx/conf.d/bibliograph-happyview-loopback.conf`, bound to
`127.0.0.1:3101`) that rewrites `Host` to `lescayes.ts.olamaelcu.net` before
proxying to `127.0.0.1:3100`. Source: `packaging/happyview/nginx/edge-loopback.conf`.
The checked-in copy is a template: replace `__HAPPYVIEW_DOMAIN__` with the host
HappyView has registered (`PUBLIC_URL`'s host).
`hv-deploy` does not need the adapter: it talks to HappyView directly at
`HAPPYVIEW_URL=http://127.0.0.1:3100/hv` and calls `/hv/admin/*`, which is not
behind the domain middleware. Only the edge's `/hv/xrpc` traffic needs the
Host-rewriting adapter.

The packaged dashboard is the upstream image's static tree: its HTML/JS contain
the literal `/__HAPPYVIEW_BP__` sentinel and a `.base-path-pending` marker.
The unit's `ExecStartPre=+…/hv-prepare-static` replaces the sentinel with
`BASE_PATH` and removes the marker on first start; without that step the pages
ask for `/__HAPPYVIEW_BP__/...` while the server serves `/hv/...`. The rewrite
is one-shot, so change `BASE_PATH` by reinstalling the package (dpkg restores
the marker), not by editing the conffile and restarting.

Ingress is `/etc/nginx/snippets/happyview-hv.conf`, included from the
`lescayes.ts.olamaelcu.net` TLS block in `/etc/nginx/conf.d/site-landing.conf`:

- `= /hv` and `= /hv/` redirect to `/hv/dashboard/`; `/hv/` allows
  `100.64.0.0/10` and `fd7a:115c:a1e0::/48` and denies everything else. The
  address check is the client's real source address: nginx is the first hop,
  and MagicDNS makes a tailnet browser connect to `100.64.0.1`, never to the
  public address.
- `= /hv/oauth-client-metadata.json` is public. The atproto authorization
  server that handles dashboard login fetches it before and after the consent
  screen and cannot reach a tailnet address. It is public client metadata
  (redirect URIs, scopes, inline JWKS) with no secret; its `redirect_uris`
  point at `/hv/auth/callback`, which stays tailnet-only.
- `/health` is not exposed; the landing site owns this host's root.

A tailnet-only hostname cannot be the dashboard origin: with a non-loopback
`PUBLIC_URL`, HappyView's OAuth client is a metadata URL, and login fails with
`invalid_client_metadata` when the authorization server cannot fetch it. This
is why the origin stays the dual-homed `lescayes.ts` name and only the
metadata document is public.

The example is shipped at
`/usr/share/bibliograph-happyview/nginx/hv-tailnet.conf` (source:
`packaging/happyview/nginx/hv-tailnet.conf`) and is installed by hand to
`/etc/nginx/snippets/happyview-hv.conf`; the package never includes it. The
`lescayes.ts.olamaelcu.net` block of `site-landing.conf` comes from
`infra/ansible/roles/landing/templates/landing.conf.j2`, whose `landing_domain`
branch includes the snippet, so a normal infra run keeps the include. The
snippet itself is not deployed by that role.

### Access without the tailnet

If MagicDNS or tailnet routing is unavailable, forward the loopback adapter and
talk to it directly:

```bash
ssh -N -L 3101:127.0.0.1:3101 veve@lescayes.ts.olamaelcu.net
curl -H 'Host: lescayes.ts.olamaelcu.net' http://127.0.0.1:3101/hv/dashboard/
```

The adapter rewrites `Host` to the registered tailnet name, so this reaches the
dashboard without relying on the browser to resolve `100.64.0.1`. An interactive
OAuth login still needs the browser to reach
`https://lescayes.ts.olamaelcu.net` (the authorization server fetches the public
metadata and the browser returns to `/hv/auth/callback`); use the tailnet name
for login and the tunnel for diagnostics or admin-key API calls.

### Static reset and rollback

`hv-prepare-static` is one-shot: to re-apply `BASE_PATH`, or to return to root
mode, reinstall the package and restart rather than editing `static/` in place.

```bash
sudo apt-get install -y --reinstall \
  -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
  /tmp/bibliograph-happyview_2.17.4-2_amd64.deb
sudo systemctl restart happyview.service
```

dpkg restores `.base-path-pending` and the `/__HAPPYVIEW_BP__` sentinel;
`ExecStartPre` then rewrites the tree to the current `BASE_PATH` and removes the
marker. Removing `BASE_PATH` from `happyview.local` before the reinstall restores
the root (`/dashboard/`) dashboard. `--reinstall` leaves the conffiles and
`happyview.local` alone; revert those from the infra role templates or a
`/root/hv-rollback-*` backup.

### Relays and network sync

In production the PDS announces itself to two relays:

```
PDS_CRAWLERS=https://atproto.africa,https://bsky.network
```

That value is managed in `infra` (`rsky_pds_crawlers` in
`ansible/group_vars/all/default.yml`, rendered into `/etc/rsky-pds/pds.local` by
`ansible/roles/rsky_pds/templates/pds.local.j2`). rsky POSTs
`com.atproto.sync.requestCrawl` to each host after a sequencer event, at most
once per 20 minutes; the list has no spaces and each entry needs its `https://`
scheme because it is interpolated into `<host>/xrpc/com.atproto.sync.requestCrawl`.

`atproto.africa` is an **additional** relay, not a replacement. HappyView still
consumes `bsky.network`:

| Setting | Value | Why it stays |
|---|---|---|
| `JETSTREAM_URL` | `wss://jetstream1.us-east.bsky.network` | atproto.africa runs no Jetstream service |
| `RELAY_URL` | `https://bsky.network` | backfill walks the relay's `listRepos`; atproto.africa has no `listRepos`/`getRepo` |

So do not point either value at `atproto.africa`. Keep both relays in
`PDS_CRAWLERS`: dropping `bsky.network` would stop re-announcement to the relay
that serves the Jetstream feed HappyView indexes.

Announce manually after a PDS restart (it also reads `PDS_CRAWLERS` from the
symlinked `/etc/rsky-pds/pds.local`):

```bash
sudo pdsadmin request-crawl https://atproto.africa,https://bsky.network
```

Verify each relay sees the host (`status` must be `active` and `seq` must match
`/var/lib/rsky-pds/sequencer.sqlite`'s `max(seq)`):

```bash
curl -sS 'https://atproto.africa/xrpc/com.atproto.sync.getHostStatus?hostname=pds.olamaelcu.net'
curl -sS 'https://bsky.network/xrpc/com.atproto.sync.getHostStatus?hostname=pds.olamaelcu.net'
```

A relay subscription is visible as a `101` on
`GET /xrpc/com.atproto.sync.subscribeRepos` in
`/var/log/nginx/rsky-pds_access.log` (nginx writes the line when the stream
closes; an open stream shows only as an established connection from the relay's
IP). Crawl failures are swallowed at debug level, so check the relay side rather
than `journalctl -u rsky-pds`.

## Dashboard login

On lescayes, sign in at `https://lescayes.ts.olamaelcu.net/hv/dashboard/` from a
tailnet client; the metadata document is the only public `/hv` path. The local
compose stack below uses `http://127.0.0.1:3000`.

Open `http://127.0.0.1:3000`, redirects to `/dashboard/`, and sign in with the
provisional handle. The redirect chain goes to
`https://pds.127-0-0-1.sslip.io/oauth/authorize`, so the browser needs Caddy's
root CA first:

```bash
mise run hv-ca            # Chrome and Firefox (user stores, no sudo)
mise run hv-ca --system   # curl, openssl, wget (asks for sudo)
```

The redirect chain crosses to `https://pds.127-0-0-1.sslip.io/oauth/authorize`,
so the browser must trust Caddy's internal CA. `hv-ca` installs Caddy's root CA
into every store it finds, under the nickname `Caddy Local Dev CA`:

| Store | What it covers | Privileges |
| --- | --- | --- |
| `~/.pki/nssdb` | Chrome / Chromium | none |
| `~/.mozilla/firefox/*/cert9.db` | Firefox, per profile | none |
| `/usr/local/share/ca-certificates` (or p11-kit) | curl, openssl, wget, Node with `--use-system-ca` | sudo |

The browser stores need no privileges and are the default; the system store is
opt-in with `--system`. Restart the browser afterwards — it caches trust
decisions per session. `mise run hv-ca --uninstall` removes the certificate
again.

The account is already a superuser via `hv-seed`, so no post-login bootstrap
step is needed.

HappyView answers only hosts registered as domains; anything else gets `421
Unknown host` from `/config` and the dashboard renders blank. The primary domain
is `PUBLIC_URL` (`127.0.0.1:3000`), and `hv-seed` registers `localhost:3000` as
an alias so either spelling loads. A login *started* at `localhost:3000` still
returns to `127.0.0.1:3000/auth/callback`, because the loopback client's
redirect is built from `PUBLIC_URL` — use `127.0.0.1` when you intend to sign
in, or flip `PUBLIC_URL` and re-seed if you prefer `localhost` as canonical.

## Reset

```bash
docker compose down -v          # drops pgdata, pdsdata, caddy_data
docker compose up -d
mise run hv-account && mise run hv-seed && mise run hv-ca
```

To reset only HappyView's tables, drop the schema and **re-apply
`docker/postgres-init.sql` before restarting the container**: with the schema
missing, sqlx creates `_sqlx_migrations` in `public`, where `happyview_app` has
no `CREATE`, and the container crash-loops on `permission denied for schema
public`.

## Known limits

- **Built-in `com.atproto.*` proxy routes fail locally.** They resolve the
  lexicon's authority DID through `PLC_URL`, which is the local directory, so
  `com.atproto.server.describeServer` and friends answer
  `DID document not found for did:plc:6msi3p…`. Uploaded lexicons with their own
  Lua scripts are unaffected.
- **Six queries depend on `public.appview_book_lua`**, the catalog read model.
  It is created by the versioned schema (`mise run catalog-schema`), so a fresh
  database or a fresh compose volume works after that command; no old service
  is required. Without the view, book-rendering queries answer 404 "catalog
  edition is missing" instead of rendering books.
- **Local records bypass schema validation.** The PDS resolves lexicons from the
  public authority, so compose blocks that host (see above) and every write
  answers `validationStatus: "unknown"`. A typo in a record shape will not be
  caught locally the way it would against a published schema.
- **The edge holds no user session.** `packages/web` injects its XRPC client
  key/secret and relays `Authorization`/`DPoP`; it never runs an OAuth flow or
  stores tokens. A caller that wants procedures must bring a DPoP session
  (Livtet registers its own with HappyView, or writes to the PDS directly), and
  the proxy cannot mint one on its behalf.
- **`db.raw` runs on the main connection** behind HappyView's tokenizer guard
  and logs a warning. Setting `PLUGIN_SQL_DATABASE_URL` to a least-privileged
  `happyview_plugin` role would move it to its own pool; no such role exists
  locally yet.
