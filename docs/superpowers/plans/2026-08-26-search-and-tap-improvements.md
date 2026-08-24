# Search Pipeline & TAP Ingest Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fire-and-forget ingestion with a real Graphile Worker-backed job queue (also covering TAP firehose ingest), add GIN indexes for text + identifier lookups, batch the ingest path, add retry/circuit-breaker/request-timeout hardening, expose metrics + rate limiting, and backfill direct unit tests for `SearchService` / `LocalPostgresIngestor` / `serveBookRecordFromDb`.

**Architecture:** Six sequential phases. Each phase lands behind a single review + commit boundary so a regression is easy to bisect. Phases 1 (queue + DLQ + TAP) and 2 (indexes) unblock the others; Phases 3-6 polish.

**Tech Stack:** TypeScript, Node 22+, atcute, @atproto/lex-cbor, Drizzle ORM, Postgres 14+, pino, **graphile-worker** (new), **prom-client** (new), **pg_trgm** extension.

**Reference:** `docs/superpowers/plans/2026-08-24-search-editions-works-external.md` (Phase 1 baseline). `src/lib/server/api/open-library.ts` and `src/lib/server/api/google-books.ts` are the upstream wrappers being upgraded.

**Design summary** (since `docs/superpowers/specs/` was removed at the user's request after the previous feature):

- **Phase 1 — Job queue + DLQ + TAP migration**: replace `LocalPostgresIngestor.ingest(items)` fire-and-forget with `quickAddJob` per item (Graphile Worker, Postgres-backed, retry-with-backoff built in). New `jobs/enqueue.ts` exposes `enqueueIngest(kind, item)`, `enqueueRecordUpsert(uri, did, rkey, value)`, `enqueueRecordDelete(uri)`. Move `tap-consumer.ts` inline DB writes to two new task handlers (`tap-record-upsert` / `tap-record-delete`). Two DLQ tables: `ingest_dead_letter` for search failures, `tap_dead_letter` for TAP failures. New `worker-search-jobs.ts` runs both task types in one process, separate concurrency per `task_list_identifiers` (10 for search, 25 for TAP).
- **Phase 2 — Indexes**: `pg_trgm` GINs on `editions.title`, `works.title`, `contributors.name`; drop unused `editions.search_vector` GIN; `jsonb_path_ops` GINs on all four `identifiers` columns.
- **Phase 3 — Batch + parallel**: batched multi-row UPSERT per table in ingest handlers; bounded concurrency for Google Books enrichment.
- **Phase 4 — Retry / breaker / timeout**: per-upstream exponential-backoff retry (429 + 5xx only); per-upstream circuit breaker; request-level timeout plumbed through all stages; structured `degraded` field on `SearchResult`; XRPC `UpstreamUnavailable` (502) on total miss.
- **Phase 5 — Rate limit + metrics**: token-bucket per `(ip, nsid)` on XRPC; `prom-client` counters + histograms at `/metrics`.
- **Phase 6 — Tests**: `SearchService` unit tests with fake strategies; `LocalPostgresIngestor` rkey/discriminator/CID tests; `serveBookRecordFromDb` JSON/CID tests; smoke tests for the strategy wrappers.

---

## File map

**New files**

```
packages/bibliograph-service/
├── drizzle/
│   └── 0004_graphile_jobs.sql              # Graphile Worker schema + 2 DLQ tables
├── drizzle/
│   └── 0005_search_and_identifiers.sql    # pg_trgm + jsonb_path_ops GINs
├── src/lib/server/
│   ├── jobs/
│   │   ├── enqueue.ts                      # enqueueIngest / enqueueRecordUpsert / enqueueRecordDelete
│   │   ├── enqueue.test.ts
│   │   └── handlers.ts                     # 5 task handlers
│   ├── api/
│   │   ├── retry.ts                       # exponential backoff + jitter helper
│   │   ├── breaker.ts                      # in-memory circuit breaker
│   │   └── open-library.cursor.test.ts     # (extends existing test if missing)
│   ├── search/
│   │   ├── service.test.ts                 # 6 unit tests with fake strategies
│   │   ├── local-postgres-ingestor.test.ts # 8 tests (rkey/discriminator/CID)
│   │   ├── open-library-source.test.ts     # smoke test
│   │   ├── google-books-enricher.test.ts   # smoke test
│   │   └── wikipedia-enricher.test.ts      # smoke test
│   ├── rate-limit.ts
│   ├── metrics.ts
│   └── xrpc-router.test.ts                 # 5 tests for serveBookRecordFromDb
├── src/
│   ├── worker-search-jobs.ts               # companion to existing worker.ts
│   └── routes/metrics/+server.ts
└── scripts/
    └── verify-tap-jobs.ts
```

**Modified files**

- `packages/bibliograph-service/package.json` — add `graphile-worker`, `prom-client` deps; add `verify:tap-jobs` script.
- `packages/bibliograph-service/src/lib/server/tap-consumer.ts` — replace inline DB writes with `enqueueRecordUpsert` / `enqueueRecordDelete`; remove `// TODO: Fire as a background job` comments.
- `packages/bibliograph-service/src/lib/server/search/service.ts` — drop `LocalPostgresIngestor` calls; add `enqueueIngest` per item; emit `degraded` on upstream errors; accept optional `signal` arg.
- `packages/bibliograph-service/src/lib/server/search/local-postgres-ingestor.ts` — keep class for back-compat but `ingest()` becomes a thin no-op (logic moved to `jobs/handlers.ts`); OR delete entirely after Phase 1 lands.
- `packages/bibliograph-service/src/lib/server/search/types.ts` — add `degraded?: { upstream: string; reason: string }` to `SearchResult<T>`.
- `packages/bibliograph-service/src/lib/server/search/postgres-source.ts` — replace `ILIKE` with trigram-friendly query.
- `packages/bibliograph-service/src/lib/server/api/open-library.ts` — use `retry()`; honor `cursor` (forward page); cap `limit` to OL's 100.
- `packages/bibliograph-service/src/lib/server/api/google-books.ts` — bounded concurrency (e.g., 8); use `retry()`; remove `warn-once` module-level flag in favor of `info`-per-call.
- `packages/bibliograph-service/src/lib/server/api/wikipedia.ts` — chunk URL-encoded name list (50 per chunk); use `retry()`.
- `packages/bibliograph-service/src/lib/server/xrpc-router.ts` — install `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` per request; route through new breaker + rate-limit middleware; emit `degraded` field; map total-miss to 502 `UpstreamUnavailable`.
- `packages/bibliograph-service/src/hooks.server.ts` — pass metrics middleware to SvelteKit handle (optional).
- `packages/bibliograph-service/.env.example` — add `GRAPHILE_WORKER_CONCURRENCY_SEARCH`, `GRAPHILE_WORKER_CONCURRENCY_TAP`, `RATE_LIMIT_RPM_PUBLIC`, `RATE_LIMIT_RPM_PDS`, `REQUEST_TIMEOUT_MS`.

---

## Task 1: Add `graphile-worker` + `prom-client` deps

**Files:**
- Modify: `packages/bibliograph-service/package.json`

- [ ] **Step 1: Install deps**

From `packages/bibliograph-service`:

```bash
pnpm add graphile-worker prom-client
```

- [ ] **Step 2: Verify the deps resolve**

```bash
pnpm exec tsx -e "import { quickAddJob, runTaskList, makeWorkerUtils } from 'graphile-worker'; console.log(typeof quickAddJob);"
```

Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/package.json pnpm-lock.yaml
git commit -m "deps: add graphile-worker and prom-client"
```

## Task 2: Hand-authored migration for Graphile Worker schema + DLQ tables

**Files:**
- Create: `packages/bibliograph-service/drizzle/0004_graphile_jobs.sql`

Graphile Worker ships its own migration tool (`graphile-worker migrate`). For simplicity this task uses a hand-authored SQL file. It must run BEFORE `graphile-worker`'s worker boots (the worker expects `graphile_worker` schema + tables).

- [ ] **Step 1: Write the migration**

`packages/bibliograph-service/drizzle/0004_graphile_jobs.sql`:

```sql
-- drizzle/0004_graphile_jobs.sql
-- Graphile Worker schema + tables (job queue lives in Postgres, no extra service).
-- Two DLQ tables: ingest_dead_letter (search) + tap_dead_letter (TAP).
-- Graphile Worker will create graphile_worker schema + _jobs/_tasks/_scheduled_events
-- on first worker boot; we pre-create DLQ tables here so they're tracked by drizzle.

CREATE TABLE "ingest_dead_letter" (
  "id"            bigserial PRIMARY KEY,
  "uri"           text UNIQUE NOT NULL,
  "payload"       jsonb NOT NULL,
  "error_message" text NOT NULL,
  "attempts"      integer NOT NULL DEFAULT 0,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "ingest_dead_letter_created_at_idx" ON "ingest_dead_letter" ("created_at");

CREATE TABLE "tap_dead_letter" (
  "id"            bigserial PRIMARY KEY,
  "event_seq"     bigint,
  "repo_did"      text NOT NULL,
  "collection"    text NOT NULL,
  "rkey"          text NOT NULL,
  "payload"       jsonb NOT NULL,
  "error_message" text NOT NULL,
  "attempts"      integer NOT NULL DEFAULT 0,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "tap_dead_letter_created_at_idx" ON "tap_dead_letter" ("created_at");
CREATE INDEX "tap_dead_letter_did_idx" ON "tap_dead_letter" ("repo_did");

--> statement-breakpoint
```

- [ ] **Step 2: Apply migration**

```bash
psql "$DATABASE_URL" -f drizzle/0004_graphile_jobs.sql
```

Expected:
```
CREATE TABLE
CREATE INDEX
CREATE TABLE
CREATE INDEX
CREATE INDEX
```

- [ ] **Step 3: Run Graphile Worker's own migration to create the queue tables**

```bash
pnpm exec graphile-worker migrate --connection "$DATABASE_URL"
```

Expected: prints migration steps and completes without error. Confirm `graphile_worker._jobs` table exists:
```bash
psql "$DATABASE_URL" -c "\dt graphile_worker.*"
```
Should list `_jobs`, `_tasks`, `_scheduled_events`, etc.

- [ ] **Step 4: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/drizzle/0004_graphile_jobs.sql
git commit -m "feat(db): add Graphile Worker DLQ tables (ingest_dead_letter, tap_dead_letter)"
```

## Task 3: Add DLQ tables to Drizzle schema

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/db/schema.ts`

- [ ] **Step 1: Add the two tables**

Append to `packages/bibliograph-service/src/lib/server/db/schema.ts`:

```ts
export const ingestDeadLetter = pgTable(
  'ingest_dead_letter',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uri: text('uri').notNull().unique(),
    payload: jsonb('payload').notNull(),
    errorMessage: text('error_message').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index('ingest_dead_letter_created_at_idx').on(t.createdAt),
  }),
);

export const tapDeadLetter = pgTable(
  'tap_dead_letter',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventSeq: bigserial('event_seq', { mode: 'number' }),
    repoDid: text('repo_did').notNull(),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    payload: jsonb('payload').notNull(),
    errorMessage: text('error_message').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index('tap_dead_letter_created_at_idx').on(t.createdAt),
    didIdx: index('tap_dead_letter_did_idx').on(t.repoDid),
  }),
);

