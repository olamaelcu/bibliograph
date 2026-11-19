# Search baseline: Postgres, before the external index

A frozen record of how `searchEditions` and `resolveEditions` behave on the
catalog before search moves to its own index. Every number here was measured on
the production host and is dated; keep it as the "before" column of the
migration, not as a latency distribution. Re-measure by appending a new dated
section rather than editing these numbers.

## Environment at sampling

| Fact | Value |
|---|---|
| Sampled | 2026-11-19 ~03:20 UTC (22:20 ET) |
| Host | `lescayes.ts.olamaelcu.net`, Debian 12, glibc 2.36, `amd64` |
| CPU / RAM | 2 vCPU, 3.9 GB (MemTotal 4 003 224 kB) |
| MemAvailable while sampling | **737–915 MB** |
| Swap | 14.7 GB total (`/swap-extra` 8 GB), 1.2–1.3 GB used, `vm.swappiness=10` |
| Database | `bibliograph_v2`, 5.2 GB |
| Versions | worker `0.8.0-1` (inactive, outside its 01:00–08:00 ET window), web `0.6.3-1`, happyview `2.17.4-5` |
| Load | 5.3–7.5 (2 vCPU) |
| PSI `io` | **some 87–95 %, full 45–64 %** |
| PSI `cpu` | some 10–18 %, full 0 % |

The host was **already IO-saturated** when these numbers were taken; the PSI
line is the single most important fact in this document. The numbers below are
therefore a *degraded-state* baseline. The best-case numbers measured earlier
on the same host, when it was quieter, are recorded separately.

## Dataset

| Table | Rows | Size on disk |
|---|---|---|
| `books` | 369 155 | — |
| `book_search` | 369 155 | heap 313 MB + indexes 236 MB (549 MB) |
| `edition_identifiers` | ~805 000 | — |
| `edition_contributors` | ~471 000 | — |
| `edition_shape` | ~353 000 | — |
| `edition_genres` | ~99 000 | — |
| `contributors` | ~213 000 | — |

Identifier issuers in use, by volume: `isbn13` 279 319, `bookhive.buzz` 236 615,
`goodreads` 228 109, `googlebooks` 35 206. Note: the issuer is `isbn13`, not
`isbn` — a body naming `isbn` matches nothing.

## How the numbers were taken

- **End-to-end XRPC**: sequential `curl` to `http://127.0.0.1:5176/xrpc/...`,
  one sample per shape, `-m 15`, `content-type: application/json`. **The NSID
  must be the dotted form** (`/xrpc/community.lexicon.media.book.searchEditions`);
  the slash form (`/xrpc/community.lexicon.media.book/searchEditions`) is
  treated as an unknown method and answers `400 {"error":"InvalidRequest"}`
  with no message in ~2 ms — a probe mistake that looks like a real failure.
- **SQL-level**: `pg_stat_statements` cumulative means/maxima as reported by the
  server, plus direct `psql` timings for primitives with `statement_timeout=0`.
- **System**: `/proc/pressure/{io,cpu}`, `vmstat`, `/proc/meminfo`, `loadavg`.

## End-to-end XRPC (degraded host, one sample each)

| Body | Method | Status | Time | Bytes |
|---|---|---|---|---|
| `{"q":"dune","limit":25}` | searchEditions | **503** | 10.01 s | 62 |
| `{"title":"dune","limit":25}` | searchEditions | **503** | 10.08 s | 62 |
| `{"author":"herbert","limit":25}` | searchEditions | **503** | 10.15 s | 62 |
| `{"q":"dune","sort":"title","order":"asc","limit":25}` | searchEditions | **503** | 10.04 s | 62 |
| `{"q":"dune","sort":"publishedYear","order":"desc","limit":25}` | searchEditions | **503** | 10.27 s | 62 |
| `{"q":"the","offset":5000,"limit":25}` | searchEditions | **503** | 10.09 s | 62 |
| `{"q":"dune","limit":100}` | searchEditions | 200 | 6.05 s | 201 412 |
| `{"identifiers":[{"issuer":"isbn13","value":"9783446270909"}],"limit":5}` | searchEditions | 200 | 2.07 s | 1 684 |
| same identifier body | resolveEditions | 200 | **0.055 s** | 1 684 |
| `{"identifiers":[{"issuer":"isbn13","value":"9780000000000"}]}` | resolveEditions | 200 | 0.44 s | 38 (0 items) |

Every 503 body is `{"error":"ServiceUnavailable","message":"catalog unavailable"}`.
The 6.05 s success at `limit=100` next to 10 s failures at `limit=25` is
evidence of variance under IO pressure, not of `limit` being the cost driver —
one sample per shape cannot separate them.

**A statement timeout is not the only failure shape:** while the pool cannot get
a connection, the server logs `timeout exceeded when trying to connect` and the
request also ends as 503; clients additionally see connection-level aborts
(`000`) when the edge is restarted mid-request.

## SQL-level (what the 10 s is spent on)

