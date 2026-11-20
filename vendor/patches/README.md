# Patches applied to `vendor/rsky`

`vendor/rsky` is a submodule pinned to the rsky commit the PDS image is built
from. It is never edited in place: `docker/pds.Dockerfile` builds from it and
applies every `*.patch` here, in filename order, before compiling. That keeps a
change reproducible — a fresh clone plus `docker compose build pds` reproduces
the binary — which a working-tree edit inside the submodule would not.

## `rsky-space-resolver-network-policy.patch`

**Symptom.** With `PDS_DEV_MODE=true`, a `managedspace` whose `managingApp` is a
`did:web` on a private address cannot be read by anyone but its owner. The PDS
answers

```
getSpaceCredential 400 InvalidRequest
identity resolution failed: https://<host>/.well-known/did.json:
resolves to a private address
```

**Cause.** `rsky-pds/src/outbound.rs` turns `PDS_DEV_MODE` into
`NetworkPolicy::PERMISSIVE`, and the app-state resolver applies it. The paths
that resolve a peer named by a DID document build their own `DidResolver`
without calling `.with_network`, so `DidWebResolver::new` keeps its
`NetworkPolicy::PUBLIC` default and refuses every non-global address:

| Site | Resolves |
| --- | --- |
| `apis/com/atproto/space/mod.rs` | the authority's `#atproto_space_host` / `#atproto_pds` endpoint |
| `apis/com/atproto/space/register_notify.rs` | a notify subscriber endpoint |
| `apis/com/atproto/space/host.rs` | the `managingApp` of a `managedspace` |
| `permission_set.rs` | a permission set's service |

**Fix.** Each adds `.with_network(crate::outbound::policy())` — the API rsky
already has (`DidWebResolver::with_network`) — so one deployment decision governs
every outbound fetch that a DID document names.

**Upstream.** None of these sites consult the policy in rsky at
`80f41a3d98a22a3ba2563d461460ef9a35adbc68`. Raise it upstream; when it lands,
drop this patch and bump the submodule.

**Verify.** In this stack, with the app serving
`https://172-17-0-1.sslip.io/.well-known/did.json`:

```bash
curl -s --cacert .cache/caddy-root.crt \
  'https://pds.127-0-0-1.sslip.io/xrpc/com.atproto.identity.resolveIdentity?identifier=did:web:172-17-0-1.sslip.io'
# 200 before: only a public address resolved; after: this one does too
```

A space read is the end-to-end check: the PDS resolves the manager and calls
`checkUserAccess` on the app instead of refusing.

## `rsky-lexicon-authority-override.patch`

**Symptom.** Sign-in against the local stack fails at the first authorize with
`invalid_scope: Unable to retrieve permission sets`. The PDS log names the set
and then either `Could not resolve DID: did:plc:e2x3ih…` or an outbound fetch to
`https://pds.olamaelcu.net` — because the app's sign-in now names an `include:`
scope, and resolving it walks into production: NSID authority → `_lexicon` TXT →
the publisher's public `did:plc` → that DID's PDS → the schema record.

**Cause.** `permission_set.rs` resolves the authority's DID from the TXT record
and nothing else, so a stack that runs its own PLC has no way to say "this
authority is published here". The reference PDS has `PDS_LEXICON_AUTHORITY_DID`
for exactly this; rsky does not.

**Fix.** `fetch` honours `PDS_LEXICON_AUTHORITY_DID` when it is set, falling back
to the TXT lookup. The dev stack sets it to the account that publishes the
lexicons (`vendor`-free: `mise run publish-lex` writes them there), so the
resolver logic stays rsky's — only the authority's answer changes, which is the
same relationship production has with DNS.
The pin is not authority-specific, exactly as the reference PDS's is not: while
it is set, **every** `include:` resolves against that one DID's repo. That is
the right semantic for a stack that publishes the lexicons it will be asked
for and nothing else; a stack that reads a third-party set leaves it unset.

