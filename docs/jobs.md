# Jobs and workers

How background work is scheduled and drained. The short answer: systemd timers
run bounded *scan* oneshots that only enqueue; the single
`bibliograph-worker.service` process runs the graphile task lists that do the
actual fetching. The web app never scrapes on the request path.

## The two halves

**Producers — `debian/bibliograph-<name>-backfill.{service,timer}`.**
A `Type=oneshot` unit runs a `scripts/backfill-*.ts` scan via `tsx`. The scan
selects actionable rows (bounded by `--limit`) and enqueues one graphile job
per row. It does no upstream fetching itself. The paired timer fires the
oneshot on a `OnCalendar=` cadence; `Persistent=true` catches up a missed tick
on the next boot. The oneshot services are installed `--no-enable --no-start`
(they exist to be timer-triggered); the timers are enabled and started by
`dh_installsystemd` at package configure time.

**Consumers — `bibliograph-worker.service` (`worker.ts`).**
One long-lived Node process that runs two things under `runJobTasks`
(`src/lib/server/jobs/run-tasks.ts`) plus the TAP consumer:

- graphile task lists from `src/lib/server/jobs/handlers.ts`:
  `searchTaskList` (search ingest + backfills, concurrency
  `GRAPHILE_WORKER_CONCURRENCY_SEARCH`, default 10) and `tapTaskList`
  (PDS mirror upserts/deletes, concurrency `GRAPHILE_WORKER_CONCURRENCY_TAP`,
  default 25). `allTaskList` spreads both; `run-tasks.ts` is the only drain.
- the TAP websocket consumer (restarted on a 30s delay on failure so a dead
  subscription cannot stop job processing).

Jobs live in `graphile_worker.jobs` (Postgres). Producers dedupe with a
`jobKey` (`backfill-description:<uri>` etc.); the graphile uniqueness on `key`
makes re-enqueueing a pending row a no-op, and the scan's own `NOT EXISTS key =`
pre-filter keeps reruns cheap on top of that. `maxAttempts: 5`; graphile
retries thrown errors with backoff. `GoodreadsBlockedError` is *not* thrown —
`backfillEditionMetadata` returns `{ status: 'blocked' }`, so anti-bot
responses are not retried.

## The description backfill, end to end

1. `bibliograph-description-backfill.timer` fires hourly at `:40`
   (`OnCalendar=*-*-* *:40:00`, `OnBootSec=35min`, `RandomizedDelaySec=5min`
   so a fleet does not hit Google Books in unison).
2. It runs `bibliograph-description-backfill.service`, which executes
   `scripts/backfill-descriptions.ts --limit 1000`. The scan selects editions
   with `description IS NULL`, `description_checked_at IS NULL`, and no pending
   `backfill-description:<uri>` job in `graphile_worker.jobs`, then enqueues
   `backfill-edition-description` with `maxAttempts: 5`.
3. `bibliograph-worker.service` picks the jobs up off `searchTaskList`, which
   maps `backfill-edition-description` → `backfillEditionDescriptionTask` →
   `backfillDescriptionForEdition(uri, log)` (`src/lib/server/jobs/description-backfill.ts`).
   It tries Google Books (volume-id, then ISBN) and ISBNdb as fallback, writes
   only if the row still lacks a description, moves the record CID, and stamps
   `description_checked_at`. A miss is stamped too, so permanent misses are not
   re-asked; a row whose upstream call *failed* is not stamped, so the next
   hourly tick retries it.

So: it is **both** — a systemd timer enqueues hourly, and the worker process
drains and executes. Nothing runs inside the web app, and nobody has to run it
by hand. `Persistent=true` plus the stamped rows make a missed tick harmless.

As of 0.5.22 there is also an on-demand path: the administrators-only
"Queue description + metadata backfill" button on `/editions/[rkey]` enqueues
`backfill-edition-description` (and `backfill-edition-format`) for that one
edition straight from the web process (`runBackfill` action in
`src/routes/editions/[rkey]/+page.server.ts`). The contributor detail page
has the same shape: its `runBackfill` action enqueues
`backfill-contributor-image` and `backfill-contributor-bio` (registered in
`searchTaskList`). Same task list, same worker, same `jobKey`
dedupe. The description/bio jobs themselves no-op when the row already has
the field.

### On-read enqueues

Read paths also fire the backfills, because they are idempotently gated on
"never checked":

- `getImageForBook` / `getImageForContributor` have always enqueued the cover /
  portrait resolver exactly this way (gated on `cover_checked_at` /
  `image_checked_at`).