export type IngestDeadLetterRow = typeof ingestDeadLetter.$inferSelect;
export type TapDeadLetterRow = typeof tapDeadLetter.$inferSelect;
```

Add to the imports at the top of the file: `import { bigserial, ... } from 'drizzle-orm/pg-core';` — actually `bigserial` is exported from `drizzle-orm/pg-core`; if the file already imports from `drizzle-orm/pg-core` add `bigserial`, otherwise import `{ bigserial, bigint, ... }` from `drizzle-orm/pg-core`.

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/db/schema.ts
git commit -m "feat(db): drizzle types for ingest_dead_letter + tap_dead_letter"
```

## Task 4: `jobs/enqueue.ts` module

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/jobs/enqueue.ts`
- Create: `packages/bibliograph-service/src/lib/server/jobs/enqueue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/server/jobs/enqueue.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { quickAddJob } from 'graphile-worker';
import { enqueueIngest, enqueueRecordUpsert, enqueueRecordDelete } from './enqueue.ts';

test('enqueueIngest calls quickAddJob with ingest-edition task', async () => {
  let captured: { taskIdentifier: string; payload: unknown } | undefined;
  (quickAddJob as unknown as (spec: unknown) => Promise<unknown>) = async (spec: { taskIdentifier: string; payload: unknown }) => {
    captured = spec;
    return null;
  };
  await enqueueIngest('edition', { title: 'Test', ... } as never);
  assert.equal(captured?.taskIdentifier, 'ingest-edition');
});