The dev stack also maps `pds.127-0-0-1.sslip.io` to the host gateway, so the
pinned DID's `#atproto_pds` endpoint (which resolves to loopback for everyone
else) reaches Caddy from inside the container instead of itself.

**Upstream.** rsky at `80f41a3d98a22a3ba2563d461460ef9a35adbc68` has no such
knob. Raise it upstream; drop the patch and bump the submodule when it lands.

## `rsky-safe-client-system-roots.patch`

**Symptom.** The permission-set fetch above still fails: the PDS logs
`error sending request for url (https://pds.127-0-0-1.sslip.io/…)` and `reqwest`
logs a connection starting and then dying. The same URL answers 200 from a
sibling container that passes this stack's bundle to its own trust store.

**Cause.** `rsky-identity` enables both `rustls-tls-webpki-roots` and
`rustls-tls-native-roots`, and `SafeClient` builds its `reqwest::Client` without
touching TLS, so verification uses webpki's compiled Mozilla roots. A host the
deployment serves with its own CA — this stack's PDS behind Caddy — is not in
them, and the operating system's store (which this stack replaces with the image
anchors plus Caddy's, see `pds-ca`) is never read.

**Fix.** `with_system_roots` adds the certificates from
`/etc/ssl/certs/ca-certificates.crt` to the builder in both places a `SafeClient`
builds a transport (`with_lookup` and `builder`). The defaults stay, so public
hosts verify exactly as before; a deployment that curates its bundle gets its
own hosts too. A missing or unreadable bundle leaves the builder unchanged.

**Upstream.** No `rsky-identity` release consults the system store. Raise it
upstream; drop the patch and bump the submodule when it lands.

## `rsky-permission-set-prose.patch`

**Symptom.** The consent page's card for an `include:` set never shows the
set's prose. A set that publishes

```json
{
  "type": "permission-set",
  "title": "Bulleted spaces",
  "detail": "Read the outlines shared in your Bulleted spaces, and write your own bullets in them."
}
```

renders as `app.bulleted.spaceAccess` as its title, and a set with no title
renders with an empty description even when it publishes a `detail`. The
grouping code (`ui/scopes.rs`) already has the reference UI's fallbacks -- NSID
title, NSID-or-empty description -- so the card is correct but blank where the
set's own words belong.

**Cause.** `permission_set.rs` keeps only `permissions` from a `permission-set`
def: `SchemaDef` has no `title`/`detail`, so serde drops them, and the cache
holds a bare `Vec<Permission>`. `oauth/routes.rs::include_sets` therefore fills
`IncludeSetView` with `title: None, detail: None` -- pinned by its test's
`assert!(…title.is_none())` -- whatever the record says.

**Fix.**

- `SchemaDef` gains `title`/`detail`. The every-def union
  (`permissions_from_record`) becomes `set_def`/`resolved_record`:
  `defs["main"]` when that is the permission set, else the first
  permission-set def by name, so a set's prose and its grants always come from
  the same def.
- The cache entry holds `SetRecord { title, detail, permissions }`, so the
  prose is fetched once beside the grants and served from cache hits; `OK_TTL`,
  `ERR_TTL` and `PermissionSetError` are unchanged.
- New `PermissionSetResolver::try_resolved_set` returns
  `ResolvedSet { title, detail, scopes }`; `try_resolved_scopes` is now its thin
  wrapper, so enforcement, PAR and token issuance -- including
  `include:<nsid>?aud=…` rendering -- are untouched.
- `include_sets` passes the prose into `IncludeSetView`.
- Per-set styling hook (no icons): `PermissionGroup` carries the set's NSID,
  the card template emits `data-permission-set="<nsid>"` and the slugged class
  `permission-group--<nsid>` (`permission-group--net-olamaelcu-livtet-authlivtetcore`
  for `net.olamaelcu.livtet.authLivtetCore`), and `assets/ui.css` gains one
  `.permission-group[data-permission-set]` rule. The default appearance is
  unchanged.

