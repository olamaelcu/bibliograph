# Lexicon Resolution via HTTP + DNS

## Overview

Bibliograph exposes its lexicon schemas via two HTTP surfaces:

1. **XRPC endpoint** — `com.atproto.lexicon.resolveLexicon` — the standard AT Protocol resolution endpoint.
2. **Path-style HTTP** — `GET /lexicon/<nsid>` — a direct JSON path for debugging and manual inspection.

Both surfaces serve the same canonical JSON: the `lexicons/` source files on disk, published under `net.olamaelcu.livtet.biblio.*` NSIDs.

> **Note:** These schemas are served directly from the file system. They are **not** stored as `com.atproto.lexicon.schema` records in any PDS. This means full AT Protocol lexicon resolution (DNS → DID → PDS → XRPC) requires publishing the schemas to a PDS account — see [goat lex publish](https://github.com/bluesky-social/goat). The HTTP and path-style endpoints documented here cover the direct HTTP serving layer only.

## DNS TXT Record

To make `net.olamaelcu.livtet.biblio.*` NSIDs resolvable via the standard AT Protocol DNS-based discovery mechanism, add a TXT record at the authority domain:

**Zone:** `biblio.livtet.olamaelcu.net`

```
_lexicon.biblio.livtet.olamaelcu.net.  300  IN  TXT  "did=did:web:biblio.livtet.olamaelcu.net"
```

- **Host:** `_lexicon.biblio.livtet.olamaelcu.net` (the `_lexicon` prefix + reversed authority from `net.olamaelcu.livtet.biblio.*`)
- **TTL:** 300 seconds (short TTL recommended per AT Protocol spec since DNS changes need to propagate quickly)
- **Value:** `did=<service-did>` — the DID of the AppView service. Same as the public host: `did:web:biblio.livtet.olamaelcu.net`.

### Verify with dig

```sh
dig TXT _lexicon.biblio.livtet.olamaelcu.net
# Expected:
# _lexicon.biblio.livtet.olamaelcu.net. 300 IN TXT "did=did:web:biblio.livtet.olamaelcu.net"
```

### Verify with the CLI

```sh
tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.review
# Full chain: DNS → DID → PDS → XRPC → JSON
```

With `--host` for local testing:
```sh
tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.review --host=http://localhost:3000/xrpc
```

## Resolution Chain

AT Protocol clients resolve a lexicon NSID in three hops:

1. **DNS** — query `_lexicon.<reversed-authority>` TXT record → get `did=...`
2. **DID** — resolve the DID to a DID document → find `#atproto_pds` service endpoint
3. **XRPC** — call `com.atproto.lexicon.resolveLexicon?nsid=<nsid>` against the PDS

The `lex:resolve` CLI automates this chain for any NSID and target host.

## HTTP Endpoints

### `GET /xrpc/com.atproto.lexicon.resolveLexicon?nsid=<nsid>`

Standard XRPC query. Returns:

```json
{
  "uri": "at://did:web:biblio.livtet.olamaelcu.net/com.atproto.lexicon.schema/net.olamaelcu.livtet.biblio.review",
  "cid": "bafyrei...",
  "schema": { ... }
}
```

Errors: `400 LexiconNotFound` if the NSID is unknown.

### `GET /lexicon/<nsid>`

Path-style endpoint for direct JSON access. No authentication required.

```sh
curl https://biblio.livtet.olamaelcu.net/lexicon/net.olamaelcu.livtet.biblio.review
```

Returns the raw lexicon JSON with `Content-Type: application/json` and `Cache-Control: public, max-age=300`.

## Adding a New Lexicon Namespace

If a future lexicon namespace is added (e.g. `net.olamaelcu.livtet.biblio.dev.*`), a separate DNS TXT record is required for each unique authority prefix:

```
_lexicon.dev.biblio.livtet.olamaelcu.net.  300  IN  TXT  "did=did:web:biblio.livtet.olamaelcu.net"
```

The AppView automatically serves any NSID present in `lexicons/` via both HTTP surfaces.
