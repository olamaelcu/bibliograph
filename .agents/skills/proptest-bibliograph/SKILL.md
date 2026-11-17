# proptest-bibliograph Skill

Hunt correctness bugs in this repository with property-based tests, then reduce
every confirmed violation to a deterministic regression test plus a minimal fix.

`skill://proptest-praxis` is the method, and it is authoritative: target
selection from code behavior, generator design, independent reference models,
RIPR-style invariants, shrinking, and independently reviewable fixes. This file
adds only what the method leaves to the repository — the stack mapping, the
runner, the target map, and the branch rules.

## Stack mapping

The method is written for Rust `proptest`. The equivalents here:

| `proptest` (Rust) | fast-check (this repo) |
| --- | --- |
| `proptest!` + `prop_assert!` | `fc.assert(fc.property(...))` inside a `node:test` `test(...)` |
| `prop_assert_eq!` | `assert.deepStrictEqual` / `assert.strictEqual` from `node:assert/strict` |
| `prop_assume!` | `fc.pre(condition)` |
| `Just(x)` / `any::<T>()` | `fc.constant(x)` / `fc.anything()`; prefer a narrow built-in (`fc.string`, `fc.integer`, `fc.array`) |
| `prop::collection::vec(g, 0..n)` | `fc.array(g, { maxLength: n })` |
| `proptest-state-machine` | `fc.commands`, run by `fc.modelRun` / `fc.asyncModelRun` / `fc.scheduledModelRun` |
| `proptest::sample::select` | `fc.constantFrom(...)` |
| reference model (`Vec`, `HashMap`, `BTreeMap`) | plain array / `Map` written independently in the harness |
| `PROPTEST_CASES` env var | `numRuns` on `fc.assert` |

Rule: the reference model must not import, wrap, or copy a production helper. If
the oracle is derived from the implementation, the property is a tautology. Write
the state machine and its arithmetic from the doc comment alone, in the
harness's own terms (this is why the token-bucket model counts integer
micro-tokens instead of reusing the production float refill).

## Runner and layout

Discovery harnesses live at the repository root, on the discovery branch only:

```bash
node --test proptest/*.test.ts            # every target
node --test proptest/rate-limit.test.ts   # one target
```