**Upstream.** rsky at `80f41a3d98a22a3ba2563d461460ef9a35adbc68` reads only a
set's permissions; `SchemaDef` has no prose fields. Raise it upstream; drop the
patch and bump the submodule when it lands.

**Verify.** The unit tests that pin each part:

At authoring time: the patch applies to a clean submodule (`git apply --check`)
and the whole `vendor/patches` chain applies in order after
`rsky-lexicon-authority-override.patch` (offsets only, no fuzz);
`cargo fmt -p rsky-pds -- --check` and `cargo check -p rsky-pds` are clean; and
the three commands below pass. The consent-page check under them has not been
run against a live stack.

```bash
(cd vendor/rsky && cargo test -p rsky-pds --lib -- permission_set)
(cd vendor/rsky && cargo test -p rsky-pds --lib -- include_sets)   # view carries the prose
(cd vendor/rsky && cargo test -p rsky-pds --lib -- included_sets)  # card carries the hook
```

End to end, the consent page for an authorize request naming
`include:net.olamaelcu.livtet.authLivtetCore` shows that set's title and detail
as the card's heading and text, and the card carries the attributes:

```bash
curl -s '<authorize URL>' | grep -o 'data-permission-set="[^"]*"'
# data-permission-set="net.olamaelcu.livtet.authLivtetCore"
```

## `rsky-duplicate-record-key.patch`

**Symptom.** Creating a record whose rkey is already taken answers
`500 InternalServerError` instead of a client error. One account's writer,
retrying through a slow window on a production instance, produced 2,101 `500`s in
55 minutes — all `com.atproto.repo.applyWrites`, peak 1.79/s, each logged as

```
{"level":50,…,"error":"There is already a value at key: community.lexicon.media.book.edition/3n2ltxg35hofn",
 "msg":"request failed with an internal error"}
```

which is indistinguishable from an outage: it trips the 5xx alert, the counters
bill it as a server error, and a client that retries on 5xx amplifies it while
the request can never succeed.

**Cause.** `Mst::add` (`rsky-repo/src/mst/mod.rs`) reports the conflict with a
bare `anyhow!("There is already a value at key: …")`. The responder's classifier
(`impl From<anyhow::Error> for ApiError`, `rsky-pds/src/apis/mod.rs`) decides by
`downcast_ref` on typed errors — `RepoUnavailable`, `WriteLimitError`,
`ReadOnlyMode`, `InvalidRecord`, `BlobMismatch`, … — so a bare string matches
nothing and falls through to `ApiError::RuntimeError`.

**Fix.** The conflict gets a type: `RepoError::RecordAlreadyExists(String)` in
`rsky-repo`, returned by `Mst::add` with its display text unchanged, and one more
downcast arm maps it to `ApiError::InvalidRequest` (400). `createRecord`,
`applyWrites` and `importRepo` all reach the MST through `rsky-repo/src/repo.rs`,
so the one arm covers all three, and the existing log line keeps its wording.

**Upstream.** rsky at `80f41a3d98a22a3ba2563d461460ef9a35adbc68` stringifies the
conflict. Raise it upstream; drop the patch and bump the submodule when it lands.

**Verify.** At authoring time: the patch applies to the clean submodule
(`git apply --check`), the whole `vendor/patches` chain applies after it, and the
unit test below passes.

```bash
(cd vendor/rsky && cargo fmt -p rsky-repo -p rsky-pds -- --check)
(cd vendor/rsky && cargo test -p rsky-pds --lib -- a_duplicate_record_key_is_a_client_error)
```

End to end, a `createRecord`/`applyWrites` create naming an rkey that already
exists answers `400 InvalidRequest` with `There is already a value at key: …`,
and `pds_http_requests_total{status=~"5.."}` does not move.