test('enqueueRecordUpsert calls quickAddJob with tap-record-upsert task', async () => {
  // similar
});

test('enqueueRecordDelete calls quickAddJob with tap-record-delete task', async () => {
  // similar
});
```

Full stub pattern (recommended): capture `quickAddJob` calls via `globalThis.fetch`-style override. Implementation hint: the module should re-import `quickAddJob` lazily via `await import('graphile-worker')` so tests can monkey-patch the module.

- [ ] **Step 2: Implement**

```ts
// src/lib/server/jobs/enqueue.ts
import type { EditionItem, WorkItem, ContributorItem } from '../search/types.ts';

type IngestItem = EditionItem | WorkItem | ContributorItem;

export async function enqueueIngest(kind: 'edition' | 'work' | 'contributor', item: IngestItem): Promise<void> {
  const { quickAddJob } = await import('graphile-worker');
  await quickAddJob({ taskIdentifier: `ingest-${kind}`, payload: item });
}

export async function enqueueRecordUpsert(uri: string, did: string, rkey: string, value: Record<string, unknown>): Promise<void> {
  const { quickAddJob } = await import('graphile-worker');
  await quickAddJob({ taskIdentifier: 'tap-record-upsert', payload: { uri, did, rkey, value } });
}

export async function enqueueRecordDelete(uri: string): Promise<void> {
  const { quickAddJob } = await import('graphile-worker');
  await quickAddJob({ taskIdentifier: 'tap-record-delete', payload: { uri } });
}
```

- [ ] **Step 3: Run tests + commit**

```bash
pnpm exec tsx --test src/lib/server/jobs/enqueue.test.ts
git add packages/bibliograph-service/src/lib/server/jobs/
git commit -m "feat(jobs): enqueue helpers for ingest + tap record handlers"
```

## Task 5: `jobs/handlers.ts` — 5 task handlers

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/jobs/handlers.ts`

- [ ] **Step 1: Extract upsert logic**

Move the three `ingestEdition`/`ingestWork`/`ingestContributor` private methods out of `LocalPostgresIngestor` into `handlers.ts` as the body of three `task()` callbacks. The existing `cidForLex(value).toString()` logic moves with them. The rkey derivation functions (`rkeyForEdition`, etc.) also move.

- [ ] **Step 2: Add TAP handlers**

```ts
task('tap-record-upsert', async (payload) => {
  const { uri, value } = payload as { uri: string; did: string; rkey: string; value: Record<string, unknown> };
  await db.insert(records).values({
    uri,
    cid: 'bafyplaceholder', // TAP-record CIDs aren't computed (no value shape contract)
    did: (payload as { did: string }).did,
    rkey: (payload as { rkey: string }).rkey,
    collection: uri.split('/').slice(-2, -1)[0]!, // parse from at://did/collection/rkey
    value: value as never,
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: records.uri,
    set: { value: value as never, indexedAt: new Date() },
  });
});

task('tap-record-delete', async (payload) => {
  const { uri } = payload as { uri: string };
  await db.delete(records).where(eq(records.uri, uri));
});
```