Root, not per-package: the campaign's targets come from both packages, and none
of them imports `$env` or a SvelteKit module, so one test file can import
`../packages/worker/lib/record-fields.js` (plain JS) and
`../packages/web/src/lib/server/covers/rate-limit.ts` (type-stripped by Node 26)
alike. Neither package's `test` script can pick these up — `node --test
test/*.test.js` and `node --test test/*.test.ts` are single-level globs — so
`pnpm test`, `pnpm worker:test` and `pnpm web:test` never run the harness.

`fast-check` is a workspace-root devDependency for exactly this reason: the
harness runs without adding a dependency to either package, and every committed
regression test stays generator-free.

A target that pulls `$env` or SvelteKit modules is out of scope until its pure
part is extractable. Do not refactor production code to enable a test during a
discovery campaign; write the target down instead.

## Runs

| Harness class | `numRuns` | Why |
| --- | --- | --- |
| Pure synchronous properties | 10,000 | cheap per case; the budget goes to shrinking, not to a few hand-picked inputs |
| Stateful / async (`fc.commands`, promise scheduling) | 1,000 | each run replays a whole operation history through the real scheduler |

On any failure, record `seed`, `path` (the fast-check shrink path) and, for
`fc.commands`, `replayPath` in `proptest/FINDINGS.md` **before** investigating.

## Target map for this campaign

| Target | Contract | Oracle |
| --- | --- | --- |
| `clippedText`, `isoCalendarDate`, `canonicalIdentifiers`, `httpUrl` — `packages/worker/lib/record-fields.js` | `clippedText` is a grapheme-aligned, maximal prefix of `value.trim()` under both `maxGraphemes` and UTF-8 `maxBytes`; blank → `undefined`. `isoCalendarDate` is exactly `YYYY-MM-DD` and a real calendar day. `canonicalIdentifiers` dedupes by `(issuer, value)` keeping the first `url`, sorted by `(issuer, value)`; the same set always yields the same array. `httpUrl` returns its input unchanged iff it parses with scheme `http:`/`https:`. | No copy of the production loop: assert the byte bound ≤ `maxBytes`, grapheme count ≤ `maxGraphemes`, `trimmed.startsWith(result)`, that the result ends on a grapheme boundary, and maximality — appending the next grapheme violates a bound. Dates against an independent `daysInMonth` + leap-rule table including years `0000`, `0099`, `1900`, `2000`, `9999` and `2023-02-29`. Identifiers: permutation invariance (shuffle and duplicate the input, expect an identical output array), idempotence, set equality, first-`url` preservation. |
| `createTokenBucket` — `packages/web/src/lib/server/covers/rate-limit.ts` | Burst ≤ `capacity`; refill at `refillPerSecond`, capped at `capacity`; `retryAfterSeconds ≥ 1` and never understates the wait; at most `maxKeys` keys tracked, evicting full-and-idle buckets first, then insertion order. | Replay a generated event list `(timeDelta, key)` against a model holding `tokens`/`updatedAt` per key and computing refills in integer micro-tokens. Assert every `allowed` decision matches the model, conservation over a window (grants ≤ `capacity + refillPerSecond × elapsed`), `retryAfterSeconds ∈ [1, ceil(missing / refillPerSecond) + 1]`, and that after `maxKeys + 1` fresh keys plus `IDLE_MS + 1` the first key is granted a full burst again. |
| `cachedLoader` — `packages/web/src/lib/server/cached-loader.ts` | A fresh value (`now() - loadedAt < ttlMs`) returns without calling `load`; concurrent callers share one in-flight load; with `staleWhileRevalidate` an expired value returns immediately and exactly one refresh starts behind it; a rejected load is not cached and the next read retries; `ttlMs: 0` disables reuse. | `fc.commands` over `Read`, `AdvanceClock(ms)`, `ResolveLoad(value)`, `RejectLoad`, run with `fc.asyncModelRun` against an independently written reference loader (explicit `fresh \| stale \| loading` state machine, own call counter) driven by deferred promises and an injected clock. Assert returned values and `load` call counts after every command. |

## Next targets (not this campaign)

Each already has a pure core worth a harness:

- `packages/worker/lib/publish.js` — outbox claim / lease / attempts
- `packages/worker/lib/resolve-format.js` — `normalizeFormatIsbns`
- `packages/worker/lib/genres.js`
- `packages/worker/lib/isbndb-names.js`
- `packages/web/src/lib/server/xrpc/identifiers.ts` — `parseIdentifierParams`
- `packages/web/src/lib/server/admin/merge.ts`, `edition-merge.ts`
- `packages/web/src/lib/server/catalog/search-hydration.ts`
- `packages/web/src/lib/server/covers/cache.ts` — `coverEtag`, `normalizeIfNoneMatch`
- `packages/worker/lib/cover-cache.js`

Excluded: anything needing Postgres (`catalog/editions.ts`, the `admin/*-db`
tests). The harness must run with no database.

## Calibration is mandatory

A green harness proves nothing until it has been seen to fail. Before recording
"no findings" for a target, inject one deliberate mutation, confirm the harness
exits non-zero with a shrunk counterexample, then `git checkout -- <file>`.
Record the mutation, the observed failure, and the reverted state in
`proptest/FINDINGS.md`. If a target still yields nothing, strengthen the
generators and say so — do not delete the finding entry.

## Fix workflow

Discovery work stays on `proptest/discovery`. For each confirmed bug:

1. Branch `proptest/fix-<slug>` from `main`.
2. Add a deterministic regression test in the owning package's existing `test/`
   directory — `packages/worker/test/<area>.test.js` or
   `packages/web/test/<area>.test.ts`, `node:test` + `node:assert/strict`, **no
   fast-check**. Committed tests must not depend on the discovery harness.
3. Add the smallest fix that satisfies it.
4. Prove the regression on `main` for the claimed reason:

   ```bash
   git worktree add /tmp/bgp-main main
   cd /tmp/bgp-main && node --test <test file>   # must fail, for that reason
   ```

   then passes on the fix branch with the same command.
5. Merge the fix branch into `proptest/discovery` (the discovery suite carries
   the fixes too) and remove the worktree: `git worktree remove /tmp/bgp-main`.

Leave every fix branch unmerged on `main`. Do not push any branch.

## Disclosure

The remote is public (`olamaelcu/bibliograph`). If a finding looks
security-relevant — authz, denial of service in the rate limiter, cache
poisoning — stop, keep it off public branches, and report it to the user first.
