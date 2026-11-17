# Findings

Calibration and confirmed violations for the three campaign targets, run
against `main` @ `3fbeae0`. Each mutation was applied to the production file,
the harness was run, and the file was reverted with `git checkout -- <file>`;
the reverted state is what every entry below reports as green.

## Target 1 — `packages/worker/lib/record-fields.js`

**Calibration.** `if (parts.length >= maxGraphemes || bytes + size > maxBytes)`
changed to `if (parts.length >= maxGraphemes || bytes > maxBytes)` in
`clippedText` (breaks the UTF-8 bound).

- Harness: `node --test proptest/record-fields.test.ts` → exit 1.
- Shrunk counterexample: `["a", 1, 0]` — `byte bound broken: 1 > 0 for "a"`.
- Reverted; the same harness then reports only the finding below.

**Generated traces.** Text pieces interleaved from combining marks, the ZWJ
family, a regional-indicator flag, CJK, SOFT HYPHEN, ZWSP/ZWJ/ZWNJ, `\r\n`,
NBSP and lone surrogates; `maxGraphemes` 0–8, `maxBytes` 0–32. Observed: empty
clip (bound 0), grapheme-bound clip, byte-bound clip, and the "first grapheme
larger than the whole budget" path. Dates: full 0–9999 year range with the
century boundaries pinned, plus near-miss suffixes and arbitrary binary text.
Identifiers: duplicate keys, blank/whitespace halves, non-object entries, `url`
present/blank/absent, collation-equivalent name pairs.

### F1 — `canonicalIdentifiers` does not canonicalize collation-equivalent keys

- **Trigger**: two distinct identifier keys whose `issuer`/`value` differ only in
  characters the default collation ignores — precomposed vs decomposed `é`,
  ZWJ vs no-ZWJ emoji sequences, ZWSP/SOFT HYPHEN insertions.
- **First divergence**: `bag.sort(...)` compares with `String#localeCompare`,
  which returns `0` for distinct strings in the same collation class. `sort` is
  stable, so the input order survives into the "canonical" array.
- **Reproduction** (shrunk from the generated trace, seed `342844628`, path
  `0:0:0`): permutations of
  `[{issuer: 'é', value: 'a'}, {issuer: 'e\u0301', value: 'a'}]` return
  `[é, e\u0301]` and `[e\u0301, é]` — the same set, two serializations.
- **Contract violated**: the doc comment's "the same set always serializes the
  same way, which is what makes `(lower(name), identifiers)` a set key rather
  than a byte-order coincidence". Two catalog rows recording the same identifier
  set in a different insert order get different JSON for the same set key.
- **Branch**: `proptest/fix-canonical-identifiers` @ `702a836` — regression test
  in `packages/worker/test/record-fields.test.js`, comparator replaced with a
  code-unit total order. The regression fails on `main` for the stated reason
  in a clean worktree and passes on the branch. Merged into `proptest/discovery`
  @ `3c31f54`.
- Not security-relevant: no authz, no denial of service, no cache poisoning.

### F2 — the entity identity row was keyed on an order-dependent bag

- **Found by**: inspection while checking what keeps catalog rows from
  duplicating Bookhive's; confirmed by the two regressions below.
- **Trigger**: the same entity name with the same identifier set arriving in
  another order — a second provider, or a curator reordering the bag.
- **First divergence**: `packages/worker/lib/ingest.js` stored
  `JSON.stringify(candidate.identifiers)`, i.e. the caller's order, into the
  column the unique index `(lower(name), identifiers)` compares. jsonb arrays
  compare positionally, so the conflict never fires and a second row is minted
  with its own `at://` address — while `buildContributorRecord` publishes
  `canonicalIdentifiers(...)`, so both rows publish the same record.
- **Contract violated**: the identity an ingest and the admin editor share —
  `entity-edit.ts` states it as "two spellings of the same identifier bag
  resolve to one contributor or publisher row".
