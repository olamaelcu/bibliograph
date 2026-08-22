# Lexicon Resolution via HTTP + DNS

## Overview

Bibliograph exposes its lexicon schemas via two HTTP surfaces:

1. **XRPC endpoint** — `com.atproto.lexicon.resolveLexicon` — the standard AT Protocol resolution endpoint.
2. **Path-style HTTP** — `GET /lexicon/<nsid>` — a direct JSON path for debugging and manual inspection.

Both surfaces serve the same canonical JSON: the `lexicons/` source files on disk. The catalog is split across two namespaces:

- **`community.lexicon.book.*`** — published records (`edition`, `contributor`) and required queries (`searchEditions`, `compatibility`, etc.) per the [community book lexicon proposal](http://localhost:5190/blog/2026/book-lexicon).
- **`net.olamaelcu.livtet.biblio.*`** — app-private records (`shelf`, `bookShelving`, `actor`) and image-lookup queries (`getImageFor{Book,Contributor}`).

> **Note:** These schemas are served directly from the file system. They are **not** stored as `com.atproto.lexicon.schema` records in any PDS. Full AT Protocol lexicon resolution (DNS → DID → PDS → XRPC) for the `net.olamaelcu.livtet.biblio.*` namespace requires publishing the schemas to a PDS account — see [goat lex publish](https://github.com/bluesky-social/goat). The HTTP and path-style endpoints documented here cover the direct HTTP serving layer only.

The `community.lexicon.book.*` records are published as atproto records from this PDS, so the community NSIDs are resolvable through the standard atproto discovery chain once a DNS TXT record exists at the `_lexicon.book.lexicon.community.` zone (out of scope for the bibliograph project).

## DNS TXT Record (net.olamaelcu.livtet.biblio.*)

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
tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.shelf
# Full chain: DNS → DID → PDS → XRPC → JSON
```

With `--host` for local testing:
```sh
tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.shelf --host=http://localhost:3000/xrpc
```

## Resolution Chain

AT Protocol clients resolve a lexicon NSID in three hops:

1. **DNS** — query `_lexicon.<reversed-authority>` TXT record → get `did=...`
2. **DID** — resolve the DID to a DID document → find `#atproto_pds` service endpoint
3. **XRPC** — call `com.atproto.lexicon.resolveLexicon?nsid=<nsid>` against the PDS

The `lex:resolve` CLI automates this chain for any NSID and target host, but is primarily useful for the app-private `net.olamaelcu.livtet.biblio.*` namespace (since the community namespace is authoritative).

## HTTP Endpoints

### `GET /xrpc/com.atproto.lexicon.resolveLexicon?nsid=<nsid>`

Standard XRPC query. Returns:

```json
{
  "uri": "at://did:web:biblio.livtet.olamaelcu.net/com.atproto.lexicon.schema/community.lexicon.book.edition",
  "cid": "bafyrei...",
  "schema": { ... }
}
```

Errors: `400 LexiconNotFound` if the NSID is unknown.

### `GET /lexicon/<nsid>`

Path-style endpoint for direct JSON access. No authentication required.

```sh
curl https://biblio.livtet.olamaelcu.net/lexicon/community.lexicon.book.edition
```

Returns the raw lexicon JSON with `Content-Type: application/json` and `Cache-Control: public, max-age=300`.

The path-style handler serves ANY `.json` file under `lexicons/` (community + app-private), so it's a one-stop shop for debugging.

## Adding a New Lexicon Namespace

If a future lexicon namespace is added (e.g. `net.olamaelcu.livtet.biblio.dev.*`), a separate DNS TXT record is required for each unique authority prefix:

```
_lexicon.dev.biblio.livtet.olamaelcu.net.  300  IN  TXT  "did=did:web:biblio.livtet.olamaelcu.net"
```

The AppView automatically serves any NSID present in `lexicons/` via both HTTP surfaces.