- `jobs/on-read.ts` (`maybeEnqueueEditionBackfills` /
  `maybeEnqueueContributorBackfills`) generalises the pattern: one indexed
  `ANY()` query for missing-and-unchecked rows across the editions/contributors
  tables, enqueue with the usual `jobKey` dedupe. Fire-and-forget; failures
  log and never fail the read; steady state is zero jobs.
- Wired into: `hydrateBooksByUri` (every shelf/book XRPC), the
  `community.lexicon.book.searchEditions` / `resolveEditions` /
  `searchWorks` / `searchContributors` handlers in `routes/xrpc/book-queries.ts`,
  and `net.olamaelcu.livtet.biblio.getEditionsByContributor`.
  `searchWorks` enqueues only the embedded contributors; there is no work
  backfill task.

The read path never stamps anything; stamps come from the worker when it runs
the backfill for real. A row that comes back `no_cover_found` / `not_found` /
`deferred` keeps whatever stamp the backfill applies, or none (deferred rows
are deliberately left unchecked) — the read path adds no new stamping rules.

### Sizing and quota

The scan is `--limit 1000`/hour on purpose: ~24k/day is a modest share of the
the Google Books quota, which the ISBN backfill (`OnCalendar=daily`, up to 1h
randomized delay, `--limit 83000`) and the cover backfill (even hours at `:00`
with up to 15min randomized delay, `--limit 1000`) also draw on; the
minute offsets keep their scans from racing for the same 429. Rows stamped
`description_checked_at` are skipped forever (permanent miss).

## Other timer-driven backfills

| Timer | When (UTC) | Scan script | Enqueues | Drained by |
|---|---|---|---|---|
| `bibliograph-description-backfill.timer` | hourly `:40` (+≤5min jitter) | `backfill-descriptions.ts --limit 1000` | `backfill-edition-description` | `bibliograph-worker` (`searchTaskList`) |
| `bibliograph-isbn-backfill.timer` | daily `00:00` (+≤1h jitter) | `backfill-edition-isbns.ts --limit 83000` | `backfill-edition-isbn` | `bibliograph-worker` |
| `bibliograph-cover-backfill.timer` | even hours `:00` (+≤15min jitter) | `backfill-covers.ts --limit 1000` | `backfill-edition-cover` | `bibliograph-worker` |
| `bibliograph-follows-backfill.timer` | hourly `:20` | `backfill-follows.ts --limit 500` | writes directly (`follows` ← Constellation) | oneshot (in-process) |
| `bibliograph-actors-backfill.timer` | daily `04:30` (+≤30min jitter) | `backfill-actors.ts --limit 2000` | writes directly (`actors`) | oneshot (in-process) |
| `bibliograph-bookhive-catalog.timer` | weekly (+≤1h jitter) | `backfill-bookhive-catalog.ts` | writes directly | oneshot (in-process) |
| — (no timer) | — | enqueued by the tap batch-delete path when a mirrored shelf references a missing catalog edition | `backfill-shelving-edition` | `bibliograph-worker` (`tapTaskList`) |

Manual one-off runs exist for each scan (`npx tsx scripts/backfill-<name>.ts
[--dry-run] [--limit N] [--isbn X]`); `--dry-run` writes nothing and is the
safe verification hook.

## Verifying on a host

```sh
systemctl list-timers --all 'bibliograph-*-backfill.timer'
systemctl is-active bibliograph-worker
journalctl -u bibliograph-worker -n 30 --no-pager        # "Completed task …" lines
journalctl -u bibliograph-description-backfill -n 30     # "enqueued N jobs"
psql "$DATABASE_URL" -c \
  "select task_identifier, count(*) from graphile_worker.jobs group by 1"
```

As of 0.5.22 the production host shows the timer enabled and active (hourly
`:40`, e.g. `NEXT 03:41:07 UTC`, `LAST 02:41:16 UTC`) and the worker active.

## Adding a new backfill

Follow the description-backfill shape exactly: enqueue-only scan script →
graphile task in `handlers.ts` → register in `searchTaskList` (or `tapTaskList`
for local upserts) → `enqueue*` helper in `enqueue.ts` with a per-URI `jobKey`
→ `bibliograph-<name>-backfill.{service,timer}` with a minute offset the other
timers do not use → packaged in `debian/rules` → verify with `--dry-run` before
the first real run. Anything that can return a permanent failure must be
handled in-process (log + return a `blocked`/`no_change` result), not thrown,
or graphile will retry it five times.