- **Branch**: `fix/entity-identity-bag` @ `794fd49` — a `canonicalIdentifiersJson`
  helper (the stored form of the bag), used by both `ingest.js` entity writes,
  by `edition-edit.ts` (insert and its follow-up lookup), and by the two merge
  writers. Regressions: `packages/worker/test/ingest-scope.test.js` (fake
  client: reordered bag must reach the row as one string) and
  `packages/web/test/edition-edit-db.test.ts` (real Postgres: the reordered bag
  must resolve to the existing contributor id). Both fail on `main` for the
  stated reason and pass on the branch. Merged into `proptest/discovery` @
  `dfa5d42`.
- Residual: rows written before this change keep whatever order they carry; no
  backfill is included, so a reordered bag can still miss an old row once.
- Not security-relevant.

## Target 2 — `packages/web/src/lib/server/covers/rate-limit.ts`

**Calibration.** `bucket.tokens -= 1;` deleted from `take` (grant without
spending).

- Harness: `node --test proptest/rate-limit.test.ts` → exit 1 on all three
  properties.
- Shrunk counterexamples: `{"events":[{"delta":0,"key":"a"},{"delta":0,"key":"a"}],"capacity":1,"refillPerSecond":0.001,"maxKeys":1}`
  (decision diverged from the model), `[1, 0.001]` → `burst of 1 exceeded`,
  `[1, 0.001, 1]` → `the newest key was granted more than its burst of 1`.
- Reverted; green.

**Generated traces.** Up to 40 events over a 1–4 key pool, `capacity` 1–8,
`refillPerSecond` 0.001–5, `maxKeys` from the pool size to 4. Both regimes are
covered: pool ≤ `maxKeys` (conservation, no eviction) and pool > `maxKeys`
(insertion-order eviction). Observed: full burst, refusal, refusal → wait →
grant, capped refill at `capacity`, eviction of the oldest key, idle-refill
behaviour across `IDLE_MS`.

**Confirmed violations**: none. Properties held across 1,000 traces plus 400
targeted cases, after the calibration above proved the harness sensitive to a
one-line defect in each direction.

**Strengthened instead of deleting**: the first version of the burst property
assumed a one-token refill per advertised second and false-positived on
`refillPerSecond > 1`; it now asserts "at least one grant, never more than one
burst". The decision oracle treats `|tokens − 1| ≤ 200` micro-tokens as
ambiguous, which is the only place the float and micro-token models can
legitimately disagree.

## Target 3 — `packages/web/src/lib/server/cached-loader.ts`

**Calibration.** `inFlight ??= options.load().then(...)` became
`inFlight = options.load().then(...)` (no sharing of an in-flight load).

- Harness: `node --test proptest/cached-loader.test.ts` → exit 1.
- Shrunk counterexample:
  `[{"ttlMs":0,"staleWhileRevalidate":false}, Read, Read /* replayPath="DFB:F" */]`
  → `a concurrent read started its own load instead of sharing the in-flight
  one`; the SWR burst test independently reports `a burst of expired reads
  started more than one refresh`.
- Reverted; green.

**Generated traces.** Up to 12 commands over `Read`, `AdvanceClock(0–2000)`,
`ResolveLoad(value)`, `RejectLoad`, with `ttlMs` 0–1000 and both
`staleWhileRevalidate` settings, replayed against a reference loader that keeps
its own `fresh | stale | loading` state and call counter. Observed: fresh hits,
expired blocking reads, shared in-flight loads (several reads on one deferred),
SWR bursts, `ttlMs: 0`, failure-then-retry, and a failure that leaves a stale
value in place.

**Confirmed violations**: none after calibration. The `load` call count never
diverged from the model, no caller was left waiting on a settled load, and no
failed load was cached.

**Strengthened instead of deleting**: the model run began as two properties
(fresh-vs-load and SWR); folding them into one `fc.commands` model run made the
load-count invariant checkable after every command instead of only at the end.