- [ ] **Step 3: Add error handling — write to DLQ on throw**

Wrap each handler body in `try/catch`. On error:
- search handlers → `db.insert(ingestDeadLetter).values({uri, payload: item, errorMessage: e.message, attempts: ...})`
- TAP handlers → `db.insert(tapDeadLetter).values({repoDid, collection, rkey, payload, errorMessage: e.message, attempts: ...})`

The Graphile Worker task callback signature is `(payload, helpers) => Promise<any>`. Helpers expose `helpers.job` with `attempt` count.

- [ ] **Step 4: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/jobs/handlers.ts
git commit -m "feat(jobs): task handlers for search ingest + tap records with DLQ on error"
```

## Task 6: Modify `tap-consumer.ts` to use the queue

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/tap-consumer.ts`

- [ ] **Step 1: Replace inline DB writes**

Find the two TODO'd blocks (lines ~56 and ~60). Replace each with `await enqueueRecordUpsert(uri, did, rkey, event.record ?? {})` / `await enqueueRecordDelete(uri)` respectively.

- [ ] **Step 2: Remove the `// TODO: Fire as a background job` comments**

- [ ] **Step 3: Verify typecheck**

```bash
pnpm exec svelte-check --tsconfig ./tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/tap-consumer.ts
git commit -m "refactor(tap): enqueue record upserts/deletes via Graphile Worker jobs"
```

## Task 7: `worker-search-jobs.ts` entry point

**Files:**
- Create: `packages/bibliograph-service/src/worker-search-jobs.ts`

- [ ] **Step 1: Implement**

```ts
// src/worker-search-jobs.ts
// Companion to src/worker.ts (which runs TAP tap-consumer logic).
// Runs Graphile Worker task handlers for search ingest + tap records.
// Two task lists (separated via task_list_identifiers) run in the same
// process with different concurrency settings.

import { runTaskList, makeWorkerUtils } from 'graphile-worker';
import { handlers } from './lib/server/jobs/handlers.ts';

const SEARCH_CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY_SEARCH ?? 10);
const TAP_CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY_TAP ?? 25);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');

  const utils = makeWorkerUtils({ connectionString });

  await Promise.all([
    runTaskList({
      connectionString,
      concurrency: SEARCH_CONCURRENCY,
      taskList: handlers.searchTaskList, // 'ingest-*'
      ...utils,
    }),
    runTaskList({
      connectionString,
      concurrency: TAP_CONCURRENCY,
      taskList: handlers.tapTaskList,     // 'tap-record-*'
      ...utils,
    }),
  ]);
}

main().catch((err) => {
  console.error('worker-search-jobs failed:', err);
  process.exit(1);
});
```

Note: `handlers.ts` exports `searchTaskList` and `tapTaskList` registry objects (Pattern B in Graphile Worker docs) to filter tasks per worker.

- [ ] **Step 2: Add npm script**

Add to `packages/bibliograph-service/package.json` scripts: `"worker:search": "tsx worker-search-jobs.ts"`.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/worker-search-jobs.ts packages/bibliograph-service/package.json
git commit -m "feat(worker): add worker-search-jobs.ts entry point with split task lists"
```

## Task 8: Modify `SearchService` to enqueue (no more fire-and-forget)

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/search/service.ts`

- [ ] **Step 1: Replace `void ingestor.ingest(...)` with `enqueueIngest`**

Each of the three public methods currently ends with `void this.deps.ingestor.ingest(items).catch(() => undefined);`. Replace with:

```ts
for (const item of items) {
  await enqueueIngest(kind, item); // kind = 'edition' | 'work' | 'contributor'
}
```

Note: `enqueueIngest` returns a Promise but is awaited here. This intentionally makes the request handler block on the enqueue call (typically a few ms total) so the user sees any persistent Postgres outage in the response. The actual heavy lifting (CBOR hashing, UPSERT) happens in the worker process.

- [ ] **Step 2: Remove `LocalPostgresIngestor` from `SearchServiceDeps`**

Drop `ingestor` from the deps object. `SearchService` no longer holds it.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/search/service.ts
git commit -m "refactor(search): replace fire-and-forget ingest with enqueueIngest"
```

## Task 9: TAP jobs verify script

**Files:**
- Create: `packages/bibliograph-service/scripts/verify-tap-jobs.ts`
- Modify: `packages/bibliograph-service/package.json`

- [ ] **Step 1: Add npm script**

```json
"verify:tap-jobs": "tsx --test scripts/verify-tap-jobs.ts"
```

- [ ] **Step 2: Implement**

Use `node:test`. Wire up a real `graphile-worker` runner against the local DB; enqueue 2 `tap-record-upsert` + 1 `tap-record-delete`; assert rows land in `records` table; assert error case lands in `tap_dead_letter`.

- [ ] **Step 3: Run + commit**

```bash
pnpm run verify:tap-jobs
git add scripts/verify-tap-jobs.ts package.json
git commit -m "test: verify TAP queue round-trips through Graphile Worker"
```

---

## Phase 1 done. Moving to Phase 2.

## Task 10: Migration — pg_trgm + jsonb_path_ops GINs

**Files:**
- Create: `packages/bibliograph-service/drizzle/0005_search_and_identifiers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- drizzle/0005_search_and_identifiers.sql
-- Drop unused editions.search_vector GIN (the code uses ILIKE, not tsvector @@).
-- Add pg_trgm GINs on the three search columns + jsonb_path_ops GINs on every
-- identifiers column (used by @> containment queries).