| Statement | Mean | Max | Calls |
|---|---|---|---|
| search candidates CTE (`WITH candidates AS …` over `book_search`) | 224 ms | 723 ms | 5 |
| `SELECT count(*) FROM book_search WHERE document @@ websearch_to_tsquery(...)` | 269 ms | — | direct |
| `SELECT count(*) FROM book_search` | 14.8 ms | — | direct |
| `count(*)` for `total` (second statement, removed in 0.6.3) | **554 ms** | — | earlier |
| hydration `edition_contributors` / `edition_identifiers` / `edition_shape` | 292 ms | 444 s | thousands |
| `SELECT e.uri FROM editions e LEFT JOIN edition_cover_files …` | **18.7 s** | 389 s | 926 |
| `INSERT INTO book_search … SELECT` (backfill/trigger) | 88.7 s | 349 s | 11 |
| `happyview_records` read (HappyView's plane) | 13.2 s | 619 s | 95 |

Pool configuration that produces the user-visible ceiling:
`searchPool` = max **5** connections, `connectionTimeoutMillis` **2 000**,
server-side `statement_timeout` **10 000**. (`docs/architecture.md` said "two
seconds"; the code and the host say ten. Corrected in that file with a link
here.)

## Best case measured earlier (for the migration target)

| Operation | Time |
|---|---|
| page query, warm | 41–84 ms |
| `count(*)` for `total` | 554 ms |
| offset 5 000 | re-scan + sort |
| `sort=publishedYear` | external sort |

## Failure modes observed (the "dangers")

1. **The count doubles the request.** `total` used to cost a second statement
   (554 ms, more than the page). Removed from search in web `0.6.3`: `total` is
   now exact only when the first page is short and omitted otherwise.
2. **Working set exceeds RAM.** 549 MB of `book_search` + a 5.2 GB database
   against 737–915 MB available: page reads hit disk on every miss, so latency
   is bimodal (tens of ms when warm, seconds when cold).
3. **Search is a victim of the other plane.** HappyView ingest drives the disk
   (`INSERT INTO happyview_record_refs` waiting on `LWLock`/`IO`); with
   `io some` at 87–95 %, any statement that touches cold pages exceeds 10 s.
   Moving search off Postgres makes it immune to this; it does not fix it.
4. **Pool acquisition can fail before SQL.** `connectionTimeoutMillis` 2 s and
   5 slots: under saturation requests fail with "timeout exceeded when trying to
   connect", so a retry loop sees 503s that never executed a query.
5. **Ten seconds is the ceiling, and it is a hard cut.** A timeout returns 503
   with no partial page; there is no smaller degraded response.
6. **A failing cache stores nothing.** The 10 s LRU only helps repeated bodies
   once one of them succeeds; under saturation every miss fails, so the cache
   cannot break the loop.
7. **The worker window defers maintenance.** Ingest/backfills/queued jobs run
   only 01:00–08:00 ET; a deploy or a schema replay that needs a backfill waits
   up to 17 h. Deploys still replay `packages/worker/sql/*.sql` regardless.
8. **SQL replay is forward-only.** Every `*.sql` file is re-applied on each
   deploy; some drop columns/tables or rewrite data, and the `--replacement`
   window is unpurged at every later install. Back up before such a release.
9. **Trigger write amplification.** Each statement over `books` or its children
   recomputes documents; the backfill `INSERT … SELECT` has been observed at
   88 s mean / 349 s max, competing with reads.
10. **`enable_seqscan=off` is global to the search pool.** A query that cannot
    use an index gets a worse plan than the planner would choose; the setting
    buys determinism, not optimal plans.
11. **Ranking is bucket-based.** Identifier > title > author > free text, with
    `ts_rank_cd` as the tie-break. Any replacement must reproduce the top-25
    overlap (gate: ≥ 0.9, title queries especially), because callers see order.
12. **Local extensions are not in the lexicon.** `language`, `sort` and `order`
    are provider extensions; upstream declares no filter and no order. A new
    engine must support them without changing the record shape.
13. **The NSID probe trap.** Slash-separated paths return a bodiless 400 in
    2 ms. Do not read that as load: it means the method was not dispatched.

## What the replacement must beat

Measured on a 365 k-document Tantivy 0.27 index, pinned to 2 cores (same shape
as this catalog):

| Operation | Postgres (this doc) | Tantivy (measured) |
|---|---|---|
| Broad query, 242 280 matches, page | 41–84 ms (warm) / >10 s (degraded) | p50 4.4 ms / p95 6.3 ms |
| Exact `total` | 554 ms, second statement | included in the same pass |
| 5 concurrent searches | 10 s timeouts | 100 broad queries in 0.167 s (~600 q/s) |
| `offset 5000` | re-scan | 3.5 ms |
| `sort=publishedYear` | external sort | 0.89 ms |
| Index footprint in the hot path | 549 MB | 78–148 MB (≤200 MB expected on real data) |
| Process memory | shared with the DB | ~15 MB RSS + ≤80 MB evictable page cache |

Acceptance gates for the flip: p50 ≤ 10 ms for `q`/`title`/`author` bodies,
top-25 overlap ≥ 0.9 against Postgres in shadow mode, and a fallback rate of
zero over a day of real traffic.

## Re-running this baseline

```bash
U=http://127.0.0.1:5176/xrpc/community.lexicon.media.book
curl -s -m 15 -o /dev/null -w '%{http_code} %{time_total}\n' \
  -X POST -H 'content-type: application/json' \
  -d '{"q":"dune","limit":25}' "$U.searchEditions"

sudo -u postgres psql -d bibliograph_v2 -X -q -A -F '|' -c \
  "select calls, round(mean_exec_time::numeric,1), round(max_exec_time::numeric,1), left(regexp_replace(query,'\s+',' ','g'),70)
     from pg_stat_statements where query ilike '%book_search%' order by calls desc"

cat /proc/pressure/io; cut -d' ' -f1-3 /proc/loadavg
awk '/MemAvailable|SwapFree/{print}' /proc/meminfo
```

Record one sample per shape when the host is quiet (that is the latency floor)
and again under HappyView ingest (that is the operational ceiling). Always note
the PSI line with the numbers: without it, two runs are not comparable.
