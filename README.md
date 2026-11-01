# Bibliograph

A collection of tools for bibliographic work in one project:

- An [ATProto appview][1] for:
  - resolving book information in a uniform way conforming to [the proposal
    made by Olamaelcu][2]
  - fetching reviews published in the Atmosphere [using microcosm for discovery](#network-discovery)

The end goal of this project is to provide the appview that [Livtet][] will
leverage to interface with the ATProto ecosystem - it's published in the open
to allow for simpler interoperability with other products and projects but
designed for the needs of Livtet.

## Discovery

Discovery for things like reviews happen in a few ways:

### Network Discovery

Bibliograph leverages <https://constellation.microcosm.blue/> to find book
reviews specific to Bibliograph written into the Atmosphere as well as records
ingested from TAP of the expected NSID
`net.olamaelcu.livtet.biblio.bookReview`. This allows for (near-)real time
analysis of book reviews on protocol from Livtet. For compatibility with other
applications like [Bookhive][], Bibliograph normalizes those reviews into
Bibliograph reviews so they can appear to Bibliograph-powered applications.

### Bookhive

[Bookhive][] publishes its catalog and its users' book records on-protocol from
a single PDS (`did:plc:enu2j5xjlqsjaylv3du4myh4`), which Bibliograph consumes in
both directions:

- **Catalog → editions.** `buzz.bookhive.catalogBook` records are ingested as
  `community.lexicon.book.edition` rows keyed `bh.{hiveId}`
  (`pnpm ingest:bookhive`), carrying the catalog record's at-uri as a `bookhive`
  identifier (plus the `goodreads` id when that is the upstream source).
- **User records → reviews and shelving.** A `buzz.bookhive.book` record holds
  the review text, a 1–10 star rating and a reading status
  (`reading` / `finished` / `wantToRead` / `abandoned`) all at once, and refs its
  catalog record through `hiveBookUri`. Bibliograph never rewrites those
  records: `getReviewsByBook` translates them into `biblio.bookReview` values and
  `getShelvingOfBook` maps the status onto `defs#bookShelfMetadata.status`, both
  only for the edition that carries the matching `bookhive` identifier.
- **Discovery.** Records are mirrored through TAP (`buzz.bookhive.book`) and
  resolved through Constellation with source `buzz.bookhive.book:hiveBookUri`,
  so reviews written since the last mirror — or by repos no TAP instance follows
  — are still found on the first page.

`buzz.bookhive.buzz` (book comments) is deliberately **not** ingested: comments
ref the user book record and each other, never the catalog record, so
Constellation cannot attach them to a Bibliograph edition and mirroring them
would only cost storage. Set `BOOKHIVE_PDS` to point somewhere other than
`https://bluesky.nickthesick.com`.

### Material Discovery

Information is sourced from a few places:

- Book information is sourced from OpenLibrary (works + editions APIs) with
  optional Google Books enrichment for descriptions and covers (requires
  `GOOGLE_BOOKS_API_KEY`)
- Author information is _gleamed_ from Wikipedia and OpenLibrary

## Catalog curation

The catalog records (`community.lexicon.book.*`) are served by Bibliograph, but
corrections come from people. Anyone who signs in with an AT Protocol account
can vote on which work an edition belongs to.

- The vote is a record in the voter's **own** repository:
  `net.olamaelcu.livtet.biblio.editionWorkLink`, keyed by the edition's rkey, so
  an account holds at most one vote per edition and changing your mind updates
  that record rather than stacking another one.
- Bibliograph ingests votes through TAP into `edition_work_votes` and only
  rewrites `editions.work_uri` once votes agree: `link votes − unlink votes >=
  EDITION_WORK_CONSENSUS_THRESHOLD` (default `2`). With one vote per account,
  a single dissenter cannot overwrite an established link. Set the threshold to
  `1` to let one account curate a small or private catalog.
- A decision is stamped `editions.work_link_source = 'consensus'`, and the
  automatic reconciler (`pnpm backfill:works`) skips those rows — otherwise a
  nightly run would silently undo a voted unlink.

OAuth is least-privilege: the client asks only for
`repo:net.olamaelcu.livtet.biblio.editionWorkLink`, never for general repo or
profile access.

| Variable | Dev default | Purpose |
| --- | --- | --- |
| `OAUTH_PUBLIC_ORIGIN` | `http://127.0.0.1:5176` | Origin used to build the redirect URI. Loopback redirects must be `127.0.0.1`/`[::1]`, not `localhost`. |
| `OAUTH_CLIENT_ID` | _(unset)_ | Unset → an ATProto loopback client id carrying its metadata inline. Set to an HTTPS URL serving `/oauth-client-metadata.json` in production. |
| `EDITION_WORK_CONSENSUS_THRESHOLD` | `2` | Net votes required to apply a link or unlink. |

Sessions are server-side (`oauth_sessions` holds DPoP key material; the browser
cookie only carries an opaque id), so a tampered cookie cannot claim another
account's session.

## Librarian gate

Voting on catalog edits is limited to accounts that hold the `librarian` label.
Signing in is not enough: authentication proves who you are, the label decides
whether you may curate.

Bibliograph is itself the labeler. Its labeler identity is the same `did:web` as
the publisher, so `/.well-known/did.json` advertises both `#atproto_label` (the
label signing key) and `#atproto_labeler` (the `AtprotoLabeler` service, an
origin with no path).

| Endpoint | Where |
| --- | --- |
| `com.atproto.label.queryLabels` | XRPC query in the SvelteKit router |
| `com.atproto.label.subscribeLabels` | WebSocket on the Node entrypoint |

Labels are signed over the DRISL/dag-CBOR encoding of the schema fields
(`ver` included, `sig` and `$type` excluded), SHA-256 hashed, with the raw hash
bytes signed by the `#atproto_label` key. Revocation is a negation label
(`neg: true`), per spec; the gate treats a negated label as absent.

### Entrypoint note

`com.atproto.label.subscribeLabels` is a WebSocket stream. `@sveltejs/adapter-node`
generates a `build/index.js` that constructs its own `http.Server` and never
exposes the `upgrade` event, so a SvelteKit route cannot serve it. Bibliograph
therefore runs `server.ts`, which imports the emitted `build/handler.js`, hands
HTTP to SvelteKit, and keeps upgrades for the label stream. `pnpm start`, the
`start` script, and the packaged `bibliograph.service` (whose `ExecStart` runs
`tsx server.ts`) all use that entrypoint.

`vite dev` does not run `server.ts`, so the stream only exists in a built server:
run `pnpm build && pnpm start` to exercise it locally.

### Label vocabulary

All values live in `src/lib/server/labeler/vocabulary.ts`, shaped like
`com.atproto.label.defs#labelValueDefinition` so they can be published in a
labeler service record without translation. Every write is validated against it:
an undeclared value, or a value applied to the wrong subject kind, throws before
anything is signed.

| Label | Subject | Behavior | Issued by |
| --- | --- | --- | --- |
| `librarian` | account | `none`/`inform`, default ignore | admin approval of an application |
| `senior-librarian` | account | `none`/`inform`, default ignore | `pnpm labels:seniority`, automatically |
| `administrator` | account | `none`/`inform`, default ignore | an existing administrator |
| `controversial` | record (edition/work) | `none`/`inform`, default warn | administrators, from the record page |

Credential labels deliberately never blur content: they say nothing about what
the subject contains. `controversial` defaults to `warn` so the banner is visible
without every subscriber configuring it — the point is that a reader sees the
context.

`senior-librarian` requires **both** tenure and contribution, since applying and
then going quiet for a year should not earn it:
`SENIOR_LIBRARIAN_MIN_DAYS` (default 365) since the first librarian label, and
`SENIOR_LIBRARIAN_MIN_VOTES` (default 10) votes cast. Run
`pnpm --filter bibliograph-service labels:seniority --dry-run` to see the
evaluation without writing anything; the job is idempotent, so schedule it daily.

### Administrators

The admin view is gated by the `administrator` label, so anyone holding it —
including accounts granted long after deployment — can review the queue without a
redeploy. `ADMIN_DIDS` remains as a bootstrap only: it is the way to grant the
first administrator on a fresh deployment, and to recover if a label is ever lost.
An account in that list stays an admin even if the label is withdrawn.

### Requesting access

A signed-in account without the label sees a request control on any edition page.
The request lands in `/admin/applications`, readable only by DIDs listed in
`ADMIN_DIDS` (empty = nobody). Approving emits the label; revoking emits a
negation and marks the application revoked. The application table records the
decision trail, but the label is the authority.

| Variable | Dev default | Purpose |
| --- | --- | --- |
| `ATP_LABEL_SIGNING_KEY` | _(unset → labeler disabled)_ | K-256 private key (64 hex) used to sign labels. `pnpm --filter bibliograph-service label-keygen`. |
| `ATP_LABEL_KEY_MULTIBASE` | _(unset → placeholder published)_ | Public half, published as `#atproto_label` in the DID document. Must match the signing key or every label fails verification. |
| `ADMIN_DIDS` | _(unset → nobody)_ | Comma-separated DIDs allowed to review the queue. |

## Observability

Prometheus is available locally at <http://localhost:9090> (no auth, dev only).

Scrape targets:

- **bibliograph-service** — `host.docker.internal:5000/metrics`. HTTP request
  histograms labelled by `method`, `status`, and a normalized `path`
  (DIDs / opaque IDs collapsed to `/{did}` and `/{id}` to bound cardinality;
  `/xrpc/*` and `/.well-known/*` are kept verbatim).
- **tap** — `tap:2481/metrics`. Firehose ingestion, outbox delivery, resync
  latency emitted by [indigo/tap](https://github.com/bluesky-social/indigo/tree/main/cmd/tap).

Pre-computed recording rules live in [`prometheus/rules/bibliograph.yml`](prometheus/rules/bibliograph.yml) and refresh every 30s:

| Rule                                              | What it tells you                     |
| ------------------------------------------------- | ------------------------------------- |
| `job:http_requests:rate5m`                        | Request rate per route + status class |
| `job:http_latency:p50_5m` / `:p95_5m` / `:p99_5m` | Latency percentiles per route         |
| `job:http_errors:ratio5m`                         | Share of 5xx responses per route      |
| `job:nodejs_eventloop_lag:p95_1m`                 | Event-loop lag p95 (Node-side)        |
| `job:process_memory_rss:bytes`                    | RSS memory in bytes                   |
| `job:tap_firehose:received_rate1m`                | Events/sec received from the relay    |
| `job:tap_firehose:processed_rate1m`               | Events/sec successfully processed     |
| `job:tap_outbox:delivered_rate1m`                 | Events/sec delivered to consumers     |
| `job:tap_resync:p95_5m`                           | Resync latency p95                    |
| `job:tap_event_cache:size`                        | Tap in-memory buffer size             |
| `job:tap_firehose:last_seq`                       | Last cursor seq committed upstream    |

TSDB lives in the `promdata` named volume with **7-day** retention.

The `/metrics` endpoint on bibliograph-service is currently unauthenticated — bind
Prometheus to localhost before exposing the port.

[1]: https://atproto.com/guides/glossary#app-view
[2]: https://www.olamaelcu.net/blog/2026/book-lexicon
[livtet]: https://livtet.olamaelcu.net
[bookhive]: https://bookhive.buzz/