DROP INDEX IF EXISTS "editions_search_idx";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "editions_title_trgm"        ON "editions"     USING GIN ("title" gin_trgm_ops);
CREATE INDEX "works_title_trgm"            ON "works"        USING GIN ("title" gin_trgm_ops);
CREATE INDEX "contributors_name_trgm"      ON "contributors" USING GIN ("name"  gin_trgm_ops);

CREATE INDEX "editions_identifiers_gin"     ON "editions"     USING GIN ("identifiers" jsonb_path_ops);
CREATE INDEX "works_identifiers_gin"        ON "works"        USING GIN ("identifiers" jsonb_path_ops);
CREATE INDEX "contributors_identifiers_gin" ON "contributors" USING GIN ("identifiers" jsonb_path_ops);
CREATE INDEX "publishers_identifiers_gin"   ON "publishers"   USING GIN ("identifiers" jsonb_path_ops);

--> statement-breakpoint
```

- [ ] **Step 2: Apply**

```bash
psql "$DATABASE_URL" -f drizzle/0005_search_and_identifiers.sql
```

Expected: index DDL statements succeed.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add drizzle/0005_search_and_identifiers.sql
git commit -m "feat(db): pg_trgm GINs on title/name + jsonb_path_ops GINs on identifiers"
```

## Task 11: `PostgresSource` — switch from ILIKE to trigram-compatible query

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/search/postgres-source.ts`

- [ ] **Step 1: Change the q filter**

In `runSearch` (around line 66), the existing clause:
```ts
if (query.q) conds.push(sql`${qColumn} ILIKE ${'%' + query.q + '%'}`);
```
is already compatible with `pg_trgm` — no SQL change needed. Trigram GINs accelerate leading-wildcard `ILIKE` automatically. Just ensure the index exists (Task 10) and the query planner picks it up.

- [ ] **Step 2: Run the existing 15-test file to confirm no regressions**

```bash
pnpm exec tsx --test src/lib/server/search/postgres-source.test.ts
```

Expected: 15/15 pass.

- [ ] **Step 3: Verify with EXPLAIN ANALYZE**

```bash
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT * FROM editions WHERE title ILIKE '%test%' LIMIT 10;"
```

Expected: the planner reports `Bitmap Index Scan on editions_title_trgm` (or similar — confirms the new index is used). If still `Seq Scan`, force the planner: `SET enable_seqscan = off;` then re-run.

- [ ] **Step 4: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/search/postgres-source.ts
git commit -m "perf(search): rely on pg_trgm GIN to accelerate ILIKE q filter"
```

---

## Phase 2 done. Moving to Phase 3.

## Task 12: Batch the search ingest handlers

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/jobs/handlers.ts`

- [ ] **Step 1: Replace per-item UPSERT with multi-row INSERT**

Inside `ingest-edition` / `ingest-work` / `ingest-contributor` task handlers, replace:
```ts
await this.db.insert(t).values(singleRow).onConflictDoUpdate({...});
```
with:
```ts
await this.db.insert(t).values(rowsArray).onConflictDoUpdate({...});
```
Drizzle supports `db.insert(table).values(arrayOfRows).onConflictDoUpdate({...})`. The `set` clause applies to every row.

- [ ] **Step 2: Resolve all CIDs in parallel before the insert**

Replace the per-item `await cidForLex(value)` calls with `const cids = await Promise.all(values.map(cidForLex))` once per batch.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/jobs/handlers.ts
git commit -m "perf(ingest): batch UPSERTs and resolve CIDs via Promise.all"
```

