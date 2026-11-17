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
