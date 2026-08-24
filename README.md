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

### Material Discovery

Information is sourced from a few places:

- Book information is sourced from OpenLibrary (works + editions APIs) with optional Google Books enrichment for descriptions and covers (requires `GOOGLE_BOOKS_API_KEY`)
- Author information is _gleamed_ from Wikipedia and OpenLibrary

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

| Rule | What it tells you |
| --- | --- |
| `job:http_requests:rate5m` | Request rate per route + status class |
| `job:http_latency:p50_5m` / `:p95_5m` / `:p99_5m` | Latency percentiles per route |
| `job:http_errors:ratio5m` | Share of 5xx responses per route |
| `job:nodejs_eventloop_lag:p95_1m` | Event-loop lag p95 (Node-side) |
| `job:process_memory_rss:bytes` | RSS memory in bytes |
| `job:tap_firehose:received_rate1m` | Events/sec received from the relay |
| `job:tap_firehose:processed_rate1m` | Events/sec successfully processed |
| `job:tap_outbox:delivered_rate1m` | Events/sec delivered to consumers |
| `job:tap_resync:p95_5m` | Resync latency p95 |
| `job:tap_event_cache:size` | Tap in-memory buffer size |
| `job:tap_firehose:last_seq` | Last cursor seq committed upstream |

TSDB lives in the `promdata` named volume with **7-day** retention.

The `/metrics` endpoint on bibliograph-service is currently unauthenticated — bind
Prometheus to localhost before exposing the port.

[1]: https://atproto.com/guides/glossary#app-view
[2]: https://www.olamaelcu.net/blog/2026/book-lexicon
[livtet]: https://livtet.olamaelcu.net
[bookhive]: https://bookhive.buzz/