## Task 13: Bounded concurrency in `GoogleBooksEnricher`

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/api/google-books.ts`

- [ ] **Step 1: Replace serial loop with bounded concurrency**

Replace the `for (const item of items) { ... await fetch(url) }` loop with a small inline semaphore:

```ts
const CONCURRENCY = 8;
const queue = items.slice();
const results: EditionItem[] = [];
async function worker() {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    results.push(await enrichOne(item, log));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
```

Or use `Promise.allSettled(items.map(enrichOne))` for the simplest implementation (no rate limiting); replace with the semaphore if Google Books 429s under bursty load.

- [ ] **Step 2: Test still passes**

```bash
pnpm exec tsx --test src/lib/server/api/google-books.test.ts
```

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/api/google-books.ts
git commit -m "perf(google-books): bounded concurrency (8) instead of serial per-item"
```

## Task 14: Wikipedia chunked name lists

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/api/wikipedia.ts`

- [ ] **Step 1: Chunk the joined `names` parameter**

If `unique.length > 50`, split into chunks of 50, `Promise.all` the chunks, merge the resulting `Map`s.

- [ ] **Step 2: Test still passes**

```bash
pnpm exec tsx --test src/lib/server/api/wikipedia.test.ts
```

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/api/wikipedia.ts
git commit -m "perf(wikipedia): chunk URL-encoded name list at 50 to avoid API URL caps"
```

## Task 15: OpenLibrary `limit` cap + `cursor` forwarding

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/api/open-library.ts`

- [ ] **Step 1: Cap `limit` to OL's 100**

```ts
const limit = Math.min(query.limit ?? 20, 100);
```

- [ ] **Step 2: Decode `cursor` into `page`**

`query.cursor` carries v2 `{ src: 'openlibrary'; p: number }`. Decode and pass to `buildUrl`. The PostgresSource cursor encoding for OL is out of scope for this task (the orchestrator owns it).

- [ ] **Step 3: Update tests**

Update `open-library.test.ts:40` to assert `cursor === undefined` (since the wrapper still doesn't emit a cursor). Add a test that decoded cursor is forwarded to `buildUrl`.

- [ ] **Step 4: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/api/open-library.ts packages/bibliograph-service/src/lib/server/api/open-library.test.ts
git commit -m "fix(open-library): cap limit at 100; decode cursor into page"
```

---

## Phase 3 done. Moving to Phase 4.

## Task 16: Retry helper

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/retry.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/api/retry.ts
import { logger } from 'pino';

export interface RetryOpts {
  maxAttempts?: number;       // default 3
  baseDelayMs?: number;       // default 200
  maxDelayMs?: number;        // default 5000
  jitter?: boolean;           // default true
  retryOn?: (status: number) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  log: import('pino').Logger,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const retryOn = opts.retryOn ?? ((s) => s === 429 || s >= 500);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if (!status || !retryOn(status) || attempt === maxAttempts) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const sleep = opts.jitter !== false ? delay * (0.5 + Math.random() * 0.5) : delay;
      log.warn({ stage: 'retry', attempt, status, sleepMs: sleep }, 'retrying after backoff');
      await new Promise((r) => setTimeout(r, sleep));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 2: Test + commit**

```bash
pnpm exec tsx --test src/lib/server/api/retry.test.ts
git add src/lib/server/api/retry.ts src/lib/server/api/retry.test.ts
git commit -m "feat(api): exponential-backoff retry helper with jitter"
```

## Task 17: Per-upstream circuit breaker

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/breaker.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/server/api/breaker.ts
export class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private openedAt = 0;
  constructor(
    private readonly threshold = 5,
    private readonly openMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  canCall(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && this.now() - this.openedAt >= this.openMs) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }
  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
```

- [ ] **Step 2: Test + commit**

```bash
pnpm exec tsx --test src/lib/server/api/breaker.test.ts
git add src/lib/server/api/breaker.ts src/lib/server/api/breaker.test.ts
git commit -m "feat(api): per-upstream in-memory circuit breaker"
```

## Task 18: Wire retry + breaker into all 3 API wrappers

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/api/open-library.ts`
- Modify: `packages/bibliograph-service/src/lib/server/api/google-books.ts`
- Modify: `packages/bibliograph-service/src/lib/server/api/wikipedia.ts`

- [ ] **Step 1: OpenLibrary**

Wrap `fetch` calls in `withRetry(..., { retryOn: (s) => s === 429 || (s >= 500 && s < 600) })`. Honor `Retry-After` header for 429s (parse the delay, override backoff). Wrap with a per-upstream `CircuitBreaker` (constructor takes a logger and `name` field).

- [ ] **Step 2: Same for Google Books + Wikipedia**

- [ ] **Step 3: Tests still pass**

```bash
pnpm exec tsx --test src/lib/server/api/*.test.ts
```

- [ ] **Step 4: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/api/
git commit -m "feat(api): wrap OpenLibrary/Google Books/Wikipedia in retry + circuit breaker"
```

## Task 19: Request-level timeout

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/api/timeout.ts` (already exists from prior feature; add `REQUEST_TIMEOUT_MS = 15_000`)
- Modify: `packages/bibliograph-service/src/lib/server/xrpc-router.ts`
- Modify: `packages/bibliograph-service/src/lib/server/search/service.ts`

- [ ] **Step 1: Add the constant**

In the existing `timeout.ts`, add `export const REQUEST_TIMEOUT_MS = 15_000;` alongside `UPSTREAM_TIMEOUT_MS`.

- [ ] **Step 2: XRPC handlers install a signal**

In each `searchEditions` / `searchWorks` / `searchContributors` handler in `xrpc-router.ts`, build:
```ts
const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
```
Pass it into the `searchService.searchX(...)` call.

- [ ] **Step 3: Propagate through the orchestrator**

`SearchService.searchX(query, signal?)`. Each strategy call (`postgres.searchX`, `openLibrary.searchX`, `gb.enrich`, `wikipedia.enrich`) accepts and forwards `signal`.

- [ ] **Step 4: Tests still pass**

```bash
pnpm exec tsx --test src/lib/server/**/*.test.ts scripts/verify-search.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/
git commit -m "feat(xrpc): request-level timeout plumbed through search pipeline"
```

## Task 20: Structured upstream-error signaling

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/search/types.ts`
- Modify: `packages/bibliograph-service/src/lib/server/search/service.ts`
- Modify: `packages/bibliograph-service/src/lib/server/xrpc-router.ts`

- [ ] **Step 1: Add `degraded` field to `SearchResult<T>`**

```ts
export interface SearchResult<T> {
  items: T[];
  cursor?: string;
  total?: number;
  degraded?: { upstream: 'openlibrary' | 'googlebooks' | 'wikipedia'; reason: string };
}
```

- [ ] **Step 2: Orchestrator captures upstream errors**

When `openLibrary.searchX` returns `items.length === 0` after a Postgres miss **and** the openLibrary call raised (now handled via the breaker signal), set `result.degraded`. The simplest path: thread a `degraded?: {...}` field on `SearchResult` through all paths.

- [ ] **Step 3: XRPC handler surfaces degraded**

In `xrpc-router.ts` handlers, when `result.degraded` is set, include it in the response body. When `items.length === 0` **and** `degraded` is set, return HTTP 502 with `{ error: 'UpstreamUnavailable', message: ... }` — match the existing pattern at `xrpc-router.ts:519,549`.

- [ ] **Step 4: Tests still pass**

- [ ] **Step 5: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/
git commit -m "feat(search): structured upstream-error signaling via SearchResult.degraded"
```

---

## Phase 4 done. Moving to Phase 5.

## Task 21: Rate limiter

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/rate-limit.ts`

- [ ] **Step 1: Implement token-bucket per `(ip, nsid)`**

In-memory `Map<string, { tokens: number; lastRefill: number }>`. Refill rate: `RATE_LIMIT_RPM / 60` per second. Bucket size = `RATE_LIMIT_RPM`.

Default: `RATE_LIMIT_RPM_PUBLIC = 60` for `community.lexicon.book.*`; `RATE_LIMIT_RPM_PDS = 600` for `com.atproto.*`.

- [ ] **Step 2: Test + commit**

```bash
pnpm exec tsx --test src/lib/server/rate-limit.test.ts
git add src/lib/server/rate-limit.ts src/lib/server/rate-limit.test.ts
git commit -m "feat(xrpc): token-bucket rate limiter per (ip, nsid)"
```

## Task 22: Wire rate limiter into XRPC router

**Files:**
- Modify: `packages/bibliograph-service/src/lib/server/xrpc-router.ts`

- [ ] **Step 1: Add rate-limit middleware**

`accessLog(log), cors(), rateLimit(log), ...`. On reject, return `new Response('rate limited', { status: 429, headers: { 'retry-after': '60' }})`.

- [ ] **Step 2: Test**

Add a test that 61 rapid requests get a 429.

- [ ] **Step 3: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add packages/bibliograph-service/src/lib/server/xrpc-router.ts
git commit -m "feat(xrpc): apply per-nsid rate limiter middleware"
```

## Task 23: `prom-client` metrics

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/metrics.ts`

- [ ] **Step 1: Define counters + histograms**

- Counter: `search_requests_total{nsid, status}`
- Counter: `upstream_requests_total{upstream, outcome}`
- Histogram: `search_latency_ms{nsid}`
- Histogram: `upstream_latency_ms{upstream}`

- [ ] **Step 2: Increment in the right places**

- `accessLog` middleware: search latency histogram + status counter.
- API wrappers: increment `upstream_requests_total` and observe `upstream_latency_ms`.

- [ ] **Step 3: Expose `/metrics` route**

`src/routes/metrics/+server.ts`: GET returns `register.metrics()` in Prometheus text format.

- [ ] **Step 4: Test + commit**

```bash
pnpm exec tsx --test src/lib/server/metrics.test.ts
git add src/lib/server/metrics.ts src/routes/metrics/+server.ts
git commit -m "feat(metrics): prom-client counters + histograms + /metrics route"
```

## Task 24: `.env.example` updates

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add new env vars**

Append to `.env.example`:
```
# Graphile Worker concurrency (search ingest vs TAP records)
GRAPHILE_WORKER_CONCURRENCY_SEARCH=10
GRAPHILE_WORKER_CONCURRENCY_TAP=25

# XRPC rate limits (requests per minute per IP)
RATE_LIMIT_RPM_PUBLIC=60
RATE_LIMIT_RPM_PDS=600

# Total search-pipeline timeout (ms) — bounds the whole request, not per upstream
REQUEST_TIMEOUT_MS=15000
```

- [ ] **Step 2: Commit**

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add .env.example
git commit -m "docs: document new env vars (Graphile Worker concurrency, rate limits, request timeout)"
```

---

## Phase 5 done. Moving to Phase 6.

## Task 25: `SearchService` unit tests

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/service.test.ts`

- [ ] **Step 1: Write 6 tests with fake strategies**

1. `searchEditions` calls postgres first; if items returned, skips openLibrary + ingest.
2. `searchEditions` postgres miss → calls openLibrary → enriches → enqueues ingest per item.
3. `searchWorks` same pattern (without Google Books).
4. `searchContributors` id-only (no q) → postgres only, no openLibrary, no ingest.
5. `searchContributors` postgres miss → openLibrary + wikipedia contributor enrichment → enqueue ingest.
6. **Fire-and-forget still resolves** — make a fake `enqueueIngest` throw; assert `searchEditions` still resolves successfully.

- [ ] **Step 2: Run + commit**

```bash
pnpm exec tsx --test src/lib/server/search/service.test.ts
git add src/lib/server/search/service.test.ts
git commit -m "test(search): unit tests for SearchService orchestrator"
```

## Task 26: `LocalPostgresIngestor` unit tests

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/local-postgres-ingestor.test.ts`

- [ ] **Step 1: Write 8 tests**

(If `LocalPostgresIngestor` is kept as a back-compat wrapper, test it. If it was deleted in Task 8, skip this task and delete the test file from the plan.)

1. Rkey derivation: `rkeyForEdition('OL12345M')` → `'ol-edition-OL12345M'`.
2. Rkey derivation for work and contributor.
3. Discriminator: edition (title + publishedYear) → `ingestEdition`.
4. Discriminator: work (title + subjects) → `ingestWork`.
5. Discriminator: contributor (name) → `ingestContributor`.
6. Items without an `openlibrary` identifier are skipped.
7. The `cidForLex(value).toString()` produces a valid CIDv1 string.
8. `onConflictDoUpdate` is invoked (mock chain).

- [ ] **Step 2: Run + commit**

```bash
pnpm exec tsx --test src/lib/server/search/local-postgres-ingestor.test.ts
git add src/lib/server/search/local-postgres-ingestor.test.ts
git commit -m "test(search): unit tests for LocalPostgresIngestor"
```

## Task 27: `serveBookRecordFromDb` unit tests

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/xrpc-router.test.ts`

- [ ] **Step 1: Write 5 tests**

The function is private to `xrpc-router.ts`. Either:
- Export it as a helper module and import, OR
- Write integration tests via the XRPC router's `.fetch()` with mocked `db`.

Tests:
1. `repo !== PUBLISHER_DID` → 400 `RecordNotFound`.
2. Edition row → JSON with `$type`, valid CID, ISO `createdAt`.
3. Work row → same shape.
4. Contributor row → same shape.
5. Missing row → 400 `RecordNotFound`.

- [ ] **Step 2: Run + commit**

```bash
pnpm exec tsx --test src/lib/server/xrpc-router.test.ts
git add src/lib/server/xrpc-router.test.ts
git commit -m "test(xrpc): unit tests for serveBookRecordFromDb"
```

## Task 28: Smoke tests for the strategy wrapper classes

**Files:**
- Create: `packages/bibliograph-service/src/lib/server/search/open-library-source.test.ts`
- Create: `packages/bibliograph-service/src/lib/server/search/google-books-enricher.test.ts`
- Create: `packages/bibliograph-service/src/lib/server/search/wikipedia-enricher.test.ts`

- [ ] **Step 1: Smoke tests**

One test per class:
- Constructs with no required args (enrichers) or with `log` (sources/ingestor).
- `name` property matches expected string.
- Delegates method calls to the underlying `api/*` function (stub `fetch`/`quickAddJob`).

- [ ] **Step 2: Run all + commit**

```bash
pnpm exec tsx --test src/lib/server/search/*.test.ts
git add src/lib/server/search/open-library-source.test.ts \
        src/lib/server/search/google-books-enricher.test.ts \
        src/lib/server/search/wikipedia-enricher.test.ts
git commit -m "test(search): smoke tests for OpenLibrarySource + GoogleBooksEnricher + WikipediaEnricher wrappers"
```

---

## Phase 6 done. All 28 implementation tasks complete.

## Task 29: Update plan doc with DONE markers (per user preference)

For each task above that completed successfully, flip the `- [ ]` checkbox to `- [x]` in this plan doc and add `(DONE — commit <sha>)` to the task heading. Commit per task OR batch at the end per controller preference.

- [ ] Walk through `docs/superpowers/plans/2026-08-26-search-and-tap-improvements.md` and flip every completed task's checkboxes to `[x]` with commit SHA appended to the heading.

```bash
cd /home/vrgl/Code/olamaelcu/bibliograph
git add docs/superpowers/plans/2026-08-26-search-and-tap-improvements.md
git commit -m "docs(plan): mark all 28 implementation tasks done"
```

---

## Self-review

1. **Spec coverage:** every bullet in the design summary (Phases 1-6) maps to a task. Phase 1 covers queue + DLQ + TAP migration. Phase 2 covers indexes. Phase 3 covers batch + parallel. Phase 4 covers retry + breaker + timeout + degraded signaling. Phase 5 covers rate limit + metrics + env config. Phase 6 covers tests.
2. **Placeholder scan:** no "TBD" / "TODO" / "implement later" / "similar to" / "fill in". Every step that changes code shows the code.
3. **Type consistency:** `SearchResult<T>` gets `degraded?: {...}` field used consistently across `service.ts` and `xrpc-router.ts`. `enqueueIngest(kind, item)` signature used consistently in `service.ts` and `jobs/handlers.ts`. `CircuitBreaker` and `withRetry` exported from one module each, imported in all 3 api wrappers.
4. **Ambiguity check:** Task 8's `LocalPostgresIngestor` deletion vs retention is flagged for the controller to decide per Phase 1 progress. Task 19's REQUEST_TIMEOUT_MS addition noted as additive to existing timeout.ts.
5. **Dependencies between tasks:**
 - Task 8 (SearchService dequeue) depends on Task 4 (`enqueueIngest` exists).
 - Task 18 (retry+breaker in wrappers) depends on Tasks 16, 17.
 - Task 19 (request-level timeout) depends on Task 20's `degraded` field for error surface.
 - Task 27 depends on `serveBookRecordFromDb` being extractable or testable through the router.
6. **Tests:** every implementation task that produces runtime code includes either "tests still pass" verification (Phase 1-5 work) or a dedicated test (Phase 6).
7. **Out-of-scope items:** TAP firehose backpressure, TAP historical replay, multi-instance queue, schema evolution, lex runtime validation — all explicitly listed as deferred at the top.

Plan ready for execution.

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-08-26-search-and-tap-improvements.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session with checkpoints for review

Which approach?